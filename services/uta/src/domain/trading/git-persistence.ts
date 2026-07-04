/**
 * Git state persistence — load/save Trading-as-Git commit history.
 *
 * Extracted from main.ts. Pure functions + file IO, no instance dependencies.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { GitExportState } from './git/types.js'
// Candidate paths are shared with the D3 reconciliation reader — the
// completeness audit must resolve the exact same files in the same order
// as the runtime, or legacy accounts would report phantom losses.
import { gitStateCandidatePaths, gitStatePrimaryPath } from '@/core/trading-git-paths.js'

// ==================== Public API ====================

/** Read saved git state from disk, trying primary path then legacy fallback. */
export async function loadGitState(accountId: string): Promise<GitExportState | undefined> {
  for (const candidate of gitStateCandidatePaths(accountId)) {
    try {
      return JSON.parse(await readFile(candidate, 'utf-8')) as GitExportState
    } catch { /* try the next candidate */ }
  }
  return undefined
}

/** Create a callback that persists git state to disk on each commit. */
export function createGitPersister(accountId: string): (state: GitExportState) => Promise<void> {
  const filePath = gitStatePrimaryPath(accountId)
  return async (state: GitExportState) => {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(state, null, 2))
  }
}
