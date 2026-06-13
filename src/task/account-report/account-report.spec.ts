import { describe, it, expect } from 'vitest'
import {
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
})

describe('NLV move', () => {
  it('fires when NLV moves beyond threshold vs last reported', () => {
    const state = freshState({ lastReportedNlv: 2000 })
    const r = detectAccountEvents(acc({ netLiquidation: 2150 }), state, RULES) // +7.5%
    expect(r.events.map(e => e.kind)).toContain('nlv_move')
    expect(r.next.lastReportedNlv).toBe(2150) // re-anchored
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
  it('buildAlertMessage lists every event detail under the account header', () => {
    const msg = buildAlertMessage('Binance Live', [
      { accountId: 'b', accountLabel: 'Binance Live', kind: 'drawdown', severity: 'high', detail: 'BTC 浮虧達淨值 -18%（L2）' },
      { accountId: 'b', accountLabel: 'Binance Live', kind: 'near_liquidation', severity: 'high', detail: '⚠️ BTC 距強平 3%' },
    ])
    expect(msg).toContain('Binance Live')
    expect(msg).toContain('-18%（L2）')
    expect(msg).toContain('距強平 3%')
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
