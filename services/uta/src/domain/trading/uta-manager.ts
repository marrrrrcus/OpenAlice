/**
 * UTAManager — UTA lifecycle management, registry, and aggregation.
 *
 * Owns the full UTA lifecycle: create → register → reconnect → remove → close.
 * Also provides cross-UTA operations (aggregated equity, contract search).
 */

import Decimal from 'decimal.js'
import type { Contract, ContractDescription, ContractDetails } from '@traderalice/ibkr'
import type { AccountCapabilities, BrokerHealth, BrokerHealthInfo } from './brokers/types.js'
import { CcxtBroker } from './brokers/ccxt/CcxtBroker.js'
import { createCcxtProviderTools } from './brokers/ccxt/ccxt-tools.js'
import { createBroker } from './brokers/factory.js'
import { getBrokerPreset } from '@traderalice/uta-protocol'
import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import type { ResearchCaptureSink } from './research-capture.js'
import { loadGitState, createGitPersister } from './git-persistence.js'
import { readUTAsConfig, type UTAConfig } from '@/core/config.js'
import type { EventLog } from '@/core/event-log.js'
import type { ToolCenter } from '@/core/tool-center.js'
import type { ReconnectResult } from '@/core/types.js'
import type { FxService } from './fx-service.js'
import './contract-ext.js'

// Manager-level shapes live in `@traderalice/uta-protocol` (the SDK
// contract surface) — re-exported here for backwards compatibility with
// callers that import via `@/domain/trading`.
import type { UTASummary, AggregatedEquity, ContractSearchResult } from '@traderalice/uta-protocol'
export type { UTASummary, AggregatedEquity, ContractSearchResult }

// ==================== UTAManager ====================

export interface SnapshotHooks {
  onPostPush?: (utaId: string) => void | Promise<void>
  onPostReject?: (utaId: string) => void | Promise<void>
}

export class UTAManager {
  private entries = new Map<string, UnifiedTradingAccount>()
  private reconnecting = new Set<string>()

  private eventLog?: EventLog
  private toolCenter?: ToolCenter
  private _snapshotHooks?: SnapshotHooks
  private _researchSink?: ResearchCaptureSink
  private fxService?: FxService

  constructor(deps?: { eventLog: EventLog; toolCenter: ToolCenter; fxService?: FxService }) {
    this.eventLog = deps?.eventLog
    this.toolCenter = deps?.toolCenter
    this.fxService = deps?.fxService
  }

  setSnapshotHooks(hooks: SnapshotHooks): void {
    this._snapshotHooks = hooks
  }

  /**
   * Track D research capture sink (docs/human-decision-ledger-v0.md) —
   * wired LAZILY into every UTA (the closure dereferences at emit time),
   * so setResearchSink may be called before or after initUTA without a
   * stale-capture ordering trap.
   */
  setResearchSink(sink: ResearchCaptureSink): void {
    this._researchSink = sink
  }

  setFxService(fx: FxService): void {
    this.fxService = fx
  }

  // ==================== Lifecycle ====================

  /** Create a UTA from config, register it, and start async broker connection. */
  async initUTA(cfg: UTAConfig): Promise<UnifiedTradingAccount> {
    const broker = createBroker(cfg, { fxService: this.fxService })
    const savedState = await loadGitState(cfg.id)
    const uta = new UnifiedTradingAccount(broker, {
      guards: cfg.guards,
      savedState,
      onCommit: createGitPersister(cfg.id),
      onHealthChange: (utaId, health) => {
        this.eventLog?.append('account.health', { accountId: utaId, ...health })
      },
      onPostPush: this._snapshotHooks?.onPostPush,
      onPostReject: this._snapshotHooks?.onPostReject,
      // Lazy dereference — see setResearchSink. (The snapshot hooks above
      // capture by value; their wiring order in main.ts happens to be safe
      // for the current call sites, but new hooks must not repeat it.)
      onResearchCapture: (evt) => this._researchSink?.(evt),
      riskGates: {
        presetId: cfg.presetId,
        // Lazy: FxService is wired via setFxService AFTER the initUTA loop
        // in services/uta/src/main.ts — a captured instance would be stale.
        getFx: () => this.fxService,
        onReport: (report, meta) => {
          this.eventLog?.append('trading.risk_gate.verdict', {
            accountId: cfg.id,
            pendingHash: meta.pendingHash,
            trigger: meta.trigger,
            mode: report.mode,
            result: report.result,
            enforced: meta.enforced,
            configSource: report.configSource,
            // Strip undefined optionals — Ajv-validated payloads must not
            // carry present-but-undefined keys.
            verdicts: report.verdicts.map(v => ({
              gate: v.gate,
              result: v.result,
              reason: v.reason,
              ...(v.code !== undefined ? { code: v.code } : {}),
              ...(v.observed !== undefined ? { observed: v.observed } : {}),
              ...(v.limit !== undefined ? { limit: v.limit } : {}),
            })),
          })
        },
      },
    })
    this.add(uta)
    return uta
  }

  /** Reconnect a UTA: close old → re-read config → create new → verify connection. */
  async reconnectUTA(utaId: string): Promise<ReconnectResult> {
    if (this.reconnecting.has(utaId)) {
      return { success: false, error: 'Reconnect already in progress' }
    }
    this.reconnecting.add(utaId)
    try {
      // Re-read config to pick up credential/guard changes
      const freshUTAs = await readUTAsConfig()

      // Close old UTA
      await this.removeUTA(utaId)

      const cfg = freshUTAs.find((a) => a.id === utaId)
      if (!cfg) {
        return { success: true, message: `UTA "${utaId}" not found in config (removed or disabled)` }
      }

      const uta = await this.initUTA(cfg)

      // Wait for broker.init() + broker.getAccount() to verify the connection
      await uta.waitForConnect()

      // Re-register CCXT-specific tools if this UTA routes to the CCXT engine.
      if (getBrokerPreset(cfg.presetId).engine === 'ccxt') {
        this.toolCenter?.register(
          createCcxtProviderTools(this),
          'trading-ccxt',
        )
      }

      const label = uta.label ?? utaId
      console.log(`reconnect: ${label} online`)
      return { success: true, message: `${label} reconnected` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`reconnect: ${utaId} failed:`, msg)
      return { success: false, error: msg }
    } finally {
      this.reconnecting.delete(utaId)
    }
  }

  /** Close and deregister a UTA. No-op if UTA doesn't exist. */
  async removeUTA(utaId: string): Promise<void> {
    const uta = this.entries.get(utaId)
    if (!uta) return
    this.entries.delete(utaId)
    try { await uta.close() } catch { /* best effort */ }
  }

  /** Register CCXT provider tools if any CCXT accounts are present. */
  registerCcxtToolsIfNeeded(): void {
    const hasCcxt = this.resolve().some((uta) => uta.broker instanceof CcxtBroker)
    if (hasCcxt) {
      this.toolCenter?.register(createCcxtProviderTools(this), 'trading-ccxt')
      console.log('ccxt: provider tools registered')
    }
  }

  // ==================== Registration ====================

  add(uta: UnifiedTradingAccount): void {
    if (this.entries.has(uta.id)) {
      throw new Error(`UTA "${uta.id}" already registered`)
    }
    this.entries.set(uta.id, uta)
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  // ==================== Lookups ====================

  get(id: string): UnifiedTradingAccount | undefined {
    return this.entries.get(id)
  }

  listUTAs(): UTASummary[] {
    return Array.from(this.entries.values()).map((uta) => ({
      id: uta.id,
      label: uta.label,
      capabilities: uta.getCapabilities(),
      health: uta.getHealthInfo(),
    }))
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  get size(): number {
    return this.entries.size
  }

  // ==================== Source routing ====================

  resolve(source?: string): UnifiedTradingAccount[] {
    if (!source) {
      return Array.from(this.entries.values())
    }
    const byId = this.entries.get(source)
    if (byId) return [byId]
    return []
  }

  resolveOne(source: string): UnifiedTradingAccount {
    const results = this.resolve(source)
    if (results.length === 0) {
      throw new Error(`No UTA found matching source "${source}". Use listUTAs to see available UTAs.`)
    }
    if (results.length > 1) {
      throw new Error(
        `Multiple UTAs match source "${source}": ${results.map((r) => r.id).join(', ')}. Use UTA id for exact match.`,
      )
    }
    return results[0]
  }

  // ==================== Cross-account aggregation ====================

  async getAggregatedEquity(): Promise<AggregatedEquity> {
    const results = await Promise.all(
      Array.from(this.entries.values()).map(async (uta) => {
        if (uta.health !== 'healthy') {
          uta.nudgeRecovery()
          return { id: uta.id, label: uta.label, health: uta.health, info: null }
        }
        try {
          const info = await uta.getAccount()
          return { id: uta.id, label: uta.label, health: uta.health, info }
        } catch {
          return { id: uta.id, label: uta.label, health: uta.health, info: null }
        }
      }),
    )

    let totalEquity = new Decimal(0)
    let totalCash = new Decimal(0)
    let totalUnrealizedPnL = new Decimal(0)
    let totalRealizedPnL = new Decimal(0)
    const fxWarnings: string[] = []
    const accounts: AggregatedEquity['accounts'] = []

    for (const { id, label, health, info } of results) {
      const baseCurrency = info?.baseCurrency ?? 'USD'
      if (info) {
        if (this.fxService && baseCurrency !== 'USD') {
          // Convert non-USD account values to USD
          const [eqR, cashR, pnlR, rpnlR] = await Promise.all([
            this.fxService.convertToUsd(info.netLiquidation, baseCurrency),
            this.fxService.convertToUsd(info.totalCashValue, baseCurrency),
            this.fxService.convertToUsd(info.unrealizedPnL, baseCurrency),
            this.fxService.convertToUsd(info.realizedPnL ?? '0', baseCurrency),
          ])
          totalEquity = totalEquity.plus(eqR.usd)
          totalCash = totalCash.plus(cashR.usd)
          totalUnrealizedPnL = totalUnrealizedPnL.plus(pnlR.usd)
          totalRealizedPnL = totalRealizedPnL.plus(rpnlR.usd)
          // Collect warnings (deduplicate — same currency produces same warning)
          const w = eqR.fxWarning
          if (w && !fxWarnings.includes(w)) fxWarnings.push(w)
          accounts.push({ id, label, baseCurrency, equity: eqR.usd, cash: cashR.usd, unrealizedPnL: pnlR.usd, health })
        } else {
          // Already USD or no FxService — pass through
          totalEquity = totalEquity.plus(info.netLiquidation)
          totalCash = totalCash.plus(info.totalCashValue)
          totalUnrealizedPnL = totalUnrealizedPnL.plus(info.unrealizedPnL)
          totalRealizedPnL = totalRealizedPnL.plus(info.realizedPnL ?? '0')
          accounts.push({ id, label, baseCurrency, equity: info.netLiquidation, cash: info.totalCashValue, unrealizedPnL: info.unrealizedPnL, health })
        }
      } else {
        accounts.push({ id, label, baseCurrency, equity: '0', cash: '0', unrealizedPnL: '0', health })
      }
    }

    return {
      totalEquity: totalEquity.toString(), totalCash: totalCash.toString(),
      totalUnrealizedPnL: totalUnrealizedPnL.toString(), totalRealizedPnL: totalRealizedPnL.toString(),
      fxWarnings: fxWarnings.length > 0 ? fxWarnings : undefined,
      accounts,
    }
  }

  // ==================== Cross-account contract search ====================

  async searchContracts(
    pattern: string,
    accountId?: string,
  ): Promise<ContractSearchResult[]> {
    const targets = accountId
      ? [this.entries.get(accountId)].filter(Boolean) as UnifiedTradingAccount[]
      : Array.from(this.entries.values())

    const results = await Promise.all(
      targets.map(async (uta) => {
        if (uta.health !== 'healthy') {
          uta.nudgeRecovery()
          return { accountId: uta.id, results: [] as ContractDescription[] }
        }
        try {
          const descriptions = await uta.searchContracts(pattern)
          return { accountId: uta.id, results: descriptions }
        } catch {
          return { accountId: uta.id, results: [] as ContractDescription[] }
        }
      }),
    )

    return results.filter((r) => r.results.length > 0)
  }

  async getContractDetails(
    query: Contract,
    accountId: string,
  ): Promise<ContractDetails | null> {
    const uta = this.entries.get(accountId)
    if (!uta) return null
    return uta.getContractDetails(query)
  }

  // ==================== Cleanup ====================

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.entries.values()).map((uta) => uta.close()),
    )
    this.entries.clear()
  }
}
