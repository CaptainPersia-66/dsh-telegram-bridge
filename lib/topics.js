/**
 * Forum-topic naming helpers shared by the command router and the notification
 * path. Topic names are derived from the Session title, optionally prefixed and
 * truncated, and can be overridden with `/topic rename`.
 */

/**
 * Derive the topic name for a Session status.
 *
 * @param {{ title?: string | null, id?: string | null }} status
 * @param {{ titlePrefix?: string, titleChars?: number }} options
 * @returns {string}
 */
export function topicNameForStatus(status, options = {}) {
  const title = typeof status?.title === 'string' && status.title.trim() !== ''
    ? status.title.trim()
    : String(status?.id ?? 'Session')
  const prefix = typeof options.titlePrefix === 'string' ? options.titlePrefix : ''
  const max = Number.isSafeInteger(Number(options.titleChars)) && Number(options.titleChars) >= 8
    ? Number(options.titleChars)
    : 48
  const raw = `${prefix}${title}`
  if (raw.length <= max) return raw.trim() || 'Session'
  return `${raw.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Validate and normalize a topic name for editForumTopic.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeTopicName(name) {
  const trimmed = String(name ?? '').trim()
  if (trimmed === '') throw new Error('Topic name must not be empty')
  return trimmed.slice(0, 128)
}
