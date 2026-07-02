/**
 * Risk-gate persistent state — currently only G3's start-of-day equity
 * anchor. Lives at data/trading/{accountId}/risk-gate-state.json (same
 * directory convention as commit.json).
 *
 * The anchor is captured lazily at the first (non-preview) evaluation of
 * each UTC day — an honest approximation, stated in G3's verdict reason.
 * Corrupt/missing state degrades to "no anchor yet" (recapture), never to a
 * crash.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { dataPath } from '@/core/paths.js'

export interface RiskGateDayAnchor {
  dateUtc: string          // YYYY-MM-DD
  startOfDayEquity: string // decimal string, account base currency
  capturedAt: string       // ISO
}

interface RiskGateStateFile {
  schemaVersion: 1
  day?: RiskGateDayAnchor
}

export interface RiskGateStateStore {
  /** Anchor for the given UTC day, or undefined if none captured yet. */
  getDayAnchor(dateUtc: string): Promise<RiskGateDayAnchor | undefined>
  /** Capture the anchor for a new UTC day (overwrites older days). */
  captureDayAnchor(anchor: RiskGateDayAnchor): Promise<void>
}

export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function createRiskGateStateStore(
  accountId: string,
  filePath: string = dataPath('trading', accountId, 'risk-gate-state.json'),
): RiskGateStateStore {
  async function read(): Promise<RiskGateStateFile | undefined> {
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as RiskGateStateFile
      if (raw && raw.schemaVersion === 1) return raw
      return undefined
    } catch {
      return undefined
    }
  }

  return {
    async getDayAnchor(dateUtc) {
      const state = await read()
      return state?.day?.dateUtc === dateUtc ? state.day : undefined
    },
    async captureDayAnchor(anchor) {
      const state: RiskGateStateFile = { schemaVersion: 1, day: anchor }
      try {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, JSON.stringify(state, null, 2))
      } catch (err) {
        // Anchor persistence is best-effort — G3 is observe-only in v0 and
        // must never turn a disk error into a blocked push.
        console.warn(`[risk-gates] ${accountId}: failed to persist day anchor:`, err instanceof Error ? err.message : err)
      }
    },
  }
}

/** In-memory store for tests / preview isolation. */
export function createMemoryRiskGateStateStore(): RiskGateStateStore {
  let day: RiskGateDayAnchor | undefined
  return {
    async getDayAnchor(dateUtc) {
      return day?.dateUtc === dateUtc ? day : undefined
    },
    async captureDayAnchor(anchor) {
      day = anchor
    },
  }
}
