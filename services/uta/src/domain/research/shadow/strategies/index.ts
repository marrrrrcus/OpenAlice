/**
 * Static strategy registry — THE code-review enforcement point of
 * pre-registration integrity (docs/strategy-shadow-track-v0.md).
 *
 * Rules for touching this file:
 *   - a new entry requires a registration doc under docs/shadow-strategies/
 *     with the pinned rule and pre-registered exit criteria;
 *   - a RULE CHANGE to an existing strategy requires a NEW id (new ledger
 *     file, new doc) — never edit a running strategy in place.
 */

import type { DailyStrategy } from '../types.js'
import { buyAndHoldV0 } from './buy-and-hold-v0.js'

export const ALL_STRATEGIES: readonly DailyStrategy[] = [
  buyAndHoldV0,
]
