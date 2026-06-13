/**
 * AgentWork — core primitive for "Alice does an async task outside chat".
 *
 * The shape: a piece of work has a `prompt` (what to do), a `session`
 * (continuity), a `preamble` (context hint), optional input/output
 * gates, and a set of event names to emit on completion.
 *
 * The runner threads it through:
 *   inputGate  → AI call → outputGate → notify → emit
 *
 * Three trigger sources today consume this primitive — heartbeat (with
 * active-hours inputGate + notify_user-inspecting outputGate + dedup
 * onDelivered), cron (no gates, default delivery), task-router (same).
 * Future sources (factor mining, asset monitoring, etc.) plug in
 * without re-implementing the gate→AI→notify→emit pipeline.
 *
 * The runner itself is stateless — construct once at startup with
 * shared deps, call run() per request with the per-call emit fn from
 * the listener context.
 */

import type { AgentCenter } from './agent-center.js'
import type { ConnectorCenter } from './connector-center.js'
import type { ISessionStore } from './session.js'
import type { NotificationSource } from './notifications-store.js'
import type { ProviderResult, ToolCallSummary } from '../ai-providers/types.js'
import type { MediaAttachment } from './types.js'

// ==================== Request / Result types ====================

/** Probe handed to outputGate — combines AI text/media plus the tool
 *  calls observed during generation. The latter is the mechanism by
 *  which structured tools like `notify_user` signal intent. */
export interface AgentWorkResultProbe {
  text: string
  media: MediaAttachment[]
  toolCalls: ReadonlyArray<ToolCallSummary>
}

/** Skip decision — emitted as the configured `skip` event. */
export interface AgentWorkSkip {
  reason: string
  /** Caller-shaped payload for the skip event. Free-form so each trigger
   *  source can attach its own metadata (parsedReason, reason-detail, …). */
  payload: object
}

/** Output gate decision — deliver to the user or skip silently. */
export type OutputGateDecision =
  | { kind: 'deliver'; text: string; media: MediaAttachment[] }
  | { kind: 'skip'; reason: string; payload: object }

export interface AgentWorkRequest {
  /** What Alice is asked to do (the AI prompt). */
  prompt: string

  /** Conversation scope. Same SessionStore reused across submissions
   *  from the same trigger source = continuous conversation. */
  session: ISessionStore

  /** Pre-prompt context — passed to agentCenter.askWithSession via
   *  AskOptions.historyPreamble. */
  preamble: string

  /** Used as connectorCenter.notify source label, plus available to
   *  gate functions for trigger-specific decisions. The source must
   *  match the NotificationSource union; adding a new trigger source
   *  means widening that union in notifications-store.ts. */
  metadata: { source: NotificationSource; [k: string]: unknown }

  /** Pre-AI guard. Return non-null to short-circuit (skip event emitted,
   *  AI never invoked). Used by heartbeat for active-hours filtering;
   *  used by cron's listener for own-job filtering (though that filter
   *  lives outside the request — pre-listener-handle, since it gates
   *  whether to even build the request). */
  inputGate?: (req: AgentWorkRequest) => AgentWorkSkip | null

  /** Post-AI gate. Decides notify vs skip based on AI result + observed
   *  tool calls. Default behaviour: deliver result.text unconditionally
   *  (matches today's cron / task-router semantics). */
  outputGate?: (probe: AgentWorkResultProbe, req: AgentWorkRequest) => OutputGateDecision

  /** Bookkeeping callback after a successful delivery — used by heartbeat
   *  to record the dedup window state. Not called for skip / error. */
  onDelivered?: (text: string, req: AgentWorkRequest) => void

  /** Delivery urgency for the notify() call. 'high' lets push-capable
   *  connectors surface proactively regardless of last-interaction —
   *  used by monitoring sources (market-report) whose AI summaries are
   *  themselves alerts. Defaults to 'normal'. */
  notifyPriority?: 'normal' | 'high'

  /** Names of the events this work emits.
   *  - done:   on successful delivery (always)
   *  - error:  on AI invocation throw (always)
   *  - skip:   on inputGate / outputGate skip — REQUIRED if either gate
   *            can return a skip; the runner treats a missing skip name
   *            as a programming error and falls back to silent suppression. */
  emitNames: { done: string; skip?: string; error: string }

  /** Construct the payload for the `done` event. Caller-shaped so each
   *  trigger source can include its own identifiers (jobId, prompt, etc.). */
  buildDonePayload: (
    req: AgentWorkRequest,
    result: ProviderResult,
    durationMs: number,
    delivered: boolean,
  ) => object

  /** Construct the payload for the `skip` event. Defaults to the skip
   *  decision's `payload` field if not supplied. */
  buildSkipPayload?: (req: AgentWorkRequest, skip: AgentWorkSkip) => object

  /** Construct the payload for the `error` event. */
  buildErrorPayload: (req: AgentWorkRequest, err: Error, durationMs: number) => object
}

export interface AgentWorkRunResult {
  outcome: 'delivered' | 'skipped' | 'errored'
  durationMs: number
  /** When `outcome === 'skipped'`, the reason that was attached to the
   *  skip event. Useful for callers that want to do bookkeeping outside
   *  the event log. */
  skipReason?: string
}

export interface AgentWorkRunnerDeps {
  agentCenter: AgentCenter
  connectorCenter: ConnectorCenter
  /** Inject the wall clock for tests. */
  now?: () => number
  /** Inject a logger for tests; defaults to console. */
  logger?: Pick<Console, 'warn' | 'error'>
}

/** The emit function shape — a permissive superset of the typed
 *  ListenerContext.emit signatures so the runner can accept any
 *  listener's emit without entangling its type generics. The caller
 *  is responsible for passing emit names that match its declared
 *  emits set; the runner doesn't validate. */
export type AgentWorkEmitFn = (
  type: string,
  payload: object,
) => Promise<unknown>

// ==================== Runner ====================

/** Stateless executor for AgentWork requests. Construct once with
 *  shared deps; call run(req, emit) per work submission.
 *
 *  Class form (rather than free function) for parity with AgentCenter /
 *  ConnectorCenter / NotificationsStore — keeps `src/core/` style
 *  consistent and gives a stable hook point for future deps injection
 *  (rate limiting, observability, etc.) without API churn at call sites. */
export class AgentWorkRunner {
  private readonly agentCenter: AgentCenter
  private readonly connectorCenter: ConnectorCenter
  private readonly now: () => number
  private readonly logger: Pick<Console, 'warn' | 'error'>

  constructor(deps: AgentWorkRunnerDeps) {
    this.agentCenter = deps.agentCenter
    this.connectorCenter = deps.connectorCenter
    this.now = deps.now ?? Date.now
    this.logger = deps.logger ?? console
  }

  async run(
    req: AgentWorkRequest,
    emit: AgentWorkEmitFn,
  ): Promise<AgentWorkRunResult> {
    const startMs = this.now()

    // ---- 1. inputGate ------------------------------------------------
    const skipBeforeAI = req.inputGate?.(req)
    if (skipBeforeAI) {
      await this.emitSkip(req, skipBeforeAI, emit)
      return {
        outcome: 'skipped',
        durationMs: this.now() - startMs,
        skipReason: skipBeforeAI.reason,
      }
    }

    // ---- 2. AI invocation -------------------------------------------
    let result: ProviderResult
    try {
      result = await this.agentCenter.askWithSession(req.prompt, req.session, {
        historyPreamble: req.preamble,
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      const durationMs = this.now() - startMs
      try {
        await emit(
          req.emitNames.error,
          req.buildErrorPayload(req, e, durationMs),
        )
      } catch (emitErr) {
        this.logger.error(
          `agent-work[${req.metadata.source}]: emit error event failed:`,
          emitErr,
        )
      }
      return { outcome: 'errored', durationMs }
    }

    // ---- 3. outputGate ----------------------------------------------
    const probe: AgentWorkResultProbe = {
      text: result.text,
      media: result.media,
      toolCalls: result.toolCalls ?? [],
    }
    const decision: OutputGateDecision = req.outputGate
      ? req.outputGate(probe, req)
      : { kind: 'deliver', text: result.text, media: result.media }

    if (decision.kind === 'skip') {
      await this.emitSkip(
        req,
        { reason: decision.reason, payload: decision.payload },
        emit,
      )
      return {
        outcome: 'skipped',
        durationMs: this.now() - startMs,
        skipReason: decision.reason,
      }
    }

    // ---- 4. Notify --------------------------------------------------
    let delivered = false
    try {
      await this.connectorCenter.notify(decision.text, {
        media: decision.media,
        source: req.metadata.source,
        priority: req.notifyPriority,
      })
      delivered = true
    } catch (sendErr) {
      // notify failure isn't fatal to the work — log and continue;
      // the done event flag tells consumers whether the user actually
      // got a push. Connectors that surface notifications make their
      // own delivery decisions downstream.
      this.logger.warn(
        `agent-work[${req.metadata.source}]: notify failed:`,
        sendErr,
      )
    }

    // ---- 5. onDelivered hook ---------------------------------------
    if (delivered) {
      try {
        req.onDelivered?.(decision.text, req)
      } catch (hookErr) {
        // Hook failure shouldn't lose the done event; log and proceed.
        this.logger.warn(
          `agent-work[${req.metadata.source}]: onDelivered hook threw:`,
          hookErr,
        )
      }
    }

    // ---- 6. Emit done ----------------------------------------------
    const durationMs = this.now() - startMs
    try {
      await emit(
        req.emitNames.done,
        req.buildDonePayload(req, result, durationMs, delivered),
      )
    } catch (emitErr) {
      this.logger.error(
        `agent-work[${req.metadata.source}]: emit done event failed:`,
        emitErr,
      )
    }

    return { outcome: 'delivered', durationMs }
  }

  private async emitSkip(
    req: AgentWorkRequest,
    skip: AgentWorkSkip,
    emit: AgentWorkEmitFn,
  ): Promise<void> {
    if (!req.emitNames.skip) {
      // Programming error — caller declared a gate that can return skip
      // but didn't declare a skip event name. Log and silently drop.
      this.logger.warn(
        `agent-work[${req.metadata.source}]: skip='${skip.reason}' but no emitNames.skip configured — suppressing`,
      )
      return
    }
    const payload = req.buildSkipPayload?.(req, skip) ?? skip.payload
    try {
      await emit(req.emitNames.skip, payload)
    } catch (emitErr) {
      this.logger.error(
        `agent-work[${req.metadata.source}]: emit skip event failed:`,
        emitErr,
      )
    }
  }
}
