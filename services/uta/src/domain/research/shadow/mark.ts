/**
 * Pure mark-to-market math — docs/strategy-shadow-track-v0.md "Daily
 * semantics", pinned to the backtest cost family (regime-trend-v0:
 * 7 bps fee + 3 bps slippage per executed leg). decimal.js throughout;
 * returns are decimal FRACTIONS, never percent numbers.
 */

import Decimal from 'decimal.js'
import type { CostModel, Stance } from './types.js'

export function stanceNum(s: Stance): number {
  return s === 'long' ? 1 : s === 'short' ? -1 : 0
}

/** Executed legs when `held` replaces `prev` (long→short = 2 legs). The
 *  change decided at close of D−1 executes at the open of day D, so its
 *  cost lands in day D's mark. */
export function legsBetween(prev: Stance, held: Stance): number {
  return Math.abs(stanceNum(held) - stanceNum(prev))
}

export interface DayMark {
  grossRet: Decimal
  legs: number
  costPerLegBps: Decimal
  netRet: Decimal
}

export function markDay(args: {
  /** Stance held during the marked day (the previous day's decision). */
  heldStance: Stance
  /** Stance held during the day before that — leg counting baseline.
   *  'flat' for the first mark of a track and after an unknown-gap
   *  re-anchor (continuity through an unobserved span may not be claimed). */
  prevHeldStance: Stance
  prevClose: Decimal
  close: Decimal
  costModel: CostModel
}): DayMark {
  const sign = stanceNum(args.heldStance)
  const grossRet = sign === 0
    ? new Decimal(0)
    : args.close.div(args.prevClose).minus(1).times(sign)
  const legs = legsBetween(args.prevHeldStance, args.heldStance)
  const costPerLegBps = new Decimal(args.costModel.feeBpsPerLeg)
    .plus(args.costModel.slippageBpsPerLeg)
  const netRet = grossRet.minus(costPerLegBps.div(10_000).times(legs))
  return { grossRet, legs, costPerLegBps, netRet }
}

export function applyEquity(prevEquity: Decimal, netRet: Decimal): Decimal {
  return prevEquity.times(new Decimal(1).plus(netRet))
}
