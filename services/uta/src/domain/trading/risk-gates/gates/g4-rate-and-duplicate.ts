/**
 * G4 — Rate limit + duplicate detection (canonical intent key).
 *
 * Rate: at most maxPushesPerHour EXECUTED pushes per account (rolling
 * hour), counted from the trading-git history. An executed push = a commit
 * whose results contain ≥1 successful broker-facing operation — this
 * excludes user-rejected commits, sync commits, and reconcile bookkeeping.
 * Risk-reducing pushes are exempt from the rate limit (a limiter must
 * never trap a human in a position; consistent with G3's exemption).
 *
 * Duplicate: each staged placeOrder/closePosition is compared by canonical
 * intent key against operations that EXECUTED successfully within
 * duplicateWindowSec. `pendingHash` is deliberately NOT part of the key —
 * the dangerous duplicate is the broker-timeout re-stage, which carries a
 * NEW hash (same-commit double-submits are already stopped by the
 * pendingHash guard). Decimal canonicalization makes "1" == "1.0"; market
 * orders carry explicit null price slots. Duplicate detection applies to
 * ALL intents — an accidental double-close flips a position.
 */

import type { GateVerdict, GitCommit, Operation } from '@traderalice/uta-protocol'
import type { RiskGate, RiskGateContext } from '../types.js'
import { canonDec } from '../decimal-io.js'

export const GATE_G4 = 'G4_RATE_DUPLICATE'

const BROKER_ACTIONS = new Set(['placeOrder', 'modifyOrder', 'closePosition', 'cancelOrder'])

/** Canonical intent key, or null when the operation is not keyable. */
export function canonicalIntentKey(op: Operation): string | null {
  if (op.action === 'placeOrder') {
    const instrument = op.contract?.aliceId || (op.contract?.symbol ? op.contract.symbol.toUpperCase() : null)
    if (!instrument) return null
    const side = op.order?.action ?? '?'
    const orderType = (op.order?.orderType ?? '?').toUpperCase()
    const qty = canonDec(op.order?.totalQuantity) ?? (canonDec(op.order?.cashQty) ? `CASH:${canonDec(op.order?.cashQty)}` : null)
    if (!qty) return null
    const lmt = canonDec(op.order?.lmtPrice) ?? 'NULL'
    const aux = canonDec(op.order?.auxPrice) ?? 'NULL'
    return ['placeOrder', instrument, side, orderType, qty, lmt, aux].join('|')
  }
  if (op.action === 'closePosition') {
    const instrument = op.contract?.aliceId || (op.contract?.symbol ? op.contract.symbol.toUpperCase() : null)
    if (!instrument) return null
    return ['closePosition', instrument, canonDec(op.quantity) ?? 'FULL'].join('|')
  }
  return null
}

function isExecutedPush(c: GitCommit): boolean {
  return c.results?.some(r => r.success && BROKER_ACTIONS.has(r.action)) ?? false
}

export const g4RateAndDuplicate: RiskGate = {
  name: GATE_G4,

  async evaluate(ctx: RiskGateContext): Promise<GateVerdict> {
    const nowMs = ctx.evaluatedAt.getTime()
    const hasIncreasing = ctx.intents.some(i => i.kind === 'risk-increasing')
    const stagedKeys = ctx.operations
      .map(op => ({ op, key: canonicalIntentKey(op) }))
      .filter((x): x is { op: Operation; key: string } => x.key !== null)

    if (!hasIncreasing && stagedKeys.length === 0) {
      return { gate: GATE_G4, result: 'NOT_APPLICABLE', reason: 'no rate-limited or keyable operations in this push' }
    }

    // ---- Rate limit (risk-increasing pushes only) ----
    if (hasIncreasing) {
      const hourAgo = nowMs - 3_600_000
      const executedInWindow = ctx.history.commits.filter(c => {
        const ts = Date.parse(c.timestamp)
        return Number.isFinite(ts) && ts >= hourAgo && isExecutedPush(c)
      }).length
      if (executedInWindow >= ctx.config.maxPushesPerHour) {
        return {
          gate: GATE_G4,
          result: 'BLOCK',
          code: 'RATE_LIMIT_EXCEEDED',
          reason: `${executedInWindow} executed pushes in the last hour ≥ limit ${ctx.config.maxPushesPerHour} — new risk-increasing pushes blocked until the window rolls`,
          observed: String(executedInWindow),
          limit: String(ctx.config.maxPushesPerHour),
        }
      }
    }

    // ---- Duplicate detection ----
    const windowMs = ctx.config.duplicateWindowSec * 1000
    for (const { key } of stagedKeys) {
      for (let i = ctx.history.commits.length - 1; i >= 0; i--) {
        const commit = ctx.history.commits[i]
        const ts = Date.parse(commit.timestamp)
        if (!Number.isFinite(ts) || nowMs - ts > windowMs) break // commits are chronological
        for (let j = 0; j < commit.operations.length; j++) {
          if (!commit.results[j]?.success) continue // user-rejected / failed ops are not at the broker
          const executedKey = canonicalIntentKey(commit.operations[j])
          if (executedKey !== null && executedKey === key) {
            const ageSec = Math.round((nowMs - ts) / 1000)
            return {
              gate: GATE_G4,
              result: 'BLOCK',
              code: 'DUPLICATE_INTENT',
              reason: `possible duplicate — an identical order executed ${ageSec}s ago (commit ${commit.hash}); if intentional, adjust price/quantity or wait ${ctx.config.duplicateWindowSec}s`,
              observed: `${ageSec}s ago`,
              limit: `${ctx.config.duplicateWindowSec}s window`,
            }
          }
        }
      }
    }

    return {
      gate: GATE_G4,
      result: 'PASS',
      reason: 'no hard-limit block detected: push rate within limit, no duplicate intent in window',
    }
  },
}
