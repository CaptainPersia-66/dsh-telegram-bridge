/**
 * Configuration resolution for the Telegram bridge.
 *
 * The bundle receives the raw `config` object from the profile patch. This
 * module applies defaults, validates each knob, and reports every fallback as a
 * warning instead of failing activation: a typo in one field must not take the
 * whole bridge down while the operator cannot reach DSH any other way.
 */

/** @typedef {'auto' | 'telegram' | 'notify' | 'off'} InteractionMode */

const INTERACTION_MODES = new Set(['auto', 'telegram', 'notify', 'off'])
const NOTIFY_MODES = new Set(['current', 'all'])

const DEFAULT_API_BASE = 'https://api.telegram.org'
const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'

/**
 * @typedef {object} ResolvedConfig
 * @property {string} tokenRef
 * @property {string | null} botToken
 * @property {string} apiBaseUrl
 * @property {string[]} allowedChatIds
 * @property {string[]} allowedUserIds
 * @property {boolean} dropPendingUpdates
 * @property {{ timeoutSeconds: number, backoffMinMs: number, backoffMaxMs: number }} poll
 * @property {object} notifications
 * @property {{ mode: InteractionMode, timeoutMs: number }} approvals
 * @property {{ mode: InteractionMode, timeoutMs: number }} questions
 * @property {object} limits
 * @property {{ notice: boolean, cooldownMs: number }} pairing
 * @property {{ includeUrl: boolean }} web
 * @property {string[]} warnings
 */

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function objectOrEmpty(value) {
  return isPlainObject(value) ? value : {}
}

/**
 * Accept an array of ids or a comma/space separated string.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeIdList(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const out = []
  for (const item of items) {
    const text = String(item ?? '').trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min: number, max: number, name: string, warnings: string[] }} bounds
 */
function integerInRange(value, fallback, bounds) {
  if (value === undefined || value === null) return fallback
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < bounds.min || number > bounds.max) {
    bounds.warnings.push(`${bounds.name} must be an integer in [${bounds.min}, ${bounds.max}]; using ${fallback}`)
    return fallback
  }
  return number
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
function booleanOr(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'on' || value === 1) return true
  if (value === 'false' || value === 'off' || value === 0) return false
  return fallback
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'])

/**
 * Normalize the deliverable extension allow-list. Accepts either an array of
 * extensions (kind is inferred) or an explicit `{ext: kind}` map.
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeExtensionMap(value) {
  /** @type {Record<string, string>} */
  const map = {}
  if (Array.isArray(value)) {
    for (const raw of value) {
      const extension = String(raw ?? '').trim().toLowerCase().replace(/^\./, '')
      if (extension === '') continue
      map[extension] = IMAGE_EXTENSIONS.has(extension)
        ? 'image'
        : VIDEO_EXTENSIONS.has(extension)
          ? 'video'
          : AUDIO_EXTENSIONS.has(extension)
            ? 'audio'
            : 'document'
    }
    return map
  }
  if (isPlainObject(value)) {
    for (const [rawExtension, rawKind] of Object.entries(value)) {
      const extension = String(rawExtension ?? '').trim().toLowerCase().replace(/^\./, '')
      const kind = String(rawKind ?? '').trim().toLowerCase()
      if (extension !== '' && kind !== '') map[extension] = kind
    }
  }
  return map
}

/**
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @param {string} fallback
 * @param {string} name
 * @param {string[]} warnings
 */
function modeOr(value, allowed, fallback, name, warnings) {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).toLowerCase()
  if (allowed.has(text)) return text
  warnings.push(`${name} must be one of ${[...allowed].join(', ')}; using ${fallback}`)
  return fallback
}

/**
 * Resolve the row config into a complete, validated settings object.
 * @param {unknown} raw
 * @returns {ResolvedConfig}
 */
export function resolveConfig(raw) {
  /** @type {string[]} */
  const warnings = []
  const input = objectOrEmpty(raw)
  const poll = objectOrEmpty(input.poll)
  const notifications = objectOrEmpty(input.notifications)
  const approvals = objectOrEmpty(input.approvals)
  const questions = objectOrEmpty(input.questions)
  const limits = objectOrEmpty(input.limits)
  const pairing = objectOrEmpty(input.pairing)
  const web = objectOrEmpty(input.web)
  const voice = objectOrEmpty(input.voice)
  const deliverables = objectOrEmpty(input.deliverables)
  const sessionList = objectOrEmpty(input.sessions)
  const topics = objectOrEmpty(input.topics)

  let apiBaseUrl = typeof input.apiBaseUrl === 'string' && input.apiBaseUrl.trim() !== '' ? input.apiBaseUrl.trim() : DEFAULT_API_BASE
  if (!/^https?:\/\//i.test(apiBaseUrl)) {
    warnings.push(`apiBaseUrl must start with http:// or https://; using ${DEFAULT_API_BASE}`)
    apiBaseUrl = DEFAULT_API_BASE
  }
  apiBaseUrl = apiBaseUrl.replace(/\/+$/, '')

  const tokenRef = typeof input.tokenRef === 'string' && input.tokenRef.trim() !== '' ? input.tokenRef.trim() : DEFAULT_TOKEN_REF
  const botToken = typeof input.botToken === 'string' && input.botToken.trim() !== '' ? input.botToken.trim() : null

  const allowedUserIds = normalizeIdList(input.allowedUserIds)
  const configuredChats = normalizeIdList(input.allowedChatIds)
  // A user id in a private chat equals its chat id, so accept either list for
  // the common single-operator setup.
  for (const userId of allowedUserIds) if (!configuredChats.includes(userId)) configuredChats.push(userId)

  return {
    tokenRef,
    botToken,
    apiBaseUrl,
    // Advanced: override the durable chat-state file (tests, portable setups).
    statePath: typeof input.statePath === 'string' && input.statePath.trim() !== '' ? input.statePath.trim() : null,
    allowedChatIds: configuredChats,
    allowedUserIds,
    dropPendingUpdates: booleanOr(input.dropPendingUpdates, true),
    poll: {
      timeoutSeconds: integerInRange(poll.timeoutSeconds, 25, { min: 0, max: 50, name: 'poll.timeoutSeconds', warnings }),
      backoffMinMs: integerInRange(poll.backoffMinMs, 1000, { min: 100, max: 60000, name: 'poll.backoffMinMs', warnings }),
      backoffMaxMs: integerInRange(poll.backoffMaxMs, 60000, { min: 1000, max: 600000, name: 'poll.backoffMaxMs', warnings }),
    },
    notifications: {
      enabled: booleanOr(notifications.enabled, true),
      mode: modeOr(notifications.mode, NOTIFY_MODES, 'current', 'notifications.mode', warnings),
      includeSubagents: booleanOr(notifications.includeSubagents, false),
      onTurnEnd: booleanOr(notifications.onTurnEnd, true),
      onError: booleanOr(notifications.onError, true),
      onApproval: booleanOr(notifications.onApproval, true),
      onQuestion: booleanOr(notifications.onQuestion, true),
      onSessionStart: booleanOr(notifications.onSessionStart, false),
      // 0 = deliver the complete final assistant message (split across messages
      // when needed); a positive number truncates it to that many characters.
      snippetChars: integerInRange(notifications.snippetChars, 0, { min: 0, max: 50000, name: 'notifications.snippetChars', warnings }),
    },
    approvals: {
      mode: modeOr(approvals.mode, INTERACTION_MODES, 'auto', 'approvals.mode', warnings),
      timeoutMs: integerInRange(approvals.timeoutMs, 120000, { min: 1000, max: 1800000, name: 'approvals.timeoutMs', warnings }),
    },
    questions: {
      mode: modeOr(questions.mode, INTERACTION_MODES, 'auto', 'questions.mode', warnings),
      timeoutMs: integerInRange(questions.timeoutMs, 300000, { min: 1000, max: 1800000, name: 'questions.timeoutMs', warnings }),
    },
    limits: {
      pageSize: integerInRange(limits.pageSize, 8, { min: 3, max: 20, name: 'limits.pageSize', warnings }),
      maxResultTurns: integerInRange(limits.maxResultTurns, 5, { min: 1, max: 20, name: 'limits.maxResultTurns', warnings }),
      maxTailTurns: integerInRange(limits.maxTailTurns, 20, { min: 1, max: 50, name: 'limits.maxTailTurns', warnings }),
      maxEventsPerRead: integerInRange(limits.maxEventsPerRead, 1500, { min: 100, max: 5000, name: 'limits.maxEventsPerRead', warnings }),
      sessionTitleChars: integerInRange(limits.sessionTitleChars, 48, { min: 16, max: 120, name: 'limits.sessionTitleChars', warnings }),
    },
    sessions: {
      // Subagent sessions are internal children of a top-level session; they are
      // hidden from the picker by default to keep the list focused on the work
      // the operator started. Notifications have their own switch.
      includeSubagents: booleanOr(sessionList.includeSubagents, false),
      // Archived sessions are hidden from Workspace grouping surfaces in DSH;
      // the picker mirrors that unless explicitly asked for the archive.
      includeArchived: booleanOr(sessionList.includeArchived, false),
    },
    topics: {
      // In a Telegram forum supergroup, bind one topic per Session so messages in
      // that topic always target that Session.
      enabled: booleanOr(topics.enabled, true),
      // Create a topic automatically when a Session is selected in the forum's
      // General topic (requires the bot's Manage Topics admin right).
      autoCreate: booleanOr(topics.autoCreate, true),
      // Optional fixed prefix for created topic titles.
      titlePrefix: typeof topics.titlePrefix === 'string' ? topics.titlePrefix.trim() : '',
      // Topic titles are derived from the Session title; truncate to this many
      // characters (Telegram caps names at 128).
      titleChars: integerInRange(topics.titleChars, 48, { min: 8, max: 120, name: 'topics.titleChars', warnings }),
    },
    pairing: {
      notice: booleanOr(pairing.notice, true),
      cooldownMs: integerInRange(pairing.cooldownMs, 600000, { min: 30000, max: 3600000, name: 'pairing.cooldownMs', warnings }),
    },
    web: {
      includeUrl: booleanOr(web.includeUrl, true),
    },
    voice: {
      enabled: booleanOr(voice.enabled, true),
      language: typeof voice.language === 'string' && voice.language.trim() !== '' ? voice.language.trim() : null,
      autoSend: booleanOr(voice.autoSend, true),
      maxDurationSeconds: integerInRange(voice.maxDurationSeconds, 300, { min: 5, max: 1800, name: 'voice.maxDurationSeconds', warnings }),
      maxDownloadBytes: integerInRange(voice.maxDownloadBytes, 20 * 1024 * 1024, { min: 64 * 1024, max: 50 * 1024 * 1024, name: 'voice.maxDownloadBytes', warnings }),
      // The local recognizer's default maxAudioBytes is 4 MB ≈ 131 s of 16 kHz
      // mono PCM16; keep the WAV we hand it inside that budget.
      maxWavBytes: integerInRange(voice.maxWavBytes, 4 * 1024 * 1024, { min: 46, max: 50 * 1024 * 1024, name: 'voice.maxWavBytes', warnings }),
      prepareTimeoutMs: integerInRange(voice.prepareTimeoutMs, 900000, { min: 60000, max: 3600000, name: 'voice.prepareTimeoutMs', warnings }),
      totalTimeoutMs: integerInRange(voice.totalTimeoutMs, 1200000, { min: 60000, max: 3600000, name: 'voice.totalTimeoutMs', warnings }),
      ffmpegPath: typeof voice.ffmpegPath === 'string' && voice.ffmpegPath.trim() !== '' ? voice.ffmpegPath.trim() : null,
    },
    deliverables: {
      // Forward media/documents produced by a finished turn to Telegram so they
      // can be reviewed without opening DSH. Code-only changes are never sent.
      enabled: booleanOr(deliverables.enabled, true),
      // Bot API's standard upload ceiling is 50 MB; keep headroom.
      maxBytes: integerInRange(deliverables.maxBytes, 45 * 1024 * 1024, { min: 64 * 1024, max: 48 * 1024 * 1024, name: 'deliverables.maxBytes', warnings }),
      // Empty = the built-in extension allow-list (images, video, audio, pdf/office/zip).
      extensions: normalizeExtensionMap(deliverables.extensions),
    },
    warnings,
  }
}

/**
 * Resolve the bot token without ever persisting it in the patch file.
 *
 * Order: explicit `botToken` config, the Harness credential service
 * (`tokenRef`, which itself covers the provider-managed store, the process
 * environment, and .env files), then the bare process environment.
 *
 * @param {import('@deepseek-ai/cordis').Context | any} ctx
 * @param {ResolvedConfig} config
 * @returns {Promise<{ token: string | null, source: string }>}
 */
export async function resolveBotToken(ctx, config) {
  if (config.botToken) return { token: config.botToken, source: 'config.botToken' }
  const credentials = ctx?.get?.('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(config.tokenRef)
      if (resolved && typeof resolved.value === 'string' && resolved.value !== '') {
        return { token: resolved.value, source: `credential ${config.tokenRef} (${resolved.source ?? 'provider'})` }
      }
    } catch {
      // A failing credential backend must not hide an environment fallback.
    }
  }
  const envValue = process.env[config.tokenRef]
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    return { token: envValue.trim(), source: `environment ${config.tokenRef}` }
  }
  return { token: null, source: 'missing' }
}

/**
 * Whether a token has the `<bot id>:<secret>` shape the Bot API expects.
 * Only used for diagnostics; a malformed token still reaches the API so the
 * real error is surfaced.
 * @param {string} token
 */
export function tokenLooksValid(token) {
  return /^\d{6,}:[\w-]{20,}$/.test(token)
}

/**
 * Redact anything that looks like a bot token from a diagnostic string.
 * @param {unknown} value
 */
export function redactToken(value) {
  return String(value ?? '').replace(/\d{6,}:[\w-]{20,}/g, '<redacted-bot-token>')
}

/**
 * A settings view safe to show a user: token presence only.
 * @param {ResolvedConfig} config
 * @param {{ source: string }} tokenInfo
 */
export function describeConfig(config, tokenInfo) {
  return {
    apiBaseUrl: config.apiBaseUrl,
    tokenRef: config.tokenRef,
    tokenConfigured: tokenInfo.token !== null,
    tokenSource: tokenInfo.source,
    allowedChatIds: config.allowedChatIds,
    approvalsMode: config.approvals.mode,
    questionsMode: config.questions.mode,
    notifications: config.notifications,
    limits: config.limits,
  }
}
