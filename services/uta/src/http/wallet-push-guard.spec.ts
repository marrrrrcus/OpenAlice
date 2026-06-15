/**
 * Tests for the fail-closed pendingHash guard on the manual approval
 * routes:
 *   POST /api/trading/uta/:id/wallet/push
 *   POST /api/trading/uta/:id/wallet/reject
 *
 * The approver must echo back the pendingHash they were shown. If it's
 * missing or no longer matches the current pending commit, the route
 * returns 409 and does NOT execute / discard the commit. The only thing
 * this can do wrong is block a legitimate approval (acceptable fail-safe);
 * it can never push or reject a commit the user didn't actually see.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTradingRoutes } from './routes-trading.js'
import type { EngineContext } from '@/core/types.js'

const PENDING_HASH = 'a1b2c3d4'

function makeMockUTA() {
  const push = vi.fn(async () => ({
    hash: PENDING_HASH,
    message: 'pending op',
    operationCount: 1,
    submitted: [{ action: 'placeOrder', success: true, orderId: 'ord-1', status: 'Submitted' }],
    rejected: [],
  }))
  const reject = vi.fn(async () => ({ hash: 'rej', message: 'rolled back', operationCount: 0 }))
  return {
    push,
    reject,
    uta: {
      id: 'mock-uta',
      label: 'Mock UTA',
      push,
      reject,
      // A commit is pending, with a known hash the client must echo back.
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
    utaManager: {
      get: (id: string) => (id === 'mock-uta' ? uta : undefined),
      resolve: () => [],
      listUTAs: () => [],
      getAggregatedEquity: vi.fn(),
    },
    snapshotService: undefined,
  } as unknown as EngineContext
  return createTradingRoutes(ctx)
}

async function post(routes: ReturnType<typeof createTradingRoutes>, path: string, body: unknown) {
  const res = await routes.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, body: json }
}

describe('POST /uta/:id/wallet/push — pendingHash guard', () => {
  let mock: ReturnType<typeof makeMockUTA>
  beforeEach(() => { mock = makeMockUTA() })

  it('executes when expectedHash matches the pending commit', async () => {
    const routes = makeRoutes(mock.uta)
    const { status, body } = await post(routes, '/uta/mock-uta/wallet/push', { expectedHash: PENDING_HASH })
    expect(status).toBe(200)
    expect((body as { hash: string }).hash).toBe(PENDING_HASH)
    expect(mock.push).toHaveBeenCalledTimes(1)
  })

  it('blocks (409) and does NOT push when expectedHash is wrong', async () => {
    const routes = makeRoutes(mock.uta)
    const { status } = await post(routes, '/uta/mock-uta/wallet/push', { expectedHash: 'deadbeef' })
    expect(status).toBe(409)
    expect(mock.push).not.toHaveBeenCalled()
  })

  it('blocks (409) and does NOT push when expectedHash is missing (fail-closed)', async () => {
    const routes = makeRoutes(mock.uta)
    const { status } = await post(routes, '/uta/mock-uta/wallet/push', {})
    expect(status).toBe(409)
    expect(mock.push).not.toHaveBeenCalled()
  })

  it('still returns 400 (not 409) when there is nothing pending', async () => {
    const empty = makeMockUTA()
    empty.uta.status = vi.fn(() => ({ pendingMessage: null, pendingHash: null, staged: [], head: null, commitCount: 0 }))
    const routes = makeRoutes(empty.uta)
    const { status } = await post(routes, '/uta/mock-uta/wallet/push', { expectedHash: PENDING_HASH })
    expect(status).toBe(400)
    expect(empty.push).not.toHaveBeenCalled()
  })
})

describe('POST /uta/:id/wallet/reject — pendingHash guard', () => {
  let mock: ReturnType<typeof makeMockUTA>
  beforeEach(() => { mock = makeMockUTA() })

  it('rejects the commit when expectedHash matches', async () => {
    const routes = makeRoutes(mock.uta)
    const { status } = await post(routes, '/uta/mock-uta/wallet/reject', { expectedHash: PENDING_HASH })
    expect(status).toBe(200)
    expect(mock.reject).toHaveBeenCalledTimes(1)
  })

  it('blocks (409) and does NOT reject when expectedHash is wrong', async () => {
    const routes = makeRoutes(mock.uta)
    const { status } = await post(routes, '/uta/mock-uta/wallet/reject', { expectedHash: 'deadbeef' })
    expect(status).toBe(409)
    expect(mock.reject).not.toHaveBeenCalled()
  })

  it('blocks (409) and does NOT reject when expectedHash is missing (fail-closed)', async () => {
    const routes = makeRoutes(mock.uta)
    const { status } = await post(routes, '/uta/mock-uta/wallet/reject', {})
    expect(status).toBe(409)
    expect(mock.reject).not.toHaveBeenCalled()
  })
})
