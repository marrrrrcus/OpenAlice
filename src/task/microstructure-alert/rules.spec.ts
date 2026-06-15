import { describe, it, expect } from 'vitest'
import {
  computeOrderBookMetrics,
  emptyBaseline,
  updateOrderBookBaseline,
  updateFundingBaseline,
  percentileRank,
  evalSpreadWidening,
  evalDepthThinning,
  evalOrderbookImbalance,
  evalFundingExtreme,
  evalFundingChange,
  buildMicroAlertMessage,
  type MicroRuleConfig,
  type OrderBookSnapshot,
  type SymbolBaseline,
} from './rules.js'

const CFG: MicroRuleConfig = {
  obWarmup: 3,
  fundingWarmup: 5,
  spread: { medium: 2, high: 3, critical: 5 },
  depth: { medium: 0.7, high: 0.5, critical: 0.3 },
  imbalance: { medium: 3, high: 5, critical: 10 },
  fundingExtreme: { medium: 60, high: 80, critical: 94 }, // tail % = |pct-50|*2
  fundingChange: { medium: 0.0003, high: 0.0008 },
}

// A balanced book around mid 100: spread 0.1%, symmetric depth 10+10 within 0.5%.
function book(over: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    bids: [[99.95, 5], [99.9, 5], [99.0, 100]],   // last level is outside 0.5% band
    asks: [[100.05, 5], [100.1, 5], [101.0, 100]],
    ...over,
  }
}

describe('computeOrderBookMetrics', () => {
  it('computes mid, relative spread, near depth, imbalance', () => {
    const m = computeOrderBookMetrics(book())!
    expect(m.mid).toBeCloseTo(100)
    expect(m.spreadPct).toBeCloseTo(0.1) // (100.05-99.95)/100*100
    expect(m.bidDepth).toBe(10)  // 5+5 within 0.5% (99.5..100); 99.0 excluded
    expect(m.askDepth).toBe(10)
    expect(m.nearDepth).toBe(20)
    expect(m.imbalance).toBeCloseTo(0.5)
  })

  it('returns null for an empty side or a crossed book', () => {
    expect(computeOrderBookMetrics({ bids: [], asks: [[1, 1]] })).toBeNull()
    expect(computeOrderBookMetrics({ bids: [[101, 1]], asks: [[100, 1]] })).toBeNull() // crossed
  })

  it('reflects a bid-heavy book in imbalance', () => {
    const m = computeOrderBookMetrics(book({ bids: [[99.95, 40], [99.9, 0]], asks: [[100.05, 10]] }))!
    expect(m.bidDepth).toBe(40)
    expect(m.askDepth).toBe(10)
    expect(m.imbalance).toBeCloseTo(0.8)
  })
})

describe('baselines', () => {
  it('EWMA warms up from null and counts samples', () => {
    let b = emptyBaseline()
    const m = computeOrderBookMetrics(book())!
    b = updateOrderBookBaseline(b, m, 0.3)
    expect(b.spreadPctEwma).toBeCloseTo(0.1)
    expect(b.obSamples).toBe(1)
    b = updateOrderBookBaseline(b, { ...m, spreadPct: 0.2 }, 0.5)
    expect(b.spreadPctEwma).toBeCloseTo(0.15) // 0.5*0.2 + 0.5*0.1
  })

  it('funding history is capped and tracks lastFunding', () => {
    let b = emptyBaseline()
    for (const f of [1, 2, 3, 4]) b = updateFundingBaseline(b, f, 3)
    expect(b.fundingHistory).toEqual([2, 3, 4]) // capped to 3
    expect(b.lastFunding).toBe(4)
  })

  it('percentileRank', () => {
    expect(percentileRank(5, [1, 2, 3, 4, 5])).toBe(100)
    expect(percentileRank(3, [1, 2, 3, 4, 5])).toBe(60)
    expect(percentileRank(0, [1, 2, 3])).toBe(0)
  })
})

describe('spread_widening', () => {
  function warmBaseline(spreadEwma: number): SymbolBaseline {
    return { ...emptyBaseline(), spreadPctEwma: spreadEwma, obSamples: 5 }
  }
  it('stays silent before warm-up', () => {
    const m = computeOrderBookMetrics(book())!
    const cold = { ...warmBaseline(0.1), obSamples: 2 }
    expect(evalSpreadWidening({ ...m, spreadPct: 1 }, cold, CFG)).toBeNull()
  })
  it('fires medium/high/critical by ratio vs baseline', () => {
    const m = computeOrderBookMetrics(book())!
    expect(evalSpreadWidening({ ...m, spreadPct: 0.25 }, warmBaseline(0.1), CFG)?.severity).toBe('medium') // 2.5x
    expect(evalSpreadWidening({ ...m, spreadPct: 0.4 }, warmBaseline(0.1), CFG)?.severity).toBe('high')    // 4x
    expect(evalSpreadWidening({ ...m, spreadPct: 0.6 }, warmBaseline(0.1), CFG)?.severity).toBe('critical') // 6x
  })
  it('does not fire at normal spread', () => {
    const m = computeOrderBookMetrics(book())!
    expect(evalSpreadWidening({ ...m, spreadPct: 0.12 }, warmBaseline(0.1), CFG)).toBeNull()
  })
})

describe('depth_thinning', () => {
  const base: SymbolBaseline = { ...emptyBaseline(), nearDepthEwma: 100, obSamples: 5 }
  const m = computeOrderBookMetrics(book())!
  it('fires when depth drops below baseline ratios', () => {
    expect(evalDepthThinning({ ...m, nearDepth: 65 }, base, CFG)?.severity).toBe('medium')   // 65%
    expect(evalDepthThinning({ ...m, nearDepth: 45 }, base, CFG)?.severity).toBe('high')      // 45%
    expect(evalDepthThinning({ ...m, nearDepth: 25 }, base, CFG)?.severity).toBe('critical')  // 25%
  })
  it('silent when depth is healthy', () => {
    expect(evalDepthThinning({ ...m, nearDepth: 90 }, base, CFG)).toBeNull()
  })
})

describe('orderbook_imbalance', () => {
  const m = computeOrderBookMetrics(book())!
  it('fires on skew, names the heavy side', () => {
    const r = evalOrderbookImbalance({ ...m, bidDepth: 40, askDepth: 10 }, CFG)
    expect(r?.severity).toBe('medium') // 4x bid-heavy
    expect(r?.data).toContain('買方')
    expect(evalOrderbookImbalance({ ...m, bidDepth: 6, askDepth: 48 }, CFG)?.severity).toBe('high')     // 8x ask-heavy
    expect(evalOrderbookImbalance({ ...m, bidDepth: 6, askDepth: 60 }, CFG)?.severity).toBe('critical') // 10x ask-heavy
  })
  it('silent when roughly balanced', () => {
    expect(evalOrderbookImbalance({ ...m, bidDepth: 11, askDepth: 10 }, CFG)).toBeNull()
  })
})

describe('funding_extreme', () => {
  function hist(vals: number[]): SymbolBaseline {
    return { ...emptyBaseline(), fundingHistory: vals }
  }
  it('silent before funding warm-up', () => {
    expect(evalFundingExtreme(0.01, hist([0.001, 0.002]), CFG)).toBeNull()
  })
  it('fires when funding is in the tail of its own history', () => {
    const h = hist([0.0001, 0.0002, 0.0003, 0.0004, 0.0005, 0.0006])
    // 0.0006 is the max -> 100th pct -> tail 100 -> critical
    expect(evalFundingExtreme(0.0006, h, CFG)?.severity).toBe('critical')
  })
  it('silent near the median', () => {
    const h = hist([0.0001, 0.0002, 0.0003, 0.0004, 0.0005, 0.0006])
    expect(evalFundingExtreme(0.00035, h, CFG)).toBeNull()
  })
})

describe('funding_change', () => {
  const b: SymbolBaseline = { ...emptyBaseline(), lastFunding: 0.0001 }
  it('fires on a large delta', () => {
    expect(evalFundingChange(0.0005, b, CFG)?.severity).toBe('medium')  // delta 0.0004
    expect(evalFundingChange(0.001, b, CFG)?.severity).toBe('high')     // delta 0.0009
  })
  it('fires medium on a sign flip even if small', () => {
    expect(evalFundingChange(-0.0001, b, CFG)?.severity).toBe('medium')
  })
  it('silent on a small same-sign move', () => {
    expect(evalFundingChange(0.00012, b, CFG)).toBeNull()
  })
})

describe('buildMicroAlertMessage', () => {
  it('renders 3-part Data/Interpretation/Action and the top severity', () => {
    const msg = buildMicroAlertMessage('BTCUSDT', [
      { type: 'spread_widening', severity: 'high', data: 'D1', interpretation: 'I1', action: 'A1' },
      { type: 'funding_extreme', severity: 'critical', data: 'D2', interpretation: 'I2', action: 'A2' },
    ])
    expect(msg).toContain('BTCUSDT 微結構警報 — 嚴重')
    expect(msg).toContain('· 買賣價差變大')
    expect(msg).toContain('數據：D1')
    expect(msg).toContain('研判：I2')
    expect(msg).toContain('建議：A2')
  })
})
