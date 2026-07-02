/**
 * Research shadow — the timer that drives the strategy shadow track
 * (docs/strategy-shadow-track-v0.md). Mirrors the regime shadow's lifecycle:
 * hourly tick, unref'd interval, `{stop(), tick()}` handle, immediate first
 * attempt. Config is re-read every tick (mtime-cached loader); the timer
 * itself follows the UTA reload model (restart to apply).
 *
 * Isolation guarantees: every tick is fully wrapped — no failure here may
 * throw into the host process, and one strategy failing must not stop the
 * others. This module never places orders and never touches trading paths.
 */

import type { FetchKlines, KlineRow } from '../../trading/risk-gates/regime/provider.js'
import { fetchBinanceSpotKlines } from '../../trading/risk-gates/regime/provider.js'
import type { DailyStrategy, EventLogLike } from './types.js'
import type { ResearchShadowConfigResolution } from './config.js'
import { isStrategyEnabled } from './config.js'
import { expectedDayUtc } from './dates.js'
import { effectiveRows, readLedgerRows, researchLedgerPath } from './ledger.js'
import { processStrategyTick } from './runner.js'

export interface ResearchShadowOptions {
  strategies: readonly DailyStrategy[]
  loadConfig: () => Promise<ResearchShadowConfigResolution>
  fetchKlines?: FetchKlines
  eventLog?: EventLogLike
  intervalMs?: number
  now?: () => Date
  /** Test seam — defaults to data/research/shadow/{id}.jsonl. */
  ledgerPathFor?: (strategyId: string) => string
}

export function startResearchShadow(opts: ResearchShadowOptions): { stop(): void; tick(): Promise<void> } {
  const intervalMs = opts.intervalMs ?? 3_600_000 // hourly — one scored day per UTC day
  const now = opts.now ?? (() => new Date())
  const fetchKlines = opts.fetchKlines ?? fetchBinanceSpotKlines
  const ledgerPathFor = opts.ledgerPathFor ?? researchLedgerPath
  const warnedDays = new Set<string>()   // per-(strategy,day) unknown warns
  let configWarnedDay: string | undefined // invalid-config warn, once per day
  let cloudWarnedDay: string | undefined  // cloud-sync refusal warn, once per day

  // The ledger is authoritative research evidence — a cloud-synced directory
  // (OneDrive) must never hold it: sync locking can tear appends, and a
  // second clone scoring into its own synced data root would mint a parallel
  // "track" that pollutes the evidence (Marcus's post-lock ruling on the
  // locked spec). The dev tree lives under OneDrive, so this also stops
  // accidental junk tracks from `pnpm dev` runs there — only the runtime
  // clone (local, non-synced) may score.
  const cloudSyncedRoot = /onedrive/i.test(ledgerPathFor(opts.strategies[0]?.id ?? 'probe'))

  // Ticks never overlap: a tick issued while one is in flight JOINS it (the
  // ledger read-then-append sequence must not interleave with itself — e.g.
  // the constructor's immediate tick vs an early manual/timer tick, or a
  // fetch slower than the interval).
  let inflight: Promise<void> | undefined
  function tick(): Promise<void> {
    inflight ??= runTick().finally(() => { inflight = undefined })
    return inflight
  }

  async function runTick(): Promise<void> {
    try {
      if (cloudSyncedRoot) {
        const day = now().toISOString().slice(0, 10)
        if (cloudWarnedDay !== day) {
          cloudWarnedDay = day
          console.warn('[research-shadow] data root is under a cloud-synced directory (OneDrive) — refusing to score; the evidence ledger must live on a local, non-synced path (run from the runtime clone)')
        }
        return
      }
      const resolution = await opts.loadConfig()
      const today = now().toISOString().slice(0, 10)
      if (resolution.status === 'invalid') {
        // Idle loudly — for research the safe failure is "stop scoring",
        // never "score wrong". Rowless days count as unknown downstream.
        if (configWarnedDay !== today) {
          configWarnedDay = today
          console.warn(`[research-shadow] config invalid — idling: ${resolution.error}`)
        }
        return
      }
      const cfg = resolution.config
      if (!cfg.enabled) return

      const expectedDay = expectedDayUtc(now())

      // Pre-check each strategy's ledger so an all-done day costs zero
      // fetches (the dedup is durable — it lives in the ledger itself).
      const needy: DailyStrategy[] = []
      for (const strategy of opts.strategies) {
        if (!isStrategyEnabled(cfg, strategy.id)) continue
        try {
          const eff = effectiveRows(await readLedgerRows(ledgerPathFor(strategy.id)))
          if (eff.get(expectedDay)?.kind !== 'day') needy.push(strategy)
        } catch (err) {
          // An unreadable ledger is NOT a cold start — never score on top
          // of evidence we cannot read (that would fork the track). Idle
          // this strategy for the tick; a rowless day reads as unknown
          // downstream, which is the honest record of the outage.
          console.warn(`[research-shadow] ${strategy.id}: ledger unreadable — not scoring this tick:`, err instanceof Error ? err.message : err)
        }
      }
      if (needy.length === 0) return

      // One fetch per symbol per tick, shared across its strategies.
      const bySymbol = new Map<string, DailyStrategy[]>()
      for (const s of needy) {
        const group = bySymbol.get(s.symbol) ?? []
        group.push(s)
        bySymbol.set(s.symbol, group)
      }

      for (const [symbol, group] of bySymbol) {
        let klines: KlineRow[] = []
        let fetchError: string | undefined
        try {
          const limit = Math.min(
            1000,
            Math.max(...group.map(s => s.dataNeeds.minDays)) + cfg.maxBackfillDays + 5,
          )
          const rows = await fetchKlines(symbol, limit)
          const nowMs = now().getTime()
          // Completed candles only — the in-progress daily candle must never
          // leak into a stance computation (lookahead).
          klines = rows.filter(r => Number(r[6]) <= nowMs)
        } catch (err) {
          fetchError = err instanceof Error ? err.message : String(err)
        }

        for (const strategy of group) {
          try {
            await processStrategyTick({
              strategy,
              costModel: cfg.costModel,
              maxBackfillDays: cfg.maxBackfillDays,
              staleGraceHours: cfg.staleGraceHours,
              klines,
              ...(fetchError !== undefined ? { fetchError } : {}),
              now,
              ledgerPath: ledgerPathFor(strategy.id),
              eventLog: opts.eventLog,
              warnedDays,
            })
          } catch (err) {
            // One strategy's failure must not stop the others.
            console.warn(`[research-shadow] ${strategy.id} tick failed:`, err instanceof Error ? err.message : err)
          }
        }
      }
    } catch (err) {
      console.warn('[research-shadow] tick failed:', err instanceof Error ? err.message : err)
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
