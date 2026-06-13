import { fetchJson } from './client'

// Keep in sync with the backend union in src/core/notifications-store.ts.
export type NotificationSource = 'heartbeat' | 'cron' | 'manual' | 'task' | 'market-report' | 'account-report' | 'news-alert'

export interface NotificationEntry {
  id: string
  ts: number
  text: string
  source?: NotificationSource
  media?: Array<{ type: string; url?: string; path?: string }>
}

export interface NotificationsHistoryResponse {
  entries: NotificationEntry[]
  hasMore: boolean
}

export const notificationsApi = {
  async history(opts: { limit?: number; before?: string; source?: NotificationSource } = {}): Promise<NotificationsHistoryResponse> {
    const qs = new URLSearchParams()
    if (opts.limit != null) qs.set('limit', String(opts.limit))
    if (opts.before) qs.set('before', opts.before)
    if (opts.source) qs.set('source', opts.source)
    return fetchJson(`/api/notifications/history?${qs}`)
  },
}
