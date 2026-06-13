import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  classifyNewsItem,
  newsItemKey,
  buildNewsAlert,
  createNewsAlert,
  type NewsKeywordRules,
  type NewsAlertItem,
} from './news-alert.js'
import type { NewsAlertConfig } from '../../core/config.js'

const RULES: NewsKeywordRules = {
  highPriority: ['hack', 'exploit', 'liquidation', 'SEC', 'ETF approval', 'ETF rejection', 'Binance halt', 'OKX outage'],
  riskWords: ['ETF', 'SEC', 'hack', 'lawsuit', 'ban', 'halt', 'delist'],
  coinWords: ['BTC', 'bitcoin', 'ETH', 'ethereum', 'SOL'],
}

describe('classifyNewsItem — tiered keyword matching', () => {
  it('fires high-priority on a standalone phrase', () => {
    const c = classifyNewsItem('Major DeFi protocol suffers $50M hack', '', RULES)
    expect(c).toMatchObject({ matched: true, tier: 'high', reason: 'hack' })
  })

  it('matches multi-word high-priority phrases', () => {
    const c = classifyNewsItem('SEC signals ETF approval is imminent', 'details...', RULES)
    // 'SEC' is also high-priority and listed first → reason 'SEC'
    expect(c.matched).toBe(true)
    expect(c.tier).toBe('high')
  })

  it('does NOT match SEC inside an unrelated word (boundary)', () => {
    const c = classifyNewsItem('Project enters second funding section', 'security review', RULES)
    expect(c.matched).toBe(false)
  })

  it('does NOT match ETH inside "method"/"together"', () => {
    const c = classifyNewsItem('A new method brings teams together', '', RULES)
    expect(c.matched).toBe(false)
  })

  it('fires coin-risk only when a coin co-occurs with a risk word', () => {
    const c = classifyNewsItem('BTC ETF sees record inflows', '', RULES)
    expect(c).toMatchObject({ matched: true, tier: 'coin-risk' })
    expect(c.reason).toContain('BTC')
  })

  it('stays silent on a bare coin headline with no risk word', () => {
    const c = classifyNewsItem('BTC price climbs 2% on the day', 'bitcoin rallies', RULES)
    expect(c.matched).toBe(false)
  })

  it('matches across title + content', () => {
    const c = classifyNewsItem('Ethereum update', 'The SEC opened a lawsuit today', RULES)
    expect(c.matched).toBe(true) // 'SEC' high-priority
  })
})

describe('newsItemKey', () => {
  function item(meta: Record<string, string | null>, title = 'T'): NewsAlertItem {
    return { time: new Date(), title, content: '', metadata: meta }
  }
  it('prefers link, then guid, then title', () => {
    expect(newsItemKey(item({ link: 'http://a', guid: 'g' }))).toBe('http://a')
    expect(newsItemKey(item({ link: null, guid: 'g' }))).toBe('g')
    expect(newsItemKey(item({}, 'My Title'))).toBe('My Title')
  })
})

describe('buildNewsAlert', () => {
  it('renders source, title, reason, and link per item', () => {
    const msg = buildNewsAlert([
      { item: { time: new Date(), title: 'Exchange X halts withdrawals', content: '', metadata: { source: 'coindesk', link: 'http://x' } },
        classification: { matched: true, tier: 'high', reason: 'halt' } },
    ])
    expect(msg).toContain('📰 新聞警示')
    expect(msg).toContain('[coindesk]')
    expect(msg).toContain('Exchange X halts withdrawals')
    expect(msg).toContain('命中：halt')
    expect(msg).toContain('http://x')
  })
})

describe('createNewsAlert — module tick (dedup + push)', () => {
  function baseConfig(over: Partial<NewsAlertConfig> = {}): NewsAlertConfig {
    return {
      enabled: true, every: '10m', lookback: '30m',
      keywords: RULES,
      maxPerAlert: 5, maxDedupKeys: 1000,
      statePath: join(tmpdir(), `news-alert-${randomUUID().slice(0, 8)}.json`),
      ...over,
    }
  }

  function item(title: string, meta: Record<string, string | null> = {}): NewsAlertItem {
    return { time: new Date(), title, content: '', metadata: { source: 'test', ...meta } }
  }

  it('pushes a high-priority alert for matching items, skips non-matches', async () => {
    const pushed: Array<{ text: string; priority?: string }> = []
    const newsSource = { getNewsV2: async () => [
      item('BTC ETF approved by regulator', { link: 'http://1' }),  // coin-risk
      item('Daily market wrap: prices steady', { link: 'http://2' }), // no match
      item('Bridge protocol hack drains funds', { link: 'http://3' }), // high
    ] }
    const connectorCenter = { notify: async (text: string, opts?: { priority?: string }) => { pushed.push({ text, priority: opts?.priority }); return {} as any } } as any

    const na = createNewsAlert({ config: baseConfig({ enabled: false }), newsSource, connectorCenter })
    await na.start(); await na.runNow(); na.stop()

    expect(pushed).toHaveLength(1)
    expect(pushed[0].priority).toBe('high')
    expect(pushed[0].text).toContain('BTC ETF approved')
    expect(pushed[0].text).toContain('hack')
    expect(pushed[0].text).not.toContain('Daily market wrap')
  })

  it('does not re-alert the same item on a second tick (dedup persists)', async () => {
    const pushed: string[] = []
    const newsSource = { getNewsV2: async () => [item('Major exploit hits lending pool', { link: 'http://dup' })] }
    const connectorCenter = { notify: async (text: string) => { pushed.push(text); return {} as any } } as any

    const cfg = baseConfig({ enabled: false })
    const na = createNewsAlert({ config: cfg, newsSource, connectorCenter })
    await na.start()
    await na.runNow() // first: alert
    await na.runNow() // second: same item still in window → must NOT re-alert
    na.stop()

    expect(pushed).toHaveLength(1)
  })

  it('over-cap overflow is NOT silently lost — capped sent now, rest next tick', async () => {
    // 6 matches, cap 2. First tick sends 2 + a "+N" note and dedups ONLY
    // those 2. The other 4 stay un-marked and are delivered across the
    // following ticks (still inside the lookback window) — nothing dropped.
    const pushedTexts: string[] = []
    const six = Array.from({ length: 6 }, (_, i) => item(`Protocol ${i} hit by hack`, { link: `http://h${i}` }))
    const newsSource = { getNewsV2: async () => six }
    const connectorCenter = { notify: async (text: string) => { pushedTexts.push(text); return {} as any } } as any

    const na = createNewsAlert({ config: baseConfig({ enabled: false, maxPerAlert: 2 }), newsSource, connectorCenter })
    await na.start()
    await na.runNow() // sends 2, notes "+4"
    await na.runNow() // sends next 2
    await na.runNow() // sends last 2
    na.stop()

    expect(pushedTexts).toHaveLength(3)
    expect(pushedTexts[0]).toContain('另有 4 條')
    // Every one of the 6 distinct headlines was delivered exactly once.
    const allText = pushedTexts.join('\n')
    for (let i = 0; i < 6; i++) expect(allText).toContain(`Protocol ${i} hit by hack`)
  })

  it('bounds the query to a real time window (passes startTime, not a "30m" string)', async () => {
    // Regression for the lookback bug: the store's parseLookback only
    // accepts h/d, so '30m' silently returned the whole archive. news-alert
    // must compute startTime itself. Here the fake honors startTime and
    // only returns an in-window item; an old item must be excluded.
    let receivedStartTime: Date | undefined
    const nowMs = Date.UTC(2026, 5, 13, 13, 0, 0)
    const inWindow = { time: new Date(nowMs - 10 * 60 * 1000), title: 'Fresh hack just now', content: '', metadata: { source: 't', link: 'http://fresh' } }
    const old = { time: new Date(nowMs - 7 * 24 * 60 * 60 * 1000), title: 'Week-old hack', content: '', metadata: { source: 't', link: 'http://old' } }
    const newsSource = {
      getNewsV2: async (opts: { startTime?: Date; endTime: Date }) => {
        receivedStartTime = opts.startTime
        return [inWindow, old].filter((i) => (!opts.startTime || i.time >= opts.startTime) && i.time <= opts.endTime)
      },
    }
    const pushed: string[] = []
    const connectorCenter = { notify: async (text: string) => { pushed.push(text); return {} as any } } as any

    const na = createNewsAlert({ config: baseConfig({ enabled: false, lookback: '30m' }), newsSource, connectorCenter, now: () => nowMs })
    await na.start(); await na.runNow(); na.stop()

    expect(receivedStartTime).toBeInstanceOf(Date) // window IS bounded
    expect(receivedStartTime!.getTime()).toBe(nowMs - 30 * 60 * 1000)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toContain('Fresh hack just now')
    expect(pushed[0]).not.toContain('Week-old hack') // stale item excluded
  })

  it('does not push when nothing matches', async () => {
    const pushed: string[] = []
    const newsSource = { getNewsV2: async () => [item('Quiet day in crypto, prices flat')] }
    const connectorCenter = { notify: async (text: string) => { pushed.push(text); return {} as any } } as any

    const na = createNewsAlert({ config: baseConfig({ enabled: false }), newsSource, connectorCenter })
    await na.start(); await na.runNow(); na.stop()
    expect(pushed).toEqual([])
  })
})
