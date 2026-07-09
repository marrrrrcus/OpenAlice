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
  const state = { ob: book() as any, funding: 0.0001 as number | null, failFunding: false }
  return {
    state,
    sdk: {
      id,
      getOrderBook: async () => state.ob,
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

describe('createMicrostructureAlert — tick orchestration (module-level)', () => {
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
  })

  it('funding clock advances once funding succeeds', async () => {
    const acc = fakeAccount('X')
    const cc = { notify: async () => ({} as any) } as any
    const cfg = baseConfig()

    const m = createMicrostructureAlert({ config: cfg, manager: fakeManager(acc.sdk), connectorCenter: cc, now: () => 1234 })
    await m.start(); await m.runNow(); m.stop()

    const st = JSON.parse(await readFile(cfg.statePath, 'utf-8'))
    expect(st.lastFundingAtMs).toBe(1234)
    expect(st.baselines['BTC/USDT:USDT'].fundingHistory.length).toBe(1)
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
