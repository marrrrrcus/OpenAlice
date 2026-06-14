/**
 * microstructure-alert — alert lifecycle / dedup / cooldown (pure).
 *
 * Decides *whether to notify* for one `(symbol, alert_type)` given the
 * current rule result and the prior lifecycle state. This is the
 * load-bearing noise-control layer: microstructure metrics jitter, so a
 * rule that "fires" every tick must not notify every tick.
 *
 * Policy (docs/microstructure-alerts.md → State, Dedup, And Cooldown):
 *   - first entry into active        -> notify, arm cooldown
 *   - severity escalation            -> notify, bypass cooldown, re-arm
 *   - active but same/lower severity -> do not notify (track current)
 *   - resolve (rule stops firing)    -> clear active, keep cooldown (anti-flap), silent
 *   - re-activate while in cooldown   -> track active, do NOT notify (anti-flap)
 *
 * Cooldown is a *notification gate* (`cooldownUntil`), not a separate alert
 * state — the underlying alert may be active while notification is gated.
 */

import type { MicroSeverity, MicroSignal } from './rules.js'

export interface AlertLifecycle {
  active: boolean
  severity: MicroSeverity | null
  lastNotifiedAt: number | null
  /** Notifications are suppressed until this epoch-ms (anti-flap). */
  cooldownUntil: number | null
}

export function emptyLifecycle(): AlertLifecycle {
  return { active: false, severity: null, lastNotifiedAt: null, cooldownUntil: null }
}

const RANK: Record<MicroSeverity, number> = { medium: 1, high: 2, critical: 3 }

export interface NotifyDecision {
  notify: boolean
  next: AlertLifecycle
}

/**
 * @param signal      the rule's current result, or null if it isn't firing
 * @param prev        prior lifecycle for this (symbol, alert_type)
 * @param nowMs       wall clock
 * @param cooldownMs  notification cooldown window
 */
export function decideNotification(
  signal: MicroSignal | null,
  prev: AlertLifecycle,
  nowMs: number,
  cooldownMs: number,
): NotifyDecision {
  // ---- rule not firing ----
  if (signal === null) {
    if (!prev.active) return { notify: false, next: prev }
    // Resolve: clear active, KEEP cooldownUntil so a fast re-trip is gated.
    return {
      notify: false,
      next: { ...prev, active: false, severity: null },
    }
  }

  // ---- rule firing ----
  const inCooldown = prev.cooldownUntil !== null && nowMs < prev.cooldownUntil

  if (!prev.active) {
    // Fresh activation. Suppress (but still mark active) if anti-flap cooldown
    // from a recent alert is still running.
    if (inCooldown) {
      return { notify: false, next: { ...prev, active: true, severity: signal.severity } }
    }
    return {
      notify: true,
      next: { active: true, severity: signal.severity, lastNotifiedAt: nowMs, cooldownUntil: nowMs + cooldownMs },
    }
  }

  // Already active.
  const escalated = prev.severity !== null && RANK[signal.severity] > RANK[prev.severity]
  if (escalated) {
    // Escalation bypasses cooldown and re-arms it.
    return {
      notify: true,
      next: { active: true, severity: signal.severity, lastNotifiedAt: nowMs, cooldownUntil: nowMs + cooldownMs },
    }
  }

  // Active, same or lower severity -> track current severity, do not notify.
  return { notify: false, next: { ...prev, active: true, severity: signal.severity } }
}
