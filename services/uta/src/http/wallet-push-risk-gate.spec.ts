/**
 * HTTP mapping for risk-gate blocks — mirrors wallet-push-guard.spec.ts.
 *
 * /wallet/push: RiskGateBlockedError → 409 with the structured report.
 * /wallet/status: attaches the preview when pending; a preview failure never
 * breaks the status surface. One-shot: order-entry returns the report so the
 * route can 409 with phase 'push'.
 */

import { describe, it, expect, vi } from 'vitest'
import { createTradingRoutes } from './routes-trading.js'
import { executeOneShotOrder } from '../domain/trading/order-entry.js'
import { RiskGateBlockedError } from '../domain/trading/risk-gates/index.js'
import type { UnifiedTradingAccount } from '../domain/trading/UnifiedTradingAccount.js'
import type { EngineContext } from '@/core/types.js'
import type { RiskGateStatus } from '@traderalice/uta-protocol'

const PENDING_HASH = 'abc12345'

const BLOCK_REPORT: RiskGateStatus = {
  mode: 'enforce',
  result: 'BLOCK',
  verdicts: [{
    gate: 'G1_MAX_ORDER_NOTIONAL',
    result: 'BLOCK',
    reason: 'order notional $1500.00 > effective cap $1000.00',
    observed: '1500.00',
    limit: '1000.00',
  }],
  evaluatedAt: new Date().toISOString(),
  configSource: 'file',
}

function makeMockUTA(opts: { pushError?: Error; preview?: RiskGateStatus | 'throws' } = {}) {
  const push = vi.fn(async () => {
    if (opts.pushError) throw opts.pushError
    return { hash: PENDING_HASH, message: 'ok', operationCount: 1, submitted: [], rejected: [] }
  })
  const previewRiskGates = vi.fn(async () => {
    if (opts.preview === 'throws') throw new Error('preview exploded')
    return opts.preview
  })
  return {
    push,
    previewRiskGates,
    uta: {
      id: 'mock-uta',
      label: 'Mock UTA',
      push,
      previewRiskGates,
      status: vi.fn(() => ({
        pendingMessage: 'pending op',
        pendingHash: PENDING_HASH,
        staged: [],
        head: null,
        commitCount: 0,
      })),
    },
  }
}

function makeRoutes(uta: unknown) {
  const ctx = {
    utaManager: { get: (id: string) => (id === 'mock-uta' ? uta : undefined) },
    snapshotService: undefined,
  } as unknown as EngineContext
  return createTradingRoutes(ctx)
}

async function req(routes: ReturnType<typeof createTradingRoutes>, method: string, path: string, body?: unknown) {
  const res = await routes.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, body: json as Record<string, unknown> | null }
}

describe('risk-gate HTTP mapping', () => {
  it('push: RiskGateBlockedError → 409 with structured riskGates report', async () => {
    const mock = makeMockUTA({ pushError: new RiskGateBlockedError(BLOCK_REPORT) })
    const routes = makeRoutes(mock.uta)
    const { status, body } = await req(routes, 'POST', '/uta/mock-uta/wallet/push', { expectedHash: PENDING_HASH })
    expect(status).toBe(409)
    expect((body?.riskGates as RiskGateStatus).result).toBe('BLOCK')
    expect(String(body?.error)).toContain('G1_MAX_ORDER_NOTIONAL')
  })

  it('push: other errors still map to 500 (no accidental 409 widening)', async () => {
    const mock = makeMockUTA({ pushError: new Error('broker exploded') })
    const routes = makeRoutes(mock.uta)
    const { status } = await req(routes, 'POST', '/uta/mock-uta/wallet/push', { expectedHash: PENDING_HASH })
    expect(status).toBe(500)
  })

  it('status: attaches the riskGates preview when a commit is pending', async () => {
    const mock = makeMockUTA({ preview: BLOCK_REPORT })
    const routes = makeRoutes(mock.uta)
    const { status, body } = await req(routes, 'GET', '/uta/mock-uta/wallet/status')
    expect(status).toBe(200)
    expect((body?.riskGates as RiskGateStatus).result).toBe('BLOCK')
    expect(mock.previewRiskGates).toHaveBeenCalledTimes(1)
  })

  it('status: a preview failure never breaks the status surface', async () => {
    const mock = makeMockUTA({ preview: 'throws' })
    const routes = makeRoutes(mock.uta)
    const { status, body } = await req(routes, 'GET', '/uta/mock-uta/wallet/status')
    expect(status).toBe(200)
    expect(body?.pendingHash).toBe(PENDING_HASH)
    expect(body?.riskGates).toBeUndefined()
  })

  it('one-shot: order-entry surfaces the report with phase push (route maps it to 409)', async () => {
    const err = new RiskGateBlockedError(BLOCK_REPORT)
    const uta = {
      stagePlaceOrder: vi.fn(),
      commit: vi.fn(),
      reject: vi.fn(),
      push: vi.fn(async () => { throw err }),
    } as unknown as UnifiedTradingAccount
    const r = await executeOneShotOrder(uta, 'msg', () => {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.phase).toBe('push')
    expect(r.riskGates?.result).toBe('BLOCK')
  })
})
