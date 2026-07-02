import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import Decimal from 'decimal.js'
import { computeZone, SMA_WINDOW } from './zone.js'

describe('computeZone', () => {
  // 200 closes all at 100 → SMA = 100, band = [97, 103]
  const flat = Array(SMA_WINDOW).fill('100')

  function withLastClose(close: string): string[] {
    return [...flat.slice(0, SMA_WINDOW - 1), close]
  }

  it('needs at least 200 closes', () => {
    const r = computeZone(Array(199).fill('100'))
    expect(r.ok).toBe(false)
  })

  it('band edges are EXACT: close must be strictly beyond ×1.03 / ×0.97', () => {
    // SMA changes when the last close changes — compute expected bands from
    // the actual SMA rather than assuming 100.
    const probe = (close: string) => {
      const r = computeZone(withLastClose(close))
      if (!r.ok) throw new Error(r.error)
      const sma = new Decimal(r.sma200)
      const upper = sma.mul('1.03')
      const lower = sma.mul('0.97')
      return { zone: r.zone, close: new Decimal(r.close), upper, lower }
    }

    const bull = probe('110')
    expect(bull.close.gt(bull.upper)).toBe(true)
    expect(bull.zone).toBe('BULL')

    const bear = probe('90')
    expect(bear.close.lt(bear.lower)).toBe(true)
    expect(bear.zone).toBe('BEAR')

    const gray = probe('100')
    expect(gray.zone).toBe('GRAY')

    // Exactly ON the boundary is GRAY (strict inequality — matches the study).
    // With 199 closes at 100 and last close c: sma = (19900 + c)/200.
    // c = sma×1.03 → c = 19900×1.03/(200−1.03) = 103.0316…; verify strictness
    // numerically: a close equal to its own upper band must be GRAY.
    const c = new Decimal('19900').mul('1.03').div(new Decimal('200').minus('1.03'))
    const exact = computeZone(withLastClose(c.toFixed(20)))
    if (!exact.ok) throw new Error(exact.error)
    expect(exact.zone).toBe('GRAY')
  })

  it('uses only the LAST 200 closes (rolling window)', () => {
    // 100 old closes at 1000 must not affect the SMA of the last 200 at 100.
    const closes = [...Array(100).fill('1000'), ...Array(SMA_WINDOW).fill('100')]
    const r = computeZone(closes)
    if (!r.ok) throw new Error(r.error)
    expect(r.sma200).toBe('100')
    expect(r.zone).toBe('GRAY')
  })
})

describe('REPLAY PARITY — live zone computation vs the validated study artifact', () => {
  it('matches daily_regime_zones.csv exactly (zero mismatches)', () => {
    const csvPath = fileURLToPath(new URL('./__fixtures__/daily_regime_zones.csv', import.meta.url))
    const lines = readFileSync(csvPath, 'utf-8').trim().split(/\r?\n/)
    const header = lines[0].split(',')
    const closeIdx = header.indexOf('close')
    const zoneIdx = header.indexOf('regime_zone')
    const dateIdx = header.indexOf('date')
    expect(closeIdx).toBeGreaterThanOrEqual(0)
    expect(zoneIdx).toBeGreaterThanOrEqual(0)

    const closes: string[] = []
    const mismatches: string[] = []
    let compared = 0

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',')
      closes.push(cols[closeIdx])
      const expected = cols[zoneIdx]
      if (expected === 'WARMUP') continue
      const window = closes.slice(-200)
      const r = computeZone(window)
      if (!r.ok) {
        mismatches.push(`${cols[dateIdx]}: compute failed (${r.error})`)
        continue
      }
      compared++
      if (r.zone !== expected) {
        mismatches.push(`${cols[dateIdx]}: computed ${r.zone}, study says ${expected} (close=${cols[closeIdx]}, sma=${r.sma200})`)
      }
    }

    expect(compared).toBeGreaterThan(2900) // sanity: the artifact really was replayed
    expect(mismatches).toEqual([])
  })
})
