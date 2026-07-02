import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, appendFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { appendLedgerRow, effectiveRows, readLedgerRows } from './ledger.js'
import type { LedgerDayRow, LedgerUnknownRow } from './types.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shadow-ledger-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const day = (dateUtc: string, equity: string): LedgerDayRow => ({
  kind: 'day', dateUtc, at: '2026-06-15T00:05:00.000Z',
  backfilled: false, close: '100', stance: 'long', equity,
})
const unknown = (dateUtc: string, equity: string): LedgerUnknownRow => ({
  kind: 'unknown', dateUtc, at: '2026-06-15T00:05:00.000Z',
  reason: 'test', equity,
})

describe('shadow ledger (the authority)', () => {
  it('append/read roundtrip preserves rows in order', async () => {
    const path = join(dir, 't.jsonl')
    await appendLedgerRow(path, day('2026-06-14', '1'))
    await appendLedgerRow(path, unknown('2026-06-15', '1'))
    const rows = await readLedgerRows(path)
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('day')
    expect(rows[1].kind).toBe('unknown')
  })

  it('missing file reads as an empty track (cold start)', async () => {
    expect(await readLedgerRows(join(dir, 'nope.jsonl'))).toEqual([])
  })

  it('skips malformed lines and rows missing required fields', async () => {
    const path = join(dir, 't.jsonl')
    await appendLedgerRow(path, day('2026-06-14', '1'))
    await appendFile(path, 'not json at all\n')
    await appendFile(path, JSON.stringify({ kind: 'day', dateUtc: '2026-06-15' }) + '\n') // no equity
    await appendFile(path, JSON.stringify({ kind: 'bogus', dateUtc: '2026-06-16', equity: '1' }) + '\n')
    const rows = await readLedgerRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0].dateUtc).toBe('2026-06-14')
  })

  it('a non-ENOENT read failure THROWS — an unreadable ledger is never a cold start', async () => {
    // Reading a directory fails with EISDIR, not ENOENT: must propagate,
    // never return [] (that would let the runner mint a fresh anchor row
    // on top of existing evidence).
    await expect(readLedgerRows(dir)).rejects.toThrow()
  })

  it('rejects structurally incomplete day rows (day rows are final — a corrupt link must read as a hole)', async () => {
    const path = join(dir, 't.jsonl')
    const base = day('2026-06-14', '1')
    const noClose = { ...base, dateUtc: '2026-06-15' } as Record<string, unknown>; delete noClose['close']
    const noStance = { ...base, dateUtc: '2026-06-16' } as Record<string, unknown>; delete noStance['stance']
    const badStance = { ...base, dateUtc: '2026-06-17', stance: 'sideways' }
    const noBackfilled = { ...base, dateUtc: '2026-06-18' } as Record<string, unknown>; delete noBackfilled['backfilled']
    const badMark = { ...base, dateUtc: '2026-06-19', mark: { stanceHeld: 'long' } } // incomplete mark
    await appendLedgerRow(path, base)
    for (const bad of [noClose, noStance, badStance, noBackfilled, badMark]) {
      await appendFile(path, JSON.stringify(bad) + '\n')
    }
    const rows = await readLedgerRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0].dateUtc).toBe('2026-06-14')
  })

  it('accepts a complete day row with a complete mark', async () => {
    const path = join(dir, 't.jsonl')
    await appendLedgerRow(path, {
      ...day('2026-06-15', '1.019'),
      mark: {
        stanceHeld: 'long', prevClose: '100', grossRet: '0.02',
        legs: 1, costPerLegBps: '10', netRet: '0.019',
      },
    })
    expect(await readLedgerRows(path)).toHaveLength(1)
  })

  it('rejects unknown rows without a reason', async () => {
    const path = join(dir, 't.jsonl')
    const bad = unknown('2026-06-14', '1') as unknown as Record<string, unknown>
    delete bad['reason']
    await appendFile(path, JSON.stringify(bad) + '\n')
    await appendLedgerRow(path, unknown('2026-06-15', '1'))
    const rows = await readLedgerRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0].dateUtc).toBe('2026-06-15')
  })

  it('tolerates a torn trailing line (crash mid-append)', async () => {
    const path = join(dir, 't.jsonl')
    await appendLedgerRow(path, day('2026-06-14', '1'))
    await appendFile(path, '{"kind":"day","dateUtc":"2026-06-15","equi') // torn
    const rows = await readLedgerRows(path)
    expect(rows).toHaveLength(1)
  })

  it('effectiveRows: last row per dateUtc wins (unknown superseded by day)', async () => {
    const rows = [
      day('2026-06-13', '1'),
      unknown('2026-06-14', '1'),
      day('2026-06-14', '1.019'), // supersedes the unknown
    ]
    const eff = effectiveRows(rows)
    expect(eff.get('2026-06-14')?.kind).toBe('day')
    expect(eff.get('2026-06-14')?.equity).toBe('1.019')
    expect(eff.size).toBe(2)
  })

  it('creates parent directories on first append', async () => {
    const path = join(dir, 'nested', 'deep', 't.jsonl')
    await appendLedgerRow(path, day('2026-06-14', '1'))
    expect(await readLedgerRows(path)).toHaveLength(1)
  })
})
