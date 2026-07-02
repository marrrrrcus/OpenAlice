/**
 * processStrategyTick — the correctness core of the shadow track
 * (docs/strategy-shadow-track-v0.md "Catch-up / backfill" + "Unknown
 * semantics"). All deps injected; zero network in this module.
 *
 * Pending-scan rules (pinned):
 *   - expected day = UTC-yesterday; if its effective ledger row is already
 *     a day row, the tick is a no-op.
 *   - cold start (empty ledger): process ONLY the expected day — a track
 *     starts at deployment; pre-activation history is never reconstructed.
 *   - otherwise pending = (newest day row, expected day]. Trailing unknown
 *     rows stay inside the scan (retryable, superseded on data arrival via
 *     last-row-wins) until a day row lands after them — then the scan floor
 *     moves past them forever. Day rows are FINAL, so the equity chain can
 *     never fork retroactively.
 *   - a pending day further than maxBackfillDays behind the expected day is
 *     REFUSED with an unknown row: reconstructing it would be a backtest
 *     wearing a forward badge.
 *
 * Unknown rows freeze equity (carry-forward state, not performance) and are
 * appended at most once per day (retries only supersede, never spam).
 */

import Decimal from 'decimal.js'
import type { KlineRow } from '../../trading/risk-gates/regime/provider.js'
import type {
  CostModel,
  DailyStrategy,
  EventLogLike,
  LedgerDayRow,
  LedgerRow,
  LedgerUnknownRow,
  StrategyResult,
} from './types.js'
import { addDays, dayUtcOfMs, diffDays, expectedDayUtc, startOfDayMs } from './dates.js'
import { appendLedgerRow, effectiveRows, readLedgerRows } from './ledger.js'
import { applyEquity, markDay } from './mark.js'

export interface StrategyTickDeps {
  strategy: DailyStrategy
  costModel: CostModel
  maxBackfillDays: number
  staleGraceHours: number
  /** Completed daily candles only, oldest → newest (caller discards the
   *  in-progress candle — anything else would be lookahead). */
  klines: readonly KlineRow[]
  /** Set when the caller's kline fetch failed. Only the expected day can
   *  then be honestly recorded (as unknown, past grace); older pending days
   *  keep no rows until data returns — day-level accounting counts rowless
   *  eligible days as unknown anyway. */
  fetchError?: string
  now: () => Date
  ledgerPath: string
  eventLog?: EventLogLike
  /** Cross-tick warn dedup (`${strategyId}:${dateUtc}`), owned by caller. */
  warnedDays?: Set<string>
}

export async function processStrategyTick(deps: StrategyTickDeps): Promise<void> {
  const { strategy } = deps
  const nowDate = deps.now()
  const expectedDay = expectedDayUtc(nowDate)

  // May THROW on a non-ENOENT read failure — deliberately: an unreadable
  // ledger must never be scored over (see ledger.ts). The shadow's
  // per-strategy catch isolates it; direct callers must do the same.
  const rows = await readLedgerRows(deps.ledgerPath)
  const eff = effectiveRows(rows)
  if (eff.get(expectedDay)?.kind === 'day') return // done for this day

  // Newest append is the equity carry source (appends are chronological;
  // a same-day supersede appended later is exactly the row to carry from).
  let carryEquity = rows.length > 0 ? rows[rows.length - 1].equity : '1'

  const withinGrace =
    nowDate.getTime() - startOfDayMs(addDays(expectedDay, 1)) <
    deps.staleGraceHours * 3_600_000

  const appendUnknown = async (dateUtc: string, reason: string): Promise<void> => {
    if (eff.get(dateUtc)?.kind === 'unknown') return // recorded once; retries supersede, never spam
    const row: LedgerUnknownRow = {
      kind: 'unknown',
      dateUtc,
      at: nowDate.toISOString(),
      reason,
      equity: carryEquity,
    }
    await appendLedgerRow(deps.ledgerPath, row)
    eff.set(dateUtc, row)
    const warnKey = `${strategy.id}:${dateUtc}`
    if (!deps.warnedDays?.has(warnKey)) {
      deps.warnedDays?.add(warnKey)
      console.warn(`[research-shadow] ${strategy.id} ${dateUtc}: ${reason}`)
    }
    try {
      await deps.eventLog?.append('research.shadow.stance', {
        strategy: strategy.id,
        symbol: strategy.symbol,
        dateUtc,
        stance: 'unknown',
        reason,
        shadowOnly: true,
      })
    } catch { /* events are best-effort mirrors — the ledger is the authority */ }
  }

  // ---- strategy-level refusals (whole strategy cannot run) ----
  if (strategy.venue !== 'binance_spot') {
    await appendUnknown(expectedDay, `unsupported venue "${strategy.venue as string}" — only binance_spot is implemented`)
    return
  }
  const unmetNeed = strategy.dataNeeds.kinds.find(k => k !== 'klines')
  if (unmetNeed !== undefined) {
    await appendUnknown(expectedDay, `data need "${unmetNeed as string}" not available in v0`)
    return
  }
  if (deps.fetchError !== undefined) {
    if (!withinGrace) await appendUnknown(expectedDay, `kline fetch failed: ${deps.fetchError}`)
    return
  }

  // ---- index completed candles by their UTC day ----
  const sorted = [...deps.klines].sort((a, b) => Number(a[0]) - Number(b[0]))
  const candleDays: string[] = []
  const candleByDay = new Map<string, KlineRow>()
  for (const row of sorted) {
    const day = dayUtcOfMs(Number(row[0]))
    if (!candleByDay.has(day)) candleDays.push(day)
    candleByDay.set(day, row)
  }

  // ---- pending range ----
  let pendingStart: string
  if (rows.length === 0) {
    pendingStart = expectedDay // cold start: the track begins at deployment
  } else {
    let lastDayRowDate: string | undefined
    let firstRowDate: string | undefined
    for (const [date, row] of eff) {
      if (firstRowDate === undefined || date < firstRowDate) firstRowDate = date
      if (row.kind === 'day' && (lastDayRowDate === undefined || date > lastDayRowDate)) {
        lastDayRowDate = date
      }
    }
    pendingStart = lastDayRowDate !== undefined
      ? addDays(lastDayRowDate, 1)
      : (firstRowDate ?? expectedDay) // all-unknown ledger: retry from activation
  }

  for (let day = pendingStart; day <= expectedDay; day = addDays(day, 1)) {
    // Cap refusal — durable: backfillability only decays with time, and the
    // already-unknown dedup makes the refusal a one-time record.
    if (diffDays(day, expectedDay) > deps.maxBackfillDays) {
      await appendUnknown(day, 'outage exceeded backfill cap — forward evidence cannot be reconstructed')
      continue
    }

    const candle = candleByDay.get(day)
    if (candle === undefined) {
      if (day === expectedDay && withinGrace) return // wait — later days cannot exist yet
      await appendUnknown(
        day,
        day === expectedDay
          ? `daily candle not available ${deps.staleGraceHours}h past its close`
          : 'daily candle missing from venue data',
      )
      continue
    }

    const dayIdx = candleDays.indexOf(day)
    const klinesThroughDay = sorted.slice(0, dayIdx + 1)
    if (klinesThroughDay.length < strategy.dataNeeds.minDays) {
      await appendUnknown(day, `insufficient history: ${klinesThroughDay.length} completed daily candles (< ${strategy.dataNeeds.minDays})`)
      continue
    }

    const prevRow = eff.get(addDays(day, -1))
    const prevIsDay = prevRow?.kind === 'day'

    let result: StrategyResult
    try {
      result = strategy.compute({
        klines: klinesThroughDay,
        ...(prevIsDay ? { prevStance: prevRow.stance } : {}),
      })
    } catch (err) {
      result = { stance: 'unknown', reason: `strategy threw: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (result.stance === 'unknown') {
      await appendUnknown(day, result.reason)
      continue
    }

    const close = new Decimal(String(candle[4]))
    let row: LedgerDayRow
    if (prevIsDay) {
      // Chained day: mark the return earned during `day` by yesterday's
      // stance. Leg baseline is the stance held the day before that —
      // 'flat' when yesterday was an anchor (first mark of a track, or
      // re-entry after an unknown gap: continuity through an unobserved
      // span may not be claimed).
      const prev2 = eff.get(addDays(day, -2))
      const mark = markDay({
        heldStance: prevRow.stance,
        prevHeldStance: prev2?.kind === 'day' ? prev2.stance : 'flat',
        prevClose: new Decimal(prevRow.close),
        close,
        costModel: deps.costModel,
      })
      const equity = applyEquity(new Decimal(prevRow.equity), mark.netRet)
      row = {
        kind: 'day',
        dateUtc: day,
        at: nowDate.toISOString(),
        backfilled: day !== expectedDay,
        close: close.toFixed(),
        stance: result.stance,
        ...(result.meta !== undefined ? { meta: result.meta } : {}),
        mark: {
          stanceHeld: prevRow.stance,
          prevClose: prevRow.close,
          grossRet: mark.grossRet.toFixed(),
          legs: mark.legs,
          costPerLegBps: mark.costPerLegBps.toFixed(),
          netRet: mark.netRet.toFixed(),
        },
        equity: equity.toFixed(),
      }
    } else {
      // Anchor: first row of the track, or first good day after an unknown
      // gap. The stance held during this day is not attributable — no mark,
      // equity carried frozen.
      row = {
        kind: 'day',
        dateUtc: day,
        at: nowDate.toISOString(),
        backfilled: day !== expectedDay,
        close: close.toFixed(),
        stance: result.stance,
        ...(result.meta !== undefined ? { meta: result.meta } : {}),
        equity: carryEquity,
      }
    }

    await appendLedgerRow(deps.ledgerPath, row)
    eff.set(day, row)
    carryEquity = row.equity

    try {
      await deps.eventLog?.append('research.shadow.stance', {
        strategy: strategy.id,
        symbol: strategy.symbol,
        dateUtc: day,
        stance: row.stance,
        close: row.close,
        ...(row.backfilled ? { backfilled: true } : {}),
        shadowOnly: true,
      })
      if (row.mark !== undefined) {
        await deps.eventLog?.append('research.shadow.mark', {
          strategy: strategy.id,
          symbol: strategy.symbol,
          dateUtc: day,
          stanceHeld: row.mark.stanceHeld,
          grossRet: row.mark.grossRet,
          legs: row.mark.legs,
          costPerLegBps: row.mark.costPerLegBps,
          netRet: row.mark.netRet,
          equity: row.equity,
          ...(row.backfilled ? { backfilled: true } : {}),
          shadowOnly: true,
        })
      }
    } catch { /* events are best-effort mirrors — the ledger is the authority */ }
  }
}
