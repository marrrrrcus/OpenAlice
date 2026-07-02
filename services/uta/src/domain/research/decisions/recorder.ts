/**
 * Track D decision recorder — ALL capture policy lives here
 * (docs/human-decision-ledger-v0.md): disposition mapping, override
 * detection, side/role/markSide derivation, notional provenance, dedup,
 * mock filtering, cloud-sync refusal. The UTA is a dumb emitter.
 *
 * Iron rules (pinned in review):
 *  1. The evidence pipeline must never affect the trading pipeline — this
 *     module does no network I/O at capture time (regime context comes
 *     from a synchronous cache-only peek; prices come from the quote map
 *     the gates already fetched), and every internal failure degrades to a
 *     warn + 'failed' outcome, never a throw into the caller's swallow.
 *  2. Nothing without brake content ever enters the brake ledger — a
 *     clean-PASS reject records nothing.
 */

import type { Contract } from '@traderalice/ibkr'
import type { OpenOrder, Operation, OperationResult, RiskGateStatus } from '@traderalice/uta-protocol'
import type { ResearchCaptureContext, ResearchCaptureEvent } from '../../trading/research-capture.js'
import {
  decOrUndef,
  effectiveOrderSide,
  findPositionFor,
  nativeKeyOf,
  operationNotional,
  type QuotePrice,
  type RegimeReading,
} from '../../trading/risk-gates/index.js'
import { isCloudSyncedPath } from '../cloud-sync.js'
import {
  appendRow,
  brakesLedgerPath,
  decisionsDir,
  decisionsLedgerPath,
  readBrakesRows,
  readDecisionsRows,
} from './ledger.js'
import type { ResearchDecisionsConfigResolution } from './config.js'
import type {
  BrakeChildRow,
  BrakeDisposition,
  BrakeParentRow,
  DecisionChildRow,
  DecisionParentRow,
  EntrySide,
  GateSummary,
  IntentRole,
  RegimeContext,
} from './types.js'

export type CaptureOutcome =
  | 'written'
  | 'skipped-duplicate'
  | 'skipped-disabled'
  | 'skipped-mock'
  | 'skipped-cloud-synced'
  | 'skipped-config-invalid'
  | 'skipped-no-brake-content'
  | 'failed'

export interface DecisionRecorderDeps {
  loadConfig: () => Promise<ResearchDecisionsConfigResolution>
  /**
   * Cache-only synchronous regime peek — MUST NOT fetch (iron rule 1: even
   * a swallowed slow fetch would delay push/409/reject). undefined →
   * UNKNOWN live context, never a wait.
   */
  peekRegime?: () => RegimeReading | undefined
  ledgerDir?: string
  now?: () => Date
}

export interface DecisionRecorder {
  capture(evt: ResearchCaptureEvent): Promise<CaptureOutcome>
}

// ==================== Report predicates ====================

const WOULD_BLOCK = /WOULD_BLOCK$/

/** BLOCK result or a *_WOULD_BLOCK annotation anywhere in the report. */
export function hasBrakeContent(report: RiskGateStatus): boolean {
  return report.verdicts.some(v => v.result === 'BLOCK' || (v.code !== undefined && WOULD_BLOCK.test(v.code)))
}

function blockingGatesOf(report: RiskGateStatus): string[] {
  const gates = report.verdicts
    .filter(v => v.result === 'BLOCK' || (v.code !== undefined && WOULD_BLOCK.test(v.code)))
    .map(v => v.gate)
  return [...new Set(gates)]
}

function gateSummaryOf(report: RiskGateStatus): GateSummary {
  return {
    mode: report.mode,
    result: report.result,
    configSource: report.configSource,
    evaluatedAt: report.evaluatedAt,
    verdicts: report.verdicts.map(v => ({
      gate: v.gate,
      result: v.result,
      reason: v.reason,
      ...(v.code !== undefined ? { code: v.code } : {}),
      ...(v.observed !== undefined ? { observed: v.observed } : {}),
      ...(v.limit !== undefined ? { limit: v.limit } : {}),
    })),
  }
}

// ==================== Recorder ====================

export function createDecisionRecorder(deps: DecisionRecorderDeps): DecisionRecorder {
  const now = deps.now ?? (() => new Date())
  const dir = deps.ledgerDir ?? decisionsDir()
  const seenIds = new Map<string, Set<string>>() // file → parent ids (lazy)
  let warnedDay: string | undefined // cloud/config warn, once per day

  const warnOnce = (msg: string): void => {
    const day = now().toISOString().slice(0, 10)
    if (warnedDay === day) return
    warnedDay = day
    console.warn(`[research-decisions] ${msg}`)
  }

  async function knownIds(filePath: string, read: (p: string) => Promise<Array<{ id?: string }>>): Promise<Set<string>> {
    let ids = seenIds.get(filePath)
    if (!ids) {
      ids = new Set((await read(filePath)).map(r => r.id).filter((x): x is string => typeof x === 'string'))
      seenIds.set(filePath, ids)
    }
    return ids
  }

  const regimeAtCapture = (): RegimeContext => {
    let reading: RegimeReading | undefined
    try {
      reading = deps.peekRegime?.()
    } catch { /* a peek must never hurt capture */ }
    if (!reading) {
      return { zone: 'UNKNOWN', contextSource: 'live', reason: 'regime context unavailable at capture time' }
    }
    return {
      zone: reading.zone,
      contextSource: 'live',
      ...(reading.computedFrom !== undefined ? { computedFrom: reading.computedFrom } : {}),
      ...(reading.reason !== undefined ? { reason: reading.reason } : {}),
    }
  }

  async function buildChildren(args: {
    ctx: ResearchCaptureContext
    parentId: string
    capturedAt: string
    regime: RegimeContext
    results?: readonly OperationResult[]
    brake: boolean
  }): Promise<Array<DecisionChildRow | BrakeChildRow>> {
    const { ctx } = args
    const restingOrders: readonly OpenOrder[] = ctx.restingOrders ?? []
    const children: Array<DecisionChildRow | BrakeChildRow> = []

    for (let i = 0; i < ctx.operations.length; i++) {
      const op = ctx.operations[i]
      const intent = ctx.intents?.[i]
      const intentKind = intent?.kind ?? 'unclassified'
      const role: IntentRole =
        intentKind === 'unclassified' ? 'unclassified'
        : intentKind === 'risk-increasing' ? 'entry'
        : intentKind === 'risk-reducing' ? 'exit'
        : 'neutral'

      const orderSide = effectiveOrderSide(op, restingOrders)
      const contract = contractOf(op, restingOrders)

      // Pinned verbatim: entry side ONLY for risk-increasing intents,
      // derived from the effective order direction. SELL-to-reduce is not
      // a SHORT.
      const side: EntrySide | undefined =
        role === 'entry' && orderSide !== undefined ? (orderSide === 'BUY' ? 'LONG' : 'SHORT') : undefined

      let markSide: EntrySide | undefined
      let markSideMeaning: 'entry' | 'forgone-exposure' | undefined
      if (side !== undefined) {
        markSide = side
        markSideMeaning = 'entry'
      } else if (role === 'exit') {
        const pos = findPositionFor(contract, ctx.positions ?? [])
        if (pos !== undefined) {
          markSide = pos.side === 'long' ? 'LONG' : 'SHORT'
          markSideMeaning = 'forgone-exposure'
        }
      }

      // Notional provenance — prices come ONLY from the quote map the
      // gates already fetched; the capture path itself never prices.
      let notional: string | undefined
      let notionalCurrency: string | undefined
      let pricedBy: DecisionChildRow['pricedBy'] = 'n/a'
      let unpricedReason: string | undefined
      let priceAgeSec: number | undefined
      if (op.action === 'placeOrder' || op.action === 'modifyOrder' || op.action === 'closePosition') {
        try {
          const priceOf = async (c: Contract): Promise<QuotePrice | null> => {
            const key = c.aliceId || `${c.symbol}|${c.secType}|${c.currency}`
            return ctx.quotes?.get(key) ?? null
          }
          const nres = await operationNotional(op, { priceOf, restingOrders })
          if (nres.ok) {
            notional = nres.notional.toFixed()
            notionalCurrency = nres.currency
            pricedBy = nres.pricedBy
            if (nres.pricedBy === 'quote' && contract !== undefined) {
              const key = contract.aliceId || `${contract.symbol}|${contract.secType}|${contract.currency}`
              const q = ctx.quotes?.get(key)
              if (q) priceAgeSec = q.ageSec
            }
          } else {
            pricedBy = 'unpriced'
            unpricedReason = nres.reason
          }
        } catch (err) {
          pricedBy = 'unpriced'
          unpricedReason = err instanceof Error ? err.message : String(err)
        }
      }

      const orderFacts = orderFactsOf(op)
      const result = args.results?.[i]

      const base = {
        v: 1 as const,
        id: `${args.parentId}#${i}`,
        parentId: args.parentId,
        accountId: ctx.accountId,
        capturedAt: args.capturedAt,
        opIndex: i,
        opAction: op.action,
        ...(contract?.aliceId !== undefined ? { aliceId: contract.aliceId } : {}),
        ...(nativeKeyOf(contract) !== undefined ? { nativeKey: nativeKeyOf(contract) } : {}),
        ...(contract?.symbol !== undefined ? { symbol: contract.symbol } : {}),
        ...(contract?.currency !== undefined ? { currency: contract.currency } : {}),
        ...(orderSide !== undefined ? { orderSide } : {}),
        ...orderFacts,
        intent: intent !== undefined
          ? { kind: intent.kind, rationale: intent.rationale }
          : { kind: 'unclassified' as const },
        role,
        ...(side !== undefined ? { side } : {}),
        ...(markSide !== undefined ? { markSide } : {}),
        ...(markSideMeaning !== undefined ? { markSideMeaning } : {}),
        ...(notional !== undefined ? { notional } : {}),
        ...(notionalCurrency !== undefined ? { notionalCurrency } : {}),
        pricedBy,
        ...(priceAgeSec !== undefined ? { priceAgeSec } : {}),
        ...(unpricedReason !== undefined ? { unpricedReason } : {}),
        context: {
          regime: args.regime,
          funding: {
            bucket: 'unavailable' as const,
            contextSource: 'live' as const,
            reason: 'not captured at decision time (D1); backfilled as derived by the ticker',
          },
        },
      }

      if (args.brake) {
        children.push({ ...base, kind: 'blocked-intent', baseline: 'flat' })
      } else {
        children.push({
          ...base,
          kind: 'intent',
          ...(result !== undefined
            ? {
                execution: {
                  success: result.success,
                  status: result.status,
                  ...(result.orderId !== undefined ? { orderId: result.orderId } : {}),
                  ...(result.filledQty !== undefined ? { filledQty: result.filledQty } : {}),
                  ...(result.filledPrice !== undefined ? { filledPrice: result.filledPrice } : {}),
                  ...(result.error !== undefined ? { error: result.error } : {}),
                },
              }
            : {}),
        })
      }
    }
    return children
  }

  async function writeBrake(
    ctx: ResearchCaptureContext,
    report: RiskGateStatus,
    disposition: BrakeDisposition,
    capturedAt: string,
    regime: RegimeContext,
    extra: { reportAgeMsAtCapture?: number; rejectReason?: string },
  ): Promise<CaptureOutcome> {
    const filePath = brakesLedgerPath(ctx.accountId, dir)
    const id = `brk:${ctx.accountId}:${ctx.pendingHash}:${disposition}`
    const ids = await knownIds(filePath, readBrakesRows)
    if (ids.has(id)) return 'skipped-duplicate'

    const children = await buildChildren({ ctx, parentId: id, capturedAt, regime, brake: true })
    const parent: BrakeParentRow = {
      kind: 'verdict',
      v: 1,
      id,
      accountId: ctx.accountId,
      presetId: ctx.presetId,
      capturedAt,
      decidedAt: report.evaluatedAt,
      pendingHash: ctx.pendingHash,
      message: ctx.message,
      disposition,
      gateSummary: gateSummaryOf(report),
      blockingGates: blockingGatesOf(report),
      ...(extra.reportAgeMsAtCapture !== undefined ? { reportAgeMsAtCapture: extra.reportAgeMsAtCapture } : {}),
      ...(extra.rejectReason !== undefined ? { rejectReason: extra.rejectReason } : {}),
      childCount: children.length,
    }
    await appendRow(filePath, parent)
    for (const child of children) await appendRow(filePath, child)
    ids.add(id)
    return 'written'
  }

  async function writeDecision(
    ctx: ResearchCaptureContext,
    report: RiskGateStatus,
    commit: { hash: string; results: readonly OperationResult[] },
    capturedAt: string,
    regime: RegimeContext,
  ): Promise<CaptureOutcome> {
    const filePath = decisionsLedgerPath(ctx.accountId, dir)
    const id = `dec:${ctx.accountId}:${ctx.pendingHash}`
    const ids = await knownIds(filePath, readDecisionsRows)
    if (ids.has(id)) return 'skipped-duplicate'

    const children = await buildChildren({ ctx, parentId: id, capturedAt, regime, results: commit.results, brake: false })
    const parent: DecisionParentRow = {
      kind: 'push',
      v: 1,
      id,
      accountId: ctx.accountId,
      presetId: ctx.presetId,
      capturedAt,
      decidedAt: report.evaluatedAt,
      pendingHash: ctx.pendingHash,
      commitHash: commit.hash,
      message: ctx.message,
      gateSummary: gateSummaryOf(report),
      override: hasBrakeContent(report),
      overrideReason: null, // no v0 capture surface — recorded as missing, never backfilled
      thesis: null,         // reserved
      results: {
        submitted: commit.results.filter(r => r.success).length,
        rejected: commit.results.filter(r => !r.success).length,
      },
      childCount: children.length,
    }
    await appendRow(filePath, parent)
    for (const child of children) await appendRow(filePath, child)
    ids.add(id)
    return 'written'
  }

  return {
    async capture(evt: ResearchCaptureEvent): Promise<CaptureOutcome> {
      try {
        const resolution = await deps.loadConfig()
        if (resolution.status === 'invalid') {
          warnOnce(`config invalid — not recording: ${resolution.error}`)
          return 'skipped-config-invalid'
        }
        const cfg = resolution.config
        if (!cfg.enabled) return 'skipped-disabled'
        if (!cfg.captureMockAccounts && evt.ctx.presetId === 'mock-simulator') return 'skipped-mock'
        if (isCloudSyncedPath(dir)) {
          warnOnce('ledger dir is under a cloud-synced (OneDrive) path — refusing to record; evidence ledgers live on the runtime clone only')
          return 'skipped-cloud-synced'
        }

        const capturedAt = now().toISOString()
        const regime = regimeAtCapture()

        if (evt.phase === 'blocked') {
          return await writeBrake(evt.ctx, evt.report, 'blocked', capturedAt, regime, {})
        }
        if (evt.phase === 'rejected') {
          // Iron rule 2: a clean-PASS reject records nothing.
          if (!hasBrakeContent(evt.report)) return 'skipped-no-brake-content'
          return await writeBrake(evt.ctx, evt.report, 'rejected', capturedAt, regime, {
            reportAgeMsAtCapture: evt.reportAgeMs,
            ...(evt.reason !== undefined ? { rejectReason: evt.reason } : {}),
          })
        }
        // executed — decision rows always; overridden brake rows when the
        // report carried brake content the human pushed through.
        const decisionOutcome = await writeDecision(evt.ctx, evt.report, evt.commit, capturedAt, regime)
        if (hasBrakeContent(evt.report)) {
          await writeBrake(evt.ctx, evt.report, 'overridden', capturedAt, regime, {})
        }
        return decisionOutcome
      } catch (err) {
        // Never throw into the caller's swallow — that would silently lose
        // the diagnostic too. Warn loudly, report failure.
        console.warn('[research-decisions] capture failed:', err instanceof Error ? err.message : err)
        return 'failed'
      }
    },
  }
}

// ==================== Op helpers ====================

function contractOf(op: Operation, restingOrders: readonly OpenOrder[]): Contract | undefined {
  if (op.action === 'placeOrder' || op.action === 'closePosition') return op.contract
  if (op.action === 'modifyOrder') {
    const resting = restingOrders.find(o => {
      const oid = (o.order as unknown as { orderId?: number | string }).orderId
      return oid !== undefined && String(oid) === op.orderId
    })
    return resting?.contract
  }
  return undefined
}

function orderFactsOf(op: Operation): { orderType?: string; qty?: string; cashQty?: string; lmtPrice?: string } {
  if (op.action === 'placeOrder') {
    const qty = decOrUndef(op.order?.totalQuantity)?.toFixed()
    const cashQty = decOrUndef(op.order?.cashQty)?.toFixed()
    const lmt = decOrUndef(op.order?.lmtPrice)?.toFixed()
    const orderType = op.order?.orderType
    return {
      ...(orderType !== undefined ? { orderType: String(orderType) } : {}),
      ...(qty !== undefined ? { qty } : {}),
      ...(cashQty !== undefined ? { cashQty } : {}),
      ...(lmt !== undefined ? { lmtPrice: lmt } : {}),
    }
  }
  if (op.action === 'modifyOrder') {
    const qty = decOrUndef(op.changes?.totalQuantity)?.toFixed()
    const lmt = decOrUndef(op.changes?.lmtPrice)?.toFixed()
    return {
      ...(qty !== undefined ? { qty } : {}),
      ...(lmt !== undefined ? { lmtPrice: lmt } : {}),
    }
  }
  if (op.action === 'closePosition') {
    const qty = decOrUndef(op.quantity)?.toFixed()
    return qty !== undefined ? { qty } : {}
  }
  return {}
}
