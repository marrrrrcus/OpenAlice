import { describe, it, expect, afterEach } from 'vitest'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMicrostructureAlert } from './microstructure-alert.js'
import type { MicrostructureAlertConfig } from '../../core/config.js'

const statePaths: string[] = []
afterEach(async () => {
  await Promise.all(statePaths.splice(0).map((p) => unlink(p).catch(() => {})))
})

function tmpState(): string {
  const p = join(tmpdir(), `micro-${randomUUID().slice(0, 8)}.json`)
  statePaths.push(p)
  return p
}

function baseConfig(over: Partial<MicrostructureAlertConfig> = {}): MicrostructureAlertConfig {
  return {
    enabled: false, source: 'X', symbols: ['BTC/USDT:USDT'],
    orderbookEvery: '2m', fundingEvery: '30m', baselineAlpha: 0.5,
    fundingHistoryCap: 80, cooldown: '30m',
    rules: {
      obWarmup: 1, fundingWarmup: 1,
      spread: { medium: 2, high: 3, critical: 5 },
      depth: { medium: 0.7, high: 0.5, critical: 0.3 },
      imbalance: { medium: 3, high: 5, critical: 10 },
      fundingExtreme: { medium: 60, high: 80, critical: 94, minAbs: 0.00001 },
      fundingChange: { medium: 0.00001, high: 0.00003 },
    },
    statePath: tmpState(),
    ...over,
  }
}

// Balanced book around mid 100; spread depends on the levels passed in.
function book(bestBid = 99.95, bestAsk = 100.05) {
  return { bids: [[bestBid, 10], [99.0, 100]], asks: [[bestAsk, 10], [101.0, 100]] }
}

/** Mutable fake account — change `.ob` / `.funding` between ticks. */
function fakeAccount(id: string) {
  const state = {
    ob: book() as any,
    funding: 0.0001 as number | null,
    failOrderBook: false,
    failFunding: false,
  }
  return {
    state,
    sdk: {
      id,
      getOrderBook: async () => {
        if (state.failOrderBook) throw new Error('order book API down')
        return state.ob
      },
      getFundingRate: async () => {
        if (state.failFunding) throw new Error('funding API down')
        return { fundingRate: state.funding }
      },
    } as any,
  }
}

function fakeManager(acc: any) {
  return { resolveOne: async () => acc, resolve: async () => [acc] } as any
}

const alertOnlySourceFiles = [
  'src/task/microstructure-alert/microstructure-alert.ts',
  'src/task/microstructure-alert/index.ts',
  'src/task/microstructure-alert/rules.ts',
  'src/task/microstructure-alert/lifecycle.ts',
]

describe('createMicrostructureAlert — tick orchestration (module-level)', () => {
  it('has no authenticated trading surface in the alert-only implementation', async () => {
    const forbidden = [
      /api[_-]?key/i,
      /secret/i,
      /signature/i,
      /\/api\/v3\/order\b/i,
      /\/fapi\/v1\/order\b/i,
      /\/sapi\//i,
      /\bPOST\b/,
      /\b(create|place|cancel)Order\b/i,
      /\b(positionSide|leverage|marginType)\b/i,
    ]
    for (const file of alertOnlySourceFiles) {
      const source = await readFile(file, 'utf-8')
      for (const pattern of forbidden) {
        expect(source, `${file} must remain alert-only; forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('has no decision, proposal, risk-gate, or shadow-ledger integration surface', async () => {
    const forbidden = [
      /from ['"].*(?:tool\/trading|domain\/trading|domain\/auto-trading|core\/agent-event)['"]/,
      /from ['"].*(?:shadow-report|decision-report)['"]/,
      /\b(?:stagePlaceOrder|stageModifyOrder|stageClosePosition|stageCancelOrder)\b/,
      /\b(?:riskGate|risk-gate|directionSource)\s*[:=]/i,
      /\b(?:append|write|record).*shadow/i,
      /\bstrategyShadow\b/i,
    ]
    for (const file of alertOnlySourceFiles) {
      const source = await readFile(file, 'utf-8')
      for (const pattern of forbidden) {
        expect(source, `${file} must not integrate alert state into trading/proposal/shadow surfaces; forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('warm-up: first tick writes a baseline and does NOT notify', async () => {
    const acc = fakeAccount('X')
    const pushed: string[] = []
    const cc = { notify: async (t: string) => { pushed.push(t); return {} as any } } as any
    const cfg = baseConfig()

    const m = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc })
    await m.start(); await m.runNow(); m.stop()

    expect(pushed).toEqual([]) // obSamples 0 -> warm-up gate
    const st = JSON.parse(await readFile(cfg.statePath, 'utf-8'))
    expect(st.baselines['BTC/USDT:USDT'].obSamples).toBe(1)
    expect(st.baselines['BTC/USDT:USDT'].spreadPctEwma).toBeGreaterThan(0)
    expect(st.runtimeIdentity).toEqual({ source: 'X', symbols: ['BTC/USDT:USDT'] })
    expect(typeof st.lastOrderBookAtMs).toBe('number')
  })

  it('after warm-up, a spread spike force-pushes a high-priority alert', async () => {
    const acc = fakeAccount('X')
    const pushed: Array<{ text: string; priority?: string }> = []
    const cc = { notify: async (text: string, opts?: { priority?: string }) => { pushed.push({ text, priority: opts?.priority }); return {} as any } } as any
    const cfg = baseConfig()

    const m = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc })
    await m.start()
    await m.runNow() // tick 1: normal book, baseline = 0.1% spread, obSamples 1
    // tick 2: spread blows out to ~0.6% (6x baseline) -> critical
    acc.state.ob = book(99.7, 100.3)
    await m.runNow()
    m.stop()

    expect(pushed).toHaveLength(1)
    expect(pushed[0].priority).toBe('high')
    expect(pushed[0].text).toContain('買賣價差變大')
    expect(pushed[0].text).toContain('BTC/USDT:USDT')
  })

  it('funding clock does NOT advance when funding fails (retry next tick)', async () => {
    const acc = fakeAccount('X')
    acc.state.failFunding = true
    const cc = { notify: async () => ({} as any) } as any
    const cfg = baseConfig()

    const m = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc })
    await m.start(); await m.runNow(); m.stop()

    const st = JSON.parse(await readFile(cfg.statePath, 'utf-8'))
    expect(st.lastFundingAtMs).toBeNull() // not advanced -> will retry next tick
    // order book still processed despite funding failure
    expect(st.baselines['BTC/USDT:USDT'].obSamples).toBe(1)
    expect(typeof st.lastOrderBookAtMs).toBe('number')
  })

  it('order-book clock does NOT advance when order book fails', async () => {
    const acc = fakeAccount('X')
    acc.state.failOrderBook = true
    const cc = { notify: async () => ({} as any) } as any
    const cfg = baseConfig()

    const m = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc, now: () => 1234 })
    await m.start(); await m.runNow(); m.stop()

    const st = JSON.parse(await readFile(cfg.statePath, 'utf-8'))
    expect(st.runtimeIdentity).toEqual({ source: 'X', symbols: ['BTC/USDT:USDT'] })
    expect(st.lastOrderBookAtMs).toBeNull()
    expect(st.lastFundingAtMs).toBe(1234)
    expect(st.baselines['BTC/USDT:USDT'].fundingHistory.length).toBe(1)
  })

  it('funding clock advances once funding succeeds', async () => {
    const acc = fakeAccount('X')
    const cc = { notify: async () => ({} as any) } as any
    const cfg = baseConfig()

    const m = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc, now: () => 1234 })
    await m.start(); await m.runNow(); m.stop()

    const st = JSON.parse(await readFile(cfg.statePath, 'utf-8'))
    expect(st.runtimeIdentity).toEqual({ source: 'X', symbols: ['BTC/USDT:USDT'] })
    expect(st.lastOrderBookAtMs).toBe(1234)
    expect(st.lastFundingAtMs).toBe(1234)
    expect(st.baselines['BTC/USDT:USDT'].fundingHistory.length).toBe(1)
  })

  it('resets old source state before trusting freshness clocks', async () => {
    const acc = fakeAccount('X')
    const cc = { notify: async () => ({} as any) } as any
    const cfg = baseConfig()

    const first = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc, now: () => 1111 })
    await first.start(); await first.runNow(); first.stop()

    const oldState = JSON.parse(await readFile(cfg.statePath, 'utf-8'))
    oldState.runtimeIdentity = { source: 'old-source', symbols: ['DOGE/USDT:USDT'] }
    oldState.lastOrderBookAtMs = 999
    oldState.lastFundingAtMs = 999
    await writeFile(cfg.statePath, JSON.stringify(oldState), 'utf-8')

    const second = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc, now: () => 1234 })
    await second.start(); await second.runNow(); second.stop()

    const st = JSON.parse(await readFile(cfg.statePath, 'utf-8'))
    expect(st.runtimeIdentity).toEqual({ source: 'X', symbols: ['BTC/USDT:USDT'] })
    expect(st.lastOrderBookAtMs).toBe(1234)
    expect(st.lastFundingAtMs).toBe(1234)
    expect(st.baselines['BTC/USDT:USDT'].obSamples).toBe(1)
    expect(st.baselines['BTC/USDT:USDT'].fundingHistory).toHaveLength(1)
  })

  it('does not reset or overwrite an unreadable state file', async () => {
    const acc = fakeAccount('X')
    const pushed: string[] = []
    const cc = { notify: async (text: string) => { pushed.push(text); return {} as any } } as any
    const cfg = baseConfig()
    await writeFile(cfg.statePath, '{not json', 'utf-8')

    const m = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc })
    await m.start(); await m.runNow(); m.stop()

    expect(pushed).toEqual([])
    expect(await readFile(cfg.statePath, 'utf-8')).toBe('{not json')
  })

  it('does not reset or overwrite a malformed state schema', async () => {
    const acc = fakeAccount('X')
    const pushed: string[] = []
    const cc = { notify: async (text: string) => { pushed.push(text); return {} as any } } as any
    const cfg = baseConfig()
    await writeFile(cfg.statePath, JSON.stringify({ baselines: [], lifecycles: {}, lastFundingAtMs: null }) + '\n', 'utf-8')

    const m = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc })
    await m.start(); await m.runNow(); m.stop()

    expect(pushed).toEqual([])
    const saved = JSON.parse(await readFile(cfg.statePath, 'utf-8')) as Record<string, unknown>
    expect(Array.isArray(saved['baselines'])).toBe(true)
  })
})
