/**
 * Account Report — deterministic broker-account risk monitor, Pump-driven.
 *
 * Polls every connected UTA (OKX, Binance, …) on a fixed interval and
 * fires Telegram alerts when account risk conditions trip. Fully
 * deterministic — NO AI. Account alerts are precise factual statements
 * ("BTC 浮虧達淨值 -18%"), so the program builds the message directly:
 * zero token cost, zero latency, no hallucination surface.
 *
 * Three layers (same shape as market-report, minus the AI layer):
 *   1. Data (no AI):   manager.resolve() → per account getAccount() +
 *                      getPositions().
 *   2. Rules (no AI):  hysteresis state machines over per-position
 *                      drawdown layers + near-liquidation distance, plus
 *                      account-level NLV move and position open/close diff.
 *   3. Deliver:        program-built alert text → ConnectorCenter.notify
 *                      with priority 'high' (force-pushes through Telegram
 *                      regardless of last-interaction — a risk alert must
 *                      reach the user when they're NOT watching).
 *
 * Quiet periods: a program-built "accounts healthy" one-liner at most
 * every `summaryEvery` (normal priority — inline only).
 *
 * Implemented conditions: drawdown thresholds, near-liquidation, NLV
 * move, position open/close. Stop-loss-missing detection is intentionally
 * NOT here — it needs a "list all exchange open orders" broker capability
 * the IBroker interface doesn't expose yet (getOrders takes explicit ids;
 * the empty-ids path only returns Alice-tracked staged orders, not stops
 * the user set manually on the exchange). That's a separate cross-cutting
 * addition tracked in TODO.md.
 *
 * State (data/account-report-state.json) persists drawdown layers,
 * liq-alert latches, last-reported NLV, and known position sets across
 * restarts so hysteresis survives reboots.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createPump, type Pump } from '../../core/pump.js'
import { parseDuration } from '../../core/duration.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { UTAManagerSDK } from '../../services/uta-client/index.js'
import type { AccountReportConfig } from '../../core/config.js'

// ==================== Observations ====================

export interface PositionObservation {
  /** Stable identity — the contract's wire localSymbol. */
  key: string
  /** Display label, e.g. "BTC/USDT:USDT". */
  label: string
  side: 'long' | 'short'
  unrealizedPnL: number
  markPrice: number
  /** Null when the broker doesn't expose it (spot, non-leveraged). */
  liquidationPrice: number | null
}

export interface AccountObservation {
  accountId: string
  label: string
  netLiquidation: number
  positions: PositionObservation[]
}

// ==================== State ====================

export interface PositionRiskState {
  /** Highest drawdown layer index already alerted (0 = none). */
  drawdownLayer: number
  /** Near-liquidation alert latch — one alert per approach. */
  liqAlerted: boolean
}

export interface AccountRiskState {
  /** NLV at last delivery — the move trigger compares against this. */
  lastReportedNlv: number | null
  /** Position keys present at last tick — diff source for open/close. */
  knownPositions: string[]
  positions: Record<string, PositionRiskState>
}

export interface AccountReportState {
  lastSummaryAtMs: number | null
  accounts: Record<string, AccountRiskState>
}

export function defaultPositionRiskState(): PositionRiskState {
  return { drawdownLayer: 0, liqAlerted: false }
}

function defaultAccountState(): AccountRiskState {
  return { lastReportedNlv: null, knownPositions: [], positions: {} }
}

function defaultState(): AccountReportState {
  return { lastSummaryAtMs: null, accounts: {} }
}

// ==================== Rules ====================

export interface DrawdownRuleConfig {
  /** Loss thresholds as % of netLiquidation, ascending, e.g. [10, 18, 25]. */
  layersPct: number[]
  /** Layer fully resets when loss recovers below layersPct[0] - buffer. */
  releaseBuffer: number
}

export interface LiquidationRuleConfig {
  /** Alert when |mark - liq| / mark * 100 ≤ safetyPct. */
  safetyPct: number
  /** Latch releases when distance climbs back above safetyPct + buffer. */
  releaseBuffer: number
}

export interface AccountRuleConfig {
  drawdown: DrawdownRuleConfig
  liquidation: LiquidationRuleConfig
  /** NLV move (%) vs last reported value that fires an alert. */
  nlvMovePct: number
}

export interface DetectedAccountEvent {
  accountId: string
  accountLabel: string
  kind: 'drawdown' | 'near_liquidation' | 'nlv_move' | 'position_opened' | 'position_closed'
  /** Severity drives notification priority. */
  severity: 'high' | 'normal'
  detail: string
}

/** Loss as a positive % of account NLV (0 when the position is in profit). */
export function lossPctOfNlv(unrealizedPnL: number, netLiquidation: number): number {
  if (netLiquidation <= 0) return 0
  if (unrealizedPnL >= 0) return 0
  return (-unrealizedPnL / netLiquidation) * 100
}

/** Highest layer index whose threshold is met (−1 when none). */
export function highestLayerHit(lossPct: number, layersPct: number[]): number {
  let hit = -1
  for (let i = 0; i < layersPct.length; i++) {
    if (lossPct >= layersPct[i]) hit = i
  }
  return hit
}

/** Distance from mark to liquidation as a % of mark (null when N/A). */
export function liquidationDistancePct(markPrice: number, liquidationPrice: number | null): number | null {
  if (liquidationPrice === null || liquidationPrice <= 0 || markPrice <= 0) return null
  return (Math.abs(markPrice - liquidationPrice) / markPrice) * 100
}

/**
 * Detect risk events for a single account. Pure — caller persists `next`.
 * Mirrors market-report's hysteresis discipline: each condition fires on
 * a state transition and stays silent until the condition meaningfully
 * clears, so a value hovering at a threshold doesn't spam.
 */
export function detectAccountEvents(
  obs: AccountObservation,
  prev: AccountRiskState,
  rules: AccountRuleConfig,
): { events: DetectedAccountEvent[]; next: AccountRiskState } {
  const events: DetectedAccountEvent[] = []
  const nextPositions: Record<string, PositionRiskState> = {}
  const currentKeys = obs.positions.map((p) => p.key)

  // Cold start: the first time we ever observe an account, lastReportedNlv
  // is null. The position-open/close diff and NLV-move are *change* events —
  // firing them on first sight would report every pre-existing position as
  // "newly opened" (spammy, and re-spams on every Alice restart). Suppress
  // those on cold start; only seed state. Drawdown / near-liquidation still
  // fire — they reflect *current* risk, which the user wants surfaced even
  // for a position that isn't new.
  const coldStart = prev.lastReportedNlv === null

  // ---- per-position: drawdown layers + near-liquidation ----
  for (const p of obs.positions) {
    const ps = prev.positions[p.key] ?? defaultPositionRiskState()
    const next: PositionRiskState = { ...ps }

    // Drawdown layers (loss relative to account NLV).
    const lossPct = lossPctOfNlv(p.unrealizedPnL, obs.netLiquidation)
    const layer = highestLayerHit(lossPct, rules.drawdown.layersPct)
    const layerOneBased = layer + 1 // 0 = none, 1..N = layer hit
    if (layerOneBased > ps.drawdownLayer) {
      events.push({
        accountId: obs.accountId,
        accountLabel: obs.label,
        kind: 'drawdown',
        severity: 'high',
        detail: `${p.label} 浮虧達淨值 -${rules.drawdown.layersPct[layer]}%（L${layerOneBased}），浮虧 $${p.unrealizedPnL.toFixed(2)}`,
      })
      next.drawdownLayer = layerOneBased
    } else if (
      ps.drawdownLayer > 0 &&
      rules.drawdown.layersPct.length > 0 &&
      lossPct < rules.drawdown.layersPct[0] - rules.drawdown.releaseBuffer
    ) {
      next.drawdownLayer = 0 // recovered — re-arm
    }

    // Near-liquidation.
    const dist = liquidationDistancePct(p.markPrice, p.liquidationPrice)
    if (dist !== null) {
      if (!ps.liqAlerted && dist <= rules.liquidation.safetyPct) {
        events.push({
          accountId: obs.accountId,
          accountLabel: obs.label,
          kind: 'near_liquidation',
          severity: 'high',
          detail: `⚠️ ${p.label} 標記價 $${p.markPrice} 距強平價 $${p.liquidationPrice} 僅 ${dist.toFixed(2)}%`,
        })
        next.liqAlerted = true
      } else if (ps.liqAlerted && dist > rules.liquidation.safetyPct + rules.liquidation.releaseBuffer) {
        next.liqAlerted = false // moved away — re-arm
      }
    }

    nextPositions[p.key] = next
  }

  // ---- account-level: position open / close diff (skipped on cold start) ----
  if (!coldStart) {
    const known = new Set(prev.knownPositions)
    const current = new Set(currentKeys)
    for (const p of obs.positions) {
      if (!known.has(p.key)) {
        events.push({
          accountId: obs.accountId,
          accountLabel: obs.label,
          kind: 'position_opened',
          severity: 'high',
          detail: `🟢 新倉 ${p.label} ${p.side} @ $${p.markPrice}`,
        })
      }
    }
    for (const key of prev.knownPositions) {
      if (!current.has(key)) {
        events.push({
          accountId: obs.accountId,
          accountLabel: obs.label,
          kind: 'position_closed',
          severity: 'high',
          detail: `🔴 平倉 ${key}`,
        })
      }
    }
  }

  // ---- account-level: NLV move vs last reported ----
  let nextNlv = prev.lastReportedNlv
  if (prev.lastReportedNlv === null) {
    nextNlv = obs.netLiquidation // anchor without firing
  } else if (prev.lastReportedNlv > 0) {
    const movePct = (obs.netLiquidation / prev.lastReportedNlv - 1) * 100
    if (Math.abs(movePct) >= rules.nlvMovePct) {
      const dir = movePct > 0 ? '增加' : '減少'
      events.push({
        accountId: obs.accountId,
        accountLabel: obs.label,
        kind: 'nlv_move',
        severity: 'normal',
        detail: `帳戶淨值${dir} ${Math.abs(movePct).toFixed(2)}%（$${prev.lastReportedNlv.toFixed(2)} → $${obs.netLiquidation.toFixed(2)}）`,
      })
      nextNlv = obs.netLiquidation // re-anchor
    }
  }

  return {
    events,
    next: {
      lastReportedNlv: nextNlv,
      knownPositions: currentKeys,
      positions: nextPositions,
    },
  }
}

// ==================== Message builders (pure) ====================

export function buildAlertMessage(accountLabel: string, events: DetectedAccountEvent[]): string {
  const lines = events.map((e) => `· ${e.detail}`)
  return [`🚨 帳戶警示 — ${accountLabel}`, ...lines].join('\n')
}

export function buildQuietSummary(observations: AccountObservation[]): string {
  const parts = observations.map((o) => {
    const posCount = o.positions.length
    return `${o.label} 淨值 $${o.netLiquidation.toFixed(2)}（${posCount} 倉）`
  })
  return `📋 帳戶正常：${parts.join(' ｜ ')}`
}

// ==================== Module ====================

export interface AccountReportOpts {
  config: AccountReportConfig
  manager: UTAManagerSDK
  connectorCenter: ConnectorCenter
  now?: () => number
}

export interface AccountReport {
  start(): Promise<void>
  stop(): void
  runNow(): Promise<void>
  isEnabled(): boolean
}

export function createAccountReport(opts: AccountReportOpts): AccountReport {
  const { config, manager, connectorCenter } = opts
  const now = opts.now ?? Date.now

  let started = false
  let pump: Pump | null = null

  const ruleConfig: AccountRuleConfig = {
    drawdown: config.drawdown,
    liquidation: config.liquidation,
    nlvMovePct: config.nlvMovePct,
  }

  // ---- state persistence ----

  async function loadState(): Promise<AccountReportState> {
    try {
      const raw = JSON.parse(await readFile(resolve(config.statePath), 'utf-8')) as AccountReportState
      return {
        lastSummaryAtMs: raw.lastSummaryAtMs ?? null,
        accounts: raw.accounts ?? {},
      }
    } catch {
      return defaultState()
    }
  }

  async function saveState(state: AccountReportState): Promise<void> {
    const abs = resolve(config.statePath)
    await mkdir(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tmp, abs)
  }

  // ---- data collection ----

  async function observe(): Promise<AccountObservation[]> {
    const accounts = await manager.resolve()
    const out: AccountObservation[] = []
    for (const acc of accounts) {
      try {
        const [account, positions] = await Promise.all([acc.getAccount(), acc.getPositions()])
        const nlv = Number(account.netLiquidation)
        if (!Number.isFinite(nlv)) {
          console.warn(`account-report: ${acc.id} has non-numeric netLiquidation, skipping`)
          continue
        }
        out.push({
          accountId: acc.id,
          label: acc.label,
          netLiquidation: nlv,
          positions: positions.map((p) => ({
            key: p.contract.localSymbol || p.contract.symbol || 'unknown',
            label: p.contract.localSymbol || p.contract.symbol || 'unknown',
            side: p.side,
            unrealizedPnL: Number(p.unrealizedPnL),
            markPrice: Number(p.marketPrice),
            liquidationPrice: p.liquidationPrice != null ? Number(p.liquidationPrice) : null,
          })),
        })
      } catch (err) {
        console.warn(`account-report: observe ${acc.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return out
  }

  // ---- tick ----

  async function onTick(): Promise<void> {
    const state = await loadState()
    const all = await observe()
    // Skip dust accounts: a % drawdown / NLV move on a near-zero balance
    // fires alerts on trivial absolute amounts (e.g. a $0.15 loss on a
    // $0.73 leftover account). minNlvUsd = 0 monitors everything.
    const observations = all.filter((o) => o.netLiquidation >= config.minNlvUsd)
    if (observations.length === 0) {
      await saveState(state)
      return
    }

    let anyEvent = false
    for (const obs of observations) {
      const prev = state.accounts[obs.accountId] ?? defaultAccountState()
      const { events, next } = detectAccountEvents(obs, prev, ruleConfig)
      state.accounts[obs.accountId] = next

      if (events.length > 0) {
        anyEvent = true
        // Any high-severity event in the batch pushes the whole alert hard.
        const priority = events.some((e) => e.severity === 'high') ? 'high' : 'normal'
        await connectorCenter.notify(buildAlertMessage(obs.label, events), {
          source: 'account-report',
          priority,
        })
      }
    }

    if (anyEvent) {
      state.lastSummaryAtMs = now()
    } else {
      const everyMs = parseDuration(config.summaryEvery) ?? 6 * 60 * 60 * 1000
      const due = state.lastSummaryAtMs === null || now() - state.lastSummaryAtMs >= everyMs
      if (due) {
        await connectorCenter.notify(buildQuietSummary(observations), { source: 'account-report' })
        state.lastSummaryAtMs = now()
      }
    }

    await saveState(state)
  }

  return {
    async start() {
      if (started) return
      started = true
      pump = createPump({
        name: 'account-report',
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
