/**
 * Research-capture contract — Track D (docs/human-decision-ledger-v0.md).
 *
 * This file lives on the TRADING side so that domain/trading never imports
 * domain/research (the onReport inversion): the UTA is a dumb emitter of
 * capture events; ALL policy — disposition mapping, override detection,
 * dedup, mock filtering, ledger writes — lives in the research-side
 * recorder that consumes them.
 *
 * Iron rule (pinned in review): the evidence pipeline must never affect the
 * trading pipeline. Every emission is awaited-for-ordering but
 * catch-and-swallow — a recorder failure can never change a push, a
 * reject, or a 409.
 */

import type { Operation, OperationResult, RiskGateStatus, Position, OpenOrder } from '@traderalice/uta-protocol'
import type { OperationIntent } from './risk-gates/intent.js'
import type { QuotePrice } from './risk-gates/types.js'

/**
 * Everything the recorder needs, captured at evaluation time — no
 * re-fetching, no network on the capture path. Optional fields are absent
 * when the gate pipeline's early paths ran (invalid config / mode off /
 * snapshot failure): the recorder records "unclassified", it never guesses.
 */
export interface ResearchCaptureContext {
  accountId: string
  presetId: string
  pendingHash: string
  /** The pending commit message at evaluation time. */
  message: string
  operations: readonly Operation[]
  /** The gate report's evaluatedAt — the decision timestamp. */
  evaluatedAt: string
  intents?: readonly OperationIntent[]
  positions?: readonly Position[]
  restingOrders?: readonly OpenOrder[]
  /** The evaluator's quote cache — the prices the gates actually saw. */
  quotes?: ReadonlyMap<string, QuotePrice | null>
}

export type ResearchCaptureEvent =
  /** A pending commit was pushed and executed at the broker. */
  | { phase: 'executed'; ctx: ResearchCaptureContext; report: RiskGateStatus; commit: { hash: string; results: readonly OperationResult[] } }
  /** An enforce-mode BLOCK stopped the push (emitted before the throw). */
  | { phase: 'blocked'; ctx: ResearchCaptureContext; report: RiskGateStatus }
  /**
   * The human rejected a pending commit for which a verdict had been shown
   * (the preview cache held a report for this exact pendingHash). Emitted
   * only in that case — no cache means nothing was shown, so there is no
   * brake story to record.
   */
  | { phase: 'rejected'; ctx: ResearchCaptureContext; report: RiskGateStatus; reportAgeMs: number; reason?: string }

export type ResearchCaptureSink = (evt: ResearchCaptureEvent) => void | Promise<void>
