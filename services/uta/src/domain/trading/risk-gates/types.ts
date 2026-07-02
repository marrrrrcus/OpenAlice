/**
 * Risk-gate pipeline — domain-side types.
 *
 * Contract: docs/risk-gate-pipeline-v0.md (locked spec, commit a79db5f).
 * Interface extension points required by docs/regime-veto-onboarding-v0.md:
 *   1. market-data slot with freshness metadata   → RiskGateContext.marketData
 *   2. shared intent-classification helper        → RiskGateContext.intent
 *   3. annotation codes on PASS                   → GateVerdict.code (protocol)
 *   4. per-gate scoping / NOT_APPLICABLE          → GateVerdict.result
 *
 * Wire shapes (GateVerdict, RiskGateStatus, RiskGateMode) live in
 * @traderalice/uta-protocol — they cross the HTTP boundary in status/push
 * responses. This file holds only in-process shapes.
 */

import type Decimal from 'decimal.js'
import type { Contract } from '@traderalice/ibkr'
import type {
  Operation,
  GitCommit,
  GateVerdict,
  Position,
  AccountInfo,
  OpenOrder,
} from '@traderalice/uta-protocol'
import type { OperationIntent } from './intent.js'
import type { ResolvedRiskGateConfig } from './config.js'
import type { RiskGateStateStore } from './state.js'

// ==================== Extension point 1: market data slot ====================

/** A market datum with explicit freshness metadata (UNKNOWN-is-not-SAFE). */
export interface MarketDatum<T = unknown> {
  value: T
  /** ISO timestamp of the completed data the value was computed from. */
  computedFrom: string
  /** ISO timestamp after which the value must be treated as stale. */
  staleAfter: string
}

/** Read-only market-data slot. Empty in Phase 1; Phase 2's regime veto plugs in here. */
export interface MarketDataSlot {
  get(key: string): MarketDatum | undefined
}

// ==================== Context ====================

export interface QuotePrice {
  price: Decimal
  /** Seconds since the quote's timestamp at evaluation time. */
  ageSec: number
}

export interface RiskGateContext {
  readonly accountId: string
  readonly evaluatedAt: Date
  /** The whole pending commit — the atomic unit under evaluation. */
  readonly operations: readonly Operation[]
  readonly positions: readonly Position[]
  readonly account: Readonly<AccountInfo>
  /** Resting broker orders in Submitted / PreSubmitted state. */
  readonly restingOrders: readonly OpenOrder[]
  /**
   * Provenance of restingOrders: 'all' = broker enumerated every open order
   * (getOpenOrders); 'git-tracked' = degraded fallback covering only ids
   * Alice itself placed — exchange-side/manual orders are INVISIBLE and G2
   * must say so loudly (unknown scope is not full scope).
   */
  readonly restingScope: 'all' | 'git-tracked'
  /**
   * Memoized quote lookup. Returns null when no quote is available or the
   * quote is older than config.snapshotMaxAgeSec — callers treat null as
   * "cannot price" and fail closed.
   */
  priceOf(contract: Contract): Promise<QuotePrice | null>
  /**
   * Convert an amount in `currency` to USD. Returns null when no FX path is
   * available (fail-closed at the consuming gate). Collects FX warnings on
   * the context as a side effect.
   */
  toUsd(amount: Decimal, currency: string): Promise<Decimal | null>
  /** Account equity in USD, or null when unavailable (G1/G2 fail closed). */
  readonly equityUsd: Decimal | null
  readonly config: ResolvedRiskGateConfig
  /** Commit history (persisted trading git) — G4's only data source. */
  readonly history: { readonly commits: readonly GitCommit[] }
  /** G3 start-of-day anchor persistence. */
  readonly state: RiskGateStateStore
  /** True for status-preview evaluations: no state writes (G3 anchor). */
  readonly preview: boolean
  /**
   * Extension point 2 — COMMIT-LEVEL intent classification, precomputed once
   * by the evaluator via `computeIntentLedger` (the whole push + resting
   * orders share one reduction-allowance pool per instrument). Gates do
   * index lookups; per-op re-classification is exactly the P0 aggregate-flip
   * hole and is deliberately not offered here.
   */
  readonly intents: readonly OperationIntent[]
  /** Index-aligned with restingOrders. */
  readonly restingIntents: readonly OperationIntent[]
  /** Extension point 1 — unused in Phase 1. */
  readonly marketData?: MarketDataSlot
  /** FX warnings collected during toUsd calls (e.g. default-table rates). */
  readonly fxWarnings: string[]
}

// ==================== Gate ====================

export interface RiskGate {
  readonly name: string
  /** Extension point 4 — declining jurisdiction renders NOT_APPLICABLE. */
  appliesTo?(ctx: RiskGateContext): boolean
  evaluate(ctx: RiskGateContext): Promise<GateVerdict>
}
