import { describe, it, expect, vi } from 'vitest'
import { createRegimeProvider, type KlineRow, type RegimeSourceConfig } from './provider.js'

const DAY = 86_400_000
const CFG: RegimeSourceConfig = {
  regimeSource: { venue: 'binance_spot', symbol: 'BTCUSDT' },
  regimeStaleAfterHours: 30,
}

/** Build daily klines ending with a candle that CLOSES at `lastCloseMs`. */
function makeKlines(closes: number[], lastCloseMs: number): KlineRow[] {
  return closes.map((c, i) => {
    const closeTime = lastCloseMs - (closes.length - 1 - i) * DAY
    return [closeTime - DAY, String(c), String(c), String(c), String(c), '0', closeTime] as KlineRow
  })
}

describe('regime provider', () => {
  const NOW = Date.parse('2026-06-15T12:00:00Z')

  it('computes the zone from completed candles and reports freshness', async () => {
    // 200 flat closes at 100, then a final completed candle at 110 → BULL.
    const closes = [...Array(210).fill(100), 110]
    const fetchKlines = vi.fn(async () => makeKlines(closes, NOW - 12 * 3_600_000))
    const p = createRegimeProvider({ fetchKlines, now: () => new Date(NOW) })
    const r = await p.getReading(CFG)
    expect(r.zone).toBe('BULL')
    expect(r.close).toBe('110')
    expect(r.dataAgeHours).toBeCloseTo(12, 5)
    expect(r.computedFrom).toBeTruthy()
  })

  it('DISCARDS the in-progress candle (closeTime in the future)', async () => {
    // Completed history is flat GRAY; a wild in-progress candle at 500 must
    // not leak into the SMA or become "the close".
    const completed = makeKlines([...Array(210).fill(100)], NOW - 6 * 3_600_000)
    const inProgress: KlineRow = [NOW - DAY, '500', '500', '500', '500', '0', NOW + 6 * 3_600_000]
    const fetchKlines = vi.fn(async () => [...completed, inProgress])
    const p = createRegimeProvider({ fetchKlines, now: () => new Date(NOW) })
    const r = await p.getReading(CFG)
    expect(r.zone).toBe('GRAY')
    expect(r.close).toBe('100')
  })

  it('stale newest candle → UNKNOWN (UNKNOWN is not SAFE)', async () => {
    const fetchKlines = vi.fn(async () => makeKlines([...Array(210).fill(100)], NOW - 31 * 3_600_000))
    const p = createRegimeProvider({ fetchKlines, now: () => new Date(NOW) })
    const r = await p.getReading(CFG)
    expect(r.zone).toBe('UNKNOWN')
    expect(r.reason).toContain('stale')
  })

  it('fetch failure → UNKNOWN with the reason', async () => {
    const fetchKlines = vi.fn(async () => { throw new Error('binance down') })
    const p = createRegimeProvider({ fetchKlines, now: () => new Date(NOW) })
    const r = await p.getReading(CFG)
    expect(r.zone).toBe('UNKNOWN')
    expect(r.reason).toContain('binance down')
  })

  it('insufficient history (<200 completed candles) → UNKNOWN', async () => {
    const fetchKlines = vi.fn(async () => makeKlines([...Array(150).fill(100)], NOW - 6 * 3_600_000))
    const p = createRegimeProvider({ fetchKlines, now: () => new Date(NOW) })
    const r = await p.getReading(CFG)
    expect(r.zone).toBe('UNKNOWN')
    expect(r.reason).toContain('insufficient history')
  })

  it('a cached good reading is re-validated against the CURRENT staleness config', async () => {
    // Good reading at NOW (data 6h old). Later the same UTC day, the clock
    // has advanced far enough that the same data violates the bound — the
    // cache must NOT keep vouching for it.
    const klines = makeKlines([...Array(210).fill(100), 110], NOW - 6 * 3_600_000)
    let clock = NOW
    const fetchKlines = vi.fn(async () => klines)
    const p = createRegimeProvider({ fetchKlines, now: () => new Date(clock) })

    expect((await p.getReading(CFG)).zone).toBe('BULL')
    // +8h, same UTC day (NOW is 12:00Z): data is now 14h old — still fine at 30h.
    clock = NOW + 8 * 3_600_000
    expect((await p.getReading(CFG)).zone).toBe('BULL')
    // Operator tightens the bound to 10h: the cached reading (14h old) must
    // be rejected and recomputed — which now yields UNKNOWN (stale).
    const tight = { ...CFG, regimeStaleAfterHours: 10 }
    const r = await p.getReading(tight)
    expect(r.zone).toBe('UNKNOWN')
    expect(r.reason).toContain('stale')
  })

  it('unsupported venue → UNKNOWN (never silently substitutes Binance)', async () => {
    const fetchKlines = vi.fn(async () => makeKlines([...Array(210).fill(100)], NOW - 6 * 3_600_000))
    const p = createRegimeProvider({ fetchKlines, now: () => new Date(NOW) })
    const r = await p.getReading({ ...CFG, regimeSource: { venue: 'coinbase_spot', symbol: 'BTCUSDT' } })
    expect(r.zone).toBe('UNKNOWN')
    expect(r.reason).toContain('unsupported regime venue')
    expect(fetchKlines).not.toHaveBeenCalled()
  })

  it('good readings are cached for the UTC day; failures retry after a short TTL', async () => {
    const good = makeKlines([...Array(210).fill(100), 110], NOW - 6 * 3_600_000)
    let clock = NOW
    const fetchKlines = vi.fn(async () => good)
    const p = createRegimeProvider({ fetchKlines, now: () => new Date(clock) })

    await p.getReading(CFG)
    await p.getReading(CFG)
    clock += 3_600_000 // +1h, same UTC day
    await p.getReading(CFG)
    expect(fetchKlines).toHaveBeenCalledTimes(1) // day-cached

    // Failure path: new provider, failing fetch — retried only after TTL.
    const failing = vi.fn(async () => { throw new Error('down') })
    let clock2 = NOW
    const p2 = createRegimeProvider({ fetchKlines: failing, now: () => new Date(clock2) })
    await p2.getReading(CFG)
    clock2 += 10_000 // within the 60s failure TTL — cached UNKNOWN
    await p2.getReading(CFG)
    expect(failing).toHaveBeenCalledTimes(1)
    clock2 += 120_000 // past the TTL — retried
    await p2.getReading(CFG)
    expect(failing).toHaveBeenCalledTimes(2)
  })
})
