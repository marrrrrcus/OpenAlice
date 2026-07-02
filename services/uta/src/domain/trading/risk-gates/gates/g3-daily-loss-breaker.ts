/**
 * G3 — Daily loss circuit breaker (transfer-adjusted; FORCED OBSERVE in v0).
 *
 * Spec-pinned measure: transfer-adjusted equity change, never raw NLV.
 * No current broker exposes transfer history, so per the spec's hard
 * precondition ("a breaker that trips on a deposit is worse than no
 * breaker") this gate NEVER emits BLOCK in v0 — it computes the raw
 * (transfer-unadjusted) trip condition and reports it loudly:
 *
 *   G3_WOULD_BLOCK                     — trip condition met (review target)
 *   G3_TRANSFER_ADJUSTMENT_UNAVAILABLE — the permanent v0 annotation
 *
 * The start-of-day equity anchor is captured lazily at the first
 * non-preview evaluation of each UTC day (honest approximation, stated in
 * the reason). Risk-reducing pushes are exempt — a breaker must never trap
 * you in a position.
 */

import Decimal from 'decimal.js'
import type { GateVerdict } from '@traderalice/uta-protocol'
import type { RiskGate, RiskGateContext } from '../types.js'
import { decOrUndef } from '../decimal-io.js'
import { utcDayOf } from '../state.js'

export const GATE_G3 = 'G3_DAILY_LOSS'

export const g3DailyLossBreaker: RiskGate = {
  name: GATE_G3,

  async evaluate(ctx: RiskGateContext): Promise<GateVerdict> {
    const hasIncreasing = ctx.intents.some(i => i.kind === 'risk-increasing')
    if (!hasIncreasing) {
      return {
        gate: GATE_G3,
        result: 'PASS',
        code: 'G3_EXEMPT_RISK_REDUCING',
        reason: 'risk-reducing/neutral push — the breaker never traps a human in a position',
      }
    }

    const equity = decOrUndef(ctx.account.netLiquidation)
    if (!equity) {
      return {
        gate: GATE_G3,
        result: 'PASS',
        code: 'G3_EQUITY_UNAVAILABLE',
        reason: 'equity unreadable — daily loss not measurable (G1/G2 already fail closed on this)',
      }
    }

    const day = utcDayOf(ctx.evaluatedAt)
    const anchor = await ctx.state.getDayAnchor(day)
    if (!anchor) {
      if (!ctx.preview) {
        await ctx.state.captureDayAnchor({
          dateUtc: day,
          startOfDayEquity: equity.toFixed(),
          capturedAt: ctx.evaluatedAt.toISOString(),
        })
      }
      return {
        gate: GATE_G3,
        result: 'PASS',
        code: 'G3_TRANSFER_ADJUSTMENT_UNAVAILABLE',
        reason: `day anchor ${ctx.preview ? 'not yet captured (preview does not write)' : 'captured at first evaluation of the UTC day'} — no measurable daily loss yet; transfer adjustment unavailable, breaker is observe-only`,
      }
    }

    const start = new Decimal(anchor.startOfDayEquity)
    const dailyLoss = equity.minus(start) // negative = loss; transfer-UNADJUSTED
    const limit = start.mul(ctx.config.dailyLossLimitPct).div(100)
    const tripped = dailyLoss.lt(limit.neg())

    if (tripped) {
      return {
        gate: GATE_G3,
        result: 'PASS', // forced observe — v0 never blocks on G3
        code: 'G3_WOULD_BLOCK',
        reason: `daily equity change ${dailyLoss.toFixed(2)} exceeds -${ctx.config.dailyLossLimitPct}% of start-of-day equity — WOULD block risk-increasing pushes, but the measure is transfer-UNADJUSTED (deposits/withdrawals pollute it) so the breaker is observe-only in v0`,
        observed: dailyLoss.toFixed(2),
        limit: limit.neg().toFixed(2),
      }
    }

    return {
      gate: GATE_G3,
      result: 'PASS',
      code: 'G3_TRANSFER_ADJUSTMENT_UNAVAILABLE',
      reason: `daily equity change ${dailyLoss.toFixed(2)} within -${ctx.config.dailyLossLimitPct}% limit (transfer-unadjusted, observe-only; anchor captured ${anchor.capturedAt})`,
      observed: dailyLoss.toFixed(2),
      limit: limit.neg().toFixed(2),
    }
  },
}
