/**
 * Risk-gate pipeline (Phase 1) — public surface.
 * Contract: docs/risk-gate-pipeline-v0.md. Phase 2 (regime veto) consumes
 * the intent classifier and the RiskGate/RiskGateContext extension points.
 */

export * from './types.js'
export * from './errors.js'
export {
  computeIntentLedger,
  classifyOperationIntent,
  findPositionFor,
  type IntentLedger,
  type OperationIntent,
} from './intent.js'
export { operationNotional, restingOrderNotional, type NotionalResult } from './notional.js'
export { decOrUndef, canonDec } from './decimal-io.js'
export {
  createRiskGatesConfigLoader,
  seedRiskGatesConfig,
  riskGatesConfigPath,
  type ResolvedRiskGateConfig,
  type RiskGateThresholds,
  type RiskGatesConfigResolution,
} from './config.js'
export {
  createRiskGateStateStore,
  createMemoryRiskGateStateStore,
  utcDayOf,
  type RiskGateStateStore,
  type RiskGateDayAnchor,
} from './state.js'
export {
  evaluateRiskGates,
  type EvaluateRiskGatesArgs,
  type RiskGateSnapshot,
  type FxLike,
} from './evaluator.js'
export { g1MaxOrderNotional, GATE_G1 } from './gates/g1-max-order-notional.js'
export { g2MaxTotalExposure, GATE_G2 } from './gates/g2-max-total-exposure.js'
export { g3DailyLossBreaker, GATE_G3 } from './gates/g3-daily-loss-breaker.js'
export { g4RateAndDuplicate, GATE_G4, canonicalIntentKey } from './gates/g4-rate-and-duplicate.js'
export {
  regimeVeto,
  GATE_REGIME,
  regimeMarketDataKey,
  shortIncreasingIndices,
  hasGatedShortIncreasing,
} from './gates/regime-veto.js'
export { effectiveOrderSide, nativeKeyOf } from './intent.js'
export type { RegimeVetoConfig } from './config.js'
export { computeZone, SMA_WINDOW, type RegimeZone, type ZoneResult } from './regime/zone.js'
export {
  createRegimeProvider,
  getRegimeReading,
  fetchBinanceSpotKlines,
  type RegimeReading,
  type RegimeProvider,
  type RegimeSourceConfig,
  type FetchKlines,
  type KlineRow,
} from './regime/provider.js'
export { startRegimeShadow, type RegimeShadowOptions } from './regime/shadow.js'
