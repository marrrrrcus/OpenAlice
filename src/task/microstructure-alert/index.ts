export { createMicrostructureAlert } from './microstructure-alert.js'
export type { MicrostructureAlert, MicrostructureAlertOpts, MicrostructureState } from './microstructure-alert.js'
export {
  computeOrderBookMetrics,
  emptyBaseline,
  buildMicroAlertMessage,
} from './rules.js'
export type {
  MicroAlertType,
  MicroSeverity,
  MicroSignal,
  MicroRuleConfig,
  SymbolBaseline,
  OrderBookMetrics,
} from './rules.js'
export { decideNotification, emptyLifecycle } from './lifecycle.js'
export type { AlertLifecycle } from './lifecycle.js'
