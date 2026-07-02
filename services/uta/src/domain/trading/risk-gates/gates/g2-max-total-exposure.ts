/**
 * G2 — Max projected gross exposure (fail-closed).
 *
 * Pinned formula (docs/risk-gate-pipeline-v0.md — the most conservative
 * reading: gross, not net; per-account; whole push aggregated):
 *
 *   projected_gross = Σ|position marketValue|
 *                   + Σ|resting risk-increasing order notional|
 *                   + Σ|this push's risk-increasing order notional|
 *   BLOCK if projected_gross > maxTotalExposurePct × equity
 *
 * A long and a short do not cancel. Risk-reducing orders add zero and are
 * never blocked here. Anything unpriceable → BLOCK (fail-closed).
 */

import Decimal from 'decimal.js'
import type { GateVerdict } from '@traderalice/uta-protocol'
import type { RiskGate, RiskGateContext } from '../types.js'
import { decOrUndef } from '../decimal-io.js'
import { operationNotional, restingOrderNotional } from '../notional.js'

export const GATE_G2 = 'G2_MAX_TOTAL_EXPOSURE'

function block(code: string, reason: string): GateVerdict {
  return { gate: GATE_G2, result: 'BLOCK', code, reason: `${reason} (fail-closed)` }
}

export const g2MaxTotalExposure: RiskGate = {
  name: GATE_G2,

  async evaluate(ctx: RiskGateContext): Promise<GateVerdict> {
    const pushIncreasing = ctx.operations.filter(
      (_, i) => ctx.intents[i]?.kind === 'risk-increasing',
    )
    if (pushIncreasing.length === 0) {
      return {
        gate: GATE_G2,
        result: 'NOT_APPLICABLE',
        reason: 'push adds no exposure (risk-reducing/neutral only) — never blocked by the exposure cap',
      }
    }

    // P1 ruling (Marcus, 2026-06): under ENFORCE, a degraded resting scope
    // (broker cannot enumerate all open orders) fail-closes risk-increasing
    // pushes unless the account explicitly opted in to the reduced scope.
    // Observe mode and opted-in accounts get the loud annotation instead.
    if (
      ctx.restingScope === 'git-tracked' &&
      ctx.config.mode === 'enforce' &&
      !ctx.config.allowDegradedRestingScope
    ) {
      return {
        gate: GATE_G2,
        result: 'BLOCK',
        code: 'G2_RESTING_SCOPE_UNAVAILABLE',
        reason: 'broker cannot enumerate all open orders — exposure would be under-counted, fail-closed under enforce; set allowDegradedRestingScope for this account to explicitly accept the git-tracked scope',
      }
    }

    if (!ctx.equityUsd || !ctx.equityUsd.gt(0)) {
      return block('EQUITY_UNAVAILABLE', 'account equity unavailable — cannot compute exposure ratio')
    }

    // 1) Existing positions, gross.
    let projected = new Decimal(0)
    for (const p of ctx.positions) {
      const mv = decOrUndef(p.marketValue)
      if (mv === undefined) return block('POSITION_UNPRICEABLE', `position ${p.contract?.symbol ?? '?'} marketValue unreadable`)
      const usd = await ctx.toUsd(mv.abs(), p.currency || ctx.account.baseCurrency || 'USD')
      if (!usd) return block('FX_UNAVAILABLE', `cannot normalize position ${p.contract?.symbol ?? '?'} to USD`)
      projected = projected.plus(usd)
    }

    // 2) Resting risk-increasing orders (ledger-classified: resting reduce
    //    orders consumed the shared allowance pool first).
    for (let i = 0; i < ctx.restingOrders.length; i++) {
      if (ctx.restingIntents[i]?.kind !== 'risk-increasing') continue
      const o = ctx.restingOrders[i]
      const priced = await restingOrderNotional(o, ctx.priceOf)
      if (!priced.ok) return block('CANNOT_PRICE', `resting order: ${priced.reason}`)
      const usd = await ctx.toUsd(priced.notional, priced.currency)
      if (!usd) return block('FX_UNAVAILABLE', `cannot normalize resting order (${priced.currency}) to USD`)
      projected = projected.plus(usd)
    }

    // 3) This push's risk-increasing orders (whole commit aggregated —
    //    two orders each under the cap must not slip through combined).
    for (const op of pushIncreasing) {
      const priced = await operationNotional(op, { priceOf: ctx.priceOf, restingOrders: ctx.restingOrders })
      if (!priced.ok) return block('CANNOT_PRICE', priced.reason)
      const usd = await ctx.toUsd(priced.notional, priced.currency)
      if (!usd) return block('FX_UNAVAILABLE', `cannot normalize order (${priced.currency}) to USD`)
      projected = projected.plus(usd)
    }

    const ratioPct = projected.div(ctx.equityUsd).mul(100)
    const limitPct = new Decimal(ctx.config.maxTotalExposurePct)

    // Degraded resting scope is never silent: with 'git-tracked' the sum
    // covers only orders Alice itself placed — exchange-side/manual resting
    // orders are invisible, so the true exposure may be HIGHER than observed.
    const degraded = ctx.restingScope === 'git-tracked'
    const scopeSuffix = degraded
      ? ' — resting-order scope limited to git-tracked ids (broker cannot enumerate all open orders; true exposure may be higher)'
      : ''

    if (ratioPct.gt(limitPct)) {
      return {
        gate: GATE_G2,
        result: 'BLOCK',
        reason: `projected gross exposure ${ratioPct.toFixed(1)}% > limit ${limitPct.toFixed(0)}% (positions + resting + this push, gross)${scopeSuffix}`,
        observed: ratioPct.toFixed(1),
        limit: limitPct.toFixed(0),
      }
    }

    return {
      gate: GATE_G2,
      result: 'PASS',
      ...(degraded ? { code: 'G2_RESTING_SCOPE_GIT_TRACKED' } : {}),
      reason: `no hard-limit block detected: projected gross exposure ${ratioPct.toFixed(1)}% ≤ limit ${limitPct.toFixed(0)}%${scopeSuffix}`,
      observed: ratioPct.toFixed(1),
      limit: limitPct.toFixed(0),
    }
  },
}
