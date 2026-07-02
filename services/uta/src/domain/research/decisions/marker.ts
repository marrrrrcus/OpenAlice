/**
 * Track D marker tick — fills horizon marks + derived contexts for both
 * ledgers' child rows (docs/human-decision-ledger-v0.md). All deps
 * injected; zero direct network here.
 *
 * State = the ledgers themselves (no side state file). Due set = children
 * with a markSide × horizons past due (grace respected) minus cells whose
 * effective mark is 'marked'. 'unmarkable' is NOT terminal — it stays in
 * the due set and a later 'marked' row supersedes it (last-wins).
 *
 * NO backfill cap — explicitly: horizon marks are point-in-time
 * derivations from historical daily candles with no chain state; a marker
 * down for months backfills completely on the next tick. The only hard
 * bound is the venue's own candle depth (structural → 'unmarkable' with
 * reason). Transient failures append nothing and retry next tick.
 */

import type { ResearchDecisionsConfig, BrakeChildRow, DecisionChildRow, DerivedRow, EntrySide, FundingContextRow, Horizon, MarkRow, RegimeContextRow } from './types.js'
import { HORIZONS, HORIZON_DAYS } from './types.js'
import {
  appendRow,
  brakesDerivedPath,
  brakesLedgerPath,
  decisionsDerivedPath,
  decisionsLedgerPath,
  effectiveFundingContext,
  effectiveMarks,
  effectiveRegimeContext,
  markKey,
  readBrakesRows,
  readDecisionsRows,
  readDerivedRows,
} from './ledger.js'
import { computeFundingBucket, toFapiSymbol, type SettledFundingRow } from './funding.js'
import { computeHorizonMark, type DailyCandleInput } from './marks.js'

const DAY_MS = 86_400_000
const dayUtcOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const startOfDayMs = (dateUtc: string): number => Date.parse(`${dateUtc}T00:00:00Z`)
const addDays = (dateUtc: string, n: number): string => dayUtcOfMs(startOfDayMs(dateUtc) + n * DAY_MS)

type ChildRow = DecisionChildRow | BrakeChildRow

export interface MarkTickDeps {
  ledgerDir: string
  config: ResearchDecisionsConfig
  now: () => Date
  /** Account ids present in the ledger dir (from readdir, injected). */
  listAccountIds: () => Promise<string[]>
  /**
   * Venue-correct completed daily candles via the account's own broker.
   * undefined = the broker structurally cannot provide candles
   * ('unmarkable'); a throw = transient, skip and retry next tick.
   */
  fetchDailyOhlcv: (accountId: string, nativeKey: string, sinceMs: number, limitDays: number) => Promise<DailyCandleInput[] | undefined>
  /** ccxt exchange id for the account (e.g. 'binanceusdm') — funding
   *  backfill is pinned to Binance USD-M; other venues are permanently
   *  'unavailable'. undefined = unknown venue. */
  venueOf: (accountId: string) => string | undefined
  /** Settled funding rows (paged public fetch, injected). Throw = transient. */
  fetchFundingHistory: (symbol: string, startMs: number, endMs: number) => Promise<SettledFundingRow[]>
  /** dateUtc → recorded trading.regime.zone event (UNKNOWN events are
   *  events too — "the event said UNKNOWN" is a different fact from "no
   *  event was recorded"). */
  loadRegimeZones: () => Promise<Map<string, { zone: 'BULL' | 'BEAR' | 'GRAY' | 'UNKNOWN'; reason?: string }>>
}

interface LedgerSlice {
  children: ChildRow[]
  parentPreset: Map<string, string>
  parentDecidedAt: Map<string, string>
  derivedPath: string
  derived: DerivedRow[]
}

async function readSlice(kind: 'decisions' | 'brakes', accountId: string, dir: string): Promise<LedgerSlice> {
  const basePath = kind === 'decisions' ? decisionsLedgerPath(accountId, dir) : brakesLedgerPath(accountId, dir)
  const derivedPath = kind === 'decisions' ? decisionsDerivedPath(accountId, dir) : brakesDerivedPath(accountId, dir)
  const rows = kind === 'decisions' ? await readDecisionsRows(basePath) : await readBrakesRows(basePath)
  const children: ChildRow[] = []
  const parentPreset = new Map<string, string>()
  const parentDecidedAt = new Map<string, string>()
  for (const row of rows) {
    if (row.kind === 'push' || row.kind === 'verdict') {
      parentPreset.set(row.id, row.presetId)
      parentDecidedAt.set(row.id, row.decidedAt)
    } else {
      children.push(row)
    }
  }
  return { children, parentPreset, parentDecidedAt, derivedPath, derived: await readDerivedRows(derivedPath) }
}

export async function processMarkTick(deps: MarkTickDeps): Promise<void> {
  const nowDate = deps.now()
  const nowMs = nowDate.getTime()
  const graceMs = deps.config.marker.graceHours * 3_600_000
  const newestCompletedDay = dayUtcOfMs(nowMs - DAY_MS)
  const today = dayUtcOfMs(nowMs)
  let regimeZones: Map<string, { zone: 'BULL' | 'BEAR' | 'GRAY' | 'UNKNOWN'; reason?: string }> | undefined

  for (const accountId of await deps.listAccountIds()) {
    // Per-account isolation: one account's trouble never stops the others.
    try {
      for (const kind of ['decisions', 'brakes'] as const) {
        const slice = await readSlice(kind, accountId, deps.ledgerDir)
        if (slice.children.length === 0) continue
        const marks = effectiveMarks(slice.derived)
        const fundingCtx = effectiveFundingContext(slice.derived)
        const regimeCtx = effectiveRegimeContext(slice.derived)

        // ---- Horizon marks ----
        if (deps.config.marker.enabled) {
          await fillMarks({ deps, accountId, slice, marks, nowMs, graceMs, newestCompletedDay })
        }

        // ---- Funding backfill (derived) ----
        if (deps.config.funding.enabled) {
          await fillFunding({ deps, accountId, slice, fundingCtx, nowMs })
        }

        // ---- Regime backfill (derived) ----
        regimeZones ??= await deps.loadRegimeZones()
        await fillRegime({ slice, regimeCtx, regimeZones, today, nowDate })
      }
    } catch (err) {
      console.warn(`[research-decisions] marker tick for ${accountId} failed:`, err instanceof Error ? err.message : err)
    }
  }
}

// ==================== Marks ====================

async function fillMarks(args: {
  deps: MarkTickDeps
  accountId: string
  slice: LedgerSlice
  marks: Map<string, MarkRow>
  nowMs: number
  graceMs: number
  newestCompletedDay: string
}): Promise<void> {
  const { deps, slice } = args

  interface Due { child: ChildRow; horizon: Horizon; anchor: string; side: EntrySide }
  const dueByKey = new Map<string, Due[]>() // nativeKey → due cells

  for (const child of slice.children) {
    if (child.markSide === undefined || child.nativeKey === undefined) continue
    const decidedAt = slice.parentDecidedAt.get(child.parentId)
    if (decidedAt === undefined) continue
    const anchor = addDays(dayUtcOfMs(Date.parse(decidedAt)), 1)
    for (const horizon of HORIZONS) {
      const existing = args.marks.get(markKey(child.id, horizon))
      if (existing?.status === 'marked') continue // marked is FINAL
      const exitDay = addDays(anchor, HORIZON_DAYS[horizon] - 1)
      const dueAt = startOfDayMs(exitDay) + 86_400_000 + args.graceMs // exit candle closes, plus grace
      if (args.nowMs < dueAt) continue
      const list = dueByKey.get(child.nativeKey) ?? []
      list.push({ child, horizon, anchor, side: child.markSide })
      dueByKey.set(child.nativeKey, list)
    }
  }

  for (const [nativeKey, dues] of dueByKey) {
    const minAnchor = dues.map(d => d.anchor).sort()[0]
    const maxExitDay = dues
      .map(d => addDays(d.anchor, HORIZON_DAYS[d.horizon] - 1))
      .sort()
      .pop()!

    // Page until every due cell's exit day is covered, the venue runs out,
    // or no progress is made — fetchPageDays is a PAGE SIZE, never a
    // backfill cap (pinned): a marker down for months must still cover.
    let candles: DailyCandleInput[] | undefined
    try {
      candles = []
      let cursor = startOfDayMs(minAnchor)
      const maxExitMs = startOfDayMs(maxExitDay)
      for (;;) {
        const page = await deps.fetchDailyOhlcv(args.accountId, nativeKey, cursor, deps.config.marker.fetchPageDays)
        if (page === undefined) {
          candles = undefined // structural — the broker cannot provide candles
          break
        }
        if (page.length === 0) break
        candles.push(...page)
        const lastMs = startOfDayMs(page[page.length - 1].dateUtc)
        if (lastMs >= maxExitMs) break              // coverage reached
        if (page.length < deps.config.marker.fetchPageDays) break // venue ran out
        const next = lastMs + 86_400_000
        if (next <= cursor) break                   // defensive: no progress
        cursor = next
      }
    } catch {
      continue // transient — retry next tick, append nothing
    }

    if (candles === undefined) {
      // Structural: broker cannot provide candles. Recorded once,
      // supersedable if a later broker version can.
      for (const due of dues) {
        if (args.marks.get(markKey(due.child.id, due.horizon))?.status === 'unmarkable') continue
        await appendMark(slice.derivedPath, {
          childId: due.child.id, horizon: due.horizon, status: 'unmarkable',
          reason: 'broker cannot provide daily candles (fetchDailyOhlcv unsupported)',
          nativeKey,
        }, args)
      }
      continue
    }

    const completed = candles.filter(c => c.dateUtc <= args.newestCompletedDay)
    const oldestFetched = completed.length > 0 ? completed[0].dateUtc : undefined
    for (const due of dues) {
      const result = computeHorizonMark({
        side: due.side,
        anchorDateUtc: due.anchor,
        horizonDays: HORIZON_DAYS[due.horizon],
        candles: completed,
      })
      if (result.ok) {
        await appendMark(slice.derivedPath, {
          childId: due.child.id, horizon: due.horizon, status: 'marked',
          side: due.side, anchorPolicy: 'next-daily-open', anchorDateUtc: due.anchor,
          entryPrice: result.entryPrice, exitPrice: result.exitPrice,
          ret: result.ret, mae: result.mae, mfe: result.mfe,
          nativeKey, symbol: due.child.symbol,
          entryOpenDateUtc: result.entryOpenDateUtc, exitCloseDateUtc: result.exitCloseDateUtc,
        }, args)
      } else if (oldestFetched !== undefined && due.anchor < oldestFetched) {
        // The venue's candle depth ends after our anchor — structural.
        if (args.marks.get(markKey(due.child.id, due.horizon))?.status === 'unmarkable') continue
        await appendMark(slice.derivedPath, {
          childId: due.child.id, horizon: due.horizon, status: 'unmarkable',
          reason: `anchor ${due.anchor} is beyond the venue's candle depth (oldest available ${oldestFetched})`,
          nativeKey,
        }, args)
      }
      // else: candles missing for another (possibly transient) reason —
      // append nothing, retry next tick.
    }
  }
}

async function appendMark(
  derivedPath: string,
  fields: Omit<MarkRow, 'kind' | 'v' | 'at' | 'venue' | 'candleSource'> & { nativeKey?: string },
  args: { deps: MarkTickDeps; accountId: string; marks: Map<string, MarkRow> },
): Promise<void> {
  const venue = args.deps.venueOf(args.accountId)
  const row: MarkRow = {
    kind: 'mark',
    v: 1,
    at: args.deps.now().toISOString(),
    ...(venue !== undefined ? { venue, candleSource: `ccxt:${venue}` } : {}),
    ...fields,
  }
  await appendRow(derivedPath, row)
  args.marks.set(markKey(row.childId, row.horizon), row)
}

// ==================== Funding backfill ====================

async function fillFunding(args: {
  deps: MarkTickDeps
  accountId: string
  slice: LedgerSlice
  fundingCtx: Map<string, FundingContextRow>
  nowMs: number
}): Promise<void> {
  const { deps, slice } = args
  const venue = deps.venueOf(args.accountId)
  const historyCache = new Map<string, SettledFundingRow[] | 'failed'>()

  for (const child of slice.children) {
    if (child.context.funding.bucket !== 'unavailable' || child.context.funding.contextSource !== 'live') continue
    if (args.fundingCtx.has(child.id)) continue // already definitively derived
    const decidedAt = slice.parentDecidedAt.get(child.parentId)
    if (decidedAt === undefined || child.nativeKey === undefined) continue
    const decidedMs = Date.parse(decidedAt)

    const fapiSymbol = toFapiSymbol(child.nativeKey)
    if (venue !== 'binanceusdm' || fapiSymbol === undefined) {
      // Permanent: the pinned bucket machinery is Binance USD-M only (v0).
      await appendDerived(slice.derivedPath, args.fundingCtx, {
        kind: 'fundingContext', v: 1, childId: child.id, at: deps.now().toISOString(),
        contextSource: 'derived', bucket: 'unavailable',
        reason: `venue not supported in v0 (pinned machinery is Binance USD-M; account venue: ${venue ?? 'unknown'})`,
      })
      continue
    }

    let rows = historyCache.get(fapiSymbol)
    if (rows === undefined) {
      try {
        rows = await deps.fetchFundingHistory(fapiSymbol, decidedMs - 366 * DAY_MS, decidedMs)
      } catch {
        rows = 'failed'
      }
      historyCache.set(fapiSymbol, rows)
    }
    if (rows === 'failed') continue // transient — retry next tick

    const result = computeFundingBucket(rows, decidedMs)
    await appendDerived(slice.derivedPath, args.fundingCtx, {
      kind: 'fundingContext', v: 1, childId: child.id, at: deps.now().toISOString(),
      contextSource: 'derived', bucket: result.bucket,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      inputs: {
        symbol: fapiSymbol,
        decidedAt,
        ...(result.sum24h !== undefined ? { sum24h: result.sum24h } : {}),
        ...(result.z !== undefined ? { z: result.z } : {}),
        ...(result.p90PosThreshold !== undefined ? { p90PosThreshold: result.p90PosThreshold } : {}),
        ...(result.historyDays !== undefined ? { historyDays: result.historyDays } : {}),
        source: 'binance_usdm',
      },
    })
  }
}

// ==================== Regime backfill ====================

async function fillRegime(args: {
  slice: LedgerSlice
  regimeCtx: Map<string, RegimeContextRow>
  regimeZones: Map<string, { zone: 'BULL' | 'BEAR' | 'GRAY' | 'UNKNOWN'; reason?: string }>
  today: string
  nowDate: Date
}): Promise<void> {
  for (const child of args.slice.children) {
    if (child.context.regime.zone !== 'UNKNOWN' || child.context.regime.contextSource !== 'live') continue
    if (args.regimeCtx.has(child.id)) continue
    const decidedAt = args.slice.parentDecidedAt.get(child.parentId)
    if (decidedAt === undefined) continue
    const day = decidedAt.slice(0, 10)

    const event = args.regimeZones.get(day)
    if (event !== undefined) {
      // An UNKNOWN event is still an event — "the recorded reading was
      // UNKNOWN" must never be rewritten as "no event was recorded".
      await appendDerived(args.slice.derivedPath, args.regimeCtx, {
        kind: 'regimeContext', v: 1, childId: child.id, at: args.nowDate.toISOString(),
        contextSource: 'derived', zone: event.zone, sourceEventDateUtc: day,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      })
    } else if (day < args.today) {
      // The day's regime event can only be logged on that day — a past day
      // with no event is permanently absent. Recorded so it stops retrying.
      await appendDerived(args.slice.derivedPath, args.regimeCtx, {
        kind: 'regimeContext', v: 1, childId: child.id, at: args.nowDate.toISOString(),
        contextSource: 'derived', zone: 'UNKNOWN',
        reason: `no recorded trading.regime.zone event for ${day}`,
      })
    }
    // day === today → the event may still arrive; retry next tick.
  }
}

async function appendDerived<T extends FundingContextRow | RegimeContextRow>(
  derivedPath: string,
  cache: Map<string, T>,
  row: T,
): Promise<void> {
  await appendRow(derivedPath, row)
  cache.set(row.childId, row)
}
