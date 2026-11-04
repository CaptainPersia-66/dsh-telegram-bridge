/**
 * Durable, per-chat bridge state.
 *
 * Only preferences that must survive a restart live here: the Telegram update
 * offset (so a restart does not replay old commands) and each chat's selected
 * session plus notification settings. Ephemeral caches (last rendered session
 * list, pending approvals) deliberately stay in memory: a button from a message
 * older than a restart must fail with "list expired", not target the wrong row.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_VERSION = 1

/**
 * Default state file location under the Harness home directory.
 * @returns {string}
 */
export function defaultStatePath() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = configured !== '' ? configured : join(homedir(), '.dsh')
  return join(home, 'telegram-bridge', 'state.json')
}

/** @returns {{ version: number, offset: number, chats: Record<string, any>, threads: Record<string, string> }} */
function emptyState() {
  return { version: STATE_VERSION, offset: 0, chats: {}, threads: {} }
}

/**
 * @param {unknown} value
 * @param {'current' | 'all'} [fallbackNotifyMode]
 * @returns {Record<string, any>}
 */
function normalizeChat(raw, fallbackNotifyMode = 'current') {
  const input = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  const currentSessionId = typeof input.currentSessionId === 'string' && input.currentSessionId !== '' ? input.currentSessionId : null
  const notifyMode = input.notifyMode === 'all'
    ? 'all'
    : input.notifyMode === 'current'
      ? 'current'
      : fallbackNotifyMode === 'all' ? 'all' : 'current'
  return {
    currentSessionId,
    notifications: input.notifications !== false,
    notifyMode,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
  }
}

export class BridgeState {
  /**
   * @param {{ filePath?: string, logger?: { warn: Function, info?: Function }, saveDebounceMs?: number,
   *           defaultNotifyMode?: 'current' | 'all' }} options
   */
  constructor(options = {}) {
    this.filePath = options.filePath ?? defaultStatePath()
    this.logger = options.logger ?? console
    this.saveDebounceMs = options.saveDebounceMs ?? 500
    /** Default notification scope for chats seen for the first time. */
    this.defaultNotifyMode = options.defaultNotifyMode === 'all' ? 'all' : 'current'
    /** @type {{ version: number, offset: number, chats: Record<string, any> }} */
    this.data = emptyState()
    this.loaded = false
    this.readOnly = false
    this._saveTimer = null
    this._saving = null
    this._saveQueued = false
    this._closed = false
    /** @type {Map<string, number>} chat id -> last pairing notice timestamp (memory only) */
    this._pairingNotices = new Map()
  }

  /**
   * Load the file, tolerating absence and corruption.
   * @returns {Promise<void>}
   */
  async load() {
    if (this.loaded) return
    this.loaded = true
    let text
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'EISDIR')) return
      this.logger.warn(`telegram-bridge: state file unreadable (${error?.message ?? error}); continuing with memory state`)
      this.readOnly = true
      return
    }
    try {
      const parsed = JSON.parse(text)
      const chats = {}
      if (parsed && typeof parsed.chats === 'object' && parsed.chats !== null) {
        for (const [chatId, value] of Object.entries(parsed.chats)) chats[String(chatId)] = normalizeChat(value, this.defaultNotifyMode)
      }
      const offset = Number.isSafeInteger(parsed?.offset) && parsed.offset >= 0 ? parsed.offset : 0
      // Durable topic bindings: `<chatId>:<message_thread_id>` -> session id.
      const threads = {}
      if (parsed && typeof parsed.threads === 'object' && parsed.threads !== null) {
        for (const [key, value] of Object.entries(parsed.threads)) {
          if (typeof value === 'string' && value !== '' && String(key).includes(':')) threads[String(key)] = value
        }
      }
      this.data = { version: STATE_VERSION, offset, chats, threads }
    } catch (error) {
      this.logger.warn(`telegram-bridge: state file is corrupt (${error?.message ?? error}); starting fresh`)
      await this._quarantineCorruptFile()
    }
  }

  async _quarantineCorruptFile() {
    try {
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      await rename(this.filePath, backup)
      this.logger.warn(`telegram-bridge: moved corrupt state file to ${backup}`)
    } catch {
      this.readOnly = true
    }
  }

  /**
   * Durable chat preferences, created on first access.
   * @param {string | number} chatId
   */
  getChat(chatId) {
    const key = String(chatId)
    let chat = this.data.chats[key]
    if (chat === undefined) {
      chat = normalizeChat({}, this.defaultNotifyMode)
      this.data.chats[key] = chat
    }
    return chat
  }

  /** @param {string | number} chatId */
  getCurrentSession(chatId) {
    return this.getChat(chatId).currentSessionId
  }

  /**
   * @param {string | number} chatId
   * @param {string | null} sessionId
   */
  setCurrentSession(chatId, sessionId) {
    const chat = this.getChat(chatId)
    const next = sessionId === undefined || sessionId === null ? null : String(sessionId)
    if (chat.currentSessionId === next) return
    chat.currentSessionId = next
    chat.updatedAt = Date.now()
    this.scheduleSave()
  }

  /** @param {string | number} chatId @param {number | string} threadId */
  threadKey(chatId, threadId) {
    return `${String(chatId)}:${Number(threadId)}`
  }

  /**
   * Session bound to one forum topic, if any.
   * @param {string | number} chatId
   * @param {number | string} threadId
   * @returns {string | null}
   */
  getThreadSession(chatId, threadId) {
    const value = this.data.threads[this.threadKey(chatId, threadId)]
    return typeof value === 'string' && value !== '' ? value : null
  }

  /**
   * @param {string | number} chatId
   * @param {number | string} threadId
   * @param {string} sessionId
   */
  setThreadSession(chatId, threadId, sessionId) {
    const key = this.threadKey(chatId, threadId)
    const next = String(sessionId)
    if (this.data.threads[key] === next) return
    this.data.threads[key] = next
    this.scheduleSave()
  }

  /** @param {string | number} chatId @param {number | string} threadId */
  clearThreadSession(chatId, threadId) {
    const key = this.threadKey(chatId, threadId)
    if (!(key in this.data.threads)) return
    delete this.data.threads[key]
    this.scheduleSave()
  }

  /**
   * First topic bound to a session (used to route notifications).
   * @param {string} sessionId
   * @returns {{ chatId: string, threadId: number } | null}
   */
  findThreadForSession(sessionId) {
    for (const [key, value] of Object.entries(this.data.threads)) {
      if (value !== sessionId) continue
      const split = key.lastIndexOf(':')
      if (split <= 0) continue
      const threadId = Number(key.slice(split + 1))
      if (!Number.isSafeInteger(threadId) || threadId <= 0) continue
      return { chatId: key.slice(0, split), threadId }
    }
    return null
  }

  /**
   * Every topic bound in one chat.
   * @param {string | number} chatId
   * @returns {Record<string, number>} session id -> thread id
   */
  listThreadSessions(chatId) {
    const prefix = `${String(chatId)}:`
    /** @type {Record<string, number>} */
    const bound = {}
    for (const [key, sessionId] of Object.entries(this.data.threads)) {
      if (!key.startsWith(prefix)) continue
      const threadId = Number(key.slice(prefix.length))
      if (Number.isSafeInteger(threadId) && threadId > 0) bound[sessionId] = threadId
    }
    return bound
  }

  /**
   * @param {string | number} chatId
   * @param {boolean} enabled
   */
  setNotifications(chatId, enabled) {
    const chat = this.getChat(chatId)
    const next = Boolean(enabled)
    if (chat.notifications === next) return
    chat.notifications = next
    chat.updatedAt = Date.now()
    this.scheduleSave()
  }

  /**
   * @param {string | number} chatId
   * @param {'current' | 'all'} mode
   */
  setNotifyMode(chatId, mode) {
    const chat = this.getChat(chatId)
    const next = mode === 'all' ? 'all' : 'current'
    if (chat.notifyMode === next) return
    chat.notifyMode = next
    chat.notifications = true
    chat.updatedAt = Date.now()
    this.scheduleSave()
  }

  getOffset() {
    return this.data.offset
  }

  /** @param {number} offset */
  setOffset(offset) {
    const next = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    if (this.data.offset === next) return
    this.data.offset = next
    // The update offset is written on every delivered update; debounce it like
    // any other preference so a burst of commands costs one write.
    this.scheduleSave()
  }

  /**
   * Whether a pairing notice may be sent to this chat now.
   * @param {string | number} chatId
   * @param {number} cooldownMs
   */
  pairingNoticeAllowed(chatId, cooldownMs) {
    const key = String(chatId)
    const now = Date.now()
    const last = this._pairingNotices.get(key) ?? 0
    if (now - last < cooldownMs) return false
    this._pairingNotices.set(key, now)
    if (this._pairingNotices.size > 200) {
      for (const [id, at] of this._pairingNotices) if (now - at > cooldownMs) this._pairingNotices.delete(id)
    }
    return true
  }

  /** @returns {string[]} chat ids that have interacted with the bridge */
  knownChatIds() {
    return Object.keys(this.data.chats)
  }

  scheduleSave() {
    if (this._closed || this.readOnly) return
    if (this._saveTimer !== null) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      this.flush().catch((error) => this.logger.warn(`telegram-bridge: state save failed (${error?.message ?? error})`))
    }, this.saveDebounceMs)
  }

  /**
   * Write the current state atomically (tmp + rename), coalescing concurrent
   * requests: while a write runs, another request sets a queued flag instead of
   * stacking microtasks.
   * @returns {Promise<void>}
   */
  async flush() {
    if (this._closed || this.readOnly) return
    if (this._saving !== null) {
      this._saveQueued = true
      return this._saving
    }
    const write = async () => {
      const payload = JSON.stringify(this.data)
      const tmp = `${this.filePath}.${process.pid}.tmp`
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.filePath)
    }
    this._saving = write().catch((error) => {
      // Keep memory state usable but stop retrying disk writes that keep failing.
      this.readOnly = true
      throw error
    }).finally(() => {
      this._saving = null
      if (this._saveQueued) {
        this._saveQueued = false
        this.flush().catch(() => {})
      }
    })
    return this._saving
  }

  async close() {
    if (this._closed) return
    this._closed = true
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    try {
      await this.flush()
    } catch {
      // close() must not throw during plugin teardown
    }
  }
}
