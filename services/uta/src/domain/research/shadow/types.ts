/**
 * Strategy shadow track — types.
 * Contract: docs/strategy-shadow-track-v0.md (locked).
 *
 * BOUNDARY: domain/research/ produces research evidence ONLY — a shadow
 * stance is never a signal, never a proposal, never an order. Nothing under
 * domain/trading/ may import from domain/research/; imports the other way
 * are limited to the kline types/fetch (risk-gates regime provider) and the
 * validated computeZone. No execution code, no risk gates, no TradingGit.
 */

import type { KlineRow } from '../../trading/risk-gates/regime/provider.js'

export type Stance = 'long' | 'short' | 'flat'

export interface StrategyContext {
  /** Completed daily candles, oldest → newest; the newest entry is the
   *  decision close for the day being signaled. */
  klines: readonly KlineRow[]
  /** Previous day's stance from the ledger chain. Absent on cold start or
   *  after an unknown gap — hysteresis strategies then fall back to their
   *  reconstructible cold-start rule (see the spec). */
  prevStance?: Stance
}

export type StrategyResult =
  | { stance: Stance; meta?: Record<string, unknown> }
  | { stance: 'unknown'; reason: string }

/** v0 supplies only klines. A future carry strategy adds 'funding' here and
 *  a context slot — the runner refuses (explicit unknown row) until then. */
export type StrategyDataKind = 'klines'

export interface DailyStrategy {
  /** VERSIONED id — any rule change requires a NEW id (new ledger file, new
   *  registration doc). Editing a strategy in place would silently rewrite
   *  its forward history: the classic overfit backdoor. */
  id: string
  symbol: string
  venue: 'binance_spot'
  /** Registration doc with the pinned rule + pre-registered exit criteria. */
  registrationDoc: string
  dataNeeds: { kinds: readonly StrategyDataKind[]; minDays: number }
  compute(ctx: StrategyContext): StrategyResult
}

export interface CostModel {
  feeBpsPerLeg: number
  slippageBpsPerLeg: number
}

// ==================== Ledger rows (the authority) ====================
// All financial values are decimal.js strings; returns are decimal
// FRACTIONS (−0.0081 = −0.81%), never percent numbers.

export interface LedgerMark {
  /** Stance that was held during this day (= the previous day's decision). */
  stanceHeld: Stance
  prevClose: string
  grossRet: string
  legs: number
  /** Cost per leg actually applied (bps) — config changes leave a trace. */
  costPerLegBps: string
  netRet: string
}

export interface LedgerDayRow {
  kind: 'day'
  dateUtc: string
  /** ISO timestamp of the append. */
  at: string
  backfilled: boolean
  close: string
  /** Stance decided at this day's close — held during the NEXT day. */
  stance: Stance
  meta?: Record<string, unknown>
  /** Absent on anchor rows (first row of a track / first row after an
   *  unknown gap): the day's held stance is not attributable. */
  mark?: LedgerMark
  /** Post-netRet equity, or carried unchanged on anchor rows. */
  equity: string
}

export interface LedgerUnknownRow {
  kind: 'unknown'
  dateUtc: string
  at: string
  reason: string
  /** Frozen carry-forward equity — state, not performance. Never a mark. */
  equity: string
}

export type LedgerRow = LedgerDayRow | LedgerUnknownRow

/** Minimal event-log shape (same local duck type as regime/shadow.ts —
 *  events are best-effort mirrors, the ledger is the authority). */
export interface EventLogLike {
  append(type: string, payload: unknown): unknown
}
