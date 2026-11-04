/**
 * Telegram update router: authorization, command parsing, and the button
 * actions attached to rendered messages.
 *
 * The router owns no DSH resources. Every entry point catches its own failures
 * and answers the user with a short, escaped diagnostic: one bad command must
 * never leave the chat or the poll loop wedged.
 */

import { isAbsolute } from 'node:path'
import { escapeHtml, formatDuration } from './format.js'
import { describeSkippedMedia, sendTurnMedia } from './media.js'
import { markTelegramText } from './prompt.js'
import { normalizeTopicName, topicNameForStatus } from './topics.js'
import { describeVoiceProgress } from './voice.js'
import * as views from './views.js'

/** @param {string} value */
function esc(value) {
  return escapeHtml(value)
}

/** @param {any} status */
function sessionTitle(status) {
  const title = typeof status?.title === 'string' && status.title.trim() !== '' ? status.title.trim() : ''
  if (title !== '') return title
  const id = String(status?.id ?? '')
  return id === '' ? 'session' : `session ${id.slice(0, 12)}…`
}

/** @param {string} value */
function clip(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * @param {object} deps
 * @param {import('./config.js').ResolvedConfig} deps.config
 * @param {() => any} deps.apiProvider
 * @param {any} deps.bridge
 * @param {import('./state.js').BridgeState} deps.state
 * @param {ReturnType<import('./interactions.js').createInteractions>} deps.interactions
 * @param {ReturnType<import('./voice.js').createVoice>} [deps.voice]
 * @param {{ info?: Function, warn?: Function, error?: Function }} deps.log
 * @param {() => object | null} [deps.describe]
 */
export function createRouter(deps) {
  const { config, bridge, state, interactions, log } = deps
  /** @type {Map<string, { sessions: any[], page: number, at: number }>} */
  const lists = new Map()
  /**
   * Reply routing: chat id -> (sent Telegram message id -> session id). A text
   * sent as a Telegram reply to one of these messages targets that session.
   * @type {Map<string, Map<number, { sessionId: string, at: number }>>}
   */
  const sessionMessages = new Map()

  const SESSION_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000
  const MAX_SESSION_MESSAGES = 300

  /**
   * @param {string | number} chatId
   * @param {number} messageId
   * @param {string} sessionId
   */
  function rememberSessionMessage(chatId, messageId, sessionId) {
    const id = Number(messageId)
    if (!Number.isSafeInteger(id) || typeof sessionId !== 'string' || sessionId === '') return
    const key = chatKey(chatId)
    let map = sessionMessages.get(key)
    if (!map) {
      map = new Map()
      sessionMessages.set(key, map)
    }
    map.set(id, { sessionId, at: Date.now() })
    if (map.size > MAX_SESSION_MESSAGES) {
      const cutoff = Date.now() - SESSION_MESSAGE_TTL_MS
      for (const [entryId, entry] of map) {
        if (entry.at < cutoff || map.size > MAX_SESSION_MESSAGES) map.delete(entryId)
      }
    }
  }

  /**
   * @param {string | number} chatId
   * @param {number} messageId
   * @returns {string | null} the session the quoted message belongs to
   */
  function findSessionMessage(chatId, messageId) {
    const map = sessionMessages.get(chatKey(chatId))
    if (!map) return null
    const id = Number(messageId)
    const entry = map.get(id)
    if (!entry) return null
    if (Date.now() - entry.at > SESSION_MESSAGE_TTL_MS) {
      map.delete(id)
      return null
    }
    return entry.sessionId
  }

  function api() {
    return deps.apiProvider()
  }

  /** @param {string | number} chatId */
  function chatKey(chatId) {
    return String(chatId)
  }

  /** Latest inbound forum topic per chat (used as the default reply target). @type {Map<string, number>} */
  const replyThreads = new Map()
  /** Chats observed as forum supergroups (General messages may omit a thread id). @type {Set<string>} */
  const forumChats = new Set()

  /** @param {any} message @returns {number} */
  function threadFromMessage(message) {
    const raw = Number(message?.message_thread_id ?? message?.reply_to_message?.message_thread_id ?? 0)
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 0
  }

  /** @param {string | number} chatId */
  function activeThread(chatId) {
    return replyThreads.get(chatKey(chatId)) ?? 0
  }

  /** @param {string | number} chatId @param {number} threadId */
  function rememberThread(chatId, threadId) {
    // General-topic messages in a forum often omit message_thread_id, so store
    // zero (chat-level) instead of keeping the previous topic as "active".
    const next = Number.isSafeInteger(threadId) && threadId > 0 ? threadId : 0
    replyThreads.set(chatKey(chatId), next)
  }

  /**
   * Session bound to the topic this chat is currently answering in.
   * @param {string | number} chatId
   * @returns {string | null}
   */
  function threadSession(chatId) {
    if (!config.topics.enabled) return null
    const threadId = activeThread(chatId)
    if (threadId <= 1) return null
    return state.getThreadSession(chatId, threadId)
  }

  /** @param {string | number} chatId */
  function isForumChat(chatId) {
    return forumChats.has(chatKey(chatId))
  }

  /**
   * @param {string} chatId
   * @param {views.MessagePart[]} parts
   * @param {{ sessionId?: string, threadId?: number | null }} [options]
   *   session to associate each sent message with (reply routing), and the
   *   forum topic to answer in; omitted threadId uses the latest inbound topic
   */
  async function send(chatId, parts, options = {}) {
    const client = api()
    if (!client) {
      log.warn('telegram-bridge: cannot send, Telegram client is not ready')
      return false
    }
    const hasExplicitThread = Object.prototype.hasOwnProperty.call(options, 'threadId')
    const threadId = hasExplicitThread ? Number(options.threadId) : activeThread(chatId)
    const messageThreadId = Number.isSafeInteger(threadId) && threadId > 1 ? threadId : undefined
    let ok = true
    for (const part of parts) {
      try {
        const sent = await client.sendMessage({
          chatId,
          text: part.html,
          keyboard: part.keyboard ?? null,
          messageThreadId,
        })
        if (options.sessionId) {
          const messages = Array.isArray(sent) ? sent : sent ? [sent] : []
          for (const message of messages) rememberSessionMessage(chatId, message?.message_id, options.sessionId)
        }
      } catch (error) {
        ok = false
        log.warn(`telegram-bridge: send failed (${error?.message ?? error})`)
      }
    }
    return ok
  }

  /**
   * @param {string} chatId
   * @param {string} html
   * @param {{ sessionId?: string, threadId?: number | null }} [options]
   */
  function sendSimple(chatId, html, options = {}) {
    return send(chatId, [{ html }], options)
  }

  /**
   * @param {string} chatId
   * @param {unknown} error
   */
  async function fail(chatId, error) {
    const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error ?? 'Unexpected error')
    await sendSimple(chatId, `⚠️ ${esc(message)}`)
  }

  function webUrl() {
    if (!config.web.includeUrl) return null
    try {
      return bridge.advertisedUrl() ?? null
    } catch {
      return null
    }
  }

  function isAuthorized(chatId, userId) {
    const chat = chatKey(chatId)
    const user = String(userId ?? '')
    return config.allowedChatIds.includes(chat) || (user !== '' && config.allowedUserIds.includes(user))
  }

  /** @returns {string[]} */
  function authorizedChats() {
    const ids = new Set(config.allowedChatIds)
    for (const known of state.knownChatIds()) if (isAuthorized(known, '')) ids.add(known)
    return [...ids]
  }

  /** @param {string} arg @param {number} fallback @param {number} max */
  function parseCount(arg, fallback, max) {
    const trimmed = String(arg ?? '').trim()
    if (trimmed === '') return fallback
    const value = Number.parseInt(trimmed, 10)
    if (!Number.isSafeInteger(value) || value < 1) return fallback
    return Math.min(value, max)
  }

  /** How long a button-initiated "send me the text next" prompt stays armed. */
  const TEXT_INTENT_TTL_MS = 5 * 60 * 1000
  /** @type {Map<string, { kind: 'say' | 'steer' | 'rename', at: number }>} */
  const textIntents = new Map()

  /** @param {string | number} chatId */
  function clearTextIntent(chatId) {
    textIntents.delete(chatKey(chatId))
  }

  /**
   * Arm the next plain-text message as the input for a button action.
   * @param {string} chatId
   * @param {'say' | 'steer' | 'rename'} kind
   */
  async function startTextIntent(chatId, kind) {
    textIntents.set(chatKey(chatId), { kind, at: Date.now() })
    const labels = { say: 'prompt text', steer: 'steering text', rename: 'new title' }
    await sendSimple(chatId, `✍️ Send the ${labels[kind]} as your next message, or /cancel to abort.`)
  }

  /**
   * Apply one typed message to the armed button action.
   * @param {string} chatId
   * @param {{ kind: 'say' | 'steer' | 'rename' }} intent
   * @param {string} text
   */
  async function runTextIntent(chatId, intent, text) {
    if (intent.kind === 'say') {
      await submitPrompt(chatId, text, 'prompt')
      return
    }
    if (intent.kind === 'steer') {
      await submitPrompt(chatId, text, 'steer')
      return
    }
    const title = String(text ?? '').trim()
    if (title === '') {
      await sendSimple(chatId, 'A session title cannot be empty.')
      return
    }
    const sessionId = requireSession(chatId)
    if (!sessionId) return
    const result = await bridge.rename(sessionId, title)
    await sendSimple(chatId, `✏️ Renamed to <b>${esc(result.title)}</b>.`)
  }

  /** @param {string} chatId @param {number} threadId @param {string} sessionId */
  async function showStatusInThread(chatId, threadId, sessionId) {
    const status = await bridge.getStatus(sessionId)
    await send(chatId, views.statusParts(status, { url: webUrl(), titleChars: config.limits.sessionTitleChars }), {
      sessionId,
      threadId,
    })
  }

  /**
   * Return the Session's topic in this chat, creating one when autoCreate is on.
   * @param {string} chatId
   * @param {string} sessionId
   * @returns {Promise<{ threadId: number, name: string, existing: boolean } | null>}
   */
  async function ensureSessionTopic(chatId, sessionId) {
    if (!config.topics.enabled) return null
    const status = await bridge.getStatus(sessionId)
    const name = topicNameForStatus(status, config.topics)
    const existing = state.findThreadForSession(sessionId)
    if (existing && existing.chatId === String(chatId)) {
      // One topic per session: selecting it again reuses that conversation
      // instead of creating a duplicate.
      await showStatusInThread(chatId, existing.threadId, sessionId)
      return { threadId: existing.threadId, name, existing: true }
    }
    if (!config.topics.autoCreate) return null
    try {
      const created = await api().createForumTopic({ chatId, name })
      const threadId = Number(created?.message_thread_id)
      if (!Number.isSafeInteger(threadId) || threadId <= 0) throw new Error('Telegram returned no topic id')
      state.setThreadSession(chatId, threadId, sessionId)
      state.setThreadName(chatId, threadId, name)
      await showStatusInThread(chatId, threadId, sessionId)
      return { threadId, name, existing: false }
    } catch (error) {
      log.warn(`telegram-bridge: could not create a topic (${error?.message ?? error})`)
      await sendSimple(chatId, '⚠️ Could not create a topic. Make the bot an admin with the "Manage Topics" right, then try again.')
      return null
    }
  }

  /** @param {string} chatId @param {string} sessionId */
  async function rememberSession(chatId, sessionId) {
    state.setCurrentSession(chatId, sessionId)
    const threadId = activeThread(chatId)
    if (config.topics.enabled && threadId > 1) {
      // Selecting inside a topic re-binds that topic to the chosen Session.
      state.setThreadSession(chatId, threadId, sessionId)
      await showStatus(chatId, sessionId)
      return
    }
    // Selecting in a forum's General topic opens the Session's own topic so the
    // conversation gets a dedicated thread instead of sharing General.
    if (config.topics.enabled && (threadId === 1 || (threadId === 0 && isForumChat(chatId)))) {
      const opened = await ensureSessionTopic(chatId, sessionId)
      if (opened) {
        const html = opened.existing
          ? `🧵 <b>${esc(clip(opened.name, 60))}</b> already has a topic — the session card was posted there, not in a new one.`
          : `🧵 Opened topic <b>${esc(clip(opened.name, 60))}</b> — continue there.`
        await send(chatId, [{ html }], { threadId: threadId || null })
        return
      }
    }
    await showStatus(chatId, sessionId)
  }

  /** @param {string} chatId */
  function requireSession(chatId) {
    const sessionId = threadSession(chatId) ?? state.getCurrentSession(chatId)
    if (!sessionId) {
      void sendSimple(chatId, 'No session selected yet. Use /sessions to pick one, or /new to create one.')
      return null
    }
    return sessionId
  }

  /**
   * @param {string} chatId
   * @param {string | null} [sessionId]
   */
  async function showStatus(chatId, sessionId = null) {
    const id = sessionId ?? requireSession(chatId)
    if (!id) return
    const status = await bridge.getStatus(id)
    if (sessionId === null) state.setCurrentSession(chatId, id)
    await send(chatId, views.statusParts(status, { url: webUrl(), titleChars: config.limits.sessionTitleChars }), { sessionId: id })
  }

  /** Full action surface for the selected session (the ⚙️ All controls card). */
  async function showControls(chatId) {
    const sessionId = requireSession(chatId)
    if (!sessionId) return
    const status = await bridge.getStatus(sessionId)
    const chat = state.getChat(chatId)
    await send(chatId, views.controlsParts(status, {
      url: webUrl(),
      notifications: chat.notifications,
      notifyMode: chat.notifyMode,
    }), { sessionId })
  }

  /**
   * Hide archived sessions and child-agent sessions from the picker unless the
   * operator opted into them.
   * @param {any[]} sessions
   * @returns {any[]}
   */
  function visibleSessions(sessions) {
    if (!Array.isArray(sessions)) return []
    return sessions.filter((session) => {
      if (!config.sessions.includeArchived && session.archived === true) return false
      if (!config.sessions.includeSubagents && (session.origin === 'subagent' || Boolean(session.parentSessionId))) return false
      return true
    })
  }

  /** @param {string} chatId */
  async function showSessions(chatId) {
    const sessions = visibleSessions(await bridge.listSessions())
    lists.set(chatId, { sessions, page: 0, at: Date.now() })
    const forum = config.topics.enabled && (isForumChat(chatId) || activeThread(chatId) === 1)
    await send(chatId, views.sessionsParts(sessions, {
      page: 0,
      pageSize: config.limits.pageSize,
      currentSessionId: state.getCurrentSession(chatId),
      forum,
      boundSessionIds: forum ? Object.keys(state.listThreadSessions(chatId)) : [],
    }))
  }

  /**
   * @param {string} chatId
   * @param {string} sessionId
   * @param {'result' | 'review' | 'tail'} kind
   * @param {number} turns
   */
  async function showTurns(chatId, sessionId, kind, turns) {
    const view = await bridge.readRecentTurns(sessionId, { turns, maxEvents: config.limits.maxEventsPerRead })
    if (kind === 'result') await send(chatId, views.resultParts(view, { url: webUrl(), maxTurns: turns, titleChars: config.limits.sessionTitleChars }), { sessionId })
    else if (kind === 'review') await send(chatId, views.reviewParts(view, { url: webUrl() }), { sessionId })
    else await send(chatId, views.tailParts(view, { url: webUrl() }), { sessionId })
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {'prompt' | 'steer'} kind
   * @param {string | null} [sessionIdOverride] explicit target (reply routing)
   */
  async function submitPrompt(chatId, text, kind, sessionIdOverride = null) {
    const trimmed = String(text ?? '').trim()
    if (trimmed === '') {
      await sendSimple(chatId, `Usage: ${kind === 'steer' ? '/steer' : '/say'} <text>`)
      return
    }
    let sessionId
    if (sessionIdOverride) {
      sessionId = sessionIdOverride
      state.setCurrentSession(chatId, sessionId)
    } else {
      sessionId = requireSession(chatId)
      if (!sessionId) return
    }
    const status = await bridge.getStatus(sessionId)
    // Mark Telegram-originated requests so the model knows the user is remote
    // (see the system-prompt section registered by the plugin).
    const outbound = markTelegramText(trimmed)
    if (kind === 'steer') await bridge.steer(sessionId, outbound)
    else await bridge.prompt(sessionId, outbound)
    const label = kind === 'steer' ? '😤 Steering message sent' : '📨 Prompt delivered'
    await sendSimple(chatId, `${label} to <b>${esc(sessionTitle(status))}</b>.<br/>Watch it with /result or /review.`.replace('<br/>', '\n'))
  }

  /**
   * @param {string} chatId
   * @param {string | null} sessionId
   */
  async function stopSession(chatId, sessionId = null) {
    const id = sessionId ?? requireSession(chatId)
    if (!id) return
    await bridge.cancel(id)
    await sendSimple(chatId, `⏹ Stop requested for <code>${esc(id)}</code>.`)
  }

  /** @type {Record<string, (ctx: { chatId: string, userId: string, username: string | null, args: string }) => Promise<void>>} */
  const commands = {
    help: async ({ chatId }) => {
      await send(chatId, views.helpParts(config))
    },
    start: async ({ chatId }) => {
      await send(chatId, views.helpParts(config))
    },
    sessions: async ({ chatId }) => {
      await showSessions(chatId)
    },
    list: async ({ chatId }) => {
      await showSessions(chatId)
    },
    use: async ({ chatId, args }) => {
      const query = args.trim()
      if (query === '') {
        await sendSimple(chatId, 'Usage: /use <number | session id | title>')
        return
      }
      const cached = lists.get(chatId)
      const sessions = cached?.sessions ?? visibleSessions(await bridge.listSessions())
      if (!cached) lists.set(chatId, { sessions, page: 0, at: Date.now() })
      const found = bridge.findSession(sessions, query)
      if (found.match) {
        await rememberSession(chatId, found.match.id)
        return
      }
      if (found.candidates) {
        const rows = []
        for (const candidate of found.candidates) {
          const index = sessions.findIndex((session) => session.id === candidate.id)
          rows.push([{ text: `${index >= 0 ? index + 1 : '·'} ${clip(sessionTitle(candidate), 30)}`, callback_data: `sel:${index}` }])
        }
        await send(chatId, [{ html: 'Several sessions match — pick one:', keyboard: { inline_keyboard: rows } }])
        return
      }
      // A hidden subagent session can still be addressed by its exact id.
      if (/^session-[A-Za-z0-9-]+$/.test(query)) {
        try {
          await bridge.getStatus(query)
          await rememberSession(chatId, query)
          return
        } catch {
          // fall through to the not-found message
        }
      }
      await sendSimple(chatId, `No session matches “${esc(clip(query, 60))}”. Try /sessions.`)
    },
    current: async ({ chatId }) => {
      await showStatus(chatId)
    },
    status: async ({ chatId }) => {
      await showStatus(chatId)
    },
    controls: async ({ chatId }) => {
      await showControls(chatId)
    },
    more: async ({ chatId }) => {
      await showControls(chatId)
    },
    result: async ({ chatId, args }) => {
      const sessionId = requireSession(chatId)
      if (!sessionId) return
      await showTurns(chatId, sessionId, 'result', parseCount(args, 1, config.limits.maxResultTurns))
    },
    files: async ({ chatId }) => {
      const sessionId = requireSession(chatId)
      if (!sessionId) return
      const view = await bridge.readRecentTurns(sessionId, { turns: 1, maxEvents: config.limits.maxEventsPerRead })
      const turn = view.turns[view.turns.length - 1]
      const threadId = activeThread(chatId) > 1 ? activeThread(chatId) : null
      const result = await sendTurnMedia({ api: api(), chatId, threadId, turn, cwd: view.cwd, config, log })
      const note = describeSkippedMedia(result.skipped)
      if (result.sent === 0) {
        await sendSimple(chatId, `📎 No media or documents found in the last turn.${note ? `\n${esc(note)}` : ''}`)
        return
      }
      await sendSimple(chatId, `📎 Sent ${result.sent} file${result.sent === 1 ? '' : 's'} from the last turn.${note ? `\n${esc(note)}` : ''}`)
    },
    review: async ({ chatId }) => {
      const sessionId = requireSession(chatId)
      if (!sessionId) return
      await showTurns(chatId, sessionId, 'review', 1)
    },
    tail: async ({ chatId, args }) => {
      const sessionId = requireSession(chatId)
      if (!sessionId) return
      await showTurns(chatId, sessionId, 'tail', parseCount(args, 8, config.limits.maxTailTurns))
    },
    say: async ({ chatId, args }) => {
      if (args.trim() === '') {
        await startTextIntent(chatId, 'say')
        return
      }
      await submitPrompt(chatId, args, 'prompt')
    },
    steer: async ({ chatId, args }) => {
      if (args.trim() === '') {
        await startTextIntent(chatId, 'steer')
        return
      }
      await submitPrompt(chatId, args, 'steer')
    },
    stop: async ({ chatId }) => {
      await stopSession(chatId)
    },
    new: async ({ chatId, args }) => {
      const cwd = args.trim()
      if (cwd !== '' && !isAbsolute(cwd)) {
        await sendSimple(chatId, 'Working directory must be an absolute path.')
        return
      }
      const created = await bridge.createSession(cwd === '' ? {} : { cwd })
      state.setCurrentSession(chatId, created.sessionId)
      const threadId = activeThread(chatId)
      if (config.topics.enabled && threadId > 1) {
        state.setThreadSession(chatId, threadId, created.sessionId)
        await showStatus(chatId, created.sessionId)
        return
      }
      if (config.topics.enabled && (threadId === 1 || (threadId === 0 && isForumChat(chatId)))) {
        const opened = await ensureSessionTopic(chatId, created.sessionId)
        if (opened) {
          await send(chatId, [{ html: `🧵 New session topic <b>${esc(clip(opened.name, 60))}</b> created.` }], { threadId: threadId || null })
          return
        }
      }
      await showStatus(chatId, created.sessionId)
    },
    topic: async ({ chatId, args }) => {
      const sessionId = requireSession(chatId)
      if (!sessionId) return
      const argv = args.trim().split(/\s+/).filter(Boolean)
      const verb = argv[0] === undefined ? '' : argv[0].toLowerCase()
      const bound = state.findThreadForSession(sessionId)
      const inThisChat = bound && bound.chatId === String(chatId) ? bound : null
      const status = await bridge.getStatus(sessionId)
      if (verb === 'rename') {
        const name = argv.slice(1).join(' ').trim()
        if (name === '') {
          await sendSimple(chatId, 'Usage: /topic rename &lt;name&gt;')
          return
        }
        if (!inThisChat) {
          await sendSimple(chatId, 'This session has no topic yet — use /topic to create one first.')
          return
        }
        try {
          const normalized = normalizeTopicName(name)
          await api().editForumTopic({ chatId, messageThreadId: inThisChat.threadId, name: normalized })
          state.setThreadName(chatId, inThisChat.threadId, normalized)
          await sendSimple(chatId, `🧵 Topic renamed to <b>${esc(normalized)}</b>.`)
        } catch (error) {
          log.warn(`telegram-bridge: could not rename topic (${error?.message ?? error})`)
          await sendSimple(chatId, `⚠️ Could not rename the topic: ${esc(error?.message ?? error)}`)
        }
        return
      }
      if (verb === 'sync') {
        if (!inThisChat) {
          await sendSimple(chatId, 'This session has no topic yet — use /topic to create one first.')
          return
        }
        const name = topicNameForStatus(status, config.topics)
        try {
          await api().editForumTopic({ chatId, messageThreadId: inThisChat.threadId, name })
          state.setThreadName(chatId, inThisChat.threadId, name)
          await sendSimple(chatId, `🧵 Topic name synced to <b>${esc(name)}</b>.`)
        } catch (error) {
          log.warn(`telegram-bridge: could not sync topic name (${error?.message ?? error})`)
          await sendSimple(chatId, `⚠️ Could not sync the topic name: ${esc(error?.message ?? error)}`)
        }
        return
      }
      const threadId = activeThread(chatId)
      if (threadId > 1) {
        state.setThreadSession(chatId, threadId, sessionId)
        const name = topicNameForStatus(status, config.topics)
        state.setThreadName(chatId, threadId, name)
        await sendSimple(chatId, '🧵 This topic is bound to the selected session.')
        return
      }
      if (inThisChat) {
        await sendSimple(chatId, '🧵 This session already has a topic. Send /topic rename &lt;name&gt; to change its name, or /topic sync to match the session title.')
        return
      }
      if (!isForumChat(chatId) && threadId !== 1) {
        await sendSimple(chatId, 'Topics are available in forum supergroups. Enable Topics in the group and make the bot an admin with "Manage Topics".')
        return
      }
      const opened = await ensureSessionTopic(chatId, sessionId)
      if (opened) await sendSimple(chatId, `🧵 Topic <b>${esc(clip(opened.name, 60))}</b> is ready.`)
    },
    rename: async ({ chatId, args }) => {
      const title = args.trim()
      if (title === '') {
        await startTextIntent(chatId, 'rename')
        return
      }
      const sessionId = requireSession(chatId)
      if (!sessionId) return
      const result = await bridge.rename(sessionId, title)
      // Keep the session's forum topic name in step with the new title.
      let topicNote = ''
      const bound = state.findThreadForSession(sessionId)
      if (bound && bound.chatId === String(chatId) && config.topics.enabled) {
        const name = topicNameForStatus({ id: sessionId, title: result.title }, config.topics)
        try {
          await api().editForumTopic({ chatId, messageThreadId: bound.threadId, name })
          state.setThreadName(chatId, bound.threadId, name)
          topicNote = ' Topic renamed too.'
        } catch (error) {
          log.warn(`telegram-bridge: could not rename the topic (${error?.message ?? error})`)
          topicNote = ' (topic rename failed)'
        }
      }
      await sendSimple(chatId, `✏️ Renamed to <b>${esc(result.title)}</b>.${topicNote}`)
    },
    notify: async ({ chatId, args }) => {
      const chat = state.getChat(chatId)
      const arg = args.trim().toLowerCase()
      if (arg === 'on') state.setNotifications(chatId, true)
      else if (arg === 'off') state.setNotifications(chatId, false)
      else if (arg === 'all') state.setNotifyMode(chatId, 'all')
      else if (arg === 'current') state.setNotifyMode(chatId, 'current')
      else if (arg !== '') {
        await sendSimple(chatId, 'Usage: /notify on|off|all|current')
        return
      }
      const current = state.getChat(chatId)
      await sendSimple(chatId, [
        `<b>Notifications</b> · ${current.notifications ? 'on' : 'off'} · ${current.notifyMode === 'all' ? 'all sessions' : 'selected session only'}`,
        '',
        '<i>/notify on|off toggles pushes; /notify all|current chooses the scope.</i>',
      ].join('\n'))
    },
    pending: async ({ chatId }) => {
      const pending = interactions.listPending()
      if (pending.length === 0) {
        await sendSimple(chatId, 'No pending approvals or questions.')
        return
      }
      const lines = [`<b>Pending interactions</b> · ${pending.length}`]
      const rows = []
      for (const item of pending) {
        const expires = item.expiresInMs > 0 ? `expires in ${formatDuration(item.expiresInMs)}` : 'expiring'
        lines.push(`• ${item.kind === 'approval' ? '🔐' : '❓'} ${esc(clip(item.title, 40))} — ${esc(item.summary)} <i>(${esc(expires)})</i> <code>${esc(item.id)}</code>`)
        if (item.kind === 'approval' && rows.length < 4) {
          rows.push([
            { text: `✅ Allow ${item.id}`, callback_data: `ap:${item.id}:allow` },
            { text: `⛔ Deny ${item.id}`, callback_data: `ap:${item.id}:deny` },
          ])
        }
      }
      await send(chatId, [{ html: lines.join('\n'), keyboard: rows.length > 0 ? { inline_keyboard: rows } : undefined }])
    },
    approve: async ({ chatId, args }) => {
      const id = args.trim() === '' || args.trim() === 'last' ? undefined : args.trim()
      const ok = interactions.decideApproval({ approvalId: id, allow: true })
      await sendSimple(chatId, ok ? '✅ Approval sent.' : 'No matching pending approval.')
    },
    deny: async ({ chatId, args }) => {
      const id = args.trim() === '' || args.trim() === 'last' ? undefined : args.trim()
      const ok = interactions.decideApproval({ approvalId: id, allow: false })
      await sendSimple(chatId, ok ? '⛔ Denial sent.' : 'No matching pending approval.')
    },
    cancel: async ({ chatId }) => {
      interactions.clearCustomAnswer(chatId)
      clearTextIntent(chatId)
      await sendSimple(chatId, 'Cancelled the pending text prompt.')
    },
    whoami: async ({ chatId, userId, username }) => {
      const chat = state.getChat(chatId)
      const lines = [
        '<b>Bridge identity</b>',
        `• chat id: <code>${esc(chatId)}</code>`,
        `• user id: <code>${esc(userId)}</code>${username ? ` (@${esc(username)})` : ''}`,
        `• selected session: ${chat.currentSessionId ? `<code>${esc(chat.currentSessionId)}</code>` : '<i>none</i>'}`,
        `• notifications: ${chat.notifications ? 'on' : 'off'} (${chat.notifyMode === 'all' ? 'all' : 'selected'})`,
        `• approvals: ${config.approvals.mode} · questions: ${config.questions.mode}`,
      ]
      const url = webUrl()
      if (url) lines.push(`• web UI: ${esc(url)}`)
      await sendSimple(chatId, lines.join('\n'))
    },
    debug: async ({ chatId }) => {
      const info = deps.describe?.()
      if (!info) {
        await sendSimple(chatId, 'No diagnostics available.')
        return
      }
      await send(chatId, views.preChunks(JSON.stringify(info, null, 2), { maxTotal: 3500 }).map(views.plainPart))
    },
  }

  /**
   * @param {string} chatId
   * @param {string} html
   * @returns {Promise<{ message_id: number } | null>}
   */
  async function sendStatusMessage(chatId, html) {
    const client = api()
    if (!client) return null
    try {
      const sent = await client.sendMessage({ chatId, text: html })
      return Array.isArray(sent) ? sent[sent.length - 1] ?? null : sent ?? null
    } catch (error) {
      log.warn(`telegram-bridge: voice status send failed (${error?.message ?? error})`)
      return null
    }
  }

  /**
   * @param {string} chatId
   * @param {number | null} messageId
   * @param {string} html
   */
  async function editStatusMessage(chatId, messageId, html) {
    if (messageId === null || messageId === undefined) return
    const client = api()
    if (!client) return
    try {
      await client.editMessageText({ chatId, messageId, text: html })
    } catch (error) {
      const description = String(error?.description ?? error?.message ?? '')
      if (!/not modified/i.test(description)) {
        log.warn(`telegram-bridge: voice status edit failed (${error?.message ?? error})`)
      }
    }
  }

  /**
   * @param {any} error
   * @returns {string}
   */
  function friendlyVoiceError(error) {
    switch (error?.code) {
      case 'unavailable':
        return 'Voice input is not available in this DSH profile. Enable the Voice Input bundle in Settings → Plugins, restart DSH, then try again.'
      case 'disabled':
        return 'Voice transcription is disabled by configuration (voice.enabled = false).'
      case 'ffmpeg-missing':
        return 'ffmpeg is not installed on the Host PATH, so I cannot decode Telegram voice notes.'
      case 'subprocess-unavailable':
        return 'The Host subprocess service is unavailable, so audio cannot be converted.'
      case 'no-provider':
        return 'No speech recognizer is configured. Open DSH Settings → Voice input, prepare the local model, then try again.'
      case 'prepare-timeout':
        return 'The voice model is still downloading. Check your network and try again in a few minutes — verified files are cached.'
      case 'prepare-failed':
      case 'prepare-cancelled':
      case 'too-large':
      case 'too-long':
      case 'empty':
      case 'no-file':
      case 'telegram-down':
        return String(error?.message ?? 'Voice transcription failed.')
      case 'convert-failed':
        return `${error?.message ?? 'Audio conversion failed'} (the voice message may use an unsupported codec).`
      default:
        return error?.message ? `Voice transcription failed: ${error.message}` : 'Voice transcription failed.'
    }
  }

  /**
   * Transcribe one Telegram voice/audio/video-note message and route the
   * recognized text exactly like a typed message.
   *
   * @param {any} message
   * @param {{ file_id?: string, duration?: number, mime_type?: string, file_size?: number }} media
   * @param {string | null} [replySessionId] session quoted by a Telegram reply
   */
  async function handleVoiceMessage(message, media, replySessionId = null) {
    const chatId = chatKey(message?.chat?.id ?? '')
    const username = message.from?.username ?? null
    if (!deps.voice) {
      await sendSimple(chatId, 'Voice messages are not supported by this bridge build.')
      return
    }
    const status = await sendStatusMessage(chatId, '🎤 <b>Voice message</b> — processing…')
    const messageId = status?.message_id ?? null
    let lastEditAt = 0
    const onProgress = (progress) => {
      const now = Date.now()
      if (messageId === null || now - lastEditAt < 1500) return
      lastEditAt = now
      void editStatusMessage(chatId, messageId, `🎤 <b>Voice message</b>\n${esc(describeVoiceProgress(progress))}`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('voice transcription timed out')), config.voice.totalTimeoutMs)
    try {
      const result = await deps.voice.transcribeVoice(media, { onProgress, signal: controller.signal })
      const timing = []
      if (result.audioSeconds > 0) timing.push(`${formatDuration(result.audioSeconds * 1000)} audio`)
      if (result.inferenceSeconds > 0) timing.push(`${formatDuration(result.inferenceSeconds * 1000)} inference`)
      const heard = [
        `🎤 <b>Heard:</b> ${esc(clip(result.text, 1200))}`,
        timing.length > 0 ? `<i>${esc(timing.join(' · '))}</i>` : '',
      ].filter(Boolean).join('\n')
      await editStatusMessage(chatId, messageId, heard)

      // Recognized speech behaves like typed text. An explicit Telegram reply
      // wins; then a pending question answer, then an armed button action,
      // otherwise a prompt to the selected session.
      if (replySessionId) {
        await submitPrompt(chatId, result.text, 'prompt', replySessionId)
        return
      }
      if (interactions.hasCustomAnswer(chatId)) {
        const recorded = await interactions.consumeCustomAnswer(chatId, result.text)
        if (recorded) {
          await sendSimple(chatId, '✅ Answer recorded.')
          return
        }
      }
      const armed = textIntents.get(chatId)
      if (armed) {
        textIntents.delete(chatId)
        if (Date.now() - armed.at < TEXT_INTENT_TTL_MS) {
          await runTextIntent(chatId, armed, result.text)
          return
        }
      }
      if (config.voice.autoSend === false) {
        await sendSimple(chatId, 'Voice transcribed — voice.autoSend is off, so nothing was sent to the session.')
        return
      }
      await submitPrompt(chatId, result.text, 'prompt')
    } catch (error) {
      if (controller.signal.aborted) {
        await editStatusMessage(chatId, messageId, '⏱️ Voice transcription timed out. Try a shorter message.')
        return
      }
      log.warn(`telegram-bridge: voice transcription failed (${error?.message ?? error})`)
      await editStatusMessage(chatId, messageId, `⚠️ ${esc(friendlyVoiceError(error))}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @param {any} message
   */
  async function handleMessage(message) {
    const chatId = chatKey(message?.chat?.id ?? '')
    const userId = String(message?.from?.id ?? '')
    if (chatId === '') return
    rememberThread(chatId, threadFromMessage(message))
    if (message?.chat?.is_forum === true) forumChats.add(chatId)
    const text = typeof message.text === 'string' ? message.text : ''
    if (!isAuthorized(chatId, userId)) {
      if (config.pairing.notice && state.pairingNoticeAllowed(chatId, config.pairing.cooldownMs)) {
        await send(chatId, views.pairingParts({
          chatId,
          userId,
          username: message.from?.username ?? null,
          allowedIds: config.allowedChatIds,
        }))
      }
      return
    }
    // Voice notes (and audio/video-note uploads) are transcribed locally.
    const media = message.voice ?? message.video_note ?? message.audio
    if (media && typeof media === 'object') {
      const quoted = message.reply_to_message
        ? findSessionMessage(chatId, message.reply_to_message.message_id)
        : null
      await handleVoiceMessage(message, media, quoted)
      return
    }
    // Reject other non-text content politely instead of silently dropping it.
    if (text === '') {
      await sendSimple(chatId, 'I can only handle text and voice messages right now.')
      return
    }
    // Telegram reply-to-message: the quoted message's session becomes the
    // target (and the new active session), so simultaneous notifications from
    // different sessions cannot misroute a prompt.
    if (!text.trimStart().startsWith('/') && message.reply_to_message) {
      const quotedSession = findSessionMessage(chatId, message.reply_to_message.message_id)
      if (quotedSession) {
        try {
          await submitPrompt(chatId, text, 'prompt', quotedSession)
        } catch (error) {
          log.warn(`telegram-bridge: reply-routed prompt failed (${error?.message ?? error})`)
          await fail(chatId, error)
        }
        return
      }
    }
    if (interactions.hasCustomAnswer(chatId) && !text.trimStart().startsWith('/')) {
      const recorded = await interactions.consumeCustomAnswer(chatId, text)
      if (recorded) {
        await sendSimple(chatId, '✅ Answer recorded.')
        return
      }
    }
    // A button like ✍️ Say… arms the next text message for that action.
    const armed = textIntents.get(chatId)
    if (armed) {
      textIntents.delete(chatId)
      const fresh = Date.now() - armed.at < TEXT_INTENT_TTL_MS
      const isCommand = text.trimStart().startsWith('/')
      if (fresh && !isCommand) {
        try {
          await runTextIntent(chatId, armed, text)
        } catch (error) {
          log.warn(`telegram-bridge: text action ${armed.kind} failed (${error?.message ?? error})`)
          await fail(chatId, error)
        }
        return
      }
    }
    const match = /^\/([A-Za-z0-9_]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (match) {
      const name = match[1].toLowerCase()
      const args = match[2] ?? ''
      const handler = commands[name]
      if (!handler) {
        await sendSimple(chatId, `Unknown command /${esc(name)}. Try /help.`)
        return
      }
      try {
        await handler({ chatId, userId, username: message.from?.username ?? null, args })
      } catch (error) {
        log.warn(`telegram-bridge: command /${name} failed (${error?.message ?? error})`)
        await fail(chatId, error)
      }
      return
    }
    if (text.trimStart().startsWith('/')) {
      await sendSimple(chatId, 'That does not look like a command. Try /help.')
      return
    }
    // Plain text is the primary way to talk to the selected session.
    try {
      await submitPrompt(chatId, text, 'prompt')
    } catch (error) {
      log.warn(`telegram-bridge: prompt failed (${error?.message ?? error})`)
      await fail(chatId, error)
    }
  }

  /** @param {any} callbackQuery */
  async function answerCallback(callbackQuery, text = '') {
    const client = api()
    if (!client) return
    try {
      await client.answerCallbackQuery({ callbackQueryId: callbackQuery.id, text: text === '' ? null : text })
    } catch (error) {
      log.warn(`telegram-bridge: answerCallbackQuery failed (${error?.message ?? error})`)
    }
  }

  /**
   * @param {any} callbackQuery
   */
  async function handleCallback(callbackQuery) {
    const chatId = chatKey(callbackQuery?.message?.chat?.id ?? '')
    const userId = String(callbackQuery?.from?.id ?? '')
    const data = typeof callbackQuery?.data === 'string' ? callbackQuery.data : ''
    if (chatId === '') return
    rememberThread(chatId, Number(callbackQuery?.message?.message_thread_id ?? 0))
    if (callbackQuery?.message?.chat?.is_forum === true) forumChats.add(chatId)
    if (!isAuthorized(chatId, userId)) {
      await answerCallback(callbackQuery, 'Not authorized.')
      return
    }
    const [verb, ...rest] = data.split(':')
    try {
      switch (verb) {
        case 'sel': {
          const list = lists.get(chatId)
          if (!list) {
            await answerCallback(callbackQuery, 'List expired — send /sessions again.')
            return
          }
          const index = Number.parseInt(rest[0] ?? '', 10)
          const session = Number.isSafeInteger(index) ? list.sessions[index] : undefined
          if (!session) {
            await answerCallback(callbackQuery, 'Unknown session.')
            return
          }
          await answerCallback(callbackQuery, 'Selected.')
          await rememberSession(chatId, session.id)
          return
        }
        case 'pg': {
          const list = lists.get(chatId)
          if (!list) {
            await answerCallback(callbackQuery, 'List expired — send /sessions again.')
            return
          }
          const page = Math.max(0, Number.parseInt(rest[0] ?? '0', 10) || 0)
          list.page = page
          await answerCallback(callbackQuery)
          await send(chatId, views.sessionsParts(list.sessions, {
            page,
            pageSize: config.limits.pageSize,
            currentSessionId: state.getCurrentSession(chatId),
          }))
          return
        }
        case 'ss': {
          await answerCallback(callbackQuery)
          await showSessions(chatId)
          return
        }
        case 'tps': {
          const list = lists.get(chatId)
          if (!list) {
            await answerCallback(callbackQuery, 'List expired — send /sessions again.')
            return
          }
          if (!config.topics.enabled) {
            await answerCallback(callbackQuery, 'Topics are disabled in config.')
            return
          }
          await answerCallback(callbackQuery, 'Creating topics…')
          const pageSize = config.limits.pageSize
          const page = Number.parseInt(rest[0] ?? '0', 10) || 0
          const slice = list.sessions.slice(page * pageSize, page * pageSize + pageSize)
          let created = 0
          let failed = 0
          for (const session of slice) {
            const existing = state.findThreadForSession(session.id)
            if (existing && existing.chatId === String(chatId)) continue
            try {
              const status = await bridge.getStatus(session.id)
              const name = topicNameForStatus(status, config.topics)
              const topic = await api().createForumTopic({ chatId, name })
              const threadId = Number(topic?.message_thread_id)
              if (!Number.isSafeInteger(threadId) || threadId <= 0) throw new Error('Telegram returned no topic id')
              state.setThreadSession(chatId, threadId, session.id)
              state.setThreadName(chatId, threadId, name)
              created += 1
            } catch (error) {
              failed += 1
              log.warn(`telegram-bridge: could not create topic for ${session.id} (${error?.message ?? error})`)
            }
          }
          await sendSimple(chatId, failed === 0
            ? `🧵 Created ${created} topic${created === 1 ? '' : 's'}.`
            : `🧵 Created ${created}, ${failed} failed. Check that the bot is an admin with the "Manage Topics" right.`)
          return
        }
        case 'st': {
          await answerCallback(callbackQuery)
          await showStatus(chatId)
          return
        }
        case 'rs': {
          await answerCallback(callbackQuery)
          const sessionId = requireSession(chatId)
          if (sessionId) await showTurns(chatId, sessionId, 'result', 1)
          return
        }
        case 'rv': {
          await answerCallback(callbackQuery)
          const sessionId = requireSession(chatId)
          if (sessionId) await showTurns(chatId, sessionId, 'review', 1)
          return
        }
        case 'more': {
          await answerCallback(callbackQuery)
          await showControls(chatId)
          return
        }
        case 'files': {
          await answerCallback(callbackQuery, 'Sending files…')
          await commands.files({ chatId, userId, username: callbackQuery.from?.username ?? null, args: '' })
          return
        }
        case 'tail': {
          await answerCallback(callbackQuery)
          const sessionId = requireSession(chatId)
          if (sessionId) await showTurns(chatId, sessionId, 'tail', 8)
          return
        }
        case 'say':
        case 'steer':
        case 'rename': {
          await answerCallback(callbackQuery, 'Send the text as your next message.')
          await startTextIntent(chatId, verb)
          return
        }
        case 'pending': {
          await answerCallback(callbackQuery)
          await commands.pending({ chatId, userId, username: callbackQuery.from?.username ?? null, args: '' })
          return
        }
        case 'help': {
          await answerCallback(callbackQuery)
          await commands.help({ chatId, userId, username: callbackQuery.from?.username ?? null, args: '' })
          return
        }
        case 'who': {
          await answerCallback(callbackQuery)
          await commands.whoami({ chatId, userId, username: callbackQuery.from?.username ?? null, args: '' })
          return
        }
        case 'dbg': {
          await answerCallback(callbackQuery)
          await commands.debug({ chatId, userId, username: callbackQuery.from?.username ?? null, args: '' })
          return
        }
        case 'nf': {
          const sub = rest[0] ?? ''
          if (sub === 'all') {
            state.setNotifyMode(chatId, 'all')
            await answerCallback(callbackQuery, 'Notifications: all sessions.')
          } else if (sub === 'cur') {
            state.setNotifyMode(chatId, 'current')
            await answerCallback(callbackQuery, 'Notifications: selected session only.')
          } else if (sub === 'off') {
            state.setNotifications(chatId, false)
            await answerCallback(callbackQuery, 'Notifications off.')
          } else {
            await answerCallback(callbackQuery, 'Unknown notification option.')
          }
          return
        }
        case 't':
        case 'r':
        case 'v': {
          const sessionId = rest.join(':')
          if (sessionId === '') {
            await answerCallback(callbackQuery, 'Missing session id.')
            return
          }
          await answerCallback(callbackQuery)
          state.setCurrentSession(chatId, sessionId)
          if (verb === 't') await showStatus(chatId, sessionId)
          else if (verb === 'r') await showTurns(chatId, sessionId, 'result', 1)
          else await showTurns(chatId, sessionId, 'review', 1)
          return
        }
        case 'c': {
          const sessionId = rest.join(':')
          if (sessionId === '') {
            await answerCallback(callbackQuery, 'Missing session id.')
            return
          }
          await answerCallback(callbackQuery, 'Selected.')
          await rememberSession(chatId, sessionId)
          return
        }
        case 'stop': {
          await answerCallback(callbackQuery, 'Stopping…')
          await stopSession(chatId)
          return
        }
        case 'nt': {
          const chat = state.getChat(chatId)
          state.setNotifications(chatId, !chat.notifications)
          await answerCallback(callbackQuery, chat.notifications ? 'Notifications on.' : 'Notifications off.')
          return
        }
        case 'new': {
          await answerCallback(callbackQuery, 'Creating…')
          const created = await bridge.createSession({})
          state.setCurrentSession(chatId, created.sessionId)
          await showStatus(chatId)
          return
        }
        case 'ap': {
          const approvalId = rest[0] ?? ''
          const allow = rest[1] === 'allow'
          const ok = interactions.decideApproval({ approvalId, allow })
          await answerCallback(callbackQuery, ok ? (allow ? 'Approved.' : 'Denied.') : 'No longer pending.')
          return
        }
        case 'qa': {
          const pendingId = rest[0] ?? ''
          const questionIndex = Number.parseInt(rest[1] ?? '', 10)
          const action = rest.slice(2).join(':')
          const result = await interactions.handleQuestionCallback({
            chatId,
            pendingId,
            questionIndex: Number.isSafeInteger(questionIndex) ? questionIndex : -1,
            action,
          })
          await answerCallback(callbackQuery, result.message ?? (result.ok ? '' : 'Could not apply.'))
          if (result.ok && action === 'other') {
            const client = api()
            if (client) {
              try {
                await client.sendMessage({ chatId, text: '✏️ Send the answer as a text message now.' })
              } catch {
                /* the toast already told the user */
              }
            }
          }
          return
        }
        default: {
          await answerCallback(callbackQuery, 'Unknown action.')
        }
      }
    } catch (error) {
      log.warn(`telegram-bridge: callback ${data} failed (${error?.message ?? error})`)
      await answerCallback(callbackQuery, 'Action failed.')
      await fail(chatId, error)
    }
  }

  /** @param {any} update */
  async function handleUpdate(update) {
    if (!update || typeof update !== 'object') return
    if (update.message) {
      await handleMessage(update.message)
      return
    }
    if (update.callback_query) {
      await handleCallback(update.callback_query)
    }
  }

  return {
    handleUpdate,
    handleMessage,
    handleCallback,
    authorizedChats,
    send,
    sendSimple,
    webUrl,
  }
}
