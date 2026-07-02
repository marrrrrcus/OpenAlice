/**
 * Static strategy registry — THE code-review enforcement point of
 * pre-registration integrity (docs/strategy-shadow-track-v0.md).
 *
 * Rules for touching this file:
 *   - a new entry requires a registration doc under docs/shadow-strategies/
 *     with the pinned rule and pre-registered exit criteria;
 *   - a RULE CHANGE to an existing strategy requires a NEW id (new ledger
 *     file, new doc) — never edit a running strategy in place;
 *   - the report-side registration mirror (src/domain/research/
 *     shadow-report.ts REGISTRATIONS) must be updated in the same change —
 *     src/ cannot import this registry, so the mirror is manual and THIS
 *     comment plus its anti-drift spec are the sync enforcement.
 */

import type { DailyStrategy } from '../types.js'
import { buyAndHoldV0 } from './buy-and-hold-v0.js'
import { regimeTrendV0Shadow } from './regime-trend-v0-shadow.js'

export const ALL_STRATEGIES: readonly DailyStrategy[] = [
  buyAndHoldV0,
  regimeTrendV0Shadow,
]
