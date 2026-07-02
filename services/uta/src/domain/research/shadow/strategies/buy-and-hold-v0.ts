/**
 * buy-and-hold-v0 — B1 seed strategy (docs/shadow-strategies/
 * buy-and-hold-v0.md). Always long BTCUSDT. Role: baseline + full-pipeline
 * verification of the scoring track. Not promotable by definition — it has
 * no entry claim to validate.
 */

import type { DailyStrategy } from '../types.js'

export const buyAndHoldV0: DailyStrategy = {
  id: 'buy-and-hold-v0',
  symbol: 'BTCUSDT',
  venue: 'binance_spot',
  registrationDoc: 'docs/shadow-strategies/buy-and-hold-v0.md',
  dataNeeds: { kinds: ['klines'], minDays: 2 },
  compute() {
    return { stance: 'long' }
  },
}
