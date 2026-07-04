/**
 * D3 — human decision report: RECONCILIATION FIRST, analysis second
 * (docs/human-decision-ledger-v0.md, D3 section).
 *
 * Capture is emit-once, so a lost sample is permanent and otherwise
 * invisible — this report audits its own evidence before it says anything
 * about behavior. Headline rule (pinned): any reconciliation failure, or
 * an unset captureSince baseline, renders
 * `evidence incomplete — no behavioral conclusions allowed` as the first
 * line; analysis still renders under that banner.
 *
 * Read-boundary discipline (shadow-report precedent): src/ imports no
 * services/uta types — every file is re-validated with local Zod schemas.
 * Git state resolves through the SAME candidate paths the runtime loads
 * from (src/core/trading-git-paths.ts) so legacy accounts cannot report
 * phantom losses. Unreadable inputs are failures, never emptiness.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { dataPath } from '@/core/paths.js'
import { gitStateCandidatePaths } from '@/core/trading-git-paths.js'
import { readUTAsConfig } from '@/core/config.js'

// ==================== Local read-boundary schemas ====================

const stance = z.enum(['LONG', 'SHORT'])
const zone = z.enum(['BULL', 'BEAR', 'GRAY', 'UNKNOWN'])
const bucket = z.enum(['extreme-positive', 'positive', 'non-positive', 'unavailable'])
const horizon = z.enum(['1D', '3D', '7D', '30D'])
const HORIZON_DAYS: Record<string, number> = { '1D': 1, '3D': 3, '7D': 7, '30D': 30 }

const decisionParentSchema = z.object({
  kind: z.literal('push'),
  id: z.string(),
  accountId: z.string(),
  presetId: z.string(),
  capturedAt: z.string(),
  decidedAt: z.string(),
  pendingHash: z.string(),
  commitHash: z.string().optional(),
  override: z.boolean(),
  overrideReason: z.string().nullable(),
  childCount: z.number(),
})
const childContextSchema = z.object({
  regime: z.object({ zone, contextSource: z.enum(['live', 'derived']) }).loose(),
  funding: z.object({ bucket, contextSource: z.enum(['live', 'derived']) }).loose(),
})
const decisionChildSchema = z.object({
  kind: z.literal('intent'),
  id: z.string(),
  parentId: z.string(),
  capturedAt: z.string(),
  role: z.enum(['entry', 'exit', 'neutral', 'unclassified']),
  side: stance.optional(),
  markSide: stance.optional(),
  context: childContextSchema,
})
const brakeParentSchema = decisionParentSchema
  .omit({ kind: true, commitHash: true, override: true, overrideReason: true })
  .extend({
    kind: z.literal('verdict'),
    disposition: z.enum(['blocked', 'overridden', 'rejected']),
  })
const brakeChildSchema = decisionChildSchema.omit({ kind: true }).extend({ kind: z.literal('blocked-intent') })
const derivedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mark'), childId: z.string(), horizon, status: z.enum(['marked', 'unmarkable']) }).loose(),
  z.object({ kind: z.literal('fundingContext'), childId: z.string(), bucket }).loose(),
  z.object({ kind: z.literal('regimeContext'), childId: z.string(), zone }).loose(),
])
const gitStateSchema = z.object({
  commits: z.array(z.object({
    hash: z.string(),
    message: z.string(),
    timestamp: z.string(),
    results: z.array(z.object({ status: z.string().optional(), success: z.boolean().optional() }).loose()).optional(),
    operations: z.array(z.object({ action: z.string().optional() }).loose()).optional(),
  }).loose()),
  head: z.union([z.string(), z.null()]),
}).loose()

type PersistedCommit = z.infer<typeof gitStateSchema>['commits'][number]

/**
 * Check 1's universe is EXECUTED PUSH commits only. TradingGit's history
 * also records two kinds the completeness contract must not demand
 * decision parents for:
 *   - clean rejects (TradingGit.reject(): every result has status
 *     'user-rejected') — the human declined; nothing executed;
 *   - synthetic reconciles (recordReconcile(): every operation is
 *     'reconcileBalance') — system bookkeeping, not a human push.
 * A BROKER-rejected push (success:false, status ≠ 'user-rejected') stays
 * in the universe — the human pushed; the outcome is still a decision.
 */
function isExecutedPushCommit(c: PersistedCommit): boolean {
  const results = c.results ?? []
  if (results.length > 0 && results.every(r => r.status === 'user-rejected')) return false
  const operations = c.operations ?? []
  if (operations.length > 0 && operations.every(o => o.action === 'reconcileBalance')) return false
  return true
}
const configSchema = z.object({
  captureMockAccounts: z.boolean().optional(),
  captureSince: z.string().optional(),
  marker: z.object({ graceHours: z.number().optional() }).loose().optional(),
}).loose()

type DecisionParent = z.infer<typeof decisionParentSchema>
type DecisionChild = z.infer<typeof decisionChildSchema>
type BrakeParent = z.infer<typeof brakeParentSchema>
type BrakeChild = z.infer<typeof brakeChildSchema>
type Derived = z.infer<typeof derivedSchema>

// ==================== Deps ====================

export interface DecisionReportDeps {
  /** Injected event reader — main.ts wires eventLog.read({type}). */
  readEvents?: (type: string) => Promise<Array<{ ts: number; payload: unknown }>>
  decisionsDir?: string
  configPath?: string
  loadAccounts?: () => Promise<Array<{ id: string; presetId: string }>>
  gitPathsFor?: (accountId: string) => string[]
  now?: () => Date
}

// ==================== Helpers ====================

const DAY_MS = 86_400_000
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

async function readJsonlValidated<T>(filePath: string, parse: (r: unknown) => T | undefined): Promise<T[] | { unreadable: string }> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    return { unreadable: err instanceof Error ? err.message : String(err) }
  }
  const rows: T[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = parse(JSON.parse(trimmed))
      if (parsed !== undefined) rows.push(parsed)
    } catch { /* malformed line — skipped */ }
  }
  return rows
}

const parseWith = <S extends z.ZodType>(schema: S) => (r: unknown): z.infer<S> | undefined => {
  const res = schema.safeParse(r)
  return res.success ? res.data : undefined
}

const WOULD_BLOCK = /WOULD_BLOCK$/

// ==================== Report ====================

export interface DecisionReport {
  headline: string
  baseline: { state: 'set' | 'unset'; captureSince?: string }
  reconciliation: {
    ok: boolean
    noData: boolean
    unreadable: Array<{ what: string; error: string }>
    missingDecisionParents: Array<{ accountId: string; commitHash: string; timestamp: string; message: string }>
    missingBrakeParents: Array<{ accountId: string; pendingHash: string; expected: 'blocked' | 'overridden'; eventTs: number }>
    childCountMismatches: Array<{ ledger: string; parentId: string; declared: number; actual: number }>
    overdueMarks: Array<{ ledger: string; childId: string; horizon: string }>
    markCoverage: { marked: number; unmarkable: number; notYetDue: number; overdue: number }
    contextCoverage: {
      funding: { pending: number; derived: number }
      regime: { pending: number; derived: number }
    }
    rejectedParentsInfo: number
  }
  process: {
    decisionParents: number
    decisionChildren: number
    brakeParents: { blocked: number; overridden: number; rejected: number }
    overrides: number
    overrideReasonMissing: number
  }
  cells: {
    note: string
    sideRegime: Record<string, { n: number; status: string }>
    sideFunding: Record<string, { n: number; status: string }>
  }
}

export async function collectDecisionReport(deps: DecisionReportDeps = {}, accountFilter?: string): Promise<DecisionReport> {
  const dir = deps.decisionsDir ?? dataPath('research', 'decisions')
  const configPath = deps.configPath ?? dataPath('config', 'research-decisions.json')
  const nowDate = deps.now?.() ?? new Date()
  const nowMs = nowDate.getTime()
  const gitPathsFor = deps.gitPathsFor ?? gitStateCandidatePaths
  const unreadable: Array<{ what: string; error: string }> = []

  // ---- Config: baseline + mock policy + grace ----
  let captureSince: string | undefined
  let captureMock = false
  let graceHours = 6
  try {
    const raw = configSchema.safeParse(JSON.parse(await readFile(configPath, 'utf-8')))
    if (raw.success) {
      captureSince = raw.data.captureSince
      captureMock = raw.data.captureMockAccounts ?? false
      graceHours = raw.data.marker?.graceHours ?? 6
    } else {
      unreadable.push({ what: `config ${configPath}`, error: 'schema mismatch' })
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      unreadable.push({ what: `config ${configPath}`, error: err instanceof Error ? err.message : String(err) })
    }
    // ENOENT: defaults (captureSince stays unset → evidence incomplete)
  }
  const sinceMs = captureSince !== undefined ? Date.parse(captureSince) : undefined

  // ---- Account universe: configured accounts ∪ ledger-file accounts ----
  let accounts: Array<{ id: string; presetId: string }> = []
  try {
    accounts = deps.loadAccounts !== undefined
      ? await deps.loadAccounts()
      : (await readUTAsConfig()).map(a => ({ id: a.id, presetId: a.presetId }))
  } catch (err) {
    unreadable.push({ what: 'accounts config', error: err instanceof Error ? err.message : String(err) })
  }
  const presetOf = new Map(accounts.map(a => [a.id, a.presetId]))
  let ledgerIds: string[] = []
  try {
    ledgerIds = [...new Set((await readdir(dir))
      .filter(f => /\.(decisions|brakes)(\.derived)?\.jsonl$/.test(f))
      .map(f => f.replace(/\.(decisions|brakes)(\.derived)?\.jsonl$/, '')))]
  } catch { /* no ledger dir yet — fine */ }
  let universe = [...new Set([...accounts.map(a => a.id), ...ledgerIds])]
  if (accountFilter !== undefined) universe = universe.filter(id => id === accountFilter)
  const isMockSkipped = (id: string): boolean => !captureMock && presetOf.get(id) === 'mock-simulator'

  // ---- Load ledgers per account ----
  const decisionParents: DecisionParent[] = []
  const decisionChildren: DecisionChild[] = []
  const brakeParents: BrakeParent[] = []
  const brakeChildren: BrakeChild[] = []
  const derivedByLedger = new Map<string, Derived[]>() // `${id}:decisions|brakes`
  for (const id of universe) {
    const dec = await readJsonlValidated(join(dir, `${id}.decisions.jsonl`), (r) => {
      const p = parseWith(decisionParentSchema)(r)
      if (p) return { p }
      const c = parseWith(decisionChildSchema)(r)
      return c ? { c } : undefined
    })
    if ('unreadable' in dec) unreadable.push({ what: `${id}.decisions.jsonl`, error: dec.unreadable })
    else for (const row of dec) { if ('p' in row && row.p) decisionParents.push(row.p); else if ('c' in row && row.c) decisionChildren.push(row.c) }

    const brk = await readJsonlValidated(join(dir, `${id}.brakes.jsonl`), (r) => {
      const p = parseWith(brakeParentSchema)(r)
      if (p) return { p }
      const c = parseWith(brakeChildSchema)(r)
      return c ? { c } : undefined
    })
    if ('unreadable' in brk) unreadable.push({ what: `${id}.brakes.jsonl`, error: brk.unreadable })
    else for (const row of brk) { if ('p' in row && row.p) brakeParents.push(row.p); else if ('c' in row && row.c) brakeChildren.push(row.c) }

    for (const kind of ['decisions', 'brakes'] as const) {
      const drv = await readJsonlValidated(join(dir, `${id}.${kind}.derived.jsonl`), parseWith(derivedSchema))
      if ('unreadable' in drv) unreadable.push({ what: `${id}.${kind}.derived.jsonl`, error: drv.unreadable })
      else derivedByLedger.set(`${id}:${kind}`, drv)
    }
  }
  const inWindow = (iso: string): boolean => sinceMs === undefined || Date.parse(iso) >= sinceMs

  // ---- Check 1: executed push commits ↔ decision parents ----
  // Account-scoped keys: an audit layer must be deterministic — matching
  // on the bare 8-hex hash would let one account's parent mask another
  // account's loss on a hash collision.
  const knownCommitKeys = new Set(
    decisionParents
      .filter(p => p.commitHash !== undefined)
      .map(p => `${p.accountId}:${p.commitHash}`),
  )
  const missingDecisionParents: DecisionReport['reconciliation']['missingDecisionParents'] = []
  let commitsInWindow = 0
  for (const id of universe) {
    if (isMockSkipped(id)) continue
    let state: z.infer<typeof gitStateSchema> | undefined
    for (const candidate of gitPathsFor(id)) {
      try {
        const parsed = gitStateSchema.safeParse(JSON.parse(await readFile(candidate, 'utf-8')))
        if (parsed.success) { state = parsed.data; break }
        unreadable.push({ what: `git state ${candidate}`, error: 'schema mismatch' })
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // next candidate
        unreadable.push({ what: `git state ${candidate}`, error: err instanceof Error ? err.message : String(err) })
        break
      }
    }
    if (!state) continue // no persisted history anywhere — nothing to reconcile
    for (const commit of state.commits) {
      if (sinceMs !== undefined && Date.parse(commit.timestamp) < sinceMs) continue
      if (!isExecutedPushCommit(commit)) continue // clean rejects / synthetic reconciles owe no parent
      commitsInWindow++
      if (!knownCommitKeys.has(`${id}:${commit.hash}`)) {
        missingDecisionParents.push({ accountId: id, commitHash: commit.hash, timestamp: commit.timestamp, message: commit.message })
      }
    }
  }

  // ---- Check 2: brake-content push verdicts ↔ brake parents ----
  const brakeIds = new Set(brakeParents.map(p => p.id))
  const missingBrakeParents: DecisionReport['reconciliation']['missingBrakeParents'] = []
  let eventsInWindow = 0
  if (deps.readEvents) {
    try {
      const events = await deps.readEvents('trading.risk_gate.verdict')
      for (const e of events) {
        // Envelope ts is the pinned filter basis (the payload carries no
        // standalone time field).
        if (sinceMs !== undefined && e.ts < sinceMs) continue
        const p = e.payload as { accountId?: string; pendingHash?: string | null; trigger?: string; result?: string; enforced?: boolean; verdicts?: Array<{ code?: string }> }
        if (p?.trigger !== 'push' || typeof p.accountId !== 'string' || typeof p.pendingHash !== 'string') continue
        if (accountFilter !== undefined && p.accountId !== accountFilter) continue
        if (isMockSkipped(p.accountId)) continue
        const brakeContent = p.result === 'BLOCK' || (p.verdicts ?? []).some(v => v.code !== undefined && WOULD_BLOCK.test(v.code))
        if (!brakeContent) continue
        eventsInWindow++
        const expected = p.enforced === true ? 'blocked' as const : 'overridden' as const
        if (!brakeIds.has(`brk:${p.accountId}:${p.pendingHash}:${expected}`)) {
          missingBrakeParents.push({ accountId: p.accountId, pendingHash: p.pendingHash, expected, eventTs: e.ts })
        }
      }
    } catch (err) {
      unreadable.push({ what: 'event log (trading.risk_gate.verdict)', error: err instanceof Error ? err.message : String(err) })
    }
  }

  // ---- Check 3: childCount ↔ actual children ----
  const childCountMismatches: DecisionReport['reconciliation']['childCountMismatches'] = []
  const countBy = <T extends { parentId: string }>(rows: T[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.parentId, (m.get(r.parentId) ?? 0) + 1)
    return m
  }
  const decCounts = countBy(decisionChildren)
  for (const p of decisionParents) {
    const actual = decCounts.get(p.id) ?? 0
    if (actual !== p.childCount) childCountMismatches.push({ ledger: 'decisions', parentId: p.id, declared: p.childCount, actual })
  }
  const brkCounts = countBy(brakeChildren)
  for (const p of brakeParents) {
    const actual = brkCounts.get(p.id) ?? 0
    if (actual !== p.childCount) childCountMismatches.push({ ledger: 'brakes', parentId: p.id, declared: p.childCount, actual })
  }

  // ---- Check 4: mark coverage (OVERDUE = reconciliation failure) ----
  const decidedAtOf = new Map<string, string>()
  for (const p of decisionParents) decidedAtOf.set(p.id, p.decidedAt)
  for (const p of brakeParents) decidedAtOf.set(p.id, p.decidedAt)
  const markStatus = new Map<string, 'marked' | 'unmarkable'>()
  for (const [key, rows] of derivedByLedger) {
    void key
    for (const d of rows) if (d.kind === 'mark') markStatus.set(`${d.childId}::${d.horizon}`, d.status)
  }
  const overdueMarks: DecisionReport['reconciliation']['overdueMarks'] = []
  const markCoverage = { marked: 0, unmarkable: 0, notYetDue: 0, overdue: 0 }
  const allChildren: Array<{ child: DecisionChild | BrakeChild; ledger: string }> = [
    ...decisionChildren.map(c => ({ child: c, ledger: 'decisions' })),
    ...brakeChildren.map(c => ({ child: c, ledger: 'brakes' })),
  ]
  for (const { child, ledger } of allChildren) {
    if (child.markSide === undefined || !inWindow(child.capturedAt)) continue
    const decidedAt = decidedAtOf.get(child.parentId)
    if (decidedAt === undefined) continue
    const anchorMs = Date.parse(dayOf(Date.parse(decidedAt))) + DAY_MS
    for (const h of ['1D', '3D', '7D', '30D']) {
      const status = markStatus.get(`${child.id}::${h}`)
      if (status === 'marked') { markCoverage.marked++; continue }
      if (status === 'unmarkable') { markCoverage.unmarkable++; continue }
      const dueMs = anchorMs + HORIZON_DAYS[h] * DAY_MS + graceHours * 3_600_000
      if (nowMs >= dueMs) {
        markCoverage.overdue++
        overdueMarks.push({ ledger, childId: child.id, horizon: h })
      } else {
        markCoverage.notYetDue++
      }
    }
  }

  // ---- Check 5: context coverage (report-only) ----
  const derivedFunding = new Set<string>()
  const derivedRegime = new Set<string>()
  for (const rows of derivedByLedger.values()) {
    for (const d of rows) {
      if (d.kind === 'fundingContext') derivedFunding.add(d.childId)
      if (d.kind === 'regimeContext') derivedRegime.add(d.childId)
    }
  }
  const contextCoverage = { funding: { pending: 0, derived: 0 }, regime: { pending: 0, derived: 0 } }
  for (const { child } of allChildren) {
    if (child.context.funding.bucket === 'unavailable' && child.context.funding.contextSource === 'live') {
      derivedFunding.has(child.id) ? contextCoverage.funding.derived++ : contextCoverage.funding.pending++
    }
    if (child.context.regime.zone === 'UNKNOWN' && child.context.regime.contextSource === 'live') {
      derivedRegime.has(child.id) ? contextCoverage.regime.derived++ : contextCoverage.regime.pending++
    }
  }

  // ---- Verdicts ----
  const failures =
    missingDecisionParents.length + missingBrakeParents.length +
    childCountMismatches.length + overdueMarks.length + unreadable.length
  const baselineUnset = captureSince === undefined
  const rowsInWindow = decisionParents.filter(p => inWindow(p.capturedAt)).length + brakeParents.filter(p => inWindow(p.capturedAt)).length
  const noData = !baselineUnset && failures === 0 && commitsInWindow === 0 && eventsInWindow === 0 && rowsInWindow === 0
  const ok = !baselineUnset && failures === 0

  const headline = baselineUnset
    ? 'evidence incomplete — no behavioral conclusions allowed (captureSince baseline is unset; completeness undetermined)'
    : failures > 0
      ? 'evidence incomplete — no behavioral conclusions allowed'
      : noData
        ? 'no data yet — reconciliation OK (an honest zero)'
        : 'reconciliation OK — evidence complete for the capture window'

  // ---- Analysis (second, tier-gated) ----
  const parentsById = new Map(decisionParents.map(p => [p.id, p]))
  const overrides = decisionParents.filter(p => p.override)
  const cellsSideRegime = new Map<string, number>()
  const cellsSideFunding = new Map<string, number>()
  for (const c of decisionChildren) {
    if (c.role !== 'entry' || c.side === undefined || !inWindow(c.capturedAt)) continue
    if (!parentsById.has(c.parentId)) continue
    // Derived context supersedes live-UNKNOWN/unavailable when present.
    const zoneVal = derivedRegimeZone(c.id, derivedByLedger) ?? c.context.regime.zone
    const bucketVal = derivedFundingBucket(c.id, derivedByLedger) ?? c.context.funding.bucket
    cellsSideRegime.set(`${c.side}×${zoneVal}`, (cellsSideRegime.get(`${c.side}×${zoneVal}`) ?? 0) + 1)
    cellsSideFunding.set(`${c.side}×${bucketVal}`, (cellsSideFunding.get(`${c.side}×${bucketVal}`) ?? 0) + 1)
  }
  const tierStatus = (n: number): string =>
    n < 20 ? 'insufficient — accumulating (no condition-level statements)' : n < 30 ? 'weakly testable' : 'eligible for aggregate statements — still evidence, never verdict'
  const toCells = (m: Map<string, number>): Record<string, { n: number; status: string }> =>
    Object.fromEntries([...m.entries()].map(([k, n]) => [k, { n, status: tierStatus(n) }]))

  return {
    headline,
    baseline: { state: baselineUnset ? 'unset' : 'set', ...(captureSince !== undefined ? { captureSince } : {}) },
    reconciliation: {
      ok,
      noData,
      unreadable,
      missingDecisionParents,
      missingBrakeParents,
      childCountMismatches,
      overdueMarks,
      markCoverage,
      contextCoverage,
      rejectedParentsInfo: brakeParents.filter(p => p.disposition === 'rejected').length,
    },
    process: {
      decisionParents: decisionParents.length,
      decisionChildren: decisionChildren.length,
      brakeParents: {
        blocked: brakeParents.filter(p => p.disposition === 'blocked').length,
        overridden: brakeParents.filter(p => p.disposition === 'overridden').length,
        rejected: brakeParents.filter(p => p.disposition === 'rejected').length,
      },
      overrides: overrides.length,
      overrideReasonMissing: overrides.filter(p => p.overrideReason === null).length,
    },
    cells: {
      note: 'fill counts only — outcome statistics are tier-gated by code and refused below n=20 per cell; research evidence only, never a signal',
      sideRegime: toCells(cellsSideRegime),
      sideFunding: toCells(cellsSideFunding),
    },
  }
}

function derivedRegimeZone(childId: string, byLedger: Map<string, Derived[]>): string | undefined {
  for (const rows of byLedger.values()) {
    for (const d of rows) if (d.kind === 'regimeContext' && d.childId === childId) return d.zone
  }
  return undefined
}
function derivedFundingBucket(childId: string, byLedger: Map<string, Derived[]>): string | undefined {
  for (const rows of byLedger.values()) {
    for (const d of rows) if (d.kind === 'fundingContext' && d.childId === childId) return d.bucket
  }
  return undefined
}

// ==================== Tool factory ====================

export function createHumanDecisionReportTools(deps: DecisionReportDeps = {}) {
  return {
    human_decision_report: tool({
      description: `Track D quarterly report (docs/human-decision-ledger-v0.md, D3):
RECONCILIATION FIRST, analysis second.

Audits the decision & brake ledgers' completeness against the trading-git
history and risk-gate verdict events BEFORE reporting anything about
behavior. Any completeness failure (or an unset captureSince baseline)
puts "evidence incomplete — no behavioral conclusions allowed" on the
first line. Analysis is fill-counts only, tier-gated by code. Research
evidence only — never a signal, never a per-trade grade, never
"your edge is X".`,
      inputSchema: z.object({
        accountId: z.string().optional().describe('Limit to one account; omit for all'),
      }),
      execute: async ({ accountId }) => collectDecisionReport(deps, accountId),
    }),
  }
}
