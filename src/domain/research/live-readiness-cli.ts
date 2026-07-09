import { loadConfig, type Config } from '@/core/config.js'
import {
  buildLiveReadinessReport,
  type LiveReadinessReport,
  type LiveReadinessReportDeps,
} from './live-readiness-report.js'

export interface LiveReadinessCliDeps {
  loadConfig?: () => Promise<Config>
  buildReport?: (deps: LiveReadinessReportDeps) => Promise<LiveReadinessReport>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export async function runLiveReadinessCli(deps: LiveReadinessCliDeps = {}): Promise<number> {
  const load = deps.loadConfig ?? loadConfig
  const buildReport = deps.buildReport ?? buildLiveReadinessReport
  const stdout = deps.stdout ?? console.log
  const stderr = deps.stderr ?? console.error

  try {
    const config = await load()
    const report = await buildReport({
      autoTrading: config.autoTrading,
      connectors: config.connectors,
      marketStateAlert: config.marketStateAlert,
      microstructureAlert: config.microstructureAlert,
    })

    stdout(JSON.stringify(report, null, 2))
    return report.status === 'ok' ? 0 : 1
  } catch (err) {
    stderr(err instanceof Error ? err.stack ?? err.message : String(err))
    return 1
  }
}
