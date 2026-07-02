/**
 * Intent classification — the pinned risk-reducing definition from
 * docs/risk-gate-pipeline-v0.md, shared by G1/G2/G3/G4, the invalid-config
 * emergency path, and (Phase 2) the regime veto.
 *
 * Pinned rules — an operation is risk-REDUCING only if it CANNOT increase
 * exposure under exchange semantics:
 *
 *   closePosition                          → reducing (inherently)
 *   cancelOrder / syncOrders / reconcile   → neutral (cannot increase exposure)
 *   placeOrder SELL against long /
 *     BUY against short, within the        → reducing (provable exposure
 *     remaining reduction ALLOWANCE          decrease)
 *   anything beyond the allowance          → INCREASING, whole order
 *   cashQty-denominated orders             → INCREASING (fill qty unprovable)
 *   modifyOrder                            → INCREASING, except a pure
 *     quantity decrease of a located resting order with no price change
 *   anything unprovable                    → INCREASING (fail-closed)
 *
 * COMMIT-LEVEL LEDGER (the P0 fix): the push is the atomic unit, so
 * "provable exposure decrease" must hold for the COMBINED fill of the whole
 * commit plus orders already resting at the exchange — `long 10 + SELL 10 +
 * SELL 10` is one reduce and one flip, not two reduces. `computeIntentLedger`
 * tracks a per-instrument reduction allowance (worst-case-fills
 * conservative):
 *
 *   allowance = |current position|            (per instrument, on its side)
 *   resting reduce-side orders consume FIRST  (they already sit at the venue)
 *   staged ops consume in staged order
 *   over-allowance → increasing AND allowance := 0   (worst case: flipped)
 *   opposite-side orders never credit the pool       (BUY 5 + SELL 12 on
 *                                                      long 10 ⇒ SELL 12
 *                                                      is increasing)
 *   closePosition consumes its qty (full close ⇒ 0)  (closePosition + SELL
 *                                                      gates the SELL)
 *
 * There is deliberately NO order-type-name exemption: a stop-ENTRY is
 * risk-increasing; only exchange semantics or provable position math count.
 * (No reduceOnly flag exists on stage params — verified against
 * @traderalice/uta-protocol StagePlaceOrderParams.)
 */

import Decimal from 'decimal.js'
import type { Operation, Position, OpenOrder } from '@traderalice/uta-protocol'
import type { Contract } from '@traderalice/ibkr'
import { decOrUndef } from './decimal-io.js'

export type OperationIntent =
  | { kind: 'risk-increasing'; rationale: string }
  | { kind: 'risk-reducing'; provenBy: 'closePosition' | 'exposure-decrease'; rationale: string }
  | { kind: 'neutral'; rationale: string }

export interface IntentLedger {
  /** Index-aligned with the input operations. */
  operationIntents: OperationIntent[]
  /** Index-aligned with the input restingOrders. */
  restingIntents: OperationIntent[]
}

// ==================== Instrument keying / matching ====================

function keyOf(contract: Contract | undefined): string | null {
  if (!contract) return null
  if (contract.aliceId) return contract.aliceId
  if (!contract.symbol) return null
  return `sym:${contract.symbol}:${contract.secType ?? ''}`
}

function contractsMatch(a: Contract | undefined, b: Contract | undefined): boolean {
  if (!a || !b) return false
  if (a.aliceId && b.aliceId) return a.aliceId === b.aliceId
  if (!a.symbol || !b.symbol) return false
  if (a.symbol !== b.symbol) return false
  if (a.secType && b.secType && a.secType !== b.secType) return false
  return true
}

export function findPositionFor(
  contract: Contract | undefined,
  positions: readonly Position[],
): Position | undefined {
  return positions.find(p => contractsMatch(p.contract, contract))
}

/**
 * Broker-native instrument key from a stamped contract — the segment after
 * the first `|` of aliceId (`accountId|nativeKey`). For ccxt this is the
 * unified symbol ("BTC/USDT:USDT"), which is what the regime veto's
 * gatedInstruments allowlist matches against (Contract.symbol is only the
 * BASE, e.g. "BTC" — never use it for instrument identity).
 */
export function nativeKeyOf(contract: Contract | undefined): string | undefined {
  const aliceId = contract?.aliceId
  if (!aliceId) return undefined
  const sep = aliceId.indexOf('|')
  return sep === -1 ? undefined : aliceId.slice(sep + 1)
}

/**
 * The order side an operation would trade at the broker: placeOrder → its
 * own action; modifyOrder → the located resting order's action; everything
 * else has no marketable side.
 */
export function effectiveOrderSide(
  op: Operation,
  restingOrders: readonly OpenOrder[],
): 'BUY' | 'SELL' | undefined {
  if (op.action === 'placeOrder') {
    const side = op.order?.action
    return side === 'BUY' || side === 'SELL' ? side : undefined
  }
  if (op.action === 'modifyOrder') {
    const resting = restingOrders.find(o => {
      const oid = (o.order as unknown as { orderId?: number | string }).orderId
      return oid !== undefined && String(oid) === op.orderId
    })
    const side = resting?.order?.action
    return side === 'BUY' || side === 'SELL' ? side : undefined
  }
  return undefined
}

// ==================== Allowance pool ====================

interface AllowanceEntry {
  side: 'long' | 'short'
  remaining: Decimal
}

function buildAllowance(positions: readonly Position[]): Map<string, AllowanceEntry> {
  const pool = new Map<string, AllowanceEntry>()
  for (const p of positions) {
    const key = keyOf(p.contract)
    const qty = decOrUndef(p.quantity)?.abs()
    if (!key || !qty || !qty.gt(0)) continue
    pool.set(key, { side: p.side, remaining: qty })
  }
  return pool
}

/**
 * Classify a marketable order (staged placeOrder or resting order) against
 * the shared allowance pool, mutating the pool.
 */
function classifyAgainstPool(
  contract: Contract | undefined,
  side: string | undefined,
  qty: Decimal | undefined,
  hasCashQty: boolean,
  pool: Map<string, AllowanceEntry>,
): OperationIntent {
  if (!qty) {
    return {
      kind: 'risk-increasing',
      rationale: hasCashQty
        ? 'cashQty-denominated order: fill quantity unprovable'
        : 'order quantity missing/unreadable (fail-closed)',
    }
  }
  const key = keyOf(contract)
  const entry = key ? pool.get(key) : undefined
  if (!entry || !entry.remaining.gt(0)) {
    return {
      kind: 'risk-increasing',
      rationale: entry
        ? 'reduction allowance for this instrument already consumed by earlier orders in this push/resting set (aggregate flip risk)'
        : 'no existing position on this instrument',
    }
  }
  const reducingSide = entry.side === 'long' ? 'SELL' : 'BUY'
  if (side !== reducingSide) {
    return { kind: 'risk-increasing', rationale: 'adds to existing exposure' }
  }
  if (qty.lte(entry.remaining)) {
    entry.remaining = entry.remaining.minus(qty)
    return {
      kind: 'risk-reducing',
      provenBy: 'exposure-decrease',
      rationale: `${side} ${qty.toFixed()} within remaining ${entry.side} reduction allowance`,
    }
  }
  // Over-allowance: the combined fill could flip the position. Whole order
  // gated, and the pool is zeroed — everything after is increasing too.
  entry.remaining = new Decimal(0)
  return {
    kind: 'risk-increasing',
    rationale: 'order exceeds remaining reduction allowance (aggregate flip) — whole order gated',
  }
}

function classifyModify(
  op: Extract<Operation, { action: 'modifyOrder' }>,
  restingOrders: readonly OpenOrder[],
): OperationIntent {
  const resting = restingOrders.find(o => {
    const oid = (o.order as unknown as { orderId?: number | string }).orderId
    return oid !== undefined && String(oid) === op.orderId
  })
  const newQty = decOrUndef(op.changes?.totalQuantity)
  if (resting && newQty) {
    const currentQty = decOrUndef(resting.order?.totalQuantity)
    const touchesPrice =
      op.changes?.lmtPrice !== undefined ||
      op.changes?.auxPrice !== undefined ||
      op.changes?.trailStopPrice !== undefined ||
      op.changes?.trailingPercent !== undefined
    if (currentQty && newQty.lte(currentQty) && !touchesPrice) {
      return {
        kind: 'risk-reducing',
        provenBy: 'exposure-decrease',
        rationale: `modify lowers qty ${currentQty.toFixed()} → ${newQty.toFixed()}, no price change`,
      }
    }
  }
  return { kind: 'risk-increasing', rationale: 'order modification not provably exposure-decreasing (fail-closed)' }
}

function classifyOperation(
  op: Operation,
  pool: Map<string, AllowanceEntry>,
  restingOrders: readonly OpenOrder[],
): OperationIntent {
  switch (op.action) {
    case 'closePosition': {
      // Inherently reducing — but it consumes the instrument's remaining
      // allowance so a follow-up SELL in the same commit is gated.
      const key = keyOf(op.contract)
      const entry = key ? pool.get(key) : undefined
      if (entry) {
        const qty = decOrUndef(op.quantity)
        entry.remaining = qty ? Decimal.max(0, entry.remaining.minus(qty)) : new Decimal(0)
      }
      return { kind: 'risk-reducing', provenBy: 'closePosition', rationale: 'closePosition cannot increase exposure' }
    }
    case 'cancelOrder':
      return { kind: 'neutral', rationale: 'cancelling a resting order cannot increase exposure' }
    case 'syncOrders':
    case 'reconcileBalance':
      return { kind: 'neutral', rationale: 'bookkeeping operation, no broker order' }
    case 'placeOrder':
      return classifyAgainstPool(
        op.contract,
        op.order?.action,
        decOrUndef(op.order?.totalQuantity),
        decOrUndef(op.order?.cashQty) !== undefined,
        pool,
      )
    case 'modifyOrder':
      return classifyModify(op, restingOrders)
  }
}

// ==================== Public API ====================

/**
 * Commit-level classification — THE canonical entry point for the risk-gate
 * pipeline. The whole pending commit (plus orders already resting at the
 * exchange) shares one reduction-allowance pool per instrument, so combined
 * fills can never smuggle a flip through per-order "reducing" labels.
 */
export function computeIntentLedger(input: {
  positions: readonly Position[]
  restingOrders: readonly OpenOrder[]
  operations: readonly Operation[]
}): IntentLedger {
  const pool = buildAllowance(input.positions)

  // Pass 1 — resting orders consume the pool first: they already sit at the
  // venue and can fill regardless of what this push does.
  const restingIntents = input.restingOrders.map(o =>
    classifyAgainstPool(
      o.contract,
      o.order?.action,
      decOrUndef(o.order?.totalQuantity),
      decOrUndef(o.order?.cashQty) !== undefined,
      pool,
    ),
  )

  // Pass 2 — staged operations in staged order (matches TradingGit.push()).
  const operationIntents = input.operations.map(op =>
    classifyOperation(op, pool, input.restingOrders),
  )

  return { operationIntents, restingIntents }
}

/**
 * Single-operation classification — Phase 2 helper / legacy shape.
 * NOTE: this deliberately ignores sibling operations and does NOT let
 * resting orders consume the allowance (restingOrders is used only for the
 * modifyOrder lookup). The risk-gate evaluator must use
 * `computeIntentLedger` — per-op classification is exactly the P0 hole.
 */
export function classifyOperationIntent(
  op: Operation,
  positions: readonly Position[],
  restingOrders: readonly OpenOrder[] = [],
): OperationIntent {
  const pool = buildAllowance(positions)
  return classifyOperation(op, pool, restingOrders)
}
