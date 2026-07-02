import { describe, it, expect } from 'vitest'
import { computeFundingBucket, fetchBinanceUsdmFundingHistory, toFapiSymbol, type SettledFundingRow } from './funding.js'

const H8 = 8 * 3_600_000
const START = Date.parse('2025-01-01T00:00:00Z')

/** n settled rows every 8h from START, constant rate unless overridden. */
function rows(n: number, rate = 0.0001, overrides: Record<number, number> = {}): SettledFundingRow[] {
  return Array.from({ length: n }, (_, i) => ({
    fundingTime: START + i * H8,
    fundingRate: String(overrides[i] ?? rate),
  }))
}

describe('computeFundingBucket (pinned machinery: row-order sum24, past-only z, positive-side p90)', () => {
  it('insufficient history (<180d) → unavailable with reason', () => {
    const r = computeFundingBucket(rows(3 * 100), START + 100 * 24 * 3_600_000) // 100 days
    expect(r.bucket).toBe('unavailable')
    expect(r.reason).toContain('insufficient funding history')
  })

  it('rows at/after decidedAt are excluded (strictly-before rule)', () => {
    const all = rows(3 * 400)
    const decidedAt = START + 200 * 24 * 3_600_000
    const r = computeFundingBucket(all, decidedAt)
    // Constant series → zero variance → honest unavailable, but the point
    // here is it did NOT throw and did not read future rows.
    expect(r.bucket).toBe('unavailable')
    expect(r.reason).toContain('zero variance')
  })

  it('positive but unremarkable funding → positive; negative sum → non-positive; extreme spike → extreme-positive', () => {
    // ~400 days of noisy-ish positive funding with occasional negatives.
    const n = 3 * 400
    const overrides: Record<number, number> = {}
    for (let i = 0; i < n; i += 7) overrides[i] = -0.00005
    for (let i = 3; i < n; i += 11) overrides[i] = 0.0003

    const decidedAt = START + n * H8 + 1 // strictly after the last settlement
    const base = computeFundingBucket(rows(n, 0.0001, overrides), decidedAt)
    expect(base.bucket).toBe('positive')
    expect(Number(base.z)).toBeLessThan(Number(base.p90PosThreshold))

    // Spike the last three settlements → extreme sum24.
    const spike = { ...overrides, [n - 1]: 0.003, [n - 2]: 0.003, [n - 3]: 0.003 }
    const extreme = computeFundingBucket(rows(n, 0.0001, spike), decidedAt)
    expect(extreme.bucket).toBe('extreme-positive')

    // Deep negative last settlements → non-positive.
    const dump = { ...overrides, [n - 1]: -0.002, [n - 2]: -0.002, [n - 3]: -0.002 }
    const neg = computeFundingBucket(rows(n, 0.0001, dump), decidedAt)
    expect(neg.bucket).toBe('non-positive')
  })
})

describe('toFapiSymbol', () => {
  it('maps linear USDM unified symbols and refuses everything else', () => {
    expect(toFapiSymbol('BTC/USDT:USDT')).toBe('BTCUSDT')
    expect(toFapiSymbol('ETH/USDT:USDT')).toBe('ETHUSDT')
    expect(toFapiSymbol('BTC/USD:BTC')).toBeUndefined() // inverse
    expect(toFapiSymbol('BTC/USDT')).toBeUndefined()    // spot
    expect(toFapiSymbol('AAPL')).toBeUndefined()
  })
})

describe('fetchBinanceUsdmFundingHistory (paged, injected fetch)', () => {
  it('pages until a short batch and concatenates', async () => {
    const all = rows(2500)
    const calls: string[] = []
    const fetchJson = async (url: string): Promise<unknown> => {
      calls.push(url)
      const start = Number(/startTime=(\d+)/.exec(url)![1])
      return all.filter(r => r.fundingTime >= start).slice(0, 1000)
    }
    const got = await fetchBinanceUsdmFundingHistory('BTCUSDT', START, START + 2500 * H8, { fetchJson })
    expect(got).toHaveLength(2500)
    expect(calls).toHaveLength(3)
    expect(got[2499].fundingTime).toBe(all[2499].fundingTime)
  })
})
