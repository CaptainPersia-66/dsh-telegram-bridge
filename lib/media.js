/**
 * Deliverable/media forwarding: send the files a finished turn produced to
 * Telegram so they can be reviewed without opening DSH.
 *
 * Two sources are considered:
 *  - model-attached images/files on the final assistant message, when the Host
 *    attachments provider exposes a Host path;
 *  - changed workspace files from the turn's `workspace/changes` summary whose
 *    extension marks them as media or a reviewable document.
 *
 * Unrelated code changes are never uploaded. Oversized files are skipped and
 * reported instead of failing the whole notification.
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, basename } from 'node:path'

import { formatBytes } from './voice.js'

/** Extensions forwarded by default, grouped by the Bot API method to use. */
const DEFAULT_EXTENSIONS = {
  // photos (inline preview; large photos fall back to documents)
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'animation-or-document',
  // videos
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mkv: 'video',
  // audio
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  flac: 'audio',
  aac: 'audio',
  // reviewable documents
  pdf: 'document',
  docx: 'document',
  pptx: 'document',
  xlsx: 'document',
  csv: 'document',
  zip: 'document',
}

/** Bot API methods and form fields for each media kind. */
const KIND_DELIVERY = {
  image: { method: 'sendPhoto', field: 'photo' },
  'animation-or-document': { method: 'sendDocument', field: 'document' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
  document: { method: 'sendDocument', field: 'document' },
}

/** Photo uploads above this size are rejected by Telegram; send those as documents. */
const PHOTO_INLINE_MAX_BYTES = 9 * 1024 * 1024

/** @param {string} name */
function extensionOf(name) {
  return extname(String(name ?? '')).replace(/^\./, '').toLowerCase()
}

/**
 * Resolve an extension to its delivery kind.
 * @param {string} extension
 * @param {Record<string, string>} map
 */
function kindOf(extension, map) {
  return map[extension] ?? null
}

/**
 * Build the list of files a turn produced that are worth forwarding.
 *
 * @param {any} turn bridge TurnView (has `attachments` and `changes`)
 * @param {{ cwd?: string | null, maxBytes?: number, extensions?: Record<string, string> }} [options]
 * @returns {{ files: Array<{ name: string, path: string, kind: string, sizeHint: number | null }>, skipped: Array<{ name: string, reason: string }> }}
 */
export function planTurnMedia(turn, options = {}) {
  const extensions = options.extensions && Object.keys(options.extensions).length > 0
    ? options.extensions
    : DEFAULT_EXTENSIONS
  const seen = new Set()
  const files = []
  const skipped = []

  // Model-attached files first: they are explicit deliverables.
  for (const attachment of Array.isArray(turn?.attachments) ? turn.attachments : []) {
    const path = typeof attachment?.hostPath === 'string' ? attachment.hostPath : ''
    if (path === '') continue
    const name = String(attachment?.name ?? 'attachment')
    const extension = extensionOf(name) || extensionOf(path)
    const kind = attachment.kind === 'image' ? 'image' : kindOf(extension, extensions)
    if (!kind) {
      skipped.push({ name, reason: 'unsupported-type' })
      continue
    }
    if (seen.has(path)) continue
    seen.add(path)
    files.push({
      name,
      path,
      kind,
      sizeHint: Number.isFinite(Number(attachment?.bytes)) ? Number(attachment.bytes) : null,
      description: null,
    })
  }

  // Explicit `present` declarations: the user asked for these files, so forward
  // them regardless of the extension allow-list (unknown types become documents).
  for (const delivered of Array.isArray(turn?.deliverables) ? turn.deliverables : []) {
    const path = typeof delivered?.path === 'string' ? delivered.path : ''
    if (path === '') continue
    if (seen.has(path)) continue
    seen.add(path)
    const name = basename(path)
    const extension = extensionOf(name)
    const kind = kindOf(extension, DEFAULT_EXTENSIONS) ?? 'document'
    files.push({
      name,
      path,
      kind,
      sizeHint: null,
      description: typeof delivered?.description === 'string' && delivered.description.trim() !== ''
        ? delivered.description.trim()
        : null,
    })
  }

  // Then media/document files the turn changed in the workspace.
  const changeFiles = Array.isArray(turn?.changes?.files) ? turn.changes.files : []
  for (const changed of changeFiles) {
    const rawPath = typeof changed?.path === 'string' ? changed.path : ''
    const display = typeof changed?.display === 'string' ? changed.display : rawPath
    const name = display.split(/[\\/]/).pop() || rawPath
    const extension = extensionOf(name) || extensionOf(rawPath)
    const kind = kindOf(extension, extensions)
    if (!kind) continue
    const path = isAbsolute(rawPath) ? rawPath : join(String(options.cwd ?? ''), rawPath)
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    files.push({ name, path, kind, sizeHint: null })
  }

  return { files, skipped }
}

/**
 * Read and upload the turn's media to one chat.
 *
 * @param {object} deps
 * @param {any} deps.api TelegramApi
 * @param {string|number} deps.chatId
 * @param {number | null} [deps.threadId] forum topic to upload into
 * @param {any} deps.turn bridge TurnView
 * @param {string | null | undefined} deps.cwd session working directory
 * @param {import('./config.js').ResolvedConfig} deps.config
 * @param {{ warn?: Function, info?: Function }} deps.log
 * @returns {Promise<{ sent: number, skipped: Array<{ name: string, reason: string }> }>}
 */
export async function sendTurnMedia(deps) {
  const { api, chatId, threadId = null, turn, cwd, config, log } = deps
  const options = config.deliverables
  if (!options || options.enabled === false) return { sent: 0, skipped: [] }
  if (!api) return { sent: 0, skipped: [] }
  const plan = planTurnMedia(turn, {
    cwd,
    maxBytes: options.maxBytes,
    extensions: options.extensions,
  })
  const skipped = [...plan.skipped]
  let sent = 0
  for (const file of plan.files) {
    try {
      const info = await stat(file.path)
      if (!info.isFile()) {
        skipped.push({ name: file.name, reason: 'not-a-file' })
        continue
      }
      if (info.size > options.maxBytes) {
        skipped.push({ name: file.name, reason: `too-large (${formatBytes(info.size)})` })
        continue
      }
      const bytes = new Uint8Array(await readFile(file.path))
      const delivery = KIND_DELIVERY[file.kind] ?? KIND_DELIVERY.document
      const isPhoto = file.kind === 'image'
      const oversizedPhoto = isPhoto && info.size > PHOTO_INLINE_MAX_BYTES
      await api.sendFile({
        chatId,
        messageThreadId: Number.isSafeInteger(Number(threadId)) && Number(threadId) > 1 ? Number(threadId) : undefined,
        method: oversizedPhoto ? 'sendDocument' : delivery.method,
        field: oversizedPhoto ? 'document' : delivery.field,
        filename: file.name,
        bytes,
        mimeType: null,
        caption: [file.name, formatBytes(info.size), file.description ? file.description.slice(0, 200) : null]
          .filter(Boolean)
          .join(' · '),
      })
      sent += 1
    } catch (error) {
      log?.warn?.(`telegram-bridge: could not forward ${file.name} (${error?.message ?? error})`)
      skipped.push({ name: file.name, reason: 'send-failed' })
    }
  }
  return { sent, skipped }
}

/** Human-readable note about files that were not forwarded. */
export function describeSkippedMedia(skipped) {
  if (!Array.isArray(skipped) || skipped.length === 0) return ''
  const names = skipped.slice(0, 3).map((item) => `${item.name} (${item.reason})`).join(', ')
  const more = skipped.length > 3 ? ` +${skipped.length - 3} more` : ''
  return `📎 Not forwarded: ${names}${more}`
}

export { DEFAULT_EXTENSIONS }
