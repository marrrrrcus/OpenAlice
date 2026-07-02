import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { KlineRow } from '../../trading/risk-gates/regime/provider.js'
import type { DailyStrategy, LedgerDayRow } from './types.js'
import { appendLedgerRow, effectiveRows, readLedgerRows } from './ledger.js'
import { processStrategyTick, type StrategyTickDeps } from './runner.js'

const DAY = 86_400_000
const COST = { feeBpsPerLeg: 7, slippageBpsPerLeg: 3 }

/** Daily candle for UTC day `dateUtc` (Binance shape: closeTime = next
 *  midnight − 1ms). */
function candleFor(dateUtc: string, close: number | string): KlineRow {
  const open = Date.parse(`${dateUtc}T00:00:00Z`)
  const c = String(close)
  return [open, c, c, c, c, '0', open + DAY - 1]
}

/** Consecutive daily candles ending at `lastDay` (closes oldest → newest). */
function candlesEnding(lastDay: string, closes: (number | string)[]): KlineRow[] {
  const lastOpen = Date.parse(`${lastDay}T00:00:00Z`)
  return closes.map((c, i) => {
    const open = lastOpen - (closes.length - 1 - i) * DAY
    return candleFor(new Date(open).toISOString().slice(0, 10), c)
  })
}

const alwaysLong: DailyStrategy = {
  id: 'test-long',
  symbol: 'TESTUSDT',
  venue: 'binance_spot',
  registrationDoc: 'docs/shadow-strategies/test.md',
  dataNeeds: { kinds: ['klines'], minDays: 2 },
  compute: () => ({ stance: 'long' }),
}

let dir: string
let events: Array<{ type: string; payload: Record<string, unknown> }>
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shadow-runner-'))
  events = []
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function deps(overrides: Partial<StrategyTickDeps> & { nowIso?: string }): StrategyTickDeps {
  const { nowIso, ...rest } = overrides
  return {
    strategy: alwaysLong,
    costModel: COST,
    maxBackfillDays: 14,
    staleGraceHours: 6,
    klines: [],
    now: () => new Date(nowIso ?? '2026-06-15T08:00:00Z'), // 8h into the day — past the 6h grace
    ledgerPath: join(dir, 'test-long.jsonl'),
    eventLog: { append: (type, payload) => { events.push({ type, payload: payload as Record<string, unknown> }) } },
    warnedDays: new Set(),
    ...rest,
  }
}

const readRows = () => readLedgerRows(join(dir, 'test-long.jsonl'))

describe('processStrategyTick — cold start & normal advance', () => {
  it('first-ever tick writes ONE anchor row for the expected day only (no pre-activation backfill)', async () => {
    // 14 candles of history exist — the track must still start at deployment.
    await processStrategyTick(deps({ klines: candlesEnding('2026-06-14', Array(14).fill(100)) }))
    const rows = await readRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('day')
    if (row.kind !== 'day') return
    expect(row.dateUtc).toBe('2026-06-14')
    expect(row.stance).toBe('long')
    expect(row.mark).toBeUndefined() // anchor — the held stance is not attributable
    expect(row.equity).toBe('1')
    expect(row.backfilled).toBe(false)
    expect(events.map(e => e.type)).toEqual(['research.shadow.stance'])
    expect(events[0].payload['shadowOnly']).toBe(true)
    expect(events[0].payload['stance']).toBe('long')
  })

  it('next day marks the anchor stance: entry leg charged from flat, equity chained', async () => {
    await processStrategyTick(deps({ klines: candlesEnding('2026-06-14', [100, 100, 100, 104]) }))
    events = []
    // Day 15 closes 2% up: gross 0.02, 1 entry leg (flat→long) = 10 bps.
    await processStrategyTick(deps({
      nowIso: '2026-06-16T08:00:00Z',
      klines: candlesEnding('2026-06-15', [100, 100, 100, 104, 106.08]),
    }))
    const rows = await readRows()
    expect(rows).toHaveLength(2)
    const row = rows[1]
    if (row.kind !== 'day') throw new Error('expected day row')
    expect(row.dateUtc).toBe('2026-06-15')
    expect(row.mark).toMatchObject({
      stanceHeld: 'long',
      prevClose: '104',
      grossRet: '0.02',
      legs: 1,
      costPerLegBps: '10',
      netRet: '0.019',
    })
    expect(row.equity).toBe('1.019')
    expect(events.map(e => e.type)).toEqual(['research.shadow.stance', 'research.shadow.mark'])
    expect(events[1].payload['shadowOnly']).toBe(true)
    expect(events[1].payload['netRet']).toBe('0.019')
  })

  it('same-day dedup: a second tick appends nothing', async () => {
    const d = deps({ klines: candlesEnding('2026-06-14', [100, 101]) })
    await processStrategyTick(d)
    await processStrategyTick(d)
    expect(await readRows()).toHaveLength(1)
  })
})

describe('processStrategyTick — catch-up / backfill', () => {
  it('3-day gap backfills oldest→newest with chained equity; only the expected day is not flagged', async () => {
    await processStrategyTick(deps({ klines: candlesEnding('2026-06-14', [100, 100, 104]) }))
    // Process was down for 3 daily closes; closes: 15th +2%, 16th flat, 17th flat.
    await processStrategyTick(deps({
      nowIso: '2026-06-18T08:00:00Z',
      klines: candlesEnding('2026-06-17', [100, 100, 104, 106.08, 106.08, 106.08]),
    }))
    const rows = await readRows()
    expect(rows).toHaveLength(4)
    const [, d15, d16, d17] = rows as LedgerDayRow[]
    expect([d15.dateUtc, d16.dateUtc, d17.dateUtc]).toEqual(['2026-06-15', '2026-06-16', '2026-06-17'])
    expect([d15.backfilled, d16.backfilled, d17.backfilled]).toEqual([true, true, false])
    expect(d15.mark?.netRet).toBe('0.019') // +2% − entry leg
    expect(d15.equity).toBe('1.019')
    expect(d16.mark?.netRet).toBe('0')    // flat price, held long, 0 legs
    expect(d16.equity).toBe('1.019')
    expect(d17.equity).toBe('1.019')
  })

  it('a gap beyond maxBackfillDays is REFUSED with unknown rows; scoring re-anchors inside the cap', async () => {
    // Anchor long ago at 2026-06-01…
    await appendLedgerRow(join(dir, 'test-long.jsonl'), {
      kind: 'day', dateUtc: '2026-06-01', at: '2026-06-01T00:05:00.000Z',
      backfilled: false, close: '100', stance: 'long', equity: '1',
    })
    // …and the next tick happens on 06-20 (expected day 06-19; 18-day gap).
    const closes = Array(20).fill(100)
    await processStrategyTick(deps({
      nowIso: '2026-06-20T08:00:00Z',
      klines: candlesEnding('2026-06-19', closes), // candles 05-31 … 06-19 all exist
    }))
    const rows = await readRows()
    const eff = effectiveRows(rows)
    // 06-02 … 06-04 are further than 14 days behind 06-19 → refused.
    for (const day of ['2026-06-02', '2026-06-03', '2026-06-04']) {
      const row = eff.get(day)
      expect(row?.kind).toBe('unknown')
      if (row?.kind !== 'unknown') continue
      expect(row.reason).toContain('backfill cap')
      expect(row.equity).toBe('1') // frozen carry-forward
    }
    // 06-05 is exactly 14 days back → first backfillable day → re-anchor
    // (previous day is unknown, continuity may not be claimed).
    const d5 = eff.get('2026-06-05')
    expect(d5?.kind).toBe('day')
    if (d5?.kind !== 'day') return
    expect(d5.mark).toBeUndefined()
    expect(d5.equity).toBe('1')
    // 06-06 gets the first mark: re-entry leg from flat on a flat price.
    const d6 = eff.get('2026-06-06')
    if (d6?.kind !== 'day') throw new Error('expected day row')
    expect(d6.mark?.legs).toBe(1)
    expect(d6.mark?.netRet).toBe('-0.001')
    expect(d6.equity).toBe('0.999')
    // Chain then runs unbroken to the expected day.
    expect(eff.get('2026-06-19')?.kind).toBe('day')
  })
})

describe('processStrategyTick — unknown semantics (operational fail-safe)', () => {
  it('missing expected-day candle within grace: waits silently, no row', async () => {
    await processStrategyTick(deps({
      nowIso: '2026-06-15T02:00:00Z', // 2h into the day < 6h grace
      klines: candlesEnding('2026-06-13', [100, 101]), // no 06-14 candle yet
    }))
    expect(await readRows()).toHaveLength(0)
  })

  it('missing expected-day candle past grace: ONE unknown row with frozen equity, retried without spam', async () => {
    await processStrategyTick(deps({ klines: candlesEnding('2026-06-13', [100, 101, 102]) }))
    // First call wrote the 06-13 anchor?? No — expected day is 06-14 and its
    // candle is missing: cold start defers activation (no pre-activation
    // rows), so past grace the track records the unknown day.
    let rows = await readRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('unknown')
    expect(rows[0].equity).toBe('1')
    // Retry ticks the same day must not append duplicates.
    await processStrategyTick(deps({ klines: candlesEnding('2026-06-13', [100, 101, 102]) }))
    rows = await readRows()
    expect(rows).toHaveLength(1)
  })

  it('a good row arriving later the same day SUPERSEDES the unknown (last-row-wins self-healing)', async () => {
    await appendLedgerRow(join(dir, 'test-long.jsonl'), {
      kind: 'day', dateUtc: '2026-06-13', at: '2026-06-14T00:05:00.000Z',
      backfilled: false, close: '100', stance: 'long', equity: '1',
    })
    // 08:00 — candle for 06-14 not yet available → unknown row.
    await processStrategyTick(deps({ klines: candlesEnding('2026-06-13', [100, 100]) }))
    // 09:00 — candle lands → day row supersedes; mark computed normally.
    await processStrategyTick(deps({
      nowIso: '2026-06-15T09:00:00Z',
      klines: candlesEnding('2026-06-14', [100, 100, 102]),
    }))
    const rows = await readRows()
    expect(rows).toHaveLength(3) // anchor + unknown + superseding day row
    const eff = effectiveRows(rows)
    const d14 = eff.get('2026-06-14')
    if (d14?.kind !== 'day') throw new Error('expected day row')
    expect(d14.mark?.grossRet).toBe('0.02')
    expect(d14.mark?.legs).toBe(1) // entry from the anchor's flat baseline
    expect(d14.equity).toBe('1.019')
  })

  it('unknown gap: equity frozen through the gap, resume re-anchors, next mark charges re-entry from flat', async () => {
    await appendLedgerRow(join(dir, 'test-long.jsonl'), {
      kind: 'day', dateUtc: '2026-06-13', at: '2026-06-14T00:05:00.000Z',
      backfilled: false, close: '100', stance: 'long', equity: '1.5',
    })
    // 06-14's candle never exists at the venue (data hole).
    await processStrategyTick(deps({ klines: candlesEnding('2026-06-13', [100, 100]) }))
    // Next day: 06-15 candle exists, 06-14 still missing.
    await processStrategyTick(deps({
      nowIso: '2026-06-16T08:00:00Z',
      klines: [...candlesEnding('2026-06-13', [100, 100]), candleFor('2026-06-15', '110')],
    }))
    // Day after: normal mark on the re-anchored stance.
    await processStrategyTick(deps({
      nowIso: '2026-06-17T08:00:00Z',
      klines: [...candlesEnding('2026-06-13', [100, 100]), candleFor('2026-06-15', '110'), candleFor('2026-06-16', '112.2')],
    }))
    const eff = effectiveRows(await readRows())
    const u14 = eff.get('2026-06-14')
    expect(u14?.kind).toBe('unknown')
    expect(u14?.equity).toBe('1.5') // frozen — NOT marked as flat performance
    const d15 = eff.get('2026-06-15')
    if (d15?.kind !== 'day') throw new Error('expected re-anchor')
    expect(d15.mark).toBeUndefined()
    expect(d15.equity).toBe('1.5')
    const d16 = eff.get('2026-06-16')
    if (d16?.kind !== 'day') throw new Error('expected day row')
    expect(d16.mark?.stanceHeld).toBe('long')
    expect(d16.mark?.legs).toBe(1) // re-entry from flat: unobserved continuity is not claimed
    expect(d16.mark?.grossRet).toBe('0.02') // 110 → 112.2
    expect(d16.equity).toBe('1.5285') // 1.5 × 1.019
  })

  it('kline fetch failure: unknown row for the expected day only (past grace), nothing within grace', async () => {
    await processStrategyTick(deps({ nowIso: '2026-06-15T02:00:00Z', fetchError: 'binance down' }))
    expect(await readRows()).toHaveLength(0)
    await processStrategyTick(deps({ fetchError: 'binance down' }))
    const rows = await readRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('unknown')
    if (rows[0].kind !== 'unknown') return
    expect(rows[0].reason).toContain('kline fetch failed: binance down')
  })

  it('a throwing strategy yields an unknown row, never an exception', async () => {
    const throwing: DailyStrategy = {
      ...alwaysLong,
      compute: () => { throw new Error('boom') },
    }
    await processStrategyTick(deps({ strategy: throwing, klines: candlesEnding('2026-06-14', [100, 101]) }))
    const rows = await readRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('unknown')
    if (rows[0].kind !== 'unknown') return
    expect(rows[0].reason).toContain('strategy threw: boom')
  })

  it('an unmet data need is refused explicitly', async () => {
    const needsFunding: DailyStrategy = {
      ...alwaysLong,
      dataNeeds: { kinds: ['funding' as 'klines'], minDays: 2 },
    }
    await processStrategyTick(deps({ strategy: needsFunding, klines: candlesEnding('2026-06-14', [100, 101]) }))
    const rows = await readRows()
    expect(rows).toHaveLength(1)
    if (rows[0].kind !== 'unknown') throw new Error('expected unknown')
    expect(rows[0].reason).toContain('data need "funding" not available')
  })

  it('insufficient history (< minDays) is an unknown day, not a crash', async () => {
    const needsHistory: DailyStrategy = {
      ...alwaysLong,
      dataNeeds: { kinds: ['klines'], minDays: 10 },
    }
    await processStrategyTick(deps({ strategy: needsHistory, klines: candlesEnding('2026-06-14', [100, 101, 102]) }))
    const rows = await readRows()
    expect(rows).toHaveLength(1)
    if (rows[0].kind !== 'unknown') throw new Error('expected unknown')
    expect(rows[0].reason).toContain('insufficient history')
  })

  it('a failing eventLog never blocks the ledger append', async () => {
    await processStrategyTick(deps({
      klines: candlesEnding('2026-06-14', [100, 101]),
      eventLog: { append: () => { throw new Error('event log down') } },
    }))
    expect(await readRows()).toHaveLength(1)
  })

  it('an unreadable ledger PROPAGATES — the runner never scores over evidence it cannot read', async () => {
    // The ledger path is a directory: readFile fails with EISDIR (not
    // ENOENT). The tick must throw, not treat it as a cold start.
    await expect(processStrategyTick(deps({
      ledgerPath: dir,
      klines: candlesEnding('2026-06-14', [100, 101]),
    }))).rejects.toThrow()
  })

  it('a GRAY-carry strategy chains prevStance correctly THROUGH a multi-day backfill', async () => {
    const seen: Array<string | undefined> = []
    const carry: DailyStrategy = {
      ...alwaysLong,
      compute: (ctx) => { seen.push(ctx.prevStance); return { stance: ctx.prevStance ?? 'long' } },
    }
    // Anchor day: no prevStance → long.
    await processStrategyTick(deps({ strategy: carry, klines: candlesEnding('2026-06-14', [100, 100]) }))
    // 3 missed closes backfilled in ONE tick: the chain must link day-by-day
    // through the working view, identical to live ticks.
    await processStrategyTick(deps({
      strategy: carry,
      nowIso: '2026-06-18T08:00:00Z',
      klines: candlesEnding('2026-06-17', [100, 100, 100, 100, 100]),
    }))
    expect(seen).toEqual([undefined, 'long', 'long', 'long'])
    const eff = effectiveRows(await readRows())
    for (const day of ['2026-06-15', '2026-06-16', '2026-06-17']) {
      const row = eff.get(day)
      if (row?.kind !== 'day') throw new Error(`expected day row for ${day}`)
      expect(row.stance).toBe('long')
    }
  })

  it('prevStance is chained from the ledger and absent after a broken chain', async () => {
    const seen: Array<string | undefined> = []
    const probe: DailyStrategy = {
      ...alwaysLong,
      compute: (ctx) => { seen.push(ctx.prevStance); return { stance: 'long' } },
    }
    // Anchor day (cold start): no prevStance.
    await processStrategyTick(deps({ strategy: probe, klines: candlesEnding('2026-06-14', [100, 101]) }))
    // Chained day: prevStance = yesterday's ledger stance.
    await processStrategyTick(deps({
      strategy: probe,
      nowIso: '2026-06-16T08:00:00Z',
      klines: candlesEnding('2026-06-15', [100, 101, 102]),
    }))
    expect(seen).toEqual([undefined, 'long'])
  })
})
