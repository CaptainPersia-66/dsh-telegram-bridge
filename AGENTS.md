# Working rules for this repository

DSH Telegram bridge plugin: zero third-party runtime dependencies, Node ESM.

## Verify before committing

- Run the full suite: `node --test`.
- Syntax-check changed files: `node --check <file>`.
- A change is "completed" only when its tests pass. Live Telegram behavior is
  verified separately by restarting DSH and exercising the bot.

## Checkpoint workflow (standing user instruction)

After every completed, verified change:

1. `git add -A`
2. `git commit -m "<type>: <summary>"` — Conventional Commits (`feat:`, `fix:`,
   `docs:`, `test:`, `chore:`)
3. `git push origin main`
4. Tag milestones as `vX.Y.Z` when a user-visible feature set grows
   (`git tag vX.Y.Z && git push origin vX.Y.Z`)

Do not leave finished work uncommitted across turns. If a change is unfinished
or failing, say so instead of committing it as complete.

Never commit: bot tokens or `.env` contents, `state.json`, session logs,
attachments, the user's profile patch, or any host-specific secret. Bot tokens
are resolved from the environment (`TELEGRAM_BOT_TOKEN`).

## Layout

- `index.js` — plugin lifecycle, Bot API polling, DSH listeners, notifications
- `lib/bridge.js` — DSH service projection: sessions, turns, attachments,
  deliverables, prompts
- `lib/commands.js` — update router, commands, buttons, forum-topic context
- `lib/views.js` — Telegram HTML message parts
- `lib/state.js` — durable chat + topic bindings
- `lib/telegram-api.js` — Bot API client (long polling, files, forum topics)
- `lib/interactions.js` — approvals and user questions
- `lib/media.js` — deliverable/media forwarding
- `lib/transcode.js` — ffmpeg compression for oversized video/audio deliverables
- `lib/topics.js` — forum-topic naming helpers
- `lib/voice.js` — voice-note transcription pipeline
- `lib/prompt.js` — `[via Telegram]` marker and remote-request system prompt
- `test/` — fake Bot API + fake DSH Host integration harness
- The profile install is a bundle link to this folder; keep the folder in place.

## Design constraints

- No third-party runtime dependencies; only `node:` builtins and globals.
- Escape and chunk Telegram HTML; the token is never logged or rendered.
- Forum topics: General is the control room; one topic per session; bindings
  persist as `<chatId>:<threadId> -> sessionId`.
- Every Telegram-originated prompt starts with `[via Telegram]`; a Host system
  prompt section tells the model to deliver files with `present` and never open
  windows/files on the host desktop.
