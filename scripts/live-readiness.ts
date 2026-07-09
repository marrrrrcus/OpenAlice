/**
 * Read-only live alert readiness check.
 *
 * Run:
 *   pnpm live:readiness
 *
 * The report is intentionally NOT a trading gate. It checks whether the
 * alert-only monitors can compute, deliver, and stay fresh. Exit code is
 * automation-friendly: 0 = ok, 1 = attention required.
 */

import { loadConfig } from '../src/core/config.js'
import { buildLiveReadinessReport } from '../src/domain/research/live-readiness-report.js'

async function main() {
  const config = await loadConfig()
  const report = await buildLiveReadinessReport({
    autoTrading: config.autoTrading,
    connectors: config.connectors,
    marketStateAlert: config.marketStateAlert,
    microstructureAlert: config.microstructureAlert,
  })

  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'ok') process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})
