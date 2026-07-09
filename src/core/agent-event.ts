/**
 * Agent Event Type System — typed event registry with runtime validation.
 *
 * `AgentEvents` is the single source of truth: each event type maps to a
 * metadata record holding its TypeBox schema, whether it's externally
 * ingestable, and an optional human-readable description.
 *
 * `AgentEventSchemas` and `isExternalEventType` are derived views exposed
 * for ergonomics and backward compatibility.
 *
 * Adding a new event type:
 *   1. Define its payload interface
 *   2. Add it to `AgentEventMap`
 *   3. Add an entry to `AgentEvents` with schema + (optional) external/description
 */

import { Type, type TSchema } from '@sinclair/typebox'
import AjvPkg from 'ajv'
import type { NotificationSource } from './notifications-store.js'

// Re-export CronFirePayload from its canonical location
export type { CronFirePayload } from '../task/cron/engine.js'

// ==================== Payload Interfaces ====================

export interface MessageReceivedPayload {
  channel: string
  to: string
  prompt: string
}

export interface MessageSentPayload {
  channel: string
  to: string
  prompt: string
  reply: string
  durationMs: number
}

// ==================== Canonical AgentWork events ====================
//
// All "Alice runs an async task" flows funnel through these four
// canonical events instead of per-trigger-source event types. The
// `source` field on each payload is the routing key — consumers
// filter on it instead of subscribing to separate event types.
//
// `agent.work.requested` is externally-ingestable (webhook). The
// done/skip/error events are internal-only.

export interface AgentWorkRequestedPayload {
  /** Which trigger source produced this work request. Drives the
   *  agent-work-listener's source-registry lookup. */
  source: NotificationSource
  /** The AI prompt to execute. */
  prompt: string
  /** Trigger-specific metadata, surfaced back on the canonical
   *  done/skip/error events via per-source payload builders. */
  metadata?: Record<string, unknown>
}

export interface AgentWorkDonePayload {
  source: NotificationSource
  reply: string
  durationMs: number
  /** Did the notification actually reach the connector? */
  delivered: boolean
  metadata?: Record<string, unknown>
}

export interface AgentWorkSkipPayload {
  source: NotificationSource
  /** Free-form reason — e.g. 'ack' | 'duplicate' | 'empty' |
   *  'outside-active-hours' | per-source extension. */
  reason: string
  metadata?: Record<string, unknown>
}

export interface AgentWorkErrorPayload {
  source: NotificationSource
  error: string
  durationMs: number
  metadata?: Record<string, unknown>
}

// ==================== Trading risk-gate event ====================
//
// One event per risk-gate evaluation of a pending trading commit
// (docs/risk-gate-pipeline-v0.md) — push-time or status-preview — carrying
// every gate verdict. This is the audit trail behind the observe-mode exit
// review. Emitted by the UTA service directly via its own EventLog instance
// (the UTA process has no ListenerRegistry; same precedent as
// 'account.health').

export interface TradingRiskGateVerdictPayload {
  accountId: string
  pendingHash: string | null
  trigger: 'push' | 'preview'
  mode: 'off' | 'observe' | 'enforce'
  result: 'PASS' | 'BLOCK'
  /** True when this evaluation actually gated a push (enforce + BLOCK at push time). */
  enforced: boolean
  configSource: 'file' | 'defaults' | 'invalid'
  verdicts: Array<{
    gate: string
    result: string
    code?: string
    reason: string
    observed?: string
    limit?: string
  }>
}

// ==================== Event Map ====================

// Import the actual CronFirePayload type for use in the map
import type { CronFirePayload } from '../task/cron/engine.js'

// ---- Regime shadow (docs/regime-veto-onboarding-v0.md observe track) ----
//
// One entry per UTC day: the live regime zone computed from Binance spot
// daily closes. This is the auditable record behind the ">=30 computed days
// within a 45-day window" observe-exit criterion. Emitted by the UTA
// service's regime shadow timer (same direct-append precedent as
// trading.risk_gate.verdict).

export interface TradingRegimeZonePayload {
  symbol: string
  dateUtc: string
  zone: 'BULL' | 'BEAR' | 'GRAY' | 'UNKNOWN'
  close?: string
  sma200?: string
  dataAgeHours?: number
  /** Populated when zone is UNKNOWN. */
  error?: string
}

// ---- Strategy shadow track (docs/strategy-shadow-track-v0.md) ----
//
// Research evidence only — never a signal, never a proposal. The per-strategy
// JSONL ledger under data/research/shadow/ is the authority; these events are
// best-effort visibility mirrors emitted by the UTA research shadow timer
// (same direct-append precedent as trading.regime.zone). `shadowOnly` is a
// schema-level literal so no consumer can plausibly read these as tradable.
// Returns are decimal FRACTIONS as strings (−0.0081 = −0.81%), never percent.

export interface ResearchShadowStancePayload {
  strategy: string
  symbol: string
  dateUtc: string
  stance: 'long' | 'short' | 'flat' | 'unknown'
  close?: string
  backfilled?: boolean
  /** Populated when stance is 'unknown'. */
  reason?: string
  shadowOnly: true
}

export interface ResearchShadowMarkPayload {
  strategy: string
  symbol: string
  dateUtc: string
  stanceHeld: 'long' | 'short' | 'flat'
  grossRet: string
  legs: number
  costPerLegBps: string
  netRet: string
  equity: string
  backfilled?: boolean
  shadowOnly: true
}

export interface AgentEventMap {
  'cron.fire': CronFirePayload
  'message.received': MessageReceivedPayload
  'message.sent': MessageSentPayload
  'agent.work.requested': AgentWorkRequestedPayload
  'agent.work.done':      AgentWorkDonePayload
  'agent.work.skip':      AgentWorkSkipPayload
  'agent.work.error':     AgentWorkErrorPayload
  'trading.risk_gate.verdict': TradingRiskGateVerdictPayload
  'trading.regime.zone': TradingRegimeZonePayload
  'research.shadow.stance': ResearchShadowStancePayload
  'research.shadow.mark': ResearchShadowMarkPayload
}

// ==================== TypeBox Schemas ====================

const CronFireSchema = Type.Object({
  jobId: Type.String(),
  jobName: Type.String(),
  payload: Type.String(),
})

const MessageReceivedSchema = Type.Object({
  channel: Type.String(),
  to: Type.String(),
  prompt: Type.String(),
})

const MessageSentSchema = Type.Object({
  channel: Type.String(),
  to: Type.String(),
  prompt: Type.String(),
  reply: Type.String(),
  durationMs: Type.Number(),
})

// ---- Canonical agent-work event schemas ----
//
// `source` is constrained to the NotificationSource union literal set.
// Free-form `metadata` is `unknown` at validation time (downstream
// shape decided per-source).

const SourceUnion = Type.Union([
  Type.Literal('heartbeat'),
  Type.Literal('cron'),
  Type.Literal('task'),
  Type.Literal('manual'),
  Type.Literal('market-report'),
  Type.Literal('market-state-alert'),
  Type.Literal('account-report'),
  Type.Literal('news-alert'),
  Type.Literal('microstructure-alert'),
])

const AgentWorkRequestedSchema = Type.Object({
  source: SourceUnion,
  prompt: Type.String(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

const AgentWorkDoneSchema = Type.Object({
  source: SourceUnion,
  reply: Type.String(),
  durationMs: Type.Number(),
  delivered: Type.Boolean(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

const AgentWorkSkipSchema = Type.Object({
  source: SourceUnion,
  reason: Type.String(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

const AgentWorkErrorSchema = Type.Object({
  source: SourceUnion,
  error: Type.String(),
  durationMs: Type.Number(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

const TradingRegimeZoneSchema = Type.Object({
  symbol: Type.String(),
  dateUtc: Type.String(),
  zone: Type.Union([
    Type.Literal('BULL'),
    Type.Literal('BEAR'),
    Type.Literal('GRAY'),
    Type.Literal('UNKNOWN'),
  ]),
  close: Type.Optional(Type.String()),
  sma200: Type.Optional(Type.String()),
  dataAgeHours: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
})

const ResearchShadowStanceSchema = Type.Object({
  strategy: Type.String(),
  symbol: Type.String(),
  dateUtc: Type.String(),
  stance: Type.Union([
    Type.Literal('long'),
    Type.Literal('short'),
    Type.Literal('flat'),
    Type.Literal('unknown'),
  ]),
  close: Type.Optional(Type.String()),
  backfilled: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String()),
  shadowOnly: Type.Literal(true),
})

const ResearchShadowMarkSchema = Type.Object({
  strategy: Type.String(),
  symbol: Type.String(),
  dateUtc: Type.String(),
  stanceHeld: Type.Union([
    Type.Literal('long'),
    Type.Literal('short'),
    Type.Literal('flat'),
  ]),
  grossRet: Type.String(),
  legs: Type.Number(),
  costPerLegBps: Type.String(),
  netRet: Type.String(),
  equity: Type.String(),
  backfilled: Type.Optional(Type.Boolean()),
  shadowOnly: Type.Literal(true),
})

const TradingRiskGateVerdictSchema = Type.Object({
  accountId: Type.String(),
  pendingHash: Type.Union([Type.String(), Type.Null()]),
  trigger: Type.Union([Type.Literal('push'), Type.Literal('preview')]),
  mode: Type.Union([Type.Literal('off'), Type.Literal('observe'), Type.Literal('enforce')]),
  result: Type.Union([Type.Literal('PASS'), Type.Literal('BLOCK')]),
  enforced: Type.Boolean(),
  configSource: Type.Union([Type.Literal('file'), Type.Literal('defaults'), Type.Literal('invalid')]),
  verdicts: Type.Array(Type.Object({
    gate: Type.String(),
    result: Type.String(),
    code: Type.Optional(Type.String()),
    reason: Type.String(),
    observed: Type.Optional(Type.String()),
    limit: Type.Optional(Type.String()),
  })),
})

// ==================== AgentEvents — metadata registry ====================

export interface AgentEventMeta {
  /** TypeBox schema for runtime payload validation. */
  schema: TSchema
  /** If true, this event type may be ingested from outside the process
   *  (HTTP webhook, external API). Internal-only types cannot be
   *  forged by external callers. Default: false. */
  external?: boolean
  /** Optional human-readable description — surfaced in topology UI tooltips. */
  description?: string
}

/** Single source of truth — metadata for every registered event type. */
export const AgentEvents: { [K in keyof AgentEventMap]: AgentEventMeta } = {
  'cron.fire': {
    schema: CronFireSchema,
    description: 'Cron scheduler timer fired for a registered job.',
  },
  'message.received': {
    schema: MessageReceivedSchema,
    description: 'A user message arrived on a connector (Web chat, Telegram, etc.).',
  },
  'message.sent': {
    schema: MessageSentSchema,
    description: 'An assistant reply was dispatched on a connector.',
  },
  'agent.work.requested': {
    schema: AgentWorkRequestedSchema,
    external: true,
    description: 'Canonical request to dispatch an AgentWork task. Carries `source` (which trigger produced it) plus the AI prompt. Ingestible via POST /api/events/ingest; the webhook layer also accepts the legacy `task.requested` event type and translates it to this canonical form.',
  },
  'agent.work.done': {
    schema: AgentWorkDoneSchema,
    description: 'An AgentWork task completed and its reply was dispatched. Filter on payload.source to attribute to a specific trigger (heartbeat / cron / task).',
  },
  'agent.work.skip': {
    schema: AgentWorkSkipSchema,
    description: 'An AgentWork task was suppressed before delivery (dedup, empty content, outside active hours, AI declined to notify, …). Filter on payload.source for trigger attribution.',
  },
  'agent.work.error': {
    schema: AgentWorkErrorSchema,
    description: 'An AgentWork task failed during execution. Filter on payload.source for trigger attribution.',
  },
  'trading.risk_gate.verdict': {
    schema: TradingRiskGateVerdictSchema,
    description: 'Risk-gate pipeline evaluated a pending trading commit (docs/risk-gate-pipeline-v0.md). One event per evaluation with every gate verdict; enforced=true means a push was actually blocked. Audit trail for the observe-mode exit review.',
  },
  'trading.regime.zone': {
    schema: TradingRegimeZoneSchema,
    description: 'Daily regime-shadow reading (docs/regime-veto-onboarding-v0.md): the live BTC regime zone computed from Binance spot daily closes. One good entry per UTC day; UNKNOWN entries carry the failure reason. Evidence track for the regime-veto observe exit.',
  },
  'research.shadow.stance': {
    schema: ResearchShadowStanceSchema,
    description: 'Strategy shadow track (docs/strategy-shadow-track-v0.md): the paper stance recorded for one strategy and UTC day. Research evidence only — never a signal, never a proposal. The JSONL ledger under data/research/shadow/ is the authority; this event is a visibility mirror.',
  },
  'research.shadow.mark': {
    schema: ResearchShadowMarkSchema,
    description: 'Strategy shadow track (docs/strategy-shadow-track-v0.md): mark-to-market of the stance held during one UTC day (close-to-close, costs charged on stance changes). Research evidence only — never a signal, never a proposal. Mirror of the authoritative ledger row.',
  },
}

// ==================== Derived views ====================

/** Schemas-only map — derived for Ajv compilation and existing consumers. */
export const AgentEventSchemas: { [K in keyof AgentEventMap]: TSchema } =
  Object.fromEntries(
    (Object.keys(AgentEvents) as Array<keyof AgentEventMap>).map(
      (k) => [k, AgentEvents[k].schema],
    ),
  ) as { [K in keyof AgentEventMap]: TSchema }

/** Whether this event type may be ingested from outside the process. */
export function isExternalEventType(type: string): boolean {
  return (
    type in AgentEvents &&
    AgentEvents[type as keyof AgentEventMap].external === true
  )
}

// ==================== Runtime Validation ====================

// Ajv ESM interop — package's default export is on `.default` under ESM
const ajv = new (AjvPkg as unknown as new (opts?: object) => import('ajv').default)({
  allErrors: true,
  strict: false,
})

const validators = new Map<string, ReturnType<typeof ajv.compile>>()
for (const [type, meta] of Object.entries(AgentEvents)) {
  validators.set(type, ajv.compile(meta.schema))
}

/**
 * Validate a payload against its registered schema.
 * - Registered type + valid payload → returns silently
 * - Registered type + invalid payload → throws Error
 * - Unregistered type → returns silently (no schema to check)
 */
export function validateEventPayload(type: string, payload: unknown): void {
  const validate = validators.get(type)
  if (!validate) return
  if (!validate(payload)) {
    const errors = validate.errors?.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')
    throw new Error(`Invalid payload for event "${type}": ${errors}`)
  }
}
