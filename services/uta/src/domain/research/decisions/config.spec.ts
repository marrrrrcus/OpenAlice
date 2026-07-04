import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createResearchDecisionsConfigLoader, seedResearchDecisionsConfig } from './config.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'decisions-config-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('research-decisions config', () => {
  it('missing file → code defaults (capture on, mock off, marker+funding on)', async () => {
    const res = await createResearchDecisionsConfigLoader(join(dir, 'nope.json'))()
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.config).toEqual({
      enabled: true,
      captureMockAccounts: false,
      marker: { enabled: true, graceHours: 6, fetchPageDays: 1000 },
      funding: { enabled: true },
    })
  })

  it('file values override; unparseable → invalid (never throws)', async () => {
    const path = join(dir, 'c.json')
    await writeFile(path, JSON.stringify({ captureMockAccounts: true, marker: { fetchPageDays: 500 } }))
    const res = await createResearchDecisionsConfigLoader(path)()
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(res.config.captureMockAccounts).toBe(true)
    expect(res.config.marker.fetchPageDays).toBe(500)
    expect(res.config.marker.graceHours).toBe(6)

    await writeFile(path, '{ not json')
    const bad = await createResearchDecisionsConfigLoader(path)()
    expect(bad.status).toBe('invalid')
  })

  it('seed creates once and never overwrites', async () => {
    const path = join(dir, 'c.json')
    await seedResearchDecisionsConfig(path)
    expect(JSON.parse(await readFile(path, 'utf-8')).enabled).toBe(true)
    await writeFile(path, JSON.stringify({ enabled: false }))
    await seedResearchDecisionsConfig(path)
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ enabled: false })
  })

  it('captureSince: seeded on new installs; parsed when present; absent stays absent (D3 baseline)', async () => {
    const path = join(dir, 'c.json')
    await seedResearchDecisionsConfig(path)
    const seeded = JSON.parse(await readFile(path, 'utf-8'))
    expect(typeof seeded.captureSince).toBe('string')
    expect(Number.isFinite(Date.parse(seeded.captureSince))).toBe(true)

    await writeFile(path, JSON.stringify({ captureSince: '2026-07-02T21:37:49Z' }))
    const withIt = await createResearchDecisionsConfigLoader(path)()
    if (withIt.status !== 'ok') throw new Error('expected ok')
    expect(withIt.config.captureSince).toBe('2026-07-02T21:37:49Z')

    await writeFile(path, JSON.stringify({}))
    const without = await createResearchDecisionsConfigLoader(path)()
    if (without.status !== 'ok') throw new Error('expected ok')
    expect(without.config.captureSince).toBeUndefined()
  })
})
