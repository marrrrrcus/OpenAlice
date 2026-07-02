/**
 * Research-shadow configuration — data/config/research-shadow.json.
 * Structural copy of the risk-gates config idioms (Zod, mtime-cached loader
 * that never throws, seed-if-absent): an invalid research config must make
 * the shadow IDLE LOUDLY, never crash the UTA process and never guess —
 * for research the safe failure is "stop scoring", not "score wrong".
 *
 * The timer's start/stop decision follows the UTA reload model (restart to
 * apply); the cost model is read per tick and the applied value is recorded
 * on every mark row, so mid-track edits leave a per-row trace.
 */

import { readFile, writeFile, stat, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { z } from 'zod'
import { dataPath } from '@/core/paths.js'

const costModelSchema = z.object({
  feeBpsPerLeg: z.number().nonnegative().default(7),
  slippageBpsPerLeg: z.number().nonnegative().default(3),
})

const strategyToggleSchema = z.object({
  enabled: z.boolean().default(true),
})

const researchShadowFileSchema = z.object({
  enabled: z.boolean().default(true),
  // Pinned to the backtest cost family (regime-trend-v0: 7 + 3 bps/leg).
  costModel: costModelSchema.default({ feeBpsPerLeg: 7, slippageBpsPerLeg: 3 }),
  maxBackfillDays: z.number().int().positive().default(14),
  staleGraceHours: z.number().positive().default(6),
  // A registered strategy ABSENT from this map runs by default — the static
  // code-reviewed registry is the gate; this map is the off-switch. Days
  // while disabled count as unknown in that strategy's denominators
  // (operator suspension is an evidence gap like any other).
  strategies: z.record(z.string(), strategyToggleSchema).default({}),
})

export type ResearchShadowConfig = z.infer<typeof researchShadowFileSchema>

export type ResearchShadowConfigResolution =
  | { status: 'ok'; source: 'file' | 'defaults'; config: ResearchShadowConfig }
  | { status: 'invalid'; error: string }

const CODE_DEFAULTS: ResearchShadowConfig = researchShadowFileSchema.parse({})

export function isStrategyEnabled(config: ResearchShadowConfig, strategyId: string): boolean {
  if (!config.enabled) return false
  return config.strategies[strategyId]?.enabled ?? true
}

export function researchShadowConfigPath(): string {
  return dataPath('config', 'research-shadow.json')
}

export function createResearchShadowConfigLoader(
  filePath: string = researchShadowConfigPath(),
): () => Promise<ResearchShadowConfigResolution> {
  let cache: { mtimeMs: number; resolution: ResearchShadowConfigResolution } | undefined

  return async (): Promise<ResearchShadowConfigResolution> => {
    let mtimeMs: number | undefined
    try {
      mtimeMs = (await stat(filePath)).mtimeMs
    } catch {
      return { status: 'ok', source: 'defaults', config: CODE_DEFAULTS }
    }

    if (cache && cache.mtimeMs === mtimeMs) return cache.resolution

    let resolution: ResearchShadowConfigResolution
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as unknown
      resolution = { status: 'ok', source: 'file', config: researchShadowFileSchema.parse(raw) }
    } catch (err) {
      // Unparseable → the shadow idles loudly (runner refuses to score).
      resolution = { status: 'invalid', error: err instanceof Error ? err.message : String(err) }
    }
    cache = { mtimeMs, resolution }
    return resolution
  }
}

/**
 * Seed the default config if absent (UTA startup) so the calibration
 * surface is discoverable. Never overwrites an existing file.
 */
export async function seedResearchShadowConfig(filePath: string = researchShadowConfigPath()): Promise<void> {
  try {
    await stat(filePath)
    return // exists — never touch
  } catch { /* missing → seed */ }
  const seed: ResearchShadowConfig = {
    ...CODE_DEFAULTS,
    strategies: {
      'buy-and-hold-v0': { enabled: true },
      'regime-trend-v0-shadow': { enabled: true },
    },
  }
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(seed, null, 2))
  } catch (err) {
    console.warn('[research-shadow] failed to seed default config:', err instanceof Error ? err.message : err)
  }
}
