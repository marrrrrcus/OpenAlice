import { describe, expect, it } from 'vitest'
import { computeStressRebound, transitionKey, type StressDailyCandle, type StressReboundParams } from './machine.js'

const P: StressReboundParams = {
  sma60: 3,
  sma120: 4,
  sma200: 5,
  sma240: 6,
  drawdownPct: '20',
  reboundMultiple: '1.15',
  timeoutDays: 2,
}

function days(closes: readonly number[], start = '2026-01-01'): StressDailyCandle[] {
  const startMs = Date.parse(`${start}T00:00:00Z`)
  return closes.map((close, i) => ({
    dateUtc: new Date(startMs + i * 86_400_000).toISOString().slice(0, 10),
    close: String(close),
    low: String(close - 1),
  }))
}

describe('BTC Stress Rebound state machine', () => {
  it('enters stress_watch from event-local peak drawdown, not from a fixed rolling peak', () => {
    const r = computeStressRebound(days([100, 100, 100, 100, 100, 100, 79]), P)
    expect(r.ok).toBe(true)
    expect(r.latest?.state).toBe('stress_watch')
    expect(r.latest?.eventPeakClose).toBe('100')
    expect(r.latest?.troughClose).toBe('79')
    expect(r.latest?.reasonLines.some(line => line.includes('SMA200'))).toBe(true)
    expect(r.latest?.reasonLines.some(line => line.includes('SMA240'))).toBe(true)
    expect(r.transitions[0].reasonLines.some(line => line.includes('自這波高點回撤'))).toBe(true)
    expect(r.transitions.map(t => t.type)).toEqual(['enter_stress_watch'])
  })

  it('updates trough_close and rebound_line without emitting a transition', () => {
    const r = computeStressRebound(days([100, 100, 100, 100, 100, 100, 79, 75]), P)
    expect(r.latest?.state).toBe('stress_watch')
    expect(r.latest?.troughClose).toBe('75')
    expect(r.latest?.reboundLine).toBe('86.25')
    expect(r.transitions.map(t => t.type)).toEqual(['enter_stress_watch'])
  })

  it('confirms rebound at trough_close * 1.15', () => {
    const r = computeStressRebound(days([100, 100, 100, 100, 100, 100, 75, 86.25]), P)
    expect(r.latest?.state).toBe('rebound_confirmed')
    expect(r.latest?.reboundLine).toBe('86.25')
    expect(r.transitions.map(t => t.type)).toEqual(['enter_stress_watch', 'rebound_confirmed'])
  })

  it('failure uses daily close below trough_close, then returns to stress_watch with a new trough', () => {
    const r = computeStressRebound(days([100, 100, 100, 100, 100, 100, 75, 86.25, 74]), P)
    expect(r.latest?.state).toBe('stress_watch')
    expect(r.latest?.troughClose).toBe('74')
    expect(r.transitions.map(t => t.type)).toEqual(['enter_stress_watch', 'rebound_confirmed', 'failure'])
  })

  it('times out when rebound_confirmed fails to reach structure_repair within the pinned window', () => {
    const r = computeStressRebound(days([100, 100, 100, 100, 100, 100, 75, 86.25, 86, 86]), P)
    expect(r.latest?.state).toBe('stress_watch')
    expect(r.transitions.map(t => t.type)).toContain('timeout')
  })

  it('collapses same-day multiple thresholds into the highest repair transition', () => {
    const r = computeStressRebound(days([100, 100, 100, 100, 100, 100, 75, 130]), P)
    expect(r.latest?.state).toBe('normal')
    expect(r.transitions.map(t => t.type)).toEqual(['enter_stress_watch', 'long_term_repair'])
  })

  it('resets event_peak_close after long_term_repair', () => {
    const r = computeStressRebound(days([100, 100, 100, 100, 100, 100, 75, 130, 105]), P)
    expect(r.latest?.state).toBe('normal')
    expect(r.latest?.eventPeakClose).toBe('130')
  })

  it('fails closed when completed daily candles have a calendar gap', () => {
    const input = days([100, 100, 100, 100, 100, 100, 79])
    input[input.length - 1].dateUtc = '2026-02-15'
    const r = computeStressRebound(input, P)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('missing UTC daily candle')
    expect(r.transitions).toHaveLength(0)
  })

  it('fails closed when completed daily candles have a duplicate date', () => {
    const input = days([100, 100, 100, 100, 100, 100, 79])
    input[input.length - 1].dateUtc = input[input.length - 2].dateUtc
    const r = computeStressRebound(input, P)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('duplicate UTC daily candle date')
    expect(r.transitions).toHaveLength(0)
  })

  it('transitionKey includes event type, not only destination state', () => {
    const r = computeStressRebound(days([100, 100, 100, 100, 100, 100, 75, 86.25, 74]), P)
    const keys = r.transitions.map(transitionKey)
    expect(keys.some(k => k.endsWith(':stress_watch:failure'))).toBe(true)
    expect(keys.some(k => k.endsWith(':stress_watch:enter_stress_watch'))).toBe(true)
  })
})
