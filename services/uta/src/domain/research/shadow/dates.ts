/**
 * UTC calendar-day helpers for the shadow track. Deliberately local (tiny)
 * rather than imported from risk-gates: the research/trading boundary stays
 * limited to kline types + fetch + computeZone.
 *
 * A "day" is a UTC calendar date string 'YYYY-MM-DD'. The daily candle for
 * day D opens at D 00:00Z and closes at D+1 00:00Z.
 */

const DAY_MS = 86_400_000

export function dayUtcOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function startOfDayMs(dateUtc: string): number {
  return Date.parse(`${dateUtc}T00:00:00Z`)
}

export function addDays(dateUtc: string, n: number): string {
  return dayUtcOfMs(startOfDayMs(dateUtc) + n * DAY_MS)
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return Math.round((startOfDayMs(b) - startOfDayMs(a)) / DAY_MS)
}

/** The newest fully completed UTC day as of `now` (= UTC-yesterday). */
export function expectedDayUtc(now: Date): string {
  return dayUtcOfMs(now.getTime() - DAY_MS)
}
