import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import type { Contract } from '@traderalice/ibkr'
import type { Operation, Position, GitCommit, Quote, AccountInfo, OpenOrder } from '@traderalice/uta-protocol'
import { evaluateRiskGates, type EvaluateRiskGatesArgs, type RiskGateSnapshot } from './evaluator.js'
import type { RiskGatesConfigResolution, RiskGateThresholds } from './config.js'
import { createMemoryRiskGateStateStore, utcDayOf } from './state.js'
import { GATE_G1, GATE_G2, GATE_G3, GATE_G4 } from './index.js'

// ==================== Fixtures ====================

const BASE: RiskGateThresholds = {
  mode: 'enforce',
  maxOrderNotionalAbsUsd: 1000,
  maxOrderNotionalEquityPct: 25,
  maxTotalExposurePct: 100,
  dailyLossLimitPct: 5,
  maxPushesPerHour: 10,
  duplicateWindowSec: 120,
  snapshotMaxAgeSec: 300,
  allowDegradedRestingScope: false,
}

function okConfig(overrides: Partial<RiskGateThresholds> = {}): RiskGatesConfigResolution {
  return {
    status: 'ok',
    source: 'file',
    forAccount: () => ({ ...BASE, ...overrides, source: 'file' }),
  }
}

function contract(aliceId: string): Contract {
  return { aliceId, symbol: aliceId.split('|')[1] ?? 'X', secType: 'CRYPTO', currency: 'USD' } as unknown as Contract
}

function buyOrder(aliceId: string, qty: string, lmtPrice?: string): Operation {
  return {
    action: 'placeOrder',
    contract: contract(aliceId),
    order: { action: 'BUY', orderType: lmtPrice ? 'LMT' : 'MKT', totalQuantity: qty, ...(lmtPrice ? { lmtPrice } : {}) },
  } as unknown as Operation
}

function sellOrder(aliceId: string, qty: string, lmtPrice?: string): Operation {
  return {
    action: 'placeOrder',
    contract: contract(aliceId),
    order: { action: 'SELL', orderType: lmtPrice ? 'LMT' : 'MKT', totalQuantity: qty, ...(lmtPrice ? { lmtPrice } : {}) },
  } as unknown as Operation
}

function position(aliceId: string, side: 'long' | 'short', qty: string, marketValue: string): Position {
  return {
    contract: contract(aliceId),
    currency: 'USD',
    side,
    quantity: new Decimal(qty),
    avgCost: '0',
    marketPrice: '0',
    marketValue,
    unrealizedPnL: '0',
    realizedPnL: '0',
    multiplier: '1',
  } as unknown as Position
}

function account(netLiquidation: string): AccountInfo {
  return { baseCurrency: 'USD', netLiquidation, totalCashValue: netLiquidation, unrealizedPnL: '0' }
}

function snapshot(opts: { equity?: string; positions?: Position[]; resting?: OpenOrder[]; restingScope?: 'all' | 'git-tracked' } = {}): RiskGateSnapshot {
  return {
    positions: opts.positions ?? [],
    account: account(opts.equity ?? '10000'),
    restingOrders: opts.resting ?? [],
    restingScope: opts.restingScope ?? 'all',
  }
}

function executedCommit(op: Operation, agoMs: number, opts: { success?: boolean; now?: Date } = {}): GitCommit {
  const now = opts.now ?? new Date()
  return {
    hash: `h${agoMs}`,
    parentHash: null,
    message: 'test',
    operations: [op],
    results: [{ action: op.action, success: opts.success ?? true, status: opts.success === false ? 'user-rejected' : 'submitted' }],
    stateAfter: { netLiquidation: '0', totalCashValue: '0', unrealizedPnL: '0', realizedPnL: '0', positions: [], pendingOrders: [] },
    timestamp: new Date(now.getTime() - agoMs).toISOString(),
  }
}

function args(overrides: Partial<EvaluateRiskGatesArgs>): EvaluateRiskGatesArgs {
  return {
    accountId: 'test-acct',
    presetId: 'ccxt-custom',
    operations: [],
    history: [],
    trigger: 'push',
    getSnapshot: async () => snapshot(),
    getQuote: async (c) => ({ contract: c, last: '100', bid: '99', ask: '101', volume: '0', timestamp: new Date() }) as Quote,
    getFx: () => undefined,
    loadConfig: async () => okConfig(),
    stateStore: createMemoryRiskGateStateStore(),
    ...overrides,
  }
}

function verdictOf(report: Awaited<ReturnType<typeof evaluateRiskGates>>, gate: string) {
  return report.verdicts.find(v => v.gate === gate)
}

// ==================== Tests ====================

describe('risk-gate evaluator', () => {
  it('mode off → PASS, no verdicts, nothing evaluated', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '999')],
      loadConfig: async () => okConfig({ mode: 'off' }),
      getSnapshot: async () => { throw new Error('must not be called') },
    }))
    expect(report).toMatchObject({ mode: 'off', result: 'PASS', verdicts: [] })
  })

  // ---- G1 ----

  it('G1 blocks an order over the effective cap (quote-priced market order)', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1')], // 1 × $100 quote... use big qty
    }))
    // qty 1 × 100 = $100 ≤ cap 1000 → pass; now the oversized case:
    const big = await evaluateRiskGates(args({ operations: [buyOrder('a|BTC', '50')] })) // $5000
    expect(report.result).toBe('PASS')
    const g1 = verdictOf(big, GATE_G1)
    expect(g1?.result).toBe('BLOCK')
    expect(g1?.observed).toBe('5000.00')
    expect(g1?.limit).toBe('1000.00')
    expect(big.result).toBe('BLOCK')
  })

  it('G1 effective cap is min(abs, pct×equity) — small account tightens the cap', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '9', '100')], // $900 < abs 1000, but 25% × $2000 = $500
      getSnapshot: async () => snapshot({ equity: '2000' }),
    }))
    const g1 = verdictOf(report, GATE_G1)
    expect(g1?.result).toBe('BLOCK')
    expect(g1?.limit).toBe('500.00')
  })

  it('G1 fail-closed: no limit price and no quote → CANNOT_PRICE', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1')],
      getQuote: async () => { throw new Error('feed down') },
    }))
    const g1 = verdictOf(report, GATE_G1)
    expect(g1?.result).toBe('BLOCK')
    expect(g1?.code).toBe('CANNOT_PRICE')
  })

  it('G1 fail-closed: stale quote (older than snapshotMaxAgeSec) → CANNOT_PRICE', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1')],
      getQuote: async (c) => ({ contract: c, last: '100', bid: '99', ask: '101', volume: '0', timestamp: new Date(Date.now() - 3600_000) }) as Quote,
    }))
    expect(verdictOf(report, GATE_G1)?.code).toBe('CANNOT_PRICE')
  })

  it('G1 fail-closed: equity unavailable → EQUITY_UNAVAILABLE (never falls back to abs cap alone)', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      getSnapshot: async () => snapshot({ equity: '' }),
    }))
    expect(verdictOf(report, GATE_G1)?.code).toBe('EQUITY_UNAVAILABLE')
    expect(report.result).toBe('BLOCK')
  })

  it('G1 fail-closed: non-USD instrument with no FX service → FX_UNAVAILABLE', async () => {
    const op = buyOrder('a|BTC', '1', '100')
    ;(op as { contract: { currency: string } }).contract.currency = 'EUR'
    const report = await evaluateRiskGates(args({ operations: [op] }))
    expect(verdictOf(report, GATE_G1)?.code).toBe('FX_UNAVAILABLE')
  })

  // ---- G2 ----

  it('G2 aggregates the WHOLE push — two orders each under G1 combine to blow the cap', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '6', '100'), buyOrder('a|ETH', '6', '100')], // $600 + $600
      getSnapshot: async () => snapshot({ equity: '10000', positions: [position('a|SOL', 'long', '90', '9000')] }),
    }))
    expect(verdictOf(report, GATE_G1)?.result).toBe('PASS')
    const g2 = verdictOf(report, GATE_G2)
    expect(g2?.result).toBe('BLOCK') // 9000 + 1200 = 102% > 100%
    expect(Number(g2?.observed)).toBeCloseTo(102, 0)
  })

  it('G2 counts resting risk-increasing orders in projected exposure', async () => {
    const resting = {
      contract: contract('a|ETH'),
      order: { orderId: 7, action: 'BUY', orderType: 'LMT', totalQuantity: '20', lmtPrice: '100' }, // $2000 resting
      orderState: { status: 'Submitted' },
    } as unknown as OpenOrder
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '5', '100')], // $500
      getSnapshot: async () => snapshot({ equity: '10000', positions: [position('a|SOL', 'long', '80', '8000')], resting: [resting] }),
    }))
    const g2 = verdictOf(report, GATE_G2)
    expect(g2?.result).toBe('BLOCK') // 8000 + 2000 + 500 = 105%
  })

  it('P1 ruling: ENFORCE + degraded resting scope BLOCKS a risk-increasing push', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      getSnapshot: async () => snapshot({ restingScope: 'git-tracked' }),
    }))
    const g2 = verdictOf(report, GATE_G2)
    expect(g2?.result).toBe('BLOCK')
    expect(g2?.code).toBe('G2_RESTING_SCOPE_UNAVAILABLE')
    expect(report.result).toBe('BLOCK')
  })

  it('P1: an explicitly opted-in account gets PASS + the loud annotation instead', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      getSnapshot: async () => snapshot({ restingScope: 'git-tracked' }),
      loadConfig: async () => okConfig({ allowDegradedRestingScope: true }),
    }))
    const g2 = verdictOf(report, GATE_G2)
    expect(g2?.result).toBe('PASS')
    expect(g2?.code).toBe('G2_RESTING_SCOPE_GIT_TRACKED')
    expect(g2?.reason).toContain('true exposure may be higher')
  })

  it('P1: observe mode keeps the annotation (never blocks on scope)', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      getSnapshot: async () => snapshot({ restingScope: 'git-tracked' }),
      loadConfig: async () => okConfig({ mode: 'observe' }),
    }))
    const g2 = verdictOf(report, GATE_G2)
    expect(g2?.result).toBe('PASS')
    expect(g2?.code).toBe('G2_RESTING_SCOPE_GIT_TRACKED')
  })

  it('P0: long 10 + SELL 10 + SELL 10 — the aggregate flip is gated (second sell hits G1)', async () => {
    const report = await evaluateRiskGates(args({
      operations: [sellOrder('a|SOL', '10', '150'), sellOrder('a|SOL', '10', '150')], // $1500 each
      getSnapshot: async () => snapshot({ positions: [position('a|SOL', 'long', '10', '1500')] }),
    }))
    const g1 = verdictOf(report, GATE_G1)
    expect(g1?.result).toBe('BLOCK') // second sell = flip = increasing, $1500 > $1000 cap
    expect(report.result).toBe('BLOCK')

    // Control: a single honest reduce of the same size passes untouched.
    const single = await evaluateRiskGates(args({
      operations: [sellOrder('a|SOL', '10', '150')],
      getSnapshot: async () => snapshot({ positions: [position('a|SOL', 'long', '10', '1500')] }),
    }))
    expect(single.result).toBe('PASS')
  })

  it('G1 prices a stop-modify by auxPrice — no quote needed, no false block', async () => {
    const resting = {
      contract: contract('a|BTC'),
      order: { orderId: 42, action: 'BUY', orderType: 'STP', totalQuantity: '5', auxPrice: '90' },
      orderState: { status: 'Submitted' },
    } as unknown as OpenOrder
    const modify: Operation = {
      action: 'modifyOrder',
      orderId: '42',
      changes: { auxPrice: '95' } as never, // raise the stop trigger — priced at $475
    }
    const report = await evaluateRiskGates(args({
      operations: [modify],
      getSnapshot: async () => snapshot({ resting: [resting] }),
      getQuote: async () => { throw new Error('no quotes available') }, // aux must suffice
    }))
    expect(verdictOf(report, GATE_G1)?.result).toBe('PASS')
    expect(report.result).toBe('PASS')
  })

  it('G2/G1 never block a risk-reducing push — even when exposure is already over the limit', async () => {
    const report = await evaluateRiskGates(args({
      operations: [sellOrder('a|SOL', '50', '100')], // sell half of the long
      getSnapshot: async () => snapshot({ equity: '10000', positions: [position('a|SOL', 'long', '150', '15000')] }),
    }))
    expect(verdictOf(report, GATE_G1)?.result).toBe('NOT_APPLICABLE')
    expect(verdictOf(report, GATE_G2)?.result).toBe('NOT_APPLICABLE')
    expect(report.result).toBe('PASS')
  })

  // ---- G3 ----

  it('G3 reports G3_WOULD_BLOCK on a tripped day but NEVER blocks (forced observe)', async () => {
    const store = createMemoryRiskGateStateStore()
    const now = new Date()
    await store.captureDayAnchor({ dateUtc: utcDayOf(now), startOfDayEquity: '20000', capturedAt: now.toISOString() })
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      getSnapshot: async () => snapshot({ equity: '10000' }), // −50% on the day
      stateStore: store,
    }))
    const g3 = verdictOf(report, GATE_G3)
    expect(g3?.result).toBe('PASS')
    expect(g3?.code).toBe('G3_WOULD_BLOCK')
    expect(report.result).toBe('PASS')
  })

  it('G3 captures the day anchor on push but NOT on preview', async () => {
    const store = createMemoryRiskGateStateStore()
    const now = new Date()
    await evaluateRiskGates(args({ operations: [buyOrder('a|BTC', '1', '100')], stateStore: store, trigger: 'preview' }))
    expect(await store.getDayAnchor(utcDayOf(now))).toBeUndefined()
    await evaluateRiskGates(args({ operations: [buyOrder('a|BTC', '1', '100')], stateStore: store, trigger: 'push' }))
    expect(await store.getDayAnchor(utcDayOf(now))).toMatchObject({ startOfDayEquity: '10000' })
  })

  // ---- G4 ----

  it('G4 rate-limits risk-increasing pushes but exempts reducing ones', async () => {
    const history = [
      executedCommit(buyOrder('a|BTC', '1', '50'), 60_000),
      executedCommit(buyOrder('a|BTC', '2', '50'), 120_000),
    ]
    const blocked = await evaluateRiskGates(args({
      operations: [buyOrder('a|ETH', '1', '100')],
      history,
      loadConfig: async () => okConfig({ maxPushesPerHour: 2 }),
    }))
    expect(verdictOf(blocked, GATE_G4)?.code).toBe('RATE_LIMIT_EXCEEDED')

    const reducing = await evaluateRiskGates(args({
      operations: [{ action: 'closePosition', contract: contract('a|BTC') } as Operation],
      history,
      loadConfig: async () => okConfig({ maxPushesPerHour: 2 }),
    }))
    expect(verdictOf(reducing, GATE_G4)?.code).not.toBe('RATE_LIMIT_EXCEEDED')
    expect(reducing.result).toBe('PASS')
  })

  it('G4 blocks a duplicate intent within the window — "1.0" equals "1"', async () => {
    const history = [executedCommit(buyOrder('a|BTC', '1.0', '100.00'), 30_000)]
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      history,
    }))
    const g4 = verdictOf(report, GATE_G4)
    expect(g4?.result).toBe('BLOCK')
    expect(g4?.code).toBe('DUPLICATE_INTENT')
  })

  it('G4 ignores user-rejected history (those never reached the broker) and stale duplicates', async () => {
    const rejected = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      history: [executedCommit(buyOrder('a|BTC', '1', '100'), 30_000, { success: false })],
    }))
    expect(verdictOf(rejected, GATE_G4)?.result).toBe('PASS')

    const stale = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      history: [executedCommit(buyOrder('a|BTC', '1', '100'), 600_000)], // 10 min > 120s window
    }))
    expect(verdictOf(stale, GATE_G4)?.result).toBe('PASS')
  })

  // ---- Pipeline-level fail-closed paths ----

  it('invalid config: risk-increasing push → BLOCK CONFIG_INVALID, mode forced enforce', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      loadConfig: async () => ({ status: 'invalid', error: 'bad json' }),
    }))
    expect(report).toMatchObject({ mode: 'enforce', result: 'BLOCK', configSource: 'invalid' })
    expect(report.verdicts[0]?.code).toBe('CONFIG_INVALID')
  })

  it('invalid config: provably risk-reducing push → PASS via the reduce-only emergency path', async () => {
    const report = await evaluateRiskGates(args({
      operations: [{ action: 'closePosition', contract: contract('a|BTC') } as Operation],
      loadConfig: async () => ({ status: 'invalid', error: 'bad json' }),
    }))
    expect(report.result).toBe('PASS')
    expect(report.verdicts[0]?.code).toBe('CONFIG_INVALID_REDUCE_ONLY_PATH')
  })

  it('invalid config: closePosition + SELL cannot slip the reduce-only door (P0 ledger)', async () => {
    const report = await evaluateRiskGates(args({
      operations: [
        { action: 'closePosition', contract: contract('a|BTC') } as Operation,
        sellOrder('a|BTC', '10', '100'),
      ],
      loadConfig: async () => ({ status: 'invalid', error: 'bad json' }),
    }))
    expect(report.result).toBe('BLOCK')
    expect(report.verdicts[0]?.code).toBe('CONFIG_INVALID')
  })

  it('snapshot fetch failure → BLOCK STATE_UNAVAILABLE (fail-closed)', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      getSnapshot: async () => { throw new Error('broker down') },
    }))
    expect(report.result).toBe('BLOCK')
    expect(report.verdicts[0]?.code).toBe('STATE_UNAVAILABLE')
  })

  it('a gate that throws becomes a BLOCK PIPELINE_ERROR verdict, never an exception', async () => {
    const report = await evaluateRiskGates(args({
      operations: [buyOrder('a|BTC', '1', '100')],
      gates: [{ name: 'BOOM', evaluate: async () => { throw new Error('kaboom') } }],
    }))
    expect(report.result).toBe('BLOCK')
    expect(report.verdicts[0]).toMatchObject({ gate: 'BOOM', result: 'BLOCK', code: 'PIPELINE_ERROR' })
  })
})
