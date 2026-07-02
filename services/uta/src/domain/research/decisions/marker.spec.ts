import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendRow,
  decisionsDerivedPath,
  decisionsLedgerPath,
  effectiveFundingContext,
  effectiveMarks,
  effectiveRegimeContext,
  markKey,
  readDerivedRows,
} from './ledger.js'
import { processMarkTick, type MarkTickDeps } from './marker.js'
import type { DailyCandleInput } from './marks.js'
import type { DecisionChildRow, DecisionParentRow, ResearchDecisionsConfig } from './types.js'
import type { SettledFundingRow } from './funding.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'decisions-marker-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const DAY = 86_400_000
const H8 = 8 * 3_600_000
const cfg: ResearchDecisionsConfig = {
  enabled: true, captureMockAccounts: false,
  marker: { enabled: true, graceHours: 6, fetchPageDays: 1000 },
  funding: { enabled: true },
}

// Decision at 2026-07-03T10:00Z → anchor day 2026-07-04.
const DECIDED_AT = '2026-07-03T10:00:00.000Z'
const parent: DecisionParentRow = {
  kind: 'push', v: 1, id: 'dec:acct:h1', accountId: 'acct', presetId: 'ccxt-custom',
  capturedAt: DECIDED_AT, decidedAt: DECIDED_AT, pendingHash: 'h1', message: 'm',
  gateSummary: { mode: 'observe', result: 'PASS', configSource: 'file', evaluatedAt: DECIDED_AT, verdicts: [] },
  override: false, overrideReason: null, thesis: null, results: { submitted: 1, rejected: 0 }, childCount: 1,
}
const child: DecisionChildRow = {
  kind: 'intent', v: 1, id: 'dec:acct:h1#0', parentId: 'dec:acct:h1', accountId: 'acct',
  capturedAt: DECIDED_AT, opIndex: 0, opAction: 'placeOrder',
  nativeKey: 'BTC/USDT:USDT', symbol: 'BTC',
  intent: { kind: 'risk-increasing', rationale: 'r' }, role: 'entry', side: 'LONG',
  markSide: 'LONG', markSideMeaning: 'entry', pricedBy: 'lmtPrice',
  context: {
    regime: { zone: 'UNKNOWN', contextSource: 'live', reason: 'unavailable' },
    funding: { bucket: 'unavailable', contextSource: 'live' },
  },
}

/** Flat 100-candles from 2026-07-01 through `lastDay`. */
function candlesThrough(lastDay: string): DailyCandleInput[] {
  const out: DailyCandleInput[] = []
  for (let ms = Date.parse('2026-07-01T00:00:00Z'); ms <= Date.parse(`${lastDay}T00:00:00Z`); ms += DAY) {
    const d = new Date(ms).toISOString().slice(0, 10)
    out.push({ dateUtc: d, open: '100', high: '110', low: '90', close: '100' })
  }
  return out
}

function deps(over: Partial<MarkTickDeps> & { nowIso: string; candles?: DailyCandleInput[] }): MarkTickDeps {
  const { nowIso, candles, ...rest } = over
  return {
    ledgerDir: dir,
    config: cfg,
    now: () => new Date(nowIso),
    listAccountIds: async () => ['acct'],
    fetchDailyOhlcv: async () => candles ?? candlesThrough(new Date(Date.parse(nowIso) - DAY).toISOString().slice(0, 10)),
    venueOf: () => 'binanceusdm',
    fetchFundingHistory: async () => { throw new Error('funding fetch not stubbed') },
    loadRegimeZones: async () => new Map(),
    ...rest,
  }
}

async function seedBase(): Promise<void> {
  const path = decisionsLedgerPath('acct', dir)
  await appendRow(path, parent)
  await appendRow(path, child)
}

const derived = () => readDerivedRows(decisionsDerivedPath('acct', dir))

describe('marker — horizon marks', () => {
  it('marks exactly the due horizons (grace respected), idempotent on re-tick', async () => {
    await seedBase()
    // 2026-07-06T08:00Z: 1D (exit 07-04, due 07-05T06Z) and 3D (exit 07-06 —
    // NOT yet: due 07-07T06Z). Only 1D marks.
    const d1 = deps({ nowIso: '2026-07-06T08:00:00.000Z', fetchFundingHistory: async () => [] })
    await processMarkTick(d1)
    let marks = effectiveMarks(await derived())
    expect(marks.get(markKey(child.id, '1D'))?.status).toBe('marked')
    expect(marks.get(markKey(child.id, '1D'))?.ret).toBe('0') // flat closes
    expect(marks.get(markKey(child.id, '1D'))?.mae).toBe('-0.1')
    expect(marks.has(markKey(child.id, '3D'))).toBe(false)
    const countAfterFirst = (await derived()).filter(r => r.kind === 'mark').length

    await processMarkTick(d1) // idempotent
    expect((await derived()).filter(r => r.kind === 'mark').length).toBe(countAfterFirst)
  })

  it('NO backfill cap: a marker down for months fills every horizon on one tick', async () => {
    await seedBase()
    await processMarkTick(deps({ nowIso: '2026-10-15T08:00:00.000Z', fetchFundingHistory: async () => [] }))
    const marks = effectiveMarks(await derived())
    for (const h of ['1D', '3D', '7D', '30D'] as const) {
      expect(marks.get(markKey(child.id, h))?.status).toBe('marked')
    }
  })

  it('structural inability (fetchDailyOhlcv → undefined) → unmarkable once, then superseded on recovery', async () => {
    await seedBase()
    const noCandles = deps({ nowIso: '2026-07-06T08:00:00.000Z', fetchDailyOhlcv: async () => undefined, fetchFundingHistory: async () => [] })
    await processMarkTick(noCandles)
    await processMarkTick(noCandles) // no spam
    const unmarkables = (await derived()).filter(r => r.kind === 'mark' && r.status === 'unmarkable')
    expect(unmarkables).toHaveLength(1)

    await processMarkTick(deps({ nowIso: '2026-07-06T09:00:00.000Z', fetchFundingHistory: async () => [] }))
    expect(effectiveMarks(await derived()).get(markKey(child.id, '1D'))?.status).toBe('marked')
  })

  it('venue depth ends after the anchor → unmarkable with reason; transient fetch throw → nothing', async () => {
    await seedBase()
    // Candles only from 2026-08-01 — anchor 07-04 is beyond depth.
    const shallow: DailyCandleInput[] = [{ dateUtc: '2026-08-01', open: '100', high: '110', low: '90', close: '100' }]
    await processMarkTick(deps({ nowIso: '2026-08-03T08:00:00.000Z', candles: shallow, fetchFundingHistory: async () => [] }))
    const mark = effectiveMarks(await derived()).get(markKey(child.id, '1D'))
    expect(mark?.status).toBe('unmarkable')
    expect(mark?.reason).toContain('candle depth')

    const before = (await derived()).length
    await processMarkTick(deps({ nowIso: '2026-08-03T09:00:00.000Z', fetchDailyOhlcv: async () => { throw new Error('down') }, fetchFundingHistory: async () => [] }))
    expect((await derived()).length).toBe(before)
  })
})

describe('marker — derived context backfills', () => {
  it('funding: computes a derived bucket for binanceusdm children; non-USDM venue → permanent unavailable', async () => {
    await seedBase()
    const decidedMs = Date.parse(DECIDED_AT)
    const rows: SettledFundingRow[] = Array.from({ length: 3 * 400 }, (_, i) => ({
      fundingTime: decidedMs - (3 * 400 - i) * H8,
      fundingRate: String(0.0001 + (i % 9) * 0.00002),
    }))
    await processMarkTick(deps({ nowIso: '2026-07-03T12:00:00.000Z', fetchFundingHistory: async () => rows }))
    const funding = effectiveFundingContext(await derived()).get(child.id)
    expect(funding?.bucket).toBe('positive')
    expect(funding?.inputs?.symbol).toBe('BTCUSDT')

    // Different venue → permanent unavailable (fresh account slice).
    const dir2 = await mkdtemp(join(tmpdir(), 'decisions-marker2-'))
    try {
      await appendRow(decisionsLedgerPath('acct', dir2), parent)
      await appendRow(decisionsLedgerPath('acct', dir2), child)
      await processMarkTick(deps({ nowIso: '2026-07-03T12:00:00.000Z', ledgerDir: dir2, venueOf: () => 'okx', fetchFundingHistory: async () => rows }))
      const f2 = effectiveFundingContext(await readDerivedRows(decisionsDerivedPath('acct', dir2))).get(child.id)
      expect(f2?.bucket).toBe('unavailable')
      expect(f2?.reason).toContain('venue not supported')
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  })

  it('regime: UNKNOWN-live + recorded zone event for the decision day → derived backfill; past day with no event → permanent UNKNOWN; same-day absence retries', async () => {
    await seedBase()
    // Same day, no event yet → nothing appended (may still arrive).
    await processMarkTick(deps({ nowIso: '2026-07-03T12:00:00.000Z', fetchFundingHistory: async () => [] }))
    expect(effectiveRegimeContext(await derived()).has(child.id)).toBe(false)

    // Event exists → derived zone.
    await processMarkTick(deps({
      nowIso: '2026-07-04T08:00:00.000Z',
      fetchFundingHistory: async () => [],
      loadRegimeZones: async () => new Map([['2026-07-03', { zone: 'BEAR' as const }]]),
    }))
    const regime = effectiveRegimeContext(await derived()).get(child.id)
    expect(regime?.zone).toBe('BEAR')
    expect(regime?.sourceEventDateUtc).toBe('2026-07-03')
  })

  it('a recorded UNKNOWN event backfills as UNKNOWN-with-source — never as "no event"', async () => {
    await seedBase()
    await processMarkTick(deps({
      nowIso: '2026-07-04T08:00:00.000Z',
      fetchFundingHistory: async () => [],
      loadRegimeZones: async () => new Map([['2026-07-03', { zone: 'UNKNOWN' as const, reason: 'kline fetch failed' }]]),
    }))
    const regime = effectiveRegimeContext(await derived()).get(child.id)
    expect(regime?.zone).toBe('UNKNOWN')
    expect(regime?.sourceEventDateUtc).toBe('2026-07-03')
    expect(regime?.reason).toBe('kline fetch failed') // the event's reason, not "no recorded event"
  })
})

describe('marker — paging (fetchPageDays is a page size, NEVER a cap)', () => {
  it('pages past fetchPageDays until every due exit day is covered, then marks', async () => {
    await seedBase()
    const fetches: number[] = []
    const all = candlesThrough('2026-08-10')
    const pagedDeps = deps({
      nowIso: '2026-08-05T08:00:00.000Z', // 30D horizon exit = 2026-08-02, long past page 1
      config: { ...cfg, marker: { ...cfg.marker, fetchPageDays: 2 } },
      fetchDailyOhlcv: async (_a, _k, sinceMs, limitDays) => {
        fetches.push(sinceMs)
        const sinceDay = new Date(sinceMs).toISOString().slice(0, 10)
        return all.filter(c => c.dateUtc >= sinceDay).slice(0, limitDays)
      },
      fetchFundingHistory: async () => [],
    })
    await processMarkTick(pagedDeps)
    expect(fetches.length).toBeGreaterThan(10) // many 2-day pages, no give-up
    const marks = effectiveMarks(await derived())
    for (const h of ['1D', '3D', '7D', '30D'] as const) {
      expect(marks.get(markKey(child.id, h))?.status).toBe('marked')
    }
  })

  it('a crippled "marked" row on disk does not freeze the cell — the reader rejects it and the marker recomputes', async () => {
    await seedBase()
    const { appendFile } = await import('fs/promises')
    const { mkdir } = await import('fs/promises')
    const { dirname } = await import('path')
    const derivedPath = decisionsDerivedPath('acct', dir)
    await mkdir(dirname(derivedPath), { recursive: true })
    await appendFile(derivedPath, JSON.stringify({ kind: 'mark', v: 1, childId: child.id, horizon: '1D', at: 't', status: 'marked' }) + '\n')
    await processMarkTick(deps({ nowIso: '2026-07-06T08:00:00.000Z', fetchFundingHistory: async () => [] }))
    const mark = effectiveMarks(await derived()).get(markKey(child.id, '1D'))
    expect(mark?.status).toBe('marked')
    expect(mark?.ret).toBe('0') // a COMPLETE recomputed row, not the crippled one
  })
})
