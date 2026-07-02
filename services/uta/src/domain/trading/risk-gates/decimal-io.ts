/**
 * Decimal field access across the three representations an Operation can
 * arrive in:
 *
 *   1. raw in-memory (staging / in-memory commits) — Decimal instances,
 *      optional fields carry the IBKR UNSET_DECIMAL sentinel;
 *   2. wire-projected (TradingGit.status() / exportState()) — Decimal
 *      instances with sentinel fields deleted (OrderHelper.toWire);
 *   3. JSON-restored (commit.json round-trip) — plain strings/numbers.
 *
 * Every risk-gate read of a quantity/price MUST go through here so all three
 * forms behave identically and the sentinel can never masquerade as a price
 * (the 2026-05-13 "@ 1.7e38" incident class).
 */

import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'

/** Normalize a maybe-Decimal/string/number field. Sentinel/invalid → undefined. */
export function decOrUndef(v: unknown): Decimal | undefined {
  if (v === undefined || v === null || v === '') return undefined
  try {
    const d = v instanceof Decimal ? v : new Decimal(String(v))
    if (!d.isFinite()) return undefined
    if (d.equals(UNSET_DECIMAL)) return undefined
    return d
  } catch {
    return undefined
  }
}

/** Canonical string form for duplicate-detection keys: "1.0" === "1". */
export function canonDec(v: unknown): string | null {
  const d = decOrUndef(v)
  return d ? d.toFixed() : null
}
