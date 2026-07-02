/**
 * Trading-as-Git type definitions
 *
 * Operation is a discriminated union — each variant carries typed IBKR objects.
 * No more Record<string, unknown> type erasure.
 */

import type { Contract, Order, OrderCancel, Execution, OrderState } from '@traderalice/ibkr'
import type Decimal from 'decimal.js'
import type { Position, OpenOrder, TpSlParams } from './broker.js'
import './contract-ext.js'

// ==================== Commit Hash ====================

/** 8-character short SHA-256 hash. */
export type CommitHash = string

// ==================== Operation ====================

export type OperationAction = Operation['action']

export type Operation =
  | { action: 'placeOrder'; contract: Contract; order: Order; tpsl?: TpSlParams }
  | { action: 'modifyOrder'; orderId: string; changes: Partial<Order> }
  | { action: 'closePosition'; contract: Contract; quantity?: Decimal }
  | { action: 'cancelOrder'; orderId: string; orderCancel?: OrderCancel }
  | { action: 'syncOrders' }
  | {
      // Wallet-only event: bridges the gap between Alice's order log and a
      // broker-reported balance change Alice did not initiate (first-sight
      // bootstrap, external transfer, staking reward, off-platform trade).
      // Treated as a virtual market buy/sell at observed price for cost-basis
      // purposes — sign of quantityDelta determines direction.
      //
      // Numeric fields stored as Decimal-as-string so they survive JSON
      // round-trip through git-persistence; reconstruct via `new Decimal(...)`
      // at consumption sites.
      action: 'reconcileBalance'
      aliceId: string
      quantityDelta: string
      markPrice: string
    }

// ==================== Operation Result ====================

export type OperationStatus = 'submitted' | 'filled' | 'rejected' | 'cancelled' | 'user-rejected'

export interface OperationResult {
  action: OperationAction
  success: boolean
  orderId?: string
  status: OperationStatus
  execution?: Execution
  orderState?: OrderState
  /** Decimal as string — sub-satoshi fills must round-trip without loss. */
  filledQty?: string
  /** Decimal as string — see filledQty. */
  filledPrice?: string
  error?: string
  raw?: unknown
}

// ==================== Wallet State ====================

/** State snapshot taken after each commit. All monetary fields are strings to prevent IEEE 754 artifacts. */
export interface GitState {
  netLiquidation: string
  totalCashValue: string
  unrealizedPnL: string
  realizedPnL: string
  positions: Position[]
  pendingOrders: OpenOrder[]
}

// ==================== Commit ====================

export interface GitCommit {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  timestamp: string
  round?: number
}

// ==================== API Results ====================

export interface AddResult {
  staged: true
  index: number
  operation: Operation
}

export interface CommitPrepareResult {
  prepared: true
  hash: CommitHash
  message: string
  operationCount: number
}

export interface PushResult {
  hash: CommitHash
  message: string
  operationCount: number
  submitted: OperationResult[]
  rejected: OperationResult[]
}

export interface RejectResult {
  hash: CommitHash
  message: string
  operationCount: number
}

export interface GitStatus {
  staged: Operation[]
  pendingMessage: string | null
  pendingHash: CommitHash | null
  head: CommitHash | null
  commitCount: number
  /**
   * Risk-gate preview for the pending commit (docs/risk-gate-pipeline-v0.md).
   * Attached by the status route when a pending commit exists and the account
   * has a risk-gate evaluator; absent otherwise. Advisory — enforcement
   * re-evaluates fresh at push time.
   */
  riskGates?: RiskGateStatus
}

// ==================== Risk Gates (Phase 1 hard-limit pipeline) ====================
//
// Wire shapes for docs/risk-gate-pipeline-v0.md. Binary PASS/BLOCK at the
// pipeline level; PASS verdicts may carry annotation codes (e.g.
// CONFIG_INVALID_REDUCE_ONLY_PATH) and a guard may render NOT_APPLICABLE when
// it declines jurisdiction (unvalidated instrument, no relevant ops) — never
// phrased as a pass on the merits. All numeric evidence is decimal strings.

export type RiskGateMode = 'off' | 'observe' | 'enforce'

export type GateResult = 'PASS' | 'BLOCK' | 'NOT_APPLICABLE'

export interface GateVerdict {
  /** Stable gate identifier, e.g. 'G1_MAX_ORDER_NOTIONAL'. */
  gate: string
  result: GateResult
  /** Annotation code — allowed on PASS as well as BLOCK (loud, greppable). */
  code?: string
  /** Observed-vs-limit facts only. A full pass never says "safe". */
  reason: string
  /** Decimal string of the observed quantity, when applicable. */
  observed?: string
  /** Decimal string of the configured limit, when applicable. */
  limit?: string
}

export interface RiskGateStatus {
  mode: RiskGateMode
  /** Pipeline-level binary result: any gate BLOCK ⇒ BLOCK. */
  result: 'PASS' | 'BLOCK'
  verdicts: GateVerdict[]
  evaluatedAt: string
  configSource: 'file' | 'defaults' | 'invalid'
}

export interface OperationSummary {
  symbol: string
  action: OperationAction
  change: string
  status: OperationStatus
}

export interface CommitLogEntry {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  timestamp: string
  round?: number
  operations: OperationSummary[]
}

// ==================== Export State ====================

export interface GitExportState {
  commits: GitCommit[]
  head: CommitHash | null
}

// ==================== Sync ====================

export interface OrderStatusUpdate {
  orderId: string
  symbol: string
  previousStatus: OperationStatus
  currentStatus: OperationStatus
  /** Decimal as string — same precision invariant as OperationResult. */
  filledPrice?: string
  filledQty?: string
}

export interface SyncResult {
  hash: CommitHash
  updatedCount: number
  updates: OrderStatusUpdate[]
}

// ==================== Simulate Price Change ====================

export interface PriceChangeInput {
  /** Contract aliceId or symbol, or "all". */
  symbol: string
  /** "@88000" (absolute) or "+10%" / "-5%" (relative). */
  change: string
}

export interface SimulationPositionCurrent {
  symbol: string
  side: 'long' | 'short'
  qty: string
  avgCost: string
  marketPrice: string
  unrealizedPnL: string
  marketValue: string
}

export interface SimulationPositionAfter {
  symbol: string
  side: 'long' | 'short'
  qty: string
  avgCost: string
  simulatedPrice: string
  unrealizedPnL: string
  marketValue: string
  pnlChange: string
  priceChangePercent: string
}

export interface SimulatePriceChangeResult {
  success: boolean
  error?: string
  currentState: {
    equity: string
    unrealizedPnL: string
    totalPnL: string
    positions: SimulationPositionCurrent[]
  }
  simulatedState: {
    equity: string
    unrealizedPnL: string
    totalPnL: string
    positions: SimulationPositionAfter[]
  }
  summary: {
    totalPnLChange: string
    equityChange: string
    equityChangePercent: string
    worstCase: string
  }
}

// ==================== Stage params (used by AI tool layer + SDK) ====================
//
// All numeric fields are decimal strings — Decimal precision is
// preserved through the staging layer into the persisted git operation
// records. Callers (AI tools, HTTP routes) that have a number must
// convert via `String(x)` at the boundary; that's deliberate friction
// so the precision-loss point is explicit.

export interface StagePlaceOrderParams {
  aliceId: string
  symbol?: string
  action: 'BUY' | 'SELL'
  orderType: string
  totalQuantity?: string
  cashQty?: string
  lmtPrice?: string
  auxPrice?: string
  trailStopPrice?: string
  trailingPercent?: string
  tif?: string
  goodTillDate?: string
  outsideRth?: boolean
  parentId?: string
  ocaGroup?: string
  takeProfit?: { price: string }
  stopLoss?: { price: string; limitPrice?: string }
}

export interface StageModifyOrderParams {
  orderId: string
  totalQuantity?: string
  lmtPrice?: string
  auxPrice?: string
  trailStopPrice?: string
  trailingPercent?: string
  orderType?: string
  tif?: string
  goodTillDate?: string
}

export interface StageClosePositionParams {
  aliceId: string
  symbol?: string
  /** Empty / undefined closes the full position. */
  qty?: string
}

// ==================== Operation Helpers ====================

/** Extract the symbol from any Operation variant. */
export function getOperationSymbol(op: Operation): string {
  switch (op.action) {
    case 'placeOrder': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'modifyOrder': return 'unknown' // modifyOrder doesn't carry contract
    case 'closePosition': return op.contract?.symbol || op.contract?.aliceId || 'unknown'
    case 'cancelOrder': return 'unknown'
    case 'syncOrders': return 'unknown'
    case 'reconcileBalance': return op.aliceId
  }
}
