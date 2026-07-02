import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { KlineRow } from '../../trading/risk-gates/regime/provider.js'
import type { DailyStrategy } from './types.js'
import type { ResearchShadowConfig, ResearchShadowConfigResolution } from './config.js'
import { effectiveRows, readLedgerRows } from './ledger.js'
import { startResearchShadow } from './shadow.js'

const DAY = 86_400_000
const NOW = '2026-06-15T08:00:00Z' // 8h into the day — past the 6h grace

function candlesEnding(lastDay: string, closes: number[]): KlineRow[] {
  const lastOpen = Date.parse(`${lastDay}T00:00:00Z`)
  return closes.map((c, i) => {
    const open = lastOpen - (closes.length - 1 - i) * DAY
    return [open, String(c), String(c), String(c), String(c), '0', open + DAY - 1] as KlineRow
  })
}

function strategy(id: string, symbol = 'TESTUSDT'): DailyStrategy {
  return {
    id,
    symbol,
    venue: 'binance_spot',
    registrationDoc: 'docs/shadow-strategies/test.md',
    dataNeeds: { kinds: ['klines'], minDays: 2 },
    compute: () => ({ stance: 'long' }),
  }
}

function okConfig(overrides: Partial<ResearchShadowConfig> = {}): () => Promise<ResearchShadowConfigResolution> {
  return async () => ({
    status: 'ok',
    source: 'defaults',
    config: {
      enabled: true,
      costModel: { feeBpsPerLeg: 7, slippageBpsPerLeg: 3 },
      maxBackfillDays: 14,
      staleGraceHours: 6,
      strategies: {},
      ...overrides,
    },
  })
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shadow-timer-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const HUGE = 3_600_000

describe('startResearchShadow — orchestration', () => {
  it('fetches ONCE per symbol per scoring pass, shared across strategies; an all-done day costs zero fetches', async () => {
    let fetches = 0
    const handle = startResearchShadow({
      strategies: [strategy('s-one'), strategy('s-two')],
      loadConfig: okConfig(),
      fetchKlines: async () => { fetches++; return candlesEnding('2026-06-14', [100, 101, 102]) },
      intervalMs: HUGE,
      now: () => new Date(NOW),
      ledgerPathFor: (id) => join(dir, `${id}.jsonl`),
    })
    await handle.tick() // joins (or follows) the constructor's immediate tick
    handle.stop()
    expect(fetches).toBe(1)
    expect(await readLedgerRows(join(dir, 's-one.jsonl'))).toHaveLength(1)
    expect(await readLedgerRows(join(dir, 's-two.jsonl'))).toHaveLength(1)
    // Everything scored for the day — the next tick must not fetch at all.
    await handle.tick()
    expect(fetches).toBe(1)
  })

  it('invalid config → idles loudly, zero fetches, zero rows', async () => {
    let fetches = 0
    const handle = startResearchShadow({
      strategies: [strategy('s-one')],
      loadConfig: async () => ({ status: 'invalid', error: 'bad json' }),
      fetchKlines: async () => { fetches++; return [] },
      intervalMs: HUGE,
      now: () => new Date(NOW),
      ledgerPathFor: (id) => join(dir, `${id}.jsonl`),
    })
    await handle.tick()
    handle.stop()
    expect(fetches).toBe(0)
    expect(await readLedgerRows(join(dir, 's-one.jsonl'))).toHaveLength(0)
  })

  it('a disabled strategy is skipped entirely (its days become evidence gaps, not rows)', async () => {
    let fetches = 0
    const handle = startResearchShadow({
      strategies: [strategy('s-off')],
      loadConfig: okConfig({ strategies: { 's-off': { enabled: false } } }),
      fetchKlines: async () => { fetches++; return candlesEnding('2026-06-14', [100, 101]) },
      intervalMs: HUGE,
      now: () => new Date(NOW),
      ledgerPathFor: (id) => join(dir, `${id}.jsonl`),
    })
    await handle.tick()
    handle.stop()
    expect(fetches).toBe(0)
    expect(await readLedgerRows(join(dir, 's-off.jsonl'))).toHaveLength(0)
  })

  it('discards the in-progress candle before any strategy sees it (no lookahead)', async () => {
    const nowMs = Date.parse(NOW)
    const inProgress: KlineRow = [
      Date.parse('2026-06-15T00:00:00Z'), '999', '999', '999', '999', '0',
      nowMs + 16 * 3_600_000, // closes in the future
    ]
    const handle = startResearchShadow({
      strategies: [strategy('s-one')],
      loadConfig: okConfig(),
      fetchKlines: async () => [...candlesEnding('2026-06-14', [100, 102]), inProgress],
      intervalMs: HUGE,
      now: () => new Date(NOW),
      ledgerPathFor: (id) => join(dir, `${id}.jsonl`),
    })
    await handle.tick()
    handle.stop()
    const eff = effectiveRows(await readLedgerRows(join(dir, 's-one.jsonl')))
    expect(eff.size).toBe(1)
    const row = eff.get('2026-06-14')
    if (row?.kind !== 'day') throw new Error('expected the completed day, not the in-progress one')
    expect(row.close).toBe('102') // never 999
  })

  it("one strategy's failure does not stop the others", async () => {
    // Give the first strategy an impossible ledger path (under a regular
    // file) so its append throws; the second must still be scored.
    await writeFile(join(dir, 'blocker'), 'i am a file')
    const handle = startResearchShadow({
      strategies: [strategy('s-broken'), strategy('s-fine')],
      loadConfig: okConfig(),
      fetchKlines: async () => candlesEnding('2026-06-14', [100, 101]),
      intervalMs: HUGE,
      now: () => new Date(NOW),
      ledgerPathFor: (id) =>
        id === 's-broken' ? join(dir, 'blocker', 'impossible.jsonl') : join(dir, `${id}.jsonl`),
    })
    await handle.tick()
    handle.stop()
    expect(await readLedgerRows(join(dir, 's-fine.jsonl'))).toHaveLength(1)
  })

  it('kline fetch failure degrades to an unknown row for the expected day (past grace), never a throw', async () => {
    const handle = startResearchShadow({
      strategies: [strategy('s-one')],
      loadConfig: okConfig(),
      fetchKlines: async () => { throw new Error('binance down') },
      intervalMs: HUGE,
      now: () => new Date(NOW),
      ledgerPathFor: (id) => join(dir, `${id}.jsonl`),
    })
    await handle.tick()
    handle.stop()
    const rows = await readLedgerRows(join(dir, 's-one.jsonl'))
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('unknown')
    if (rows[0].kind !== 'unknown') return
    expect(rows[0].reason).toContain('binance down')
  })

  it('an unreadable ledger idles that strategy WITHOUT scoring; others are unaffected', async () => {
    // s-broken's ledger path is a directory → EISDIR on read (not ENOENT):
    // must be skipped (no fake cold start), while s-fine still scores.
    const brokenLedger = join(dir, 'broken-ledger')
    await mkdir(brokenLedger)
    const handle = startResearchShadow({
      strategies: [strategy('s-broken'), strategy('s-fine')],
      loadConfig: okConfig(),
      fetchKlines: async () => candlesEnding('2026-06-14', [100, 101]),
      intervalMs: HUGE,
      now: () => new Date(NOW),
      ledgerPathFor: (id) => (id === 's-broken' ? brokenLedger : join(dir, `${id}.jsonl`)),
    })
    await handle.tick()
    handle.stop()
    expect(await readLedgerRows(join(dir, 's-fine.jsonl'))).toHaveLength(1)
    // The broken one was idled, not "restarted": its path is still a bare
    // directory (an anchor append would have failed loudly anyway — the
    // point is the read error was never mistaken for an empty track).
    await expect(readLedgerRows(brokenLedger)).rejects.toThrow()
  })

  it('refuses to score into a cloud-synced (OneDrive) data root — the ledger is evidence', async () => {
    let fetches = 0
    const handle = startResearchShadow({
      strategies: [strategy('s-one')],
      loadConfig: okConfig(),
      fetchKlines: async () => { fetches++; return candlesEnding('2026-06-14', [100, 101]) },
      intervalMs: HUGE,
      now: () => new Date(NOW),
      ledgerPathFor: (id) => join(dir, 'OneDrive', 'Desktop', `${id}.jsonl`),
    })
    await handle.tick()
    handle.stop()
    expect(fetches).toBe(0)
    expect(await readLedgerRows(join(dir, 'OneDrive', 'Desktop', 's-one.jsonl'))).toHaveLength(0)
  })

  it('stop() halts the timer', async () => {
    let configLoads = 0
    const loadConfig = async (): Promise<ResearchShadowConfigResolution> => {
      configLoads++
      return { status: 'invalid', error: 'probe' } // cheapest tick body
    }
    const handle = startResearchShadow({
      strategies: [strategy('s-one')],
      loadConfig,
      fetchKlines: async () => [],
      intervalMs: 30,
      now: () => new Date(NOW),
      ledgerPathFor: (id) => join(dir, `${id}.jsonl`),
    })
    await handle.tick()
    handle.stop()
    await new Promise(r => setTimeout(r, 60)) // let anything in flight settle
    const after = configLoads
    await new Promise(r => setTimeout(r, 150))
    expect(configLoads).toBe(after) // no more ticks after stop
  })
})
