import type { StressDailyCandle } from './machine.js'

/** Binance kline row: [openTime, open, high, low, close, volume, closeTime, ...] */
export type BinanceKlineRow = [number, string, string, string, string, string, number, ...unknown[]]

export type FetchKlines = (symbol: string, limit: number) => Promise<BinanceKlineRow[]>

export async function fetchBinanceSpotKlines(symbol: string, limit: number): Promise<BinanceKlineRow[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`)
  return await res.json() as BinanceKlineRow[]
}

export function completedDailyCandles(rows: readonly BinanceKlineRow[], now: Date): StressDailyCandle[] {
  return rows
    .filter(r => Number(r[6]) <= now.getTime())
    .map(r => ({
      dateUtc: new Date(Number(r[0])).toISOString().slice(0, 10),
      close: String(r[4]),
      low: String(r[3]),
    }))
    .sort((a, b) => a.dateUtc.localeCompare(b.dateUtc))
}

export async function fetchBinanceSpotDailyCandles(
  symbol: string,
  limit: number,
  now: Date = new Date(),
  fetchKlines: FetchKlines = fetchBinanceSpotKlines,
): Promise<StressDailyCandle[]> {
  return completedDailyCandles(await fetchKlines(symbol, limit), now)
}
