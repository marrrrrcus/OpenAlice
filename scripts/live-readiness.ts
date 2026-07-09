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

import { runLiveReadinessCli } from '../src/domain/research/live-readiness-cli.js'

process.exitCode = await runLiveReadinessCli()
