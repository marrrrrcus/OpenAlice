/**
 * microstructure-alert — deterministic order-book / funding risk monitor, Pump-driven.
 *
 * Polls a small watchlist's order book (fast) and funding (slow), measures
 * five signals against per-symbol adaptive baselines, and force-pushes
 * explainable Telegram alerts. Zero AI. Explains risk, never calls price.
 *
 * Two-layer state (data/microstructure-alert-state.json):
 *   Layer A — per-symbol baselines (rolled forward each tick)
 *   Layer B — per-(symbol, alert_type) lifecycle (dedup + cooldown)
 *
 * Pure logic lives in rules.ts (metrics + baselines + the five rules) and
 * lifecycle.ts (notify decision). This file is the I/O orchestration:
 * resolve symbols -> fetch -> evaluate (vs the prior baseline) -> update
 * baseline -> lifecycle gate -> notify.
 *
 * v1 scope is locked (see docs/microstructure-alerts.md): five alerts only;
 * wall / OI / crowded / liquidity-vacuum are deferred.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Contract } from '@traderalice/ibkr'
import { createPump, type Pump } from '../../core/pump.js'
import { parseDuration } from '../../core/duration.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { UTAManagerSDK } from '../../services/uta-client/index.js'
import type { UTAAccountSDK } from '../../services/uta-client/index.js'
import type { MicrostructureAlertConfig } from '../../core/config.js'
import {
  computeOrderBookMetrics,
  emptyBaseline,
  updateOrderBookBaseline,
  updateFundingBaseline,
  evalSpreadWidening,
  evalDepthThinning,
  evalOrderbookImbalance,
  evalFundingExtreme,
  evalFundingChange,
  buildMicroAlertMessage,
  type SymbolBaseline,
  type MicroRuleConfig,
  type MicroSignal,
  type MicroAlertType,
} from './rules.js'
import { decideNotification, emptyLifecycle, type AlertLifecycle } from './lifecycle.js'

// ==================== State ====================

export interface MicrostructureState {
  baselines: Record<string, SymbolBaseline>
  lifecycles: Record<string, Record<string, AlertLifecycle>>
  lastOrderBookAtMs: number | null
  lastFundingAtMs: number | null
}

function defaultState(): MicrostructureState {
  return { baselines: {}, lifecycles: {}, lastOrderBookAtMs: null, lastFundingAtMs: null }
}

// ==================== Module ====================

export interface MicrostructureAlertOpts {
  config: MicrostructureAlertConfig
  manager: UTAManagerSDK
  connectorCenter: ConnectorCenter
  now?: () => number
}

export interface MicrostructureAlert {
  start(): Promise<void>
  stop(): void
  runNow(): Promise<void>
  isEnabled(): boolean
}

export function createMicrostructureAlert(opts: MicrostructureAlertOpts): MicrostructureAlert {
  const { config, manager, connectorCenter } = opts
  const now = opts.now ?? Date.now

  let started = false
  let pump: Pump | null = null

  /** Resolved data account (cached after first success). */
  let account: UTAAccountSDK | null = null

  const ruleCfg: MicroRuleConfig = {
    obWarmup: config.rules.obWarmup,
    fundingWarmup: config.rules.fundingWarmup,
    spread: config.rules.spread,
    depth: config.rules.depth,
    imbalance: config.rules.imbalance,
    fundingExtreme: config.rules.fundingExtreme,
    fundingChange: config.rules.fundingChange,
  }
  const cooldownMs = parseDuration(config.cooldown) ?? 30 * 60 * 1000
  const fundingEveryMs = parseDuration(config.fundingEvery) ?? 30 * 60 * 1000

  // ---- state persistence ----

  async function loadState(): Promise<MicrostructureState> {
    try {
      const raw = JSON.parse(await readFile(resolvePath(config.statePath), 'utf-8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('state must be a JSON object')
      const state = raw as Partial<MicrostructureState>
      if (state.baselines !== undefined && (!state.baselines || typeof state.baselines !== 'object' || Array.isArray(state.baselines))) {
        throw new Error('baselines must be an object')
      }
      if (state.lifecycles !== undefined && (!state.lifecycles || typeof state.lifecycles !== 'object' || Array.isArray(state.lifecycles))) {
        throw new Error('lifecycles must be an object')
      }
      if (
        state.lastOrderBookAtMs !== undefined
        && state.lastOrderBookAtMs !== null
        && (!Number.isFinite(state.lastOrderBookAtMs) || state.lastOrderBookAtMs < 0)
      ) {
        throw new Error('lastOrderBookAtMs must be null or a non-negative finite number')
      }
      if (
        state.lastFundingAtMs !== undefined
        && state.lastFundingAtMs !== null
        && (!Number.isFinite(state.lastFundingAtMs) || state.lastFundingAtMs < 0)
      ) {
        throw new Error('lastFundingAtMs must be null or a non-negative finite number')
      }
      return {
        baselines: state.baselines ?? {},
        lifecycles: state.lifecycles ?? {},
        lastOrderBookAtMs: state.lastOrderBookAtMs ?? null,
        lastFundingAtMs: state.lastFundingAtMs ?? null,
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return defaultState()
      }
      throw new Error(`microstructure-alert state unreadable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function loadStateOrUndefined(): Promise<MicrostructureState | undefined> {
    try {
      return await loadState()
    } catch (err) {
      console.warn(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }

  async function saveState(state: MicrostructureState): Promise<void> {
    const abs = resolvePath(config.statePath)
    await mkdir(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tmp, abs)
  }

  // ---- resolution ----

  async function resolveAccount(): Promise<UTAAccountSDK | null> {
    if (account) return account
    try {
      if (config.source) {
        account = await manager.resolveOne(config.source)
      } else {
        const all = await manager.resolve()
        account = all[0] ?? null
      }
    } catch (err) {
      console.warn(`microstructure-alert: account resolve failed: ${err instanceof Error ? err.message : String(err)}`)
      account = null
    }
    return account
  }

  /**
   * Build the Contract for a watchlist symbol. The aliceId wire format is
   * `accountId|nativeKey`, and for a CCXT account the nativeKey IS the
   * unified symbol (e.g. "BTC/USDT:USDT"). The UTA route expands the
   * aliceId via the broker's native-key decoder, so we construct it
   * directly — searchContracts goes through an aggregated index that does
   * not reliably return per-account CCXT perps.
   */
  function buildContract(acc: UTAAccountSDK, symbol: string): Contract {
    return Object.assign(new Contract(), { aliceId: `${acc.id}|${symbol}` })
  }

  // ---- evaluation ----

  /** Evaluate all rules for one symbol against its PRIOR baseline; returns
   *  the firing signals (null = not firing) keyed by alert type, plus the
   *  baseline rolled forward with this tick's observations. */
  function evaluateSymbol(
    baseline: SymbolBaseline,
    ob: { bids: [number, number][]; asks: [number, number][] } | null,
    funding: number | null,
  ): { results: Map<MicroAlertType, MicroSignal | null>; nextBaseline: SymbolBaseline; orderBookObserved: boolean } {
    const results = new Map<MicroAlertType, MicroSignal | null>()
    let next = baseline
    let orderBookObserved = false

    if (ob) {
      const m = computeOrderBookMetrics(ob)
      if (m) {
        orderBookObserved = true
        // Evaluate against the baseline that EXCLUDES this tick, then fold in.
        results.set('spread_widening', evalSpreadWidening(m, baseline, ruleCfg))
        results.set('depth_thinning', evalDepthThinning(m, baseline, ruleCfg))
        results.set('orderbook_imbalance', evalOrderbookImbalance(m, ruleCfg))
        next = updateOrderBookBaseline(next, m, config.baselineAlpha)
      }
    }

    if (funding !== null && Number.isFinite(funding)) {
      results.set('funding_extreme', evalFundingExtreme(funding, baseline, ruleCfg))
      results.set('funding_change', evalFundingChange(funding, baseline, ruleCfg))
      next = updateFundingBaseline(next, funding, config.fundingHistoryCap)
    }

    return { results, nextBaseline: next, orderBookObserved }
  }

  // ---- tick ----

  async function onTick(): Promise<void> {
    const acc = await resolveAccount()
    if (!acc) return

    const state = await loadStateOrUndefined()
    if (!state) return
    const fundingDue = state.lastFundingAtMs === null || now() - state.lastFundingAtMs >= fundingEveryMs
    // Only advance the funding clock once at least one symbol's funding
    // actually came back — otherwise a transient funding-API failure would
    // silently push the next retry out by a whole fundingEvery window.
    let fundingSucceeded = false
    let orderBookSucceeded = false

    for (const symbol of config.symbols) {
      const contract = buildContract(acc, symbol)

      // Fetch order book every tick; funding only when due.
      let ob: { bids: [number, number][]; asks: [number, number][] } | null = null
      let funding: number | null = null
      try {
        const book = await acc.getOrderBook(contract)
        ob = { bids: book.bids as [number, number][], asks: book.asks as [number, number][] }
      } catch (err) {
        console.warn(`microstructure-alert: getOrderBook(${symbol}) failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (fundingDue) {
        try {
          const fr = await acc.getFundingRate(contract)
          funding = fr.fundingRate
          if (Number.isFinite(funding)) fundingSucceeded = true
        } catch (err) {
          console.warn(`microstructure-alert: getFundingRate(${symbol}) failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (!ob && funding === null) continue

      const prevBaseline = state.baselines[symbol] ?? emptyBaseline()
      const { results, nextBaseline, orderBookObserved } = evaluateSymbol(prevBaseline, ob, funding)
      if (orderBookObserved) orderBookSucceeded = true
      state.baselines[symbol] = nextBaseline

      // Lifecycle gate per (symbol, alert_type); collect what to notify.
      const lc = state.lifecycles[symbol] ?? {}
      const toNotify: MicroSignal[] = []
      for (const [type, signal] of results) {
        const prev = lc[type] ?? emptyLifecycle()
        const { notify, next } = decideNotification(signal, prev, now(), cooldownMs)
        lc[type] = next
        if (notify && signal) toNotify.push(signal)
      }
      state.lifecycles[symbol] = lc

      if (toNotify.length > 0) {
        // All microstructure alerts are risk signals — force-push.
        await connectorCenter.notify(buildMicroAlertMessage(symbol, toNotify), {
          source: 'microstructure-alert',
          priority: 'high',
        })
      }
    }

    if (orderBookSucceeded) state.lastOrderBookAtMs = now()
    if (fundingDue && fundingSucceeded) state.lastFundingAtMs = now()
    await saveState(state)
  }

  return {
    async start() {
      if (started) return
      started = true
      pump = createPump({
        name: 'microstructure-alert',
        every: config.orderbookEvery,
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
