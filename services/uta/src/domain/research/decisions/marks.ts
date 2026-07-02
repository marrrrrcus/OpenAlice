/**
 * Horizon mark math — pure decimal.js (docs/human-decision-ledger-v0.md
 * must-pin 1). Anchor policy pinned: entry = OPEN of the first daily candle
 * AFTER the decision day (no lookahead); horizon nD exit = CLOSE of
 * anchor+n−1; MAE/MFE from daily highs/lows over the window. Identical
 * methodology for both ledgers — executed intents do NOT use fill prices
 * here (fills live on the child's execution field, reported separately).
 */

import Decimal from 'decimal.js'
import type { EntrySide } from './types.js'

export interface DailyCandleInput {
  dateUtc: string
  open: string
  high: string
  low: string
  close: string
}

export type HorizonMarkResult =
  | {
      ok: true
      entryPrice: string
      exitPrice: string
      /** Signed decimal fractions. */
      ret: string
      mae: string
      mfe: string
      entryOpenDateUtc: string
      exitCloseDateUtc: string
    }
  | { ok: false; reason: string }

const DAY_MS = 86_400_000
const addDays = (dateUtc: string, n: number): string =>
  new Date(Date.parse(`${dateUtc}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

export function computeHorizonMark(args: {
  side: EntrySide
  anchorDateUtc: string
  horizonDays: number
  /** Completed daily candles covering the window (gaps tolerated except
   *  the anchor and exit days themselves). */
  candles: readonly DailyCandleInput[]
}): HorizonMarkResult {
  const sign = args.side === 'LONG' ? new Decimal(1) : new Decimal(-1)
  const exitDay = addDays(args.anchorDateUtc, args.horizonDays - 1)
  const byDay = new Map(args.candles.map(c => [c.dateUtc, c]))

  const anchor = byDay.get(args.anchorDateUtc)
  if (!anchor) return { ok: false, reason: `anchor candle ${args.anchorDateUtc} not available` }
  const exit = byDay.get(exitDay)
  if (!exit) return { ok: false, reason: `exit candle ${exitDay} not available` }

  const entry = new Decimal(anchor.open)
  if (!entry.gt(0)) return { ok: false, reason: 'anchor open is not a positive price' }
  const exitClose = new Decimal(exit.close)

  const ret = sign.mul(exitClose.div(entry).minus(1))

  // Window extremes day by day (venue gaps inside the window are tolerated —
  // the extremes are computed over the days that exist).
  let mae: Decimal | undefined
  let mfe: Decimal | undefined
  for (let d = args.anchorDateUtc; d <= exitDay; d = addDays(d, 1)) {
    const candle = byDay.get(d)
    if (!candle) continue
    const adverse = args.side === 'LONG' ? new Decimal(candle.low) : new Decimal(candle.high)
    const favorable = args.side === 'LONG' ? new Decimal(candle.high) : new Decimal(candle.low)
    const advRet = sign.mul(adverse.div(entry).minus(1))
    const favRet = sign.mul(favorable.div(entry).minus(1))
    if (mae === undefined || advRet.lt(mae)) mae = advRet
    if (mfe === undefined || favRet.gt(mfe)) mfe = favRet
  }
  if (mae === undefined || mfe === undefined) {
    return { ok: false, reason: 'no candles inside the horizon window' }
  }

  return {
    ok: true,
    entryPrice: entry.toFixed(),
    exitPrice: exitClose.toFixed(),
    ret: ret.toFixed(),
    mae: mae.toFixed(),
    mfe: mfe.toFixed(),
    entryOpenDateUtc: args.anchorDateUtc,
    exitCloseDateUtc: exitDay,
  }
}
