import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { parseDuration } from '@/core/duration.js'
import type {
  AutoTradingConfig,
  Config,
  LiveReadinessAlertConfig,
  MarketStateAlertConfig,
  MicrostructureAlertConfig,
} from '@/core/config.js'
import {
  buildMarketStateReport,
  type MarketStateReport,
} from './market-state-report.js'

export type LiveReadinessStatus = 'ok' | 'attention'

export interface LiveReadinessCheck {
  id: string
  label: string
  status: LiveReadinessStatus
  detail: string
}

export interface LiveReadinessReport {
  status: LiveReadinessStatus
  generatedAt: string
  scope: 'alert_only_monitoring'
  checks: LiveReadinessCheck[]
  attentionItems: string[]
  discipline: string
}

export interface LiveReadinessReportDeps {
  autoTrading: AutoTradingConfig
  connectors: Config['connectors']
  liveReadinessAlert: LiveReadinessAlertConfig
  marketStateAlert: MarketStateAlertConfig
  microstructureAlert: MicrostructureAlertConfig
  now?: () => Date
  readText?: (path: string) => Promise<string>
  marketStateReport?: () => Promise<MarketStateReport>
}

const DISCIPLINE = 'Alert readiness only. This is not a trade signal, proposal, strategy-shadow result, or permission to place orders.'
const MICROSTRUCTURE_STALE_MULTIPLE = 2

function ok(id: string, label: string, detail: string): LiveReadinessCheck {
  return { id, label, status: 'ok', detail }
}

function attention(id: string, label: string, detail: string): LiveReadinessCheck {
  return { id, label, status: 'attention', detail }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

async function readJson(path: string, readText: (path: string) => Promise<string>): Promise<unknown> {
  return parseJson(await readText(resolve(path)))
}

interface MarketStateStateCheck {
  detail: string
  lastEvaluatedDayUtc?: string
}

function checkMarketStateState(raw: unknown): MarketStateStateCheck {
  if (!isRecord(raw)) throw new Error('state must be a JSON object')
  if (raw['schemaVersion'] !== 1) throw new Error('schemaVersion must be 1')

  const last = raw['lastEvaluatedDayUtc']
  if (last !== undefined && typeof last !== 'string') {
    throw new Error('lastEvaluatedDayUtc must be a string when present')
  }

  const smoke = raw['initialSmokeSentFor']
  if (smoke !== undefined && typeof smoke !== 'string') {
    throw new Error('initialSmokeSentFor must be a string when present')
  }

  return typeof last === 'string'
    ? { detail: `last evaluated UTC day ${last}`, lastEvaluatedDayUtc: last }
    : { detail: 'state readable; no evaluated day recorded yet' }
}

interface MicrostructureStateCheck {
  detail: string
  lastFundingAtMs: number | null
}

function checkMicrostructureState(raw: unknown): MicrostructureStateCheck {
  if (!isRecord(raw)) throw new Error('state must be a JSON object')
  const baselines = raw['baselines']
  if (!isRecord(baselines)) throw new Error('baselines must be an object')
  const lifecycles = raw['lifecycles']
  if (!isRecord(lifecycles)) throw new Error('lifecycles must be an object')
  const lastFunding = raw['lastFundingAtMs']
  if (
    lastFunding !== null
    && lastFunding !== undefined
    && (typeof lastFunding !== 'number' || !Number.isFinite(lastFunding) || lastFunding < 0)
  ) {
    throw new Error('lastFundingAtMs must be null or a non-negative finite number')
  }

  return {
    detail: `state readable; ${Object.keys(baselines).length} baseline key(s), ${Object.keys(lifecycles).length} lifecycle key(s)`,
    lastFundingAtMs: typeof lastFunding === 'number' ? lastFunding : null,
  }
}

export async function buildLiveReadinessReport(deps: LiveReadinessReportDeps): Promise<LiveReadinessReport> {
  const now = deps.now ?? (() => new Date())
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf-8'))
  const marketStateReport = deps.marketStateReport ?? (() => buildMarketStateReport({ config: deps.marketStateAlert }))
  const checks: LiveReadinessCheck[] = []
  let marketStateLastEvaluatedDayUtc: string | undefined
  let currentMarketStateReport: MarketStateReport | undefined

  checks.push(
    deps.autoTrading.enabled
      ? attention('auto_trading_disabled', 'Auto-trading disabled', 'autoTrading.enabled is true; current BTC stress layer is alert-only')
      : ok('auto_trading_disabled', 'Auto-trading disabled', 'autoTrading.enabled is false'),
  )

  checks.push(
    deps.liveReadinessAlert.enabled
      ? ok('live_readiness_alert_enabled', 'Readiness self-monitor enabled', `live-readiness-alert every ${deps.liveReadinessAlert.every}`)
      : attention('live_readiness_alert_enabled', 'Readiness self-monitor enabled', 'live-readiness-alert is disabled; readiness attention will not self-notify'),
  )

  checks.push(
    deps.connectors.telegram.enabled
      ? ok('telegram_enabled', 'Telegram connector enabled', 'telegram.enabled is true')
      : attention('telegram_enabled', 'Telegram connector enabled', 'telegram.enabled is false; alerts cannot be delivered'),
  )

  checks.push(
    deps.connectors.telegram.botToken
      ? ok('telegram_bot_token', 'Telegram bot token present', 'bot token present; value redacted')
      : attention('telegram_bot_token', 'Telegram bot token present', 'bot token missing; alerts cannot be delivered'),
  )

  checks.push(
    deps.connectors.telegram.chatIds.length > 0
      ? ok('telegram_chat_ids', 'Telegram chat target configured', `${deps.connectors.telegram.chatIds.length} chat target(s); ids redacted`)
      : attention('telegram_chat_ids', 'Telegram chat target configured', 'no chat target configured; alerts cannot be delivered'),
  )

  checks.push(
    deps.marketStateAlert.enabled
      ? ok('market_state_alert_enabled', 'BTC stress monitor enabled', `market-state-alert every ${deps.marketStateAlert.every}`)
      : attention('market_state_alert_enabled', 'BTC stress monitor enabled', 'market-state-alert is disabled'),
  )

  try {
    const stateCheck = checkMarketStateState(await readJson(deps.marketStateAlert.statePath, readText))
    marketStateLastEvaluatedDayUtc = stateCheck.lastEvaluatedDayUtc
    checks.push(ok('market_state_alert_state', 'BTC stress state file readable', stateCheck.detail))
  } catch (err) {
    checks.push(attention(
      'market_state_alert_state',
      'BTC stress state file readable',
      err instanceof Error ? err.message : String(err),
    ))
  }

  try {
    const report = await marketStateReport()
    currentMarketStateReport = report
    if (report.status === 'ok') {
      checks.push(ok('market_state_report_current', 'BTC stress report current', `${report.state ?? 'unknown'} on ${report.dateUtc ?? 'unknown date'}`))
    } else {
      checks.push(attention('market_state_report_current', 'BTC stress report current', report.reason ?? 'market_state_report returned UNKNOWN'))
    }
  } catch (err) {
    checks.push(attention(
      'market_state_report_current',
      'BTC stress report current',
      err instanceof Error ? err.message : String(err),
    ))
  }

  if (currentMarketStateReport?.status === 'ok' && currentMarketStateReport.dateUtc) {
    if (!marketStateLastEvaluatedDayUtc) {
      checks.push(attention(
        'market_state_alert_fresh',
        'BTC stress scheduled state fresh',
        `no evaluated day recorded; current completed day is ${currentMarketStateReport.dateUtc}`,
      ))
    } else if (marketStateLastEvaluatedDayUtc !== currentMarketStateReport.dateUtc) {
      checks.push(attention(
        'market_state_alert_fresh',
        'BTC stress scheduled state fresh',
        `state last evaluated ${marketStateLastEvaluatedDayUtc}, but current completed day is ${currentMarketStateReport.dateUtc}`,
      ))
    } else {
      checks.push(ok(
        'market_state_alert_fresh',
        'BTC stress scheduled state fresh',
        `scheduled state matches current completed day ${currentMarketStateReport.dateUtc}`,
      ))
    }
  }

  checks.push(
    deps.microstructureAlert.enabled
      ? ok('microstructure_alert_enabled', 'Microstructure monitor enabled', `microstructure-alert watches ${deps.microstructureAlert.symbols.length} symbol(s)`)
      : attention('microstructure_alert_enabled', 'Microstructure monitor enabled', 'microstructure-alert is disabled'),
  )

  checks.push(
    deps.microstructureAlert.source
      ? ok('microstructure_alert_source', 'Microstructure source configured', deps.microstructureAlert.source)
      : attention('microstructure_alert_source', 'Microstructure source configured', 'source is empty; monitor will fall back to the first resolved UTA'),
  )

  try {
    const stateCheck = checkMicrostructureState(await readJson(deps.microstructureAlert.statePath, readText))
    checks.push(ok('microstructure_alert_state', 'Microstructure state file readable', stateCheck.detail))
    const fundingEveryMs = parseDuration(deps.microstructureAlert.fundingEvery)
    if (stateCheck.lastFundingAtMs === null) {
      checks.push(attention(
        'microstructure_alert_fresh',
        'Microstructure funding state fresh',
        'lastFundingAtMs is not recorded yet',
      ))
    } else if (!fundingEveryMs) {
      checks.push(attention(
        'microstructure_alert_fresh',
        'Microstructure funding state fresh',
        `fundingEvery is not parseable: ${deps.microstructureAlert.fundingEvery}`,
      ))
    } else {
      const ageMs = now().getTime() - stateCheck.lastFundingAtMs
      const maxAgeMs = fundingEveryMs * MICROSTRUCTURE_STALE_MULTIPLE
      if (ageMs > maxAgeMs) {
        checks.push(attention(
          'microstructure_alert_fresh',
          'Microstructure funding state fresh',
          `last funding tick is ${Math.round(ageMs / 60_000)}m old; expected <= ${Math.round(maxAgeMs / 60_000)}m`,
        ))
      } else {
        checks.push(ok(
          'microstructure_alert_fresh',
          'Microstructure funding state fresh',
          `last funding tick is ${Math.max(0, Math.round(ageMs / 60_000))}m old`,
        ))
      }
    }
  } catch (err) {
    checks.push(attention(
      'microstructure_alert_state',
      'Microstructure state file readable',
      err instanceof Error ? err.message : String(err),
    ))
  }

  const attentionItems = checks
    .filter((check) => check.status === 'attention')
    .map((check) => `${check.label}: ${check.detail}`)

  return {
    status: attentionItems.length === 0 ? 'ok' : 'attention',
    generatedAt: now().toISOString(),
    scope: 'alert_only_monitoring',
    checks,
    attentionItems,
    discipline: DISCIPLINE,
  }
}

export function createLiveReadinessReportTools(deps: LiveReadinessReportDeps) {
  return {
    live_readiness_report: tool({
      description: `Report alert-only live readiness for the BTC stress and microstructure monitors.

Read-only diagnostic: checks config/state health and current BTC stress report.
Never a trade signal, proposal, strategy-shadow result, or permission to place orders.`,
      inputSchema: z.object({}),
      execute: async () => buildLiveReadinessReport(deps),
    }),
  }
}
