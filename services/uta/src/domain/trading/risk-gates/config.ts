/**
 * Risk-gate configuration — data/config/risk-gates.json.
 *
 * Deliberately NOT loaded through core/config.ts's parse-or-throw path: an
 * invalid safety config must be a RUNTIME verdict (BLOCK risk-increasing,
 * reduce-only emergency path per the spec's invalid-config table), never a
 * startup crash. Same directory and Zod discipline, different failure mode.
 *
 * Freshness: read-per-evaluation with an mtime cache — pushes are rare, the
 * file is tiny, and "edit config + reload" needs no restart. Editing this
 * file is the ONLY override path (no one-click override anywhere).
 */

import { readFile, writeFile, stat, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { z } from 'zod'
import { dataPath } from '@/core/paths.js'

// ==================== Schema ====================

// Phase 2 — regime veto (docs/regime-veto-onboarding-v0.md, validated rule
// SHORT in BULL → BLOCK from regime-risk-gate-v0@70eb587). Execution
// instruments (broker/ccxt nativeKey notation) and the regime SOURCE
// (Binance spot BTCUSDT — fixed by the validation) are deliberately
// separate keys; conflating them is a symbol-mapping bug the config shape
// forbids. The veto has its OWN mode, independent of the pipeline mode.
const regimeVetoSchema = z.object({
  mode: z.enum(['off', 'observe', 'enforce']).default('observe'),
  gatedInstruments: z.array(z.string()).default(['BTC/USDT:USDT']),
  regimeSource: z.object({
    // Literal, not free string: the provider only speaks Binance spot (the
    // venue the validation was computed from). A config claiming another
    // venue would silently still hit Binance — schema-invalid is honest,
    // silent substitution is not. Extending venues = a schema change here
    // AND a provider implementation, deliberately.
    venue: z.literal('binance_spot').default('binance_spot'),
    symbol: z.string().default('BTCUSDT'),
  }).default({ venue: 'binance_spot', symbol: 'BTCUSDT' }),
  regimeStaleAfterHours: z.number().positive().default(30),
  spec: z.string().default('regime-risk-gate-v0@70eb587'),
})

export type RegimeVetoConfig = z.infer<typeof regimeVetoSchema>

const thresholdsSchema = z.object({
  mode: z.enum(['off', 'observe', 'enforce']).default('observe'),
  // G1 — effective cap = min(absolute cap, pct-of-equity)
  maxOrderNotionalAbsUsd: z.number().positive().default(1000),
  maxOrderNotionalEquityPct: z.number().positive().default(25),
  // G2 — gross projected exposure vs equity
  maxTotalExposurePct: z.number().positive().default(100),
  // G3 — transfer-adjusted daily loss (observe-only until transfers exist)
  dailyLossLimitPct: z.number().positive().default(5),
  // G4
  maxPushesPerHour: z.number().int().positive().default(10),
  duplicateWindowSec: z.number().int().positive().default(120),
  // Quote/state staleness bound
  snapshotMaxAgeSec: z.number().int().positive().default(300),
  // G2 — explicit per-account acceptance of a degraded resting-order scope
  // (broker cannot enumerate all open orders). Default FALSE: under enforce,
  // degraded scope BLOCKS risk-increasing pushes (Marcus's P1 ruling —
  // fail-closed by default, relaxation must leave a config-file trace).
  allowDegradedRestingScope: z.boolean().default(false),
  // Phase 2 regime veto (per-gate mode; see regimeVetoSchema above).
  regimeVeto: regimeVetoSchema.default({
    mode: 'observe',
    gatedInstruments: ['BTC/USDT:USDT'],
    regimeSource: { venue: 'binance_spot', symbol: 'BTCUSDT' },
    regimeStaleAfterHours: 30,
    spec: 'regime-risk-gate-v0@70eb587',
  }),
})

const riskGatesFileSchema = z.object({
  defaults: thresholdsSchema.partial().default({}),
  accounts: z.record(z.string(), thresholdsSchema.partial()).default({}),
})

export type RiskGateThresholds = z.infer<typeof thresholdsSchema>
export interface ResolvedRiskGateConfig extends RiskGateThresholds {
  /** Where the numbers came from — surfaced in every report. */
  source: 'file' | 'defaults'
}

export type RiskGatesConfigResolution =
  | { status: 'ok'; source: 'file' | 'defaults'; forAccount(accountId: string, presetId: string): ResolvedRiskGateConfig }
  | { status: 'invalid'; error: string }

// ==================== Resolution ====================

const CODE_DEFAULTS: RiskGateThresholds = thresholdsSchema.parse({})

function resolveFor(
  file: z.infer<typeof riskGatesFileSchema> | undefined,
  source: 'file' | 'defaults',
  accountId: string,
  presetId: string,
): ResolvedRiskGateConfig {
  const fileDefaults = file?.defaults ?? {}
  const account = file?.accounts?.[accountId] ?? {}
  const merged: RiskGateThresholds = { ...CODE_DEFAULTS, ...fileDefaults, ...account }
  // regimeVeto is a nested object — a shallow spread would let a partial
  // per-account block wipe the defaults. Deep-merge one level.
  merged.regimeVeto = {
    ...CODE_DEFAULTS.regimeVeto,
    ...(fileDefaults.regimeVeto ?? {}),
    ...(account.regimeVeto ?? {}),
    regimeSource: {
      ...CODE_DEFAULTS.regimeVeto.regimeSource,
      ...(fileDefaults.regimeVeto?.regimeSource ?? {}),
      ...(account.regimeVeto?.regimeSource ?? {}),
    },
  }
  // Mode precedence: explicit per-account > mock-preset enforce > file default
  // > code default (observe). "Mock enforces from day one" is keyed off the
  // preset (id 'mock-simulator'), not an account literally named "mock".
  if (account.mode === undefined) {
    if (presetId === 'mock-simulator') merged.mode = 'enforce'
    else if (fileDefaults.mode !== undefined) merged.mode = fileDefaults.mode
  }
  return { ...merged, source }
}

// ==================== Loader (mtime-cached, never throws) ====================

export function riskGatesConfigPath(): string {
  return dataPath('config', 'risk-gates.json')
}

export function createRiskGatesConfigLoader(
  filePath: string = riskGatesConfigPath(),
): () => Promise<RiskGatesConfigResolution> {
  let cache: { mtimeMs: number; resolution: RiskGatesConfigResolution } | undefined

  return async (): Promise<RiskGatesConfigResolution> => {
    let mtimeMs: number | undefined
    try {
      mtimeMs = (await stat(filePath)).mtimeMs
    } catch {
      // Missing file → code defaults (valid, observe-by-default).
      const resolution: RiskGatesConfigResolution = {
        status: 'ok',
        source: 'defaults',
        forAccount: (accountId, presetId) => resolveFor(undefined, 'defaults', accountId, presetId),
      }
      return resolution
    }

    if (cache && cache.mtimeMs === mtimeMs) return cache.resolution

    let resolution: RiskGatesConfigResolution
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as unknown
      const parsed = riskGatesFileSchema.parse(raw)
      resolution = {
        status: 'ok',
        source: 'file',
        forAccount: (accountId, presetId) => resolveFor(parsed, 'file', accountId, presetId),
      }
    } catch (err) {
      // Unparseable → fail-closed with reduce-only emergency path (handled
      // by the evaluator). Loud, never silent, never a crash.
      resolution = {
        status: 'invalid',
        error: err instanceof Error ? err.message : String(err),
      }
    }
    cache = { mtimeMs, resolution }
    return resolution
  }
}

/**
 * Seed the default config file if absent (called once at UTA startup so the
 * calibration surface is discoverable). Never overwrites an existing file.
 */
export async function seedRiskGatesConfig(filePath: string = riskGatesConfigPath()): Promise<void> {
  try {
    await stat(filePath)
    return // exists — never touch
  } catch { /* missing → seed */ }
  const seed = {
    defaults: CODE_DEFAULTS,
    accounts: {},
  }
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(seed, null, 2))
  } catch (err) {
    console.warn('[risk-gates] failed to seed default config:', err instanceof Error ? err.message : err)
  }
}
