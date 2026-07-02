import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import type { Operation, OperationResult, Position, RiskGateStatus } from '@traderalice/uta-protocol'
import type { ResearchCaptureContext, ResearchCaptureEvent } from '../../trading/research-capture.js'
import type { OperationIntent, QuotePrice, RegimeReading } from '../../trading/risk-gates/index.js'
import '../../trading/contract-ext.js'
import { createDecisionRecorder, type DecisionRecorderDeps } from './recorder.js'
import { brakesLedgerPath, decisionsLedgerPath, readBrakesRows, readDecisionsRows } from './ledger.js'
import type { BrakeChildRow, BrakeParentRow, DecisionChildRow, DecisionParentRow } from './types.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'decisions-rec-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

// ==================== Fixtures ====================

const okConfig: DecisionRecorderDeps['loadConfig'] = async () => ({
  status: 'ok',
  source: 'defaults',
  config: {
    enabled: true,
    captureMockAccounts: false,
    marker: { enabled: true, graceHours: 6, fetchPageDays: 1000 },
    funding: { enabled: true },
  },
})

function contract(aliceId: string, symbol: string): Contract {
  const c = new Contract()
  c.symbol = symbol
  c.currency = 'USDT'
  c.aliceId = aliceId
  return c
}

function placeOrder(side: 'BUY' | 'SELL', qty: string, lmt?: string): Operation {
  const order = new Order()
  order.action = side
  order.orderType = lmt !== undefined ? 'LMT' : 'MKT'
  order.totalQuantity = new Decimal(qty)
  if (lmt !== undefined) order.lmtPrice = new Decimal(lmt)
  return { action: 'placeOrder', contract: contract('acct|BTC/USDT:USDT', 'BTC'), order }
}

function passReport(): RiskGateStatus {
  return {
    mode: 'observe', result: 'PASS', evaluatedAt: '2026-07-03T10:00:00.000Z',
    configSource: 'file',
    verdicts: [{ gate: 'G1_MAX_ORDER_NOTIONAL', result: 'PASS', reason: 'within cap' }],
  }
}

function wouldBlockReport(): RiskGateStatus {
  return {
    mode: 'observe', result: 'BLOCK', evaluatedAt: '2026-07-03T10:00:00.000Z',
    configSource: 'file',
    verdicts: [
      { gate: 'G1_MAX_ORDER_NOTIONAL', result: 'PASS', reason: 'within cap' },
      { gate: 'REGIME_VETO', result: 'PASS', code: 'REGIME_WOULD_BLOCK', reason: 'observe downgrade' },
    ],
  }
}

function blockReport(): RiskGateStatus {
  return {
    mode: 'enforce', result: 'BLOCK', evaluatedAt: '2026-07-03T10:00:00.000Z',
    configSource: 'file',
    verdicts: [{ gate: 'G1_MAX_ORDER_NOTIONAL', result: 'BLOCK', reason: 'over cap' }],
  }
}

function ctxOf(args: {
  operations: Operation[]
  intents?: OperationIntent[]
  positions?: Position[]
  quotes?: Map<string, QuotePrice | null>
  presetId?: string
  pendingHash?: string
}): ResearchCaptureContext {
  return {
    accountId: 'acct',
    presetId: args.presetId ?? 'ccxt-custom',
    pendingHash: args.pendingHash ?? 'abcd1234',
    message: 'test push',
    operations: args.operations,
    evaluatedAt: '2026-07-03T10:00:00.000Z',
    ...(args.intents !== undefined ? { intents: args.intents } : {}),
    ...(args.positions !== undefined ? { positions: args.positions } : {}),
    restingOrders: [],
    ...(args.quotes !== undefined ? { quotes: args.quotes } : {}),
  }
}

const increasing: OperationIntent = { kind: 'risk-increasing', rationale: 'new exposure' }
const reducing: OperationIntent = { kind: 'risk-reducing', provenBy: 'exposure-decrease', rationale: 'reduces long' }
const results: OperationResult[] = [{ action: 'placeOrder', success: true, status: 'submitted', orderId: 'o1', filledQty: '1', filledPrice: '60000' }]

function recorder(over: Partial<DecisionRecorderDeps> = {}) {
  return createDecisionRecorder({ loadConfig: okConfig, ledgerDir: dir, ...over })
}

function executedEvt(ctx: ResearchCaptureContext, report: RiskGateStatus): ResearchCaptureEvent {
  return { phase: 'executed', ctx, report, commit: { hash: 'c0ffee00', results } }
}

// ==================== Core capture ====================

describe('decision recorder — executed pushes', () => {
  it('writes parent + per-intent children; BUY entry → LONG, execution index-aligned', async () => {
    const ctx = ctxOf({ operations: [placeOrder('BUY', '1', '60000')], intents: [increasing] })
    const outcome = await recorder().capture(executedEvt(ctx, passReport()))
    expect(outcome).toBe('written')
    const rows = await readDecisionsRows(decisionsLedgerPath('acct', dir))
    expect(rows).toHaveLength(2)
    const parent = rows[0] as DecisionParentRow
    expect(parent.kind).toBe('push')
    expect(parent.id).toBe('dec:acct:abcd1234')
    expect(parent.override).toBe(false)
    expect(parent.overrideReason).toBeNull()
    expect(parent.commitHash).toBe('c0ffee00')
    expect(parent.results).toEqual({ submitted: 1, rejected: 0 })
    const child = rows[1] as DecisionChildRow
    expect(child.id).toBe('dec:acct:abcd1234#0')
    expect(child.role).toBe('entry')
    expect(child.side).toBe('LONG')
    expect(child.markSide).toBe('LONG')
    expect(child.markSideMeaning).toBe('entry')
    expect(child.nativeKey).toBe('BTC/USDT:USDT')
    expect(child.pricedBy).toBe('lmtPrice')
    expect(child.notional).toBe('60000')
    expect(child.execution?.orderId).toBe('o1')
    expect(child.context.funding.bucket).toBe('unavailable')
  })

  it('SELL entry → SHORT; SELL-reduce-long → role=exit, NO entry side, markSide=LONG forgone-exposure', async () => {
    const longPos = { contract: contract('acct|BTC/USDT:USDT', 'BTC'), side: 'long', quantity: '2' } as unknown as Position
    const ctx = ctxOf({
      operations: [placeOrder('SELL', '1', '60000'), placeOrder('SELL', '1', '60000')],
      intents: [increasing, reducing],
      positions: [longPos],
    })
    await recorder().capture(executedEvt(ctx, passReport()))
    const rows = await readDecisionsRows(decisionsLedgerPath('acct', dir))
    const c0 = rows[1] as DecisionChildRow
    const c1 = rows[2] as DecisionChildRow
    expect(c0.role).toBe('entry')
    expect(c0.side).toBe('SHORT')
    expect(c1.role).toBe('exit')
    expect(c1.side).toBeUndefined() // SELL-to-reduce is NOT a SHORT (pinned)
    expect(c1.markSide).toBe('LONG')
    expect(c1.markSideMeaning).toBe('forgone-exposure')
  })

  it('BUY-cover-short → exit with markSide=SHORT; cancel → neutral, no markSide, pricedBy n/a', async () => {
    const shortPos = { contract: contract('acct|BTC/USDT:USDT', 'BTC'), side: 'short', quantity: '2' } as unknown as Position
    const ctx = ctxOf({
      operations: [placeOrder('BUY', '1', '60000'), { action: 'cancelOrder', orderId: 'x1' }],
      intents: [reducing, { kind: 'neutral', rationale: 'cancel' }],
      positions: [shortPos],
    })
    await recorder().capture(executedEvt(ctx, passReport()))
    const rows = await readDecisionsRows(decisionsLedgerPath('acct', dir))
    const cover = rows[1] as DecisionChildRow
    expect(cover.role).toBe('exit')
    expect(cover.markSide).toBe('SHORT')
    expect(cover.markSideMeaning).toBe('forgone-exposure')
    const cancel = rows[2] as DecisionChildRow
    expect(cancel.role).toBe('neutral')
    expect(cancel.markSide).toBeUndefined()
    expect(cancel.pricedBy).toBe('n/a')
  })

  it('missing intents → unclassified role, no side cells', async () => {
    const ctx = ctxOf({ operations: [placeOrder('BUY', '1', '60000')] }) // no intents
    await recorder().capture(executedEvt(ctx, passReport()))
    const rows = await readDecisionsRows(decisionsLedgerPath('acct', dir))
    const child = rows[1] as DecisionChildRow
    expect(child.intent.kind).toBe('unclassified')
    expect(child.role).toBe('unclassified')
    expect(child.side).toBeUndefined()
  })

  it('pricedBy quote (from the gates\' quote map, with age) and unpriced (no price anywhere)', async () => {
    const quotes = new Map<string, QuotePrice | null>([
      ['acct|BTC/USDT:USDT', { price: new Decimal('61000'), ageSec: 3 }],
    ])
    const ctx = ctxOf({ operations: [placeOrder('BUY', '1')], intents: [increasing], quotes })
    await recorder().capture(executedEvt(ctx, passReport()))
    let child = (await readDecisionsRows(decisionsLedgerPath('acct', dir)))[1] as DecisionChildRow
    expect(child.pricedBy).toBe('quote')
    expect(child.notional).toBe('61000')
    expect(child.priceAgeSec).toBe(3)

    const ctx2 = ctxOf({ operations: [placeOrder('BUY', '1')], intents: [increasing], pendingHash: 'ffff0000' })
    await recorder().capture(executedEvt(ctx2, passReport()))
    const rows = await readDecisionsRows(decisionsLedgerPath('acct', dir))
    child = rows[rows.length - 1] as DecisionChildRow
    expect(child.pricedBy).toBe('unpriced')
    expect(child.unpricedReason).toBeTruthy()
  })

  it('dedup: the same push captured twice writes one family', async () => {
    const ctx = ctxOf({ operations: [placeOrder('BUY', '1', '60000')], intents: [increasing] })
    const r = recorder()
    await r.capture(executedEvt(ctx, passReport()))
    const second = await r.capture(executedEvt(ctx, passReport()))
    expect(second).toBe('skipped-duplicate')
    expect(await readDecisionsRows(decisionsLedgerPath('acct', dir))).toHaveLength(2)
  })
})

// ==================== Override + brake dispositions ====================

describe('decision recorder — brake ledger dispositions', () => {
  const ctx = () => ctxOf({ operations: [placeOrder('SELL', '1', '60000')], intents: [increasing] })

  it('executed with WOULD_BLOCK codes → decision parent override:true AND overridden brake family', async () => {
    await recorder().capture(executedEvt(ctx(), wouldBlockReport()))
    const dec = await readDecisionsRows(decisionsLedgerPath('acct', dir))
    expect((dec[0] as DecisionParentRow).override).toBe(true)
    const brakes = await readBrakesRows(brakesLedgerPath('acct', dir))
    expect(brakes).toHaveLength(2)
    const parent = brakes[0] as BrakeParentRow
    expect(parent.disposition).toBe('overridden')
    expect(parent.blockingGates).toEqual(['REGIME_VETO'])
    expect((brakes[1] as BrakeChildRow).baseline).toBe('flat')
  })

  it('blocked (enforce BLOCK) → brake family with disposition blocked; no decision rows', async () => {
    await recorder().capture({ phase: 'blocked', ctx: ctx(), report: blockReport() })
    expect(await readDecisionsRows(decisionsLedgerPath('acct', dir))).toHaveLength(0)
    const brakes = await readBrakesRows(brakesLedgerPath('acct', dir))
    expect((brakes[0] as BrakeParentRow).disposition).toBe('blocked')
  })

  it('rejected with brake content → rejected family with reportAgeMs + reason', async () => {
    await recorder().capture({ phase: 'rejected', ctx: ctx(), report: wouldBlockReport(), reportAgeMs: 4200, reason: 'too risky' })
    const brakes = await readBrakesRows(brakesLedgerPath('acct', dir))
    const parent = brakes[0] as BrakeParentRow
    expect(parent.disposition).toBe('rejected')
    expect(parent.reportAgeMsAtCapture).toBe(4200)
    expect(parent.rejectReason).toBe('too risky')
  })

  it('IRON RULE 2: a clean-PASS reject writes NOTHING to the brake ledger', async () => {
    const outcome = await recorder().capture({ phase: 'rejected', ctx: ctx(), report: passReport(), reportAgeMs: 100 })
    expect(outcome).toBe('skipped-no-brake-content')
    expect(await readBrakesRows(brakesLedgerPath('acct', dir))).toHaveLength(0)
  })

  it('blocked then (after config change) executed under the SAME pendingHash → two families, distinct ids', async () => {
    const r = recorder()
    await r.capture({ phase: 'blocked', ctx: ctx(), report: blockReport() })
    await r.capture(executedEvt(ctx(), passReport()))
    const brakes = await readBrakesRows(brakesLedgerPath('acct', dir))
    const dec = await readDecisionsRows(decisionsLedgerPath('acct', dir))
    expect((brakes[0] as BrakeParentRow).id).toBe('brk:acct:abcd1234:blocked')
    expect((dec[0] as DecisionParentRow).id).toBe('dec:acct:abcd1234')
  })
})

// ==================== Regime context (iron rule 1) ====================

describe('decision recorder — regime context is peek-only', () => {
  const ctx = () => ctxOf({ operations: [placeOrder('BUY', '1', '60000')], intents: [increasing] })

  it('cache-empty peek → UNKNOWN live, capture succeeds without delay', async () => {
    await recorder({ peekRegime: () => undefined }).capture(executedEvt(ctx(), passReport()))
    const child = (await readDecisionsRows(decisionsLedgerPath('acct', dir)))[1] as DecisionChildRow
    expect(child.context.regime).toEqual({
      zone: 'UNKNOWN', contextSource: 'live',
      reason: 'regime context unavailable at capture time',
    })
  })

  it('cache-hit peek → zone recorded on a clean LONG push (not only shorts)', async () => {
    const reading: RegimeReading = { zone: 'BEAR', close: '60000', sma200: '75000', computedFrom: '2026-07-02T00:00:00.000Z' }
    await recorder({ peekRegime: () => reading }).capture(executedEvt(ctx(), passReport()))
    const child = (await readDecisionsRows(decisionsLedgerPath('acct', dir)))[1] as DecisionChildRow
    expect(child.context.regime.zone).toBe('BEAR')
    expect(child.context.regime.contextSource).toBe('live')
  })

  it('a THROWING peek never hurts capture', async () => {
    const outcome = await recorder({ peekRegime: () => { throw new Error('boom') } }).capture(executedEvt(ctx(), passReport()))
    expect(outcome).toBe('written')
  })
})

// ==================== Refusals ====================

describe('decision recorder — refusal policy', () => {
  const ctx = (preset?: string) => ctxOf({ operations: [placeOrder('BUY', '1', '60000')], intents: [increasing], ...(preset !== undefined ? { presetId: preset } : {}) })

  it('mock-simulator pushes are skipped by default', async () => {
    const outcome = await recorder().capture(executedEvt(ctx('mock-simulator'), passReport()))
    expect(outcome).toBe('skipped-mock')
    expect(await readDecisionsRows(decisionsLedgerPath('acct', dir))).toHaveLength(0)
  })

  it('cloud-synced (OneDrive) ledger dir → no-op refusal', async () => {
    const cloudDir = join(dir, 'OneDrive', 'evidence')
    const outcome = await createDecisionRecorder({ loadConfig: okConfig, ledgerDir: cloudDir })
      .capture(executedEvt(ctx(), passReport()))
    expect(outcome).toBe('skipped-cloud-synced')
  })

  it('invalid config → refusal; disabled → refusal', async () => {
    const invalid = await createDecisionRecorder({
      loadConfig: async () => ({ status: 'invalid', error: 'bad json' }), ledgerDir: dir,
    }).capture(executedEvt(ctx(), passReport()))
    expect(invalid).toBe('skipped-config-invalid')

    const disabled = await createDecisionRecorder({
      loadConfig: async () => ({
        status: 'ok', source: 'file',
        config: { enabled: false, captureMockAccounts: false, marker: { enabled: true, graceHours: 6, fetchPageDays: 1000 }, funding: { enabled: true } },
      }),
      ledgerDir: dir,
    }).capture(executedEvt(ctx(), passReport()))
    expect(disabled).toBe('skipped-disabled')
  })

  it('an internal failure degrades to a warned "failed" outcome, never a throw', async () => {
    // Ledger dir path under a regular FILE → append fails.
    const broken = createDecisionRecorder({ loadConfig: okConfig, ledgerDir: join(dir, 'blocker', 'nested') })
    const { writeFile } = await import('fs/promises')
    await writeFile(join(dir, 'blocker'), 'a file, not a dir')
    const outcome = await broken.capture(executedEvt(ctx(), passReport()))
    expect(outcome).toBe('failed')
  })
})
