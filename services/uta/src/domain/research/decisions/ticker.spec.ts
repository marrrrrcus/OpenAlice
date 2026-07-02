import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { startDecisionsTicker, type DecisionsTickerOptions } from './ticker.js'
import type { ResearchDecisionsConfigResolution } from './config.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'decisions-ticker-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const okConfig = (): Promise<ResearchDecisionsConfigResolution> => Promise.resolve({
  status: 'ok', source: 'defaults',
  config: {
    enabled: true, captureMockAccounts: false,
    marker: { enabled: true, graceHours: 6, fetchPageDays: 1000 },
    funding: { enabled: true },
  },
})

function opts(over: Partial<DecisionsTickerOptions> = {}): DecisionsTickerOptions {
  return {
    loadConfig: okConfig,
    fetchDailyOhlcv: async () => [],
    venueOf: () => 'binanceusdm',
    fetchFundingHistory: async () => [],
    loadRegimeZones: async () => new Map(),
    ledgerDir: dir,
    intervalMs: 3_600_000,
    now: () => new Date('2026-07-04T08:00:00Z'),
    ...over,
  }
}

describe('decisions ticker', () => {
  it('empty ledger dir → tick completes without work or errors', async () => {
    const handle = startDecisionsTicker(opts())
    await handle.tick()
    handle.stop()
  })

  it('OneDrive ledger dir → idles (never scans, never writes)', async () => {
    let loads = 0
    const handle = startDecisionsTicker(opts({
      ledgerDir: join(dir, 'OneDrive', 'x'),
      loadConfig: () => { loads++; return okConfig() },
    }))
    await handle.tick()
    handle.stop()
    expect(loads).toBe(0) // refused before even loading config
  })

  it('invalid config / disabled → idle', async () => {
    const invalid = startDecisionsTicker(opts({ loadConfig: async () => ({ status: 'invalid', error: 'bad' }) }))
    await invalid.tick()
    invalid.stop()

    const disabled = startDecisionsTicker(opts({
      loadConfig: async () => ({
        status: 'ok', source: 'file',
        config: { enabled: false, captureMockAccounts: false, marker: { enabled: true, graceHours: 6, fetchPageDays: 1000 }, funding: { enabled: true } },
      }),
    }))
    await disabled.tick()
    disabled.stop()
  })

  it('in-flight join: concurrent ticks share one run; stop() halts the timer', async () => {
    let runs = 0
    const handle = startDecisionsTicker(opts({
      intervalMs: 25,
      loadConfig: async () => { runs++; await new Promise(r => setTimeout(r, 30)); return { status: 'invalid', error: 'probe' } },
    }))
    const [a, b] = [handle.tick(), handle.tick()]
    await Promise.all([a, b])
    expect(runs).toBe(1) // joined
    handle.stop()
    await new Promise(r => setTimeout(r, 60))
    const settled = runs
    await new Promise(r => setTimeout(r, 120))
    expect(runs).toBe(settled)
  })
})
