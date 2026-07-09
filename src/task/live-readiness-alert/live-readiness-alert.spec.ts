import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  createLiveReadinessAlert,
  buildLiveReadinessAttentionMessage,
} from './live-readiness-alert.js'
import type { LiveReadinessAlertConfig } from '@/core/config.js'
import type { LiveReadinessReport } from '@/domain/research/live-readiness-report.js'
import type { NotificationEntry } from '@/core/notifications-store.js'

async function tempState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'live-readiness-alert-'))
  return join(dir, 'state.json')
}

async function cleanup(path: string): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true }).catch(() => {})
}

function config(statePath: string): LiveReadinessAlertConfig {
  return { enabled: true, every: '15m', statePath }
}

function report(status: 'ok' | 'attention', items = ['Telegram connector enabled: telegram.enabled is false']): LiveReadinessReport {
  return {
    status,
    generatedAt: '2026-07-09T00:00:00.000Z',
    scope: 'alert_only_monitoring',
    checks: [],
    attentionItems: status === 'attention' ? items : [],
    discipline: 'Alert readiness only. This is not a trade signal, proposal, strategy-shadow result, or permission to place orders.',
  }
}

function entry(text: string): NotificationEntry {
  return { id: `n-${text.length}`, ts: 0, text, source: 'live-readiness-alert' }
}

describe('live-readiness-alert', () => {
  it('notifies once for the same attention fingerprint', async () => {
    const statePath = await tempState()
    const pushed: string[] = []
    const alert = createLiveReadinessAlert({
      config: config(statePath),
      connectorCenter: { notify: async (text) => { pushed.push(text); return entry(text) } },
      buildReport: async () => report('attention'),
    })

    try {
      await alert.start()
      await alert.runNow()
      await alert.runNow()

      expect(pushed).toHaveLength(1)
      expect(pushed[0]).toContain('attention needed')
      expect(await readFile(statePath, 'utf-8')).toContain('lastAttentionFingerprint')
    } finally {
      alert.stop()
      await cleanup(statePath)
    }
  })

  it('re-notifies when the attention set changes, then sends one recovery message', async () => {
    const statePath = await tempState()
    const pushed: string[] = []
    const reports = [
      report('attention', ['a']),
      report('attention', ['a']),
      report('attention', ['b']),
      report('ok'),
      report('ok'),
    ]
    const alert = createLiveReadinessAlert({
      config: config(statePath),
      connectorCenter: { notify: async (text) => { pushed.push(text); return entry(text) } },
      buildReport: async () => reports.shift() ?? report('ok'),
    })

    try {
      await alert.start()
      await alert.runNow()
      await alert.runNow()
      await alert.runNow()
      await alert.runNow()
      await alert.runNow()

      expect(pushed).toHaveLength(3)
      expect(pushed[0]).toContain('- a')
      expect(pushed[1]).toContain('- b')
      expect(pushed[2]).toContain('recovered')
    } finally {
      alert.stop()
      await cleanup(statePath)
    }
  })

  it('fails closed on corrupt state without notifying or overwriting', async () => {
    const statePath = await tempState()
    await writeFile(statePath, '{not json', 'utf-8')
    const pushed: string[] = []
    const alert = createLiveReadinessAlert({
      config: config(statePath),
      connectorCenter: { notify: async (text) => { pushed.push(text); return entry(text) } },
      buildReport: async () => report('attention'),
    })

    try {
      await alert.start()
      await alert.runNow()

      expect(pushed).toHaveLength(0)
      expect(await readFile(statePath, 'utf-8')).toBe('{not json')
    } finally {
      alert.stop()
      await cleanup(statePath)
    }
  })

  it('renders operational wording without trade instructions', () => {
    const message = buildLiveReadinessAttentionMessage(report('attention', ['state stale']))
    const lower = message.toLowerCase()
    expect(message).toContain('operational alert')
    expect(lower).not.toContain('buy')
    expect(lower).not.toContain('sell')
    expect(lower).not.toContain('validated')
  })
})
