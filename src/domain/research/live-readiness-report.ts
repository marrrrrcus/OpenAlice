import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type {
  AutoTradingConfig,
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
  marketStateAlert: MarketStateAlertConfig
  microstructureAlert: MicrostructureAlertConfig
  now?: () => Date
  readText?: (path: string) => Promise<string>
  marketStateReport?: () => Promise<MarketStateReport>
}

const DISCIPLINE = 'Alert readiness only. This is not a trade signal, proposal, strategy-shadow result, or permission to place orders.'

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

function checkMarketStateState(raw: unknown): string {
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

  return typeof last === 'string' ? `last evaluated UTC day ${last}` : 'state readable; no evaluated day recorded yet'
}

function checkMicrostructureState(raw: unknown): string {
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

  return `state readable; ${Object.keys(baselines).length} baseline key(s), ${Object.keys(lifecycles).length} lifecycle key(s)`
}

export async function buildLiveReadinessReport(deps: LiveReadinessReportDeps): Promise<LiveReadinessReport> {
  const now = deps.now ?? (() => new Date())
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf-8'))
  const marketStateReport = deps.marketStateReport ?? (() => buildMarketStateReport({ config: deps.marketStateAlert }))
  const checks: LiveReadinessCheck[] = []

  checks.push(
    deps.autoTrading.enabled
      ? attention('auto_trading_disabled', 'Auto-trading disabled', 'autoTrading.enabled is true; current BTC stress layer is alert-only')
      : ok('auto_trading_disabled', 'Auto-trading disabled', 'autoTrading.enabled is false'),
  )

  checks.push(
    deps.marketStateAlert.enabled
      ? ok('market_state_alert_enabled', 'BTC stress monitor enabled', `market-state-alert every ${deps.marketStateAlert.every}`)
      : attention('market_state_alert_enabled', 'BTC stress monitor enabled', 'market-state-alert is disabled'),
  )

  try {
    const detail = checkMarketStateState(await readJson(deps.marketStateAlert.statePath, readText))
    checks.push(ok('market_state_alert_state', 'BTC stress state file readable', detail))
  } catch (err) {
    checks.push(attention(
      'market_state_alert_state',
      'BTC stress state file readable',
      err instanceof Error ? err.message : String(err),
    ))
  }

  try {
    const report = await marketStateReport()
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
    const detail = checkMicrostructureState(await readJson(deps.microstructureAlert.statePath, readText))
    checks.push(ok('microstructure_alert_state', 'Microstructure state file readable', detail))
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
