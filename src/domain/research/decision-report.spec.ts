import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectDecisionReport, type DecisionReportDeps } from './decision-report.js'

const NOW = new Date('2026-07-10T12:00:00Z')
const SINCE = '2026-07-02T21:37:49Z'

let dir: string       // ledger dir
let cfgPath: string
let gitDir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'd3-ledgers-'))
  gitDir = await mkdtemp(join(tmpdir(), 'd3-git-'))
  cfgPath = join(dir, 'research-decisions.json')
  await writeFile(cfgPath, JSON.stringify({ captureSince: SINCE, captureMockAccounts: false, marker: { graceHours: 6 } }))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(gitDir, { recursive: true, force: true })
})

// ==================== Fixtures ====================

const gate = { mode: 'observe', result: 'PASS', configSource: 'file', evaluatedAt: '2026-07-05T10:00:00Z', verdicts: [] }
function decParent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'push', v: 1, id: 'dec:acct:h1', accountId: 'acct', presetId: 'ccxt-custom',
    capturedAt: '2026-07-05T10:00:01Z', decidedAt: '2026-07-05T10:00:00Z', pendingHash: 'h1',
    commitHash: 'c1', message: 'm', gateSummary: gate, override: false, overrideReason: null,
    thesis: null, results: { submitted: 1, rejected: 0 }, childCount: 1, ...over,
  }
}
function decChild(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'intent', v: 1, id: 'dec:acct:h1#0', parentId: 'dec:acct:h1', accountId: 'acct',
    capturedAt: '2026-07-05T10:00:01Z', opIndex: 0, opAction: 'placeOrder',
    intent: { kind: 'risk-increasing' }, role: 'entry', side: 'LONG', markSide: 'LONG',
    markSideMeaning: 'entry', pricedBy: 'lmtPrice',
    context: {
      regime: { zone: 'BEAR', contextSource: 'live' },
      funding: { bucket: 'unavailable', contextSource: 'live' },
    }, ...over,
  }
}
function brkParent(disposition: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'verdict', v: 1, id: `brk:acct:h1:${disposition}`, accountId: 'acct', presetId: 'ccxt-custom',
    capturedAt: '2026-07-05T10:00:01Z', decidedAt: '2026-07-05T10:00:00Z', pendingHash: 'h1',
    message: 'm', disposition, gateSummary: gate, blockingGates: ['G1'], childCount: 0, ...over,
  }
}
async function writeLedger(name: string, rows: Record<string, unknown>[]): Promise<void> {
  await writeFile(join(dir, name), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
}
async function writeGit(
  accountId: string,
  commits: Array<{ hash: string; timestamp: string; results?: unknown[]; operations?: unknown[] }>,
): Promise<void> {
  await mkdir(join(gitDir, accountId), { recursive: true })
  await writeFile(join(gitDir, accountId, 'commit.json'), JSON.stringify({
    commits: commits.map(c => ({
      hash: c.hash, message: 'm', timestamp: c.timestamp,
      operations: c.operations ?? [], results: c.results ?? [],
    })),
    head: commits.length > 0 ? commits[commits.length - 1].hash : null,
  }))
}

function deps(over: Partial<DecisionReportDeps> = {}): DecisionReportDeps {
  return {
    decisionsDir: dir,
    configPath: cfgPath,
    loadAccounts: async () => [{ id: 'acct', presetId: 'ccxt-custom' }],
    gitPathsFor: (id) => [join(gitDir, id, 'commit.json')],
    readEvents: async () => [],
    now: () => NOW,
    ...over,
  }
}

const INCOMPLETE = 'evidence incomplete — no behavioral conclusions allowed'

// ==================== Baseline two-state ====================

describe('D3 baseline (captureSince two-state, pinned)', () => {
  it('captureSince ABSENT → always evidence incomplete, even with zero data', async () => {
    await writeFile(cfgPath, JSON.stringify({ captureMockAccounts: false }))
    const r = await collectDecisionReport(deps())
    expect(r.headline).toContain(INCOMPLETE)
    expect(r.headline).toContain('baseline is unset')
    expect(r.baseline.state).toBe('unset')
    expect(r.reconciliation.ok).toBe(false)
  })

  it('captureSince set + nothing at/after it → no data yet, reconciliation OK', async () => {
    await writeGit('acct', [{ hash: 'old1', timestamp: '2026-06-01T00:00:00Z' }]) // before since
    const r = await collectDecisionReport(deps())
    expect(r.headline).toContain('no data yet')
    expect(r.reconciliation.ok).toBe(true)
    expect(r.reconciliation.noData).toBe(true)
    expect(r.reconciliation.missingDecisionParents).toHaveLength(0) // pre-baseline commit not judged
  })
})

// ==================== The five checks ====================

describe('D3 reconciliation checks', () => {
  it('full green: commit ↔ parent, childCount exact, no events → evidence complete', async () => {
    await writeGit('acct', [{ hash: 'c1', timestamp: '2026-07-05T10:00:00Z' }])
    await writeLedger('acct.decisions.jsonl', [decParent(), decChild()])
    // now = before the first horizon is due, so mark coverage is all
    // not-yet-due (check 4 exercised separately below).
    const r = await collectDecisionReport(deps({ now: () => new Date('2026-07-06T02:00:00Z') }))
    expect(r.reconciliation.ok).toBe(true)
    expect(r.headline).toContain('reconciliation OK — evidence complete')
    expect(r.process.decisionParents).toBe(1)
  })

  it('check 1: an executed commit without a decision parent is a listed loss → incomplete', async () => {
    await writeGit('acct', [
      { hash: 'c1', timestamp: '2026-07-05T10:00:00Z' },
      { hash: 'cLOST', timestamp: '2026-07-06T10:00:00Z' },
    ])
    await writeLedger('acct.decisions.jsonl', [decParent(), decChild()])
    const r = await collectDecisionReport(deps())
    expect(r.headline).toBe(INCOMPLETE)
    expect(r.reconciliation.missingDecisionParents).toEqual([
      expect.objectContaining({ accountId: 'acct', commitHash: 'cLOST' }),
    ])
  })

  it('check 1: clean rejects and synthetic reconciles owe NO decision parent; broker-rejected pushes still do', async () => {
    await writeGit('acct', [
      // Clean reject: every result user-rejected → excluded.
      { hash: 'cRej', timestamp: '2026-07-05T10:00:00Z', results: [{ action: 'placeOrder', success: false, status: 'user-rejected' }] },
      // Synthetic reconcile: all ops reconcileBalance → excluded.
      { hash: 'cRec', timestamp: '2026-07-05T11:00:00Z', operations: [{ action: 'reconcileBalance' }], results: [{ action: 'reconcileBalance', success: true, status: 'filled' }] },
      // Broker-rejected push: the human pushed → parent REQUIRED.
      { hash: 'cBrk', timestamp: '2026-07-05T12:00:00Z', results: [{ action: 'placeOrder', success: false, status: 'rejected' }] },
    ])
    const r = await collectDecisionReport(deps())
    expect(r.reconciliation.missingDecisionParents).toEqual([
      expect.objectContaining({ commitHash: 'cBrk' }),
    ])
  })

  it('check 1: commit matching is ACCOUNT-SCOPED — a hash collision on another account cannot mask a loss', async () => {
    await writeGit('acct', [{ hash: 'cSAME', timestamp: '2026-07-05T10:00:00Z' }])
    await writeGit('acct2', [{ hash: 'cSAME', timestamp: '2026-07-05T10:00:00Z' }])
    // Only acct has the decision parent for cSAME.
    await writeLedger('acct.decisions.jsonl', [decParent({ commitHash: 'cSAME' }), decChild({ markSide: undefined })])
    const r = await collectDecisionReport(deps({
      loadAccounts: async () => [
        { id: 'acct', presetId: 'ccxt-custom' },
        { id: 'acct2', presetId: 'ccxt-custom' },
      ],
      now: () => new Date('2026-07-06T02:00:00Z'),
    }))
    expect(r.reconciliation.missingDecisionParents).toEqual([
      expect.objectContaining({ accountId: 'acct2', commitHash: 'cSAME' }),
    ])
  })

  it('check 1: mock accounts are outside the completeness contract when captureMockAccounts=false', async () => {
    await writeGit('mock-paper', [{ hash: 'cm', timestamp: '2026-07-05T10:00:00Z' }])
    const r = await collectDecisionReport(deps({
      loadAccounts: async () => [{ id: 'mock-paper', presetId: 'mock-simulator' }],
    }))
    expect(r.reconciliation.missingDecisionParents).toHaveLength(0)
  })

  it('check 1: legacy path fallback — history at the legacy candidate is found, not misread as empty', async () => {
    const legacy = join(gitDir, 'legacy-commit.json')
    await writeFile(legacy, JSON.stringify({ commits: [{ hash: 'cL', message: 'm', timestamp: '2026-07-05T10:00:00Z' }], head: 'cL' }))
    const r = await collectDecisionReport(deps({
      gitPathsFor: () => [join(gitDir, 'does-not-exist', 'commit.json'), legacy],
    }))
    expect(r.reconciliation.missingDecisionParents).toEqual([
      expect.objectContaining({ commitHash: 'cL' }),
    ])
  })

  it('check 1: an unreadable git state is a FAILURE, never emptiness', async () => {
    const r = await collectDecisionReport(deps({
      gitPathsFor: () => [gitDir], // a directory → EISDIR
    }))
    expect(r.headline).toBe(INCOMPLETE)
    expect(r.reconciliation.unreadable.length).toBeGreaterThan(0)
  })

  it('check 2: a push verdict with brake content and no brake parent is a loss; envelope ts is the filter', async () => {
    const evt = (ts: string, pendingHash: string, enforced: boolean) => ({
      ts: Date.parse(ts),
      payload: {
        accountId: 'acct', pendingHash, trigger: 'push', mode: 'observe',
        result: 'BLOCK', enforced, configSource: 'file',
        verdicts: [{ gate: 'G1', result: 'BLOCK', reason: 'over' }],
      },
    })
    // Before baseline → ignored; after → must match.
    const r = await collectDecisionReport(deps({
      readEvents: async () => [evt('2026-06-01T00:00:00Z', 'hOld', true), evt('2026-07-05T10:00:00Z', 'hNew', false)],
    }))
    expect(r.reconciliation.missingBrakeParents).toEqual([
      expect.objectContaining({ pendingHash: 'hNew', expected: 'overridden' }),
    ])

    // With the matching parent present → clean.
    await writeLedger('acct.brakes.jsonl', [brkParent('overridden', { id: 'brk:acct:hNew:overridden', pendingHash: 'hNew' })])
    const r2 = await collectDecisionReport(deps({
      readEvents: async () => [evt('2026-07-05T10:00:00Z', 'hNew', false)],
    }))
    expect(r2.reconciliation.missingBrakeParents).toHaveLength(0)
  })

  it('check 3: childCount mismatches are flagged on both ledgers', async () => {
    await writeLedger('acct.decisions.jsonl', [decParent({ childCount: 2 }), decChild()])
    await writeGit('acct', [{ hash: 'c1', timestamp: '2026-07-05T10:00:00Z' }])
    const r = await collectDecisionReport(deps())
    expect(r.reconciliation.childCountMismatches).toEqual([
      { ledger: 'decisions', parentId: 'dec:acct:h1', declared: 2, actual: 1 },
    ])
    expect(r.headline).toBe(INCOMPLETE)
  })

  it('check 4: OVERDUE marks fail; not-yet-due do not; marked/unmarkable counted', async () => {
    // decidedAt 07-05 → anchor 07-06; at NOW (07-10 12:00) horizons 1D/3D
    // are past due+grace, 7D/30D are not.
    await writeGit('acct', [{ hash: 'c1', timestamp: '2026-07-05T10:00:00Z' }])
    await writeLedger('acct.decisions.jsonl', [decParent(), decChild()])
    await writeLedger('acct.decisions.derived.jsonl', [
      { kind: 'mark', v: 1, childId: 'dec:acct:h1#0', horizon: '1D', at: 't', status: 'marked', side: 'LONG', anchorPolicy: 'next-daily-open', anchorDateUtc: '2026-07-06', entryPrice: '1', exitPrice: '1', ret: '0', mae: '0', mfe: '0', entryOpenDateUtc: '2026-07-06', exitCloseDateUtc: '2026-07-06' },
    ])
    const r = await collectDecisionReport(deps())
    expect(r.reconciliation.markCoverage.marked).toBe(1)   // 1D
    expect(r.reconciliation.markCoverage.overdue).toBe(1)  // 3D (due 07-09+6h < NOW)
    expect(r.reconciliation.markCoverage.notYetDue).toBe(2) // 7D, 30D
    expect(r.reconciliation.overdueMarks).toEqual([
      { ledger: 'decisions', childId: 'dec:acct:h1#0', horizon: '3D' },
    ])
    expect(r.headline).toBe(INCOMPLETE) // marker unhealthy = failure
  })

  it('check 5: context coverage is reported but never fails reconciliation', async () => {
    await writeGit('acct', [{ hash: 'c1', timestamp: '2026-07-05T10:00:00Z' }])
    await writeLedger('acct.decisions.jsonl', [
      decParent(),
      decChild({ context: { regime: { zone: 'UNKNOWN', contextSource: 'live' }, funding: { bucket: 'unavailable', contextSource: 'live' } }, markSide: undefined }),
    ])
    await writeLedger('acct.decisions.derived.jsonl', [
      { kind: 'fundingContext', v: 1, childId: 'dec:acct:h1#0', at: 't', contextSource: 'derived', bucket: 'positive' },
    ])
    const r = await collectDecisionReport(deps())
    expect(r.reconciliation.contextCoverage.funding).toEqual({ pending: 0, derived: 1 })
    expect(r.reconciliation.contextCoverage.regime).toEqual({ pending: 1, derived: 0 })
    expect(r.reconciliation.ok).toBe(true) // low regime coverage informs, never fails
  })
})

// ==================== Analysis (second, tier-gated) ====================

describe('D3 analysis sections', () => {
  it('cells count entry-side children with derived context superseding live; tiers refuse below 20', async () => {
    await writeGit('acct', [{ hash: 'c1', timestamp: '2026-07-05T10:00:00Z' }])
    await writeLedger('acct.decisions.jsonl', [
      decParent({ childCount: 2 }),
      decChild({ markSide: undefined }),
      decChild({ id: 'dec:acct:h1#1', opIndex: 1, context: { regime: { zone: 'UNKNOWN', contextSource: 'live' }, funding: { bucket: 'unavailable', contextSource: 'live' } }, markSide: undefined }),
    ])
    await writeLedger('acct.decisions.derived.jsonl', [
      { kind: 'regimeContext', v: 1, childId: 'dec:acct:h1#1', at: 't', contextSource: 'derived', zone: 'GRAY' },
    ])
    const r = await collectDecisionReport(deps())
    expect(r.cells.sideRegime['LONG×BEAR']?.n).toBe(1)
    expect(r.cells.sideRegime['LONG×GRAY']?.n).toBe(1) // derived superseded UNKNOWN live
    expect(r.cells.sideRegime['LONG×BEAR']?.status).toContain('insufficient — accumulating')
  })

  it('process metrics: overrides with null reason count as process failures', async () => {
    await writeGit('acct', [{ hash: 'c1', timestamp: '2026-07-05T10:00:00Z' }])
    await writeLedger('acct.decisions.jsonl', [decParent({ override: true }), decChild()])
    const r = await collectDecisionReport(deps())
    expect(r.process.overrides).toBe(1)
    expect(r.process.overrideReasonMissing).toBe(1)
  })
})
