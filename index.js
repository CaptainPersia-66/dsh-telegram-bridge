/**
 * Telegram bridge — Host plugin entry.
 *
 * Lifecycle: resolve settings, load durable chat state, connect to the Bot API
 * with long polling, and route updates through the command router. Independent
 * DSH listeners publish turn completions and claim approvals/questions when no
 * desktop answerer is available. Every resource is owned by the plugin fiber:
 * disposing the plugin aborts polling, settles outstanding interactions, and
 * flushes the state file.
 */

import { describeConfig, redactToken, resolveBotToken, resolveConfig, tokenLooksValid } from './lib/config.js'
import { createBridge } from './lib/bridge.js'
import { createRouter } from './lib/commands.js'
import { createInteractions } from './lib/interactions.js'
import { describeSkippedMedia, sendTurnMedia } from './lib/media.js'
import { registerPromptSection } from './lib/prompt.js'
import { BridgeState } from './lib/state.js'
import { topicNameForStatus } from './lib/topics.js'
import { createMediaCompressor } from './lib/transcode.js'
import { TelegramApi } from './lib/telegram-api.js'
import { createVoice } from './lib/voice.js'
import * as views from './lib/views.js'

/** Stable Loader identity. */
export const name = 'telegram-bridge'

/**
 * Session-controller presence gates the whole bridge: without it there is
 * nothing to manage and the plugin stays inactive instead of throwing.
 */
export const inject = ['sessionController']

/**
 * @param {AbortSignal} signal
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(signal, ms) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(finish, Math.max(0, ms))
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context | any} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger ?? console
  for (const warning of config.warnings) log.warn?.(`telegram-bridge: ${warning}`)

  const lifetime = new AbortController()
  const bridge = createBridge(ctx)
  const state = new BridgeState({
    logger: log,
    filePath: config.statePath ?? undefined,
    defaultNotifyMode: config.notifications.mode,
  })
  /** @type {TelegramApi | null} */
  let api = null
  /** @type {{ token: string | null, source: string }} */
  let tokenInfo = { token: null, source: 'pending' }
  /** @type {ReturnType<typeof createRouter> | null} */
  let router = null

  const webUrl = () => {
    try {
      return bridge.advertisedUrl() ?? null
    } catch {
      return null
    }
  }

  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const turnTimers = new Map()
  /** @type {Map<string, number>} session id -> last turn notified as an error */
  const notifiedErrors = new Map()

  const interactions = createInteractions({
    apiProvider: () => api,
    config,
    log,
    statusFor: async (sessionId) => bridge.getStatus(sessionId),
    targets: (sessionId) => router
      ? interactionTargets(sessionId)
      : config.allowedChatIds.map((chatId) => ({ chatId, threadId: null })),
    ensureTopic: async (sessionId) => {
      if (!sessionId) return
      const status = await statusForMaybe({ id: sessionId })
      await ensureNotificationTopic(sessionId, status)
    },
  })

  const voice = createVoice({ ctx, config, log, apiProvider: () => api })
  const mediaCompressor = createMediaCompressor({ ctx, config, log })

  router = createRouter({
    config,
    apiProvider: () => api,
    bridge,
    state,
    interactions,
    voice,
    compress: mediaCompressor,
    log,
    describe: () => {
      const view = describeConfig(config, tokenInfo)
      let voiceStatus
      try {
        const stt = ctx.get?.('speechToText')
        const snapshot = stt?.snapshot?.()
        voiceStatus = {
          enabled: config.voice.enabled,
          providers: Array.isArray(snapshot?.providers)
            ? snapshot.providers.map((provider) => ({ id: provider.id, phase: provider.preparation?.phase ?? 'unknown' }))
            : [],
          selection: snapshot?.selection ?? null,
        }
      } catch {
        voiceStatus = { enabled: config.voice.enabled, unavailable: true }
      }
      return {
        ...view,
        bridge: {
          hasLiveClient: bridge.hasLiveClient(),
          advertisedUrl: webUrl(),
        },
        voice: voiceStatus,
        pending: interactions.listPending().length,
      }
    },
  })

  /**
   * Chats and forum topics that should receive a session's push notifications.
   * A session bound to a topic notifies only in that topic; otherwise the
   * chat-level subscription decides and general-chat messages have no thread.
   * @param {string} sessionId
   * @returns {Array<{ chatId: string, threadId: number | null }>}
   */
  function notificationTargets(sessionId) {
    const targets = []
    for (const chatId of router.authorizedChats()) {
      const chat = state.getChat(chatId)
      if (!chat.notifications) continue
      if (config.topics.enabled) {
        const bound = state.findThreadForSession(sessionId)
        if (bound && bound.chatId === String(chatId)) {
          targets.push({ chatId, threadId: bound.threadId })
          continue
        }
      }
      if (chat.notifyMode === 'all' || chat.currentSessionId === sessionId) {
        targets.push({ chatId, threadId: null })
      }
    }
    return targets
  }

  /**
   * Keep a Session's forum-topic name in step with its title. Called on turn
   * notifications, so renaming a session anywhere in DSH updates its topic.
   * @param {string} sessionId
   * @param {any} status
   */
  async function syncTopicName(sessionId, status) {
    if (!config.topics.enabled || api === null) return
    const bound = state.findThreadForSession(sessionId)
    if (!bound) return
    const desired = topicNameForStatus(status, config.topics)
    const current = state.getThreadName(bound.chatId, bound.threadId)
    if (current === desired) return
    if (current === null) {
      // Binding predates name tracking; adopt the current name without a call.
      state.setThreadName(bound.chatId, bound.threadId, desired)
      return
    }
    try {
      await api.editForumTopic({ chatId: bound.chatId, messageThreadId: bound.threadId, name: desired })
      state.setThreadName(bound.chatId, bound.threadId, desired)
      log.info?.(`telegram-bridge: synced topic name for ${sessionId}`)
    } catch (error) {
      log.warn?.(`telegram-bridge: could not sync topic name (${error?.message ?? error})`)
    }
  }

  /**
   * Give a Session its topic when it first needs attention in a forum chat.
   * @param {string} sessionId
   * @param {any} status
   */
  async function ensureNotificationTopic(sessionId, status) {
    if (!config.topics.enabled || !config.topics.autoCreateOnNotify || api === null) return
    for (const chatId of router.authorizedChats()) {
      const chat = state.getChat(chatId)
      if (!chat.notifications) continue
      if (!state.isForumChat(chatId)) continue
      if (chat.notifyMode !== 'all' && chat.currentSessionId !== sessionId) continue
      const bound = state.findThreadForSession(sessionId)
      if (bound && bound.chatId === String(chatId)) continue
      try {
        const name = topicNameForStatus(status, config.topics)
        const created = await api.createForumTopic({ chatId, name })
        const threadId = Number(created?.message_thread_id)
        if (!Number.isSafeInteger(threadId) || threadId <= 0) throw new Error('Telegram returned no topic id')
        state.setThreadSession(chatId, threadId, sessionId)
        state.setThreadName(chatId, threadId, name)
        await router.send(chatId, views.statusParts(status, {
          url: webUrl(),
          titleChars: config.limits.sessionTitleChars,
        }), { sessionId, threadId, pin: true })
        log.info?.(`telegram-bridge: created topic for ${sessionId} on first notification`)
      } catch (error) {
        log.warn?.(`telegram-bridge: could not create a topic on notification (${error?.message ?? error})`)
      }
    }
  }

  /**
   * Close/reopen a Session's topic to match its archived state.
   * @param {string} sessionId
   */
  async function syncArchiveForSession(sessionId) {
    if (!config.topics.enabled || !config.topics.syncArchive || api === null) return
    const bound = state.findThreadForSession(sessionId)
    if (!bound) return
    let archived
    try {
      const sessions = await bridge.listSessions()
      const found = sessions.find((session) => session.id === sessionId)
      if (!found) return
      archived = found.archived === true
    } catch {
      return
    }
    if (archived === state.isThreadClosed(bound.chatId, bound.threadId)) return
    try {
      if (archived) await api.closeForumTopic({ chatId: bound.chatId, messageThreadId: bound.threadId })
      else await api.reopenForumTopic({ chatId: bound.chatId, messageThreadId: bound.threadId })
      state.setThreadClosed(bound.chatId, bound.threadId, archived)
    } catch (error) {
      log.warn?.(`telegram-bridge: could not sync the archived topic (${error?.message ?? error})`)
    }
  }

  /**
   * Approvals and questions go to every authorized chat (they are live requests,
   * not subscriptions), posted in the session's topic when one is bound.
   * @param {string} sessionId
   * @returns {Array<{ chatId: string, threadId: number | null }>}
   */
  function interactionTargets(sessionId) {
    const chats = router?.authorizedChats() ?? config.allowedChatIds
    const bound = config.topics.enabled ? state.findThreadForSession(sessionId) : null
    return chats.map((chatId) => ({
      chatId,
      threadId: bound && bound.chatId === String(chatId) ? bound.threadId : null,
    }))
  }

  /**
   * @param {Array<{ chatId: string, threadId: number | null }>} targets
   * @param {(status: any) => views.MessagePart[]} buildParts
   * @param {any} [fallbackStatus]
   * @param {string | null} [sessionId] session recorded for reply routing
   */
  async function sendToChats(targets, buildParts, fallbackStatus, sessionId = null) {
    if (targets.length === 0) return
    for (const target of targets) {
      try {
        const status = fallbackStatus ?? { id: '', title: null }
        await router.send(target.chatId, buildParts(status), { sessionId: sessionId ?? undefined, threadId: target.threadId })
      } catch (error) {
        log.warn?.(`telegram-bridge: notification send failed (${error?.message ?? error})`)
      }
    }
  }

  /**
   * @param {{ id?: string, title?: string | null }} sessionLike
   * @param {string | undefined} sessionId
   */
  async function statusForMaybe(sessionLike, sessionId) {
    const id = sessionId ?? sessionLike?.id ?? ''
    try {
      return await bridge.getStatus(id)
    } catch {
      return { id, title: null, running: false }
    }
  }

  /**
   * @param {any} session
   * @param {any} event
   */
  function scheduleTurnEnd(session, event) {
    const sessionId = String(session.id)
    const existing = turnTimers.get(sessionId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      turnTimers.delete(sessionId)
      void notifyTurnEnd(session, event).catch((error) => log.warn?.(`telegram-bridge: turn notification failed (${error?.message ?? error})`))
    }, 400)
    turnTimers.set(sessionId, timer)
  }

  /**
   * @param {any} session
   * @param {any} event
   */
  async function notifyTurnEnd(session, event) {
    if (lifetime.signal.aborted || api === null) return
    if (!config.notifications.enabled || !config.notifications.onTurnEnd) return
    const header = session.header ?? {}
    if (header.origin === 'subagent' && !config.notifications.includeSubagents) return
    const reason = event.data?.reason?.kind ?? 'completed'
    if (reason === 'error' && !config.notifications.onError) return
    const sessionId = String(session.id)
    const [status, turnView] = await Promise.all([
      statusForMaybe({ id: session.id }),
      bridge.readRecentTurns(sessionId, { turns: 1, maxEvents: config.limits.maxEventsPerRead }).catch(() => null),
    ])
    await ensureNotificationTopic(sessionId, status)
    await syncArchiveForSession(sessionId)
    const targets = notificationTargets(sessionId)
    if (targets.length === 0) return
    const parts = views.turnEndParts(status, {
      turn: Number(event.data?.turn ?? 0),
      reason,
      sessionId,
      url: webUrl(),
      snippetChars: config.notifications.snippetChars,
      turnView,
    })
    if (reason === 'error') notifiedErrors.set(sessionId, Number(event.data?.turn ?? 0))
    await syncTopicName(sessionId, status)
    await sendToChats(targets, () => parts, status, sessionId)

    // Forward the turn's media/documents so they can be reviewed in Telegram.
    const turn = turnView?.turns?.[turnView.turns.length - 1]
    if (config.deliverables.enabled && turn) {
      for (const target of targets) {
        try {
          const result = await sendTurnMedia({
            api,
            chatId: target.chatId,
            threadId: target.threadId,
            turn,
            cwd: turnView?.cwd ?? status?.cwd ?? null,
            config,
            log,
            compress: mediaCompressor,
          })
          if (result.skipped.length > 0) {
            const note = describeSkippedMedia(result.skipped)
            if (note !== '') await router.sendSimple(target.chatId, note, { threadId: target.threadId })
          }
        } catch (error) {
          log.warn?.(`telegram-bridge: media forwarding failed (${error?.message ?? error})`)
        }
      }
    }
  }

  /**
   * @param {any} agent
   * @param {any} turn
   * @param {unknown} error
   */
  async function notifyAgentError(agent, turn, error) {
    if (lifetime.signal.aborted || api === null) return
    // A failed turn also emits turn/end, which carries the richer result view;
    // only fall back to this notice when turn-end pushes are disabled.
    if (!config.notifications.enabled || !config.notifications.onError || config.notifications.onTurnEnd) return
    const sessionId = String(agent?.id ?? agent?.session ?? '')
    if (sessionId === '' || notifiedErrors.get(sessionId) === Number(turn)) return
    const chats = notificationTargets(sessionId)
    if (chats.length === 0) return
    const status = await statusForMaybe({ id: sessionId })
    const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error ?? 'Unknown error')
    const parts = views.agentErrorParts(status, { message, sessionId, url: webUrl() })
    notifiedErrors.set(sessionId, Number(turn))
    await sendToChats(chats, () => parts, status, sessionId)
  }

  /**
   * Send a notice for an interaction that stays in the desktop UI.
   * @param {string} sessionId
   * @param {'approval' | 'question'} kind
   */
  async function notifyRemoteInteraction(sessionId, kind) {
    if (lifetime.signal.aborted || api === null || !config.notifications.enabled) return
    const status = await statusForMaybe({ id: sessionId })
    await ensureNotificationTopic(sessionId, status)
    const chats = notificationTargets(sessionId)
    if (chats.length === 0) return
    const parts = views.remoteInteractionNotice(status, { session: status, kind, url: webUrl() })
    await sendToChats(chats, () => parts, status, sessionId)
  }

  /**
   * @param {{ agent: { id: string }, toolName: string, reason?: string, signal?: AbortSignal }} request
   */
  async function notifyApprovalOnly(request) {
    if (!config.notifications.onApproval) return
    await notifyRemoteInteraction(String(request.agent?.id ?? ''), 'approval')
  }

  /**
   * @param {{ agent?: { id: string } }} request
   */
  async function notifyQuestionOnly(request) {
    if (!config.notifications.onQuestion) return
    await notifyRemoteInteraction(String(request.agent?.id ?? ''), 'question')
  }

  /**
   * Effective interaction mode: `auto` claims only while no browser client is
   * connected, because a connected client owns the richer in-app answerer.
   * @param {'auto' | 'telegram' | 'notify' | 'off'} mode
   */
  function shouldClaim(mode) {
    if (mode === 'off' || mode === 'notify') return false
    if (mode === 'telegram') return true
    try {
      return !bridge.hasLiveClient()
    } catch {
      return false
    }
  }

  ctx.on('approval/request', async (request, next) => {
    try {
      const mode = config.approvals.mode
      if (mode === 'off') return next()
      if (api === null || router.authorizedChats().length === 0 || !shouldClaim(mode)) {
        if (mode !== 'off') await notifyApprovalOnly(request)
        return next()
      }
      const outcome = await interactions.requestApproval(request)
      return outcome === null ? next() : outcome
    } catch (error) {
      log.warn?.(`telegram-bridge: approval handling failed (${error?.message ?? error})`)
      return next()
    }
  })

  ctx.on('user-questions/request', async (request, next) => {
    try {
      const mode = config.questions.mode
      if (mode === 'off') return next()
      if (api === null || router.authorizedChats().length === 0 || !shouldClaim(mode)) {
        if (mode !== 'off') await notifyQuestionOnly(request)
        return next()
      }
      const answer = await interactions.requestQuestions(request)
      return answer === null ? next() : answer
    } catch (error) {
      log.warn?.(`telegram-bridge: question handling failed (${error?.message ?? error})`)
      return next()
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      if (!config.notifications.enabled || api === null || lifetime.signal.aborted) return
      if (event.type === 'turn/end') scheduleTurnEnd(session, event)
      else if (event.type === 'turn/start' && config.notifications.onSessionStart) {
        const header = session.header ?? {}
        if (header.origin === 'subagent' && !config.notifications.includeSubagents) return
        const sessionId = String(session.id)
        const chats = notificationTargets(sessionId)
        if (chats.length === 0) return
        void (async () => {
          const status = await statusForMaybe({ id: sessionId })
          const parts = views.sessionStartedParts(status, { turn: Number(event.data?.turn ?? 0), sessionId, url: webUrl() })
          await sendToChats(chats, () => parts, status, sessionId)
        })().catch(() => {})
      }
    } catch (error) {
      log.warn?.(`telegram-bridge: session notification failed (${error?.message ?? error})`)
    }
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    void notifyAgentError(agent, turn, error).catch((cause) => log.warn?.(`telegram-bridge: error notification failed (${cause?.message ?? cause})`))
  })

  /** @type {Promise<void> | null} */
  let polling = null

  async function pollLoop() {
    if (api === null) return
    let offset = state.getOffset()
    if (offset === 0 && config.dropPendingUpdates) {
      try {
        await api.getUpdates({ offset: -1, timeoutSeconds: 0, limit: 1, signal: lifetime.signal })
      } catch {
        // A failure here just means the normal loop will surface the problem.
      }
    }
    let backoff = config.poll.backoffMinMs
    log.info?.('telegram-bridge: polling for updates')
    while (!lifetime.signal.aborted && api !== null) {
      try {
        const updates = await api.getUpdates({
          offset,
          timeoutSeconds: config.poll.timeoutSeconds,
          signal: lifetime.signal,
        })
        backoff = config.poll.backoffMinMs
        for (const update of updates) {
          if (lifetime.signal.aborted) break
          offset = Math.max(offset, Number(update?.update_id ?? 0) + 1)
          state.setOffset(offset)
          try {
            await router.handleUpdate(update)
          } catch (error) {
            log.warn?.(`telegram-bridge: update handling failed (${error?.message ?? error})`)
          }
        }
      } catch (error) {
        if (lifetime.signal.aborted) break
        const code = error?.code
        if (code === 401 || code === 404) {
          log.error?.(`telegram-bridge: bot token rejected (${redactToken(error?.description ?? error?.message)}) — polling stopped`)
          break
        }
        if (code === 409) {
          log.warn?.('telegram-bridge: another process is polling this bot (409); retrying in 30s')
          await sleep(lifetime.signal, 30000)
          continue
        }
        log.warn?.(`telegram-bridge: getUpdates failed (${redactToken(error?.description ?? error?.message ?? error)})`)
        await sleep(lifetime.signal, backoff)
        backoff = Math.min(Math.floor(backoff * 2), config.poll.backoffMaxMs)
      }
    }
  }

  async function start() {
    await state.load()
    tokenInfo = await resolveBotToken(ctx, config)
    if (tokenInfo.token === null) {
      log.warn?.(`telegram-bridge: no bot token found (ref ${config.tokenRef}); plugin loaded but idle. Set the ${config.tokenRef} credential/environment variable and restart dsh.`)
      return
    }
    if (!tokenLooksValid(tokenInfo.token)) {
      log.warn?.(`telegram-bridge: token from ${tokenInfo.source} does not look like a Bot API token; trying it anyway`)
    }
    api = new TelegramApi({
      token: tokenInfo.token,
      baseUrl: config.apiBaseUrl,
      logger: log,
      signal: lifetime.signal,
    })
    try {
      const me = await api.getMe()
      log.info?.(`telegram-bridge: connected as @${me?.username ?? me?.id ?? 'unknown bot'}`)
    } catch (error) {
      if (lifetime.signal.aborted) return
      log.error?.(`telegram-bridge: getMe failed (${redactToken(error?.description ?? error?.message ?? error)})`)
      if (error?.code === 401 || error?.code === 404) return
    }
    if (lifetime.signal.aborted) return
    await pollLoop()
  }

  // Tell every agent that `[via Telegram]` requests come from a remote user:
  // deliver with `present`, never open windows on this desktop.
  ctx.effect(() => registerPromptSection(ctx) ?? (() => {}))

  ctx.effect(() => {
    polling = start().catch((error) => {
      log.error?.(`telegram-bridge: startup failed (${redactToken(error?.message ?? error)})`)
    })
    return async () => {
      lifetime.abort()
      for (const timer of turnTimers.values()) clearTimeout(timer)
      turnTimers.clear()
      interactions.dispose()
      await state.close()
      try {
        await polling
      } catch {
        // startup already reported its failure
      }
    }
  })
}
