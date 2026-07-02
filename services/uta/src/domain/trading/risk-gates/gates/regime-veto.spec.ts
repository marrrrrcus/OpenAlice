import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'
import type { Contract } from '@traderalice/ibkr'
import type { Operation, Position, Quote, AccountInfo } from '@traderalice/uta-protocol'
import { evaluateRiskGates, type EvaluateRiskGatesArgs, type RiskGateSnapshot } from '../evaluator.js'
import type { RiskGatesConfigResolution, RiskGateThresholds, RegimeVetoConfig } from '../config.js'
import { createMemoryRiskGateStateStore } from '../state.js'
import { GATE_REGIME } from './regime-veto.js'
import type { RegimeReading } from '../regime/provider.js'

// ==================== Fixtures ====================

const RV_OFF: RegimeVetoConfig = {
  mode: 'off',
  gatedInstruments: ['BTC'],
  regimeSource: { venue: 'binance_spot', symbol: 'BTCUSDT' },
  regimeStaleAfterHours: 30,
  spec: 'regime-risk-gate-v0@70eb587',
}

const BASE: RiskGateThresholds = {
  mode: 'enforce',
  maxOrderNotionalAbsUsd: 100_000,
  maxOrderNotionalEquityPct: 100,
  maxTotalExposurePct: 1000,
  dailyLossLimitPct: 5,
  maxPushesPerHour: 100,
  duplicateWindowSec: 120,
  snapshotMaxAgeSec: 300,
  allowDegradedRestingScope: false,
  regimeVeto: RV_OFF,
}

function cfgWith(rv: Partial<RegimeVetoConfig>): RiskGatesConfigResolution {
  return {
    status: 'ok',
    source: 'file',
    forAccount: () => ({ ...BASE, regimeVeto: { ...RV_OFF, ...rv }, source: 'file' }),
  }
}

function contract(aliceId: string): Contract {
  return { aliceId, symbol: aliceId.split('|')[1] ?? 'X', secType: 'CRYPTO', currency: 'USD' } as unknown as Contract
}

function order(aliceId: string, side: 'BUY' | 'SELL', qty: string, lmtPrice = '100'): Operation {
  return {
    action: 'placeOrder',
    contract: contract(aliceId),
    order: { action: side, orderType: 'LMT', totalQuantity: qty, lmtPrice },
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

const ACCOUNT: AccountInfo = { baseCurrency: 'USD', netLiquidation: '100000', totalCashValue: '100000', unrealizedPnL: '0' }

function snapshot(positions: Position[] = []): RiskGateSnapshot {
  return { positions, account: ACCOUNT, restingOrders: [], restingScope: 'all' }
}

function reading(zone: RegimeReading['zone']): RegimeReading {
  return zone === 'UNKNOWN'
    ? { zone, reason: 'test outage' }
    : { zone, close: '110000', sma200: '100000', computedFrom: new Date().toISOString(), dataAgeHours: 6 }
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
    loadConfig: async () => cfgWith({ mode: 'enforce' }),
    stateStore: createMemoryRiskGateStateStore(),
    ...overrides,
  }
}

function regimeVerdict(report: Awaited<ReturnType<typeof evaluateRiskGates>>) {
  return report.verdicts.find(v => v.gate === GATE_REGIME)
}

const SHORT_BTC = order('a|BTC', 'SELL', '1') // no position → short-increasing

// ==================== Decision table ====================

describe('REGIME_VETO decision table', () => {
  it('BULL + enforce → BLOCK (the validated veto, verbatim wording)', async () => {
    const report = await evaluateRiskGates(args({
      operations: [SHORT_BTC],
      getRegimeReading: async () => reading('BULL'),
    }))
    const v = regimeVerdict(report)
    expect(v?.result).toBe('BLOCK')
    expect(v?.code).toBe('REGIME_BULL_SHORT_VETO')
    expect(v?.reason).toContain('does not endorse longs')
    expect(report.result).toBe('BLOCK')
  })

  it('UNKNOWN (stale/missing data) → BLOCK — UNKNOWN is not SAFE', async () => {
    const report = await evaluateRiskGates(args({
      operations: [SHORT_BTC],
      getRegimeReading: async () => reading('UNKNOWN'),
    }))
    const v = regimeVerdict(report)
    expect(v?.result).toBe('BLOCK')
    expect(v?.code).toBe('REGIME_UNKNOWN')
  })

  it('a THROWING regime reader degrades to UNKNOWN → BLOCK (fail-closed)', async () => {
    const report = await evaluateRiskGates(args({
      operations: [SHORT_BTC],
      getRegimeReading: async () => { throw new Error('provider exploded') },
    }))
    expect(regimeVerdict(report)?.code).toBe('REGIME_UNKNOWN')
    expect(report.result).toBe('BLOCK')
  })

  it('BEAR → PASS + honest non-endorsement wording', async () => {
    const report = await evaluateRiskGates(args({
      operations: [SHORT_BTC],
      getRegimeReading: async () => reading('BEAR'),
    }))
    const v = regimeVerdict(report)
    expect(v?.result).toBe('PASS')
    expect(v?.code).toBe('REGIME_NO_MACRO_BLOCK')
    expect(v?.reason).toContain('not an endorsement')
    expect(report.result).toBe('PASS')
  })

  it('GRAY → PASS + no-auto-veto annotation', async () => {
    const report = await evaluateRiskGates(args({
      operations: [SHORT_BTC],
      getRegimeReading: async () => reading('GRAY'),
    }))
    expect(regimeVerdict(report)?.code).toBe('REGIME_GRAY_NO_AUTO_VETO')
  })

  it('observe mode downgrades a would-BLOCK to PASS + REGIME_WOULD_BLOCK — even in an enforcing pipeline', async () => {
    const report = await evaluateRiskGates(args({
      operations: [SHORT_BTC],
      loadConfig: async () => cfgWith({ mode: 'observe' }), // pipeline stays enforce (BASE.mode)
      getRegimeReading: async () => reading('BULL'),
    }))
    const v = regimeVerdict(report)
    expect(v?.result).toBe('PASS')
    expect(v?.code).toBe('REGIME_WOULD_BLOCK')
    expect(report.result).toBe('PASS') // the observing regime gate cannot block the push
  })

  it('mode off → NOT_APPLICABLE and the regime reader is NEVER called', async () => {
    const spy = vi.fn(async () => reading('BULL'))
    const report = await evaluateRiskGates(args({
      operations: [SHORT_BTC],
      loadConfig: async () => cfgWith({ mode: 'off' }),
      getRegimeReading: spy,
    }))
    expect(regimeVerdict(report)?.result).toBe('NOT_APPLICABLE')
    expect(spy).not.toHaveBeenCalled()
  })
})

// ==================== Scoping ====================

describe('REGIME_VETO scoping', () => {
  it('LONG intents are never evaluated (no fetch, quiet NOT_APPLICABLE)', async () => {
    const spy = vi.fn(async () => reading('BULL'))
    const report = await evaluateRiskGates(args({
      operations: [order('a|BTC', 'BUY', '1')],
      getRegimeReading: spy,
    }))
    const v = regimeVerdict(report)
    expect(v?.result).toBe('NOT_APPLICABLE')
    expect(v?.code).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it('an ETH short is untouched by the BTC gate — even during a BTC data outage', async () => {
    const spy = vi.fn(async () => reading('UNKNOWN'))
    const report = await evaluateRiskGates(args({
      operations: [order('a|ETH', 'SELL', '1')],
      getRegimeReading: spy,
    }))
    const v = regimeVerdict(report)
    expect(v?.result).toBe('NOT_APPLICABLE')
    expect(v?.code).toBe('REGIME_GATE_NOT_VALIDATED')
    expect(v?.reason).toContain('never generalized')
    expect(spy).not.toHaveBeenCalled() // no gated candidate ⇒ no fetch at all
    expect(report.result).toBe('PASS')
  })

  it('a reduce-only SELL (≤ long) is exempt — the veto never blocks getting OUT', async () => {
    const spy = vi.fn(async () => reading('BULL'))
    const report = await evaluateRiskGates(args({
      operations: [order('a|BTC', 'SELL', '5')],
      getSnapshot: async () => snapshot([position('a|BTC', 'long', '10')]),
      getRegimeReading: spy,
    }))
    expect(regimeVerdict(report)?.result).toBe('NOT_APPLICABLE')
    expect(spy).not.toHaveBeenCalled()
    expect(report.result).toBe('PASS')
  })

  it('a flip SELL (beyond the long) IS gated — the excess opens a short', async () => {
    const report = await evaluateRiskGates(args({
      operations: [order('a|BTC', 'SELL', '15')],
      getSnapshot: async () => snapshot([position('a|BTC', 'long', '10')]),
      getRegimeReading: async () => reading('BULL'),
    }))
    expect(regimeVerdict(report)?.result).toBe('BLOCK')
  })
})
