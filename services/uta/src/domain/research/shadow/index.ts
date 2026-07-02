/**
 * Strategy shadow track — public surface.
 * Contract: docs/strategy-shadow-track-v0.md (locked). Research evidence
 * only: never a signal, never a proposal, never an order.
 */

export * from './types.js'
export { stanceNum, legsBetween, markDay, applyEquity, type DayMark } from './mark.js'
export {
  researchLedgerPath,
  appendLedgerRow,
  readLedgerRows,
  effectiveRows,
} from './ledger.js'
export {
  createResearchShadowConfigLoader,
  seedResearchShadowConfig,
  researchShadowConfigPath,
  isStrategyEnabled,
  type ResearchShadowConfig,
  type ResearchShadowConfigResolution,
} from './config.js'
export { processStrategyTick, type StrategyTickDeps } from './runner.js'
export { startResearchShadow, type ResearchShadowOptions } from './shadow.js'
export { ALL_STRATEGIES } from './strategies/index.js'
export { buyAndHoldV0 } from './strategies/buy-and-hold-v0.js'
export { dayUtcOfMs, startOfDayMs, addDays, diffDays, expectedDayUtc } from './dates.js'
