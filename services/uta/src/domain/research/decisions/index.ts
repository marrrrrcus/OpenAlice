/**
 * Track D — human decision ledger + counterfactual brake ledger.
 * Contract: docs/human-decision-ledger-v0.md (locked). Research evidence
 * only: never a signal, never a proposal, never an order.
 */

export * from './types.js'
export {
  decisionsDir,
  decisionsLedgerPath,
  brakesLedgerPath,
  decisionsDerivedPath,
  brakesDerivedPath,
  appendRow,
  readDecisionsRows,
  readBrakesRows,
  readDerivedRows,
  isValidDecisionsRow,
  isValidBrakesRow,
  isValidDerivedRow,
  effectiveMarks,
  effectiveFundingContext,
  effectiveRegimeContext,
  markKey,
} from './ledger.js'
export {
  createResearchDecisionsConfigLoader,
  seedResearchDecisionsConfig,
  researchDecisionsConfigPath,
  type ResearchDecisionsConfigResolution,
} from './config.js'
export {
  createDecisionRecorder,
  hasBrakeContent,
  type DecisionRecorder,
  type DecisionRecorderDeps,
  type CaptureOutcome,
} from './recorder.js'
export { computeHorizonMark, type DailyCandleInput } from './marks.js'
export {
  fetchBinanceUsdmFundingHistory,
  computeFundingBucket,
  toFapiSymbol,
  type SettledFundingRow,
} from './funding.js'
export { processMarkTick, type MarkTickDeps } from './marker.js'
export { startDecisionsTicker, type DecisionsTickerOptions } from './ticker.js'
