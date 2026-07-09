import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMarketStateAlert, buildTransitionMessage } from './market-state-alert.js'
import type { MarketStateAlertConfig } from '../../core/config.js'
import type { BinanceKlineRow } from '../../domain/research/stress-rebound/binance.js'
import type { StressTransition } from '../../domain/research/stress-rebound/machine.js'

function config(statePath: string): MarketStateAlertConfig {
  return {
    enabled: false,
    every: '1h',
    symbol: 'BTCUSDT',
    historyLimit: 1000,
    drawdownPct: 20,
    reboundMultiple: 1.15,
    timeoutDays: 60,
    smas: { sma60: 60, sma120: 120, sma200: 200, sma240: 240 },
    statePath,
  }
}

function rows(closes: readonly number[], start = '2026-01-01'): BinanceKlineRow[] {
  const startMs = Date.parse(`${start}T00:00:00Z`)
  return closes.map((close, i) => {
    const open = startMs + i * 86_400_000
    const closeMs = open + 86_400_000 - 1
    return [open, String(close), String(close + 1), String(close - 1), String(close), '1', closeMs]
  })
}

function stressRows(): BinanceKlineRow[] {
  return rows([...Array(240).fill(80000), 58600, 61900])
}

describe('market-state-alert monitor', () => {
  it('sends one initial smoke notification, then gates repeated ticks for the same UTC day', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'msa-'))
    try {
      const notified: string[] = []
      const alert = createMarketStateAlert({
        config: config(join(dir, 'state.json')),
        connectorCenter: { notify: async (text: string) => { notified.push(text); return {} as any } } as any,
        now: () => new Date('2026-09-01T12:00:00Z'),
        fetchKlines: async () => stressRows(),
      })
      await alert.start()
      await alert.runNow()
      await alert.runNow()
      alert.stop()

      expect(notified).toHaveLength(1)
      expect(notified[0]).toContain('初始狀態')
      expect(notified[0]).toContain('壓力觀察(stress_watch)')
      const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8')) as Record<string, unknown>
      expect(saved['lastEvaluatedDayUtc']).toBe('2026-08-30')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not write state on fetch failure, so the next tick retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'msa-'))
    try {
      const notified: string[] = []
      let calls = 0
      const alert = createMarketStateAlert({
        config: config(join(dir, 'state.json')),
        connectorCenter: { notify: async (text: string) => { notified.push(text); return {} as any } } as any,
        now: () => new Date('2026-09-01T12:00:00Z'),
        fetchKlines: async () => {
          calls++
          if (calls === 1) throw new Error('network down')
          return stressRows()
        },
      })
      await alert.start()
      await alert.runNow()
      await alert.runNow()
      alert.stop()

      expect(calls).toBe(2)
      expect(notified).toHaveLength(1)
      expect(notified[0]).toContain('初始狀態')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('transition message contains numbers and avoids endorsement words', () => {
    const t: StressTransition = {
      dateUtc: '2026-07-01',
      from: 'stress_watch',
      to: 'rebound_confirmed',
      type: 'rebound_confirmed',
      close: '67390',
      eventPeakClose: '80000',
      troughClose: '58600',
      reboundLine: '67390',
      trigger: 'close >= trough_close * 1.15',
      reasonLines: [
        '反彈確認線(rebound_line): 日線收盤 67390 高於或等於 67390 (+0.00%)',
        'SMA60: 日線收盤 67390 低於 70000 (-3.73%)',
      ],
    }
    const msg = buildTransitionMessage(t, 'structure_repair if close >= SMA60/SMA120')
    expect(msg).toContain('67390')
    expect(msg).toContain('原因:')
    expect(msg).toContain('SMA60: 日線收盤 67390 低於 70000')
    expect(msg).toContain('這不是交易訊號')
    for (const forbidden of ['buy', 'sell', 'safe', 'validated']) {
      expect(msg.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('dedupes by transition key, not destination state alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'msa-'))
    try {
      const statePath = join(dir, 'state.json')
      const cfg = config(statePath)
      await import('node:fs/promises').then(fs => fs.writeFile(statePath, JSON.stringify({
        schemaVersion: 1,
        lastEvaluatedDayUtc: '2026-08-30',
        initialSmokeSentFor: '2026-08-30:rebound_confirmed',
        lastNotifiedTransitionKey: '2026-08-30:normal:stress_watch:enter_stress_watch',
      }) + '\n'))
      const notified: string[] = []
      const alert = createMarketStateAlert({
        config: cfg,
        connectorCenter: { notify: async (text: string) => { notified.push(text); return {} as any } } as any,
        now: () => new Date('2026-09-01T12:00:00Z'),
        fetchKlines: async () => rows([...Array(240).fill(80000), 58600, 67390, 58500]),
      })
      await alert.start()
      await alert.runNow()
      alert.stop()
      expect(notified).toHaveLength(1)
      expect(notified[0]).toContain('failure')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('catches up only the latest missed transition after downtime, even when it is not on the newest daily candle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'msa-'))
    try {
      const statePath = join(dir, 'state.json')
      await import('node:fs/promises').then(fs => fs.writeFile(statePath, JSON.stringify({
        schemaVersion: 1,
        lastEvaluatedDayUtc: '2026-08-29',
        initialSmokeSentFor: '2026-08-29:stress_watch',
      }) + '\n'))
      const notified: string[] = []
      const alert = createMarketStateAlert({
        config: config(statePath),
        connectorCenter: { notify: async (text: string) => { notified.push(text); return {} as any } } as any,
        now: () => new Date('2026-09-02T12:00:00Z'),
        // Aug 29 stress, Aug 30 rebound, Aug 31 failure, Sept 1 no additional transition.
        fetchKlines: async () => rows([...Array(240).fill(80000), 58600, 67390, 58500, 58600]),
      })
      await alert.start()
      await alert.runNow()
      await alert.runNow()
      alert.stop()

      expect(notified).toHaveLength(1)
      expect(notified[0]).toContain('停機期間補發')
      expect(notified[0]).toContain('狀態: 反彈確認(rebound_confirmed) -> 壓力觀察(stress_watch)')
      expect(notified[0]).toContain('事件: 確認失敗(failure)')
      const saved = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>
      expect(saved['lastEvaluatedDayUtc']).toBe('2026-09-01')
      expect(String(saved['lastNotifiedTransitionKey'])).toContain(':failure')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
