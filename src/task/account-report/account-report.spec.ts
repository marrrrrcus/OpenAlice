import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createAccountReport,
  detectAccountEvents,
  lossPctOfNlv,
  highestLayerHit,
  liquidationDistancePct,
  buildAlertMessage,
  buildQuietSummary,
  defaultPositionRiskState,
  type AccountObservation,
  type AccountRiskState,
  type AccountRuleConfig,
  type PositionObservation,
} from './account-report.js'
import type { AccountReportConfig } from '../../core/config.js'

const RULES: AccountRuleConfig = {
  drawdown: { layersPct: [10, 18, 25], releaseBuffer: 3 },
  liquidation: { safetyPct: 5, releaseBuffer: 2 },
  nlvMovePct: 5,
}

function pos(over: Partial<PositionObservation> = {}): PositionObservation {
  return { key: 'BTC/USDT:USDT', label: 'BTC/USDT:USDT', side: 'long', unrealizedPnL: 0, markPrice: 64000, liquidationPrice: null, ...over }
}

function acc(over: Partial<AccountObservation> = {}): AccountObservation {
  return { accountId: 'binance-main', label: 'Binance Live', netLiquidation: 2000, positions: [pos()], ...over }
}

function freshState(over: Partial<AccountRiskState> = {}): AccountRiskState {
  // knownPositions seeded so position-open doesn't fire in threshold tests
  return { lastReportedNlv: 2000, knownPositions: ['BTC/USDT:USDT'], positions: {}, ...over }
}

describe('pure helpers', () => {
  it('lossPctOfNlv: loss as positive % of NLV, 0 when in profit', () => {
    expect(lossPctOfNlv(-200, 2000)).toBeCloseTo(10)
    expect(lossPctOfNlv(500, 2000)).toBe(0)
    expect(lossPctOfNlv(-200, 0)).toBe(0)
  })

  it('highestLayerHit: returns top layer index met, -1 when none', () => {
    expect(highestLayerHit(5, [10, 18, 25])).toBe(-1)
    expect(highestLayerHit(12, [10, 18, 25])).toBe(0)
    expect(highestLayerHit(20, [10, 18, 25])).toBe(1)
    expect(highestLayerHit(30, [10, 18, 25])).toBe(2)
  })

  it('liquidationDistancePct: percent distance, null when N/A', () => {
    expect(liquidationDistancePct(64000, 60800)).toBeCloseTo(5)
    expect(liquidationDistancePct(64000, null)).toBeNull()
    expect(liquidationDistancePct(64000, 0)).toBeNull()
  })
})

describe('drawdown layers (hysteresis)', () => {
  it('fires when crossing into a layer, escalates to higher layers', () => {
    let state = freshState()
    // -12% → L1
    let r = detectAccountEvents(acc({ positions: [pos({ unrealizedPnL: -240 })] }), state, RULES)
    expect(r.events.map(e => e.kind)).toEqual(['drawdown'])
    expect(r.events[0].detail).toContain('L1')
    expect(r.next.positions['BTC/USDT:USDT'].drawdownLayer).toBe(1)
    state = r.next
    // -20% → L2 (escalation fires)
    r = detectAccountEvents(acc({ positions: [pos({ unrealizedPnL: -400 })] }), state, RULES)
    expect(r.events.map(e => e.kind)).toEqual(['drawdown'])
    expect(r.events[0].detail).toContain('L2')
  })

  it('stays silent while loss deepens within the same layer', () => {
    const state = freshState({ positions: { 'BTC/USDT:USDT': { drawdownLayer: 1, liqAlerted: false } } })
    const r = detectAccountEvents(acc({ positions: [pos({ unrealizedPnL: -300 })] }), state, RULES) // -15%, still L1
    expect(r.events).toEqual([])
    expect(r.next.positions['BTC/USDT:USDT'].drawdownLayer).toBe(1)
  })

  it('re-arms only after loss recovers below layer1 - buffer', () => {
    const state = freshState({ positions: { 'BTC/USDT:USDT': { drawdownLayer: 1, liqAlerted: false } } })
    // -6% < 10-3=7 → re-arm to 0
    const r = detectAccountEvents(acc({ positions: [pos({ unrealizedPnL: -120 })] }), state, RULES)
    expect(r.events).toEqual([])
    expect(r.next.positions['BTC/USDT:USDT'].drawdownLayer).toBe(0)
  })

  it('does not fire for profitable positions', () => {
    const r = detectAccountEvents(acc({ positions: [pos({ unrealizedPnL: 500 })] }), freshState(), RULES)
    expect(r.events).toEqual([])
  })
})

describe('near-liquidation (latched)', () => {
  it('fires once when distance falls within safety band', () => {
    const state = freshState()
    const r = detectAccountEvents(acc({ positions: [pos({ markPrice: 64000, liquidationPrice: 61500 })] }), state, RULES) // ~3.9%
    expect(r.events.map(e => e.kind)).toEqual(['near_liquidation'])
    expect(r.events[0].severity).toBe('high')
    expect(r.next.positions['BTC/USDT:USDT'].liqAlerted).toBe(true)
  })

  it('does not re-fire while still within band', () => {
    const state = freshState({ positions: { 'BTC/USDT:USDT': { drawdownLayer: 0, liqAlerted: true } } })
    const r = detectAccountEvents(acc({ positions: [pos({ markPrice: 64000, liquidationPrice: 62000 })] }), state, RULES)
    expect(r.events).toEqual([])
  })

  it('re-arms when distance climbs above safety + buffer', () => {
    const state = freshState({ positions: { 'BTC/USDT:USDT': { drawdownLayer: 0, liqAlerted: true } } })
    // distance ~10% > 5+2 → re-arm
    const r = detectAccountEvents(acc({ positions: [pos({ markPrice: 64000, liquidationPrice: 57600 })] }), state, RULES)
    expect(r.events).toEqual([])
    expect(r.next.positions['BTC/USDT:USDT'].liqAlerted).toBe(false)
  })

  it('ignores positions without a liquidation price', () => {
    const r = detectAccountEvents(acc({ positions: [pos({ liquidationPrice: null })] }), freshState(), RULES)
    expect(r.events.filter(e => e.kind === 'near_liquidation')).toEqual([])
  })
})

describe('position open / close diff', () => {
  it('fires position_opened for a new key', () => {
    const state = freshState({ knownPositions: [] })
    const r = detectAccountEvents(acc(), state, RULES)
    expect(r.events.map(e => e.kind)).toContain('position_opened')
  })

  it('fires position_closed for a vanished key', () => {
    const state = freshState({ knownPositions: ['BTC/USDT:USDT', 'ETH/USDT:USDT'] })
    const r = detectAccountEvents(acc({ positions: [pos()] }), state, RULES) // ETH gone
    expect(r.events.map(e => e.kind)).toContain('position_closed')
    expect(r.events.find(e => e.kind === 'position_closed')?.detail).toContain('ETH/USDT:USDT')
  })

  it('cold start (lastReportedNlv null) seeds positions WITHOUT firing open/close', () => {
    // First-ever observation of an account: pre-existing positions must not
    // be reported as "newly opened" (would re-spam on every Alice restart).
    const coldState: AccountRiskState = { lastReportedNlv: null, knownPositions: [], positions: {} }
    const r = detectAccountEvents(acc({ positions: [pos(), pos({ key: 'ETH/USDT:USDT', label: 'ETH/USDT:USDT' })] }), coldState, RULES)
    expect(r.events.filter(e => e.kind === 'position_opened')).toEqual([])
    expect(r.next.knownPositions).toEqual(['BTC/USDT:USDT', 'ETH/USDT:USDT']) // still seeded
    expect(r.next.lastReportedNlv).toBe(2000) // anchored
  })

  it('cold start STILL fires drawdown — current risk surfaces even for non-new positions', () => {
    const coldState: AccountRiskState = { lastReportedNlv: null, knownPositions: [], positions: {} }
    const r = detectAccountEvents(acc({ positions: [pos({ unrealizedPnL: -400 })] }), coldState, RULES) // -20% → L2
    expect(r.events.map(e => e.kind)).toContain('drawdown')
    expect(r.events.filter(e => e.kind === 'position_opened')).toEqual([])
  })
})

describe('NLV move', () => {
  it('fires when NLV moves beyond threshold vs last reported, with 📈 on a gain', () => {
    const state = freshState({ lastReportedNlv: 2000 })
    const r = detectAccountEvents(acc({ netLiquidation: 2150 }), state, RULES) // +7.5%
    const ev = r.events.find(e => e.kind === 'nlv_move')
    expect(ev).toBeDefined()
    expect(ev!.detail).toContain('📈')
    expect(ev!.detail).toContain('增加')
    expect(r.next.lastReportedNlv).toBe(2150) // re-anchored
  })

  it('uses 📉 on a downward NLV move', () => {
    const r = detectAccountEvents(acc({ netLiquidation: 1880 }), freshState({ lastReportedNlv: 2000 }), RULES) // -6%
    const ev = r.events.find(e => e.kind === 'nlv_move')
    expect(ev!.detail).toContain('📉')
    expect(ev!.detail).toContain('減少')
  })

  it('stays silent below threshold and anchors first observation', () => {
    const r1 = detectAccountEvents(acc({ netLiquidation: 2000 }), freshState({ lastReportedNlv: null }), RULES)
    expect(r1.events.filter(e => e.kind === 'nlv_move')).toEqual([])
    expect(r1.next.lastReportedNlv).toBe(2000)
    const r2 = detectAccountEvents(acc({ netLiquidation: 2050 }), freshState({ lastReportedNlv: 2000 }), RULES) // +2.5%
    expect(r2.events.filter(e => e.kind === 'nlv_move')).toEqual([])
  })
})

describe('message builders', () => {
  it('buildAlertMessage uses 🚨 alarm header when a risk event is present', () => {
    const msg = buildAlertMessage('Binance Live', [
      { accountId: 'b', accountLabel: 'Binance Live', kind: 'drawdown', severity: 'high', detail: 'BTC 浮虧達淨值 -18%（L2）' },
      { accountId: 'b', accountLabel: 'Binance Live', kind: 'near_liquidation', severity: 'high', detail: '⚠️ BTC 距強平 3%' },
    ])
    expect(msg).toContain('🚨 帳戶警示 — Binance Live')
    expect(msg).toContain('-18%（L2）')
    expect(msg).toContain('距強平 3%')
  })

  it('buildAlertMessage uses 📊 status header for purely informational events (no alarm for a gain)', () => {
    const msg = buildAlertMessage('Binance Live', [
      { accountId: 'b', accountLabel: 'Binance Live', kind: 'nlv_move', severity: 'normal', detail: '📈 帳戶淨值增加 5.63%（$1817.72 → $1920.10）' },
    ])
    expect(msg).toContain('📊 帳戶動態 — Binance Live')
    expect(msg).not.toContain('🚨')
    expect(msg).toContain('📈 帳戶淨值增加 5.63%')
  })

  it('buildAlertMessage: risk wins when a batch mixes risk + informational', () => {
    const msg = buildAlertMessage('Acct', [
      { accountId: 'a', accountLabel: 'Acct', kind: 'nlv_move', severity: 'normal', detail: '📉 帳戶淨值減少 6%' },
      { accountId: 'a', accountLabel: 'Acct', kind: 'drawdown', severity: 'high', detail: 'BTC 浮虧 -10%（L1）' },
    ])
    expect(msg).toContain('🚨 帳戶警示')
  })

  it('buildQuietSummary renders one entry per account with position count', () => {
    const msg = buildQuietSummary([
      acc({ label: 'Binance Live', netLiquidation: 2000, positions: [pos(), pos({ key: 'ETH/USDT:USDT' })] }),
    ])
    expect(msg).toContain('Binance Live 淨值 $2000.00（2 倉）')
  })
})

describe('defaultPositionRiskState', () => {
  it('starts clean', () => {
    expect(defaultPositionRiskState()).toEqual({ drawdownLayer: 0, liqAlerted: false })
  })
})

describe('createAccountReport — dust-account filter (module-level)', () => {
  function baseConfig(over: Partial<AccountReportConfig> = {}): AccountReportConfig {
    return {
      enabled: true, every: '5m', summaryEvery: '6h',
      drawdown: { layersPct: [10, 18, 25], releaseBuffer: 3 },
      liquidation: { safetyPct: 5, releaseBuffer: 2 },
      nlvMovePct: 5, minNlvUsd: 10,
      statePath: join(tmpdir(), `ar-test-${randomUUID().slice(0, 8)}.json`),
      ...over,
    }
  }

  // A fake UTAAccountSDK exposing just what observe() touches.
  function fakeAccount(id: string, nlv: string, positions: Array<Record<string, unknown>>) {
    return {
      id, label: id,
      getAccount: async () => ({ netLiquidation: nlv }),
      getPositions: async () => positions.map((p) => ({
        contract: { localSymbol: p.key, symbol: p.key },
        side: p.side ?? 'long',
        unrealizedPnL: p.unrealizedPnL ?? '0',
        marketPrice: p.markPrice ?? '0',
        liquidationPrice: p.liquidationPrice,
      })),
    }
  }

  it('skips a dust account (NLV < minNlvUsd) even when its % drawdown is huge', async () => {
    const notified: Array<{ text: string; priority?: string }> = []
    const manager = {
      resolve: async () => [
        // Dust: 20% loss but only -$0.15 absolute — must be skipped.
        fakeAccount('OKX', '0.73', [{ key: 'SOL/USDT', unrealizedPnL: '-0.15', markPrice: '66.9' }]),
      ],
    } as any
    const connectorCenter = { notify: async (text: string, opts?: { priority?: string }) => { notified.push({ text, priority: opts?.priority }); return {} as any } } as any

    const ar = createAccountReport({ config: baseConfig({ enabled: false }), manager, connectorCenter })
    await ar.start()
    await ar.runNow()
    ar.stop()

    expect(notified).toEqual([]) // no alert, no quiet summary for a dust-only sweep
  })

  it('monitors an account at/above minNlvUsd and alerts on its drawdown', async () => {
    const notified: Array<{ text: string; priority?: string }> = []
    const manager = {
      resolve: async () => [
        fakeAccount('Binance', '2000', [{ key: 'BTC/USDT:USDT', unrealizedPnL: '-400', markPrice: '60000' }]),
      ],
    } as any
    const connectorCenter = { notify: async (text: string, opts?: { priority?: string }) => { notified.push({ text, priority: opts?.priority }); return {} as any } } as any

    const ar = createAccountReport({ config: baseConfig({ enabled: false }), manager, connectorCenter })
    await ar.start()
    await ar.runNow()
    ar.stop()

    expect(notified).toHaveLength(1)
    expect(notified[0].priority).toBe('high')
    expect(notified[0].text).toContain('L2') // -400/2000 = -20% → layer 2
  })
})
