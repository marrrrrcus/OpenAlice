import type { Message } from 'grammy/types'
import type { ParsedMessage, MediaRef } from './types.js'
import type { NotificationPriority } from '../../core/notifications-store.js'

/**
 * Decide whether a store notification should be pushed into the Telegram
 * thread. Normal-priority notifications inline only when Telegram is the
 * last-interacted channel (avoid pinging an idle channel); high-priority
 * notifications — monitoring alerts — push regardless, since the point of
 * an alert is to reach the user precisely when they're NOT watching.
 */
export function shouldSurfaceToTelegram(
  priority: NotificationPriority | undefined,
  lastInteractedChannel: string | undefined,
): boolean {
  if (priority === 'high') return true
  return lastInteractedChannel === 'telegram'
}

export function extractMedia(msg: Message): MediaRef[] {
  const media: MediaRef[] = []

  if (msg.photo) {
    // Telegram sends multiple sizes; pick the largest
    const largest = msg.photo.reduce((a, b) =>
      (a.width ?? 0) * (a.height ?? 0) >= (b.width ?? 0) * (b.height ?? 0) ? a : b,
    )
    media.push({
      type: 'photo',
      fileId: largest.file_id,
      width: largest.width,
      height: largest.height,
    })
  }

  if (msg.animation) {
    media.push({
      type: 'animation',
      fileId: msg.animation.file_id,
      fileName: msg.animation.file_name,
      mimeType: msg.animation.mime_type,
      width: msg.animation.width,
      height: msg.animation.height,
    })
  } else if (msg.document) {
    // Only add document if there's no animation (Telegram sends both for GIFs)
    media.push({
      type: 'document',
      fileId: msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
    })
  }

  if (msg.voice) {
    media.push({
      type: 'voice',
      fileId: msg.voice.file_id,
      mimeType: msg.voice.mime_type,
    })
  }

  if (msg.video) {
    media.push({
      type: 'video',
      fileId: msg.video.file_id,
      fileName: msg.video.file_name,
      mimeType: msg.video.mime_type,
      width: msg.video.width,
      height: msg.video.height,
    })
  }

  if (msg.video_note) {
    media.push({
      type: 'video_note',
      fileId: msg.video_note.file_id,
    })
  }

  if (msg.audio) {
    media.push({
      type: 'audio',
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
    })
  }

  if (msg.sticker) {
    media.push({
      type: 'sticker',
      fileId: msg.sticker.file_id,
      width: msg.sticker.width,
      height: msg.sticker.height,
    })
  }

  return media
}

/** Build a ParsedMessage from a grammY Message. */
export function buildParsedMessage(
  msg: Message,
  command?: string,
  commandArgs?: string,
): ParsedMessage {
  const text = msg.text ?? msg.caption ?? ''
  const from = msg.from

  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    from: {
      id: from?.id ?? 0,
      firstName: from?.first_name ?? '',
      username: from?.username,
    },
    date: new Date(msg.date * 1000),
    text,
    command,
    commandArgs,
    media: extractMedia(msg),
    mediaGroupId: msg.media_group_id,
    raw: msg,
  }
}
