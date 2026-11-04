/**
 * Telegram message rendering.
 *
 * Every builder returns one or more "parts" — a self-contained HTML fragment
 * that fits in a Telegram message (Telegram HTML), optionally carrying its own
 * reply markup. Building parts instead of one long string is deliberate: the
 * Bot API rejects messages whose HTML is malformed, and naive splitting can cut
 * a tag in half. Long free text is chunked *before* escaping and then wrapped in
 * its own `<pre>` block, so every part is independently valid.
 */

import { escapeHtml, formatDuration, formatRelativeTime, formatTokens, truncate } from './format.js'

/** @typedef {{ html: string, keyboard?: { inline_keyboard: Array<Array<{ text: string, callback_data?: string, url?: string }>> } }} MessagePart */

const RUNNING = '🔄'
const IDLE = '💤'
const REASON_EMOJI = {
  completed: '✅',
  error: '❌',
  aborted: '⏹️',
  blocked: '⛔',
  'max-tokens': '✂️',
  interrupted: '⏸️',
  forked: '🌱',
  open: '⏳',
}

const REASON_LABEL = {
  completed: 'completed',
  error: 'failed',
  aborted: 'stopped',
  blocked: 'blocked',
  'max-tokens': 'hit max tokens',
  interrupted: 'interrupted',
  forked: 'forked',
  open: 'running',
}

/** Escape then truncate — order matters so cut text never contains a half entity. */
function clip(value, maxChars) {
  return truncate(String(value ?? ''), maxChars)
}

/** @param {unknown} value */
function esc(value) {
  return escapeHtml(value)
}

/** @param {unknown} value */
function code(value) {
  return `<code>${esc(value)}</code>`
}

/** @param {string} raw */
function pre(raw) {
  return `<pre>${esc(raw)}</pre>`
}

/**
 * @param {Array<Array<{ text: string, callback_data?: string } | null> | null>} rows
 */
function keyboard(rows) {
  const cleaned = rows
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => row.filter(Boolean))
    .filter((row) => row.length > 0)
  return cleaned.length === 0 ? undefined : { inline_keyboard: cleaned }
}

/**
 * @param {string} text
 * @param {string} data
 */
function btn(text, data) {
  return { text, callback_data: data }
}

/** @param {{ id?: string, title?: string | null }} statusLike */
function titleOf(statusLike) {
  const title = typeof statusLike?.title === 'string' && statusLike.title.trim() !== '' ? statusLike.title.trim() : ''
  if (title !== '') return title
  const id = String(statusLike?.id ?? statusLike?.sessionId ?? '')
  return id === '' ? 'Untitled session' : `Session ${id.slice(0, 14)}…`
}

/** @param {string | null | undefined} path */
function dirName(path) {
  if (typeof path !== 'string' || path === '') return ''
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/** @param {string | null | undefined} path */
function displayDir(path) {
  if (typeof path !== 'string' || path === '') return 'unknown directory'
  const base = dirName(path)
  return base === '' ? path : base
}

/**
 * @param {number} count
 * @param {string} [label]
 */
function plural(count, label) {
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

/**
 * @param {{ startedAt?: number | null, endedAt?: number | null }} turn
 */
function turnDurationMs(turn) {
  if (!Number.isFinite(turn?.startedAt)) return null
  const end = Number.isFinite(turn?.endedAt) ? turn.endedAt : Date.now()
  return Math.max(0, end - /** @type {number} */ (turn.startedAt))
}

/**
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number, total?: number } | null | undefined} usage
 * @returns {string}
 */
function usageLine(usage) {
  if (!usage) return ''
  const input = Number(usage.input ?? 0)
  const output = Number(usage.output ?? 0)
  const cache = Number(usage.cacheRead ?? 0)
  const pieces = [`↑${formatTokens(input)}`, `↓${formatTokens(output)}`]
  if (cache > 0) pieces.push(`cache ${formatTokens(cache)}`)
  return `${pieces.join(' · ')} tokens`
}

/** @param {string} sessionId */
function shortSession(sessionId) {
  const text = String(sessionId ?? '')
  const stripped = text.startsWith('session-') ? text.slice('session-'.length) : text
  return stripped.slice(0, 8)
}

/**
 * Split raw text into pieces whose *escaped* form fits one Telegram message.
 * Chunking before escaping is not enough: `&`, `<` and `>` expand up to 5x, so
 * a raw 2800-char chunk can exceed Telegram's 4096-char limit after escaping.
 * This walks code points and cuts on the escaped-size budget, which also keeps
 * every message a self-contained, valid `<pre>` block.
 *
 * @param {string} raw
 * @param {number} escapedBudget max escaped characters per chunk
 * @returns {string[]}
 */
function escapeSafeChunks(raw, escapedBudget) {
  /** @type {string[]} */
  const chunks = []
  let rest = raw
  const budget = Math.max(16, escapedBudget)
  while (rest.length > 0) {
    let escapedLength = 0
    let cut = 0
    for (const character of rest) {
      // escapeHtml turns & < > into 5/4/4 characters.
      const cost = character === '&' ? 5 : character === '<' || character === '>' ? 4 : character.length
      if (escapedLength + cost > budget) break
      escapedLength += cost
      cut += character.length
    }
    // A single entity worth more than the whole budget still has to move.
    if (cut === 0) cut = rest.codePointAt(0) !== undefined && rest.codePointAt(0) > 0xffff ? 2 : 1
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return chunks
}

/**
 * Split a long raw text into Telegram-safe `<pre>` parts.
 * @param {string} text
 * @param {{ maxChunk?: number, maxTotal?: number }} [options]
 * @returns {string[]}
 */
export function preChunks(text, options = {}) {
  const escapedBudget = options.maxChunk ?? 3400
  const maxTotal = options.maxTotal ?? 12000
  const raw = String(text ?? '')
  if (raw.trim() === '') return []
  const clipped = raw.length > maxTotal ? `${truncate(raw, maxTotal, '\n… (truncated)')}` : raw
  return escapeSafeChunks(clipped, escapedBudget).map((chunk) => pre(chunk))
}

/**
 * @param {string} html
 * @param {MessagePart['keyboard']} [markup]
 * @returns {MessagePart}
 */
export function textPart(html, markup) {
  return markup === undefined ? { html } : { html, keyboard: markup }
}

/**
 * @param {string} action
 * @param {string} reason
 * @param {number} turn
 * @param {number | null} durationMs
 */
function turnHeadline(action, reason, turn, durationMs) {
  const emoji = REASON_EMOJI[reason] ?? 'ℹ️'
  const label = REASON_LABEL[reason] ?? reason
  const timing = durationMs === null ? '' : ` · ${formatDuration(durationMs)}`
  return `${emoji} <b>${esc(action)}</b> · turn ${turn} ${esc(label)}${timing}`
}

/**
 * @param {{ id?: string, sessionId?: string }} [like]
 * @param {{ url?: string | null }} [options]
 */
function sessionFooter(like, options = {}) {
  const id = String(like?.id ?? like?.sessionId ?? '')
  const lines = id === '' ? [] : [`<i>${code(id)}</i>`]
  if (options.url) lines.push(`<a href="${esc(options.url)}">Open DSH</a>`)
  return lines.length === 0 ? '' : `\n${lines.join(' · ')}`
}

/**
 * @param {string} sessionId
 * @param {{ result?: boolean, review?: boolean, status?: boolean }} flags
 */
function sessionActionKeyboard(sessionId, flags = {}) {
  const id = String(sessionId ?? '')
  if (id === '') return undefined
  const row = []
  if (flags.result !== false) row.push(btn('🧾 Result', `r:${id}`))
  if (flags.review !== false) row.push(btn('🔍 Review', `v:${id}`))
  if (flags.status !== false) row.push(btn('📊 Status', `t:${id}`))
  return keyboard([row])
}

const HELP_HTML = [
  '<b>DeepSeek Harness from Telegram</b>',
  'Pick a session, watch runs, read results and review them — no desktop needed.',
  '',
  '<b>Sessions</b>',
  '/sessions — list sessions (tap one to select)',
  '/use &lt;number | id | title&gt; — select a session',
  '/status — selected session status',
  '/result [turns] — latest assistant answer(s)',
  '/files — resend media/documents from the last turn',
  '/review — answer + tool calls + changed files',
  '/tail [turns] — compact recent-turn overview',
  '/controls — every session action as buttons (⚙️ All controls)',
  '/new [absolute cwd] — create a session and select it',
  '/topic [rename &lt;name&gt; | sync | close | reopen] — manage the session topic',
  '/rename &lt;title&gt; — rename the selected session',
  '',
  '<b>Talk to the agent</b>',
  'Send any plain text — it becomes a prompt in the selected session.',
  'Reply to a session message (notification/status) to target that session.',
  'Send a voice note — it is transcribed locally and sent as your prompt.',
  '/say &lt;text&gt; — same, explicit',
  '/steer &lt;text&gt; — interrupt-adjacent steering message',
  '/stop — stop the running turn',
  '',
  '<b>Human-in-the-loop</b>',
  '/pending — open approvals / questions',
  '/approve [id] — allow the oldest pending approval',
  '/deny [id] — reject it',
  'Any question with options can be answered by tapping its buttons.',
  '',
  '<b>Notifications</b>',
  '/notify on | off — toggle push notifications',
  '/notify all | current — notify for every session or only the selected one',
  '',
  '<b>Other</b>',
  '/whoami — chat id and bridge settings',
  '/help — this message',
].join('\n')

/**
 * @param {import('./config.js').ResolvedConfig} config
 * @returns {MessagePart[]}
 */
export function helpParts(config) {
  const rows = [[btn('📋 Sessions', 'ss')]]
  return [textPart(HELP_HTML, keyboard(rows))]
}

/**
 * @param {{ chatId: string, userId: string, username?: string | null, allowedIds: string[] }} info
 * @returns {MessagePart[]}
 */
export function pairingParts(info) {
  const html = [
    '<b>Pairing required</b>',
    'This bot is not authorized for this chat yet. Send these ids to the operator:',
    '',
    `• chat id: ${code(info.chatId)}`,
    `• user id: ${code(info.userId)}${info.username ? ` (@${esc(info.username)})` : ''}`,
    '',
    'Add the chat id under <code>allowedChatIds</code> in the <code>telegram-bridge</code> row of the profile patch and restart dsh.',
    info.allowedIds.length === 0 ? '\n<i>No chats are authorized yet.</i>' : '',
  ].join('\n')
  return [textPart(html)]
}

/**
 * @param {Array<{ id: string, title: string | null, running: boolean, cwd: string | null, updatedAt: number, parentSessionId?: string | null, origin?: string | null }>} sessions
 * @param {{ page?: number, pageSize?: number, currentSessionId?: string | null,
 *           forum?: boolean, boundSessionIds?: string[] }} [options]
 * @returns {MessagePart[]}
 */
export function sessionsParts(sessions, options = {}) {
  const pageSize = options.pageSize ?? 8
  const page = Math.max(0, options.page ?? 0)
  const start = page * pageSize
  const slice = sessions.slice(start, start + pageSize)
  const total = sessions.length
  const bound = new Set(Array.isArray(options.boundSessionIds) ? options.boundSessionIds : [])
  const lines = [`<b>Sessions</b> · ${plural(total, 'session')}`]
  if (total === 0) {
    lines.push('', 'No sessions yet. Create one with /new or in the DSH app.')
  } else if (options.forum) {
    lines.push('', '<i>Tap a session to open its topic, or use 🧵 Create topics below.</i>')
  }
  const rows = []
  for (let i = 0; i < slice.length; i += 1) {
    const session = slice[i]
    const index = start + i
    const current = options.currentSessionId && options.currentSessionId === session.id
    const dot = session.running ? RUNNING : IDLE
    const sub = [
      session.archived ? 'archived' : null,
      session.parentSessionId ? 'subagent' : null,
      displayDir(session.cwd),
      formatRelativeTime(session.updatedAt),
    ].filter(Boolean).join(' · ')
    const marker = current ? '▸ ' : ''
    const topicMark = bound.has(session.id) ? '🧵 ' : ''
    lines.push(`${marker}${topicMark}${index + 1}. ${dot} <b>${esc(clip(titleOf(session), 60))}</b>`, `   <i>${esc(sub)}</i>`)
    const label = `${topicMark}${index + 1}${session.running ? ' ▶' : ''} ${clip(titleOf(session), 24)}`
    const entry = btn(label, `sel:${index}`)
    if (i % 2 === 0) rows.push([entry])
    else rows[rows.length - 1].push(entry)
  }
  const navigation = []
  if (page > 0) navigation.push(btn('◀ Prev', `pg:${page - 1}`))
  if (start + pageSize < total) navigation.push(btn('Next ▶', `pg:${page + 1}`))
  if (navigation.length > 0) rows.push(navigation)
  if (options.forum && slice.length > 0) rows.push([btn('🧵 Create topics', `tps:${page}`)])
  rows.push([btn('🔄 Refresh', 'ss'), btn('➕ New session', 'new')])
  return [textPart(lines.join('\n'), keyboard(rows))]
}

/**
 * @param {object} status
 * @param {{ url?: string | null, titleChars?: number }} [options]
 * @returns {MessagePart[]}
 */
export function statusParts(status, options = {}) {
  const titleChars = options.titleChars ?? 48
  const lines = [
    `${status.running ? RUNNING : IDLE} <b>${esc(clip(titleOf(status), titleChars))}</b>`,
    `<i>${esc(String(status.cwd ?? 'unknown directory'))}</i>`,
    '',
  ]
  if (status.lastTurn !== null && status.lastTurn !== undefined) lines.push(`• Turn: ${status.lastTurn}${status.turns ? ` of ${status.turns}` : ''}${status.steps ? ` · ${plural(status.steps, 'step')}` : ''}`)
  else if (status.turns) lines.push(`• Turns: ${status.turns}${status.steps ? ` · ${plural(status.steps, 'step')}` : ''}`)
  lines.push(`• State: ${status.running ? 'running' : 'idle'}`)
  if (status.model) lines.push(`• Model: ${code(status.model)}${status.reasoningEffort ? ` (${esc(status.reasoningEffort)})` : ''}`)
  if (status.preset) lines.push(`• Preset: ${esc(status.preset)}`)
  if (status.usage) {
    const usage = `↑${formatTokens(status.usage.input ?? 0)} ↓${formatTokens(status.usage.output ?? 0)}`
    const cached = Number(status.usage.cacheRead ?? 0)
    lines.push(`• Tokens: ${usage}${cached > 0 ? ` · cache ${formatTokens(cached)}` : ''}`)
  }
  if (Number.isFinite(status.contextTokens) && Number.isFinite(status.contextWindow) && status.contextWindow > 0) {
    const percent = Math.round((status.contextTokens / status.contextWindow) * 100)
    lines.push(`• Context: ${formatTokens(status.contextTokens)} / ${formatTokens(status.contextWindow)} (${percent}%)`)
  }
  if (status.approvalPolicy || status.sandbox) {
    lines.push(`• Policy: ${esc(status.approvalPolicy ?? 'ask')} approval · ${esc(status.sandbox ?? 'unknown')} sandbox`)
  }
  lines.push(`• Activity: ${formatRelativeTime(status.updatedAt ?? Date.now())}`)
  lines.push(sessionFooter(status, options))
  const rows = [[btn('🧾 Result', 'rs'), btn('🔍 Review', 'rv'), btn('📋 Sessions', 'ss')]]
  if (status.running) rows[0].push(btn('⏹ Stop', 'stop'))
  rows.push([btn('⚙️ All controls', 'more'), btn('🔄 Refresh', 'st'), btn('🔔 Notifications', 'nt')])
  return [textPart(lines.join('\n'), keyboard(rows))]
}

/**
 * Full session control surface: every action available from the session card,
 * including the text-entry ones that ask for the next chat message.
 * @param {object} status
 * @param {{ url?: string | null, notifications?: boolean, notifyMode?: 'current' | 'all' }} [options]
 * @returns {MessagePart[]}
 */
export function controlsParts(status, options = {}) {
  const notifications = options.notifications === false
    ? 'off'
    : options.notifyMode === 'all' ? 'all sessions' : 'selected session'
  const lines = [
    `🎛️ <b>All controls</b> · ${esc(clip(titleOf(status), 48))}`,
    `<i>Notifications: ${esc(notifications)}</i>`,
    '',
    '<i>Buttons with … ask for the text as your next message; send /cancel to abort.</i>',
  ]
  const rows = [
    [btn('📊 Status', 'st'), btn('🧾 Result', 'rs'), btn('🔍 Review', 'rv'), btn('🧵 Tail', 'tail')],
    [btn('📎 Files', 'files'), btn('✍️ Say…', 'say'), btn('😤 Steer…', 'steer'), btn('✏️ Rename…', 'rename')],
    [btn('⏹ Stop', 'stop'), btn('📋 Sessions', 'ss'), btn('⏳ Pending', 'pending'), btn('➕ New', 'new'), btn('❓ Help', 'help')],
    [btn('🔔 Notify all', 'nf:all'), btn('🔔 Notify selected', 'nf:cur'), btn('🔕 Notify off', 'nf:off')],
    [btn('👤 Whoami', 'who'), btn('🩺 Debug', 'dbg'), btn('🔄 Refresh', 'more')],
  ]
  return [textPart(lines.join('\n'), keyboard(rows)), textPart(sessionFooter(status, { url: options.url }))]
}

/**
 * @param {any} turnView
 * @param {{ titleChars?: number, url?: string | null, maxTurns?: number }} [options]
 * @returns {MessagePart[]}
 */
export function resultParts(turnView, options = {}) {
  const session = turnView ?? {}
  const turns = Array.isArray(session.turns) ? session.turns : []
  /** @type {MessagePart[]} */
  const parts = []
  if (turns.length === 0) {
    return [textPart(`<b>Result</b> · ${esc(clip(titleOf(session), options.titleChars ?? 48))}\n\nNo turns recorded yet.`)]
  }
  const shown = turns.slice(-Math.max(1, Math.min(turns.length, options.maxTurns ?? 1)))
  const heading = shown.length === 1 ? '<b>Result</b>' : `<b>Last ${shown.length} results</b>`
  parts.push(textPart(`${heading} · ${esc(clip(titleOf(session), options.titleChars ?? 48))}`))
  for (const turn of shown) {
    const duration = turnDurationMs(turn)
    parts.push(textPart(turnHeadline('Turn', turn.endReason ?? 'unknown', turn.turn, duration)))
    if (Array.isArray(turn.tools) && turn.tools.length > 0) {
      const failed = turn.tools.filter((tool) => !tool.ok).length
      parts.push(textPart(`<i>${plural(turn.tools.length, 'tool call')}${failed > 0 ? ` · ${failed} failed` : ''}</i>`))
    }
    const text = typeof turn.assistantText === 'string' ? turn.assistantText.trim() : ''
    if (text === '') {
      parts.push(textPart(`<i>No assistant text in this turn${turn.errorMessage ? `: ${esc(clip(turn.errorMessage, 300))}` : ''}.</i>`))
    } else {
      for (const html of preChunks(text, { maxTotal: 12000 })) parts.push(textPart(html))
    }
    const usage = usageLine(turn.usage)
    if (usage) parts.push(textPart(`<i>${esc(usage)}</i>`))
  }
  const summary = []
  const last = shown[shown.length - 1]
  if (last?.changes) summary.push(`Changed ${plural(last.changes.total ?? last.changes.files?.length ?? 0, 'file')} (+${last.changes.added ?? 0} −${last.changes.deleted ?? 0})`)
  if (summary.length > 0) parts.push(textPart(`<i>${esc(summary.join(' · '))}</i>`))
  const lastPart = parts[parts.length - 1]
  const markup = sessionActionKeyboard(session.id, { result: false })
  if (markup) lastPart.keyboard = markup
  parts.push(textPart(sessionFooter(session, { url: options.url })))
  return parts
}

/**
 * @param {any} turnView
 * @param {{ url?: string | null }} [options]
 * @returns {MessagePart[]}
 */
export function reviewParts(turnView, options = {}) {
  const session = turnView ?? {}
  const turns = Array.isArray(session.turns) ? session.turns : []
  const turn = turns[turns.length - 1]
  if (!turn) return [textPart(`<b>Review</b> · ${esc(titleOf(session))}\n\nNo turns recorded yet.`)]
  const parts = []
  const duration = turnDurationMs(turn)
  parts.push(textPart(`🔍 <b>Review</b> · ${esc(clip(titleOf(session), 48))}\n${turnHeadline('Turn', turn.endReason ?? 'unknown', turn.turn, duration)}`))
  if (turn.errorMessage) parts.push(textPart(`<b>Error</b>\n${pre(clip(turn.errorMessage, 900))}`))
  const prompt = String(turn.userText ?? '').trim()
  if (prompt !== '') {
    parts.push(textPart('<b>Request</b>'))
    const chunks = preChunks(prompt, { maxTotal: 4000 })
    if (chunks.length === 0) parts.push(textPart(`<i>${esc(clip(prompt, 300))}</i>`))
    for (const html of chunks) parts.push(textPart(html))
  }
  const answer = String(turn.assistantText ?? '').trim()
  if (answer !== '') {
    parts.push(textPart('<b>Answer</b>'))
    for (const html of preChunks(answer, { maxTotal: 9000 })) parts.push(textPart(html))
  }
  const tools = Array.isArray(turn.tools) ? turn.tools : []
  if (tools.length > 0) {
    parts.push(textPart(`<b>Tool calls</b> · ${tools.length}`))
    const lines = []
    for (let i = 0; i < tools.length; i += 1) {
      const tool = tools[i]
      const mark = tool.ok ? '✅' : '❌'
      lines.push(`${i + 1}. ${mark} ${code(tool.name ?? 'tool')}${tool.argsPreview ? ` — <i>${esc(clip(tool.argsPreview, 110))}</i>` : ''}`)
      if (tool.error) lines.push(`   ⚠ ${esc(clip(tool.error, 160))}`)
      else if (tool.resultPreview) lines.push(`   ↳ ${esc(clip(tool.resultPreview, 160))}`)
    }
    parts.push(textPart(lines.join('\n')))
  }
  if (turn.changes) {
    const changes = turn.changes
    const files = Array.isArray(changes.files) ? changes.files : []
    const header = `<b>Changed files</b> · ${changes.total ?? files.length} (+${changes.added ?? 0} −${changes.deleted ?? 0})`
    parts.push(textPart(header))
    if (files.length === 0) parts.push(textPart('<i>No files changed.</i>'))
    const listed = files.slice(0, 25)
    const lines = listed.map((file) => {
      const mark = file.binary ? '◼' : file.oversized ? '◻' : ''
      return `• ${code(file.display ?? file.path)}${file.binary || file.oversized ? ` ${mark}` : ` +${file.added ?? 0} −${file.deleted ?? 0}`}`
    })
    if (files.length > listed.length) lines.push(`<i>…and ${files.length - listed.length} more</i>`)
    parts.push(textPart(lines.join('\n')))
  }
  const usage = usageLine(turn.usage)
  if (usage || duration !== null) {
    const meta = [duration === null ? null : formatDuration(duration), usage || null].filter(Boolean).join(' · ')
    parts.push(textPart(`<i>${esc(meta)}</i>`))
  }
  parts.push(textPart(sessionFooter(session, { url: options.url })))
  const markup = sessionActionKeyboard(session.id, { review: false })
  if (markup) parts[parts.length - 1].keyboard = markup
  return parts
}

/**
 * @param {any} turnView
 * @param {{ url?: string | null }} [options]
 * @returns {MessagePart[]}
 */
export function tailParts(turnView, options = {}) {
  const session = turnView ?? {}
  const turns = Array.isArray(session.turns) ? session.turns : []
  const lines = [`<b>Recent turns</b> · ${esc(clip(titleOf(session), 48))}`, '']
  if (turns.length === 0) lines.push('<i>No turns recorded yet.</i>')
  for (const turn of turns) {
    const emoji = REASON_EMOJI[turn.endReason ?? 'open'] ?? 'ℹ️'
    const when = Number.isFinite(turn.endedAt) ? formatRelativeTime(turn.endedAt) : 'running'
    lines.push(`${emoji} <b>#${turn.turn}</b> · ${esc(when)} · ${plural(turn.tools?.length ?? 0, 'tool')}`)
    if (turn.userText) lines.push(`   👤 ${esc(clip(String(turn.userText).replace(/\s+/g, ' '), 160))}`)
    if (turn.assistantText) lines.push(`   🤖 ${esc(clip(String(turn.assistantText).replace(/\s+/g, ' '), 220))}`)
    else if (turn.errorMessage) lines.push(`   ⚠ ${esc(clip(turn.errorMessage, 220))}`)
  }
  const parts = [textPart(lines.join('\n'))]
  const markup = sessionActionKeyboard(session.id, { result: false, review: false })
  if (markup) parts[parts.length - 1].keyboard = markup
  return parts
}

/**
 * Turn-finished notification. The final assistant message is delivered in full
 * (split into several Telegram messages when long); `snippetChars > 0` keeps the
 * old truncated behaviour for users who prefer compact pushes.
 *
 * @param {any} status
 * @param {{ turn: number, reason: string, sessionId: string, url?: string | null, snippetChars?: number, turnView?: any }} options
 * @returns {MessagePart[]}
 */
export function turnEndParts(status, options) {
  const turn = options.turnView?.turns?.[options.turnView.turns.length - 1]
  const duration = turn ? turnDurationMs(turn) : null
  const head = turnHeadline('Turn finished', options.reason ?? 'completed', options.turn, duration)
  const header = [`${head} · ${esc(clip(titleOf(status), 48))}`]
  if (options.reason === 'error') {
    const error = turn?.errorMessage
    if (error) header.push(pre(clip(error, 900)))
  }
  // Usage and the session link belong to the header: a separate "footer" bubble
  // would arrive as a pointless one-line message after the answer chunks.
  const usage = usageLine(turn?.usage)
  if (usage) header.push(`<i>${esc(usage)}</i>`)
  const footer = sessionFooter(status, { url: options.url })
  if (footer !== '') header.push(footer)
  /** @type {MessagePart[]} */
  const parts = [textPart(header.join('\n'))]
  const answer = String(turn?.assistantText ?? '').trim()
  const limit = Number.isFinite(Number(options.snippetChars)) ? Number(options.snippetChars) : 0
  if (answer !== '') {
    const chunks = preChunks(answer, { maxTotal: limit > 0 ? limit : Number.POSITIVE_INFINITY, maxChunk: 3500 })
    for (const html of chunks) parts.push(textPart(html))
  }
  const markup = sessionActionKeyboard(options.sessionId)
  if (markup) parts[parts.length - 1].keyboard = markup
  return parts
}

/**
 * @param {any} status
 * @param {{ turn: number, sessionId: string, url?: string | null }} options
 * @returns {MessagePart[]}
 */
export function sessionStartedParts(status, options) {
  const lines = [
    `${RUNNING} <b>Turn started</b> · turn ${options.turn} · ${esc(clip(titleOf(status), 48))}`,
    `<i>${esc(displayDir(status?.cwd))} · ${formatRelativeTime(Date.now())}</i>`,
    sessionFooter(status, { url: options.url }),
  ]
  return [textPart(lines.join('\n'))]
}

/**
 * @param {any} status
 * @param {{ message: string, sessionId: string, url?: string | null }} options
 * @returns {MessagePart[]}
 */
export function agentErrorParts(status, options) {
  const lines = [
    `❌ <b>Agent error</b> · ${esc(clip(titleOf(status), 48))}`,
    pre(clip(options.message, 900)),
    sessionFooter(status, { url: options.url }),
  ]
  const parts = [textPart(lines.join('\n'))]
  const markup = sessionActionKeyboard(options.sessionId, { result: false })
  if (markup) parts[parts.length - 1].keyboard = markup
  return parts
}

/**
 * @param {any} status
 * @param {{ approvalId: string, toolName: string, reason?: string | null, url?: string | null }} options
 * @returns {MessagePart[]}
 */
export function approvalParts(status, options) {
  const lines = [
    '🔐 <b>Approval requested</b>',
    `Session: <b>${esc(clip(titleOf(status), 48))}</b>`,
    `Tool: ${code(options.toolName ?? 'unknown')}`,
  ]
  if (options.reason) lines.push(`Reason: ${esc(clip(options.reason, 400))}`)
  lines.push('', '<i>Tap a decision — it is applied to the waiting tool call.</i>')
  const markup = keyboard([[btn('✅ Allow once', `ap:${options.approvalId}:allow`), btn('⛔ Deny', `ap:${options.approvalId}:deny`)]])
  return [textPart(lines.join('\n'), markup)]
}

/**
 * @param {any} status
 * @param {{ question: { id: string, question: string, header?: string, detail?: string, options?: Array<{ label: string, description?: string }>, multiSelect?: boolean }, index: number, total: number, pendingId: string, answered?: { selected?: string[], custom?: string } | null }} options
 * @returns {MessagePart[]}
 */
export function questionParts(status, options) {
  const question = options.question
  const lines = [
    `❓ <b>Question ${options.index + 1}/${options.total}</b> · ${esc(clip(titleOf(status), 48))}`,
  ]
  if (question.header) lines.push(`<b>${esc(question.header)}</b>`)
  lines.push(`<b>${esc(clip(question.question, 900))}</b>`)
  if (question.detail) lines.push('', pre(clip(question.detail, 1500)))
  const options_ = Array.isArray(question.options) ? question.options : []
  const rows = []
  if (options_.length > 0) {
    lines.push('')
    for (let i = 0; i < options_.length; i += 1) {
      const option = options_[i]
      const prefix = String.fromCharCode(65 + (i % 26))
      const selected = options.answered?.selected?.includes(option.label) ? '✅ ' : ''
      lines.push(`${prefix}) ${selected}${esc(clip(option.label, 120))}${option.description ? ` — <i>${esc(clip(option.description, 120))}</i>` : ''}`)
      rows.push([btn(`${prefix} ${clip(option.label, 40)}`, `qa:${options.pendingId}:${options.index}:${i}`)])
    }
    if (question.multiSelect) rows.push([btn('✅ Done', `qa:${options.pendingId}:${options.index}:done`)])
  }
  if (options.answered && (options.answered.selected?.length || options.answered.custom)) {
    const answerText = options.answered.custom ?? (options.answered.selected ?? []).join(', ')
    lines.push('', `<b>Your answer:</b> ${esc(clip(answerText, 300))}`)
  }
  rows.push([btn('✏️ Other / custom answer', `qa:${options.pendingId}:${options.index}:other`)])
  return [textPart(lines.join('\n'), keyboard(rows))]
}

/**
 * @param {string} html
 * @returns {MessagePart}
 */
export function plainPart(html) {
  return { html }
}

/**
 * @param {any} status
 * @param {{ session: any, kind: 'approval' | 'question', url?: string | null }} options
 * @returns {MessagePart[]}
 */
export function remoteInteractionNotice(status, options) {
  const what = options.kind === 'approval' ? 'approval request' : 'question'
  return [textPart(
    `ℹ️ An ${what} is waiting in DSH · ${esc(clip(titleOf(status), 48))}\n` +
    `<i>A desktop client is connected, so answer it there (or set the bridge mode to “telegram” to answer from here).</i>` +
    sessionFooter(status, { url: options.url }),
  )]
}
