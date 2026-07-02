import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import type { Operation, Quote } from '@traderalice/uta-protocol'
import '../contract-ext.js'
import { evaluateRiskGates, evaluateRiskGatesDetailed, type EvaluateRiskGatesArgs, type RiskGateSnapshot } from './evaluator.js'
import { createMemoryRiskGateStateStore } from './state.js'
import type { RiskGatesConfigResolution, RiskGateThresholds } from './config.js'

const THRESHOLDS: RiskGateThresholds = {
  mode: 'observe',
  maxOrderNotionalAbsUsd: 1000,
  maxOrderNotionalEquityPct: 25,
  maxTotalExposurePct: 100,
  dailyLossLimitPct: 5,
  maxPushesPerHour: 10,
  duplicateWindowSec: 120,
  snapshotMaxAgeSec: 300,
  allowDegradedRestingScope: false,
  regimeVeto: {
    mode: 'off',
    gatedInstruments: [],
    regimeSource: { venue: 'binance_spot', symbol: 'BTCUSDT' },
    regimeStaleAfterHours: 30,
    spec: 'regime-risk-gate-v0@70eb587',
  },
}

function op(): Operation {
  const contract = new Contract()
  contract.symbol = 'AAPL'
  contract.currency = 'USD'
  contract.aliceId = 'a|AAPL'
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'LMT'
  order.totalQuantity = new Decimal(1)
  order.lmtPrice = new Decimal(150)
  return { action: 'placeOrder', contract, order }
}

function args(over: Partial<EvaluateRiskGatesArgs> = {}): EvaluateRiskGatesArgs {
  const snapshot: RiskGateSnapshot = {
    positions: [],
    account: { netLiquidation: '100000', totalCashValue: '100000', unrealizedPnL: '0', realizedPnL: '0', baseCurrency: 'USD' } as RiskGateSnapshot['account'],
    restingOrders: [],
    restingScope: 'all',
  }
  return {
    accountId: 'a',
    presetId: 'test',
    operations: [op()],
    history: [],
    trigger: 'push',
    getSnapshot: async () => snapshot,
    getQuote: async () => ({ last: '150', timestamp: new Date() } as unknown as Quote),
    getFx: () => undefined,
    loadConfig: async (): Promise<RiskGatesConfigResolution> => ({
      status: 'ok', source: 'file', forAccount: () => ({ ...THRESHOLDS, source: 'file' }),
    }),
    stateStore: createMemoryRiskGateStateStore(),
    ...over,
  }
}

describe('evaluateRiskGatesDetailed (Track D pass-through)', () => {
  it('full run: detail carries index-aligned intents, the snapshot, and the quote cache; wrapper report is identical', async () => {
    const a = args()
    const detail = await evaluateRiskGatesDetailed(a)
    expect(detail.report.result).toBe('PASS')
    expect(detail.intents).toHaveLength(1)
    expect(detail.intents![0].kind).toBe('risk-increasing')
    expect(detail.restingIntents).toEqual([])
    expect(detail.snapshot?.restingScope).toBe('all')
    expect(detail.quotes).toBeDefined()

    const report = await evaluateRiskGates(args())
    expect(report.result).toBe(detail.report.result)
    expect(report.verdicts.map(v => v.gate)).toEqual(detail.report.verdicts.map(v => v.gate))
  })

  it('early paths (mode off / invalid config / snapshot failure) return NO detail fields — absence, never guesses', async () => {
    const off = await evaluateRiskGatesDetailed(args({
      loadConfig: async () => ({ status: 'ok', source: 'file', forAccount: () => ({ ...THRESHOLDS, mode: 'off', source: 'file' }) }),
    }))
    expect(off.report.mode).toBe('off')
    expect(off.intents).toBeUndefined()
    expect(off.snapshot).toBeUndefined()

    const invalid = await evaluateRiskGatesDetailed(args({
      loadConfig: async () => ({ status: 'invalid', error: 'bad json' }),
    }))
    expect(invalid.report.configSource).toBe('invalid')
    expect(invalid.intents).toBeUndefined()

    const noSnap = await evaluateRiskGatesDetailed(args({
      getSnapshot: async () => { throw new Error('broker down') },
    }))
    expect(noSnap.report.result).toBe('BLOCK')
    expect(noSnap.report.verdicts[0].code).toBe('STATE_UNAVAILABLE')
    expect(noSnap.intents).toBeUndefined()
  })
})
