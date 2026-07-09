import { describe, expect, it } from 'vitest'
import { runLiveReadinessCli } from './live-readiness-cli.js'
import type { Config } from '@/core/config.js'
import type { LiveReadinessReport } from './live-readiness-report.js'

function config(): Config {
  return {
    autoTrading: { enabled: false, tickEvery: '15m', marketSnapshotPath: 'data/market-snapshot.json' },
    connectors: {
      web: { port: 3002 },
      mcpAsk: { enabled: false },
      telegram: { enabled: true, botToken: 'super-secret-token', chatIds: [987654321] },
    },
    liveReadinessAlert: {
      enabled: true,
      every: '15m',
      statePath: 'data/live-readiness-alert-state.json',
    },
    marketStateAlert: {
      enabled: true,
      every: '1h',
      symbol: 'BTCUSDT',
      historyLimit: 1000,
      drawdownPct: 20,
      reboundMultiple: 1.15,
      timeoutDays: 60,
      smas: { sma60: 60, sma120: 120, sma200: 200, sma240: 240 },
      statePath: 'data/market-state-alert-state.json',
    },
    microstructureAlert: {
      enabled: true,
      source: 'binance-public',
      symbols: ['BTC/USDT:USDT'],
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
    },
  } as Config
}

function report(status: 'ok' | 'attention'): LiveReadinessReport {
  return {
    status,
    generatedAt: '2026-07-09T00:00:00.000Z',
    scope: 'alert_only_monitoring',
    checks: [
      {
        id: 'telegram_bot_token',
        label: 'Telegram bot token present',
        status: 'ok',
        detail: 'bot token present; value redacted',
      },
    ],
    attentionItems: status === 'ok' ? [] : ['Telegram chat target configured: no chat target configured'],
    discipline: 'Alert readiness only. This is not a trade signal, proposal, strategy-shadow result, or permission to place orders.',
  }
}

describe('live-readiness CLI runner', () => {
  it('prints redacted JSON and returns 0 when readiness is OK', async () => {
    const out: string[] = []
    const code = await runLiveReadinessCli({
      loadConfig: async () => config(),
      buildReport: async () => report('ok'),
      stdout: (text) => out.push(text),
      stderr: () => { throw new Error('stderr should not be called') },
    })

    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0]) as LiveReadinessReport).toMatchObject({ status: 'ok' })
    expect(out[0]).not.toContain('super-secret-token')
    expect(out[0]).not.toContain('987654321')
  })

  it('returns 1 when readiness needs attention', async () => {
    const out: string[] = []
    const code = await runLiveReadinessCli({
      loadConfig: async () => config(),
      buildReport: async () => report('attention'),
      stdout: (text) => out.push(text),
      stderr: () => { throw new Error('stderr should not be called') },
    })

    expect(code).toBe(1)
    expect(JSON.parse(out[0]) as LiveReadinessReport).toMatchObject({ status: 'attention' })
  })

  it('returns 1 and writes stderr on load/report failures', async () => {
    const errors: string[] = []
    const code = await runLiveReadinessCli({
      loadConfig: async () => { throw new Error('config exploded') },
      stdout: () => { throw new Error('stdout should not be called') },
      stderr: (text) => errors.push(text),
    })

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('config exploded')
  })
})
