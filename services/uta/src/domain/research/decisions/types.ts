/**
 * Track D — human decision ledger + counterfactual brake ledger row types.
 * Contract: docs/human-decision-ledger-v0.md (locked b70364b).
 *
 * BOUNDARY: domain/research/ may import trading TYPES and PURE CLASSIFIERS
 * (OperationIntent, effectiveOrderSide, nativeKeyOf, operationNotional,
 * findPositionFor) — never execution code, TradingGit, or brokers. A
 * decision row is evidence about a decision, never an instruction.
 *
 * Granularity (pinned in review): BOTH ledgers are parent + per-intent
 * child rows — attribution lives at intent level, never push/verdict
 * level. All financial values are decimal strings; returns in derived
 * rows are decimal fractions.
 */

export type EntrySide = 'LONG' | 'SHORT'
export type IntentRole = 'entry' | 'exit' | 'neutral' | 'unclassified'
export type FundingBucket = 'extreme-positive' | 'positive' | 'non-positive' | 'unavailable'
export type ContextSource = 'live' | 'derived'
export type BrakeDisposition = 'blocked' | 'overridden' | 'rejected'

export type Horizon = '1D' | '3D' | '7D' | '30D'
export const HORIZONS: readonly Horizon[] = ['1D', '3D', '7D', '30D']
export const HORIZON_DAYS: Readonly<Record<Horizon, number>> = { '1D': 1, '3D': 3, '7D': 7, '30D': 30 }

/** Verdict summary embedded per parent — the full audit context travels
 *  with the row (the ledger must stand alone, no event-log join needed). */
export interface GateSummary {
  mode: 'off' | 'observe' | 'enforce'
  result: 'PASS' | 'BLOCK'
  configSource: string
  evaluatedAt: string
  verdicts: Array<{
    gate: string
    result: string
    code?: string
    reason: string
    observed?: string
    limit?: string
  }>
}

export interface RegimeContext {
  zone: 'BULL' | 'BEAR' | 'GRAY' | 'UNKNOWN'
  contextSource: ContextSource
  computedFrom?: string
  reason?: string
}

export interface FundingContext {
  bucket: FundingBucket
  contextSource: ContextSource
  reason?: string
}

// ==================== Decision ledger (executed pushes) ====================

export interface DecisionParentRow {
  kind: 'push'
  v: 1
  /** Idempotency key: dec:{accountId}:{pendingHash}. */
  id: string
  accountId: string
  presetId: string
  /** Append time — the audit timestamp (P2: never rely on the 8-hex hash
   *  as the human-readable evidence of WHEN). */
  capturedAt: string
  /** The gate report's evaluatedAt — the decision timestamp. */
  decidedAt: string
  pendingHash: string
  /** Executed commit hash (present on executed pushes). */
  commitHash?: string
  message: string
  gateSummary: GateSummary
  /** True iff any verdict was BLOCK or carried a *_WOULD_BLOCK code —
   *  the human pushed anyway. */
  override: boolean
  /** Always null in v0 — no capture surface exists; recorded-as-missing is
   *  the pinned process-metric failure, never backfilled. */
  overrideReason: string | null
  /** Reserved (opt-in at approval time, no v0 surface). */
  thesis: string | null
  results: { submitted: number; rejected: number }
  childCount: number
}

export interface DecisionChildRow {
  kind: 'intent'
  v: 1
  /** {parentId}#{opIndex} — opIndex is the staged (= execution) index. */
  id: string
  parentId: string
  accountId: string
  capturedAt: string
  opIndex: number
  opAction: string
  aliceId?: string
  nativeKey?: string
  symbol?: string
  currency?: string
  orderSide?: 'BUY' | 'SELL'
  orderType?: string
  qty?: string
  cashQty?: string
  lmtPrice?: string
  /** Passed through from the evaluator's commit-level ledger;
   *  'unclassified' when the pipeline's early paths ran — honest, never
   *  guessed. */
  intent: { kind: 'risk-increasing' | 'risk-reducing' | 'neutral' | 'unclassified'; rationale?: string }
  role: IntentRole
  /**
   * Pinned verbatim (spec): for RISK-INCREASING intents only, side is the
   * exposure-intent side derived from the classifier plus the effective
   * order direction — BUY opens/adds LONG, SELL opens/adds SHORT.
   * Reduce/close intents never carry side (they are exit/de-risk).
   */
  side?: EntrySide
  /** Which exposure the horizon marks measure: the entry side, or (for
   *  exits) the side of the position being reduced (forgone exposure). */
  markSide?: EntrySide
  markSideMeaning?: 'entry' | 'forgone-exposure'
  notional?: string
  notionalCurrency?: string
  pricedBy: 'cashQty' | 'lmtPrice' | 'auxPrice' | 'quote' | 'unpriced' | 'n/a'
  priceAgeSec?: number
  unpricedReason?: string
  /** Index-aligned broker result (executed pushes only). */
  execution?: {
    success?: boolean
    status?: string
    orderId?: string
    filledQty?: string
    filledPrice?: string
    error?: string
  }
  context: { regime: RegimeContext; funding: FundingContext }
}

// ==================== Brake ledger (BLOCK / would-block verdicts) ====================

export interface BrakeParentRow {
  kind: 'verdict'
  v: 1
  /** Idempotency key: brk:{accountId}:{pendingHash}:{disposition}. The same
   *  pending commit can legitimately produce 'blocked' and later
   *  'rejected' — both kept; the reader reconciles as "brake fired, human
   *  obeyed" (documented so D3 never double-counts). */
  id: string
  accountId: string
  presetId: string
  capturedAt: string
  decidedAt: string
  pendingHash: string
  message: string
  disposition: BrakeDisposition
  gateSummary: GateSummary
  /** Gates whose verdict was BLOCK or carried a *_WOULD_BLOCK code. */
  blockingGates: string[]
  /** rejected only: age of the cached (last-shown) report at capture. */
  reportAgeMsAtCapture?: number
  /** rejected only: the human's reject(reason) — subjective context
   *  captured at the moment, never backfilled. */
  rejectReason?: string
  childCount: number
}

export interface BrakeChildRow extends Omit<DecisionChildRow, 'kind' | 'execution'> {
  kind: 'blocked-intent'
  /** Pinned primary comparison (spec): the counterfactual is measured
   *  against flat / no-trade. */
  baseline: 'flat'
}

// ==================== Derived rows (D2 ticker — separate writer/files) ====================

export interface MarkRow {
  kind: 'mark'
  v: 1
  childId: string
  horizon: Horizon
  at: string
  /** 'marked' is FINAL; 'unmarkable' is NOT terminal — it stays in the due
   *  set and a later 'marked' row supersedes it (last-wins per
   *  (childId, horizon)). */
  status: 'marked' | 'unmarkable'
  reason?: string
  side?: EntrySide
  /** Anchor policy pinned: entry = open of the first daily candle AFTER
   *  the decision day (no lookahead; identical methodology for both
   *  ledgers — executed children do NOT use fill prices here). */
  anchorPolicy?: 'next-daily-open'
  anchorDateUtc?: string
  entryPrice?: string
  exitPrice?: string
  /** Signed decimal fractions. */
  ret?: string
  mae?: string
  mfe?: string
  // Forensics (P2): not strategy semantics, but they save the audit.
  venue?: string
  symbol?: string
  nativeKey?: string
  candleSource?: string
  entryOpenDateUtc?: string
  exitCloseDateUtc?: string
}

export interface FundingContextRow {
  kind: 'fundingContext'
  v: 1
  childId: string
  at: string
  contextSource: 'derived'
  bucket: FundingBucket
  reason?: string
  inputs?: {
    symbol: string
    decidedAt: string
    sum24h?: string
    z?: string
    p90PosThreshold?: string
    historyDays?: number
    source: string
  }
}

export interface RegimeContextRow {
  kind: 'regimeContext'
  v: 1
  childId: string
  at: string
  contextSource: 'derived'
  zone: 'BULL' | 'BEAR' | 'GRAY' | 'UNKNOWN'
  reason?: string
  /** The recorded trading.regime.zone event's dateUtc this was derived from. */
  sourceEventDateUtc?: string
}

export type DecisionsBaseRow = DecisionParentRow | DecisionChildRow
export type BrakesBaseRow = BrakeParentRow | BrakeChildRow
export type DerivedRow = MarkRow | FundingContextRow | RegimeContextRow

// ==================== Config ====================

export interface ResearchDecisionsConfig {
  enabled: boolean
  /** mock-simulator pushes are simulator noise, not "real pushes" (spec);
   *  flip to true temporarily for deployment smoke tests. */
  captureMockAccounts: boolean
  marker: {
    enabled: boolean
    graceHours: number
    /** Page size for a single candle fetch — NOT a global backfill cap
     *  (pinned): deeper gaps are filled across multiple pages; the only
     *  hard bound is the venue's own candle depth. */
    fetchPageDays: number
  }
  funding: { enabled: boolean }
}
