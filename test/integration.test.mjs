/**
 * End-to-end tests for the Telegram bridge plugin.
 *
 * These drive the real `apply()` with the real command router, interactions,
 * state store and DSH bridge, against a fake Telegram Bot API and a fake Host
 * context. Nothing here talks to the network, Telegram, or the live DSH profile.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import {
  assistantMessage,
  createFakeHost,
  sessionEvent,
  toolCall,
  toolResult,
  turnEnd,
  turnStart,
  userMessage,
  waitUntil,
  workspaceChanges,
} from './fake-ctx.mjs'
import { startFakeTelegram } from './fake-telegram.mjs'

const TOKEN = '123456:TEST-TOKEN-abcdefghijklmnopqrstuvwxyz'
const CHAT = '777'
const ALPHA = 'session-alpha-0001'

/**
 * @param {object} [overrides] plugin config overrides
 * @param {object} [hostOptions] fake Host capabilities (e.g. `voice`)
 */
async function setup(overrides = {}, hostOptions = {}) {
  const telegram = await startFakeTelegram({ token: TOKEN, longPollDelayMs: 250 })
  const host = createFakeHost(hostOptions)
  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-telegram-bridge-test-'))
  const statePath = join(stateDirectory, 'state.json')
  host.addSession({
    id: ALPHA,
    title: 'Alpha task',
    cwd: 'C:\\work\\alpha',
    updatedAt: Date.now() - 60_000,
    running: false,
    projections: {
      title: 'Alpha task',
      workingDirectory: 'C:\\work\\alpha',
      tokenUsage: { totals: { uncachedInputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheWriteTokens: 0 } },
      sessionStats: { turns: 1, steps: 4, lastTurn: 1 },
      turnOutline: { turns: [{ turn: 1, seq: 5, prompt: 'Build the thing', response: 'Hello from the agent.' }] },
      modelSelection: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } },
      permissions: { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
      contextPressure: { surfaceTokens: 12000, contextWindow: 1_000_000 },
    },
    events: [
      turnStart(1, 1),
      userMessage(2, 1, 1, 'Build the thing'),
      assistantMessage(3, 1, 1, 'Hello from the agent.', { inputTokens: 1200, outputTokens: 340 }),
      toolCall(4, 1, 1, { callId: 'call-1', name: 'pwsh', args: '{"command":"npm test"}' }),
      toolResult(5, 1, 1, { callId: 'call-1', text: 'all tests passed' }),
      workspaceChanges(6, 1),
      turnEnd(7, 1, 'completed'),
    ],
  })
  host.addSession({
    id: 'session-beta-0002',
    title: 'Beta task',
    cwd: 'C:\\work\\beta',
    updatedAt: Date.now() - 120_000,
    running: false,
    projections: { title: 'Beta task' },
    events: [turnStart(1, 1), userMessage(2, 1, 1, 'Other work'), turnEnd(3, 1, 'completed')],
  })
  // Child-agent session: hidden from the picker unless configured otherwise.
  host.addSession({
    id: 'session-subagent-0009',
    title: 'Subagent Task',
    cwd: 'C:\\work\\alpha',
    updatedAt: Date.now() - 10_000,
    origin: 'subagent',
    parentSessionId: ALPHA,
    events: [turnStart(1, 1), turnEnd(2, 1, 'completed')],
  })
  // Archived session: hidden from the picker unless configured otherwise.
  host.addSession({
    id: 'session-archived-0008',
    title: 'Archived task',
    cwd: 'C:\\work\\old',
    updatedAt: Date.now() - 30_000,
    events: [turnStart(1, 1), turnEnd(2, 1, 'completed')],
  })
  host.setArchivedSessionIds(['session-archived-0008'])
  host.setWorkspaceSummary(ALPHA, 6, {
    turn: 1,
    cwd: 'C:\\work\\alpha',
    files: [
      { path: 'src/app.js', display: 'src/app.js', added: 12, deleted: 3 },
      { path: '../outside/notes.md', display: '~/notes.md', added: 2, deleted: 0 },
    ],
    total: 2,
    added: 14,
    deleted: 3,
  })

  apply(host.ctx, {
    botToken: TOKEN,
    apiBaseUrl: telegram.baseUrl,
    statePath,
    allowedChatIds: [CHAT],
    poll: { timeoutSeconds: 1, backoffMinMs: 100, backoffMaxMs: 1000 },
    notifications: { enabled: true, mode: 'current', onTurnEnd: true, includeSubagents: false },
    approvals: { mode: 'telegram', timeoutMs: 8000 },
    questions: { mode: 'telegram', timeoutMs: 8000 },
    limits: { pageSize: 8, maxEventsPerRead: 500 },
    ...overrides,
  })
  await telegram.waitForCall('getMe')
  let updateId = 100
  /** @returns {number} the next unique Telegram update id */
  const nextUpdateId = () => (updateId += 1)

  return {
    telegram,
    host,
    statePath,
    nextUpdateId,
    async cleanup() {
      await host.dispose()
      await telegram.close()
      await rm(stateDirectory, { recursive: true, force: true })
    },
  }
}

/** @param {string} text @param {string} [chatId] */
function textUpdate(text, chatId = CHAT, updateId = 0) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: 'private' },
      from: { id: Number(chatId), is_bot: false, first_name: 'Tester', username: 'tester' },
      text,
    },
  }
}

/** Forum-supergroup update inside one topic (thread 1 is General). */
function forumUpdate(text, chatId, updateId, threadId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 300,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: 'supergroup', is_forum: true },
      from: { id: Number(CHAT), is_bot: false, first_name: 'Tester', username: 'tester' },
      text,
      message_thread_id: threadId,
      is_topic_message: threadId > 1,
    },
  }
}

/** @param {any} message */
function callbackUpdate(message, data, updateId = 0) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: Number(CHAT), is_bot: false, first_name: 'Tester', username: 'tester' },
      message: {
        message_id: message.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(message.chatId), type: 'private' },
      },
      data,
    },
  }
}

/** Callback on a message that lives inside a forum supergroup. */
function forumCallbackUpdate(message, data, updateId = 0, threadId = 1) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: Number(CHAT), is_bot: false, first_name: 'Tester', username: 'tester' },
      message: {
        message_id: message.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(message.chatId), type: 'supergroup', is_forum: true },
        message_thread_id: threadId,
      },
      data,
    },
  }
}

/** @param {any} message */
function buttonData(message) {
  const keyboard = message?.keyboard
  const rows = keyboard?.inline_keyboard ?? []
  const buttons = rows.flat()
  return buttons
}

test('pairing, help, session list, selection, prompt, result, review, notify, approval and question flows', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())
  const { telegram, host } = env

  // Pairing: an unknown chat learns its id but cannot run commands.
  telegram.pushUpdate(textUpdate('/whoami', '999', env.nextUpdateId()))
  const pairing = await telegram.waitForMessage((message) => String(message.chatId) === '999' && message.text.includes('Pairing required'))
  assert.match(pairing.text, /999/)
  assert.equal(host.prompts.length, 0)

  // Help.
  telegram.pushUpdate(textUpdate('/help', CHAT, env.nextUpdateId()))
  const help = await telegram.waitForMessage((message) => String(message.chatId) === CHAT && message.text.includes('DeepSeek Harness from Telegram'))
  assert.match(help.text, /\/sessions/)

  // Session list renders titles and selection buttons.
  telegram.pushUpdate(textUpdate('/sessions', CHAT, env.nextUpdateId()))
  const list = await telegram.waitForMessage((message) => message.text.includes('Alpha task'))
  assert.match(list.text, /Beta task/)
  assert.match(list.text, /2 sessions/)
  // Child-agent sessions are hidden from the picker by default.
  assert.doesNotMatch(list.text, /Subagent Task/)
  assert.doesNotMatch(list.text, /Archived task/)
  assert.ok(buttonData(list).some((button) => button.callback_data === 'sel:0'))

  // Select by index and see status.
  telegram.pushUpdate(textUpdate('/use 1', CHAT, env.nextUpdateId()))
  const status = await telegram.waitForMessage((message) => message.text.includes('Turn: 1') && message.text.includes('Alpha task'))
  assert.equal(status.keyboard.inline_keyboard.length > 0, true)

  // Plain text becomes a prompt for the selected session.
  telegram.pushUpdate(textUpdate('Please continue', CHAT, env.nextUpdateId()))
  await waitUntil(() => host.prompts.length === 1, { label: 'prompt delivery' })
  assert.equal(host.prompts[0].sessionId, ALPHA)
  assert.equal(host.prompts[0].mode, 'queue')
  assert.match(host.prompts[0].content[0].text, /^\[via Telegram\]\nPlease continue$/)

  // Result shows the last assistant answer (headline and answer are separate
  // Telegram messages by design, so assert across the delivered batch).
  telegram.pushUpdate(textUpdate('/result', CHAT, env.nextUpdateId()))
  const result = await telegram.waitForMessage((message) => message.text.includes('Hello from the agent.'))
  assert.ok(result)
  await waitUntil(() => telegram.messages.some((message) => message.text.includes('turn 1 completed')), { label: 'result headline' })

  // Review shows tool calls and changed files. The card is delivered as several
  // messages by design, so wait for the whole batch rather than the first part.
  telegram.pushUpdate(textUpdate('/review', CHAT, env.nextUpdateId()))
  await telegram.waitForMessage((message) => message.text.includes('Changed files'))
  await waitUntil(() => {
    const combined = telegram.messages.map((message) => message.text).join('\n')
    return combined.includes('pwsh') && combined.includes('src/app.js') && combined.includes('notes.md')
  }, { label: 'review body' })

  // A finished turn pushes a notification with result/review/status buttons and
  // the complete final assistant message (split across messages when long).
  const longAnswer = `Second answer is ready. ${'Long detail sentence. '.repeat(400)}`
  host.pushSessionEvent(ALPHA, turnStart(8, 2))
  host.pushSessionEvent(ALPHA, assistantMessage(9, 2, 1, longAnswer, { inputTokens: 10, outputTokens: 5 }))
  host.setWorkspaceSummary(ALPHA, 10, { turn: 2, cwd: 'C:\\work\\alpha', files: [], total: 0, added: 0, deleted: 0 })
  host.pushSessionEvent(ALPHA, workspaceChanges(10, 2))
  host.pushSessionEvent(ALPHA, turnEnd(11, 2, 'completed'))
  await telegram.waitForMessage((message) => message.text.includes('Turn finished'), 5000)
  // Chunks are sent sequentially (per-chat rate limit), so wait for the batch.
  await waitUntil(() => {
    const batch = telegram.messages.map((message) => message.text).join('\n')
    return batch.split('Long detail sentence.').length - 1 >= 380
  }, { label: 'full-answer notification', timeoutMs: 8000 })
  const notificationButtons = telegram.messages.flatMap((message) => buttonData(message))
  assert.ok(notificationButtons.some((button) => button.callback_data === `r:${ALPHA}`))
  const notifiedText = telegram.messages.map((message) => message.text).join('\n')
  assert.ok(notifiedText.includes('Second answer is ready.'))
  const occurrences = notifiedText.split('Long detail sentence.').length - 1
  assert.ok(occurrences >= 380, `notification must carry the whole answer (got ${occurrences})`)

  // Approval waterfall is claimed by Telegram and resolved by a button.
  host.sessions.get(ALPHA).running = true
  const approvalRequest = {
    agent: { id: ALPHA },
    toolName: 'pwsh',
    reason: 'run the test suite',
    signal: new AbortController().signal,
  }
  let approvalFallbackCalled = false
  const approvalOutcome = host.waterfall('approval/request', approvalRequest, async () => {
    approvalFallbackCalled = true
    return 'unavailable'
  })
  const approvalMessage = await telegram.waitForMessage((message) => message.text.includes('Approval requested'), 5000)
  assert.match(approvalMessage.text, /pwsh/)
  const allowButton = buttonData(approvalMessage).find((button) => String(button.callback_data).endsWith(':allow'))
  assert.ok(allowButton)
  telegram.pushUpdate(callbackUpdate(approvalMessage, allowButton.callback_data, env.nextUpdateId()))
  assert.equal(await approvalOutcome, 'allowed-once')
  assert.equal(approvalFallbackCalled, false)
  await waitUntil(() => telegram.calls.some((call) => call.method === 'editMessageText' && String(call.params.text).includes('Decision:')), { label: 'approval resolution edit' })

  // Structured question: tapping an option resolves the waterfall.
  const answerRequest = {
    agent: { id: ALPHA },
    questions: [
      {
        id: 'deploy',
        question: 'Proceed with deploy?',
        header: 'Deploy',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
    signal: new AbortController().signal,
  }
  const answerPromise = host.waterfall('user-questions/request', answerRequest, async () => ({ answers: [{ id: 'deploy', selected: ['__fallback__'] }] }))
  const questionMessage = await telegram.waitForMessage((message) => message.text.includes('Proceed with deploy?'), 5000)
  const yesButton = buttonData(questionMessage).find((button) => {
    const data = String(button.callback_data ?? '')
    return data.startsWith('qa:') && data.endsWith(':0') && button.text.startsWith('A ')
  })
  assert.ok(yesButton, `question keyboard was ${JSON.stringify(buttonData(questionMessage))}`)
  telegram.pushUpdate(callbackUpdate(questionMessage, yesButton.callback_data, env.nextUpdateId()))
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [{ id: 'deploy', selected: ['Yes'] }])

  // Notifications, selection and offsets survive into the state file.
  const saved = JSON.parse(await readFile(env.statePath, 'utf8'))
  assert.equal(saved.chats[CHAT].currentSessionId, ALPHA)
  assert.ok(saved.offset > 0)
})

test('auto approval mode defers to a desktop client but still notifies', async (t) => {
  const env = await setup({ approvals: { mode: 'auto', timeoutMs: 3000 } })
  t.after(() => env.cleanup())
  env.host.setLiveClient(true)

  // Select the session so the notification targets this chat.
  env.telegram.pushUpdate(textUpdate(`/use ${ALPHA}`, CHAT, env.nextUpdateId()))
  await env.telegram.waitForMessage((message) => message.text.includes('Alpha task'))

  const request = { agent: { id: ALPHA }, toolName: 'fs_write', reason: 'write file', signal: new AbortController().signal }
  const outcome = await env.host.waterfall('approval/request', request, async () => 'unavailable-fallback')
  assert.equal(outcome, 'unavailable-fallback')
  const notice = await env.telegram.waitForMessage((message) => message.text.includes('waiting in DSH'), 5000)
  assert.match(notice.text, /desktop client/)
})

test('missing token leaves the plugin loaded and idle', async (t) => {
  const host = createFakeHost()
  t.after(() => host.dispose())
  const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-telegram-bridge-test-'))
  t.after(() => rm(stateDirectory, { recursive: true, force: true }))
  apply(host.ctx, {
    tokenRef: 'DSH_TELEGRAM_BRIDGE_TEST_MISSING_TOKEN',
    statePath: join(stateDirectory, 'state.json'),
    allowedChatIds: [CHAT],
  })
  await waitUntil(() => host.logs.some((entry) => entry.level === 'warn' && entry.text.includes('no bot token found')), {
    label: 'missing-token warning',
  })
  assert.equal(host.logs.some((entry) => entry.level === 'error'), false)
})

test('session events for unselected sessions do not notify when mode is current', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())
  // Current session is not selected for this chat yet.
  env.host.pushSessionEvent('session-beta-0002', turnStart(4, 2))
  env.host.pushSessionEvent('session-beta-0002', assistantMessage(5, 2, 1, 'Beta finished.'))
  env.host.pushSessionEvent('session-beta-0002', turnEnd(6, 2, 'completed'))
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(env.telegram.messages.some((message) => message.text.includes('Beta finished.')), false)
})

test('new session and stop commands call the session controller', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())
  env.telegram.pushUpdate(textUpdate('/new', CHAT, env.nextUpdateId()))
  await waitUntil(() => env.host.creates.length === 1, { label: 'session create' })
  await env.telegram.waitForMessage((message) => message.text.includes('New session') || message.text.includes('session-fake-1'), 5000)
  env.telegram.pushUpdate(textUpdate('/stop', CHAT, env.nextUpdateId()))
  await waitUntil(() => env.host.cancels.length === 1, { label: 'session cancel' })
  assert.equal(env.host.cancels[0].sessionId, 'session-fake-1')
})

test('an expired approval resolves to delegation, not a stuck tool call', async (t) => {
  const env = await setup({ approvals: { mode: 'telegram', timeoutMs: 1000 } })
  t.after(() => env.cleanup())
  const request = { agent: { id: ALPHA }, toolName: 'bash', signal: new AbortController().signal }
  const outcome = await env.host.waterfall('approval/request', request, async () => 'fallback')
  assert.equal(outcome, 'fallback')
  await waitUntil(() => env.telegram.calls.some((call) => call.method === 'editMessageText' && String(call.params.text).includes('Expired')), { label: 'expiry edit', timeoutMs: 5000 })
})

test('review handles a turn with no assistant text and an error reason', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())
  const { host } = env
  host.addSession({
    id: 'session-gamma-0003',
    title: 'Gamma failure',
    cwd: 'C:\\work\\gamma',
    updatedAt: Date.now(),
    events: [
      sessionEvent(1, 'turn/start', { turn: 1 }),
      sessionEvent(2, 'user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'break it' }], source: { kind: 'user' }, turn: 1, step: 1 }),
      sessionEvent(3, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'model exploded', code: 'boom' } } }),
    ],
  })
  env.telegram.pushUpdate(textUpdate('/sessions', CHAT, env.nextUpdateId()))
  await env.telegram.waitForMessage((message) => message.text.includes('Gamma failure'), 5000)
  // Select by exact id, then read the failed result.
  env.telegram.pushUpdate(textUpdate('/use session-gamma-0003', CHAT, env.nextUpdateId()))
  await env.telegram.waitForMessage((message) => message.text.includes('Gamma failure'), 5000)
  env.telegram.pushUpdate(textUpdate('/review', CHAT, env.nextUpdateId()))
  await env.telegram.waitForMessage((message) => message.text.includes('model exploded'), 6000)
})

test('all controls card exposes every session action and arms text inputs', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())
  const { telegram, host } = env

  telegram.pushUpdate(textUpdate('/use 1', CHAT, env.nextUpdateId()))
  const status = await telegram.waitForMessage((message) => message.text.includes('Turn: 1') && message.text.includes('Alpha task'), 5000)
  assert.ok(buttonData(status).some((button) => button.callback_data === 'more'), 'session card must offer All controls')

  telegram.pushUpdate(callbackUpdate(status, 'more', env.nextUpdateId()))
  const controls = await telegram.waitForMessage((message) => message.text.includes('All controls'), 5000)
  const data = new Set(buttonData(controls).map((button) => button.callback_data))
  for (const expected of ['st', 'rs', 'rv', 'tail', 'say', 'steer', 'rename', 'new', 'stop', 'ss', 'pending', 'help', 'nf:all', 'nf:cur', 'nf:off', 'who', 'dbg']) {
    assert.ok(data.has(expected), `controls card is missing ${expected}`)
  }

  // ✍️ Say… arms the next message and delivers it as a prompt.
  telegram.pushUpdate(callbackUpdate(controls, 'say', env.nextUpdateId()))
  await telegram.waitForMessage((message) => message.text.includes('Send the prompt text as your next message'), 5000)
  telegram.pushUpdate(textUpdate('via the controls card', CHAT, env.nextUpdateId()))
  await waitUntil(() => host.prompts.length === 1, { label: 'button prompt delivery' })
  assert.match(host.prompts[0].content[0].text, /^\[via Telegram\]\nvia the controls card$/)

  // ✏️ Rename… arms the next message as a title.
  telegram.pushUpdate(callbackUpdate(controls, 'rename', env.nextUpdateId()))
  await telegram.waitForMessage((message) => message.text.includes('Send the new title as your next message'), 5000)
  telegram.pushUpdate(textUpdate('Renamed via button', CHAT, env.nextUpdateId()))
  await waitUntil(() => host.renames.length === 1, { label: 'button rename' })
  assert.equal(host.renames[0].title, 'Renamed via button')

  // Notification scope buttons update durable per-chat state.
  telegram.pushUpdate(callbackUpdate(controls, 'nf:all', env.nextUpdateId()))
  await waitUntil(async () => {
    const saved = JSON.parse(await readFile(env.statePath, 'utf8'))
    return saved.chats[CHAT]?.notifyMode === 'all'
  }, { label: 'notify mode persisted', timeoutMs: 3000 })
  assert.ok(telegram.calls.some((call) => call.method === 'answerCallbackQuery' && call.params.text === 'Notifications: all sessions.'))

  // Tail and Help are wired from the card too.
  telegram.pushUpdate(callbackUpdate(controls, 'tail', env.nextUpdateId()))
  await telegram.waitForMessage((message) => message.text.includes('Recent turns'), 5000)
  telegram.pushUpdate(callbackUpdate(controls, 'help', env.nextUpdateId()))
  await telegram.waitForMessage((message) => message.text.includes('DeepSeek Harness from Telegram'), 5000)
})

test('voice notes are transcribed and delivered as prompts', async (t) => {
  const env = await setup({}, { voice: { transcript: 'hello from a voice note' } })
  t.after(() => env.cleanup())
  const { telegram, host } = env
  telegram.setFile('voice/test.ogg', new Uint8Array(512).fill(7))

  telegram.pushUpdate(textUpdate('/use 1', CHAT, env.nextUpdateId()))
  await telegram.waitForMessage((message) => message.text.includes('Alpha task'), 5000)

  const updateId = env.nextUpdateId()
  telegram.pushUpdate({
    update_id: updateId,
    message: {
      message_id: updateId + 5,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(CHAT), type: 'private' },
      from: { id: Number(CHAT), is_bot: false, first_name: 'Tester', username: 'tester' },
      voice: { file_id: 'voice-file-1', duration: 2, mime_type: 'audio/ogg', file_size: 512 },
    },
  })

  await waitUntil(() => telegram.calls.some((call) => (
    call.method === 'editMessageText'
    && String(call.params.text).includes('Heard:')
    && String(call.params.text).includes('hello from a voice note')
  )), { label: 'voice transcript edit', timeoutMs: 8000 })
  await waitUntil(() => host.prompts.length === 1, { label: 'voice prompt delivery', timeoutMs: 5000 })
  assert.match(host.prompts[0].content[0].text, /^\[via Telegram\]\nhello from a voice note$/)
  assert.equal(host.prompts[0].mode, 'queue')
  assert.ok(telegram.fileDownloads.some((download) => download.path === 'voice/test.ogg'))
  assert.ok(telegram.messages.some((message) => message.text.includes('Voice message') && message.text.includes('processing')))
})

test('hidden subagent sessions can still be targeted by exact id', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())
  env.telegram.pushUpdate(textUpdate('/use session-subagent-0009', CHAT, env.nextUpdateId()))
  await env.telegram.waitForMessage((message) => message.text.includes('Subagent Task'), 5000)
})

test('sessions.includeSubagents shows child-agent sessions', async (t) => {
  const env = await setup({ sessions: { includeSubagents: true } })
  t.after(() => env.cleanup())
  env.telegram.pushUpdate(textUpdate('/sessions', CHAT, env.nextUpdateId()))
  await waitUntil(() => env.telegram.messages.some((message) => message.text.includes('Subagent Task')), {
    label: 'subagent session listed',
    timeoutMs: 5000,
  })
})

test('archived sessions stay out of the picker unless sessions.includeArchived is set', async (t) => {
  const hidden = await setup()
  t.after(() => hidden.cleanup())
  hidden.telegram.pushUpdate(textUpdate('/sessions', CHAT, hidden.nextUpdateId()))
  await hidden.telegram.waitForMessage((message) => message.text.includes('Alpha task'), 5000)
  assert.equal(hidden.telegram.messages.some((message) => message.text.includes('Archived task')), false)

  const shown = await setup({ sessions: { includeArchived: true } })
  t.after(() => shown.cleanup())
  shown.telegram.pushUpdate(textUpdate('/sessions', CHAT, shown.nextUpdateId()))
  await waitUntil(() => shown.telegram.messages.some((message) => message.text.includes('Archived task')), {
    label: 'archived session listed',
    timeoutMs: 5000,
  })
  // Archiving does not affect subagent filtering.
  assert.equal(shown.telegram.messages.some((message) => message.text.includes('Subagent Task')), false)
})

test('turn media is forwarded to Telegram and /files resends it', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tg-media-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'clip.mp4'), new Uint8Array([1, 2, 3, 4, 5, 6]))
  await writeFile(join(directory, 'report.pdf'), new Uint8Array([37, 80, 68, 70]))
  const mediaSession = 'session-media-0007'
  env.host.addSession({
    id: mediaSession,
    title: 'Media run',
    cwd: directory,
    updatedAt: Date.now(),
    events: [
      turnStart(1, 1),
      assistantMessage(2, 1, 1, 'Rendered the clip.'),
      workspaceChanges(3, 1),
      sessionEvent(4, 'deliverables/presented', {
        turn: 1,
        callId: 'present-1',
        files: [{ path: join(directory, 'report.pdf'), description: 'Report' }],
      }),
    ],
  })
  env.host.setWorkspaceSummary(mediaSession, 3, {
    turn: 1,
    cwd: directory,
    files: [
      { path: 'clip.mp4', display: 'clip.mp4', added: 0, deleted: 0 },
      { path: 'src/app.js', display: 'src/app.js', added: 3, deleted: 1 },
    ],
    total: 2,
    added: 3,
    deleted: 1,
  })
  env.telegram.pushUpdate(textUpdate(`/use ${mediaSession}`, CHAT, env.nextUpdateId()))
  await env.telegram.waitForMessage((message) => message.text.includes('Media run'), 5000)

  env.host.pushSessionEvent(mediaSession, turnEnd(5, 1, 'completed'))
  await waitUntil(() => env.telegram.calls.some((call) => call.method === 'sendVideo'), {
    label: 'media forwarded on turn end',
    timeoutMs: 5000,
  })
  // A `present` declaration is forwarded as a document even though .pdf is not
  // in the changed-files media path here.
  await waitUntil(() => env.telegram.calls.some((call) => call.method === 'sendDocument'), {
    label: 'present deliverables forwarded',
    timeoutMs: 5000,
  })
  // Code-only changes are not uploaded.
  assert.equal(env.telegram.calls.some((call) => String(call.params?.multipart ?? false) === true && String(call.params?.filename ?? '').includes('app.js')), false)

  env.telegram.pushUpdate(textUpdate('/files', CHAT, env.nextUpdateId()))
  await waitUntil(
    () => env.telegram.calls.filter((call) => call.method === 'sendVideo').length >= 2,
    { label: '/files resends the video', timeoutMs: 5000 },
  )
  await waitUntil(
    () => env.telegram.calls.filter((call) => call.method === 'sendDocument').length >= 2,
    { label: '/files resends the deliverable', timeoutMs: 5000 },
  )
})

test('replying to a session message routes the prompt to that session', async (t) => {
  const env = await setup({ notifications: { enabled: true, mode: 'all', onTurnEnd: true } })
  t.after(() => env.cleanup())
  const { telegram, host } = env
  const deltaId = 'session-delta-0010'
  host.addSession({
    id: deltaId,
    title: 'Delta task',
    cwd: 'C:\\work\\delta',
    updatedAt: Date.now(),
    events: [turnStart(1, 1), assistantMessage(2, 1, 1, 'Delta answer is ready.')],
  })

  // Select a different session first so reply routing has to switch the target.
  telegram.pushUpdate(textUpdate('/use session-alpha-0001', CHAT, env.nextUpdateId()))
  await telegram.waitForMessage((message) => message.text.includes('Alpha task') && message.text.includes('Turn: 1'), 5000)

  // Another session finishes and pushes a mapped notification.
  host.pushSessionEvent(deltaId, turnEnd(3, 1, 'completed'))
  const header = await telegram.waitForMessage(
    (message) => message.text.includes('Turn finished') && message.text.includes('Delta task'),
    5000,
  )
  assert.ok(header)

  // Reply to that notification: the prompt must go to Delta, not Alpha.
  const replyUpdate = env.nextUpdateId()
  telegram.pushUpdate({
    update_id: replyUpdate,
    message: {
      message_id: replyUpdate + 500,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(CHAT), type: 'private' },
      from: { id: Number(CHAT), is_bot: false, first_name: 'Tester', username: 'tester' },
      text: 'Reply addressed to delta',
      reply_to_message: {
        message_id: header.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(CHAT), type: 'private' },
      },
    },
  })
  await waitUntil(
    () => host.prompts.some((prompt) => prompt.sessionId === deltaId && prompt.content[0].text.endsWith('Reply addressed to delta')),
    { label: 'reply routed to the quoted session', timeoutMs: 5000 },
  )
  // Replying also makes the quoted session active for follow-up messages.
  await waitUntil(async () => {
    const saved = JSON.parse(await readFile(env.statePath, 'utf8'))
    return saved.chats[CHAT]?.currentSessionId === deltaId
  }, { label: 'reply switches the active session', timeoutMs: 3000 })
})

test('Telegram prompts are marked remote and the system prompt explains delivery', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())
  // Activation registers a Host system-prompt section for remote requests.
  assert.equal(env.host.promptSections.length, 1)
  const section = env.host.promptSections[0]
  assert.equal(section.name, 'telegram-bridge-remote')
  assert.match(section.text, /Telegram remote requests/)
  assert.match(section.text, /present/)
  assert.match(section.text, /Never open files/)

  env.telegram.pushUpdate(textUpdate('/use 1', CHAT, env.nextUpdateId()))
  await env.telegram.waitForMessage((message) => message.text.includes('Alpha task'), 5000)
  env.telegram.pushUpdate(textUpdate('show me the clip', CHAT, env.nextUpdateId()))
  await waitUntil(() => env.host.prompts.length === 1, { label: 'marked prompt delivered', timeoutMs: 5000 })
  assert.match(env.host.prompts[0].content[0].text, /^\[via Telegram\]\nshow me the clip$/)
})

test('forum topics bind one session per topic and route prompts and notifications', async (t) => {
  const GROUP = '-1009001'
  const env = await setup({
    allowedChatIds: [CHAT, GROUP],
    notifications: { enabled: true, mode: 'all', onTurnEnd: true },
  })
  t.after(() => env.cleanup())
  const { telegram, host } = env

  // Selecting a session in General creates its own topic and posts the status there.
  telegram.pushUpdate(forumUpdate('/use session-alpha-0001', GROUP, env.nextUpdateId(), 1))
  await waitUntil(() => telegram.calls.some((call) => call.method === 'createForumTopic'), {
    label: 'session topic created',
    timeoutMs: 5000,
  })
  const created = telegram.calls.find((call) => call.method === 'createForumTopic')
  assert.equal(created.params.name, 'Alpha task')
  await waitUntil(
    () => telegram.messages.some((message) => String(message.chatId) === GROUP && Number(message.threadId) > 1),
    { label: 'status posted in the new topic', timeoutMs: 5000 },
  )
  const topicId = telegram.messages.find((message) => String(message.chatId) === GROUP && Number(message.threadId) > 1).threadId
  assert.ok(Number(topicId) > 1)

  // Plain text in the topic prompts the bound session without /use.
  telegram.pushUpdate(forumUpdate('Topic-bound prompt', GROUP, env.nextUpdateId(), topicId))
  await waitUntil(
    () => host.prompts.some((prompt) => prompt.sessionId === 'session-alpha-0001' && prompt.content[0].text.endsWith('Topic-bound prompt')),
    { label: 'topic prompt routed to its session', timeoutMs: 5000 },
  )

  // Turn notifications for that session land in its topic.
  host.pushSessionEvent('session-alpha-0001', turnEnd(5, 1, 'completed'))
  await waitUntil(
    () => telegram.messages.some((message) => String(message.chatId) === GROUP && Number(message.threadId) === Number(topicId) && message.text.includes('Turn finished')),
    { label: 'turn notification routed to the topic', timeoutMs: 5000 },
  )
})

test('the sessions card can create one topic per listed session', async (t) => {
  const GROUP = '-1009002'
  const env = await setup({
    allowedChatIds: [CHAT, GROUP],
    notifications: { enabled: true, mode: 'all', onTurnEnd: true },
  })
  t.after(() => env.cleanup())
  const { telegram } = env

  telegram.pushUpdate(forumUpdate('/sessions', GROUP, env.nextUpdateId(), 1))
  await waitUntil(
    () => telegram.messages.some((message) => String(message.chatId) === GROUP && JSON.stringify(message.keyboard ?? {}).includes('tps:')),
    { label: 'sessions card offers topic creation', timeoutMs: 5000 },
  )
  const card = telegram.messages.find(
    (message) => String(message.chatId) === GROUP && JSON.stringify(message.keyboard ?? {}).includes('tps:'),
  )
  const before = telegram.calls.filter((call) => call.method === 'createForumTopic').length
  telegram.pushUpdate(forumCallbackUpdate(card, 'tps:0', env.nextUpdateId(), 1))
  await waitUntil(
    () => telegram.calls.filter((call) => call.method === 'createForumTopic').length > before,
    { label: 'topics created for the listed sessions', timeoutMs: 10000 },
  )
  await waitUntil(
    () => telegram.messages.some((message) => String(message.chatId) === GROUP && message.text.includes('Created') && message.text.includes('topic')),
    { label: 'topic creation summary sent', timeoutMs: 5000 },
  )
})

test('a General message without a thread id does not reuse the previous topic', async (t) => {
  const GROUP = '-1009003'
  const env = await setup({
    allowedChatIds: [CHAT, GROUP],
    notifications: { enabled: true, mode: 'all', onTurnEnd: true },
  })
  t.after(() => env.cleanup())
  const { telegram } = env

  // First session gets its topic from General.
  telegram.pushUpdate(forumUpdate('/use session-alpha-0001', GROUP, env.nextUpdateId(), 1))
  await waitUntil(
    () => telegram.messages.some((message) => String(message.chatId) === GROUP && Number(message.threadId) > 1),
    { label: 'first topic created', timeoutMs: 5000 },
  )
  const firstTopic = telegram.messages.find((message) => String(message.chatId) === GROUP && Number(message.threadId) > 1).threadId

  // General messages may omit message_thread_id entirely; the reply must go to
  // General (not inherit the first topic) and selecting another session must
  // create a second topic.
  telegram.pushUpdate(forumUpdate('/sessions', GROUP, env.nextUpdateId(), 0))
  await waitUntil(
    () => telegram.messages.some(
      (message) => String(message.chatId) === GROUP && !message.threadId && JSON.stringify(message.keyboard ?? {}).includes('sel:1'),
    ),
    { label: 'sessions card sent to General again', timeoutMs: 5000 },
  )
  const card = [...telegram.messages].reverse().find(
    (message) => String(message.chatId) === GROUP && !message.threadId && JSON.stringify(message.keyboard ?? {}).includes('sel:1'),
  )
  telegram.pushUpdate(forumCallbackUpdate(card, 'sel:1', env.nextUpdateId(), 0))
  await waitUntil(
    () => telegram.messages.some(
      (message) => String(message.chatId) === GROUP && Number(message.threadId) > 1 && message.text.includes('Beta task'),
    ),
    { label: 'second session status posted in its own topic', timeoutMs: 5000 },
  )
  const secondCard = telegram.messages.find(
    (message) => String(message.chatId) === GROUP && Number(message.threadId) > 1 && message.text.includes('Beta task'),
  )
  const secondTopic = secondCard.threadId
  assert.notEqual(Number(secondTopic), Number(firstTopic))
  assert.ok(telegram.calls.filter((call) => call.method === 'createForumTopic').length >= 2)
})
