/**
 * BTC Stress Rebound v1 — deterministic state-awareness monitor.
 *
 * Alert-only: no orders, no proposals, no risk-gate verdicts, no strategy
 * shadow ledger. It watches completed Binance spot BTCUSDT daily closes,
 * folds the pinned stress/rebound state machine, and notifies only on state
 * transitions (plus one initial smoke notification after first deployment).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { createPump, type Pump } from '../../core/pump.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { MarketStateAlertConfig } from '../../core/config.js'
import { fetchBinanceSpotDailyCandles, type FetchKlines } from '../../domain/research/stress-rebound/binance.js'
import { computeStressRebound, transitionKey, type StressReboundState, type StressTransition, type StressTransitionType } from '../../domain/research/stress-rebound/machine.js'
import { paramsFromConfig } from '../../domain/research/market-state-report.js'

export interface MarketStateAlertState {
  schemaVersion: 1
  lastEvaluatedDayUtc?: string
  lastNotifiedTransitionKey?: string
  initialSmokeSentFor?: string
}

export interface MarketStateAlertOpts {
  config: MarketStateAlertConfig
  connectorCenter: ConnectorCenter
  now?: () => Date
  fetchKlines?: FetchKlines
}

export interface MarketStateAlert {
  start(): Promise<void>
  stop(): void
  runNow(): Promise<void>
  isEnabled(): boolean
}

function defaultState(): MarketStateAlertState {
  return { schemaVersion: 1 }
}

async function loadState(path: string): Promise<MarketStateAlertState> {
  try {
    const raw = JSON.parse(await readFile(resolve(path), 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('state must be a JSON object')
    const state = raw as Partial<MarketStateAlertState>
    if (state.schemaVersion !== undefined && state.schemaVersion !== 1) throw new Error(`unsupported schemaVersion: ${String(state.schemaVersion)}`)
    for (const key of ['lastEvaluatedDayUtc', 'lastNotifiedTransitionKey', 'initialSmokeSentFor'] as const) {
      if (state[key] !== undefined && typeof state[key] !== 'string') throw new Error(`${key} must be a string`)
    }
    return {
      schemaVersion: 1,
      lastEvaluatedDayUtc: state.lastEvaluatedDayUtc,
      lastNotifiedTransitionKey: state.lastNotifiedTransitionKey,
      initialSmokeSentFor: state.initialSmokeSentFor,
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultState()
    }
    throw new Error(`market-state-alert state unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function loadStateOrUndefined(path: string): Promise<MarketStateAlertState | undefined> {
  try {
    return await loadState(path)
  } catch (err) {
    console.warn(err instanceof Error ? err.message : String(err))
    return undefined
  }
}

async function saveState(path: string, state: MarketStateAlertState): Promise<void> {
  const abs = resolve(path)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  await rename(tmp, abs)
}

function formatLine(label: string, value: string | undefined): string {
  return value ? `${label}: ${value}` : `${label}: n/a`
}

const STATE_LABELS: Record<StressReboundState, string> = {
  normal: '正常',
  stress_watch: '壓力觀察',
  rebound_confirmed: '反彈確認',
  structure_repair: '結構修復',
}

const EVENT_LABELS: Record<StressTransitionType, string> = {
  enter_stress_watch: '進入壓力觀察',
  rebound_confirmed: '反彈確認成立',
  structure_repair: '結構修復',
  long_term_repair: '長期壓力解除',
  failure: '確認失敗',
  timeout: '修復逾時',
}

function stateLabel(state: StressReboundState | string): string {
  return state in STATE_LABELS ? `${STATE_LABELS[state as StressReboundState]}(${state})` : state
}

export function buildTransitionMessage(t: StressTransition, nextTrigger: string | undefined, opts: { catchUp?: boolean } = {}): string {
  const lines = [
    'BTC 壓力反彈 v1 — 狀態轉移',
    ...(opts.catchUp ? ['停機期間補發:這個轉態發生時 Alice 沒有在評估日線收盤。'] : []),
    `日期: ${t.dateUtc}`,
    `狀態: ${stateLabel(t.from)} -> ${stateLabel(t.to)}`,
    `事件: ${EVENT_LABELS[t.type]}(${t.type})`,
    `觸發原因: ${t.trigger}`,
    formatLine('收盤價', t.close),
    formatLine('這波高點(event_peak_close)', t.eventPeakClose),
    formatLine('這波低點(trough_close)', t.troughClose),
    formatLine('反彈確認線(rebound_line)', t.reboundLine),
    ...(t.reasonLines.length > 0 ? ['原因:', ...t.reasonLines.map(line => `- ${line}`)] : []),
    `下一個條件: ${nextTrigger ?? 'n/a'}`,
    '依你的 v1 規則,這只代表人工 review 條件成立,不代表任何執行動作。',
    '提醒:這不是交易訊號。如果你選擇交易,請走 Alice stage -> commit -> Trading as Git verdict。',
  ]
  return lines.join('\n')
}

export function buildInitialMessage(args: {
  dateUtc: string
  state: string
  close: string
  eventPeakClose: string
  troughClose?: string
  reboundLine?: string
  reasonLines?: string[]
  nextTrigger: string
}): string {
  return [
    'BTC 壓力反彈 v1 — 初始狀態',
    '這只是啟用確認,不是狀態轉移。',
    `日期: ${args.dateUtc}`,
    `目前狀態: ${stateLabel(args.state)}`,
    formatLine('收盤價', args.close),
    formatLine('這波高點(event_peak_close)', args.eventPeakClose),
    formatLine('這波低點(trough_close)', args.troughClose),
    formatLine('反彈確認線(rebound_line)', args.reboundLine),
    ...(args.reasonLines && args.reasonLines.length > 0 ? ['原因:', ...args.reasonLines.map(line => `- ${line}`)] : []),
    `下一個條件: ${args.nextTrigger}`,
    '提醒:這不是交易訊號。如果你選擇交易,請走 Alice stage -> commit -> Trading as Git verdict。',
  ].join('\n')
}

const DAY_MS = 86_400_000

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
}

function latestTransitionAfter(transitions: readonly StressTransition[], dateUtc: string | undefined): StressTransition | undefined {
  const matches = transitions.filter(t => dateUtc === undefined || t.dateUtc > dateUtc)
  return matches.length > 0 ? matches[matches.length - 1] : undefined
}

export function createMarketStateAlert(opts: MarketStateAlertOpts): MarketStateAlert {
  const { config, connectorCenter } = opts
  const now = opts.now ?? (() => new Date())
  let pump: Pump | null = null
  let started = false

  async function onTick(): Promise<void> {
    const nowDate = now()
    let candles
    try {
      candles = await fetchBinanceSpotDailyCandles(config.symbol, config.historyLimit, nowDate, opts.fetchKlines)
    } catch (err) {
      console.warn(`market-state-alert: kline fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const result = computeStressRebound(candles, paramsFromConfig(config))
    if (!result.ok || !result.latest) {
      console.warn(`market-state-alert: state unavailable: ${result.error ?? 'no completed daily state available'}`)
      return
    }

    const state = await loadStateOrUndefined(config.statePath)
    if (!state) return
    const latest = result.latest
    if (state.lastEvaluatedDayUtc === latest.dateUtc) return

    if (!state.initialSmokeSentFor) {
      await connectorCenter.notify(buildInitialMessage({
        dateUtc: latest.dateUtc,
        state: latest.state,
        close: latest.close,
        eventPeakClose: latest.eventPeakClose,
        troughClose: latest.troughClose,
        reboundLine: latest.reboundLine,
        reasonLines: latest.reasonLines,
        nextTrigger: latest.nextTrigger,
      }), { source: 'market-state-alert', priority: 'high' })
      state.initialSmokeSentFor = `${latest.dateUtc}:${latest.state}`
      state.lastEvaluatedDayUtc = latest.dateUtc
      await saveState(config.statePath, state)
      return
    }

    const candidate = latestTransitionAfter(result.transitions, state.lastEvaluatedDayUtc)
    if (candidate) {
      const key = transitionKey(candidate)
      if (state.lastNotifiedTransitionKey !== key) {
        const catchUp = state.lastEvaluatedDayUtc !== undefined && daysBetween(state.lastEvaluatedDayUtc, latest.dateUtc) > 1
        await connectorCenter.notify(buildTransitionMessage(candidate, latest.nextTrigger, { catchUp }), { source: 'market-state-alert', priority: 'high' })
        state.lastNotifiedTransitionKey = key
      }
    }
    state.lastEvaluatedDayUtc = latest.dateUtc
    await saveState(config.statePath, state)
  }

  return {
    async start() {
      if (started) return
      started = true
      pump = createPump({
        name: 'market-state-alert',
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
