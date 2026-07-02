/**
 * Order-notional pricing for G1/G2.
 *
 * Notional = qty × contract multiplier × reference price, in the instrument's
 * currency. Reference price preference: explicit limit price → stop/aux
 * price → live quote (subject to the staleness bound enforced by
 * ctx.priceOf). Anything unpriceable is an explicit failure — the consuming
 * gate BLOCKS (fail-closed), it never guesses.
 */

import Decimal from 'decimal.js'
import type { Operation, OpenOrder } from '@traderalice/uta-protocol'
import type { Contract } from '@traderalice/ibkr'
import { decOrUndef } from './decimal-io.js'
import type { QuotePrice } from './types.js'

export type NotionalResult =
  | { ok: true; notional: Decimal; currency: string; pricedBy: 'cashQty' | 'lmtPrice' | 'auxPrice' | 'quote' }
  | { ok: false; reason: string }

function multiplierOf(contract: Contract | undefined): Decimal {
  const m = decOrUndef(contract?.multiplier)
  return m && m.gt(0) ? m : new Decimal(1)
}

export async function operationNotional(
  op: Operation,
  deps: {
    priceOf(contract: Contract): Promise<QuotePrice | null>
    restingOrders: readonly OpenOrder[]
  },
): Promise<NotionalResult> {
  if (op.action === 'placeOrder') {
    const currency = op.contract?.currency || 'USD'
    const cashQty = decOrUndef(op.order?.cashQty)
    const qty = decOrUndef(op.order?.totalQuantity)
    if (cashQty && cashQty.gt(0) && !qty) {
      // Cash-denominated order: the cash amount IS the notional.
      return { ok: true, notional: cashQty, currency, pricedBy: 'cashQty' }
    }
    if (!qty) return { ok: false, reason: 'order has neither totalQuantity nor cashQty' }

    const lmt = decOrUndef(op.order?.lmtPrice)
    const aux = decOrUndef(op.order?.auxPrice)
    const mult = multiplierOf(op.contract)
    if (lmt && lmt.gt(0)) {
      return { ok: true, notional: qty.mul(mult).mul(lmt), currency, pricedBy: 'lmtPrice' }
    }
    if (aux && aux.gt(0)) {
      return { ok: true, notional: qty.mul(mult).mul(aux), currency, pricedBy: 'auxPrice' }
    }
    const quote = op.contract ? await deps.priceOf(op.contract) : null
    if (!quote) return { ok: false, reason: 'cannot price order: no limit/stop price and no fresh quote' }
    return { ok: true, notional: qty.mul(mult).mul(quote.price), currency, pricedBy: 'quote' }
  }

  if (op.action === 'modifyOrder') {
    const resting = deps.restingOrders.find(o => {
      const oid = (o.order as unknown as { orderId?: number | string }).orderId
      return oid !== undefined && String(oid) === op.orderId
    })
    if (!resting) return { ok: false, reason: `cannot price modifyOrder: resting order ${op.orderId} not found` }
    const currency = resting.contract?.currency || 'USD'
    const qty = decOrUndef(op.changes?.totalQuantity) ?? decOrUndef(resting.order?.totalQuantity)
    if (!qty) return { ok: false, reason: 'cannot price modifyOrder: quantity unreadable' }
    const mult = multiplierOf(resting.contract)
    // Same reference-price preference as placeOrder: limit → stop/aux → quote.
    // A stop-modify (auxPrice-only) must be priced by its aux, not a live
    // quote — and must not be false-blocked when no quote is available.
    const lmt = decOrUndef(op.changes?.lmtPrice) ?? decOrUndef(resting.order?.lmtPrice)
    const aux = decOrUndef(op.changes?.auxPrice) ?? decOrUndef(resting.order?.auxPrice)
    if (lmt && lmt.gt(0)) {
      return { ok: true, notional: qty.mul(mult).mul(lmt), currency, pricedBy: 'lmtPrice' }
    }
    if (aux && aux.gt(0)) {
      return { ok: true, notional: qty.mul(mult).mul(aux), currency, pricedBy: 'auxPrice' }
    }
    const quote = resting.contract ? await deps.priceOf(resting.contract) : null
    if (!quote) return { ok: false, reason: 'cannot price modifyOrder: no price reference' }
    return { ok: true, notional: qty.mul(mult).mul(quote.price), currency, pricedBy: 'quote' }
  }

  return { ok: false, reason: `operation ${op.action} is not priceable` }
}

/** Notional of a resting open order (for G2's resting risk-increasing term). */
export async function restingOrderNotional(
  o: OpenOrder,
  priceOf: (contract: Contract) => Promise<QuotePrice | null>,
): Promise<NotionalResult> {
  const currency = o.contract?.currency || 'USD'
  const qty = decOrUndef(o.order?.totalQuantity)
  const cashQty = decOrUndef(o.order?.cashQty)
  if (!qty && cashQty && cashQty.gt(0)) {
    return { ok: true, notional: cashQty, currency, pricedBy: 'cashQty' }
  }
  if (!qty) return { ok: false, reason: 'resting order quantity unreadable' }
  const mult = multiplierOf(o.contract)
  const ref = decOrUndef(o.order?.lmtPrice) ?? decOrUndef(o.order?.auxPrice)
  if (ref && ref.gt(0)) {
    return { ok: true, notional: qty.mul(mult).mul(ref), currency, pricedBy: 'lmtPrice' }
  }
  const quote = o.contract ? await priceOf(o.contract) : null
  if (!quote) return { ok: false, reason: 'cannot price resting order: no fresh quote' }
  return { ok: true, notional: qty.mul(mult).mul(quote.price), currency, pricedBy: 'quote' }
}
