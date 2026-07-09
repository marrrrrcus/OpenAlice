import { tool } from 'ai'
import { z } from 'zod'
import type { MarketStateAlertConfig } from '@/core/config.js'
import { fetchBinanceSpotDailyCandles, type FetchKlines } from './stress-rebound/binance.js'
import {
  computeStressRebound,
  type StressDay,
  type StressReboundParams,
} from './stress-rebound/machine.js'

export interface MarketStateReportDeps {
  config: MarketStateAlertConfig
  now?: () => Date
  fetchKlines?: FetchKlines
}

export interface MarketStateReport {
  status: 'ok' | 'unknown'
  reason?: string
  symbol: string
  source: string
  state?: StressDay['state']
  dateUtc?: string
  close?: string
  eventPeakClose?: string
  eventPeakDateUtc?: string
  troughClose?: string
  troughDateUtc?: string
  reboundLine?: string
  sma60?: string
  sma120?: string
  sma200?: string
  sma240?: string
  reasonLines?: string[]
  nextTrigger?: string
  discipline: string
}

export function paramsFromConfig(config: MarketStateAlertConfig): StressReboundParams {
  return {
    sma60: config.smas.sma60,
    sma120: config.smas.sma120,
    sma200: config.smas.sma200,
    sma240: config.smas.sma240,
    drawdownPct: String(config.drawdownPct),
    reboundMultiple: String(config.reboundMultiple),
    timeoutDays: config.timeoutDays,
  }
}

export async function buildMarketStateReport(deps: MarketStateReportDeps): Promise<MarketStateReport> {
  const now = deps.now ?? (() => new Date())
  let candles
  try {
    candles = await fetchBinanceSpotDailyCandles(deps.config.symbol, deps.config.historyLimit, now(), deps.fetchKlines)
  } catch (err) {
    return {
      status: 'unknown',
      symbol: deps.config.symbol,
      source: 'binance_spot_daily_close',
      reason: `kline fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      discipline: '這不是交易訊號。如果你選擇交易,請走 Alice stage -> commit -> Trading as Git verdict。',
    }
  }

  const result = computeStressRebound(candles, paramsFromConfig(deps.config))
  if (!result.ok || !result.latest) {
    return {
      status: 'unknown',
      symbol: deps.config.symbol,
      source: 'binance_spot_daily_close',
      reason: result.error ?? 'no completed daily state available',
      discipline: '這不是交易訊號。如果你選擇交易,請走 Alice stage -> commit -> Trading as Git verdict。',
    }
  }

  const latest = result.latest
  return {
    status: 'ok',
    symbol: deps.config.symbol,
    source: 'binance_spot_daily_close',
    state: latest.state,
    dateUtc: latest.dateUtc,
    close: latest.close,
    eventPeakClose: latest.eventPeakClose,
    eventPeakDateUtc: latest.eventPeakDateUtc,
    troughClose: latest.troughClose,
    troughDateUtc: latest.troughDateUtc,
    reboundLine: latest.reboundLine,
    sma60: latest.sma60,
    sma120: latest.sma120,
    sma200: latest.sma200,
    sma240: latest.sma240,
    reasonLines: latest.reasonLines,
    nextTrigger: latest.nextTrigger,
    discipline: '這不是交易訊號。如果你選擇交易,請走 Alice stage -> commit -> Trading as Git verdict。',
  }
}

export function createMarketStateReportTools(deps: MarketStateReportDeps) {
  return {
    market_state_report: tool({
      description: `Report BTC Stress Rebound v1's current state.

Awareness monitor only: state, thresholds, and next trigger. Never a
directionSource, never a proposal, never a strategy-shadow result.`,
      inputSchema: z.object({}),
      execute: async () => buildMarketStateReport(deps),
    }),
  }
}
