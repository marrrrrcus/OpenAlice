/**
 * Track D ticker — hourly timer driving the marker (horizon marks +
 * derived funding/regime backfills). Mirrors the research shadow's
 * lifecycle verbatim: unref'd interval, immediate first attempt, in-flight
 * join (ticks never overlap), cloud-sync refusal, config gate, per-account
 * isolation inside the marker. Never throws into the host.
 */

import { readdir } from 'fs/promises'
import { isCloudSyncedPath } from '../cloud-sync.js'
import type { ResearchDecisionsConfigResolution } from './config.js'
import { decisionsDir } from './ledger.js'
import { processMarkTick, type MarkTickDeps } from './marker.js'

export interface DecisionsTickerOptions {
  loadConfig: () => Promise<ResearchDecisionsConfigResolution>
  fetchDailyOhlcv: MarkTickDeps['fetchDailyOhlcv']
  venueOf: MarkTickDeps['venueOf']
  fetchFundingHistory: MarkTickDeps['fetchFundingHistory']
  loadRegimeZones: MarkTickDeps['loadRegimeZones']
  ledgerDir?: string
  intervalMs?: number
  now?: () => Date
}

export function startDecisionsTicker(opts: DecisionsTickerOptions): { stop(): void; tick(): Promise<void> } {
  const intervalMs = opts.intervalMs ?? 3_600_000
  const now = opts.now ?? (() => new Date())
  const dir = opts.ledgerDir ?? decisionsDir()
  let warnedDay: string | undefined

  const warnOnce = (msg: string): void => {
    const day = now().toISOString().slice(0, 10)
    if (warnedDay === day) return
    warnedDay = day
    console.warn(`[research-decisions] ${msg}`)
  }

  let inflight: Promise<void> | undefined
  function tick(): Promise<void> {
    inflight ??= runTick().finally(() => { inflight = undefined })
    return inflight
  }

  async function runTick(): Promise<void> {
    try {
      if (isCloudSyncedPath(dir)) {
        warnOnce('ledger dir is under a cloud-synced (OneDrive) path — ticker idle; evidence ledgers live on the runtime clone only')
        return
      }
      const resolution = await opts.loadConfig()
      if (resolution.status === 'invalid') {
        warnOnce(`config invalid — ticker idle: ${resolution.error}`)
        return
      }
      const cfg = resolution.config
      if (!cfg.enabled || (!cfg.marker.enabled && !cfg.funding.enabled)) return

      await processMarkTick({
        ledgerDir: dir,
        config: cfg,
        now,
        listAccountIds: async () => {
          let files: string[]
          try {
            files = await readdir(dir)
          } catch {
            return [] // no ledgers yet — nothing to mark
          }
          const ids = files
            .filter(f => f.endsWith('.decisions.jsonl') || f.endsWith('.brakes.jsonl'))
            .map(f => f.replace(/\.(decisions|brakes)\.jsonl$/, ''))
          return [...new Set(ids)]
        },
        fetchDailyOhlcv: opts.fetchDailyOhlcv,
        venueOf: opts.venueOf,
        fetchFundingHistory: opts.fetchFundingHistory,
        loadRegimeZones: opts.loadRegimeZones,
      })
    } catch (err) {
      console.warn('[research-decisions] ticker tick failed:', err instanceof Error ? err.message : err)
    }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  void tick()

  return {
    stop() { clearInterval(timer) },
    tick,
  }
}
