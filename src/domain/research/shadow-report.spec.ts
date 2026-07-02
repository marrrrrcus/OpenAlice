import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { REGISTRATIONS, buildReport, collectShadowReports, parseLedgerText } from './shadow-report.js'

const NOW = new Date('2026-07-04T08:00:00Z') // newest completed UTC day = 2026-07-03

function anchor(dateUtc: string, equity = '1', stance = 'long'): Record<string, unknown> {
  return { kind: 'day', dateUtc, at: `${dateUtc}T00:05:00.000Z`, backfilled: false, close: '100', stance, equity }
}
function markDayRow(dateUtc: string, args: { netRet: string; legs: number; equity: string; backfilled?: boolean; grossRet?: string }): Record<string, unknown> {
  return {
    kind: 'day', dateUtc, at: `${dateUtc}T00:05:00.000Z`,
    backfilled: args.backfilled ?? false, close: '100', stance: 'long',
    mark: {
      stanceHeld: 'long', prevClose: '100',
      grossRet: args.grossRet ?? args.netRet, legs: args.legs,
      costPerLegBps: '10', netRet: args.netRet,
    },
    equity: args.equity,
  }
}
function unknownRow(dateUtc: string, equity = '1'): Record<string, unknown> {
  return { kind: 'unknown', dateUtc, at: `${dateUtc}T01:00:00.000Z`, reason: 'test outage', equity }
}
function ledger(...rows: Record<string, unknown>[]): ReturnType<typeof parseLedgerText> {
  return parseLedgerText(rows.map(r => JSON.stringify(r)).join('\n'))
}

describe('buildReport — computation on hand-checked fixtures', () => {
  it('empty rows → no track yet', () => {
    const r = buildReport('buy-and-hold-v0', [], NOW)
    expect(r.status).toBe('no track yet')
  })

  it('anchor-only → anchored status, n/a metrics, no fake precision', () => {
    const r = buildReport('buy-and-hold-v0', ledger(anchor('2026-07-01')), NOW)
    expect(r.status).toBe('anchored, no mark-bearing days yet')
    expect(r.equity).toBe('1')
    expect(r.cumulativeNetReturn).toBe('n/a')
    expect(r.maxDrawdown).toBe('n/a')
    expect(r.annualizedDailySharpe).toBe('n/a')
    expect(r.preMarkUnknownRows).toBe(0)
  })

  it('anchor followed by consecutive unknowns → pre-mark unknowns are NOT hidden', () => {
    const r = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'), unknownRow('2026-07-02'), unknownRow('2026-07-03'),
    ), NOW)
    expect(r.status).toBe('anchored, no mark-bearing days yet')
    expect(r.preMarkUnknownRows).toBe(2)
    expect(r.annualizedDailySharpe).toBe('n/a')
  })

  it('scoring track: equity / cumRet / maxDD / Sharpe / cost match hand computation', () => {
    const r = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-02', { netRet: '0.02', legs: 1, equity: '1.02' }),
      markDayRow('2026-07-03', { netRet: '-0.01', legs: 0, equity: '1.0098' }),
    ), NOW)
    expect(r.status).toBe('scoring')
    expect(r.eligibleDays).toBe(2)       // 07-02 … 07-03
    expect(r.knownForwardDays).toBe(2)
    expect(r.unknownDays).toBe(0)
    expect(r.backfilledDays).toBe(0)
    expect(r.inconclusive).toBe(false)
    expect(r.equity).toBe('1.0098')
    expect(Number(r.cumulativeNetReturn)).toBeCloseTo(0.0098, 10)
    // peak 1.02 → trough 1.0098: dd = 0.0102/1.02 = 0.01
    expect(Number(r.maxDrawdown)).toBeCloseTo(0.01, 10)
    // netRets [0.02, −0.01]: mean 0.005, sample std 0.0212132 → ×√365 = 4.50
    expect(r.annualizedDailySharpe).toBe('4.50')
    expect(r.totalCostBps).toBe('10')
    expect(r.currentStance).toBe('long')
    expect(r.note).toContain('never a signal')
  })

  it('a dead shadow rots visibly: eligible days extend to the newest completed day → unknown ratio trips INCONCLUSIVE', () => {
    const r = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-02', { netRet: '0.01', legs: 1, equity: '1.01' }),
      markDayRow('2026-07-03', { netRet: '0.02', legs: 0, equity: '1.0302' }),
    ), new Date('2026-07-20T08:00:00Z')) // newest completed = 07-19 → eligible 18
    expect(r.eligibleDays).toBe(18)
    expect(r.knownForwardDays).toBe(2)
    expect(r.unknownDays).toBe(16)
    expect(r.inconclusive).toBe(true)
    expect(r.inconclusiveReason).toContain('unknown/eligible')
  })

  it('backfilled ratio above 20% trips INCONCLUSIVE independently', () => {
    const r = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-02', { netRet: '0.01', legs: 1, equity: '1.01' }),
      markDayRow('2026-07-03', { netRet: '0', legs: 0, equity: '1.01', backfilled: true }),
    ), NOW)
    expect(r.backfilledDays).toBe(1)
    expect(r.eligibleDays).toBe(2) // 1/2 = 50% > 20%
    expect(r.inconclusive).toBe(true)
    expect(r.inconclusiveReason).toContain('backfilled/eligible')
  })

  it('Sharpe is n/a below 2 marked days and at zero variance — never Infinity', () => {
    const single = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-02', { netRet: '0.02', legs: 1, equity: '1.02' }),
    ), new Date('2026-07-03T08:00:00Z'))
    expect(single.annualizedDailySharpe).toBe('n/a')

    const zeroVar = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-02', { netRet: '0.01', legs: 1, equity: '1.01' }),
      markDayRow('2026-07-03', { netRet: '0.01', legs: 0, equity: '1.0201' }),
    ), NOW)
    expect(zeroVar.annualizedDailySharpe).toBe('n/a')
    expect(zeroVar.status).toBe('scoring') // metrics degrade, the track doesn't
  })

  it('pre-registered bar: distance shown while short, "human verdict pending" once reached — never "validated"', () => {
    const rows = [anchor('2026-01-01')]
    let equity = 1
    for (let i = 1; i <= 95; i++) {
      const d = new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10)
      equity *= 1.001
      rows.push(markDayRow(d, { netRet: i % 2 === 0 ? '0.001' : '0.0011', legs: 0, equity: equity.toFixed(8) }))
    }
    const reached = buildReport('regime-trend-v0-shadow', ledger(...rows), new Date('2026-04-07T08:00:00Z'))
    expect(reached.knownForwardDays).toBeGreaterThanOrEqual(90)
    expect(reached.note).toContain('human verdict pending')
    // "validated" may appear ONLY in the negated phrase (same discipline as
    // the "signal" ban on event names).
    expect(reached.note).toContain('nothing is auto-validated')
    expect(reached.note.replace('nothing is auto-validated', '')).not.toContain('validated')

    const short = buildReport('regime-trend-v0-shadow', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-02', { netRet: '0.01', legs: 1, equity: '1.01' }),
      markDayRow('2026-07-03', { netRet: '0.02', legs: 0, equity: '1.0302' }),
    ), NOW)
    expect(short.note).toContain('of ≥90')
  })

  it('rows dated beyond the newest completed day cannot pollute any statistic (eligible-range discipline)', () => {
    const clean = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-02', { netRet: '0.02', legs: 1, equity: '1.02' }),
      markDayRow('2026-07-03', { netRet: '-0.01', legs: 0, equity: '1.0098' }),
    ), NOW)
    const polluted = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-02', { netRet: '0.02', legs: 1, equity: '1.02' }),
      markDayRow('2026-07-03', { netRet: '-0.01', legs: 0, equity: '1.0098' }),
      // Pathological future row (a healthy writer can never produce this):
      markDayRow('2026-07-09', { netRet: '0.50', legs: 2, equity: '9.99' }),
    ), NOW)
    // Every performance figure must match the clean track exactly —
    // equity is the ELIGIBLE-END equity, never the latest row's.
    expect(polluted.equity).toBe(clean.equity)
    expect(polluted.cumulativeNetReturn).toBe(clean.cumulativeNetReturn)
    expect(polluted.maxDrawdown).toBe(clean.maxDrawdown)
    expect(polluted.annualizedDailySharpe).toBe(clean.annualizedDailySharpe)
    expect(polluted.totalCostBps).toBe(clean.totalCostBps)
    expect(polluted.knownForwardDays).toBe(clean.knownForwardDays)
    expect(polluted.currentStance).toBe(clean.currentStance)
  })

  it('ALL mark rows dated in the future → no performance claim at all', () => {
    const r = buildReport('buy-and-hold-v0', ledger(
      anchor('2026-07-01'),
      markDayRow('2026-07-09', { netRet: '0.50', legs: 2, equity: '9.99' }),
    ), NOW)
    expect(r.status).toBe('anchored, no mark-bearing days yet')
    expect(r.annualizedDailySharpe).toBe('n/a')
    expect(r.note).toContain('future-dated')
  })

  it('registration mirror covers every registered shadow strategy (anti-drift with the UTA registry)', () => {
    // src/ cannot import the UTA registry — this mirror is manual, and this
    // spec plus the registry-header rule are the sync enforcement.
    expect(REGISTRATIONS['buy-and-hold-v0']?.registrationDoc).toBe('docs/shadow-strategies/buy-and-hold-v0.md')
    expect(REGISTRATIONS['buy-and-hold-v0']?.barKnownForwardDays).toBeUndefined() // open-ended baseline
    expect(REGISTRATIONS['regime-trend-v0-shadow']?.registrationDoc).toBe('docs/shadow-strategies/regime-trend-v0-shadow.md')
    expect(REGISTRATIONS['regime-trend-v0-shadow']?.barKnownForwardDays).toBe(90)
  })

  it('malformed and structurally invalid lines are skipped by the parser', () => {
    const text = [
      JSON.stringify(anchor('2026-07-01')),
      'garbage not json',
      JSON.stringify({ kind: 'day', dateUtc: '2026-07-02' }), // missing fields
      JSON.stringify({ kind: 'unknown', dateUtc: '2026-07-02', at: 'x', equity: '1' }), // no reason
    ].join('\n')
    expect(parseLedgerText(text)).toHaveLength(1)
  })
})

describe('collectShadowReports — I/O honesty', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shadow-report-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('missing directory → honest "no track yet", not an error', async () => {
    const reports = await collectShadowReports({ dir: join(dir, 'nope'), now: () => NOW })
    expect(reports).toHaveLength(1)
    expect(reports[0].status).toBe('no track yet')
  })

  it('filter for a strategy with no ledger → per-strategy no track yet', async () => {
    const reports = await collectShadowReports({ dir, now: () => NOW }, 'buy-and-hold-v0')
    expect(reports).toHaveLength(1)
    expect(reports[0].strategy).toBe('buy-and-hold-v0')
    expect(reports[0].status).toBe('no track yet')
  })

  it('reads real ledger files and reports per strategy', async () => {
    await writeFile(join(dir, 'buy-and-hold-v0.jsonl'), JSON.stringify(anchor('2026-07-01')) + '\n')
    const reports = await collectShadowReports({ dir, now: () => NOW })
    expect(reports).toHaveLength(1)
    expect(reports[0].strategy).toBe('buy-and-hold-v0')
    expect(reports[0].status).toBe('anchored, no mark-bearing days yet')
    expect(reports[0].registrationDoc).toBe('docs/shadow-strategies/buy-and-hold-v0.md')
  })

  it('an unreadable ledger is reported as unreadable — never disguised as a fresh track', async () => {
    await mkdir(join(dir, 'broken.jsonl')) // a directory with a ledger name → EISDIR on read
    await writeFile(join(dir, 'fine.jsonl'), JSON.stringify(anchor('2026-07-01')) + '\n')
    const reports = await collectShadowReports({ dir, now: () => NOW })
    const broken = reports.find(r => r.strategy === 'broken')
    const fine = reports.find(r => r.strategy === 'fine')
    expect(broken?.status).toBe('ledger unreadable')
    expect(broken?.error).toBeTruthy()
    expect(fine?.status).toBe('anchored, no mark-bearing days yet')
  })
})
