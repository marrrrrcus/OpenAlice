/**
 * live-readiness-alert — self-monitor for the alert-only stack.
 *
 * It periodically runs the same live_readiness_report used by the CLI/tool
 * and pushes only when readiness needs attention or recovers. It never
 * places orders, creates proposals, or emits strategy evidence.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createPump, type Pump } from '@/core/pump.js'
import type { ConnectorCenter } from '@/core/connector-center.js'
import type { LiveReadinessAlertConfig } from '@/core/config.js'
import type { LiveReadinessReport } from '@/domain/research/live-readiness-report.js'

export interface LiveReadinessAlertState {
  schemaVersion: 1
  lastStatus?: LiveReadinessReport['status']
  lastAttentionFingerprint?: string
}

export interface LiveReadinessAlertOpts {
  config: LiveReadinessAlertConfig
  connectorCenter: Pick<ConnectorCenter, 'notify'>
  buildReport: () => Promise<LiveReadinessReport>
}

export interface LiveReadinessAlert {
  start(): Promise<void>
  stop(): void
  runNow(): Promise<void>
  isEnabled(): boolean
}

function defaultState(): LiveReadinessAlertState {
  return { schemaVersion: 1 }
}

function attentionFingerprint(report: LiveReadinessReport): string {
  return createHash('sha256')
    .update(JSON.stringify(report.attentionItems))
    .digest('hex')
}

async function loadState(path: string): Promise<LiveReadinessAlertState> {
  try {
    const raw = JSON.parse(await readFile(resolve(path), 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('state must be a JSON object')
    const state = raw as Partial<LiveReadinessAlertState>
    if (state.schemaVersion !== undefined && state.schemaVersion !== 1) throw new Error(`unsupported schemaVersion: ${String(state.schemaVersion)}`)
    if (state.lastStatus !== undefined && state.lastStatus !== 'ok' && state.lastStatus !== 'attention') {
      throw new Error('lastStatus must be ok or attention')
    }
    if (state.lastAttentionFingerprint !== undefined && typeof state.lastAttentionFingerprint !== 'string') {
      throw new Error('lastAttentionFingerprint must be a string')
    }
    return {
      schemaVersion: 1,
      lastStatus: state.lastStatus,
      lastAttentionFingerprint: state.lastAttentionFingerprint,
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultState()
    }
    throw new Error(`live-readiness-alert state unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function loadStateOrUndefined(path: string): Promise<LiveReadinessAlertState | undefined> {
  try {
    return await loadState(path)
  } catch (err) {
    console.warn(err instanceof Error ? err.message : String(err))
    return undefined
  }
}

async function saveState(path: string, state: LiveReadinessAlertState): Promise<void> {
  const abs = resolve(path)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  await rename(tmp, abs)
}

export function buildLiveReadinessAttentionMessage(report: LiveReadinessReport): string {
  return [
    'Live readiness — attention needed',
    `generatedAt: ${report.generatedAt}`,
    'scope: alert-only monitoring',
    'items:',
    ...report.attentionItems.map((item) => `- ${item}`),
    'Reminder: this is an operational alert, not a trade signal or permission to place orders.',
  ].join('\n')
}

export function buildLiveReadinessRecoveryMessage(report: LiveReadinessReport): string {
  return [
    'Live readiness — recovered',
    `generatedAt: ${report.generatedAt}`,
    'scope: alert-only monitoring',
    'All readiness checks are currently OK.',
    'Reminder: this is an operational alert, not a trade signal or permission to place orders.',
  ].join('\n')
}

export function createLiveReadinessAlert(opts: LiveReadinessAlertOpts): LiveReadinessAlert {
  const { config, connectorCenter, buildReport } = opts
  let started = false
  let pump: Pump | null = null

  async function onTick(): Promise<void> {
    const state = await loadStateOrUndefined(config.statePath)
    if (!state) return

    let report: LiveReadinessReport
    try {
      report = await buildReport()
    } catch (err) {
      console.warn(`live-readiness-alert: report failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    if (report.status === 'attention') {
      const fp = attentionFingerprint(report)
      if (state.lastStatus !== 'attention' || state.lastAttentionFingerprint !== fp) {
        await connectorCenter.notify(buildLiveReadinessAttentionMessage(report), {
          source: 'live-readiness-alert',
          priority: 'high',
        })
      }
      state.lastStatus = 'attention'
      state.lastAttentionFingerprint = fp
      await saveState(config.statePath, state)
      return
    }

    if (state.lastStatus === 'attention') {
      await connectorCenter.notify(buildLiveReadinessRecoveryMessage(report), {
        source: 'live-readiness-alert',
        priority: 'normal',
      })
    }
    state.lastStatus = 'ok'
    delete state.lastAttentionFingerprint
    await saveState(config.statePath, state)
  }

  return {
    async start() {
      if (started) return
      started = true
      pump = createPump({
        name: 'live-readiness-alert',
        every: config.every,
        enabled: config.enabled,
        onTick,
      })
      pump.start()
    },
    stop() {
      if (!started) return
      pump?.stop()
      pump = null
      started = false
    },
    async runNow() {
      if (pump) await pump.runNow()
    },
    isEnabled() {
      return pump?.isEnabled() ?? config.enabled
    },
  }
}
