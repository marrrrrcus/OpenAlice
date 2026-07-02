import { describe, it, expect } from 'vitest'
import { computeZone } from '../../../trading/risk-gates/regime/zone.js'
import type { KlineRow } from '../../../trading/risk-gates/regime/provider.js'
import { regimeTrendV0Shadow } from './regime-trend-v0-shadow.js'

const DAY = 86_400_000
const START = Date.parse('2024-01-01T00:00:00Z')

function klinesOf(closes: (number | string)[]): KlineRow[] {
  return closes.map((c, i) => {
    const open = START + i * DAY
    const s = String(c)
    return [open, s, s, s, s, '0', open + DAY - 1] as KlineRow
  })
}

describe('regime-trend-v0-shadow (REJECTED-rule harness control)', () => {
  it('BULL → long (agrees with computeZone)', () => {
    const closes = [...Array(210).fill(100), 110]
    const zone = computeZone(closes)
    expect(zone.ok && zone.zone).toBe('BULL')
    const res = regimeTrendV0Shadow.compute({ klines: klinesOf(closes) })
    expect(res.stance).toBe('long')
    if (res.stance === 'unknown') return
    expect(res.meta?.['zone']).toBe('BULL')
  })

  it('BEAR → flat (long/flat rule — never short)', () => {
    const closes = [...Array(210).fill(100), 90]
    const zone = computeZone(closes)
    expect(zone.ok && zone.zone).toBe('BEAR')
    const res = regimeTrendV0Shadow.compute({ klines: klinesOf(closes) })
    expect(res.stance).toBe('flat')
  })

  it('GRAY carries the chained prevStance — both directions', () => {
    const closes = [...Array(211).fill(100)] // flat history: GRAY
    expect(regimeTrendV0Shadow.compute({ klines: klinesOf(closes), prevStance: 'long' }).stance).toBe('long')
    expect(regimeTrendV0Shadow.compute({ klines: klinesOf(closes), prevStance: 'flat' }).stance).toBe('flat')
  })

  it('cold start reconstructs from the most recent band exit: BULL exit → long', () => {
    // Flat 100s, a 110 spike (BULL day), then 100s again (GRAY) — today is
    // GRAY with no chain; the walk must find the BULL exit.
    const closes = [...Array(220).fill(100), 110, ...Array(5).fill(100)]
    const res = regimeTrendV0Shadow.compute({ klines: klinesOf(closes) })
    expect(res.stance).toBe('long')
    if (res.stance === 'unknown') return
    expect(res.meta?.['coldStartZone']).toBe('BULL')
    expect(res.meta?.['coldStartFrom']).toBeTruthy()
  })

  it('cold start reconstructs a BEAR exit → flat', () => {
    const closes = [...Array(220).fill(100), 90, ...Array(5).fill(100)]
    const res = regimeTrendV0Shadow.compute({ klines: klinesOf(closes) })
    expect(res.stance).toBe('flat')
    if (res.stance === 'unknown') return
    expect(res.meta?.['coldStartZone']).toBe('BEAR')
  })

  it('a window with no band exit is unknown — the honest cold-start answer', () => {
    const res = regimeTrendV0Shadow.compute({ klines: klinesOf(Array(500).fill(100)) })
    expect(res.stance).toBe('unknown')
    if (res.stance !== 'unknown') return
    expect(res.reason).toContain('indeterminate')
  })

  it('insufficient history for the SMA is unknown, never a crash', () => {
    const res = regimeTrendV0Shadow.compute({ klines: klinesOf(Array(150).fill(100)) })
    expect(res.stance).toBe('unknown')
  })

  it('registration fields are pinned', () => {
    expect(regimeTrendV0Shadow.id).toBe('regime-trend-v0-shadow')
    expect(regimeTrendV0Shadow.symbol).toBe('BTCUSDT')
    expect(regimeTrendV0Shadow.venue).toBe('binance_spot')
    expect(regimeTrendV0Shadow.registrationDoc).toBe('docs/shadow-strategies/regime-trend-v0-shadow.md')
    expect(regimeTrendV0Shadow.dataNeeds).toEqual({ kinds: ['klines'], minDays: 500 })
  })
})
