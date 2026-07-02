import { describe, it, expect } from 'vitest'
import { buyAndHoldV0 } from './buy-and-hold-v0.js'
import { ALL_STRATEGIES } from './index.js'

describe('buy-and-hold-v0 (B1 seed)', () => {
  it('is always long, with or without a previous stance', () => {
    expect(buyAndHoldV0.compute({ klines: [] })).toEqual({ stance: 'long' })
    expect(buyAndHoldV0.compute({ klines: [], prevStance: 'flat' })).toEqual({ stance: 'long' })
  })

  it('registration fields are pinned (id versioning + doc + venue)', () => {
    expect(buyAndHoldV0.id).toBe('buy-and-hold-v0')
    expect(buyAndHoldV0.symbol).toBe('BTCUSDT')
    expect(buyAndHoldV0.venue).toBe('binance_spot')
    expect(buyAndHoldV0.registrationDoc).toBe('docs/shadow-strategies/buy-and-hold-v0.md')
    expect(buyAndHoldV0.dataNeeds).toEqual({ kinds: ['klines'], minDays: 2 })
  })

  it('is registered in the static registry (the pre-registration gate)', () => {
    expect(ALL_STRATEGIES.map(s => s.id)).toContain('buy-and-hold-v0')
    // Registry ids must be unique — two strategies must never share a ledger.
    const ids = ALL_STRATEGIES.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
