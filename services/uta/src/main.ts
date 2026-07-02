/**
 * UTA service entry — co-located v1.
 *
 * Owns the trading domain (broker connections, git-like approval state,
 * snapshots, FX). Bind 127.0.0.1-only — Alice talks to UTA via
 * `OPENALICE_UTA_URL`, never exposed externally.
 *
 * Startup path is also the reload path: when broker config changes, Alice
 * touches `data/control/restart-uta.flag`, Guardian SIGTERMs this process
 * and respawns. There is no in-process hot-reload code path.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { loadConfig, readUTAsConfig, purgeEphemeralUTAs } from '@/core/config.js'
import { createEventLog } from '@/core/event-log.js'
import { ToolCenter } from '@/core/tool-center.js'
import {
  UTAManager,
  createSnapshotService,
  createSnapshotScheduler,
} from './domain/trading/index.js'
import { FxService } from './domain/trading/fx-service.js'
import {
  seedRiskGatesConfig,
  createRiskGatesConfigLoader,
  getRegimeReading,
  startRegimeShadow,
} from './domain/trading/risk-gates/index.js'
import {
  seedResearchShadowConfig,
  createResearchShadowConfigLoader,
  startResearchShadow,
  ALL_STRATEGIES,
} from './domain/research/shadow/index.js'
import {
  getSDKExecutor,
  buildRouteMap,
  SDKCurrencyClient,
} from '@/domain/market-data/client/typebb/index.js'
import type { CurrencyClientLike } from '@/domain/market-data/client/types.js'
import { buildSDKCredentials } from '@/domain/market-data/credential-map.js'
import { OpenBBCurrencyClient } from '@/domain/market-data/client/openbb-api/currency-client.js'
import { createTradingRoutes } from './http/routes-trading.js'
import { createSimulatorRoutes } from './http/routes-simulator.js'
import type { EngineContext } from '@/core/types.js'

const UTA_PORT = Number(process.env['OPENALICE_UTA_PORT'] ?? 47333)
const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000  // 6h

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  console.log(`[uta] bootstrap @ ${startedAt}`)

  const config = await loadConfig()

  // ==================== Trading-only dependencies ====================
  // UTA needs eventLog (UTAManager journaling) + toolCenter (CCXT tool
  // registration). Other infra Alice has (agentCenter, connectorCenter,
  // listenerRegistry, ...) is not used by trading routes.

  const eventLog = await createEventLog()
  const toolCenter = new ToolCenter()
  const utaManager = new UTAManager({ eventLog, toolCenter })

  // Seed data/config/risk-gates.json with observe-mode defaults if absent —
  // the calibration surface must be discoverable. Never overwrites.
  await seedRiskGatesConfig()

  // ==================== Account init (with ephemeral purge) ====================

  const survivors = await purgeEphemeralUTAs(await readUTAsConfig())
  for (const accCfg of survivors) {
    if (accCfg.enabled === false) continue
    await utaManager.initUTA(accCfg)
  }
  utaManager.registerCcxtToolsIfNeeded()

  // ==================== FX (single-asset-class slice of market-data) ====================
  // UTA needs only the currency client for USD conversion in
  // /api/trading/equity. The other market-data clients stay in Alice.

  const { providers } = config.marketData
  let currencyClient: CurrencyClientLike
  if (config.marketData.backend === 'openbb-api') {
    currencyClient = new OpenBBCurrencyClient(
      config.marketData.apiUrl,
      providers.currency,
      config.marketData.providerKeys,
    )
  } else {
    const executor = getSDKExecutor()
    const routeMap = buildRouteMap()
    const credentials = buildSDKCredentials(config.marketData.providerKeys)
    currencyClient = new SDKCurrencyClient(executor, 'currency', providers.currency, credentials, routeMap)
  }
  const fxService = new FxService(currencyClient)
  utaManager.setFxService(fxService)

  // ==================== Snapshots ====================

  const snapshotService = createSnapshotService({ utaManager, eventLog })
  utaManager.setSnapshotHooks({
    onPostPush: (id) => { snapshotService.takeSnapshot(id, 'post-push') },
    onPostReject: (id) => { snapshotService.takeSnapshot(id, 'post-reject') },
  })

  const snapshotScheduler = createSnapshotScheduler({ snapshotService, config: config.snapshot })
  await snapshotScheduler.start()
  if (config.snapshot.enabled) {
    console.log(`[uta] snapshot scheduler started (every ${config.snapshot.every})`)
  }

  // ==================== Regime shadow (Phase 2 observe track) ====================
  // Daily BTC regime-zone reading logged to the event log — the auditable
  // record behind the regime-veto observe-exit criterion. Independent of
  // whether any short intent ever fires. Started when the defaults-level OR
  // ANY account-level regimeVeto mode is non-off (an account can enable the
  // veto without touching the defaults and still gets its evidence trail).
  //
  // NOTE: this startup decision follows the UTA's global reload model — the
  // startup path IS the reload path (see file header). Changing
  // risk-gates.json regimeVeto modes affects gate evaluation immediately
  // (config is read per evaluation) but the shadow timer only re-evaluates
  // on the next UTA restart (data/control/restart-uta.flag).
  let regimeShadow: { stop(): void } | undefined
  try {
    const rgResolution = await createRiskGatesConfigLoader()()
    if (rgResolution.status === 'ok') {
      const candidates = [
        rgResolution.forAccount('__defaults__', '').regimeVeto,
        ...survivors.map(acc => rgResolution.forAccount(acc.id, acc.presetId).regimeVeto),
      ]
      const active = candidates.find(rv => rv.mode !== 'off')
      if (active) {
        regimeShadow = startRegimeShadow({ getReading: getRegimeReading, cfg: active, eventLog })
        console.log(`[uta] regime shadow started (${active.regimeSource.symbol}, mode=${active.mode}; restart UTA to apply regimeVeto config changes to the shadow)`)
      }
    }
  } catch (err) {
    console.warn('[uta] regime shadow not started:', err instanceof Error ? err.message : err)
  }

  // ==================== Research shadow (strategy shadow track) ====================
  // docs/strategy-shadow-track-v0.md — forward paper-evidence scoring for
  // registered candidate strategies. Research evidence ONLY: never a signal,
  // never an order; no trading path reads its output. The per-strategy JSONL
  // ledger under data/research/shadow/ is the authority; events are mirrors.
  // Same reload model as the regime shadow: config is read per tick, but the
  // timer itself re-evaluates only on UTA restart.
  let researchShadow: { stop(): void } | undefined
  try {
    await seedResearchShadowConfig()
    researchShadow = startResearchShadow({
      strategies: ALL_STRATEGIES,
      loadConfig: createResearchShadowConfigLoader(),
      eventLog,
    })
    console.log(`[uta] research shadow started (${ALL_STRATEGIES.map(s => s.id).join(', ')}; ledger at data/research/shadow; evidence only — never a signal)`)
  } catch (err) {
    console.warn('[uta] research shadow not started:', err instanceof Error ? err.message : err)
  }

  // ==================== Catalog refresh ====================
  // Brokers that cache catalog (Alpaca / CCXT / Mock) need periodic refresh.
  // No-op for brokers that query server-side. Lifted from src/main.ts:460-470.

  const catalogRefreshTimer = setInterval(() => {
    for (const uta of utaManager.resolve()) {
      uta.refreshCatalog().catch((err) => {
        console.warn(`[uta] catalog-refresh ${uta.id} failed:`, err instanceof Error ? err.message : err)
      })
    }
  }, CATALOG_REFRESH_MS)
  catalogRefreshTimer.unref?.()

  // ==================== HTTP app ====================

  const app = new Hono()

  // Health probe — used by Guardian readiness gate and Alice BFF supervisor.
  app.get('/__uta/health', (c) => c.json({
    ok: true,
    startedAt,
    utas: utaManager.listUTAs().length,
  }))

  // Trading routes — reused from Alice's existing module via @/ path alias.
  // Cast to EngineContext: trading routes only touch utaManager / fxService /
  // snapshotService. Other ctx fields aren't read, so the narrow assembly is
  // structurally sufficient even though the type is wider on paper.
  const tradingCtx = {
    utaManager,
    fxService,
    snapshotService,
  } as unknown as EngineContext
  app.route('/api/trading', createTradingRoutes(tradingCtx))
  // Simulator endpoints — MockBroker-only god-view operations the
  // /dev/simulator UI tab drives. Lives next to the trading routes
  // because both need direct access to UTA's in-process MockBroker
  // instances. Alice BFF proxies `/api/simulator/*` to here.
  app.route('/api/simulator', createSimulatorRoutes(tradingCtx))

  // ==================== Bind + shutdown ====================

  const server = serve({
    fetch: app.fetch,
    port: UTA_PORT,
    hostname: '127.0.0.1',
  })
  console.log(`[uta] listening on http://127.0.0.1:${UTA_PORT}`)

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    console.log(`[uta] ${signal} → shutdown`)
    clearInterval(catalogRefreshTimer)
    regimeShadow?.stop()
    researchShadow?.stop()
    snapshotScheduler.stop()
    server.close()
    await utaManager.closeAll().catch(() => { /* swallow during shutdown */ })
    await eventLog.close().catch(() => { /* swallow during shutdown */ })
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((err) => {
  console.error('[uta] fatal:', err)
  process.exit(1)
})
