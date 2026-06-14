import { describe, it, expect } from 'vitest'
import { decideNotification, emptyLifecycle, type AlertLifecycle } from './lifecycle.js'
import type { MicroSeverity, MicroSignal } from './rules.js'

const COOLDOWN = 30 * 60 * 1000 // 30m
const T0 = 1_000_000_000_000

function sig(severity: MicroSeverity): MicroSignal {
  return { type: 'spread_widening', severity, data: 'd', interpretation: 'i', action: 'a' }
}

describe('decideNotification', () => {
  it('first entry into active notifies and arms cooldown', () => {
    const r = decideNotification(sig('medium'), emptyLifecycle(), T0, COOLDOWN)
    expect(r.notify).toBe(true)
    expect(r.next).toMatchObject({ active: true, severity: 'medium', lastNotifiedAt: T0, cooldownUntil: T0 + COOLDOWN })
  })

  it('active + same severity does NOT notify (dedup)', () => {
    const prev: AlertLifecycle = { active: true, severity: 'medium', lastNotifiedAt: T0, cooldownUntil: T0 + COOLDOWN }
    const r = decideNotification(sig('medium'), prev, T0 + 60_000, COOLDOWN)
    expect(r.notify).toBe(false)
    expect(r.next.active).toBe(true)
  })

  it('severity escalation notifies even inside cooldown, and re-arms', () => {
    const prev: AlertLifecycle = { active: true, severity: 'medium', lastNotifiedAt: T0, cooldownUntil: T0 + COOLDOWN }
    const now = T0 + 60_000 // still inside cooldown
    const r = decideNotification(sig('high'), prev, now, COOLDOWN)
    expect(r.notify).toBe(true)
    expect(r.next.severity).toBe('high')
    expect(r.next.cooldownUntil).toBe(now + COOLDOWN)
  })

  it('de-escalation while active does not notify but tracks current severity', () => {
    const prev: AlertLifecycle = { active: true, severity: 'critical', lastNotifiedAt: T0, cooldownUntil: T0 + COOLDOWN }
    const r = decideNotification(sig('high'), prev, T0 + 60_000, COOLDOWN)
    expect(r.notify).toBe(false)
    expect(r.next.severity).toBe('high')
  })

  it('resolve clears active but keeps cooldown, silently', () => {
    const prev: AlertLifecycle = { active: true, severity: 'high', lastNotifiedAt: T0, cooldownUntil: T0 + COOLDOWN }
    const r = decideNotification(null, prev, T0 + 60_000, COOLDOWN)
    expect(r.notify).toBe(false)
    expect(r.next.active).toBe(false)
    expect(r.next.severity).toBeNull()
    expect(r.next.cooldownUntil).toBe(T0 + COOLDOWN) // kept for anti-flap
  })

  it('re-activation inside cooldown is tracked but NOT notified (anti-flap)', () => {
    // resolved at T0+1m, cooldownUntil still T0+30m
    const resolved: AlertLifecycle = { active: false, severity: null, lastNotifiedAt: T0, cooldownUntil: T0 + COOLDOWN }
    const r = decideNotification(sig('medium'), resolved, T0 + 5 * 60_000, COOLDOWN) // inside cooldown
    expect(r.notify).toBe(false)
    expect(r.next.active).toBe(true)
    expect(r.next.severity).toBe('medium')
  })

  it('re-activation AFTER cooldown notifies again', () => {
    const resolved: AlertLifecycle = { active: false, severity: null, lastNotifiedAt: T0, cooldownUntil: T0 + COOLDOWN }
    const now = T0 + COOLDOWN + 60_000 // past cooldown
    const r = decideNotification(sig('medium'), resolved, now, COOLDOWN)
    expect(r.notify).toBe(true)
    expect(r.next.cooldownUntil).toBe(now + COOLDOWN)
  })

  it('null signal on an idle alert is a no-op', () => {
    const r = decideNotification(null, emptyLifecycle(), T0, COOLDOWN)
    expect(r.notify).toBe(false)
    expect(r.next).toEqual(emptyLifecycle())
  })
})
