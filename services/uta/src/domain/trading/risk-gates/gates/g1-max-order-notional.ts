/**
 * G1 — Max order notional (fail-closed).
 *
 * Every risk-increasing order in the push must satisfy
 *   notionalUsd ≤ min(maxOrderNotionalAbsUsd, maxOrderNotionalEquityPct × equityUsd)
 *
 * No price → BLOCK. No equity → BLOCK (falling back to the absolute cap
 * alone would silently loosen the limit for small accounts). Risk-reducing
 * and neutral operations are not notional-gated.
 */

import Decimal from 'decimal.js'
import type { GateVerdict } from '@traderalice/uta-protocol'
import type { RiskGate, RiskGateContext } from '../types.js'
import { operationNotional } from '../notional.js'

export const GATE_G1 = 'G1_MAX_ORDER_NOTIONAL'

export const g1MaxOrderNotional: RiskGate = {
  name: GATE_G1,

  async evaluate(ctx: RiskGateContext): Promise<GateVerdict> {
    const increasing = ctx.operations.filter(
      (_, i) => ctx.intents[i]?.kind === 'risk-increasing',
    )
    if (increasing.length === 0) {
      return {
        gate: GATE_G1,
        result: 'NOT_APPLICABLE',
        reason: 'no risk-increasing orders in this push',
      }
    }

    if (!ctx.equityUsd || !ctx.equityUsd.gt(0)) {
      return {
        gate: GATE_G1,
        result: 'BLOCK',
        code: 'EQUITY_UNAVAILABLE',
        reason: 'account equity unavailable — cannot compute the pct-of-equity cap (fail-closed)',
      }
    }

    const capAbs = new Decimal(ctx.config.maxOrderNotionalAbsUsd)
    const capPct = ctx.equityUsd.mul(ctx.config.maxOrderNotionalEquityPct).div(100)
    const cap = Decimal.min(capAbs, capPct)

    for (const op of increasing) {
      const priced = await operationNotional(op, { priceOf: ctx.priceOf, restingOrders: ctx.restingOrders })
      if (!priced.ok) {
        return {
          gate: GATE_G1,
          result: 'BLOCK',
          code: 'CANNOT_PRICE',
          reason: `${priced.reason} (fail-closed)`,
        }
      }
      const usd = await ctx.toUsd(priced.notional, priced.currency)
      if (!usd) {
        return {
          gate: GATE_G1,
          result: 'BLOCK',
          code: 'FX_UNAVAILABLE',
          reason: `cannot normalize ${priced.currency} notional to USD (fail-closed)`,
        }
      }
      if (usd.gt(cap)) {
        return {
          gate: GATE_G1,
          result: 'BLOCK',
          reason: `order notional $${usd.toFixed(2)} > effective cap $${cap.toFixed(2)} (min($${capAbs.toFixed(0)} abs, ${ctx.config.maxOrderNotionalEquityPct}% of equity))`,
          observed: usd.toFixed(2),
          limit: cap.toFixed(2),
        }
      }
    }

    return {
      gate: GATE_G1,
      result: 'PASS',
      ...(ctx.fxWarnings.length > 0 ? { code: 'FX_DEFAULT_RATE' } : {}),
      reason: 'no hard-limit block detected: all risk-increasing order notionals within the effective cap',
    }
  },
}
