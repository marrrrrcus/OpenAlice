/**
 * Track D ledgers — append-only JSONL, per-account, single writer per file
 * (docs/human-decision-ledger-v0.md). Same authority discipline as the
 * shadow ledger, with row-type-specific validation:
 *
 *   - ONLY a missing file is a cold start; any other read failure THROWS
 *     (an unreadable ledger must never read as empty);
 *   - malformed / structurally incomplete lines are skipped;
 *   - derived rows: last row per (childId, kind, horizon|—) wins;
 *     'marked' is final, 'unmarkable' is supersedable.
 */

import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname } from 'path'
import { dataPath } from '@/core/paths.js'
import type {
  BrakesBaseRow,
  DecisionsBaseRow,
  DerivedRow,
  FundingContextRow,
  Horizon,
  MarkRow,
  RegimeContextRow,
} from './types.js'

// ==================== Paths ====================

export function decisionsDir(): string {
  return dataPath('research', 'decisions')
}
export function decisionsLedgerPath(accountId: string, dir = decisionsDir()): string {
  return `${dir}/${accountId}.decisions.jsonl`
}
export function brakesLedgerPath(accountId: string, dir = decisionsDir()): string {
  return `${dir}/${accountId}.brakes.jsonl`
}
export function decisionsDerivedPath(accountId: string, dir = decisionsDir()): string {
  return `${dir}/${accountId}.decisions.derived.jsonl`
}
export function brakesDerivedPath(accountId: string, dir = decisionsDir()): string {
  return `${dir}/${accountId}.brakes.derived.jsonl`
}

// ==================== Append / read ====================

export async function appendRow(filePath: string, row: object): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(row) + '\n', 'utf-8')
}

async function readJsonl<T>(filePath: string, isValid: (r: unknown) => r is T): Promise<T[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    // ONLY a missing file is a cold start (the shadow-ledger ruling).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const rows: T[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isValid(parsed)) rows.push(parsed)
    } catch { /* malformed line — skipped */ }
  }
  return rows
}

// ==================== Validation ====================

const isStr = (x: unknown): x is string => typeof x === 'string'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isBool = (x: unknown): x is boolean => typeof x === 'boolean'
const rec = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object'

const ROLES: ReadonlySet<string> = new Set(['entry', 'exit', 'neutral', 'unclassified'])
const SIDES: ReadonlySet<string> = new Set(['LONG', 'SHORT'])
const INTENT_KINDS: ReadonlySet<string> = new Set(['risk-increasing', 'risk-reducing', 'neutral', 'unclassified'])
const PRICED_BY: ReadonlySet<string> = new Set(['cashQty', 'lmtPrice', 'auxPrice', 'quote', 'unpriced', 'n/a'])
const DISPOSITIONS: ReadonlySet<string> = new Set(['blocked', 'overridden', 'rejected'])
const ZONES: ReadonlySet<string> = new Set(['BULL', 'BEAR', 'GRAY', 'UNKNOWN'])
const BUCKETS: ReadonlySet<string> = new Set(['extreme-positive', 'positive', 'non-positive', 'unavailable'])
const HORIZON_SET: ReadonlySet<string> = new Set(['1D', '3D', '7D', '30D'])

function validParentCore(r: Record<string, unknown>): boolean {
  return isStr(r['id']) && isStr(r['accountId']) && isStr(r['presetId']) &&
    isStr(r['capturedAt']) && isStr(r['decidedAt']) && isStr(r['pendingHash']) &&
    isStr(r['message']) && rec(r['gateSummary']) && isNum(r['childCount'])
}

function validChildCore(r: Record<string, unknown>): boolean {
  if (!(isStr(r['id']) && isStr(r['parentId']) && isStr(r['accountId']) &&
    isStr(r['capturedAt']) && isNum(r['opIndex']) && isStr(r['opAction']))) return false
  const intent = r['intent']
  if (!rec(intent) || !isStr(intent['kind']) || !INTENT_KINDS.has(intent['kind'])) return false
  if (!isStr(r['role']) || !ROLES.has(r['role'])) return false
  if (r['side'] !== undefined && (!isStr(r['side']) || !SIDES.has(r['side']))) return false
  if (r['markSide'] !== undefined && (!isStr(r['markSide']) || !SIDES.has(r['markSide']))) return false
  if (!isStr(r['pricedBy']) || !PRICED_BY.has(r['pricedBy'])) return false
  const context = r['context']
  if (!rec(context)) return false
  const regime = context['regime']
  const funding = context['funding']
  if (!rec(regime) || !isStr(regime['zone']) || !ZONES.has(regime['zone'])) return false
  if (!rec(funding) || !isStr(funding['bucket']) || !BUCKETS.has(funding['bucket'])) return false
  return true
}

export function isValidDecisionsRow(parsed: unknown): parsed is DecisionsBaseRow {
  if (!rec(parsed)) return false
  if (parsed['kind'] === 'push') {
    return validParentCore(parsed) && isBool(parsed['override']) && rec(parsed['results'])
  }
  if (parsed['kind'] === 'intent') return validChildCore(parsed)
  return false
}

export function isValidBrakesRow(parsed: unknown): parsed is BrakesBaseRow {
  if (!rec(parsed)) return false
  if (parsed['kind'] === 'verdict') {
    return validParentCore(parsed) &&
      isStr(parsed['disposition']) && DISPOSITIONS.has(parsed['disposition']) &&
      Array.isArray(parsed['blockingGates'])
  }
  if (parsed['kind'] === 'blocked-intent') {
    return validChildCore(parsed) && parsed['baseline'] === 'flat'
  }
  return false
}

export function isValidDerivedRow(parsed: unknown): parsed is DerivedRow {
  if (!rec(parsed) || !isStr(parsed['childId']) || !isStr(parsed['at'])) return false
  if (parsed['kind'] === 'mark') {
    if (!isStr(parsed['horizon']) || !HORIZON_SET.has(parsed['horizon'])) return false
    if (parsed['status'] === 'marked') {
      // A 'marked' row is FINAL for its cell — a structurally incomplete one
      // would disguise bad evidence as finished evidence. Reject it so the
      // reader sees a hole and the marker recomputes the cell.
      return isStr(parsed['side']) && SIDES.has(parsed['side']) &&
        parsed['anchorPolicy'] === 'next-daily-open' &&
        isStr(parsed['anchorDateUtc']) &&
        isStr(parsed['entryPrice']) && isStr(parsed['exitPrice']) &&
        isStr(parsed['ret']) && isStr(parsed['mae']) && isStr(parsed['mfe']) &&
        isStr(parsed['entryOpenDateUtc']) && isStr(parsed['exitCloseDateUtc'])
    }
    if (parsed['status'] === 'unmarkable') {
      return isStr(parsed['reason'])
    }
    return false
  }
  if (parsed['kind'] === 'fundingContext') {
    return parsed['contextSource'] === 'derived' &&
      isStr(parsed['bucket']) && BUCKETS.has(parsed['bucket'])
  }
  if (parsed['kind'] === 'regimeContext') {
    return parsed['contextSource'] === 'derived' &&
      isStr(parsed['zone']) && ZONES.has(parsed['zone'])
  }
  return false
}

export const readDecisionsRows = (filePath: string): Promise<DecisionsBaseRow[]> =>
  readJsonl(filePath, isValidDecisionsRow)
export const readBrakesRows = (filePath: string): Promise<BrakesBaseRow[]> =>
  readJsonl(filePath, isValidBrakesRow)
export const readDerivedRows = (filePath: string): Promise<DerivedRow[]> =>
  readJsonl(filePath, isValidDerivedRow)

// ==================== Join helpers ====================

/** Last mark per (childId, horizon) wins; 'marked' is final by the writer's
 *  discipline (it never re-appends over a marked cell). */
export function effectiveMarks(rows: readonly DerivedRow[]): Map<string, MarkRow> {
  const map = new Map<string, MarkRow>()
  for (const row of rows) {
    if (row.kind === 'mark') map.set(`${row.childId}::${row.horizon}`, row)
  }
  return map
}

export function markKey(childId: string, horizon: Horizon): string {
  return `${childId}::${horizon}`
}

/** Latest derived funding context per childId. */
export function effectiveFundingContext(rows: readonly DerivedRow[]): Map<string, FundingContextRow> {
  const map = new Map<string, FundingContextRow>()
  for (const row of rows) {
    if (row.kind === 'fundingContext') map.set(row.childId, row)
  }
  return map
}

/** Latest derived regime context per childId. */
export function effectiveRegimeContext(rows: readonly DerivedRow[]): Map<string, RegimeContextRow> {
  const map = new Map<string, RegimeContextRow>()
  for (const row of rows) {
    if (row.kind === 'regimeContext') map.set(row.childId, row)
  }
  return map
}
