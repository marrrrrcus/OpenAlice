import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createResearchShadowConfigLoader,
  isStrategyEnabled,
  seedResearchShadowConfig,
} from './config.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'shadow-config-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('research-shadow config', () => {
  it('missing file → code defaults (pinned cost family, cap 14, grace 6)', async () => {
    const load = createResearchShadowConfigLoader(join(dir, 'nope.json'))
    const res = await load()
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.source).toBe('defaults')
    expect(res.config.enabled).toBe(true)
    expect(res.config.costModel).toEqual({ feeBpsPerLeg: 7, slippageBpsPerLeg: 3 })
    expect(res.config.maxBackfillDays).toBe(14)
    expect(res.config.staleGraceHours).toBe(6)
  })

  it('file values override defaults', async () => {
    const path = join(dir, 'c.json')
    await writeFile(path, JSON.stringify({
      costModel: { feeBpsPerLeg: 5, slippageBpsPerLeg: 5 },
      maxBackfillDays: 7,
    }))
    const res = await createResearchShadowConfigLoader(path)()
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.source).toBe('file')
    expect(res.config.costModel.feeBpsPerLeg).toBe(5)
    expect(res.config.maxBackfillDays).toBe(7)
    expect(res.config.staleGraceHours).toBe(6) // untouched default
  })

  it('unparseable file → invalid, never throws (the shadow idles loudly)', async () => {
    const path = join(dir, 'c.json')
    await writeFile(path, '{ definitely not json')
    const res = await createResearchShadowConfigLoader(path)()
    expect(res.status).toBe('invalid')
    if (res.status !== 'invalid') return
    expect(res.error).toBeTruthy()
  })

  it('schema violation → invalid (negative fee)', async () => {
    const path = join(dir, 'c.json')
    await writeFile(path, JSON.stringify({ costModel: { feeBpsPerLeg: -1 } }))
    const res = await createResearchShadowConfigLoader(path)()
    expect(res.status).toBe('invalid')
  })

  it('seed creates the default file once and never overwrites', async () => {
    const path = join(dir, 'c.json')
    await seedResearchShadowConfig(path)
    const first = await readFile(path, 'utf-8')
    expect(JSON.parse(first).strategies['buy-and-hold-v0']).toEqual({ enabled: true })
    await writeFile(path, JSON.stringify({ enabled: false }))
    await seedResearchShadowConfig(path) // must not touch the edited file
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ enabled: false })
  })

  it('isStrategyEnabled: absent = enabled (the registry is the gate), explicit off wins, global off wins', async () => {
    const res = await createResearchShadowConfigLoader(join(dir, 'nope.json'))()
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(isStrategyEnabled(res.config, 'anything')).toBe(true)
    expect(isStrategyEnabled({ ...res.config, strategies: { x: { enabled: false } } }, 'x')).toBe(false)
    expect(isStrategyEnabled({ ...res.config, enabled: false }, 'anything')).toBe(false)
  })
})
