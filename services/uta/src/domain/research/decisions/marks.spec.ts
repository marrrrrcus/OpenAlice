import { describe, it, expect } from 'vitest'
import { computeHorizonMark, type DailyCandleInput } from './marks.js'

const c = (dateUtc: string, open: number, high: number, low: number, close: number): DailyCandleInput =>
  ({ dateUtc, open: String(open), high: String(high), low: String(low), close: String(close) })

describe('computeHorizonMark (pinned anchor = next-daily-open)', () => {
  const candles = [
    c('2026-07-03', 100, 110, 95, 105), // anchor
    c('2026-07-04', 105, 120, 100, 118),
    c('2026-07-05', 118, 119, 90, 92),
  ]

  it('LONG 3D: ret from anchor open to exit close; MAE = worst low; MFE = best high', () => {
    const r = computeHorizonMark({ side: 'LONG', anchorDateUtc: '2026-07-03', horizonDays: 3, candles })
    if (!r.ok) throw new Error(r.reason)
    expect(r.entryPrice).toBe('100')
    expect(r.exitPrice).toBe('92')
    expect(r.ret).toBe('-0.08')      // (92/100 − 1)
    expect(r.mae).toBe('-0.1')       // low 90 → −10%
    expect(r.mfe).toBe('0.2')        // high 120 → +20%
    expect(r.entryOpenDateUtc).toBe('2026-07-03')
    expect(r.exitCloseDateUtc).toBe('2026-07-05')
  })

  it('SHORT 3D: signs flip — adverse is the high, favorable is the low', () => {
    const r = computeHorizonMark({ side: 'SHORT', anchorDateUtc: '2026-07-03', horizonDays: 3, candles })
    if (!r.ok) throw new Error(r.reason)
    expect(r.ret).toBe('0.08')
    expect(r.mae).toBe('-0.2')  // high 120 hurts a short by −20%
    expect(r.mfe).toBe('0.1')   // low 90 favors a short by +10%
  })

  it('1D horizon: exit day = anchor day itself', () => {
    const r = computeHorizonMark({ side: 'LONG', anchorDateUtc: '2026-07-03', horizonDays: 1, candles })
    if (!r.ok) throw new Error(r.reason)
    expect(r.exitCloseDateUtc).toBe('2026-07-03')
    expect(r.ret).toBe('0.05')
  })

  it('missing anchor or exit candle → explicit refusal, never a guess', () => {
    const noAnchor = computeHorizonMark({ side: 'LONG', anchorDateUtc: '2026-07-02', horizonDays: 1, candles })
    expect(noAnchor.ok).toBe(false)
    const noExit = computeHorizonMark({ side: 'LONG', anchorDateUtc: '2026-07-03', horizonDays: 7, candles })
    expect(noExit.ok).toBe(false)
  })

  it('gaps INSIDE the window are tolerated (extremes over existing days)', () => {
    const gappy = [candles[0], candles[2]] // 07-04 missing
    const r = computeHorizonMark({ side: 'LONG', anchorDateUtc: '2026-07-03', horizonDays: 3, candles: gappy })
    if (!r.ok) throw new Error(r.reason)
    expect(r.mfe).toBe('0.19') // high 119, not 120 (the missing day can't contribute)
  })
})
