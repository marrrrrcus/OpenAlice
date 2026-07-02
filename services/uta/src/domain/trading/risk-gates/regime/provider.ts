/**
 * Live regime provider — fetches Binance SPOT daily klines (public API) and
 * computes the zone via zone.ts. Must match the validated study exactly:
 * completed candles only (the in-progress daily candle is discarded),
 * SMA200, ±3% band, stateless zones.
 *
 * UNKNOWN-is-not-SAFE plumbing: any failure — fetch error, insufficient
 * history, stale newest candle — yields zone 'UNKNOWN' with a reason; the
 * regime-veto gate BLOCKS short-increasing orders on gated instruments when
 * the zone is UNKNOWN (enforce mode).
 *
 * Cache: one successful reading per UTC day per symbol (the zone only
 * changes on a new daily close). Failures are cached for a short TTL so a
 * dead endpoint doesn't get hammered by preview polling, but recovery is
 * quick.
 */

import { computeZone, type RegimeZone } from './zone.js'

export interface RegimeSourceConfig {
  regimeSource: { venue: string; symbol: string }
  regimeStaleAfterHours: number
}

export interface RegimeReading {
  zone: RegimeZone | 'UNKNOWN'
  close?: string
  sma200?: string
  /** ISO timestamp of the newest completed daily candle's close. */
  computedFrom?: string
  dataAgeHours?: number
  /** Populated when zone is UNKNOWN. */
  reason?: string
}

/** Binance kline row: [openTime, open, high, low, close, volume, closeTime, ...] */
export type KlineRow = [number, string, string, string, string, string, number, ...unknown[]]

export type FetchKlines = (symbol: string, limit: number) => Promise<KlineRow[]>

const FAILURE_TTL_MS = 60_000
const KLINE_LIMIT = 250 // ≥ SMA200 warmup + slack

async function fetchBinanceSpotKlines(symbol: string, limit: number): Promise<KlineRow[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`)
  return await res.json() as KlineRow[]
}

export interface RegimeProvider {
  getReading(cfg: RegimeSourceConfig): Promise<RegimeReading>
}

export function createRegimeProvider(deps: { fetchKlines?: FetchKlines; now?: () => Date } = {}): RegimeProvider {
  const fetchKlines = deps.fetchKlines ?? fetchBinanceSpotKlines
  const now = deps.now ?? (() => new Date())
  const cache = new Map<string, { dateUtc: string; reading: RegimeReading; at: number }>()

  return {
    async getReading(cfg: RegimeSourceConfig): Promise<RegimeReading> {
      // Defensive venue guard (the config schema already pins the literal,
      // but a programmatic caller must not silently get Binance data under
      // another venue's name — UNKNOWN is the honest answer).
      if (cfg.regimeSource.venue !== 'binance_spot') {
        return { zone: 'UNKNOWN', reason: `unsupported regime venue "${cfg.regimeSource.venue}" — only binance_spot is implemented` }
      }
      const symbol = cfg.regimeSource.symbol
      const nowDate = now()
      const dateUtc = nowDate.toISOString().slice(0, 10)

      const cached = cache.get(symbol)
      if (cached) {
        // A good reading holds for the UTC day — but ONLY while it still
        // satisfies the CURRENT staleness config. If the operator tightens
        // regimeStaleAfterHours, or the day drags past the bound with no new
        // close, the cache must not keep vouching for stale data.
        const stillFresh =
          cached.reading.zone !== 'UNKNOWN' &&
          cached.dateUtc === dateUtc &&
          cached.reading.computedFrom !== undefined &&
          (nowDate.getTime() - Date.parse(cached.reading.computedFrom)) / 3_600_000 <= cfg.regimeStaleAfterHours
        const failureCooling =
          cached.reading.zone === 'UNKNOWN' &&
          nowDate.getTime() - cached.at < FAILURE_TTL_MS
        if (stillFresh || failureCooling) return cached.reading
      }

      const reading = await compute(fetchKlines, symbol, cfg.regimeStaleAfterHours, nowDate)
      cache.set(symbol, { dateUtc, reading, at: nowDate.getTime() })
      return reading
    },
  }
}

async function compute(
  fetchKlines: FetchKlines,
  symbol: string,
  staleAfterHours: number,
  now: Date,
): Promise<RegimeReading> {
  let rows: KlineRow[]
  try {
    rows = await fetchKlines(symbol, KLINE_LIMIT)
  } catch (err) {
    return { zone: 'UNKNOWN', reason: `kline fetch failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Completed candles only — the in-progress daily candle (closeTime in the
  // future) must never leak into the SMA (that would be lookahead vs the
  // validated rule, and an intraday-noisy zone).
  const completed = rows.filter(r => Number(r[6]) <= now.getTime())
  if (completed.length < 200) {
    return { zone: 'UNKNOWN', reason: `insufficient history: ${completed.length} completed daily candles (< 200)` }
  }

  const newestCloseMs = Number(completed[completed.length - 1][6])
  const dataAgeHours = (now.getTime() - newestCloseMs) / 3_600_000
  if (dataAgeHours > staleAfterHours) {
    return {
      zone: 'UNKNOWN',
      dataAgeHours,
      reason: `newest completed daily candle is ${dataAgeHours.toFixed(1)}h old (> ${staleAfterHours}h stale bound)`,
    }
  }

  const result = computeZone(completed.map(r => r[4]))
  if (!result.ok) return { zone: 'UNKNOWN', dataAgeHours, reason: result.error }
  return {
    zone: result.zone,
    close: result.close,
    sma200: result.sma200,
    computedFrom: new Date(newestCloseMs).toISOString(),
    dataAgeHours,
  }
}

// Module-level default provider — one daily Binance call shared across all
// evaluations in the process. Tests inject their own via evaluator args.
let defaultProvider: RegimeProvider | undefined
export function getRegimeReading(cfg: RegimeSourceConfig): Promise<RegimeReading> {
  defaultProvider ??= createRegimeProvider()
  return defaultProvider.getReading(cfg)
}
