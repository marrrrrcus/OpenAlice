import { describe, it, expect } from 'vitest'
import { shouldSurfaceToTelegram } from './helpers.js'

describe('shouldSurfaceToTelegram', () => {
  it('pushes high-priority alerts regardless of last-interacted channel', () => {
    expect(shouldSurfaceToTelegram('high', 'web')).toBe(true)
    expect(shouldSurfaceToTelegram('high', undefined)).toBe(true)
    expect(shouldSurfaceToTelegram('high', 'telegram')).toBe(true)
  })

  it('inlines normal-priority notifications only when telegram is last-interacted', () => {
    expect(shouldSurfaceToTelegram('normal', 'telegram')).toBe(true)
    expect(shouldSurfaceToTelegram(undefined, 'telegram')).toBe(true)
  })

  it('drops normal-priority notifications when another channel is active', () => {
    expect(shouldSurfaceToTelegram('normal', 'web')).toBe(false)
    expect(shouldSurfaceToTelegram(undefined, 'web')).toBe(false)
    expect(shouldSurfaceToTelegram(undefined, undefined)).toBe(false)
  })
})
