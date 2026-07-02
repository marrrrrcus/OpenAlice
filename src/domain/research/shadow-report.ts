/**
 * Strategy-shadow report — Alice-side READER of the research ledgers
 * written by the UTA research shadow (docs/strategy-shadow-track-v0.md).
 *
 * Read-boundary contract: src/ deliberately does not import services/uta
 * types — rows are re-validated here with a local Zod schema mirroring the
 * locked ledger contract. The ledger is the authority; this module only
 * reads and summarizes. Language discipline: everything rendered here is
 * research evidence accumulating — never a signal, never an endorsement,
 * and a track past its bar is "human verdict pending", not "validated".
 *
 * Honesty rules (pinned in review):
 *  - a non-ENOENT read failure reports "ledger unreadable", never an empty
 *    track (mirror of the B1 ledger ruling);
 *  - anchored-but-unmarked tracks say so, expose `preMarkUnknownRows`, and
 *    return n/a metrics — no fake precision;
 *  - Sharpe is n/a below 2 marked days or at zero variance (never
 *    Infinity/NaN);
 *  - eligible days extend to the newest COMPLETED UTC day, so a dead
 *    shadow visibly rots instead of freezing its denominator.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { dataPath } from '@/core/paths.js'

// ==================== Read-boundary row schema ====================

const stanceSchema = z.enum(['long', 'short', 'flat'])
const dayRowSchema = z.object({
  kind: z.literal('day'),
  dateUtc: z.string(),
  at: z.string(),
  backfilled: z.boolean(),
  close: z.string(),
  stance: stanceSchema,
  meta: z.record(z.string(), z.unknown()).optional(),
  mark: z.object({
    stanceHeld: stanceSchema,
    prevClose: z.string(),
    grossRet: z.string(),
    legs: z.number(),
    costPerLegBps: z.string(),
    netRet: z.string(),
  }).optional(),
  equity: z.string(),
})
const unknownRowSchema = z.object({
  kind: z.literal('unknown'),
  dateUtc: z.string(),
  at: z.string(),
  reason: z.string(),
  equity: z.string(),
})
const rowSchema = z.discriminatedUnion('kind', [dayRowSchema, unknownRowSchema])
type LedgerRow = z.infer<typeof rowSchema>

// ==================== Static registration map ====================
// The registration doc + pre-registered bar live in docs and in the UTA
// registry, which src/ cannot import — this small mirror is the report's
// source for "how far from the evidence bar". Two entries; updated when a
// strategy is registered (code review catches drift, same gate as the
// registry itself).

interface RegistrationInfo {
  registrationDoc: string
  /** Pre-registered minimum known-forward days; undefined = open-ended baseline. */
  barKnownForwardDays?: number
}

export const REGISTRATIONS: Record<string, RegistrationInfo> = {
  'buy-and-hold-v0': {
    registrationDoc: 'docs/shadow-strategies/buy-and-hold-v0.md',
  },
  'regime-trend-v0-shadow': {
    registrationDoc: 'docs/shadow-strategies/regime-trend-v0-shadow.md',
    barKnownForwardDays: 90,
  },
}

const UNKNOWN_RATIO_BOUND = 0.10
const BACKFILLED_RATIO_BOUND = 0.20

// ==================== Pure computation (testable) ====================

const DAY_MS = 86_400_000
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const diffDays = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)

export interface StrategyShadowReport {
  strategy: string
  status: 'scoring' | 'anchored, no mark-bearing days yet' | 'no track yet' | 'ledger unreadable'
  error?: string
  registrationDoc?: string
  activationDay?: string
  currentStance?: string
  equity?: string
  preMarkUnknownRows?: number
  eligibleDays?: number
  knownForwardDays?: number
  unknownDays?: number
  backfilledDays?: number
  unknownRatio?: string
  backfilledRatio?: string
  inconclusive?: boolean
  inconclusiveReason?: string
  cumulativeNetReturn?: string
  maxDrawdown?: string
  annualizedDailySharpe?: string
  totalCostBps?: string
  note: string
}

export function parseLedgerText(text: string): LedgerRow[] {
  const rows: LedgerRow[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = rowSchema.safeParse(JSON.parse(trimmed))
      if (parsed.success) rows.push(parsed.data)
    } catch { /* malformed line — skipped, same tolerance as the writer */ }
  }
  return rows
}

export function buildReport(strategy: string, rows: readonly LedgerRow[], now: Date): StrategyShadowReport {
  const reg = REGISTRATIONS[strategy]
  const base = {
    strategy,
    ...(reg !== undefined ? { registrationDoc: reg.registrationDoc } : {}),
  }

  if (rows.length === 0) {
    return { ...base, status: 'no track yet', note: 'no ledger rows recorded yet — the track starts at its first deployed tick' }
  }

  // Last row per dateUtc wins (the ledger's pinned reader rule).
  const eff = new Map<string, LedgerRow>()
  for (const row of rows) eff.set(row.dateUtc, row)
  const dates = [...eff.keys()].sort()
  const activationDay = dates[0]
  const dayRows = dates
    .map(d => eff.get(d) as LedgerRow)
    .filter((r): r is Extract<LedgerRow, { kind: 'day' }> => r.kind === 'day')
  const newestRow = rows[rows.length - 1]
  const currentStance = dayRows.length > 0 ? dayRows[dayRows.length - 1].stance : undefined

  const firstMark = dayRows.find(r => r.mark !== undefined)
  if (firstMark === undefined) {
    // Anchored (or failing since activation) — no performance may be claimed,
    // and early data trouble must be visible, not hidden behind "anchored".
    const preMarkUnknownRows = dates.filter(d => eff.get(d)?.kind === 'unknown').length
    return {
      ...base,
      status: 'anchored, no mark-bearing days yet',
      activationDay,
      ...(currentStance !== undefined ? { currentStance } : {}),
      equity: newestRow.equity,
      preMarkUnknownRows,
      cumulativeNetReturn: 'n/a',
      maxDrawdown: 'n/a',
      annualizedDailySharpe: 'n/a',
      note: 'evidence not yet accumulating — anchor recorded, first mark lands after the next daily close; research evidence only, never a signal',
    }
  }

  // Eligible span: first mark-bearing day → newest COMPLETED UTC day.
  // EVERY performance statistic below is computed on this range only — a
  // pathological row dated beyond the newest completed day (which a healthy
  // writer can never produce) must not leak into equity/Sharpe/maxDD; the
  // report stays consistent with its own denominator definition.
  const newestCompletedDay = dayOf(now.getTime() - DAY_MS)
  const eligibleDays = Math.max(0, diffDays(firstMark.dateUtc, newestCompletedDay)) + 1
  const inRange = (d: string): boolean => d >= firstMark.dateUtc && d <= newestCompletedDay
  const rangeDayRows = dayRows.filter(r => inRange(r.dateUtc))
  if (rangeDayRows.length === 0) {
    // Pathological: every mark-bearing row is dated beyond the newest
    // completed day. No performance may be claimed from rows the calendar
    // hasn't reached.
    return {
      ...base,
      status: 'anchored, no mark-bearing days yet',
      activationDay,
      preMarkUnknownRows: dates.filter(d => eff.get(d)?.kind === 'unknown').length,
      cumulativeNetReturn: 'n/a',
      maxDrawdown: 'n/a',
      annualizedDailySharpe: 'n/a',
      note: 'ledger rows are dated beyond the newest completed UTC day — no performance claim can be made from future-dated rows',
    }
  }
  const knownForwardDays = rangeDayRows.length
  const unknownDays = eligibleDays - knownForwardDays
  const backfilledDays = rangeDayRows.filter(r => r.backfilled).length
  const preMarkUnknownRows = dates.filter(d => d < firstMark.dateUtc && eff.get(d)?.kind === 'unknown').length

  const unknownRatio = eligibleDays > 0 ? unknownDays / eligibleDays : 0
  const backfilledRatio = eligibleDays > 0 ? backfilledDays / eligibleDays : 0
  const inconclusiveReasons: string[] = []
  if (unknownRatio > UNKNOWN_RATIO_BOUND) {
    inconclusiveReasons.push(`unknown/eligible ${(unknownRatio * 100).toFixed(1)}% > ${UNKNOWN_RATIO_BOUND * 100}%`)
  }
  if (backfilledRatio > BACKFILLED_RATIO_BOUND) {
    inconclusiveReasons.push(`backfilled/eligible ${(backfilledRatio * 100).toFixed(1)}% > ${BACKFILLED_RATIO_BOUND * 100}%`)
  }

  // Metrics over the ELIGIBLE-RANGE known-day sequence only (unknown days
  // froze equity and carry no performance claim; out-of-range rows carry no
  // claim at all). Reported equity is the eligible-END equity by the same
  // rule.
  const marked = rangeDayRows.filter(r => r.mark !== undefined)
  const netRets = marked.map(r => Number(r.mark!.netRet))
  const equity = rangeDayRows[rangeDayRows.length - 1].equity
  const cumulativeNetReturn = (Number(equity) - 1).toFixed(6)

  let peak = -Infinity
  let maxDd = 0
  for (const r of rangeDayRows) {
    const e = Number(r.equity)
    if (e > peak) peak = e
    else maxDd = Math.max(maxDd, (peak - e) / peak)
  }

  let sharpe = 'n/a'
  if (netRets.length >= 2) {
    const mean = netRets.reduce((a, b) => a + b, 0) / netRets.length
    const variance = netRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (netRets.length - 1)
    const std = Math.sqrt(variance)
    if (std > 0) sharpe = ((mean / std) * Math.sqrt(365)).toFixed(2)
  }

  const totalCostBps = marked
    .reduce((a, r) => a + r.mark!.legs * Number(r.mark!.costPerLegBps), 0)
    .toFixed(0)

  const bar = reg?.barKnownForwardDays
  const barNote = bar === undefined
    ? 'open-ended baseline (no promotion bar by design)'
    : knownForwardDays >= bar
      ? `bar reached (${knownForwardDays}/${bar} known-forward days) — human verdict pending, nothing is auto-validated`
      : `${knownForwardDays} of ≥${bar} pre-registered known-forward days`

  return {
    ...base,
    status: 'scoring',
    activationDay,
    currentStance: rangeDayRows[rangeDayRows.length - 1].stance,
    equity,
    preMarkUnknownRows,
    eligibleDays,
    knownForwardDays,
    unknownDays,
    backfilledDays,
    unknownRatio: `${(unknownRatio * 100).toFixed(1)}% (bound ${UNKNOWN_RATIO_BOUND * 100}%)`,
    backfilledRatio: `${(backfilledRatio * 100).toFixed(1)}% (bound ${BACKFILLED_RATIO_BOUND * 100}%)`,
    inconclusive: inconclusiveReasons.length > 0,
    ...(inconclusiveReasons.length > 0 ? { inconclusiveReason: inconclusiveReasons.join('; ') } : {}),
    cumulativeNetReturn,
    maxDrawdown: maxDd.toFixed(6),
    annualizedDailySharpe: sharpe,
    totalCostBps,
    note: `evidence accumulating — ${barNote}; research evidence only, never a signal`,
  }
}

// ==================== Tool factory ====================

export interface ResearchShadowToolDeps {
  /** Ledger directory — defaults to data/research/shadow. */
  dir?: string
  now?: () => Date
}

export async function collectShadowReports(deps: ResearchShadowToolDeps = {}, strategyFilter?: string): Promise<StrategyShadowReport[]> {
  const dir = deps.dir ?? dataPath('research', 'shadow')
  const now = deps.now ?? (() => new Date())

  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
  } catch {
    files = [] // no directory yet = no tracks yet (honest empty, not an error)
  }
  const ids = files.map(f => f.slice(0, -'.jsonl'.length))
  const wanted = strategyFilter !== undefined ? ids.filter(id => id === strategyFilter) : ids
  if (strategyFilter !== undefined && wanted.length === 0) {
    return [{ strategy: strategyFilter, status: 'no track yet', note: 'no ledger file for this strategy — the track starts at its first deployed tick' }]
  }
  if (wanted.length === 0) {
    return [{ strategy: '(none)', status: 'no track yet', note: 'no shadow ledgers found — tracks are written by the UTA research shadow on the runtime host' }]
  }

  const reports: StrategyShadowReport[] = []
  for (const id of wanted) {
    try {
      const text = await readFile(join(dir, `${id}.jsonl`), 'utf-8')
      reports.push(buildReport(id, parseLedgerText(text), now()))
    } catch (err) {
      // Unreadable ≠ empty — never disguise a read failure as a fresh track.
      reports.push({
        strategy: id,
        status: 'ledger unreadable',
        error: err instanceof Error ? err.message : String(err),
        note: 'ledger could not be read — no performance claim can be made from an unreadable ledger',
      })
    }
  }
  return reports
}

export function createResearchShadowTools(deps: ResearchShadowToolDeps = {}) {
  return {
    research_shadow_report: tool({
      description: `Report the strategy shadow track standings (docs/strategy-shadow-track-v0.md).

Research evidence only — never a signal, never a proposal, never an
endorsement. Shows, per registered strategy: known / unknown / backfilled
day counts against the pinned INCONCLUSIVE bounds, current paper stance,
equity multiple, cumulative net return, max drawdown, annualized daily
Sharpe (known days only), total costs paid, and the distance to the
strategy's pre-registered evidence bar. A track past its bar reads
"human verdict pending" — nothing is ever auto-validated.`,
      inputSchema: z.object({
        strategy: z.string().optional().describe('Limit to one strategy id (e.g. "buy-and-hold-v0"); omit for all tracks'),
      }),
      execute: async ({ strategy }) => collectShadowReports(deps, strategy),
    }),
  }
}
