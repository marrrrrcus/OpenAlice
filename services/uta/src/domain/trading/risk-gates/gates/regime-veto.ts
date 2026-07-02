/**
 * REGIME_VETO — Phase 2 gate wiring EXACTLY ONE validated rule
 * (docs/regime-veto-onboarding-v0.md; validation: regime-risk-gate-v0 @
 * 70eb587): SHORT in BULL → BLOCK.
 *
 * Decision table (pinned):
 *   regimeVeto.mode off                → NOT_APPLICABLE (quiet)
 *   op not short-increasing            → NOT_APPLICABLE (quiet)
 *   instrument ∉ gatedInstruments      → NOT_APPLICABLE + REGIME_GATE_NOT_VALIDATED
 *   zone BULL                          → BLOCK (the validated veto)
 *   zone UNKNOWN (stale/missing data)  → BLOCK (UNKNOWN is not SAFE)
 *   zone GRAY                          → PASS + REGIME_GRAY_NO_AUTO_VETO
 *   zone BEAR                          → PASS + REGIME_NO_MACRO_BLOCK
 *
 * LONG intents get ZERO behavior here (the LONG-side veto was NOT
 * validated). A BTC data outage never gates any other instrument. The gate
 * has its OWN mode: observe converts would-BLOCKs into loud
 * PASS + REGIME_WOULD_BLOCK annotations so an observing regime gate can
 * never block a pipeline that is otherwise enforcing.
 *
 * Language discipline (verbatim from the onboarding spec): BEAR/GRAY passes
 * never read as endorsement; "no macro block" ≠ "macro supports this short".
 */

import type { GateVerdict } from '@traderalice/uta-protocol'
import type { Contract } from '@traderalice/ibkr'
import type { RiskGate, RiskGateContext } from '../types.js'
import { effectiveOrderSide, nativeKeyOf } from '../intent.js'
import type { RegimeReading } from '../regime/provider.js'

export const GATE_REGIME = 'REGIME_VETO'

export function regimeMarketDataKey(symbol: string): string {
  return `regime:${symbol}`
}

type IntentProbe = Pick<RiskGateContext, 'operations' | 'intents' | 'restingOrders'>

/** Contract an operation would trade (modifyOrder → the located resting order's). */
function contractOf(ctx: IntentProbe, opIndex: number): Contract | undefined {
  const op = ctx.operations[opIndex]
  if (op.action === 'placeOrder' || op.action === 'closePosition') return op.contract
  if (op.action === 'modifyOrder') {
    const resting = ctx.restingOrders.find(o => {
      const oid = (o.order as unknown as { orderId?: number | string }).orderId
      return oid !== undefined && String(oid) === op.orderId
    })
    return resting?.contract
  }
  return undefined
}

/** Index list of short-increasing operations (risk-increasing AND effective SELL). */
export function shortIncreasingIndices(ctx: IntentProbe): number[] {
  const out: number[] = []
  for (let i = 0; i < ctx.operations.length; i++) {
    if (ctx.intents[i]?.kind !== 'risk-increasing') continue
    if (effectiveOrderSide(ctx.operations[i], ctx.restingOrders) !== 'SELL') continue
    out.push(i)
  }
  return out
}

/**
 * Does this push contain a short-increasing op on a gated instrument?
 * Used by the evaluator to decide whether the regime reading is needed at
 * all (lazy prefetch — ~1 Binance call per UTC day, and none for pushes the
 * veto can never touch).
 */
export function hasGatedShortIncreasing(
  probe: IntentProbe,
  cfg: { gatedInstruments: string[] },
): boolean {
  return shortIncreasingIndices(probe).some(i => {
    const key = nativeKeyOf(contractOf(probe, i))
    return key !== undefined && cfg.gatedInstruments.includes(key)
  })
}

export const regimeVeto: RiskGate = {
  name: GATE_REGIME,

  async evaluate(ctx: RiskGateContext): Promise<GateVerdict> {
    const cfg = ctx.config.regimeVeto
    if (!cfg || cfg.mode === 'off') {
      return { gate: GATE_REGIME, result: 'NOT_APPLICABLE', reason: 'regime veto is off' }
    }

    const shortIdx = shortIncreasingIndices(ctx)
    if (shortIdx.length === 0) {
      return {
        gate: GATE_REGIME,
        result: 'NOT_APPLICABLE',
        reason: 'no short-increasing orders in this push (LONG intents are never evaluated by this gate)',
      }
    }

    const gated = shortIdx.filter(i => {
      const key = nativeKeyOf(contractOf(ctx, i))
      return key !== undefined && cfg.gatedInstruments.includes(key)
    })
    if (gated.length === 0) {
      const firstKey = nativeKeyOf(contractOf(ctx, shortIdx[0])) ?? 'this instrument'
      return {
        gate: GATE_REGIME,
        result: 'NOT_APPLICABLE',
        code: 'REGIME_GATE_NOT_VALIDATED',
        reason: `no validated regime gate for ${firstKey} — the SHORT-in-BULL veto is validated for ${cfg.gatedInstruments.join(', ')} only (never generalized)`,
      }
    }

    const datum = ctx.marketData?.get(regimeMarketDataKey(cfg.regimeSource.symbol))
    const reading = (datum?.value as RegimeReading | undefined) ?? { zone: 'UNKNOWN' as const, reason: 'regime reading unavailable' }

    const observe = cfg.mode === 'observe'
    const blockAs = (code: string, reason: string, extra?: Partial<GateVerdict>): GateVerdict =>
      observe
        ? { gate: GATE_REGIME, result: 'PASS', code: 'REGIME_WOULD_BLOCK', reason: `OBSERVE — would block: ${reason}`, ...extra }
        : { gate: GATE_REGIME, result: 'BLOCK', code, reason, ...extra }

    switch (reading.zone) {
      case 'BULL':
        return blockAs(
          'REGIME_BULL_SHORT_VETO',
          `BTC is above SMA200+3% (BULL regime). Short-side bull-regime veto — validated by ${cfg.spec}. This blocks the trade; it does not endorse longs.`,
          reading.close && reading.sma200 ? { observed: reading.close, limit: reading.sma200 } : undefined,
        )
      case 'UNKNOWN':
        return blockAs(
          'REGIME_UNKNOWN',
          `Regime UNKNOWN — market data stale or unavailable (${reading.reason ?? 'no reading'}), the validated veto cannot be evaluated. Short-increasing order blocked (UNKNOWN is not SAFE).`,
        )
      case 'GRAY':
        return {
          gate: GATE_REGIME,
          result: 'PASS',
          code: 'REGIME_GRAY_NO_AUTO_VETO',
          reason: 'Regime ambiguous (within ±3% of SMA200). No automatic veto; judgement is yours.',
        }
      case 'BEAR':
        return {
          gate: GATE_REGIME,
          result: 'PASS',
          code: 'REGIME_NO_MACRO_BLOCK',
          reason: 'No macro-regime block detected. This is not an endorsement; the short still requires your confirmation.',
        }
    }
  },
}
