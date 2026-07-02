/**
 * Regime zone computation — bit-for-bit the validated study's rule
 * (docs/backtests/regime-risk-gate-v0.md, commit 70eb587):
 *
 *   sma200 = simple mean of the last 200 COMPLETED daily closes
 *            (including the newest completed close — pandas
 *            close.rolling(200).mean() semantics)
 *   close > sma200 × 1.03 → BULL
 *   close < sma200 × 0.97 → BEAR
 *   otherwise             → GRAY        (stateless — no hysteresis carry)
 *
 * Pure function; the replay-parity spec drives THIS code against the
 * study artifact daily_regime_zones.csv and requires zero mismatches.
 */

import Decimal from 'decimal.js'

export type RegimeZone = 'BULL' | 'BEAR' | 'GRAY'

export const SMA_WINDOW = 200
export const BAND = new Decimal('0.03')

export type ZoneResult =
  | { ok: true; zone: RegimeZone; close: string; sma200: string }
  | { ok: false; error: string }

/**
 * @param closes — completed daily closes, oldest → newest. The newest entry
 *                 is "the close" the zone is computed for.
 */
export function computeZone(closes: readonly (string | number)[]): ZoneResult {
  if (closes.length < SMA_WINDOW) {
    return { ok: false, error: `need ≥${SMA_WINDOW} completed daily closes, got ${closes.length}` }
  }
  let sum = new Decimal(0)
  for (let i = closes.length - SMA_WINDOW; i < closes.length; i++) {
    try {
      sum = sum.plus(new Decimal(String(closes[i])))
    } catch {
      return { ok: false, error: `unreadable close at index ${i}` }
    }
  }
  const sma = sum.div(SMA_WINDOW)
  const close = new Decimal(String(closes[closes.length - 1]))
  const upper = sma.mul(new Decimal(1).plus(BAND))
  const lower = sma.mul(new Decimal(1).minus(BAND))
  const zone: RegimeZone = close.gt(upper) ? 'BULL' : close.lt(lower) ? 'BEAR' : 'GRAY'
  return { ok: true, zone, close: close.toFixed(), sma200: sma.toFixed() }
}
