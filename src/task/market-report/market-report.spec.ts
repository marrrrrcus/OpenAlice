import { describe, it, expect } from 'vitest'
import {
  detectSymbolEvents,
  defaultSymbolState,
  buildQuietSummary,
  buildEventPrompt,
  type SymbolObservation,
  type SymbolReportState,
} from './market-report.js'

const RULES = { oversold: 30, overbought: 70, releaseBuffer: 5 }

function obs(over: Partial<SymbolObservation> = {}): SymbolObservation {
  return { label: 'BTC', price: 64000, rsi: 50, todayHigh: 64500, todayLow: 63000, ...over }
}

describe('detectSymbolEvents — RSI hysteresis', () => {
  it('fires rsi_oversold once when crossing below threshold from neutral', () => {
    const prev = { ...defaultSymbolState(), lastReportedPrice: 64000 }
    const { events, next } = detectSymbolEvents(obs({ rsi: 28 }), prev, RULES, 1)
    expect(events.map((e) => e.kind)).toEqual(['rsi_oversold'])
    expect(next.rsiZone).toBe('oversold')
  })

  it('stays silent while RSI remains below threshold (no re-fire)', () => {
    const prev: SymbolReportState = { rsiZone: 'oversold', lastRsi: 28, lastReportedPrice: 64000 }
    const { events, next } = detectSymbolEvents(obs({ rsi: 26 }), prev, RULES, 1)
    expect(events).toEqual([])
    expect(next.rsiZone).toBe('oversold')
  })

  it('stays silent inside the hysteresis buffer band (30–35 oscillation)', () => {
    const prev: SymbolReportState = { rsiZone: 'oversold', lastRsi: 29, lastReportedPrice: 64000 }
    const { events, next } = detectSymbolEvents(obs({ rsi: 33 }), prev, RULES, 1)
    expect(events).toEqual([])
    expect(next.rsiZone).toBe('oversold')
  })

  it('fires rsi_recovered only after RSI clears oversold + buffer', () => {
    const prev: SymbolReportState = { rsiZone: 'oversold', lastRsi: 33, lastReportedPrice: 64000 }
    const { events, next } = detectSymbolEvents(obs({ rsi: 36 }), prev, RULES, 1)
    expect(events.map((e) => e.kind)).toEqual(['rsi_recovered'])
    expect(next.rsiZone).toBe('neutral')
  })

  it('can re-fire oversold after a full recover cycle', () => {
    let state: SymbolReportState = { ...defaultSymbolState(), lastReportedPrice: 64000 }
    // dip → fire
    let r = detectSymbolEvents(obs({ rsi: 29 }), state, RULES, 1)
    expect(r.events.map((e) => e.kind)).toEqual(['rsi_oversold'])
    state = { ...r.next, lastReportedPrice: 64000 }
    // recover → fire
    r = detectSymbolEvents(obs({ rsi: 40 }), state, RULES, 1)
    expect(r.events.map((e) => e.kind)).toEqual(['rsi_recovered'])
    state = { ...r.next, lastReportedPrice: 64000 }
    // dip again → fires again
    r = detectSymbolEvents(obs({ rsi: 29 }), state, RULES, 1)
    expect(r.events.map((e) => e.kind)).toEqual(['rsi_oversold'])
  })

  it('fires rsi_overbought / rsi_cooled symmetrically', () => {
    let state: SymbolReportState = { ...defaultSymbolState(), lastReportedPrice: 64000 }
    let r = detectSymbolEvents(obs({ rsi: 72 }), state, RULES, 1)
    expect(r.events.map((e) => e.kind)).toEqual(['rsi_overbought'])
    state = { ...r.next, lastReportedPrice: 64000 }
    // inside buffer (65–70) → silent
    r = detectSymbolEvents(obs({ rsi: 67 }), state, RULES, 1)
    expect(r.events).toEqual([])
    state = { ...r.next, lastReportedPrice: 64000 }
    r = detectSymbolEvents(obs({ rsi: 63 }), state, RULES, 1)
    expect(r.events.map((e) => e.kind)).toEqual(['rsi_cooled'])
  })

  it('handles null RSI without firing or corrupting zone state', () => {
    const prev: SymbolReportState = { rsiZone: 'oversold', lastRsi: 28, lastReportedPrice: 64000 }
    const { events, next } = detectSymbolEvents(obs({ rsi: null }), prev, RULES, 1)
    expect(events).toEqual([])
    expect(next.rsiZone).toBe('oversold')
    expect(next.lastRsi).toBe(28)
  })
})

describe('detectSymbolEvents — price move', () => {
  it('fires when price moves beyond threshold vs last reported price', () => {
    const prev: SymbolReportState = { rsiZone: 'neutral', lastRsi: 50, lastReportedPrice: 64000 }
    const { events } = detectSymbolEvents(obs({ price: 64700 }), prev, RULES, 1)
    expect(events.map((e) => e.kind)).toEqual(['price_move'])
    expect(events[0].detail).toContain('上漲')
  })

  it('fires on downward moves too', () => {
    const prev: SymbolReportState = { rsiZone: 'neutral', lastRsi: 50, lastReportedPrice: 64000 }
    const { events } = detectSymbolEvents(obs({ price: 63200 }), prev, RULES, 1)
    expect(events.map((e) => e.kind)).toEqual(['price_move'])
    expect(events[0].detail).toContain('下跌')
  })

  it('stays silent below threshold', () => {
    const prev: SymbolReportState = { rsiZone: 'neutral', lastRsi: 50, lastReportedPrice: 64000 }
    const { events } = detectSymbolEvents(obs({ price: 64300 }), prev, RULES, 1)
    expect(events).toEqual([])
  })

  it('anchors baseline on first observation without firing', () => {
    const { events, next } = detectSymbolEvents(obs({ price: 64000 }), defaultSymbolState(), RULES, 1)
    expect(events).toEqual([])
    expect(next.lastReportedPrice).toBe(64000)
  })
})

describe('message builders', () => {
  it('buildQuietSummary renders one line per symbol', () => {
    const s = buildQuietSummary(
      [obs(), obs({ label: 'ETH', price: 1683.5, rsi: 41.2 })],
      null,
    )
    expect(s).toContain('BTC $64000')
    expect(s).toContain('ETH $1683.5')
    expect(s).toContain('RSI 41.2')
  })

  it('buildQuietSummary appends stale note when present', () => {
    const s = buildQuietSummary([obs()], '⚠️ 快照過期')
    expect(s).toContain('⚠️ 快照過期')
  })

  it('buildEventPrompt embeds data, events, and the no-tools instruction', () => {
    const p = buildEventPrompt(
      [obs({ rsi: 28.5 })],
      [{ label: 'BTC', kind: 'rsi_oversold', detail: 'RSI 28.50 跌破 30（超賣）' }],
      { BTC: 34.7 },
      undefined,
    )
    expect(p).toContain('現價 $64000')
    expect(p).toContain('RSI(14) 28.50')
    expect(p).toContain('上次 34.70')
    expect(p).toContain('跌破 30')
    expect(p).toContain('請勿呼叫任何工具')
    expect(p).toContain('150 字')
  })
})
