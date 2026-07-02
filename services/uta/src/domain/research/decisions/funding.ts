/**
 * Derived funding-context machinery (docs/human-decision-ledger-v0.md
 * pinned buckets, reusing funding-crowding-short-veto-v0's signal
 * definitions verbatim):
 *
 *   sum24h(row_i) = rate_i + rate_{i−1} + rate_{i−2}   (ROW ORDER, never
 *                   exact 8h-boundary equality — the ms-jitter lesson)
 *   z             = past-only trailing-365d standardization, per event,
 *                   requiring ≥180d of history
 *   extreme-positive  iff z ≥ trailing p90 of the positive side's z
 *   positive          iff sum24h > 0 (not extreme)
 *   non-positive      iff sum24h ≤ 0
 *   unavailable       otherwise (insufficient history / no rows)
 *
 * Bucket math uses floats: this is a research ANNOTATION (context bucket),
 * not money movement — funding magnitudes (~1e-4) are far inside float
 * precision, and per-event past-only standardization over years of rows
 * would be needlessly heavy in Decimal.
 */

export interface SettledFundingRow {
  /** Settlement time (ms). */
  fundingTime: number
  fundingRate: string
}

const DAY_MS = 86_400_000
const YEAR_MS = 365 * DAY_MS
const MIN_HISTORY_MS = 180 * DAY_MS

export interface FundingBucketResult {
  bucket: 'extreme-positive' | 'positive' | 'non-positive' | 'unavailable'
  sum24h?: string
  z?: string
  p90PosThreshold?: string
  historyDays?: number
  reason?: string
}

/**
 * Bucket the funding state as of `decidedAtMs`, using ONLY rows settled
 * strictly before that moment (same-timestamp ambiguity excluded — the
 * funding-exhaustion rule).
 */
export function computeFundingBucket(rows: readonly SettledFundingRow[], decidedAtMs: number): FundingBucketResult {
  const settled = rows
    .filter(r => r.fundingTime < decidedAtMs)
    .sort((a, b) => a.fundingTime - b.fundingTime)
  if (settled.length < 3) {
    return { bucket: 'unavailable', reason: `only ${settled.length} settled funding rows before the decision` }
  }
  const historyMs = decidedAtMs - settled[0].fundingTime
  const historyDays = Math.floor(historyMs / DAY_MS)
  if (historyMs < MIN_HISTORY_MS) {
    return { bucket: 'unavailable', historyDays, reason: `insufficient funding history: ${historyDays}d (< 180d)` }
  }

  // Row-order 24h sums.
  const rates = settled.map(r => Number(r.fundingRate))
  const sums: number[] = []
  for (let i = 2; i < rates.length; i++) sums.push(rates[i] + rates[i - 1] + rates[i - 2])
  const sumTimes = settled.slice(2).map(r => r.fundingTime)

  // Per-event past-only trailing-365d z (rolling two-pointer window), then
  // the positive side's z distribution for the trailing p90 threshold.
  const zs: Array<number | undefined> = new Array(sums.length).fill(undefined)
  let lo = 0
  let count = 0
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < sums.length; i++) {
    // Window = sums strictly BEFORE event i, within 365d of event i's time.
    while (lo < i && sumTimes[lo] < sumTimes[i] - YEAR_MS) {
      sum -= sums[lo]; sumSq -= sums[lo] * sums[lo]; count--; lo++
    }
    if (count >= 2) {
      const mean = sum / count
      const variance = Math.max(0, (sumSq - count * mean * mean) / (count - 1))
      const std = Math.sqrt(variance)
      // Guard against float-cancellation residue on (near-)constant series
      // (residue scales with the values, so the threshold must too): a
      // vanishing std would mint z "extremes" out of nothing.
      if (std > Math.abs(mean) * 1e-6 + 1e-15) zs[i] = (sums[i] - mean) / std
    }
    sum += sums[i]; sumSq += sums[i] * sums[i]; count++
  }

  const currentIdx = sums.length - 1
  const sum24h = sums[currentIdx]
  const z = zs[currentIdx]
  if (z === undefined) {
    return { bucket: 'unavailable', historyDays, reason: 'trailing distribution unavailable (zero variance or too few sums)' }
  }

  // Positive side's PAST z values within 365d of the decision.
  const posZ = zs
    .slice(0, currentIdx)
    .map((v, i) => ({ v, t: sumTimes[i] }))
    .filter((e): e is { v: number; t: number } => e.v !== undefined && e.v >= 0 && e.t >= sumTimes[currentIdx] - YEAR_MS)
    .map(e => e.v)
    .sort((a, b) => a - b)
  if (posZ.length < 10) {
    return { bucket: 'unavailable', historyDays, reason: `positive-side z sample too thin (${posZ.length} < 10)` }
  }
  const p90 = posZ[Math.min(posZ.length - 1, Math.floor(0.9 * posZ.length))]

  const bucket = z >= p90 && sum24h > 0
    ? 'extreme-positive' as const
    : sum24h > 0
      ? 'positive' as const
      : 'non-positive' as const
  return {
    bucket,
    sum24h: String(sum24h),
    z: z.toFixed(4),
    p90PosThreshold: p90.toFixed(4),
    historyDays,
  }
}

// ==================== Symbol mapping + public fetcher ====================

/** 'BTC/USDT:USDT' (ccxt linear USDM) → 'BTCUSDT'; anything else undefined. */
export function toFapiSymbol(nativeKey: string): string | undefined {
  const m = /^([A-Z0-9]+)\/([A-Z0-9]+):([A-Z0-9]+)$/.exec(nativeKey)
  if (!m || m[2] !== m[3]) return undefined
  return `${m[1]}${m[2]}`
}

type FetchJson = (url: string) => Promise<unknown>

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fapi fundingRate HTTP ${res.status}`)
  return await res.json()
}

/** Paged public fetch of settled Binance USD-M funding rows. */
export async function fetchBinanceUsdmFundingHistory(
  symbol: string,
  startTimeMs: number,
  endTimeMs: number,
  deps: { fetchJson?: FetchJson; pageLimit?: number } = {},
): Promise<SettledFundingRow[]> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson
  const pageLimit = deps.pageLimit ?? 1000
  const rows: SettledFundingRow[] = []
  let cursor = startTimeMs
  for (let page = 0; page < 100; page++) { // hard safety bound: 100k rows ≈ 90 years
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${cursor}&endTime=${endTimeMs}&limit=${pageLimit}`
    const batch = await fetchJson(url) as Array<{ fundingTime: number; fundingRate: string }>
    if (!Array.isArray(batch) || batch.length === 0) break
    for (const r of batch) rows.push({ fundingTime: Number(r.fundingTime), fundingRate: String(r.fundingRate) })
    if (batch.length < pageLimit) break
    const last = rows[rows.length - 1].fundingTime
    if (last + 1 <= cursor) break // no progress — defensive
    cursor = last + 1
  }
  return rows
}
