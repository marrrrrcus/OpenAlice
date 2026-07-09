import { describe, expect, it } from 'vitest'
import { buildLiveReadinessReport } from './live-readiness-report.js'
import type {
  AutoTradingConfig,
  MarketStateAlertConfig,
  MicrostructureAlertConfig,
} from '@/core/config.js'

const autoTradingOff: AutoTradingConfig = {
  enabled: false,
  tickEvery: '15m',
  marketSnapshotPath: 'data/market-snapshot.json',
}

const marketStateAlert: MarketStateAlertConfig = {
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

const microstructureAlert: MicrostructureAlertConfig = {
  enabled: true,
  source: 'ccxt-custom-7e373296',
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
  orderbookEvery: '2m',
  fundingEvery: '30m',
  baselineAlpha: 0.2,
  fundingHistoryCap: 80,
  cooldown: '30m',
  rules: {
    obWarmup: 20,
    fundingWarmup: 24,
    spread: { medium: 2, high: 3, critical: 5 },
    depth: { medium: 0.7, high: 0.5, critical: 0.3 },
    imbalance: { medium: 3, high: 5, critical: 10 },
    fundingExtreme: { medium: 50, high: 80, critical: 94, minAbs: 0.00001 },
    fundingChange: { medium: 0.000007, high: 0.00003 },
  },
  statePath: 'data/microstructure-alert-state.json',
}

const files = new Map<string, string>([
  [
    'data/market-state-alert-state.json',
    JSON.stringify({
      schemaVersion: 1,
      initialSmokeSentFor: '2026-07-08:stress_watch',
      lastEvaluatedDayUtc: '2026-07-08',
    }),
  ],
  [
    'data/microstructure-alert-state.json',
    JSON.stringify({
      baselines: { btc: {}, eth: {} },
      lifecycles: { btc: {} },
      lastFundingAtMs: 1,
    }),
  ],
])

async function readText(path: string): Promise<string> {
  const normalized = path.replaceAll('\\', '/')
  const key = [...files.keys()].find((candidate) => normalized.endsWith(candidate))
  if (!key) throw new Error(`missing fixture: ${path}`)
  return files.get(key)!
}

describe('live_readiness_report', () => {
  it('reports OK when alert-only monitors are enabled and state files are readable', async () => {
    const report = await buildLiveReadinessReport({
      autoTrading: autoTradingOff,
      marketStateAlert,
      microstructureAlert,
      now: () => new Date('2026-07-09T00:00:00Z'),
      readText,
      marketStateReport: async () => ({
        status: 'ok',
        symbol: 'BTCUSDT',
        source: 'binance_spot_daily_close',
        state: 'stress_watch',
        dateUtc: '2026-07-08',
        discipline: 'not a trade signal',
      }),
    })

    expect(report.status).toBe('ok')
    expect(report.scope).toBe('alert_only_monitoring')
    expect(report.checks.map((check) => check.status)).toEqual(Array(report.checks.length).fill('ok'))
    const rendered = JSON.stringify(report).toLowerCase()
    expect(rendered).not.toContain('buy')
    expect(rendered).not.toContain('sell')
    expect(rendered).not.toContain('validated')
  })

  it('raises attention if auto trading is enabled', async () => {
    const report = await buildLiveReadinessReport({
      autoTrading: { ...autoTradingOff, enabled: true },
      marketStateAlert,
      microstructureAlert,
      readText,
      marketStateReport: async () => ({
        status: 'ok',
        symbol: 'BTCUSDT',
        source: 'binance_spot_daily_close',
        state: 'stress_watch',
        dateUtc: '2026-07-08',
        discipline: 'not a trade signal',
      }),
    })

    expect(report.status).toBe('attention')
    expect(report.attentionItems.some((item) => item.includes('autoTrading.enabled is true'))).toBe(true)
  })

  it('raises attention instead of trusting corrupt monitor state', async () => {
    const report = await buildLiveReadinessReport({
      autoTrading: autoTradingOff,
      marketStateAlert,
      microstructureAlert,
      readText: async (path) => {
        if (path.includes('market-state-alert-state')) return '{not json'
        return readText(path)
      },
      marketStateReport: async () => ({
        status: 'ok',
        symbol: 'BTCUSDT',
        source: 'binance_spot_daily_close',
        state: 'stress_watch',
        dateUtc: '2026-07-08',
        discipline: 'not a trade signal',
      }),
    })

    expect(report.status).toBe('attention')
    expect(report.attentionItems.some((item) => item.includes('BTC stress state file readable'))).toBe(true)
  })

  it('raises attention when the current BTC stress report is UNKNOWN', async () => {
    const report = await buildLiveReadinessReport({
      autoTrading: autoTradingOff,
      marketStateAlert,
      microstructureAlert,
      readText,
      marketStateReport: async () => ({
        status: 'unknown',
        symbol: 'BTCUSDT',
        source: 'binance_spot_daily_close',
        reason: 'missing UTC daily candle',
        discipline: 'not a trade signal',
      }),
    })

    expect(report.status).toBe('attention')
    expect(report.attentionItems.some((item) => item.includes('missing UTC daily candle'))).toBe(true)
  })
})
