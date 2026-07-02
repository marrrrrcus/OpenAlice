import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, rm, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRiskGatesConfigLoader, seedRiskGatesConfig } from './config.js'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'risk-gates-'))
  file = join(dir, 'risk-gates.json')
  return async () => { await rm(dir, { recursive: true, force: true }) }
})

describe('risk-gates config loader', () => {
  it('missing file → code defaults, observe mode', async () => {
    const load = createRiskGatesConfigLoader(file)
    const res = await load()
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.source).toBe('defaults')
    const cfg = res.forAccount('any-account', 'ccxt-custom')
    expect(cfg.mode).toBe('observe')
    expect(cfg.maxOrderNotionalAbsUsd).toBe(1000)
    expect(cfg.maxTotalExposurePct).toBe(100)
  })

  it('mock-simulator preset defaults to ENFORCE even with no file', async () => {
    const load = createRiskGatesConfigLoader(file)
    const res = await load()
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(res.forAccount('sim-acct', 'mock-simulator').mode).toBe('enforce')
  })

  it('explicit per-account mode beats the mock-enforce default', async () => {
    await writeFile(file, JSON.stringify({ accounts: { 'sim-acct': { mode: 'off' } } }))
    const load = createRiskGatesConfigLoader(file)
    const res = await load()
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(res.forAccount('sim-acct', 'mock-simulator').mode).toBe('off')
  })

  it('per-account threshold overrides merge over file defaults', async () => {
    await writeFile(file, JSON.stringify({
      defaults: { maxOrderNotionalAbsUsd: 500, mode: 'observe' },
      accounts: { main: { maxOrderNotionalAbsUsd: 2000, mode: 'enforce' } },
    }))
    const load = createRiskGatesConfigLoader(file)
    const res = await load()
    if (res.status !== 'ok') throw new Error('expected ok')
    const main = res.forAccount('main', 'ccxt-custom')
    expect(main.mode).toBe('enforce')
    expect(main.maxOrderNotionalAbsUsd).toBe(2000)
    const other = res.forAccount('other', 'ccxt-custom')
    expect(other.mode).toBe('observe')
    expect(other.maxOrderNotionalAbsUsd).toBe(500)
    // untouched keys fall back to code defaults
    expect(other.maxPushesPerHour).toBe(10)
  })

  it('unparseable JSON → status invalid (never throws)', async () => {
    await writeFile(file, '{ not json !!!')
    const load = createRiskGatesConfigLoader(file)
    const res = await load()
    expect(res.status).toBe('invalid')
  })

  it('schema-violating JSON → status invalid', async () => {
    await writeFile(file, JSON.stringify({ defaults: { maxOrderNotionalAbsUsd: -5 } }))
    const load = createRiskGatesConfigLoader(file)
    const res = await load()
    expect(res.status).toBe('invalid')
  })

  it('mtime cache: re-reads after the file changes', async () => {
    await writeFile(file, JSON.stringify({ defaults: { maxOrderNotionalAbsUsd: 111 } }))
    const load = createRiskGatesConfigLoader(file)
    const first = await load()
    if (first.status !== 'ok') throw new Error('expected ok')
    expect(first.forAccount('a', 'x').maxOrderNotionalAbsUsd).toBe(111)
    // ensure a different mtime even on coarse filesystems
    await new Promise(r => setTimeout(r, 20))
    await writeFile(file, JSON.stringify({ defaults: { maxOrderNotionalAbsUsd: 222 } }))
    const second = await load()
    if (second.status !== 'ok') throw new Error('expected ok')
    expect(second.forAccount('a', 'x').maxOrderNotionalAbsUsd).toBe(222)
  })

  it('seedRiskGatesConfig writes defaults once and never overwrites', async () => {
    await seedRiskGatesConfig(file)
    const seeded = JSON.parse(await readFile(file, 'utf-8'))
    expect(seeded.defaults.mode).toBe('observe')
    const before = (await stat(file)).mtimeMs
    await writeFile(file, JSON.stringify({ defaults: { mode: 'enforce' } }))
    await seedRiskGatesConfig(file) // must not touch the user's edit
    const after = JSON.parse(await readFile(file, 'utf-8'))
    expect(after.defaults.mode).toBe('enforce')
    void before
  })
})
