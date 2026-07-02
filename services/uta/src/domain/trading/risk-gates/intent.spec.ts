import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import type { Contract } from '@traderalice/ibkr'
import type { Operation, Position, OpenOrder } from '@traderalice/uta-protocol'
import { classifyOperationIntent, computeIntentLedger } from './intent.js'

function contract(aliceId: string, symbol = aliceId.split('|')[1] ?? 'X'): Contract {
  return { aliceId, symbol, secType: 'CRYPTO', currency: 'USD' } as unknown as Contract
}

function placeOrder(opts: {
  aliceId: string
  side: 'BUY' | 'SELL'
  qty?: string
  cashQty?: string
  orderType?: string
  lmtPrice?: string
}): Operation {
  return {
    action: 'placeOrder',
    contract: contract(opts.aliceId),
    order: {
      action: opts.side,
      orderType: opts.orderType ?? 'MKT',
      ...(opts.qty !== undefined ? { totalQuantity: opts.qty } : {}),
      ...(opts.cashQty !== undefined ? { cashQty: opts.cashQty } : {}),
      ...(opts.lmtPrice !== undefined ? { lmtPrice: opts.lmtPrice } : {}),
    },
  } as unknown as Operation
}

function position(aliceId: string, side: 'long' | 'short', qty: string): Position {
  return {
    contract: contract(aliceId),
    currency: 'USD',
    side,
    quantity: new Decimal(qty),
    avgCost: '100',
    marketPrice: '100',
    marketValue: new Decimal(qty).mul(100).toString(),
    unrealizedPnL: '0',
    realizedPnL: '0',
    multiplier: '1',
  } as unknown as Position
}

const LONG_10 = [position('acct|BTC', 'long', '10')]
const SHORT_10 = [position('acct|BTC', 'short', '10')]

describe('classifyOperationIntent (pinned risk-reducing definition)', () => {
  it('closePosition is inherently risk-reducing', () => {
    const op: Operation = { action: 'closePosition', contract: contract('acct|BTC') }
    expect(classifyOperationIntent(op, [])).toMatchObject({ kind: 'risk-reducing', provenBy: 'closePosition' })
  })

  it('cancelOrder / syncOrders / reconcileBalance are neutral', () => {
    expect(classifyOperationIntent({ action: 'cancelOrder', orderId: '1' }, []).kind).toBe('neutral')
    expect(classifyOperationIntent({ action: 'syncOrders' }, []).kind).toBe('neutral')
    expect(classifyOperationIntent(
      { action: 'reconcileBalance', aliceId: 'acct|BTC', quantityDelta: '1', markPrice: '1' }, [],
    ).kind).toBe('neutral')
  })

  it('SELL ≤ existing long is a provable exposure decrease', () => {
    const op = placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '10' })
    expect(classifyOperationIntent(op, LONG_10)).toMatchObject({ kind: 'risk-reducing', provenBy: 'exposure-decrease' })
  })

  it('partial close (SELL 4 of long 10) is risk-reducing', () => {
    const op = placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '4' })
    expect(classifyOperationIntent(op, LONG_10).kind).toBe('risk-reducing')
  })

  it('BUY ≤ existing short (cover) is risk-reducing', () => {
    const op = placeOrder({ aliceId: 'acct|BTC', side: 'BUY', qty: '10' })
    expect(classifyOperationIntent(op, SHORT_10).kind).toBe('risk-reducing')
  })

  it('flip (SELL 15 against long 10) gates the WHOLE order as increasing', () => {
    const op = placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '15' })
    const intent = classifyOperationIntent(op, LONG_10)
    expect(intent.kind).toBe('risk-increasing')
    expect(intent.rationale).toContain('flip')
  })

  it('BUY with no position is risk-increasing', () => {
    const op = placeOrder({ aliceId: 'acct|ETH', side: 'BUY', qty: '1' })
    expect(classifyOperationIntent(op, LONG_10).kind).toBe('risk-increasing')
  })

  it('a stop-ENTRY gets no exemption from its order type name', () => {
    const op = placeOrder({ aliceId: 'acct|ETH', side: 'BUY', qty: '1', orderType: 'STP' })
    expect(classifyOperationIntent(op, []).kind).toBe('risk-increasing')
  })

  it('cashQty-denominated orders are increasing (fill qty unprovable)', () => {
    const op = placeOrder({ aliceId: 'acct|BTC', side: 'SELL', cashQty: '100' })
    const intent = classifyOperationIntent(op, LONG_10)
    expect(intent.kind).toBe('risk-increasing')
    expect(intent.rationale).toContain('cashQty')
  })

  it('SELL matching a DIFFERENT instrument long is increasing (aliceId match, not vibes)', () => {
    const op = placeOrder({ aliceId: 'acct|ETH', side: 'SELL', qty: '5' })
    expect(classifyOperationIntent(op, LONG_10).kind).toBe('risk-increasing')
  })

  it('modifyOrder is increasing by default (fail-closed)', () => {
    const op: Operation = { action: 'modifyOrder', orderId: '42', changes: { } as never }
    expect(classifyOperationIntent(op, LONG_10).kind).toBe('risk-increasing')
  })

  it('modifyOrder that only lowers qty of a located resting order is reducing', () => {
    const resting = {
      contract: contract('acct|BTC'),
      order: { orderId: 42, action: 'BUY', orderType: 'LMT', totalQuantity: '5', lmtPrice: '90' },
      orderState: { status: 'Submitted' },
    } as unknown as OpenOrder
    const op: Operation = { action: 'modifyOrder', orderId: '42', changes: { totalQuantity: '2' } as never }
    expect(classifyOperationIntent(op, [], [resting]).kind).toBe('risk-reducing')
  })

  it('modifyOrder lowering qty but touching price stays increasing', () => {
    const resting = {
      contract: contract('acct|BTC'),
      order: { orderId: 42, action: 'BUY', orderType: 'LMT', totalQuantity: '5', lmtPrice: '90' },
      orderState: { status: 'Submitted' },
    } as unknown as OpenOrder
    const op: Operation = { action: 'modifyOrder', orderId: '42', changes: { totalQuantity: '2', lmtPrice: '95' } as never }
    expect(classifyOperationIntent(op, [], [resting]).kind).toBe('risk-increasing')
  })
})

// ==================== Commit-level ledger (the P0 aggregate-flip fix) ====================

function restingSell(aliceId: string, qty: string): OpenOrder {
  return {
    contract: contract(aliceId),
    order: { action: 'SELL', orderType: 'LMT', totalQuantity: qty, lmtPrice: '100' },
    orderState: { status: 'Submitted' },
  } as unknown as OpenOrder
}

describe('computeIntentLedger (commit is the atomic unit)', () => {
  it('P0: long 10 + SELL 10 + SELL 10 — the second sell is a flip, not a reduce', () => {
    const { operationIntents } = computeIntentLedger({
      positions: LONG_10,
      restingOrders: [],
      operations: [
        placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '10' }),
        placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '10' }),
      ],
    })
    expect(operationIntents[0].kind).toBe('risk-reducing')
    expect(operationIntents[1].kind).toBe('risk-increasing')
  })

  it('partial overflow: SELL 6 + SELL 6 on long 10 — second exceeds the remaining 4', () => {
    const { operationIntents } = computeIntentLedger({
      positions: LONG_10,
      restingOrders: [],
      operations: [
        placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '6' }),
        placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '6' }),
      ],
    })
    expect(operationIntents[0].kind).toBe('risk-reducing')
    expect(operationIntents[1].kind).toBe('risk-increasing')
  })

  it('closePosition consumes the allowance — a follow-up SELL is gated', () => {
    const { operationIntents } = computeIntentLedger({
      positions: LONG_10,
      restingOrders: [],
      operations: [
        { action: 'closePosition', contract: contract('acct|BTC') } as Operation,
        placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '5' }),
      ],
    })
    expect(operationIntents[0].kind).toBe('risk-reducing')
    expect(operationIntents[1].kind).toBe('risk-increasing')
  })

  it('resting reduce orders consume the pool FIRST — a staged sell of the same size flips', () => {
    const { restingIntents, operationIntents } = computeIntentLedger({
      positions: LONG_10,
      restingOrders: [restingSell('acct|BTC', '10')],
      operations: [placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '10' })],
    })
    expect(restingIntents[0].kind).toBe('risk-reducing')
    expect(operationIntents[0].kind).toBe('risk-increasing')
  })

  it('opposite-side ops never credit the pool: BUY 5 + SELL 12 on long 10 → both increasing', () => {
    const { operationIntents } = computeIntentLedger({
      positions: LONG_10,
      restingOrders: [],
      operations: [
        placeOrder({ aliceId: 'acct|BTC', side: 'BUY', qty: '5' }),
        placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '12' }),
      ],
    })
    expect(operationIntents[0].kind).toBe('risk-increasing')
    expect(operationIntents[1].kind).toBe('risk-increasing')
  })

  it('independent instruments have independent pools', () => {
    const { operationIntents } = computeIntentLedger({
      positions: [...LONG_10, position('acct|ETH', 'long', '3')],
      restingOrders: [],
      operations: [
        placeOrder({ aliceId: 'acct|BTC', side: 'SELL', qty: '10' }),
        placeOrder({ aliceId: 'acct|ETH', side: 'SELL', qty: '3' }),
      ],
    })
    expect(operationIntents[0].kind).toBe('risk-reducing')
    expect(operationIntents[1].kind).toBe('risk-reducing')
  })
})
