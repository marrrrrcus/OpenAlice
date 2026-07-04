/**
 * Track D configuration — data/config/research-decisions.json.
 * Structural clone of the research-shadow config idioms: Zod, mtime-cached
 * loader that never throws, seed-if-absent. Invalid config → the recorder
 * and ticker idle loudly (for evidence the safe failure is "stop
 * recording", never "record wrong").
 */

import { readFile, writeFile, stat, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { z } from 'zod'
import { dataPath } from '@/core/paths.js'
import type { ResearchDecisionsConfig } from './types.js'

const researchDecisionsFileSchema = z.object({
  enabled: z.boolean().default(true),
  // mock-simulator pushes are simulator noise, not "real pushes" (spec).
  // Flip true temporarily for deployment smoke tests, then back.
  captureMockAccounts: z.boolean().default(false),
  // D3 reconciliation baseline: commits/events/rows BEFORE this instant
  // are outside the completeness contract (pre-deployment history).
  // ABSENT → the D3 report is pinned to render "evidence incomplete"
  // regardless of data — an unset baseline means completeness is
  // undetermined. Seeded with the seed time on new installs; existing
  // deployments set it manually to their Track D restart time.
  captureSince: z.string().optional(),
  marker: z.object({
    enabled: z.boolean().default(true),
    graceHours: z.number().positive().default(6),
    // Page size for a single candle fetch — NOT a global backfill cap:
    // deeper gaps are filled across multiple pages; the only hard bound is
    // the venue's own candle depth.
    fetchPageDays: z.number().int().positive().default(1000),
  }).default({ enabled: true, graceHours: 6, fetchPageDays: 1000 }),
  funding: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
})

export type ResearchDecisionsConfigResolution =
  | { status: 'ok'; source: 'file' | 'defaults'; config: ResearchDecisionsConfig }
  | { status: 'invalid'; error: string }

const CODE_DEFAULTS: ResearchDecisionsConfig = researchDecisionsFileSchema.parse({})

export function researchDecisionsConfigPath(): string {
  return dataPath('config', 'research-decisions.json')
}

export function createResearchDecisionsConfigLoader(
  filePath: string = researchDecisionsConfigPath(),
): () => Promise<ResearchDecisionsConfigResolution> {
  let cache: { mtimeMs: number; resolution: ResearchDecisionsConfigResolution } | undefined

  return async (): Promise<ResearchDecisionsConfigResolution> => {
    let mtimeMs: number | undefined
    try {
      mtimeMs = (await stat(filePath)).mtimeMs
    } catch {
      return { status: 'ok', source: 'defaults', config: CODE_DEFAULTS }
    }

    if (cache && cache.mtimeMs === mtimeMs) return cache.resolution

    let resolution: ResearchDecisionsConfigResolution
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as unknown
      resolution = { status: 'ok', source: 'file', config: researchDecisionsFileSchema.parse(raw) }
    } catch (err) {
      resolution = { status: 'invalid', error: err instanceof Error ? err.message : String(err) }
    }
    cache = { mtimeMs, resolution }
    return resolution
  }
}

/** Seed the default config if absent (UTA startup). Never overwrites. */
export async function seedResearchDecisionsConfig(filePath: string = researchDecisionsConfigPath()): Promise<void> {
  try {
    await stat(filePath)
    return // exists — never touch
  } catch { /* missing → seed */ }
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify({ ...CODE_DEFAULTS, captureSince: new Date().toISOString() }, null, 2))
  } catch (err) {
    console.warn('[research-decisions] failed to seed default config:', err instanceof Error ? err.message : err)
  }
}
