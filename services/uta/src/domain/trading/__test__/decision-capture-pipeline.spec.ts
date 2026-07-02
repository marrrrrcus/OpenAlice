/**
 * Track D capture integration — real UnifiedTradingAccount + MockBroker +
 * real decision recorder on a temp ledger dir.
 *
 * Proves the two iron rules end-to-end:
 *   1. the evidence pipeline never affects the trading pipeline (a
 *      throwing sink changes nothing about push/409/reject);
 *   2. nothing without brake content enters the brake ledger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MockBroker } from '../brokers/mock/index.js'
import { UnifiedTradingAccount } from '../UnifiedTradingAccount.js'
import { RiskGateBlockedError, createMemoryRiskGateStateStore } from '../risk-gates/index.js'
import type { RiskGatesConfigResolution, RiskGateThresholds } from '../risk-gates/index.js'
import { createDecisionRecorder } from '../../research/decisions/index.js'
import {
  brakesLedgerPath,
  decisionsLedgerPath,
  readBrakesRows,
  readDecisionsRows,
} from '../../research/decisions/ledger.js'
import type { BrakeParentRow, DecisionChildRow, DecisionParentRow } from '../../research/decisions/types.js'
import type { ResearchCaptureEvent } from '../research-capture.js'

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
    mode: 'off',
    gatedInstruments: ['AAPL'],
    regimeSource: { venue: 'binance_spot', symbol: 'BTCUSDT' },
    regimeStaleAfterHours: 30,
    spec: 'regime-risk-gate-v0@70eb587',
  },
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'capture-int-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const decisionsConfig = async () => ({
  status: 'ok' as const, source: 'defaults' as const,
  config: {
    enabled: true, captureMockAccounts: false,
    marker: { enabled: true, graceHours: 6, fetchPageDays: 1000 },
    funding: { enabled: true },
  },
})

function makeAccount(configRef: { current: RiskGateThresholds }, sink?: (evt: ResearchCaptureEvent) => Promise<void>) {
  const broker = new MockBroker({ cash: 100_000 })
  broker.setQuote('AAPL', 150)
  const loadConfig = async (): Promise<RiskGatesConfigResolution> => ({
    status: 'ok', source: 'file',
    forAccount: () => ({ ...configRef.current, source: 'file' }),
  })
  const recorder = createDecisionRecorder({ loadConfig: decisionsConfig, ledgerDir: dir })
  const uta = new UnifiedTradingAccount(broker, {
    riskGates: {
      presetId: 'test-live', // NOT mock-simulator — captures must not be filtered
      loadConfig,
      stateStore: createMemoryRiskGateStateStore(),
    },
    onResearchCapture: sink ?? (async (evt) => { await recorder.capture(evt) }),
  })
  return { broker, uta }
}

const acctId = () => 'mock-paper' // MockBroker id
const stage = (uta: UnifiedTradingAccount, qty: string) =>
  uta.stagePlaceOrder({ aliceId: 'mock-paper|AAPL', symbol: 'AAPL', action: 'BUY', orderType: 'MKT', totalQuantity: qty })

describe('Track D capture through the real push/reject paths', () => {
  let configRef: { current: RiskGateThresholds }
  beforeEach(() => { configRef = { current: { ...BASE, mode: 'observe' } } })

  it('clean executed push → decision parent + children with execution results; brake ledger untouched', async () => {
    const { uta } = makeAccount(configRef)
    await uta.waitForConnect()
    stage(uta, '2') // $300 — within every gate
    uta.commit('small buy')
    const pendingHash = uta.status().pendingHash!
    await uta.push()

    const rows = await readDecisionsRows(decisionsLedgerPath(uta.id, dir))
    expect(rows).toHaveLength(2)
    const parent = rows[0] as DecisionParentRow
    expect(parent.id).toBe(`dec:${acctId()}:${pendingHash}`)
    expect(parent.override).toBe(false)
    expect(parent.message).toBe('small buy')
    expect(parent.results.submitted).toBe(1)
    const child = rows[1] as DecisionChildRow
    expect(child.role).toBe('entry')
    expect(child.side).toBe('LONG')
    expect(child.execution?.success).toBe(true)
    expect(await readBrakesRows(brakesLedgerPath(uta.id, dir))).toHaveLength(0)
  })

  it('enforce BLOCK → brake "blocked" family captured, pending intact, broker untouched; config raise → re-push shares the pendingHash', async () => {
    configRef.current = { ...BASE } // enforce
    const { broker, uta } = makeAccount(configRef)
    await uta.waitForConnect()
    stage(uta, '10') // $1500 > $1000 cap
    uta.commit('oversized')
    const pendingHash = uta.status().pendingHash!

    await expect(uta.push()).rejects.toThrow(RiskGateBlockedError)
    expect(await broker.getPositions()).toHaveLength(0)
    expect(uta.status().pendingHash).toBe(pendingHash)

    const brakes = await readBrakesRows(brakesLedgerPath(uta.id, dir))
    expect(brakes).toHaveLength(2)
    const brakeParent = brakes[0] as BrakeParentRow
    expect(brakeParent.disposition).toBe('blocked')
    expect(brakeParent.id).toBe(`brk:${acctId()}:${pendingHash}:blocked`)
    expect(brakeParent.blockingGates).toContain('G1_MAX_ORDER_NOTIONAL')

    configRef.current = { ...BASE, maxOrderNotionalAbsUsd: 5000 }
    await uta.push()
    const dec = await readDecisionsRows(decisionsLedgerPath(uta.id, dir))
    expect((dec[0] as DecisionParentRow).pendingHash).toBe(pendingHash) // same commit, two ledgers, one hash
  })

  it('observe push with BLOCK verdicts executes → decision override:true + brake "overridden"', async () => {
    const { broker, uta } = makeAccount(configRef) // observe
    await uta.waitForConnect()
    stage(uta, '10') // would-block under enforce
    uta.commit('override me')
    await uta.push()
    expect(await broker.getPositions()).toHaveLength(1)

    const dec = await readDecisionsRows(decisionsLedgerPath(uta.id, dir))
    expect((dec[0] as DecisionParentRow).override).toBe(true)
    const brakes = await readBrakesRows(brakesLedgerPath(uta.id, dir))
    expect((brakes[0] as BrakeParentRow).disposition).toBe('overridden')
  })

  it('preview → reject(reason) with brake content → brake "rejected" with reason + report age', async () => {
    const { uta } = makeAccount(configRef) // observe
    await uta.waitForConnect()
    stage(uta, '10')
    uta.commit('shown then declined')
    await uta.previewRiskGates() // the human was shown the verdict
    await uta.reject('too risky')

    const brakes = await readBrakesRows(brakesLedgerPath(uta.id, dir))
    expect(brakes.length).toBeGreaterThanOrEqual(2)
    const parent = brakes[0] as BrakeParentRow
    expect(parent.disposition).toBe('rejected')
    expect(parent.rejectReason).toBe('too risky')
    expect(parent.reportAgeMsAtCapture).toBeGreaterThanOrEqual(0)
  })

  it('IRON RULE 2 end-to-end: clean-PASS preview → reject → brake ledger stays empty', async () => {
    const { uta } = makeAccount(configRef)
    await uta.waitForConnect()
    stage(uta, '2') // clean
    uta.commit('clean but declined')
    await uta.previewRiskGates()
    await uta.reject('changed my mind')
    expect(await readBrakesRows(brakesLedgerPath(uta.id, dir))).toHaveLength(0)
  })

  it('reject WITHOUT any preview → nothing captured (nothing was shown)', async () => {
    const { uta } = makeAccount(configRef)
    await uta.waitForConnect()
    stage(uta, '10')
    uta.commit('never shown')
    await uta.reject()
    expect(await readBrakesRows(brakesLedgerPath(uta.id, dir))).toHaveLength(0)
  })

  it('IRON RULE 1: a THROWING sink changes nothing — BLOCK still throws, push completes, reject succeeds', async () => {
    const throwing = async () => { throw new Error('recorder exploded') }

    // (a) enforce BLOCK still surfaces as RiskGateBlockedError.
    configRef.current = { ...BASE }
    const a = makeAccount(configRef, throwing)
    await a.uta.waitForConnect()
    stage(a.uta, '10')
    a.uta.commit('blocked anyway')
    await expect(a.uta.push()).rejects.toThrow(RiskGateBlockedError)

    // (b) a clean push completes.
    configRef.current = { ...BASE, mode: 'observe' }
    const b = makeAccount(configRef, throwing)
    await b.uta.waitForConnect()
    stage(b.uta, '2')
    b.uta.commit('executes anyway')
    const result = await b.uta.push()
    expect(result.submitted).toHaveLength(1)

    // (c) reject succeeds after a preview.
    const c = makeAccount(configRef, throwing)
    await c.uta.waitForConnect()
    stage(c.uta, '10')
    c.uta.commit('rejected anyway')
    await c.uta.previewRiskGates()
    const rejected = await c.uta.reject('no')
    expect(rejected.operationCount).toBe(1)
  })
})
