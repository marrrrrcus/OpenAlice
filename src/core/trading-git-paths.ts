/**
 * Trading-git state file locations — the SINGLE source of candidate paths
 * for `data/trading/{id}/commit.json` and its legacy fallbacks.
 *
 * Shared deliberately: the UTA's `git-persistence.ts` (runtime load/save)
 * and the D3 reconciliation reader (src/domain/research) must resolve the
 * exact same files in the exact same order — a completeness audit that
 * reads different paths than the runtime would report phantom losses on
 * legacy accounts. Pure path math: zero fs, zero domain types.
 */

import { dataPath } from './paths.js'

/** Legacy locations kept for backward compat. TODO: remove before v1.0. */
const LEGACY_GIT_PATHS: Record<string, string[]> = {
  'bybit-main': [dataPath('crypto-trading', 'commit.json')],
  'alpaca-paper': [dataPath('securities-trading', 'commit.json')],
  'alpaca-live': [dataPath('securities-trading', 'commit.json')],
}

/** Primary persisted git-state path for an account. */
export function gitStatePrimaryPath(accountId: string): string {
  return dataPath('trading', accountId, 'commit.json')
}

/**
 * All candidate paths in the runtime's resolution order: primary first,
 * then any legacy fallbacks. Readers use the first file that exists.
 */
export function gitStateCandidatePaths(accountId: string): string[] {
  return [gitStatePrimaryPath(accountId), ...(LEGACY_GIT_PATHS[accountId] ?? [])]
}
