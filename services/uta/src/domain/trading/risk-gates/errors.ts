/**
 * RiskGateBlockedError — thrown by UnifiedTradingAccount.push() when the
 * risk-gate pipeline (docs/risk-gate-pipeline-v0.md) evaluates the pending
 * commit as BLOCK under enforce mode.
 *
 * Thrown BEFORE TradingGit.push() starts, so nothing reaches the broker and
 * the pending commit stays fully intact — it can be rejected, or re-approved
 * after a config change. Never auto-retried.
 *
 * HTTP layers map this to a 409 with the structured report attached
 * (mirroring the pendingHash guard's 409).
 */

import type { RiskGateStatus } from '@traderalice/uta-protocol'

export class RiskGateBlockedError extends Error {
  readonly report: RiskGateStatus

  constructor(report: RiskGateStatus) {
    const blocked = report.verdicts.filter(v => v.result === 'BLOCK')
    const summary = blocked.map(v => `[${v.gate}] ${v.reason}`).join('; ')
    super(`Risk gates blocked this push: ${summary || 'blocked'}`)
    this.name = 'RiskGateBlockedError'
    this.report = report
  }
}
