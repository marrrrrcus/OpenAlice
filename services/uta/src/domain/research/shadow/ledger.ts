/**
 * Per-strategy JSONL ledger — THE authority of the shadow track
 * (docs/strategy-shadow-track-v0.md). Single writer (the UTA research
 * shadow), append-only, ~1 line per day.
 *
 * Reader rules (pinned):
 *   - for a given dateUtc the LAST row wins (a later good day row
 *     supersedes an earlier unknown row — append-only self-healing);
 *   - malformed lines are skipped (same tolerance as the event log);
 *   - day rows are FINAL — only unknown rows may be superseded, and only
 *     while nothing has been recorded after them (enforced by the runner's
 *     pending-scan floor, which never reaches behind the newest day row).
 */

import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname } from 'path'
import { dataPath } from '@/core/paths.js'
import type { LedgerRow } from './types.js'

export function researchLedgerPath(strategyId: string): string {
  return dataPath('research', 'shadow', `${strategyId}.jsonl`)
}

export async function appendLedgerRow(filePath: string, row: LedgerRow): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(row) + '\n', 'utf-8')
}

export async function readLedgerRows(filePath: string): Promise<LedgerRow[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    // ONLY a missing file is a cold start. Any other read failure — a
    // transient lock, permission, I/O — must THROW: treating it as an empty
    // track would let the runner mint a fresh anchor row ON TOP of existing
    // evidence and fork the authoritative ledger. Callers isolate the throw
    // (idle + warn), they never score through it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const rows: LedgerRow[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isValidLedgerRow(parsed)) rows.push(parsed)
    } catch { /* malformed line — skipped */ }
  }
  return rows
}

const STANCES: ReadonlySet<string> = new Set(['long', 'short', 'flat'])

/**
 * Structural validation — a row the chain logic would misread must be
 * rejected, not half-accepted. Day rows are FINAL, so an incomplete day row
 * (missing close/stance) cannot self-heal; better it reads as a hole (which
 * evaluation counts as unknown) than as a corrupt link in the chain.
 */
function isValidLedgerRow(parsed: unknown): parsed is LedgerRow {
  if (parsed === null || typeof parsed !== 'object') return false
  const row = parsed as Record<string, unknown>
  if (typeof row['dateUtc'] !== 'string') return false
  if (typeof row['at'] !== 'string') return false
  if (typeof row['equity'] !== 'string') return false
  if (row['kind'] === 'unknown') {
    return typeof row['reason'] === 'string'
  }
  if (row['kind'] !== 'day') return false
  if (typeof row['backfilled'] !== 'boolean') return false
  if (typeof row['close'] !== 'string') return false
  if (typeof row['stance'] !== 'string' || !STANCES.has(row['stance'])) return false
  const mark = row['mark']
  if (mark !== undefined) {
    if (mark === null || typeof mark !== 'object') return false
    const m = mark as Record<string, unknown>
    if (typeof m['stanceHeld'] !== 'string' || !STANCES.has(m['stanceHeld'])) return false
    if (typeof m['prevClose'] !== 'string') return false
    if (typeof m['grossRet'] !== 'string') return false
    if (typeof m['netRet'] !== 'string') return false
    if (typeof m['costPerLegBps'] !== 'string') return false
    if (typeof m['legs'] !== 'number') return false
  }
  return true
}

/** Effective view: last row per dateUtc wins. Insertion order of the map
 *  follows first appearance, but values are the superseding rows. */
export function effectiveRows(rows: readonly LedgerRow[]): Map<string, LedgerRow> {
  const map = new Map<string, LedgerRow>()
  for (const row of rows) map.set(row.dateUtc, row)
  return map
}
