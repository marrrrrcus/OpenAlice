/**
 * News Alert — deterministic breaking-news monitor, Pump-driven.
 *
 * The NewsCollector archives RSS into a queryable store but never pushes;
 * items just sit there until Alice is asked. This task closes that gap:
 * it polls newly-published items and force-pushes a Telegram alert when
 * one trips a tiered keyword filter. Keyword matching is fully
 * deterministic — zero AI, zero tokens.
 *
 * Why tiered (not a flat keyword list): bare coin tickers like "BTC" /
 * "ETH" match almost every crypto headline and would spam relentlessly.
 * So:
 *   - High-priority phrases (hack, exploit, liquidation, SEC, ETF
 *     approval/rejection, exchange halt/outage) push on their own.
 *   - Coin tickers fire ONLY when co-occurring with a risk word
 *     (e.g. "BTC" + "ETF"/"SEC"/"hack") — a plain price-move headline
 *     mentioning BTC stays quiet.
 *
 * An optional AI-digest fallback over the non-matching remainder (catch
 * the "big thing that matched no keyword") is intentionally NOT here yet
 * — keyword hits stay zero-token; the AI layer is a documented follow-up
 * in TODO.md. Everything this task pushes is keyword-deterministic.
 *
 * State (data/news-alert-state.json) holds the set of already-alerted
 * item keys so a headline lingering in the lookback window isn't
 * re-pushed, surviving restarts.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createPump, type Pump } from '../../core/pump.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { NewsAlertConfig } from '../../core/config.js'

// ==================== News source (minimal slice of INewsProvider) ====================

export interface NewsAlertItem {
  time: Date
  title: string
  content: string
  metadata: Record<string, string | null>
}

export interface NewsAlertSource {
  getNewsV2(options: { endTime: Date; lookback?: string; limit?: number }): Promise<NewsAlertItem[]>
}

// ==================== Keyword classifier (pure) ====================

export interface NewsKeywordRules {
  /** Phrases that push on their own (highest signal). */
  highPriority: string[]
  /** Words that "arm" a coin ticker (must co-occur for a coin match). */
  riskWords: string[]
  /** Coin tickers / names — fire only alongside a risk word. */
  coinWords: string[]
}

export interface NewsClassification {
  matched: boolean
  tier: 'high' | 'coin-risk' | null
  /** Human-readable reason, e.g. "Binance halt" or "BTC+SEC". */
  reason: string
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whole-word (boundary) match, case-insensitive. Word boundaries stop
 * "SEC" matching "section" and "ETH" matching "method", while still
 * matching multi-word phrases like "ETF approval".
 */
function hasKeyword(text: string, keyword: string): boolean {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i').test(text)
}

export function classifyNewsItem(title: string, content: string, rules: NewsKeywordRules): NewsClassification {
  const text = `${title}\n${content}`

  for (const kw of rules.highPriority) {
    if (hasKeyword(text, kw)) return { matched: true, tier: 'high', reason: kw }
  }

  const coin = rules.coinWords.find((c) => hasKeyword(text, c))
  if (coin) {
    const risk = rules.riskWords.find((r) => hasKeyword(text, r))
    if (risk) return { matched: true, tier: 'coin-risk', reason: `${coin}+${risk}` }
  }

  return { matched: false, tier: null, reason: '' }
}

/** Stable identity for dedup: prefer the article link / guid, fall back to title. */
export function newsItemKey(item: NewsAlertItem): string {
  return item.metadata['link'] || item.metadata['guid'] || item.title
}

// ==================== Message builder (pure) ====================

export interface MatchedNews {
  item: NewsAlertItem
  classification: NewsClassification
}

export function buildNewsAlert(matches: MatchedNews[]): string {
  const lines = matches.map((m) => {
    const source = m.item.metadata['source'] ?? '?'
    const link = m.item.metadata['link']
    const tail = link ? `\n  ${link}` : ''
    return `· [${source}] ${m.item.title}（命中：${m.classification.reason}）${tail}`
  })
  return ['📰 新聞警示', ...lines].join('\n')
}

// ==================== State ====================

export interface NewsAlertState {
  /** Keys of items already pushed — prevents re-alerting a lingering headline. */
  alertedKeys: string[]
}

function defaultState(): NewsAlertState {
  return { alertedKeys: [] }
}

// ==================== Module ====================

export interface NewsAlertOpts {
  config: NewsAlertConfig
  newsSource: NewsAlertSource
  connectorCenter: ConnectorCenter
  now?: () => number
}

export interface NewsAlert {
  start(): Promise<void>
  stop(): void
  runNow(): Promise<void>
  isEnabled(): boolean
}

export function createNewsAlert(opts: NewsAlertOpts): NewsAlert {
  const { config, newsSource, connectorCenter } = opts
  const now = opts.now ?? Date.now

  let started = false
  let pump: Pump | null = null

  const rules: NewsKeywordRules = {
    highPriority: config.keywords.highPriority,
    riskWords: config.keywords.riskWords,
    coinWords: config.keywords.coinWords,
  }

  async function loadState(): Promise<NewsAlertState> {
    try {
      const raw = JSON.parse(await readFile(resolve(config.statePath), 'utf-8')) as NewsAlertState
      return { alertedKeys: Array.isArray(raw.alertedKeys) ? raw.alertedKeys : [] }
    } catch {
      return defaultState()
    }
  }

  async function saveState(state: NewsAlertState): Promise<void> {
    const abs = resolve(config.statePath)
    await mkdir(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tmp, abs)
  }

  async function onTick(): Promise<void> {
    const state = await loadState()
    const seen = new Set(state.alertedKeys)

    let items: NewsAlertItem[]
    try {
      items = await newsSource.getNewsV2({ endTime: new Date(now()), lookback: config.lookback })
    } catch (err) {
      console.warn(`news-alert: getNewsV2 failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const matches: MatchedNews[] = []
    for (const item of items) {
      const key = newsItemKey(item)
      if (seen.has(key)) continue // already alerted (or marked) — skip
      const classification = classifyNewsItem(item.title, item.content, rules)
      if (classification.matched) {
        matches.push({ item, classification })
        seen.add(key)
        state.alertedKeys.push(key)
      }
    }

    if (matches.length > 0) {
      // Cap per push so a burst doesn't produce a wall of text.
      const capped = matches.slice(0, config.maxPerAlert)
      await connectorCenter.notify(buildNewsAlert(capped), { source: 'news-alert', priority: 'high' })
    }

    // Bound the dedup set — keep the most recent N keys.
    if (state.alertedKeys.length > config.maxDedupKeys) {
      state.alertedKeys = state.alertedKeys.slice(-config.maxDedupKeys)
    }

    await saveState(state)
  }

  return {
    async start() {
      if (started) return
      started = true
      pump = createPump({
        name: 'news-alert',
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
