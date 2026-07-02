/**
 * Risk-gate evaluator — atomic pre-push evaluation of a whole pending
 * commit (docs/risk-gate-pipeline-v0.md).
 *
 * NEVER throws. Every failure path degrades to a verdict:
 *   - config invalid  → BLOCK risk-increasing / PASS + CONFIG_INVALID_REDUCE_ONLY_PATH
 *   - snapshot fetch  → BLOCK STATE_UNAVAILABLE
 *   - gate exception  → BLOCK PIPELINE_ERROR (that gate)
 *
 * The caller (UnifiedTradingAccount.push) enforces:
 *   mode === 'enforce' && result === 'BLOCK'  ⇒ RiskGateBlockedError
 * observe mode surfaces + logs the same report but never blocks.
 */

import Decimal from 'decimal.js'
import type { Contract } from '@traderalice/ibkr'
import type {
  Operation,
  GitCommit,
  GateVerdict,
  RiskGateStatus,
  Position,
  AccountInfo,
  OpenOrder,
  Quote,
} from '@traderalice/uta-protocol'
import { decOrUndef } from './decimal-io.js'
import { computeIntentLedger } from './intent.js'
import type { RiskGatesConfigResolution } from './config.js'
import type { RiskGateStateStore } from './state.js'
import type { RiskGateContext, QuotePrice, RiskGate } from './types.js'
import { g1MaxOrderNotional } from './gates/g1-max-order-notional.js'
import { g2MaxTotalExposure } from './gates/g2-max-total-exposure.js'
import { g3DailyLossBreaker } from './gates/g3-daily-loss-breaker.js'
import { g4RateAndDuplicate } from './gates/g4-rate-and-duplicate.js'

// ==================== Inputs ====================

export interface RiskGateSnapshot {
  positions: Position[]
  account: AccountInfo
  restingOrders: OpenOrder[]
  /** 'all' = broker enumerated every open order; 'git-tracked' = degraded fallback (annotated by G2). */
  restingScope: 'all' | 'git-tracked'
}

/** Minimal FX surface (matches FxService.convertToUsd). */
export interface FxLike {
  convertToUsd(amount: string, currency: string): Promise<{ usd: string; fxWarning?: string }>
}

export interface EvaluateRiskGatesArgs {
  accountId: string
  presetId: string
  /** The whole pending commit — the atomic unit. */
  operations: readonly Operation[]
  /** Trading-git history (persisted; G4's only source). */
  history: readonly GitCommit[]
  trigger: 'push' | 'preview'
  /** Fetches positions/account/resting orders (aliceIds stamped by the UTA). */
  getSnapshot: () => Promise<RiskGateSnapshot>
  getQuote: (contract: Contract) => Promise<Quote>
  getFx: () => FxLike | undefined
  loadConfig: () => Promise<RiskGatesConfigResolution>
  stateStore: RiskGateStateStore
  now?: () => Date
  /** Override the gate list (tests / future Phase 2 wiring). */
  gates?: readonly RiskGate[]
}

const DEFAULT_GATES: readonly RiskGate[] = [
  g1MaxOrderNotional,
  g2MaxTotalExposure,
  g3DailyLossBreaker,
  g4RateAndDuplicate,
]

// ==================== Evaluation ====================

export async function evaluateRiskGates(args: EvaluateRiskGatesArgs): Promise<RiskGateStatus> {
  const now = args.now?.() ?? new Date()
  const evaluatedAt = now.toISOString()

  // ---- Config resolution (never throws) ----
  let configRes: RiskGatesConfigResolution
  try {
    configRes = await args.loadConfig()
  } catch (err) {
    configRes = { status: 'invalid', error: err instanceof Error ? err.message : String(err) }
  }

  if (configRes.status === 'invalid') {
    // Emergency path: commit-level ledger with EMPTY position knowledge —
    // deterministic and conservative (allowance 0 ⇒ anything not inherently
    // reducing counts increasing; a multi-op flip cannot slip the door).
    const emergency = computeIntentLedger({ positions: [], restingOrders: [], operations: args.operations })
    const anyIncreasing = emergency.operationIntents.some(i => i.kind === 'risk-increasing')
    const verdict: GateVerdict = anyIncreasing
      ? {
          gate: 'PIPELINE',
          result: 'BLOCK',
          code: 'CONFIG_INVALID',
          reason: `risk-gate config invalid (${configRes.error}) — risk-increasing orders blocked (fail-closed); fix data/config/risk-gates.json`,
        }
      : {
          gate: 'PIPELINE',
          result: 'PASS',
          code: 'CONFIG_INVALID_REDUCE_ONLY_PATH',
          reason: `risk-gate config invalid (${configRes.error}) — only the reduce-only path is open; fix data/config/risk-gates.json`,
        }
    return {
      mode: 'enforce', // a broken safety config is never allowed to relax anything
      result: verdict.result === 'BLOCK' ? 'BLOCK' : 'PASS',
      verdicts: [verdict],
      evaluatedAt,
      configSource: 'invalid',
    }
  }

  const config = configRes.forAccount(args.accountId, args.presetId)

  if (config.mode === 'off') {
    return { mode: 'off', result: 'PASS', verdicts: [], evaluatedAt, configSource: config.source }
  }

  // ---- Snapshot (broker state) ----
  let snapshot: RiskGateSnapshot
  try {
    snapshot = await args.getSnapshot()
  } catch (err) {
    return {
      mode: config.mode,
      result: 'BLOCK',
      verdicts: [{
        gate: 'PIPELINE',
        result: 'BLOCK',
        code: 'STATE_UNAVAILABLE',
        reason: `cannot fetch account state: ${err instanceof Error ? err.message : String(err)} (fail-closed)`,
      }],
      evaluatedAt,
      configSource: config.source,
    }
  }

  // ---- Context ----
  const fxWarnings: string[] = []
  const quoteCache = new Map<string, QuotePrice | null>()

  const priceOf = async (contract: Contract): Promise<QuotePrice | null> => {
    const key = contract.aliceId || `${contract.symbol}|${contract.secType}|${contract.currency}`
    if (quoteCache.has(key)) return quoteCache.get(key)!
    let result: QuotePrice | null = null
    try {
      const quote = await args.getQuote(contract)
      const price = decOrUndef(quote.last)
      const ts = quote.timestamp instanceof Date ? quote.timestamp.getTime() : Date.parse(String(quote.timestamp))
      const ageSec = Number.isFinite(ts) ? Math.max(0, (now.getTime() - ts) / 1000) : Number.POSITIVE_INFINITY
      if (price && price.gt(0) && ageSec <= config.snapshotMaxAgeSec) {
        result = { price, ageSec }
      }
    } catch { /* fail-closed: null */ }
    quoteCache.set(key, result)
    return result
  }

  const toUsd = async (amount: Decimal, currency: string): Promise<Decimal | null> => {
    const cur = (currency || 'USD').toUpperCase()
    if (cur === 'USD') return amount
    const fx = args.getFx()
    if (!fx) return null
    try {
      const res = await fx.convertToUsd(amount.toFixed(), cur)
      if (res.fxWarning && !fxWarnings.includes(res.fxWarning)) fxWarnings.push(res.fxWarning)
      return new Decimal(res.usd)
    } catch {
      return null
    }
  }

  const equityRaw = decOrUndef(snapshot.account.netLiquidation)
  const equityUsd = equityRaw ? await toUsd(equityRaw, snapshot.account.baseCurrency || 'USD') : null

  // Commit-level intent ledger — computed ONCE for the atomic unit (whole
  // push + resting orders sharing one reduction-allowance pool). Gates do
  // index lookups; per-op re-classification is the P0 aggregate-flip hole.
  const ledger = computeIntentLedger({
    positions: snapshot.positions,
    restingOrders: snapshot.restingOrders,
    operations: args.operations,
  })

  const ctx: RiskGateContext = {
    accountId: args.accountId,
    evaluatedAt: now,
    operations: args.operations,
    positions: snapshot.positions,
    account: snapshot.account,
    restingOrders: snapshot.restingOrders,
    restingScope: snapshot.restingScope,
    priceOf,
    toUsd,
    equityUsd,
    config,
    history: { commits: args.history },
    state: args.stateStore,
    preview: args.trigger === 'preview',
    intents: ledger.operationIntents,
    restingIntents: ledger.restingIntents,
    fxWarnings,
  }

  // ---- Gates (each fail-closed) ----
  const verdicts: GateVerdict[] = []
  for (const gate of args.gates ?? DEFAULT_GATES) {
    if (gate.appliesTo && !gate.appliesTo(ctx)) {
      verdicts.push({ gate: gate.name, result: 'NOT_APPLICABLE', reason: 'gate declined jurisdiction for this push' })
      continue
    }
    try {
      verdicts.push(await gate.evaluate(ctx))
    } catch (err) {
      verdicts.push({
        gate: gate.name,
        result: 'BLOCK',
        code: 'PIPELINE_ERROR',
        reason: `gate threw: ${err instanceof Error ? err.message : String(err)} (fail-closed)`,
      })
    }
  }

  return {
    mode: config.mode,
    result: verdicts.some(v => v.result === 'BLOCK') ? 'BLOCK' : 'PASS',
    verdicts,
    evaluatedAt,
    configSource: config.source,
  }
}
