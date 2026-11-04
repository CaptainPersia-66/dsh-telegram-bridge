# Telegram bridge — implementation spec (shared)

Package: `@local/dsh-telegram-bridge` — a zero-dependency ESM **Host plugin** for the
DeepSeek Harness (DSH) desktop profile. It runs a Telegram bot (Bot API long
polling) inside the Host process and lets the user list sessions, follow runs,
read/review results, prompt sessions, stop runs, and answer approvals or
questions — all from Telegram.

Runtime: Node 24 (Electron host), global `fetch`, `AbortSignal`. **No third-party
dependencies, no bare imports.** Only `node:` builtins plus globals.

This file is the contract between parallel workstreams. Do not rename exported
functions or change their shapes without telling the Lead.

---

## 1. File ownership

| Files | Owner |
| --- | --- |
| `lib/telegram-api.js`, `lib/format.js`, `test/fake-telegram.mjs`, `test/telegram-api.test.mjs`, `test/format.test.mjs` | workstream **api** |
| `lib/bridge.js`, `test/bridge.test.mjs` | workstream **bridge** |
| `index.js`, `lib/config.js`, `lib/state.js`, `lib/views.js`, `lib/commands.js`, `README.md`, `test/fake-ctx.mjs`, `test/integration.test.mjs` | Lead |

Never edit files you do not own. No `npm install`, no lockfile writes.

## 2. Conventions

- Plain ESM: `export function`, `export class`, `export const`. No TypeScript.
- JSDoc on exported functions; comments explain *why*, not restating code.
- Errors: `throw new Error(msg)`; when a caller must branch, set `error.code` or
  use the small error classes defined in the module.
- Never log, format, or embed the bot token. Redact anything shaped
  `\d{6,}:[\w-]{20,}` in diagnostics.
- Tests: `node --test` from the package directory (auto-discovers `test/*.test.mjs`).
  No network beyond 127.0.0.1. Fake servers bind port `0` and report the assigned
  URL.
- `node --check <file>` must pass for every file you write (ESM; package has
  `"type": "module"`).

---

## 3. `lib/format.js` (workstream api)

Pure string helpers, no I/O.

```js
export function escapeHtml(value)                  // String(value), then & -> &amp; < -> &lt; > -> &gt;
export function truncate(text, maxChars, suffix = '…')
export function chunkText(text, maxChars = 3900)   // string -> string[]
export function formatDuration(ms)                 // 850 -> '850ms', 3200 -> '3.2s', 65000 -> '1m 5s', 3900000 -> '1h 5m', 5400000 -> '1h 30m'
export function formatRelativeTime(epochMs, now = Date.now()) // 'just now' (<10s), '12s ago', '5m ago', '3h ago', '2d ago'; future -> 'in 5m'
export function formatTokens(count)                // 999 -> '999', 1234 -> '1.2k', 1_234_567 -> '1.2M'
```

`chunkText` rules: every chunk `length <= maxChars` and `length > 0`; input
characters are preserved exactly (no trimming, no inserted characters); prefer
splitting after a blank line, then after `\n`, then after a space, then hard
split; never split a UTF-16 surrogate pair; a non-empty input returns at least
one chunk; empty input returns `[]`.

`truncate` returns the input unchanged when `length <= maxChars`; otherwise cuts
at a code-point boundary and appends `suffix`, total `<= maxChars` when
`maxChars > suffix.length`.

## 4. `lib/telegram-api.js` (workstream api)

```js
export class TelegramApiError extends Error {
  // message is safe to show users (never contains the token)
  // fields: code (number|null), description (string), method (string),
  //         retryAfterSeconds (number|undefined), isParseError (boolean)
}

export class TelegramApi {
  constructor(options)
  // options: {
  //   token: string (required, non-empty),
  //   baseUrl = 'https://api.telegram.org',
  //   logger = null,              // object with info/warn/error methods
  //   fetchImpl = globalThis.fetch,
  //   maxRetries = 3,
  //   minSendIntervalMs = 60,     // min gap between messages to the same chat
  //   maxConcurrentCalls = 4,
  //   signal = null,              // plugin lifetime; aborts in-flight calls
  // }

  async call(method, params = {}, { signal } = {})     // raw Bot API call
  async getMe(options = {})                            // result.getMe()
  async getUpdates({ offset = 0, timeoutSeconds = 25, limit = 100,
                     allowedUpdates = ['message', 'callback_query'],
                     signal } = {})                    // -> array of Update
  async sendMessage({ chatId, text, parseMode = 'HTML', keyboard = null,
                      disableWebPagePreview = true, replyToMessageId = null },
                    { signal } = {})                   // -> array of sent Message objects (one per chunk)
  async editMessageText({ chatId, messageId, text, parseMode = 'HTML',
                          keyboard = null }, { signal } = {})       // -> Message | true
  async editMessageReplyMarkup({ chatId, messageId, keyboard = null }, { signal } = {}) // -> Message | true
  async answerCallbackQuery({ callbackQueryId, text = null, showAlert = false }, { signal } = {}) // -> true
  async deleteMessage({ chatId, messageId }, { signal } = {}) // -> true
}
```

Behavior:

- Base URL: strip a trailing `/`, then request `POST <baseUrl>/bot<token>/<method>`
  with `Content-Type: application/json` and a JSON body. `getUpdates` uses the
  Bot API long-poll parameter `timeout`; give that fetch
  `timeoutSeconds * 1000 + 15000` and combine with the caller signal
  (`AbortSignal.any`) so a long poll cannot hang forever.
- Retries: 429 (`retry_after` seconds, honor it, capped at 30 s), 5xx
  (`502/503/504`), and network/timeout errors use exponential backoff with jitter
  (`200ms * 2^attempt`, capped 8 s) up to `maxRetries`. Never retry other 4xx.
  Honor an abort immediately (`AbortError` propagates).
- `sendMessage`: split with `chunkText(text, 3900)`; attach `keyboard` only to
  the first chunk; send chunks sequentially; return the sent message array. If a
  chunk fails with a parse-entities error (`isParseError`), retry that chunk once
  with `parseMode` omitted and no `reply_markup` before throwing.
- Rate limiting: per-chat serialization queue with `minSendIntervalMs` between
  `sendMessage` starts for the same chat; global in-flight cap
  `maxConcurrentCalls` for all calls. The queue must not deadlock and must be
  released on abort.
- `keyboard` is passed straight through as `reply_markup` JSON
  (`{ inline_keyboard: [[{ text, callback_data }, …], …] }`).
- `TelegramApiError` mapping: HTTP non-2xx or `ok:false` -> code =
  `error_code`/`parameters.retry_after`; `isParseError` when description
  mentions `parse entities`. Network errors get `code: null`.
- `call` never throws for a legitimate Bot API `ok:false` without wrapping in
  `TelegramApiError`; timeouts/abort propagate as abort errors.

## 5. `test/fake-telegram.mjs` (workstream api, reused by Lead)

```js
export async function startFakeTelegram(options = {})
// options: { token = '123456:TEST-TOKEN-abcdefghijklmnopqrstuvwxyz',
//            longPollDelayMs = 10 }
// -> {
//   baseUrl,            // 'http://127.0.0.1:<port>'
//   token,
//   calls,              // every call: { method, params, at }
//   messages,           // sent messages: { chatId, text, parseMode, keyboard, messageId, at }
//   sendReports,        // per sendMessage call result arrays
//   updates,            // queue of pending updates
//   pushUpdate(update), // enqueue an Update
//   queueUpdates(list),
//   waitForCall(method, predicate = () => true, timeoutMs = 3000), // Promise<call>
//   waitForMessage(predicate = () => true, timeoutMs = 3000),      // Promise<message>
//   lastCall(method),
//   setBehavior(method, fn) // fn(params) -> { status, body } override, for error tests
//   close(),            // Promise<void>
// }
```

The fake implements at least `getMe`, `getUpdates` (long-poll: when the queue is
empty wait up to a short delay for a push), `sendMessage` (records and answers
`ok:true` with `message_id`), `editMessageText`, `editMessageReplyMarkup`,
`answerCallbackQuery`, `deleteMessage`. Unknown methods answer
`{ ok:false, error_code: 404, description: 'Not Found' }`. Use a raw
`node:http` server, JSON bodies, no external deps, close cleanly (including
pending long polls) so `node --test` exits.

## 6. `lib/bridge.js` (workstream bridge)

DSH Host side. Create with `createBridge(ctx)`; the object is stateless except for
a shared logger. Services are read lazily through `ctx.get(name)`:
`sessionController`, `sessionQuery`, `workspaceChanges`, `typertGateway`,
`webApp`. A missing `sessionController` makes every method throw
`BridgeError('unavailable', 'Session controller is not available in this profile')`.

```js
export class BridgeError extends Error {
  constructor(code, message, cause) // this.code = code
}
export function createBridge(ctx)

// listSessions(): Promise<SessionSummaryView[]>
//   [{ id, title: string|null, running, cwd: string|null, updatedAt: number,
//      agentAvailable, blank, parentSessionId: string|null, origin: string|null }]
//   sorted by updatedAt desc. Titles from sessionQuery.readTitleSnapshots batch;
//   one rejected title read must not fail the listing.

// getStatus(sessionId): Promise<SessionStatusView>
//   { id, title, running, cwd, updatedAt, blank, parentSessionId, origin,
//     lastTurn: number|null, turns: number, steps: number,
//     usage: { input, output, cacheRead, cacheWrite }, contextTokens: number|null,
//     contextWindow: number|null, model: string|null, preset: string|null,
//     approvalPolicy: string|null, sandbox: string|null, updatedAtModel? }
//   From sessionController.projections({ sessionId }, signal) when available;
//   project a missing projection to null rather than throwing.

// readRecentTurns(sessionId, { turns = 1, maxEvents = 1200 } = {}): Promise<TurnView>
//   { id, title: string|null, cwd: string|null,
//     turns: [{ turn: number, userText: string, assistantText: string,
//               assistantTexts: string[],
//               tools: [{ name, ok: boolean, argsPreview: string,
//                         resultPreview: string, error: string|null }],
//               endReason: 'completed'|'error'|'aborted'|'blocked'|'max-tokens'|'interrupted'|'forked'|'open',
//               errorMessage: string|null,
//               usage: { input, output, cacheRead, cacheWrite, total },
//               startedAt: number|null, endedAt: number|null,
//               changes: null | { total, added, deleted,
//                                  files: [{ path, display, added, deleted, binary }] } }] }
//   Fold from sessionController.inspect(sessionId) events (SessionInspection has
//   { meta, inheritedEventCount, events }). Keep only the tail as needed. Turn
//   semantics: turn/start opens, turn/end closes with reason.kind; user text
//   comes from user/message blocks whose source.kind === 'user'; assistant text
//   from assistant/message message.content text blocks; tool calls from tool/call
//   and tool results matched by callId from tool/result. The last turn is
//   'open' when the selected tail has its turn/start without turn/end.
//   changes: find the latest event in the fold with type 'workspace/changes' and
//   data.turn === turn, then workspaceChanges.summary(sessionId, event.seq);
//   failures leave changes null.

// prompt(sessionId, text, { mode = 'queue' } = {}): Promise<{ accepted: true }>
//   sessionController.prompt({ requestId: randomUUID(), sessionId, mode,
//     content: [{ type: 'text', text }],
//     clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
//     undefined) — use crypto.randomUUID() from node:crypto.
// steer(sessionId, text): Promise<{ accepted: true }>  // prompt with mode 'steer'
// cancel(sessionId): Promise<{ accepted: true }>       // sessionController.cancel({ sessionId })
// createSession({ cwd = undefined, workspaceId = undefined } = {}): Promise<{ sessionId }>
//   sessionController.create({ cwd, workspaceId }); drop undefined keys.
// rename(sessionId, title): Promise<{ title, seq }>   // sessionController.rename({ sessionId, title })
// hasLiveClient(): boolean                            // typertGateway?.hasLiveClient() === true
// advertisedUrl(): string|undefined                   // webApp?.getAdvertisedUrl()
// findSession(sessions, query): { match } | { candidates } | { error: 'not-found'|'ambiguous' }
//   query trimmed: 1-based index into the provided array; then exact id; then
//   unique id prefix (case-insensitive); then unique case-insensitive title
//   substring. Ambiguous ids/titles return candidates (max 8).
```

When a DSH service call throws, translate to `BridgeError` with codes:
`session-not-found` (message mentions "not found" / missing), `session-busy`
("busy"/"writer"), `unavailable` otherwise. Preserve `cause`.

## 7. Integration contract (Lead)

`index.js` will construct:

```js
const api = new TelegramApi({ token, baseUrl: config.apiBaseUrl, logger });
const bridge = createBridge(ctx);
```

and drive `api.getUpdates`, `api.sendMessage`, `bridge.*`, plus DSH events
(`session/event`, `agent/error`, `approval/request`, `user-questions/request`).
Workstream modules must not read environment variables or files.
