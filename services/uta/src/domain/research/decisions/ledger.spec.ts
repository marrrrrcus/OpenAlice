import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendRow,
  effectiveMarks,
  isValidBrakesRow,
  isValidDecisionsRow,
  isValidDerivedRow,
  markKey,
  readDecisionsRows,
  readDerivedRows,
} from './ledger.js'
import type { DecisionChildRow, DecisionParentRow, MarkRow } from './types.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'decisions-ledger-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const parent: DecisionParentRow = {
  kind: 'push', v: 1, id: 'dec:a:h1', accountId: 'a', presetId: 'p',
  capturedAt: 't', decidedAt: 't', pendingHash: 'h1', message: 'm',
  gateSummary: { mode: 'observe', result: 'PASS', configSource: 'file', evaluatedAt: 't', verdicts: [] },
  override: false, overrideReason: null, thesis: null,
  results: { submitted: 1, rejected: 0 }, childCount: 1,
}
const child: DecisionChildRow = {
  kind: 'intent', v: 1, id: 'dec:a:h1#0', parentId: 'dec:a:h1', accountId: 'a',
  capturedAt: 't', opIndex: 0, opAction: 'placeOrder',
  intent: { kind: 'risk-increasing', rationale: 'r' }, role: 'entry', side: 'LONG',
  markSide: 'LONG', markSideMeaning: 'entry', pricedBy: 'lmtPrice',
  context: {
    regime: { zone: 'BEAR', contextSource: 'live' },
    funding: { bucket: 'unavailable', contextSource: 'live' },
  },
}
const mark = (childId: string, horizon: MarkRow['horizon'], status: MarkRow['status'], at: string): MarkRow =>
  status === 'unmarkable'
    ? { kind: 'mark', v: 1, childId, horizon, at, status, reason: 'test' }
    : {
        kind: 'mark', v: 1, childId, horizon, at, status,
        side: 'LONG', anchorPolicy: 'next-daily-open', anchorDateUtc: '2026-07-04',
        entryPrice: '100', exitPrice: '101', ret: '0.01', mae: '-0.02', mfe: '0.03',
        entryOpenDateUtc: '2026-07-04', exitCloseDateUtc: '2026-07-04',
      }

describe('decisions ledger', () => {
  it('append/read roundtrip; malformed and invalid lines skipped', async () => {
    const path = join(dir, 'a.decisions.jsonl')
    await appendRow(path, parent)
    await appendRow(path, child)
    await appendFile(path, 'garbage\n')
    await appendFile(path, JSON.stringify({ kind: 'intent', id: 'x' }) + '\n') // incomplete
    await appendFile(path, JSON.stringify({ ...child, role: 'bogus' }) + '\n')
    await appendFile(path, JSON.stringify({ ...child, side: 'sideways' }) + '\n')
    const rows = await readDecisionsRows(path)
    expect(rows).toHaveLength(2)
  })

  it('non-ENOENT read failure THROWS — an unreadable ledger is never a cold start', async () => {
    await expect(readDecisionsRows(dir)).rejects.toThrow() // EISDIR
    expect(await readDecisionsRows(join(dir, 'missing.jsonl'))).toEqual([]) // ENOENT only
  })

  it('brake rows require the flat baseline and a known disposition', () => {
    const brakeChild = { ...child, kind: 'blocked-intent', baseline: 'flat' }
    expect(isValidBrakesRow(brakeChild)).toBe(true)
    expect(isValidBrakesRow({ ...brakeChild, baseline: 'executed' })).toBe(false)
    const brakeParent = { ...parent, kind: 'verdict', disposition: 'blocked', blockingGates: [] }
    expect(isValidBrakesRow(brakeParent)).toBe(true)
    expect(isValidBrakesRow({ ...brakeParent, disposition: 'maybe' })).toBe(false)
  })

  it('derived rows are kind-discriminated; unknown kinds rejected', () => {
    expect(isValidDerivedRow(mark('c1', '1D', 'marked', 't'))).toBe(true)
    expect(isValidDerivedRow({ kind: 'fundingContext', v: 1, childId: 'c1', at: 't', contextSource: 'derived', bucket: 'positive' })).toBe(true)
    expect(isValidDerivedRow({ kind: 'regimeContext', v: 1, childId: 'c1', at: 't', contextSource: 'derived', zone: 'BULL' })).toBe(true)
    expect(isValidDerivedRow({ kind: 'mystery', childId: 'c1', at: 't' })).toBe(false)
    expect(isValidDerivedRow({ kind: 'mark', v: 1, childId: 'c1', at: 't', horizon: '2D', status: 'marked' })).toBe(false)
  })

  it('a structurally incomplete "marked" row is REJECTED — bad evidence must not become final evidence', () => {
    const crippled = { kind: 'mark', v: 1, childId: 'c1', horizon: '1D', at: 't', status: 'marked' }
    expect(isValidDerivedRow(crippled)).toBe(false)
    const noRet = { ...mark('c1', '1D', 'marked', 't') } as Record<string, unknown>
    delete noRet['ret']
    expect(isValidDerivedRow(noRet)).toBe(false)
    // unmarkable requires a reason
    expect(isValidDerivedRow({ kind: 'mark', v: 1, childId: 'c1', horizon: '1D', at: 't', status: 'unmarkable' })).toBe(false)
  })

  it('effectiveMarks: last row per (childId, horizon) wins — unmarkable superseded by marked', async () => {
    const path = join(dir, 'a.decisions.derived.jsonl')
    await appendRow(path, mark('c1', '1D', 'unmarkable', 't1'))
    await appendRow(path, mark('c1', '3D', 'marked', 't1'))
    await appendRow(path, mark('c1', '1D', 'marked', 't2'))
    const eff = effectiveMarks(await readDerivedRows(path))
    expect(eff.get(markKey('c1', '1D'))?.status).toBe('marked')
    expect(eff.get(markKey('c1', '3D'))?.status).toBe('marked')
    expect(eff.size).toBe(2)
  })

  it('decisions validator rejects brake kinds and vice versa (no cross-ledger bleed)', () => {
    expect(isValidDecisionsRow({ ...parent, kind: 'verdict', disposition: 'blocked', blockingGates: [] })).toBe(false)
    expect(isValidBrakesRow(parent)).toBe(false)
  })
})
