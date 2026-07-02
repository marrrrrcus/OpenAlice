/**
 * Regime shadow — the observe-mode evidence track from
 * docs/regime-veto-onboarding-v0.md: compute the zone once per UTC day and
 * log it (`trading.regime.zone`), so the "≥30 computed days within a
 * 45-calendar-day window" observe-exit criterion has an auditable record,
 * independent of whether any short intent ever fires.
 *
 * Failure days are logged once (with the UNKNOWN reason) and retried each
 * tick until a good reading lands — an upstream hiccup must not silently
 * hole the record.
 */

import type { RegimeReading, RegimeSourceConfig } from './provider.js'

interface EventLogLike {
  append(type: string, payload: unknown): unknown
}

export interface RegimeShadowOptions {
  getReading: (cfg: RegimeSourceConfig) => Promise<RegimeReading>
  cfg: RegimeSourceConfig
  eventLog?: EventLogLike
  intervalMs?: number
  now?: () => Date
}

export function startRegimeShadow(opts: RegimeShadowOptions): { stop(): void; tick(): Promise<void> } {
  const intervalMs = opts.intervalMs ?? 3_600_000 // hourly — logs once per UTC day
  const now = opts.now ?? (() => new Date())
  let loggedDay: string | undefined       // day with a GOOD reading logged
  let errorLoggedDay: string | undefined  // day with an UNKNOWN already logged (no spam)

  async function tick(): Promise<void> {
    const dateUtc = now().toISOString().slice(0, 10)
    if (loggedDay === dateUtc) return
    let reading: RegimeReading
    try {
      reading = await opts.getReading(opts.cfg)
    } catch (err) {
      reading = { zone: 'UNKNOWN', reason: err instanceof Error ? err.message : String(err) }
    }
    if (reading.zone !== 'UNKNOWN') {
      loggedDay = dateUtc
      try {
        await opts.eventLog?.append('trading.regime.zone', {
          symbol: opts.cfg.regimeSource.symbol,
          dateUtc,
          zone: reading.zone,
          ...(reading.close !== undefined ? { close: reading.close } : {}),
          ...(reading.sma200 !== undefined ? { sma200: reading.sma200 } : {}),
          ...(reading.dataAgeHours !== undefined ? { dataAgeHours: reading.dataAgeHours } : {}),
        })
      } catch { /* shadow logging is best-effort */ }
    } else if (errorLoggedDay !== dateUtc) {
      errorLoggedDay = dateUtc
      console.warn(`[regime-shadow] ${opts.cfg.regimeSource.symbol} ${dateUtc}: ${reading.reason}`)
      try {
        await opts.eventLog?.append('trading.regime.zone', {
          symbol: opts.cfg.regimeSource.symbol,
          dateUtc,
          zone: 'UNKNOWN',
          error: reading.reason ?? 'unknown failure',
        })
      } catch { /* best-effort */ }
      // loggedDay NOT set — keep retrying this day each tick.
    }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  void tick() // immediate first attempt

  return {
    stop() { clearInterval(timer) },
    tick, // exposed for tests
  }
}
