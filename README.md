# Telegram Bridge for DeepSeek Harness

Talk to DeepSeek Harness (DSH) from Telegram. The bridge runs a bot **inside the
DSH Host process** and lets you:

- **See every session** — titles, working directories, running/idle state, last activity.
- **Read results** — the latest assistant answer, per-turn, with token usage.
- **Review a run** — the request, the answer, every tool call (ok/failed with a
  result preview), and the files it changed with `+/-` counts.
- **Keep the agent working** — send plain text as a prompt, steer, stop a run,
  create or rename sessions.
- **Talk instead of typing** — Telegram voice notes are transcribed locally by
  DSH's voice-input model and sent as prompts.
- **Review media deliverables** — videos, audio, images and documents a turn
  produced are sent to Telegram automatically; `/files` resends the last turn's.
- **Answer the human-in-the-loop moments** — approve/deny tool calls and answer
  `ask_user_question` cards from your phone when the desktop app is not in front
  of you.
- **Get pushed the moment a turn ends** — with buttons for Result / Review / Status.

No inbound port, no webhook, no public URL: the plugin long-polls the Telegram
Bot API from the Host.

---

## Setup

### 1. Create a bot and get a token

1. Open Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot`.
2. Choose a name and a username (`…_bot`).
3. Copy the token (`123456789:AA…`).

### 2. Give the token to DSH

Pick **one** of these (checked in this order):

| Method | How |
| --- | --- |
| Configuration | `botToken:` in the `telegram-bridge` row of the profile patch (not recommended for shared machines). |
| Credential reference *(recommended)* | Set a `TELEGRAM_BOT_TOKEN` environment variable for the user that launches DSH, or store it through the Harness credential store. The row default is `tokenRef: TELEGRAM_BOT_TOKEN`. |

For a Windows desktop install: **System Properties → Environment Variables →
User variables → New**, name `TELEGRAM_BOT_TOKEN`, value = the token; then fully
restart DeepSeek Harness (closing the window is not enough — quit from the tray
menu). The bridge reads the credential on startup.

### 3. Authorize your chat

1. After the restart, send `/start` to your bot. Because no chat is authorized
   yet, the bot enters **pairing mode** and replies with your numeric **chat id**
   and **user id** — nothing else is executed.
2. Add your chat id to the plugin row in the **profile patch**
   (`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` on Windows,
   `~/.dsh/profiles/desktop/cordis.patch.yml` elsewhere), not the bundle's own
   patch:

   ```yaml
   - id: telegram-bridge
     name: "@local/dsh-telegram-bridge"
     config:
       tokenRef: TELEGRAM_BOT_TOKEN
       allowedChatIds: ["123456789"]
   ```

   (`allowedUserIds` works too for private chats; the two lists are merged.)
   A row override replaces the whole `config`, so restate `tokenRef` when you
   set `allowedChatIds`. The profile patch is reapplied after bundle layers, so
   it survives plugin upgrades.
3. Restart DSH. Send `/help` — you should get the command card.

> The bundle intentionally ships **no generated settings form**: it is a
> zero-dependency plugin that validates its own config and reports invalid values
> as warnings in the Host log. Configure it through the profile patch (or the
> bundle's `cordis.patch.yml` if you are developing it).

> Pairing never authorizes: an unknown chat only learns its own id, and the
> notice is rate-limited. Until the id is in the allowlist, every command is
> ignored.

---

## Commands

Plain text (anything that does not start with `/`) is sent as a prompt to the
selected session — the fastest way to keep an agent going from your phone.

Child-agent (**subagent**) and **archived** sessions are hidden from `/sessions`
by default. Set `sessions.includeSubagents: true` and/or
`sessions.includeArchived: true` to list them, or address one directly with
`/use <full session id>`.

| Command | What it does |
| --- | --- |
| `/sessions` (or `/list`) | List sessions; tap a button to select one. |
| `/use <n \| id-prefix \| title>` | Select a session by list number, id prefix, or title substring. |
| `/status` (`/current`) | State, turn/steps, model, tokens, context, policy, activity. |
| `/result [turns]` | Latest assistant answer(s), default 1 turn. |
| `/files` | Resend the last turn's produced media/documents to this chat. |
| `/review` | Request / answer / tool calls / changed files for the latest turn. |
| `/tail [turns]` | Compact recent-turn overview. |
| `/controls` (`/more`) | Every session action as buttons — same card as the **⚙️ All controls** button. |
| `/say <text>` | Send a prompt (explicit form of plain text). With no text, waits for your next message. |
| `/steer <text>` | Send a steering message to the running turn. With no text, waits for your next message. |
| `/stop` | Stop the running turn. |
| `/new [absolute-cwd]` | Create a session (optional working directory) and select it. |
| `/topic` | Create/bind the current session's forum topic (supergroup forums). |
| `/rename <title>` | Rename the selected session. With no title, waits for your next message. |
| `/pending` | List pending approvals/questions with action buttons. |
| `/approve [id]` / `/deny [id]` | Decide the oldest (or a specific) pending approval. |
| `/notify on\|off` | Toggle push notifications for this chat. |
| `/notify all\|current` | Notify for every session, or only the selected one. |
| `/whoami` | Your ids, selected session, notification state, web UI URL. |
| `/debug` | Redacted bridge diagnostics for troubleshooting. |
| `/cancel` | Abandon a pending button text prompt (Say…/Steer…/Rename…) or typed answer. |
| `/help` | Command card. |

### Session buttons

The session card (`/status`, after selecting a session, and on push
notifications) has Result / Review / Sessions / Stop / Refresh / Notifications
plus **⚙️ All controls**. That opens one card with every action:

- **Status, Result, Review, Tail** — read the session.
- **📎 Files** — resend the last turn's media/documents.
- **Say…, Steer…, Rename…** — the bot asks for the text as your *next message*
  (send `/cancel` to abort).
- **New, Stop, Sessions, Pending, Help** — session and app actions.
- **Notify all / selected / off** — switch push scope in one tap.
- **Whoami, Debug, Refresh** — diagnostics and re-render.

Approval and question messages carry **inline buttons**; questions with multiple
selectable answers also get a **✅ Done** button and an **✏️ Other** button that
switches the conversation into "type your answer" mode for that question.

### Routing a reply to the right session

Selecting a session makes it the default target for plain text and commands. When
notifications from several sessions arrive at once, you do not have to reselect:

- **Reply to the message** (Telegram's quote/reply gesture) — the prompt goes to
  the session that message belongs to, and that session becomes active for
  follow-ups. This works for turn notifications, status cards, Result/Review/
  Tail output, and the All-controls card.
- **Tap Result / Review / Status** on a notification — the button already targets
  that session and selects it.
- Commands (`/status`, `/result`, …) still act on the currently active session;
  reply-routing applies to plain text (and voice notes, once transcribed).

The mapping is remembered in memory (24 h, up to 300 messages per chat). After a
restart, replies to older messages fall back to the active session, so send
`/sessions` or tap the notification's buttons to be explicit.

### Telling the model the user is remote

A DSH session normally belongs to someone sitting in front of the desktop app, so
the agent will happily open files/windows there unless told otherwise. The bridge
makes the transport explicit:

- Every Telegram-originated prompt (typed text, reply-routed text, and
  transcribed voice) is prefixed with `[via Telegram]`.
- On activation the plugin registers a Host **system-prompt section** explaining
  that marker: the sender is remote, they cannot see this computer, and
  file/review requests must be delivered with the `present` tool (the bridge
  forwards declared files to the chat) rather than opening files, folders, or
  applications on the host. It also explains the ~45 MB forwarding limit and that
  only the final answer and presented files reach the phone.

The marker stays in the session log next to the request (visible if you later
read that session in the desktop app), which keeps the origin durable across
resume and forks. Prompts typed directly in the DSH app have no marker.

### Forum topics: one topic per session

In a **forum supergroup** the bridge can bind one topic to one Session, so the
chat itself carries the routing:

- **General** is the control room: `/sessions`, `/new`, and status buttons.
- Selecting a Session in General (button or `/use`) **creates or reuses its
  topic** and posts the session card there. Bound sessions are marked 🧵 in the
  list and its buttons; selecting one again reuses that topic (the bot says so)
  instead of creating a duplicate.
- The `/sessions` card in a forum also shows a **🧵 Create topics** button that
  creates and binds one topic for every session on the visible page in one tap.
- **Inside a topic**, plain text and voice notes prompt that topic's Session;
  `/status`, `/result`, `/review`, `/files`, `/stop`, `/rename` all default to
  it. Running `/use` inside a topic re-binds that topic.
- Turn notifications, approvals, and questions for a bound Session are posted
  into its topic.
- `/topic` creates (or re-binds) the current Session's topic on demand.

Bindings persist in the state file (`<chatId>:<message_thread_id>` → session),
so they survive restarts. Setup requirements:

1. The group must be a **supergroup with Topics enabled**.
2. The bot must be an administrator with the **Manage Topics** right
   (Telegram → group → Administrators → your bot).
3. **Bot privacy mode must be disabled** (BotFather → `/setprivacy` → Disable),
   otherwise the bot only receives commands, mentions, and replies in groups;
   plain prompts in topics would never arrive.
4. Add the **supergroup's** chat id (starts with `-100…`) to `allowedChatIds`.
   Converting a group to a supergroup changes its id.
5. Allowlisting a group authorizes every member of that group; keep it private
   and use a user allowlist where membership is not controlled.

---

## How interactions behave

Two independent settings decide who gets a request first:

| Mode | Behavior |
| --- | --- |
| `auto` *(default)* | If a browser/desktop client is connected, it answers in-app and Telegram only gets a notice. With no connected client, the bridge **claims** the request and waits for your tap. |
| `telegram` | Always claim in Telegram (useful when the app is open in a background tab). |
| `notify` | Never claim; only send a notice. |
| `off` | Ignore the request entirely. |

Settings: `approvals.mode` / `approvals.timeoutMs` (default 120 s) and
`questions.mode` / `questions.timeoutMs` (default 300 s). A claim that times out
is **delegated back** to the remaining answerers, so DSH never hangs on a phone
that went offline. A claimed approval is answered exactly once; its message is
edited to show the final decision and its keyboard is removed.

## Notifications

- On `turn/end` for a watched session: one compact **header** message (status,
  duration, token usage, session id + Open DSH link), then **the complete final
  assistant message**. Telegram caps a message at ~4K characters, so long
  answers arrive as several consecutive messages, each a valid `<pre>` block;
  the Result / Review / Status buttons ride on the last one. Set
  `notifications.snippetChars` to a positive number (e.g. `700`) if you prefer a
  truncated push. There is no separate footer bubble.
- On `agent/error` when turn-end pushes are disabled: the failure message.
- On approvals/questions that stay in the desktop UI: a notice.
- Sessions that are their own child agents (`origin: subagent`) are skipped
  unless `notifications.includeSubagents: true`.

A chat watches its **selected session** by default; `/notify all` switches it to
every top-level session.

## Voice notes

Send a Telegram voice note (or an audio file / round video note) and the bridge:

1. downloads it through the Bot API,
2. converts it with **ffmpeg** to 16 kHz mono PCM16 WAV,
3. transcribes it with DSH's `speechToText` service (local SenseVoice model by
   default, or any recognizer configured in DSH Settings → Voice input),
4. echoes **🎤 Heard: “…”** and sends the transcript as a prompt to the selected
   session — or uses it as the answer to a pending question / armed button action.

Requirements:

- The **Voice Input** bundle enabled in DSH (`@deepseek-ai/dsh-experimental-voice-input-bundle`,
  enabled on this profile) and its recognizer prepared.
- **ffmpeg** on the Host `PATH` (or set `voice.ffmpegPath`).
- The first transcription downloads the local model once (about **239 MB** int8,
  from huggingface.co or hf-mirror.com, checksum-verified) and caches it under
  `$DSH_HOME/speech-to-text/`. The chat shows download progress and can wait up
  to `voice.prepareTimeoutMs`.

Voice transcription errors are reported in the chat: missing bundle, missing
ffmpeg, unrecognizable speech, or a failed model download. The audio itself is
deleted from temp storage after each attempt; only the transcript becomes a
session message.

## File deliverables

When a turn finishes, files it produced are forwarded to the same chats that get
the turn notification:

- **`present` deliverables** — files the agent declared with DSH's `present`
  tool (the delivery cards in the app). These are forwarded regardless of the
  extension allow-list; their description becomes part of the caption.
- **model-attached** images/files from the final assistant message (when the
  attachments provider exposes a Host path), and
- **workspace files** changed by the turn whose extension marks them as
  reviewable: images (`png jpg jpeg webp gif`), video (`mp4 webm mov m4v mkv`),
  audio (`mp3 wav m4a ogg flac aac`), documents (`pdf docx pptx xlsx csv zip`).

Images arrive as photos with inline preview; a photo over 9 MB is sent as a
document instead. Videos/audio get inline players. Files above
`deliverables.maxBytes` (default 45 MB) are skipped and reported in a short
"not forwarded" note instead of failing the notification. Code-only changes are
never uploaded. `/files` (or the **📎 Files** button under All controls) resends
the previous turn's deliverables on demand.

Set `deliverables.enabled: false` to disable forwarding, or replace the
allow-list:

```yaml
deliverables:
  enabled: true
  maxBytes: 47185920
  extensions: ["mp4", "png", "pdf", "epub"]  # or {epub: document, ...}
```

---

## Configuration reference

All fields are optional. They live in the `telegram-bridge` row's `config`
(profile patch or bundle patch). Invalid values fall back to the default and are
reported as warnings in the Host log.

```yaml
- id: telegram-bridge
  name: "@local/dsh-telegram-bridge"
  config:
    tokenRef: TELEGRAM_BOT_TOKEN   # credential reference; default TELEGRAM_BOT_TOKEN
    botToken: null                 # direct token override (avoid in shared machines)
    apiBaseUrl: https://api.telegram.org  # local Bot API server / tests
    allowedChatIds: []             # numeric chat ids; empty = pairing mode
    allowedUserIds: []             # user ids allowed in any chat
    dropPendingUpdates: true       # ignore backlog on a fresh start
    statePath: null                # advanced: override the chat-state file
    poll:
      timeoutSeconds: 25
      backoffMinMs: 1000
      backoffMaxMs: 60000
    notifications:
      enabled: true
      mode: current                # default scope for new chats (current | all)
      includeSubagents: false
      onTurnEnd: true
      onError: true
      onApproval: true
      onQuestion: true
      onSessionStart: false
      snippetChars: 0              # 0 = send the whole final message; >0 truncates
    approvals:
      mode: auto                   # auto | telegram | notify | off
      timeoutMs: 120000
    questions:
      mode: auto                   # auto | telegram | notify | off
      timeoutMs: 300000
    limits:
      pageSize: 8                  # sessions per page
      maxResultTurns: 5
      maxTailTurns: 20
      maxEventsPerRead: 1500
      sessionTitleChars: 48
    sessions:
      includeSubagents: false      # hide child-agent sessions from /sessions
      includeArchived: false       # hide archived sessions from /sessions
    topics:
      enabled: true                # forum supergroup: one topic per session
      autoCreate: true             # open a topic when a session is selected in General
      titlePrefix: ''              # optional prefix for created topic titles
    pairing:
      notice: true
      cooldownMs: 600000
    web:
      includeUrl: true
    voice:
      enabled: true
      language: null               # null = recognizer auto (en, zh, ja, ko, …)
      autoSend: true               # send transcript as a prompt automatically
      maxDurationSeconds: 300
      maxDownloadBytes: 20971520
      maxWavBytes: 4194304         # recognizer input cap (≈131 s of 16 kHz PCM16)
      prepareTimeoutMs: 900000     # first-use model download window
      totalTimeoutMs: 1200000
      ffmpegPath: null             # default: ffmpeg from PATH
    deliverables:
      enabled: true                # forward produced media/documents to Telegram
      maxBytes: 47185920           # Bot API upload ceiling headroom
      extensions: []               # [] = built-in allow-list; or [mp4, png, …]
```

The state file defaults to `$DSH_HOME/telegram-bridge/state.json` and stores only
preferences: the update offset and each chat's selected session / notification
settings. Pending approvals and button-to-session caches are memory-only, so a
button older than a restart fails with "list expired" instead of acting on the
wrong row.

---

## Security model

- **Allowlist first.** Unauthorized chats can only learn their own ids.
- **No inbound listener.** Long polling means nothing is exposed on your network.
- **Authority matches DSH.** Claiming an approval or question only when
  `auto`-unattended (or explicitly configured) is deliberate: granting tool
  authority to a chat is a policy decision, and the timeout delegates back to
  the in-app answerer.
- **Tokens never leave the Host.** They are resolved per startup, never logged,
  never rendered into a message, and redacted from diagnostics.
- **Everything is escaped.** User/model text is HTML-escaped and chunked into
  independently valid messages, so malformed model output cannot break delivery
  or inject markup.
- **Callback data is short and scoped.** Session ids in buttons are validated
  against live sessions before use.

---

## Architecture

```
Telegram  ⇄  Telegram Bot API (long poll)  ⇄  Host plugin (index.js)
                                                   ├─ commands.js     update router + commands
                                                   ├─ interactions.js approvals / questions
                                                   ├─ views.js        Telegram HTML rendering
                                                   ├─ bridge.js       DSH session-controller access
                                                   ├─ telegram-api.js Bot API client (retry, rate limit, chunking)
                                                   ├─ state.js        durable per-chat preferences
                                                   └─ config.js       validation + token resolution
```

Data comes from the Host's own services: `sessionController` (list, inspect,
prompt, cancel, create, rename, projections), `sessionQuery` (titles),
`workspaceChanges` (per-turn changed files), `typertGateway` (desktop-client
presence), `webApp` (GUI URL), and `credentials` (token reference). Nothing is
scraped from the filesystem and no session events are written.

## Development

```powershell
cd dsh-telegram-bridge
node --test                  # unit + end-to-end tests (no network)
```

Tests use an in-process fake Host context and a fake Bot API on `127.0.0.1`, so
they never touch your real bot, profile, or session logs. `scripts/live-fake-telegram.mjs`
is a standalone fake Bot API for manually pointing a real DSH Host at a local
endpoint during development (`node scripts/live-fake-telegram.mjs <out-dir> 18765`).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Bot never answers | Check that `TELEGRAM_BOT_TOKEN` is visible to the **DSH process** (set it, then fully quit and relaunch DSH), and that the `telegram-bridge` row is active in Settings → Plugins. `/debug` works once the bot answers. |
| Bot replies "Pairing required" | Add the printed chat id under `allowedChatIds` in the profile patch, then restart. |
| Plugin row is active but idle | No token was resolved. The Host log has `no bot token found (ref TELEGRAM_BOT_TOKEN)`. |
| `409 Conflict` warnings | Another DSH process (or another copy of the app) is polling the same bot. Only one long poll per token is allowed. |
| Approvals never show buttons | A desktop client is connected, so `auto` mode defers to the in-app answerer. Answer there, or set `approvals.mode: telegram`. |
| Buttons answer "list expired" | The session list is memory-only; send `/sessions` again after a restart. |
| Voice note: "Voice input is not available" | Enable the Voice Input bundle (Settings → Plugins → Voice Input) and restart DSH. |
| Voice note stuck on "Downloading voice model…" | First use downloads ~239 MB. Let it finish or check the network; verified files are cached, so a retry continues from the cache. |
| Voice note: "ffmpeg was not found" | Install ffmpeg on the Host `PATH`, or set `voice.ffmpegPath` to its absolute path, then restart DSH. |
| Voice transcript is wrong/empty | Speak a bit longer and closer to the mic; pick a matching `voice.language`; very short clips may be rejected as empty. |

## Limitations

- Text messages and voice notes inbound; outbound media is limited to the
  Bot API's ~50 MB upload ceiling and the `deliverables` allow-list.
- Inbound photos, documents and stickers are not read yet.
- One bot token per installed profile; `apiBaseUrl` supports a self-hosted Bot API server.
- Telegram messages are edited best-effort: very old approval/question messages
  may keep a stale keyboard, but a late tap is rejected as expired.
- Only long polling, not webhooks.
- Deep links into the desktop app are not generated; `/whoami` shows the GUI URL.

---

## Development & source

- Repository: [CaptainPersia-66/dsh-telegram-bridge](https://github.com/CaptainPersia-66/dsh-telegram-bridge) (public, MIT).
- Run the suite with `node --test` — no dependencies beyond Node 24.
- Every completed, verified change is checkpointed to `main` and milestones are
  tagged (`v1.0.0` is the first). The plugin stays installed from this folder, so
  commits do not disturb the running profile.
- Working rules for agents live in [AGENTS.md](AGENTS.md).

