/**
 * Human-in-the-loop interactions: approvals and structured questions routed to
 * Telegram.
 *
 * Both DSH flows are Cordis waterfalls: a listener may claim a request by
 * returning a decision, or delegate with `next()`. This module owns the pending
 * map and the chat-side UI; `index.js` implements the waterfall listeners and
 * asks this module to claim when the configured mode and desktop presence say
 * so. Every wait is bounded by the request signal, a configured timeout, and the
 * plugin lifetime, and every message is edited to its final state so a stale
 * keyboard can never send a late decision.
 */

import * as views from './views.js'

let counter = 0
function nextId(prefix) {
  counter = (counter + 1) % 999983
  return `${prefix}${counter.toString(36)}`
}

/**
 * @typedef {object} PendingApproval
 * @property {'approval'} kind
 * @property {string} id
 * @property {any} request
 * @property {any} status
 * @property {Map<string, { messageId: number, html: string }>} messages chat -> message
 * @property {boolean} settled
 * @property {((value: any) => void) | null} finish
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {number} expiresAt
 */

/**
 * @typedef {{ selected: string[], custom?: string }} QuestionAnswer
 */

/**
 * @typedef {object} PendingQuestion
 * @property {'question'} kind
 * @property {string} id
 * @property {any} request
 * @property {any} status
 * @property {Array<{ id: string, question: string, header?: string, detail?: string, options?: Array<{ label: string, description?: string }>, multiSelect?: boolean }>} questions
 * @property {QuestionAnswer[]} answers
 * @property {Map<number, Map<string, number>>} messages question index -> chat -> message id
 * @property {Set<number>} complete
 * @property {Map<number, string>} html question index -> rendered html
 * @property {boolean} settled
 * @property {((value: any) => void) | null} finish
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {number} expiresAt
 */

/**
 * @param {object} deps
 * @param {() => any} deps.apiProvider
 * @param {import('./config.js').ResolvedConfig} deps.config
 * @param {{ info?: Function, warn?: Function, error?: Function }} deps.log
 * @param {(sessionId: string) => Promise<any>} deps.statusFor
 * @param {(sessionId: string) => Array<{ chatId: string, threadId: number | null }>} deps.targets
 */
export function createInteractions(deps) {
  const { config, log } = deps
  /** @type {Map<string, PendingApproval>} */
  const approvals = new Map()
  /** @type {Map<string, PendingQuestion>} */
  const questions = new Map()
  /** @type {Map<string, { pendingId: string, questionIndex: number }>} chat id -> awaiting custom answer */
  const customWaits = new Map()

  function api() {
    return deps.apiProvider()
  }

  /**
   * @param {string} chatId
   * @param {views.MessagePart} part
   * @param {number | null} [threadId] forum topic to post into
   * @returns {Promise<number | null>} message id
   */
  async function sendPart(chatId, part, threadId = null) {
    const client = api()
    if (!client) return null
    try {
      const messageThreadId = Number.isSafeInteger(Number(threadId)) && Number(threadId) > 1 ? Number(threadId) : undefined
      const sent = await client.sendMessage({ chatId, text: part.html, keyboard: part.keyboard ?? null, messageThreadId })
      const last = Array.isArray(sent) ? sent[sent.length - 1] : sent
      return last?.message_id ?? null
    } catch (error) {
      log.warn?.(`telegram-bridge: could not send interaction message (${error?.message ?? error})`)
      return null
    }
  }

  /**
   * @param {string} chatId
   * @param {number} messageId
   * @param {string} html
   * @param {object | null} [markup]
   */
  async function editPart(chatId, messageId, html, markup = null) {
    const client = api()
    if (!client) return
    try {
      await client.editMessageText({ chatId, messageId, text: html, keyboard: markup })
    } catch (error) {
      const description = String(error?.description ?? error?.message ?? '')
      // Editing a message that is too old, deleted, or unchanged is not fatal.
      if (!/not modified|message to edit not found|MESSAGE_ID_INVALID/i.test(description)) {
        log.warn?.(`telegram-bridge: could not edit interaction message (${error?.message ?? error})`)
      }
    }
  }

  /** @param {string} sessionId */
  async function safeStatus(sessionId) {
    try {
      const status = await deps.statusFor(sessionId)
      return status ?? { id: sessionId, title: null }
    } catch {
      return { id: sessionId, title: null }
    }
  }

  /** @param {string} sessionId @returns {Array<{ chatId: string, threadId: number | null }>} */
  function chats(sessionId = '') {
    try {
      return deps.targets(sessionId)
    } catch {
      return []
    }
  }

  /**
   * Wait for a pending interaction to settle.
   * @param {PendingApproval | PendingQuestion} pending
   * @param {{ signal?: AbortSignal, timeoutMs: number }} options
   * @returns {Promise<any>}
   */
  function waitFor(pending, options) {
    return new Promise((resolve) => {
      const finish = (value) => {
        if (pending.settled) return
        pending.settled = true
        if (pending.timer !== null) clearTimeout(pending.timer)
        pending.timer = null
        options.signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => finish(null)
      pending.finish = finish
      pending.expiresAt = Date.now() + options.timeoutMs
      pending.timer = setTimeout(() => finish(null), options.timeoutMs)
      if (options.signal) {
        if (options.signal.aborted) finish(null)
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /**
   * Claim one approval request for Telegram.
   * @param {{ agent: { id: string }, toolName: string, reason?: string, signal?: AbortSignal }} request
   * @returns {Promise<'allowed-once' | 'rejected' | null>}
   */
  async function requestApproval(request) {
    const targets = chats(request.agent?.id ?? '')
    if (targets.length === 0) return null
    const pending = /** @type {PendingApproval} */ ({
      kind: 'approval',
      id: nextId('a'),
      request,
      status: await safeStatus(request.agent?.id ?? ''),
      messages: new Map(),
      settled: false,
      finish: null,
      timer: null,
      expiresAt: 0,
    })
    approvals.set(pending.id, pending)
    const [part] = views.approvalParts(pending.status, {
      approvalId: pending.id,
      toolName: request.toolName,
      reason: request.reason,
    })
    await Promise.all(targets.map(async (target) => {
      const messageId = await sendPart(target.chatId, part, target.threadId)
      if (messageId !== null) pending.messages.set(String(target.chatId), { messageId, html: part.html })
    }))
    const decision = await waitFor(pending, { signal: request.signal, timeoutMs: config.approvals.timeoutMs })
    const outcome = decision === 'allowed-once' || decision === 'rejected' ? decision : null
    const suffix = outcome === null
      ? '\n\n<i>Expired — no decision from Telegram.</i>'
      : `\n\n<b>Decision:</b> ${outcome === 'allowed-once' ? '✅ allowed once' : '⛔ denied'}`
    await Promise.all([...pending.messages].map(([chatId, ref]) => editPart(chatId, ref.messageId, `${ref.html}${suffix}`)))
    approvals.delete(pending.id)
    return outcome
  }

  /**
   * Decide one pending approval from a chat command or button.
   * @param {{ approvalId?: string, allow: boolean }} options
   * @returns {boolean}
   */
  function decideApproval(options) {
    const list = [...approvals.values()].filter((item) => !item.settled)
    if (list.length === 0) return false
    const target = options.approvalId ? list.find((item) => item.id === options.approvalId) : list[0]
    if (!target) return false
    target.finish?.(options.allow ? 'allowed-once' : 'rejected')
    return true
  }

  /**
   * Send (or re-send) one question card to every chat.
   * @param {PendingQuestion} pending
   * @param {number} qi
   * @param {string[]} targets
   * @param {{ markup?: any, note?: string }} [options]
   */
  async function sendQuestionCard(pending, qi, targets, options = {}) {
    const question = pending.questions[qi]
    const [part] = views.questionParts(pending.status, {
      question,
      index: qi,
      total: pending.questions.length,
      pendingId: pending.id,
      answered: pending.answers[qi],
    })
    const html = options.note ? `${part.html}\n\n${options.note}` : part.html
    pending.html.set(qi, html)
    const byChat = new Map()
    await Promise.all(targets.map(async (target) => {
      const messageId = await sendPart(target.chatId, { html, keyboard: part.keyboard }, target.threadId)
      if (messageId !== null) byChat.set(String(target.chatId), messageId)
    }))
    pending.messages.set(qi, byChat)
  }

  /**
   * Update one question card in every chat that received it.
   * @param {PendingQuestion} pending
   * @param {number} qi
   * @param {string} html
   * @param {object | null} markup
   */
  async function refreshQuestionCard(pending, qi, html, markup) {
    const byChat = pending.messages.get(qi)
    if (!byChat) return
    pending.html.set(qi, html)
    await Promise.all([...byChat].map(([chatId, messageId]) => editPart(chatId, messageId, html, markup)))
  }

  /**
   * Ask the next question that only accepts a typed answer.
   * @param {PendingQuestion} pending
   * @param {Array<{ chatId: string, threadId: number | null }>} targets
   */
  async function requestNextTypedAnswer(pending, targets) {
    if (pending.settled) return
    for (let qi = 0; qi < pending.questions.length; qi += 1) {
      const question = pending.questions[qi]
      if (pending.complete.has(qi)) continue
      if (Array.isArray(question.options) && question.options.length > 0) continue
      for (const target of targets) {
        customWaits.set(String(target.chatId), { pendingId: pending.id, questionIndex: qi })
        await sendPart(target.chatId, { html: `✏️ <b>Question ${qi + 1}/${pending.questions.length}</b> needs a typed answer — reply with the text.` }, target.threadId)
      }
      return
    }
  }

  /**
   * Claim one structured-question request for Telegram.
   * @param {{ agent?: { id: string }, questions: any[], signal?: AbortSignal }} request
   * @returns {Promise<{ answers: Array<{ id: string, selected: string[], custom?: string }> } | null>}
   */
  async function requestQuestions(request) {
    const targets = chats(request.agent?.id ?? '')
    if (targets.length === 0) return null
    const list = Array.isArray(request.questions) ? request.questions : []
    if (list.length === 0) return null
    const pending = /** @type {PendingQuestion} */ ({
      kind: 'question',
      id: nextId('q'),
      request,
      status: await safeStatus(request.agent?.id ?? ''),
      questions: list,
      answers: list.map(() => ({ selected: [] })),
      messages: new Map(),
      complete: new Set(),
      html: new Map(),
      settled: false,
      finish: null,
      timer: null,
      expiresAt: 0,
    })
    questions.set(pending.id, pending)
    for (let qi = 0; qi < list.length; qi += 1) await sendQuestionCard(pending, qi, targets)
    await requestNextTypedAnswer(pending, targets)
    const value = await waitFor(pending, { signal: request.signal, timeoutMs: config.questions.timeoutMs })
    const answer = value && Array.isArray(value.answers) ? value : null
    if (answer === null) {
      for (let qi = 0; qi < list.length; qi += 1) {
        const html = pending.html.get(qi)
        if (html === undefined) continue
        await refreshQuestionCard(pending, qi, `${html}\n\n<i>Expired — no answer from Telegram.</i>`, null)
      }
    }
    questions.delete(pending.id)
    for (const [chatId, wait] of customWaits) if (wait.pendingId === pending.id) customWaits.delete(chatId)
    return answer
  }

  /** @param {string | number} chatId */
  function hasCustomAnswer(chatId) {
    return customWaits.has(String(chatId))
  }

  /** @param {string | number} chatId */
  function clearCustomAnswer(chatId) {
    return customWaits.delete(String(chatId))
  }

  /**
   * Record a typed custom answer for a question that asked for one.
   * @param {string | number} chatId
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function consumeCustomAnswer(chatId, text) {
    const key = String(chatId)
    const wait = customWaits.get(key)
    if (!wait) return false
    const pending = questions.get(wait.pendingId)
    if (!pending || pending.settled) {
      customWaits.delete(key)
      return false
    }
    const qi = wait.questionIndex
    pending.answers[qi] = { selected: [], custom: String(text) }
    pending.complete.add(qi)
    customWaits.delete(key)
    const [part] = views.questionParts(pending.status, {
      question: pending.questions[qi],
      index: qi,
      total: pending.questions.length,
      pendingId: pending.id,
      answered: pending.answers[qi],
    })
    await refreshQuestionCard(pending, qi, part.html, null)
    await requestNextTypedAnswer(pending, chats(pending.request?.agent?.id ?? ''))
    await maybeSubmit(pending)
    return true
  }

  /**
   * @param {PendingQuestion} pending
   */
  async function maybeSubmit(pending) {
    if (pending.settled) return
    if (pending.complete.size < pending.questions.length) return
    const answers = pending.questions.map((question, index) => {
      const answer = pending.answers[index] ?? { selected: [] }
      return {
        id: question.id,
        selected: [...(answer.selected ?? [])],
        ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
      }
    })
    pending.finish?.({ answers })
  }

  /**
   * Handle a `qa:<pendingId>:<questionIndex>:<action>` callback.
   * @param {{ chatId: string | number, pendingId: string, questionIndex: number, action: string }} input
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async function handleQuestionCallback(input) {
    const chatId = String(input.chatId)
    const pending = questions.get(input.pendingId)
    if (!pending || pending.settled) return { ok: false, message: 'This question already expired.' }
    const qi = input.questionIndex
    const question = pending.questions[qi]
    if (!question) return { ok: false, message: 'Unknown question.' }
    const options = Array.isArray(question.options) ? question.options : []
    if (input.action === 'other') {
      customWaits.set(chatId, { pendingId: pending.id, questionIndex: qi })
      const [part] = views.questionParts(pending.status, {
        question,
        index: qi,
        total: pending.questions.length,
        pendingId: pending.id,
        answered: pending.answers[qi],
      })
      await refreshQuestionCard(pending, qi, `${part.html}\n\n<i>✏️ Reply with the answer text.</i>`, part.keyboard)
      return { ok: true, message: 'Reply with the answer text.' }
    }
    if (input.action === 'done') {
      const current = pending.answers[qi] ?? { selected: [] }
      if (current.selected.length === 0 && current.custom === undefined) return { ok: false, message: 'Select at least one option first.' }
      pending.complete.add(qi)
    } else {
      const optionIndex = Number.parseInt(input.action, 10)
      const option = options[optionIndex]
      if (!option) return { ok: false, message: 'Unknown option.' }
      const current = pending.answers[qi] ?? { selected: [] }
      if (question.multiSelect) {
        const has = current.selected.includes(option.label)
        pending.answers[qi] = {
          selected: has ? current.selected.filter((label) => label !== option.label) : [...current.selected, option.label],
        }
      } else {
        pending.answers[qi] = { selected: [option.label] }
        pending.complete.add(qi)
      }
    }
    const [part] = views.questionParts(pending.status, {
      question,
      index: qi,
      total: pending.questions.length,
      pendingId: pending.id,
      answered: pending.answers[qi],
    })
    const finished = pending.complete.has(qi) || !question.multiSelect
    await refreshQuestionCard(pending, qi, part.html, finished ? null : part.keyboard)
    await maybeSubmit(pending)
    return { ok: true }
  }

  /**
   * @returns {Array<{ id: string, kind: 'approval' | 'question', title: string, summary: string, expiresInMs: number }>}
   */
  function listPending() {
    const out = []
    for (const item of approvals.values()) {
      if (item.settled) continue
      out.push({
        id: item.id,
        kind: 'approval',
        title: item.status?.title ?? item.request?.agent?.id ?? 'session',
        summary: `approval for ${item.request?.toolName ?? 'tool'}`,
        expiresInMs: Math.max(0, item.expiresAt - Date.now()),
      })
    }
    for (const item of questions.values()) {
      if (item.settled) continue
      out.push({
        id: item.id,
        kind: 'question',
        title: item.status?.title ?? 'session',
        summary: `${item.questions.length} question(s), ${item.complete.size} answered`,
        expiresInMs: Math.max(0, item.expiresAt - Date.now()),
      })
    }
    return out
  }

  /** Resolve every wait as delegated and clear the maps (plugin teardown). */
  function dispose() {
    for (const item of approvals.values()) item.finish?.(null)
    for (const item of questions.values()) item.finish?.(null)
    approvals.clear()
    questions.clear()
    customWaits.clear()
  }

  return {
    requestApproval,
    requestQuestions,
    decideApproval,
    handleQuestionCallback,
    hasCustomAnswer,
    clearCustomAnswer,
    consumeCustomAnswer,
    listPending,
    dispose,
  }
}
