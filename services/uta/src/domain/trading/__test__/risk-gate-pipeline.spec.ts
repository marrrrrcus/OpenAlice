/**
 * Risk-gate pipeline integration — real UnifiedTradingAccount + MockBroker.
 *
 * Proves the spec's atomicity contract end-to-end: a BLOCK at push time
 * sends NOTHING to the broker and leaves the pending commit intact
 * (re-approvable after a config change), across both single- and multi-op
 * commits; observe mode surfaces the same verdicts without blocking.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import { MockBroker } from '../brokers/mock/index.js'
import { UnifiedTradingAccount } from '../UnifiedTradingAccount.js'
import { RiskGateBlockedError, createMemoryRiskGateStateStore } from '../risk-gates/index.js'
import type { RiskGatesConfigResolution, RiskGateThresholds } from '../risk-gates/index.js'
import type { RiskGateStatus } from '@traderalice/uta-protocol'

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
  regimeVeto: {
    mode: 'off', // enabled per-test below
    gatedInstruments: ['AAPL'], // MockBroker nativeKey = ticker
    regimeSource: { venue: 'binance_spot', symbol: 'BTCUSDT' },
    regimeStaleAfterHours: 30,
    spec: 'regime-risk-gate-v0@70eb587',
  },
}

function makeAccount(
  configRef: { current: RiskGateThresholds },
  opts: { getRegimeReading?: () => Promise<import('../risk-gates/index.js').RegimeReading> } = {},
) {
  const broker = new MockBroker({ cash: 100_000 })
  broker.setQuote('AAPL', 150)
  const reports: Array<{ report: RiskGateStatus; meta: { trigger: string; enforced: boolean } }> = []
  const loadConfig = async (): Promise<RiskGatesConfigResolution> => ({
    status: 'ok',
    source: 'file',
    forAccount: () => ({ ...configRef.current, source: 'file' }),
  })
  const uta = new UnifiedTradingAccount(broker, {
    riskGates: {
      presetId: 'mock-simulator',
      loadConfig,
      stateStore: createMemoryRiskGateStateStore(),
      onReport: (report, meta) => { reports.push({ report, meta }) },
      ...(opts.getRegimeReading ? { getRegimeReading: opts.getRegimeReading } : {}),
    },
  })
  return { broker, uta, reports }
}

describe('risk-gate pipeline through UnifiedTradingAccount.push()', () => {
  let configRef: { current: RiskGateThresholds }

  beforeEach(() => {
    configRef = { current: { ...BASE } }
  })

  it('BLOCK: nothing reaches the broker, pending commit intact; config raise → re-push executes', async () => {
    const { broker, uta } = makeAccount(configRef)
    await uta.waitForConnect()

    // $1500 notional > $1000 cap
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: '10' })
    uta.commit('buy 10 AAPL')
    const pendingBefore = uta.status().pendingHash
    expect(pendingBefore).toBeTruthy()

    await expect(uta.push()).rejects.toThrow(RiskGateBlockedError)

    // Atomicity: broker untouched, pending commit fully intact.
    expect(await broker.getPositions()).toHaveLength(0)
    const after = uta.status()
    expect(after.pendingHash).toBe(pendingBefore)
    expect(after.pendingMessage).toBe('buy 10 AAPL')

    // Config change (the only override path) → same commit re-approved.
    configRef.current = { ...BASE, maxOrderNotionalAbsUsd: 5000 }
    const result = await uta.push()
    expect(result.submitted).toHaveLength(1)
    expect(await broker.getPositions()).toHaveLength(1)
  })

  it('multi-op atomicity: a compliant op1 is NOT executed when op2 blocks the push', async () => {
    const { broker, uta } = makeAccount(configRef)
    await uta.waitForConnect()

    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: '1' })   // $150 fine
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: '100' }) // $15k blocked
    uta.commit('two orders, one oversized')

    await expect(uta.push()).rejects.toThrow(RiskGateBlockedError)
    expect(await broker.getPositions()).toHaveLength(0) // op1 must not have slipped through
    expect(uta.status().pendingMessage).toBe('two orders, one oversized')
  })

  it('the blocked error carries the structured report (gate + observed vs limit facts)', async () => {
    const { uta } = makeAccount(configRef)
    await uta.waitForConnect()
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: '10' })
    uta.commit('m')
    const err = await uta.push().catch(e => e as RiskGateBlockedError)
    expect(err).toBeInstanceOf(RiskGateBlockedError)
    const report = (err as RiskGateBlockedError).report
    expect(report.mode).toBe('enforce')
    expect(report.result).toBe('BLOCK')
    expect(report.verdicts.some(v => v.gate === 'G1_MAX_ORDER_NOTIONAL' && v.result === 'BLOCK')).toBe(true)
  })

  it('observe mode: identical verdicts surfaced via onReport, but the push executes', async () => {
    configRef.current = { ...BASE, mode: 'observe' }
    const { broker, uta, reports } = makeAccount(configRef)
    await uta.waitForConnect()

    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: '10' })
    uta.commit('observe: oversized')
    const result = await uta.push()
    expect(result.submitted).toHaveLength(1)
    expect(await broker.getPositions()).toHaveLength(1)

    const pushReport = reports.find(r => r.meta.trigger === 'push')
    expect(pushReport?.report.result).toBe('BLOCK')
    expect(pushReport?.meta.enforced).toBe(false)
  })

  it('G4 duplicate: re-staging an identical executed order within the window blocks the second push', async () => {
    const { uta } = makeAccount(configRef)
    await uta.waitForConnect()

    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'LMT', totalQuantity: '2', lmtPrice: '100' })
    uta.commit('first')
    await uta.push() // executes ($200 ≤ caps)

    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'LMT', totalQuantity: '2.0', lmtPrice: '100.00' })
    uta.commit('broker-timeout re-stage (same intent, new hash)')
    const err = await uta.push().catch(e => e as RiskGateBlockedError)
    expect(err).toBeInstanceOf(RiskGateBlockedError)
    const g4 = (err as RiskGateBlockedError).report.verdicts.find(v => v.gate === 'G4_RATE_DUPLICATE')
    expect(g4?.code).toBe('DUPLICATE_INTENT')
  })

  it('G2 counts EXCHANGE-SIDE resting orders (placed outside Alice) via getOpenOrders', async () => {
    configRef.current = { ...BASE, maxOrderNotionalAbsUsd: 5000, maxTotalExposurePct: 5 } // limit = $5000
    const { broker, uta } = makeAccount(configRef)
    await uta.waitForConnect()

    // A manual/exchange-side resting LMT order Alice never staged: $3000.
    const manualContract = new Contract()
    manualContract.symbol = 'AAPL'
    manualContract.secType = 'STK'
    manualContract.currency = 'USD'
    const manualOrder = new Order()
    manualOrder.action = 'BUY'
    manualOrder.orderType = 'LMT'
    manualOrder.totalQuantity = new Decimal('20')
    manualOrder.lmtPrice = new Decimal('150')
    await broker.placeOrder(manualContract, manualOrder)

    // This push alone is $3000 ≤ $5000 — it blocks ONLY if the manual
    // resting order is being counted ($3000 + $3000 > $5000).
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'LMT', totalQuantity: '20', lmtPrice: '150' })
    uta.commit('push on top of manual resting order')
    const err = await uta.push().catch(e => e as RiskGateBlockedError)
    expect(err).toBeInstanceOf(RiskGateBlockedError)
    const g2 = (err as RiskGateBlockedError).report.verdicts.find(v => v.gate === 'G2_MAX_TOTAL_EXPOSURE')
    expect(g2?.result).toBe('BLOCK')
    expect(g2?.reason).not.toContain('git-tracked') // full-scope enumeration, no degraded annotation
  })

  it('getOpenOrders failure under ENFORCE blocks the increasing push (P1 ruling)', async () => {
    const { broker, uta } = makeAccount(configRef)
    await uta.waitForConnect()
    Object.assign(broker, { getOpenOrders: async () => { throw new Error('exchange enumeration down') } })

    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'LMT', totalQuantity: '1', lmtPrice: '100' })
    uta.commit('small order under degraded scope')
    const report = await uta.previewRiskGates()
    const g2 = report?.verdicts.find(v => v.gate === 'G2_MAX_TOTAL_EXPOSURE')
    expect(g2?.result).toBe('BLOCK')
    expect(g2?.code).toBe('G2_RESTING_SCOPE_UNAVAILABLE')
  })

  it('opted-in account under degraded scope gets PASS + the loud annotation', async () => {
    configRef.current = { ...BASE, allowDegradedRestingScope: true }
    const { broker, uta } = makeAccount(configRef)
    await uta.waitForConnect()
    Object.assign(broker, { getOpenOrders: async () => { throw new Error('exchange enumeration down') } })

    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'LMT', totalQuantity: '1', lmtPrice: '100' })
    uta.commit('opted-in degraded scope')
    const report = await uta.previewRiskGates()
    const g2 = report?.verdicts.find(v => v.gate === 'G2_MAX_TOTAL_EXPOSURE')
    expect(g2?.result).toBe('PASS')
    expect(g2?.code).toBe('G2_RESTING_SCOPE_GIT_TRACKED')
    expect(g2?.reason).toContain('true exposure may be higher')
  })

  it('P0: long 10 + SELL 10 + SELL 10 in one commit is blocked; an honest single reduce passes', async () => {
    // Setup: acquire the long with a temporarily raised cap.
    configRef.current = { ...BASE, maxOrderNotionalAbsUsd: 5000 }
    const { broker, uta } = makeAccount(configRef)
    await uta.waitForConnect()
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: '10' })
    uta.commit('acquire long 10')
    await uta.push()
    expect(await broker.getPositions()).toHaveLength(1)

    // Tighten the cap back: a $1500 INCREASING order must be gated.
    configRef.current = { ...BASE } // abs cap $1000

    // Two sells: first is a true reduce (exempt), second is the flip.
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'SELL', orderType: 'MKT', totalQuantity: '10' })
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'SELL', orderType: 'MKT', totalQuantity: '10' })
    uta.commit('double sell — aggregate flip')
    const err = await uta.push().catch(e => e as RiskGateBlockedError)
    expect(err).toBeInstanceOf(RiskGateBlockedError)
    const g1 = (err as RiskGateBlockedError).report.verdicts.find(v => v.gate === 'G1_MAX_ORDER_NOTIONAL')
    expect(g1?.result).toBe('BLOCK')
    // Nothing executed: the long is still 10.
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].quantity.toNumber()).toBe(10)

    // Control: a single honest reduce of the full size passes untouched.
    await uta.reject('drop the flip attempt')
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'SELL', orderType: 'MKT', totalQuantity: '10' })
    uta.commit('honest full close')
    const result = await uta.push()
    expect(result.submitted).toHaveLength(1)
    expect(await broker.getPositions()).toHaveLength(0)
  })

  it('an async onReport rejection never affects the push (audit failure is swallowed, awaited)', async () => {
    configRef.current = { ...BASE, mode: 'observe' }
    const broker = new MockBroker({ cash: 100_000 })
    broker.setQuote('AAPL', 150)
    const uta = new UnifiedTradingAccount(broker, {
      riskGates: {
        presetId: 'mock-simulator',
        loadConfig: async () => ({ status: 'ok', source: 'file', forAccount: () => ({ ...configRef.current, source: 'file' }) }),
        stateStore: createMemoryRiskGateStateStore(),
        onReport: async () => { throw new Error('audit sink down') },
      },
    })
    await uta.waitForConnect()
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: '1' })
    uta.commit('audit sink failure must not matter')
    const result = await uta.push() // must not throw / no unhandled rejection
    expect(result.submitted).toHaveLength(1)
  })

  it('Phase 2 end-to-end: SHORT in BULL is blocked; the same short in BEAR executes', async () => {
    configRef.current = {
      ...BASE,
      regimeVeto: { ...BASE.regimeVeto, mode: 'enforce' }, // gatedInstruments: ['AAPL']
    }
    let zone: 'BULL' | 'BEAR' = 'BULL'
    const { broker, uta } = makeAccount(configRef, {
      getRegimeReading: async () => ({
        zone,
        close: '110',
        sma200: '100',
        computedFrom: new Date().toISOString(),
        dataAgeHours: 6,
      }),
    })
    await uta.waitForConnect()

    // Short-open (SELL, no position) on the gated instrument in BULL → BLOCK.
    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'SELL', orderType: 'LMT', totalQuantity: '2', lmtPrice: '150' })
    uta.commit('short into a bull regime')
    const err = await uta.push().catch(e => e as RiskGateBlockedError)
    expect(err).toBeInstanceOf(RiskGateBlockedError)
    const v = (err as RiskGateBlockedError).report.verdicts.find(x => x.gate === 'REGIME_VETO')
    expect(v?.result).toBe('BLOCK')
    expect(v?.code).toBe('REGIME_BULL_SHORT_VETO')
    expect(await broker.getPositions()).toHaveLength(0)
    expect(uta.status().pendingMessage).toBe('short into a bull regime') // intact

    // Same pending commit, regime flips to BEAR → the veto passes (with the
    // non-endorsement annotation) and the push executes.
    zone = 'BEAR'
    const result = await uta.push()
    expect(result.submitted).toHaveLength(1)
  })

  it('previewRiskGates: returns the report without writing G3 state, and caches by pendingHash', async () => {
    const store = createMemoryRiskGateStateStore()
    const broker = new MockBroker({ cash: 100_000 })
    broker.setQuote('AAPL', 150)
    const uta = new UnifiedTradingAccount(broker, {
      riskGates: {
        presetId: 'mock-simulator',
        loadConfig: async () => ({ status: 'ok', source: 'file', forAccount: () => ({ ...configRef.current, source: 'file' }) }),
        stateStore: store,
      },
    })
    await uta.waitForConnect()

    expect(await uta.previewRiskGates()).toBeUndefined() // nothing pending

    uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: '10' })
    uta.commit('preview me')
    const first = await uta.previewRiskGates()
    expect(first?.result).toBe('BLOCK')
    // preview must not have captured the G3 day anchor
    const today = new Date().toISOString().slice(0, 10)
    expect(await store.getDayAnchor(today)).toBeUndefined()
    // cached: same object for the same pendingHash within TTL
    const second = await uta.previewRiskGates()
    expect(second).toBe(first)
  })
})
