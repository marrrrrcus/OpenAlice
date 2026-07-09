import { describe, expect, it } from 'vitest'
import { buildMarketStateReport } from './market-state-report.js'
import type { MarketStateAlertConfig } from '@/core/config.js'
import type { BinanceKlineRow } from './stress-rebound/binance.js'

function config(): MarketStateAlertConfig {
  return {
    enabled: true,
    every: '1h',
    symbol: 'BTCUSDT',
    historyLimit: 1000,
    drawdownPct: 20,
    reboundMultiple: 1.15,
    timeoutDays: 60,
    smas: { sma60: 60, sma120: 120, sma200: 200, sma240: 240 },
    statePath: 'data/market-state-alert-state.json',
  }
}

function rows(closes: readonly number[], start = '2026-01-01'): BinanceKlineRow[] {
  const startMs = Date.parse(`${start}T00:00:00Z`)
  return closes.map((close, i) => {
    const open = startMs + i * 86_400_000
    return [open, String(close), String(close + 1), String(close - 1), String(close), '1', open + 86_400_000 - 1]
  })
}

describe('market_state_report', () => {
  it('reports the current stress_watch fixture without giving an order instruction', async () => {
    const report = await buildMarketStateReport({
      config: config(),
      now: () => new Date('2026-09-01T12:00:00Z'),
      fetchKlines: async () => rows([...Array(240).fill(80000), 58600, 61900]),
    })

    expect(report.status).toBe('ok')
    expect(report.state).toBe('stress_watch')
    expect(report.troughClose).toBe('58600')
    expect(report.reboundLine).toBe('67390')
    expect(report.reasonLines?.some(line => line.includes('SMA200'))).toBe(true)
    expect(report.nextTrigger).toContain('rebound_confirmed')
    const rendered = JSON.stringify(report).toLowerCase()
    expect(rendered).not.toContain('buy')
    expect(rendered).not.toContain('sell')
    expect(rendered).not.toContain('safe')
    expect(rendered).not.toContain('validated')
  })

  it('returns UNKNOWN when daily candles cannot be fetched', async () => {
    const report = await buildMarketStateReport({
      config: config(),
      now: () => new Date('2026-09-01T12:00:00Z'),
      fetchKlines: async () => { throw new Error('binance unavailable') },
    })
    expect(report.status).toBe('unknown')
    expect(report.reason).toContain('binance unavailable')
  })

  it('returns UNKNOWN when completed daily candles are not calendar-contiguous', async () => {
    const brokenRows = rows([...Array(240).fill(80000), 58600, 61900]).filter((_, i) => i !== 120)

    const report = await buildMarketStateReport({
      config: config(),
      now: () => new Date('2026-09-01T12:00:00Z'),
      fetchKlines: async () => brokenRows,
    })

    expect(report.status).toBe('unknown')
    expect(report.reason).toContain('missing UTC daily candle')
    expect(report.state).toBeUndefined()
    expect(report.nextTrigger).toBeUndefined()
  })
})
