import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { applyEquity, legsBetween, markDay, stanceNum } from './mark.js'

const COST = { feeBpsPerLeg: 7, slippageBpsPerLeg: 3 } // pinned family: 10 bps/leg

describe('mark math (docs/strategy-shadow-track-v0.md daily semantics)', () => {
  it('stanceNum: long=+1 short=−1 flat=0', () => {
    expect(stanceNum('long')).toBe(1)
    expect(stanceNum('short')).toBe(-1)
    expect(stanceNum('flat')).toBe(0)
  })

  it('legsBetween: entry=1, exit=1, flip=2, hold=0', () => {
    expect(legsBetween('flat', 'long')).toBe(1)
    expect(legsBetween('long', 'flat')).toBe(1)
    expect(legsBetween('long', 'short')).toBe(2)
    expect(legsBetween('short', 'long')).toBe(2)
    expect(legsBetween('long', 'long')).toBe(0)
    expect(legsBetween('flat', 'flat')).toBe(0)
  })

  it('long gross return: 100 → 102 = +0.02', () => {
    const m = markDay({
      heldStance: 'long', prevHeldStance: 'long',
      prevClose: new Decimal(100), close: new Decimal(102), costModel: COST,
    })
    expect(m.grossRet.toFixed()).toBe('0.02')
    expect(m.legs).toBe(0)
    expect(m.netRet.toFixed()).toBe('0.02')
  })

  it('short gross return: 100 → 102 = −0.02 (sign flipped)', () => {
    const m = markDay({
      heldStance: 'short', prevHeldStance: 'short',
      prevClose: new Decimal(100), close: new Decimal(102), costModel: COST,
    })
    expect(m.grossRet.toFixed()).toBe('-0.02')
  })

  it('flat held stance earns exactly 0 regardless of the move', () => {
    const m = markDay({
      heldStance: 'flat', prevHeldStance: 'flat',
      prevClose: new Decimal(100), close: new Decimal(150), costModel: COST,
    })
    expect(m.grossRet.toFixed()).toBe('0')
    expect(m.netRet.toFixed()).toBe('0')
  })

  it('entry day charges 1 leg: net = gross − 0.001 at 10 bps/leg', () => {
    const m = markDay({
      heldStance: 'long', prevHeldStance: 'flat',
      prevClose: new Decimal(100), close: new Decimal(102), costModel: COST,
    })
    expect(m.legs).toBe(1)
    expect(m.costPerLegBps.toFixed()).toBe('10')
    expect(m.netRet.toFixed()).toBe('0.019') // 0.02 − 0.001, exact Decimal
  })

  it('flip day charges 2 legs: net = gross − 0.002', () => {
    const m = markDay({
      heldStance: 'short', prevHeldStance: 'long',
      prevClose: new Decimal(100), close: new Decimal(98), costModel: COST,
    })
    expect(m.grossRet.toFixed()).toBe('0.02') // short, price fell 2%
    expect(m.legs).toBe(2)
    expect(m.netRet.toFixed()).toBe('0.018')
  })

  it('applyEquity compounds: 1 × (1 + 0.019) = 1.019, then × (1 − 0.001)', () => {
    const e1 = applyEquity(new Decimal(1), new Decimal('0.019'))
    expect(e1.toFixed()).toBe('1.019')
    const e2 = applyEquity(e1, new Decimal('-0.001'))
    expect(e2.toFixed()).toBe('1.017981') // exact: 1.019 × 0.999
  })
})
