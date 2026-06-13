/**
 * Market Report — deterministic market monitoring, Pump-driven.
 *
 * Replaces the prompt-driven "check BTC every 30min and report" cron job.
 * That pattern burned tokens on every tick: the AI fetched quotes via tool
 * calls (each round-trip resends the whole context), computed nothing the
 * program couldn't, and produced a report even when the market hadn't moved.
 *
 * New shape — three layers, AI only in the narrowest one:
 *
 *   1. Data (no AI):   read market-snapshot.json for live price; pull daily
 *                      candles via the crypto market-data client; compute
 *                      RSI in-process.
 *   2. Rules (no AI):  hysteresis state machine over RSI zones + price-move
 *                      threshold vs. the last *reported* price. Snapshot
 *                      staleness (writer down) is itself an alert condition.
 *   3. Summary (AI):   only when an event fires, emit `agent.work.requested`
 *                      with all numbers pre-baked into the prompt — the AI
 *                      writes prose, it does not fetch data.
 *
 * Quiet periods: a program-built one-liner goes out at most every
 * `summaryEvery` (default 4h) via ConnectorCenter.notify() — zero AI tokens.
 *
 * State (data/market-report-state.json) persists RSI zones, last reported
 * prices, and alert flags across restarts so hysteresis survives reboots.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionStore } from '../../core/session.js'
import type { ISessionStore } from '../../core/session.js'
import type { ListenerRegistry } from '../../core/listener-registry.js'
import type { ProducerHandle } from '../../core/producer.js'
import { createPump, type Pump } from '../../core/pump.js'
import { parseDuration } from '../../core/duration.js'
import type { AgentWorkListener, AgentWorkSourceConfig } from '../../core/agent-work-listener.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { MarketReportConfig, MarketReportSymbolConfig } from '../../core/config.js'
import type { CryptoClientLike } from '../../domain/market-data/client/types.js'
import { RSI } from '../../domain/analysis/indicator/functions/technical.js'
import {
  readMarketSnapshotFile,
  isSnapshotStale,
  MARKET_SNAPSHOT_MAX_AGE_MS,
  type MarketSnapshotSlice,
} from '../../domain/auto-trading/market-snapshot.js'

// ==================== State ====================

export type RsiZone = 'oversold' | 'neutral' | 'overbought'

export interface SymbolReportState {
  rsiZone: RsiZone
  lastRsi: number | null
  /** Price at the time of the last delivered report (AI or summary).
   *  The price-move trigger compares against this, not the previous tick —
   *  otherwise a slow 3% drift over 6 ticks never fires. */
  lastReportedPrice: number | null
}

export interface MarketReportState {
  /** Last time anything was delivered (event report or quiet summary). */
  lastSummaryAtMs: number | null
  /** Stale-snapshot alert latch — fire once per outage, reset on recovery. */
  staleAlerted: boolean
  symbols: Record<string, SymbolReportState>
}

export function defaultSymbolState(): SymbolReportState {
  return { rsiZone: 'neutral', lastRsi: null, lastReportedPrice: null }
}

function defaultState(): MarketReportState {
  return { lastSummaryAtMs: null, staleAlerted: false, symbols: {} }
}

// ==================== Event detection (pure) ====================

export interface SymbolObservation {
  label: string
  price: number
  rsi: number | null
  todayHigh: number | null
  todayLow: number | null
}

export interface DetectedEvent {
  label: string
  kind: 'rsi_oversold' | 'rsi_overbought' | 'rsi_recovered' | 'rsi_cooled' | 'price_move'
  detail: string
}

export interface RsiRuleConfig {
  oversold: number
  overbought: number
  releaseBuffer: number
}

/**
 * Hysteresis state machine over one symbol. Pure — caller persists `next`.
 *
 * RSI zones: entering oversold/overbought fires once; the zone only resets
 * after RSI retreats past threshold±releaseBuffer (also fires, as a
 * "condition cleared" event). Oscillation inside the buffer band is silent.
 *
 * Price move: |price / lastReportedPrice - 1| ≥ priceMovePct fires. The
 * baseline is the last *reported* price and is reset by the caller after
 * any delivery, so quiet summaries also re-anchor the comparison.
 */
export function detectSymbolEvents(
  obs: SymbolObservation,
  prev: SymbolReportState,
  rules: RsiRuleConfig,
  priceMovePct: number,
): { events: DetectedEvent[]; next: SymbolReportState } {
  const events: DetectedEvent[] = []
  const next: SymbolReportState = { ...prev }

  if (obs.rsi !== null) {
    const r = obs.rsi
    if (prev.rsiZone === 'neutral') {
      if (r < rules.oversold) {
        next.rsiZone = 'oversold'
        events.push({ label: obs.label, kind: 'rsi_oversold', detail: `RSI ${r.toFixed(2)} 跌破 ${rules.oversold}（超賣）` })
      } else if (r > rules.overbought) {
        next.rsiZone = 'overbought'
        events.push({ label: obs.label, kind: 'rsi_overbought', detail: `RSI ${r.toFixed(2)} 突破 ${rules.overbought}（超買）` })
      }
    } else if (prev.rsiZone === 'oversold' && r > rules.oversold + rules.releaseBuffer) {
      next.rsiZone = 'neutral'
      events.push({ label: obs.label, kind: 'rsi_recovered', detail: `RSI 回升至 ${r.toFixed(2)}，脫離超賣區` })
    } else if (prev.rsiZone === 'overbought' && r < rules.overbought - rules.releaseBuffer) {
      next.rsiZone = 'neutral'
      events.push({ label: obs.label, kind: 'rsi_cooled', detail: `RSI 回落至 ${r.toFixed(2)}，脫離超買區` })
    }
    next.lastRsi = r
  }

  if (prev.lastReportedPrice !== null && prev.lastReportedPrice > 0) {
    const movePct = (obs.price / prev.lastReportedPrice - 1) * 100
    if (Math.abs(movePct) >= priceMovePct) {
      const dir = movePct > 0 ? '上漲' : '下跌'
      events.push({
        label: obs.label,
        kind: 'price_move',
        detail: `價格自上次回報${dir} ${Math.abs(movePct).toFixed(2)}%（$${prev.lastReportedPrice} → $${obs.price}）`,
      })
    }
  } else {
    // First observation — anchor the baseline without firing.
    next.lastReportedPrice = obs.price
  }

  return { events, next }
}

// ==================== Message builders (pure) ====================

export function buildQuietSummary(observations: SymbolObservation[], staleNote: string | null): string {
  const parts = observations.map((o) => {
    const rsi = o.rsi !== null ? ` RSI ${o.rsi.toFixed(1)}` : ''
    return `${o.label} $${o.price}${rsi}`
  })
  const base = `📊 市場平穩：${parts.join(' ｜ ')}（無顯著變化）`
  return staleNote ? `${base}\n${staleNote}` : base
}

export function buildEventPrompt(
  observations: SymbolObservation[],
  events: DetectedEvent[],
  prevRsiByLabel: Record<string, number | null>,
  snapshot: MarketSnapshotSlice | undefined,
): string {
  const dataLines = observations.map((o) => {
    const prev = prevRsiByLabel[o.label]
    const rsiPart = o.rsi !== null
      ? `RSI(14) ${o.rsi.toFixed(2)}${prev != null ? `（上次 ${prev.toFixed(2)}）` : ''}`
      : 'RSI 無資料'
    const hl = o.todayHigh !== null && o.todayLow !== null
      ? `，今日高 $${o.todayHigh} / 低 $${o.todayLow}`
      : ''
    return `- ${o.label}：現價 $${o.price}，${rsiPart}${hl}`
  })

  const eventLines = events.map((e) => `- [${e.label}] ${e.detail}`)

  const fg = snapshot?.market_context?.fear_greed_index
  const fgLine = fg?.value != null ? `恐懼貪婪指數：${fg.value}（${fg.label ?? ''}）` : null

  return [
    '【市場快訊任務】以下數據已由系統計算完成，請勿呼叫任何工具。',
    '',
    '市場數據：',
    ...dataLines,
    ...(fgLine ? [fgLine] : []),
    '',
    '觸發事件：',
    ...eventLines,
    '',
    '請用繁體中文寫一段不超過 150 字的市場快訊給 Ma：說明發生了什麼、可能的意義、',
    '以及一句話的操作傾向（觀望／留意進場／注意風險）。直接輸出訊息內容即可。',
  ].join('\n')
}

// ==================== Module ====================

export interface MarketReportOpts {
  config: MarketReportConfig
  agentWorkListener: AgentWorkListener
  registry: ListenerRegistry
  connectorCenter: ConnectorCenter
  cryptoClient: CryptoClientLike
  /** Optional: inject a session for testing. */
  session?: ISessionStore
  /** Inject clock for testing. */
  now?: () => number
}

export interface MarketReport {
  start(): Promise<void>
  stop(): void
  runNow(): Promise<void>
  isEnabled(): boolean
}

export function createMarketReport(opts: MarketReportOpts): MarketReport {
  const { config, agentWorkListener, registry, connectorCenter, cryptoClient } = opts
  const session = opts.session ?? new SessionStore('market-report')
  const now = opts.now ?? Date.now

  let started = false
  let producer: ProducerHandle<readonly ['agent.work.requested']> | null = null
  let pump: Pump | null = null

  const sourceConfig: AgentWorkSourceConfig = {
    source: 'market-report',
    session,
    preamble: () =>
      'You are operating in the market-report context (session: market-report). ' +
      'All market data in the prompt was computed by the system — do not call tools to re-fetch it.',
    // No output gate — an event already passed the deterministic rules,
    // so every AI reply is worth delivering.
    // High priority — an event summary IS an alert; it should reach the
    // user via Telegram even when they're not actively chatting there.
    notifyPriority: 'high',
  }

  // ---- state persistence ----

  async function loadState(): Promise<MarketReportState> {
    try {
      const raw = JSON.parse(await readFile(resolve(config.statePath), 'utf-8')) as MarketReportState
      return {
        lastSummaryAtMs: raw.lastSummaryAtMs ?? null,
        staleAlerted: raw.staleAlerted ?? false,
        symbols: raw.symbols ?? {},
      }
    } catch {
      return defaultState()
    }
  }

  async function saveState(state: MarketReportState): Promise<void> {
    const abs = resolve(config.statePath)
    await mkdir(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tmp, abs)
  }

  // ---- data collection ----

  async function observeSymbol(
    sym: MarketReportSymbolConfig,
    snapshot: MarketSnapshotSlice | undefined,
    snapshotFresh: boolean,
  ): Promise<SymbolObservation> {
    // Daily candles for RSI + today's range. ~90 calendar days covers
    // RSI(14) warm-up generously.
    const startDate = new Date(now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const raw = await cryptoClient.getHistorical({ symbol: sym.dataSymbol, start_date: startDate, interval: '1d' })

    const bars = (raw as Array<Record<string, unknown>>)
      .filter((d) => d.close != null && d.high != null && d.low != null && typeof d.date === 'string')
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))

    const closes = bars.map((d) => Number(d.close))
    const lastBar = bars.length > 0 ? bars[bars.length - 1] : null

    const rsi = closes.length >= config.rsi.period + 1 ? RSI(closes, config.rsi.period) : null

    // Live price: prefer the 5-minute snapshot when fresh; the daily bar's
    // close can lag by hours depending on the data provider.
    const snapPrice = snapshotFresh && sym.snapshotKey
      ? snapshot?.signals?.[sym.snapshotKey]?.price
      : undefined
    const price = snapPrice ?? (lastBar ? Number(lastBar.close) : NaN)
    if (!Number.isFinite(price)) {
      throw new Error(`market-report: no price available for ${sym.label}`)
    }

    return {
      label: sym.label,
      price,
      rsi,
      todayHigh: lastBar ? Number(lastBar.high) : null,
      todayLow: lastBar ? Number(lastBar.low) : null,
    }
  }

  // ---- tick ----

  async function onTick(): Promise<void> {
    const state = await loadState()

    let snapshot: MarketSnapshotSlice | undefined
    try {
      snapshot = await readMarketSnapshotFile(config.snapshotPath)
    } catch (err) {
      console.warn(`market-report: snapshot read failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    const stale = snapshot !== undefined && isSnapshotStale(snapshot, MARKET_SNAPSHOT_MAX_AGE_MS)
    let staleNote: string | null = null

    // Stale snapshot = the writer process may be down. That's an alert in
    // its own right, latched so one outage produces one alert.
    if (stale && !state.staleAlerted) {
      const ageMin = snapshot?.updated_at
        ? Math.round((now() - Date.parse(snapshot.updated_at)) / 60_000)
        : null
      await connectorCenter.notify(
        `⚠️ 行情快照已${ageMin !== null ? ` ${ageMin} 分鐘` : ''}未更新，snapshot writer 可能停止運作，請檢查。`,
        { source: 'market-report', priority: 'high' },
      )
      state.staleAlerted = true
    } else if (!stale && snapshot !== undefined && state.staleAlerted) {
      await connectorCenter.notify('✅ 行情快照已恢復更新。', { source: 'market-report', priority: 'high' })
      state.staleAlerted = false
    }
    if (stale) staleNote = '⚠️ 注意：行情快照過期，價格來自日線資料。'

    const observations: SymbolObservation[] = []
    const allEvents: DetectedEvent[] = []
    const prevRsiByLabel: Record<string, number | null> = {}

    for (const sym of config.symbols) {
      try {
        const obs = await observeSymbol(sym, snapshot, !stale)
        const prev = state.symbols[sym.label] ?? defaultSymbolState()
        prevRsiByLabel[sym.label] = prev.lastRsi
        const { events, next } = detectSymbolEvents(obs, prev, config.rsi, config.priceMovePct)
        state.symbols[sym.label] = next
        observations.push(obs)
        allEvents.push(...events)
      } catch (err) {
        console.warn(`market-report: observe ${sym.label} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (observations.length === 0) {
      await saveState(state)
      return
    }

    if (allEvents.length > 0) {
      // Event path — AI writes the summary, numbers pre-baked.
      const prompt = buildEventPrompt(observations, allEvents, prevRsiByLabel, snapshot)
      await producer!.emit('agent.work.requested', { source: 'market-report', prompt })
      state.lastSummaryAtMs = now()
      // Re-anchor price baselines: the user just got these prices.
      for (const obs of observations) {
        const s = state.symbols[obs.label]
        if (s) s.lastReportedPrice = obs.price
      }
    } else {
      const everyMs = parseDuration(config.summaryEvery) ?? 4 * 60 * 60 * 1000
      const due = state.lastSummaryAtMs === null || now() - state.lastSummaryAtMs >= everyMs
      if (due) {
        // Quiet path — program-built one-liner, zero AI tokens.
        await connectorCenter.notify(buildQuietSummary(observations, staleNote), { source: 'market-report' })
        state.lastSummaryAtMs = now()
        for (const obs of observations) {
          const s = state.symbols[obs.label]
          if (s) s.lastReportedPrice = obs.price
        }
      }
    }

    await saveState(state)
  }

  return {
    async start() {
      if (started) return
      started = true

      producer = registry.declareProducer({
        name: 'market-report',
        emits: ['agent.work.requested'] as const,
      })
      agentWorkListener.registerSource(sourceConfig)

      pump = createPump({
        name: 'market-report',
        every: config.every,
        enabled: config.enabled,
        onTick,
      })
      pump.start()
    },

    stop() {
      if (!started) return
      pump?.stop()
      pump = null
      producer?.dispose()
      producer = null
      started = false
    },

    async runNow() {
      if (pump) await pump.runNow()
    },

    isEnabled() {
      return pump?.isEnabled() ?? config.enabled
    },
  }
}
