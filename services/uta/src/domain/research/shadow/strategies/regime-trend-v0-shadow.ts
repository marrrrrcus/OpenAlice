/**
 * regime-trend-v0-shadow — B2 harness-control strategy
 * (docs/shadow-strategies/regime-trend-v0-shadow.md).
 *
 * The rule is the REJECTED docs/backtests/regime-trend-v0.md mainline
 * (rejected 2026-06: beat buy-and-hold on every aggregate metric but failed
 * the per-cycle gate on the 2019-2020 fast crash), run forward as an
 * OUT-OF-SAMPLE CONTROL: if the shadow's realized behavior contradicts the
 * backtest's character, suspect the harness first. Good forward numbers do
 * NOT overturn the REJECTED verdict — they can only feed a human-written
 * verdict or a separately pre-registered vNext hypothesis.
 *
 * Pinned rule (bit-faithful via the validated computeZone):
 *   BULL (close > SMA200×1.03) → long
 *   BEAR (close < SMA200×0.97) → flat     (long/flat strategy — never short)
 *   GRAY (in band)             → carry the previous stance
 *
 * Hysteresis state source follows the track spec: prevStance chains from
 * the ledger; on a cold start / broken chain the state is reconstructed as
 * the most recent band EXIT within the provided window, and a window with
 * no exit at all is `unknown` (the backtest's "FLAT until the first BULL
 * after warmup" initial state needs full history, which a bounded window
 * cannot guarantee — unknown is the honest answer; in practice a 500-day
 * window virtually always contains an exit).
 */

import { computeZone, SMA_WINDOW } from '../../../trading/risk-gates/regime/zone.js'
import type { DailyStrategy, Stance, StrategyResult } from '../types.js'

function zoneToStance(zone: 'BULL' | 'BEAR'): Stance {
  return zone === 'BULL' ? 'long' : 'flat'
}

export const regimeTrendV0Shadow: DailyStrategy = {
  id: 'regime-trend-v0-shadow',
  symbol: 'BTCUSDT',
  venue: 'binance_spot',
  registrationDoc: 'docs/shadow-strategies/regime-trend-v0-shadow.md',
  // 200-day SMA warmup + ~300 days of zone history for cold-start exit hunting.
  dataNeeds: { kinds: ['klines'], minDays: 500 },
  compute(ctx): StrategyResult {
    const closes = ctx.klines.map(r => r[4])
    const today = computeZone(closes)
    if (!today.ok) return { stance: 'unknown', reason: today.error }

    if (today.zone !== 'GRAY') {
      return {
        stance: zoneToStance(today.zone),
        meta: { zone: today.zone, sma200: today.sma200 },
      }
    }

    // GRAY — carry the chained stance when the ledger provides one.
    if (ctx.prevStance !== undefined) {
      return {
        stance: ctx.prevStance,
        meta: { zone: 'GRAY', sma200: today.sma200 },
      }
    }

    // Cold start / broken chain: reconstruct from the most recent band exit
    // within the window (walk backwards from yesterday; each step recomputes
    // the zone on the shortened history — identical math to what a live
    // fold would have produced on that day).
    for (let i = closes.length - 2; i + 1 >= SMA_WINDOW; i--) {
      const past = computeZone(closes.slice(0, i + 1))
      if (!past.ok) break
      if (past.zone !== 'GRAY') {
        return {
          stance: zoneToStance(past.zone),
          meta: {
            zone: 'GRAY',
            sma200: today.sma200,
            coldStartFrom: new Date(Number(ctx.klines[i][0])).toISOString().slice(0, 10),
            coldStartZone: past.zone,
          },
        }
      }
    }
    return { stance: 'unknown', reason: 'hysteresis state indeterminate: no band exit within the provided window' }
  },
}
