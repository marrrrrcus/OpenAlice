/**
 * ConnectorCenter — centralized management of outbound message delivery.
 *
 * Owns connector registration, interaction tracking, delivery targeting,
 * and outbound notification sending. Heartbeat, cron, and other callers
 * use `notify()` / `broadcast()` without knowing which connector is chosen.
 *
 * Design: single-tenant, multi-channel. One user, potentially reachable via
 * multiple connectors. Default send target follows the "last" strategy —
 * replies go to whichever channel the user most recently interacted through.
 */

import type { AppendOpts, EventLog, EventLogEntry } from './event-log.js'
import type { MediaAttachment } from './types.js'
import type { Connector } from '../connectors/types.js'
import type { Listener } from './listener.js'
import type { ListenerRegistry } from './listener-registry.js'
import type { ProducerHandle } from './producer.js'
import type { MessageReceivedPayload, MessageSentPayload } from './agent-event.js'
import type { INotificationsStore, NotificationEntry, NotificationSource, NotificationPriority } from './notifications-store.js'

export type { Connector, SendPayload, SendResult, ConnectorCapabilities } from '../connectors/types.js'

// ==================== Notify Types ====================

/**
 * Options for notify(). `kind` from the old shape is gone — every notify
 * call now feeds the notifications store, which is the canonical record.
 * Connectors decide how to surface its `onAppended` events for their
 * transport (Web → bell + panel; Telegram → inline if user is active +
 * /notifications command; Mobile → OS push).
 */
export interface NotifyOpts {
  media?: MediaAttachment[]
  source?: NotificationSource
  /** Delivery urgency. 'high' tells push-capable connectors to surface
   *  proactively even when they're not the last-interacted channel. */
  priority?: NotificationPriority
}

// ==================== Interaction Tracking ====================

export interface LastInteraction {
  channel: string
  to: string
  ts: number
}

// ==================== ConnectorCenter ====================

export interface ConnectorCenterOpts {
  eventLog?: EventLog
  listenerRegistry?: ListenerRegistry
  /**
   * The canonical notifications store. `notify()` appends to it; connectors
   * subscribe to its `onAppended` event for their own surfacing strategy.
   * When omitted, `notify()` throws — calling code that produces
   * notifications must run with a store wired up.
   */
  notificationsStore?: INotificationsStore
}

export class ConnectorCenter {
  private connectors = new Map<string, Connector>()
  private lastInteraction: LastInteraction | null = null
  private listenerRegistry: ListenerRegistry | null = null
  /** Shared producer for `message.received` / `message.sent` across every
   *  connector. Declared once on construction when a registry is available;
   *  null when ConnectorCenter runs without a registry (legacy test setup). */
  private producer: ProducerHandle<readonly ['message.received', 'message.sent']> | null = null
  /** Name under which the interaction-tracking listener was registered, so
   *  `stop()` can unregister it symmetrically. */
  private interactionListenerName: string | null = null
  /** Canonical notifications store. notify() appends here. */
  private notificationsStore: INotificationsStore | null = null

  constructor(opts?: ConnectorCenterOpts | EventLog) {
    // Backward-compat: accept bare EventLog for tests that pre-date the options shape
    const resolved: ConnectorCenterOpts =
      opts && typeof (opts as EventLog).subscribeType === 'function'
        ? { eventLog: opts as EventLog }
        : (opts as ConnectorCenterOpts | undefined) ?? {}

    const { eventLog, listenerRegistry, notificationsStore } = resolved
    this.notificationsStore = notificationsStore ?? null

    // Restore last interaction from event log buffer (survives restart)
    if (eventLog) {
      const recent = eventLog.recent({ type: 'message.received' })
      if (recent.length > 0) {
        const last = recent[recent.length - 1]
        const { channel, to } = last.payload as { channel: string; to: string }
        this.lastInteraction = { channel, to, ts: last.ts }
      }
    }

    // Register interaction-tracking listener + declare the shared message
    // producer. Both require a registry; when absent (legacy test doubles)
    // ConnectorCenter still works for delivery but can't emit messaging
    // events — callers that try hit a loud error from emitMessageReceived /
    // emitMessageSent rather than silently dropping.
    if (listenerRegistry) {
      this.listenerRegistry = listenerRegistry

      const listener: Listener<'message.received'> = {
        name: 'connector-interaction-tracker',
        subscribes: 'message.received',
        handle: async (entry) => {
          this.touch(entry.payload.channel, entry.payload.to)
        },
      }
      listenerRegistry.register(listener)
      this.interactionListenerName = listener.name

      this.producer = listenerRegistry.declareProducer({
        name: 'connectors',
        emits: ['message.received', 'message.sent'] as const,
      })
    }
  }

  /** Register a Connector instance. Replaces any existing registration for this channel. */
  register(connector: Connector): () => void {
    this.connectors.set(connector.channel, connector)
    return () => { this.connectors.delete(connector.channel) }
  }

  /** Emit a `message.received` event on behalf of any connector. The
   *  payload's `channel` field carries source attribution (`'web'`,
   *  `'telegram'`, etc.). Throws if the center was constructed without
   *  a ListenerRegistry — emitting messages without a bus is a bug. */
  async emitMessageReceived(
    payload: MessageReceivedPayload,
    opts?: AppendOpts,
  ): Promise<EventLogEntry<MessageReceivedPayload>> {
    if (!this.producer) {
      throw new Error(
        'ConnectorCenter: cannot emit message.received — no ListenerRegistry was supplied at construction',
      )
    }
    return this.producer.emit('message.received', payload, opts)
  }

  /** Emit a `message.sent` event on behalf of any connector. See
   *  {@link emitMessageReceived} for the `listenerRegistry` requirement. */
  async emitMessageSent(
    payload: MessageSentPayload,
    opts?: AppendOpts,
  ): Promise<EventLogEntry<MessageSentPayload>> {
    if (!this.producer) {
      throw new Error(
        'ConnectorCenter: cannot emit message.sent — no ListenerRegistry was supplied at construction',
      )
    }
    return this.producer.emit('message.sent', payload, opts)
  }

  /** Tear down registry-held resources: dispose the shared producer and
   *  unregister the interaction-tracking listener. Safe to call on a
   *  registry-less center (no-op). Call before `listenerRegistry.stop()`
   *  during shutdown. */
  stop(): void {
    this.producer?.dispose()
    this.producer = null
    if (this.interactionListenerName && this.listenerRegistry) {
      this.listenerRegistry.unregister(this.interactionListenerName)
      this.interactionListenerName = null
    }
  }

  /** Record that the user just interacted via this channel. */
  private touch(channel: string, to: string): void {
    this.lastInteraction = { channel, to, ts: Date.now() }
  }

  /** Get the last interaction info (channel + recipient). */
  getLastInteraction(): LastInteraction | null {
    return this.lastInteraction
  }

  /** Get a specific connector by channel name. */
  get(channel: string): Connector | null {
    return this.connectors.get(channel) ?? null
  }

  /** List all registered connectors. */
  list(): Connector[] {
    return [...this.connectors.values()]
  }

  /** Check if any connectors are registered. */
  hasConnectors(): boolean {
    return this.connectors.size > 0
  }

  /**
   * Append a notification to the canonical store. Connectors subscribe to
   * the store's `onAppended` event and decide how to surface it for their
   * transport — ConnectorCenter itself does no routing here.
   *
   * Throws when constructed without a `notificationsStore` (every
   * production path passes one; absence is a wiring bug, not a soft
   * failure).
   */
  async notify(text: string, opts?: NotifyOpts): Promise<NotificationEntry> {
    if (!this.notificationsStore) {
      throw new Error(
        'ConnectorCenter: notify() called without a notificationsStore in opts',
      )
    }
    return this.notificationsStore.append({
      text,
      source: opts?.source,
      media: opts?.media,
      priority: opts?.priority,
    })
  }
}
