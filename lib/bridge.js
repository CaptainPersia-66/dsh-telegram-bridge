/**
 * DSH Host session bridge for the Telegram bridge plugin.
 *
 * The plugin runs inside the DSH Host process. This module is the only place
 * that touches Host session services: it resolves them lazily through
 * `ctx.get(name)` because the active profile decides which services exist, and
 * it projects every value into a small JSON-safe shape the command layer can
 * render without caring about Host internals.
 *
 * Design rules:
 * - `sessionController` is required for session operations; everything else is
 *   optional and degrades one field to `null` instead of failing a command.
 * - Read-only enrichment (titles, workspace change summaries) is isolated: one
 *   failed lookup never fails a listing or a turn review.
 * - Host service failures are translated to `BridgeError` so the command layer
 *   can branch on `error.code` and always show `error.message` to the user.
 */

import { randomUUID } from 'node:crypto';

const SESSION_CONTROLLER_UNAVAILABLE = 'Session controller is not available in this profile';
const DEFAULT_TURN_LIMIT = 1;
const DEFAULT_MAX_EVENTS = 1200;
const MAX_TURN_LIMIT = 100;
const MAX_EVENT_SCAN = 100000;
const PREVIEW_MAX_CHARS = 200;
const MAX_FIND_CANDIDATES = 8;

/** Turn end kinds that the bridge exposes verbatim. */
const TURN_END_REASONS = new Set([
  'completed',
  'error',
  'aborted',
  'blocked',
  'max-tokens',
  'interrupted',
  'forked',
]);

/**
 * Error raised by every bridge operation that can fail for a business reason.
 *
 * @example
 * try { await bridge.prompt(id, text); }
 * catch (error) {
 *   if (error instanceof BridgeError && error.code === 'session-busy') { ... }
 * }
 */
export class BridgeError extends Error {
  /**
   * @param {'session-not-found' | 'session-busy' | 'unavailable'} code
   *   Machine-readable reason the command layer can branch on.
   * @param {string} message Safe, user-showable message (never contains a token).
   * @param {unknown} [cause] Original Host error, preserved for diagnostics.
   */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BridgeError';
    this.code = code;
    if (cause !== undefined && this.cause === undefined) this.cause = cause;
  }
}

/**
 * @typedef {object} SessionSummaryView
 * @property {string} id
 * @property {string | null} title
 * @property {boolean} running
 * @property {string | null} cwd
 * @property {number} updatedAt
 * @property {boolean} agentAvailable
 * @property {boolean} blank
 * @property {string | null} parentSessionId
 * @property {string | null} origin
 * @property {boolean} archived
 */

/**
 * @typedef {object} SessionStatusView
 * @property {string} id
 * @property {string | null} title
 * @property {boolean} running
 * @property {string | null} cwd
 * @property {number} updatedAt
 * @property {boolean} blank
 * @property {string | null} parentSessionId
 * @property {string | null} origin
 * @property {number | null} lastTurn
 * @property {number} turns
 * @property {number} steps
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} usage
 * @property {number | null} contextTokens
 * @property {number | null} contextWindow
 * @property {string | null} model
 * @property {string | null} reasoningEffort
 * @property {string | null} preset
 * @property {string | null} approvalPolicy
 * @property {string | null} sandbox
 * @property {number | null} updatedAtModel
 */

/**
 * @typedef {object} TurnToolView
 * @property {string} name
 * @property {boolean} ok
 * @property {string} argsPreview
 * @property {string} resultPreview
 * @property {string | null} error
 */

/**
 * @typedef {object} TurnChangesView
 * @property {number} total
 * @property {number} added
 * @property {number} deleted
 * @property {Array<{ path: string, display: string, added: number, deleted: number, binary: boolean, oversized: boolean }>} files
 */

/**
 * @typedef {object} TurnAttachmentView
 * @property {'image'|'file'} kind
 * @property {string} name
 * @property {string | null} mediaType
 * @property {number | null} bytes
 * @property {string | null} hostPath Resolved Host path when the attachment provider exposes one
 */

/**
 * @typedef {object} TurnDeliverableView
 * @property {string} path absolute path recorded by the `present` tool
 * @property {string | null} description
 */

/**
 * @typedef {object} TurnView
 * @property {number} turn
 * @property {string} userText
 * @property {string} assistantText
 * @property {string[]} assistantTexts
 * @property {TurnToolView[]} tools
 * @property {TurnAttachmentView[]} attachments
 * @property {TurnDeliverableView[]} deliverables
 * @property {'completed'|'error'|'aborted'|'blocked'|'max-tokens'|'interrupted'|'forked'|'open'} endReason
 * @property {string | null} errorMessage
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number, total: number }} usage
 * @property {number | null} startedAt
 * @property {number | null} endedAt
 * @property {TurnChangesView | null} changes
 */

/**
 * @typedef {object} RecentTurnsView
 * @property {string} id
 * @property {string | null} title
 * @property {string | null} cwd
 * @property {TurnView[]} turns
 */

/**
 * Create the DSH-backed bridge used by the Telegram plugin.
 *
 * The returned object is stateless apart from the resolved logger; every call
 * re-reads the Host services from `ctx`, so profile changes are observed without
 * re-creating the bridge.
 *
 * @param {object} ctx Cordis Host context (services resolved with `ctx.get(name)`).
 * @returns {{
 *   listSessions: (options?: { signal?: AbortSignal }) => Promise<SessionSummaryView[]>,
 *   getStatus: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<SessionStatusView>,
 *   readRecentTurns: (sessionId: string, options?: { turns?: number, maxEvents?: number, signal?: AbortSignal }) => Promise<RecentTurnsView>,
 *   prompt: (sessionId: string, text: string, options?: { mode?: 'queue' | 'steer', signal?: AbortSignal }) => Promise<{ accepted: true }>,
 *   steer: (sessionId: string, text: string, options?: { signal?: AbortSignal }) => Promise<{ accepted: true }>,
 *   cancel: (sessionId: string) => Promise<{ accepted: true }>,
 *   createSession: (options?: { cwd?: string, workspaceId?: string }) => Promise<{ sessionId: string }>,
 *   rename: (sessionId: string, title: string) => Promise<{ title: string, seq: number | null }>,
 *   hasLiveClient: () => boolean,
 *   advertisedUrl: () => string | undefined,
 *   findSession: (sessions: SessionSummaryView[], query: string) => ({ match: SessionSummaryView } | { candidates: SessionSummaryView[] } | { error: 'not-found' | 'ambiguous' }),
 * }}
 */
export function createBridge(ctx) {
  const logger = resolveLogger(ctx);
  return {
    /** @type {() => Promise<SessionSummaryView[]>} */
    listSessions: (options = {}) => listSessionsImpl(ctx, logger, options),

    /** @type {(sessionId: string, options?: object) => Promise<SessionStatusView>} */
    getStatus: (sessionId, options = {}) => getStatusImpl(ctx, logger, sessionId, options),

    /** @type {(sessionId: string, options?: object) => Promise<RecentTurnsView>} */
    readRecentTurns: (sessionId, options = {}) =>
      readRecentTurnsImpl(ctx, logger, sessionId, options),

    /** @type {(sessionId: string, text: string, options?: object) => Promise<{ accepted: true }>} */
    prompt: (sessionId, text, options = {}) => promptImpl(ctx, logger, sessionId, text, options),

    /** @type {(sessionId: string, text: string, options?: object) => Promise<{ accepted: true }>} */
    steer: (sessionId, text, options = {}) =>
      promptImpl(ctx, logger, sessionId, text, { ...asRecord(options), mode: 'steer' }),

    /** @type {(sessionId: string) => Promise<{ accepted: true }>} */
    cancel: (sessionId) => cancelImpl(ctx, logger, sessionId),

    /** @type {(options?: object) => Promise<{ sessionId: string }>} */
    createSession: (options = {}) => createSessionImpl(ctx, logger, options),

    /** @type {(sessionId: string, title: string) => Promise<{ title: string, seq: number | null }>} */
    rename: (sessionId, title) => renameImpl(ctx, logger, sessionId, title),

    /** @type {() => boolean} */
    hasLiveClient: () => hasLiveClientImpl(ctx),

    /** @type {() => string | undefined} */
    advertisedUrl: () => advertisedUrlImpl(ctx),

    /** @type {(sessions: SessionSummaryView[], query: string) => object} */
    findSession: (sessions, query) => findSessionImpl(sessions, query),
  };
}

// ---------------------------------------------------------------------------
// Session reads
// ---------------------------------------------------------------------------

/**
 * Read the registry-global archived Session ids.
 *
 * The archive set lives on the Workspace registry entity (the same getter the
 * Host's own workspace feed reads). It is optional: a profile without a
 * Workspace registry simply has nothing archived.
 *
 * @param {object} ctx
 * @returns {Set<string>}
 */
function readArchivedSessionIds(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry');
    const ids = registry?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * List every visible session, newest activity first.
 *
 * Titles come from one batched `sessionQuery.readTitleSnapshots` read. The
 * batch is fully isolated: a rejected entry (or a failed batch) only leaves that
 * session titled `null`.
 *
 * @param {object} ctx
 * @param {object | null} logger
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<SessionSummaryView[]>}
 */
async function listSessionsImpl(ctx, logger, options) {
  const signal = options?.signal;
  const controller = requireSessionController(ctx);

  let listed;
  try {
    listed = await controller.list({}, signal);
  } catch (error) {
    throw translateServiceError(error);
  }

  const items = Array.isArray(listed?.items) ? listed.items : [];
  const archived = readArchivedSessionIds(ctx);
  const views = [];
  for (const item of items) {
    const view = summaryToView(item);
    if (!view) continue;
    view.archived = archived.has(String(view.id));
    views.push(view);
  }

  if (views.length > 0) {
    const titles = await readTitleBatch(
      ctx,
      views.map((view) => view.id),
      signal,
      logger,
    );
    for (const view of views) {
      const title = titles.get(view.id);
      if (title) view.title = title;
    }
  }

  // Newest first; session id is a stable tie-breaker for identical timestamps.
  views.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  return views;
}

/**
 * Read one session's status view from the session list plus projection values.
 *
 * A missing projection value becomes `null` (or `0` for counters) instead of
 * failing the command. A wholly missing session raises `session-not-found`.
 *
 * @param {object} ctx
 * @param {object | null} logger
 * @param {string} sessionId
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<SessionStatusView>}
 */
async function getStatusImpl(ctx, logger, sessionId, options) {
  const signal = options?.signal;
  const id = requireSessionId(sessionId);
  const controller = requireSessionController(ctx);

  let listed;
  try {
    listed = await controller.list({}, signal);
  } catch (error) {
    throw translateServiceError(error);
  }

  const items = Array.isArray(listed?.items) ? listed.items : [];
  const summary = items.find((item) => item && toNullableString(item.sessionId) === id) ?? null;
  const base = summaryToView(summary);

  let values = null;
  if (typeof controller.projections === 'function') {
    try {
      values = projectionValues(await controller.projections({ sessionId: id }, signal));
    } catch (error) {
      const translated = translateServiceError(error);
      // A missing session is a real answer; any other projection failure only
      // costs us the projection fields, so the command still renders.
      if (translated.code === 'session-not-found') throw translated;
      warn(logger, `Session projection read failed for ${id}`, error);
      values = null;
    }
  }

  if (!base && !values) {
    throw new BridgeError('session-not-found', `Session ${id} was not found`);
  }

  const stats = asRecord(values?.sessionStats) ?? {};
  const totals = asRecord(values?.tokenUsage?.totals) ?? {};
  const permissions = asRecord(values?.permissions) ?? {};
  const listMetadata = asRecord(values?.sessionListMetadata) ?? {};
  const modelSelection = asRecord(values?.modelSelection) ?? {};
  const lastUsed = asRecord(modelSelection.lastUsed) ?? {};
  const pressure = asRecord(values?.contextPressure) ?? {};

  let title = toNullableString(values?.title) ?? base?.title ?? null;
  if (!title) {
    const titles = await readTitleBatch(ctx, [id], signal, logger);
    title = titles.get(id) ?? null;
  }

  return {
    id,
    title,
    running: base?.running === true,
    cwd: base?.cwd ?? null,
    updatedAt: base?.updatedAt ?? 0,
    blank: base?.blank ?? listMetadata.blank === true,
    parentSessionId: base?.parentSessionId ?? null,
    origin: base?.origin ?? null,
    lastTurn: toFiniteNumber(stats.lastTurn) ?? null,
    turns: toCount(stats.turns),
    steps: toCount(stats.steps),
    usage: {
      input: toCount(totals.uncachedInputTokens),
      output: toCount(totals.outputTokens),
      cacheRead: toCount(totals.cacheReadTokens),
      cacheWrite: toCount(totals.cacheWriteTokens),
    },
    contextTokens: toFiniteNumber(pressure.surfaceTokens) ?? null,
    contextWindow: toFiniteNumber(pressure.contextWindow) ?? null,
    model: toNullableString(lastUsed.model) ?? toNullableString(modelSelection.model) ?? null,
    reasoningEffort: toNullableString(lastUsed.reasoningEffort) ?? null,
    preset: policyString(permissions.preset),
    approvalPolicy: policyString(permissions.approval),
    sandbox: policyString(permissions.sandbox),
    updatedAtModel: toFiniteNumber(modelSelection.updatedAt) ?? toFiniteNumber(lastUsed.updatedAt) ?? null,
  };
}

/**
 * Fold the tail of a session log into renderable turn views.
 *
 * The fold is intentionally read-only and best-effort: unknown event types are
 * ignored, a non-user `user/message` surface is skipped, and a failed workspace
 * changes summary only nulls that turn's `changes`.
 *
 * @param {object} ctx
 * @param {object | null} logger
 * @param {string} sessionId
 * @param {{ turns?: number, maxEvents?: number, signal?: AbortSignal }} options
 * @returns {Promise<RecentTurnsView>}
 */
async function readRecentTurnsImpl(ctx, logger, sessionId, options) {
  const id = requireSessionId(sessionId);
  const controller = requireSessionController(ctx);
  const signal = options?.signal;
  const turnLimit = clampInteger(options?.turns, DEFAULT_TURN_LIMIT, 1, MAX_TURN_LIMIT);
  const maxEvents = clampInteger(options?.maxEvents, DEFAULT_MAX_EVENTS, 1, MAX_EVENT_SCAN);

  let inspection;
  try {
    inspection = await controller.inspect(id, signal);
  } catch (error) {
    throw translateServiceError(error);
  }
  if (!inspection || typeof inspection !== 'object') {
    throw new BridgeError('session-not-found', `Session ${id} was not found`);
  }

  const meta = asRecord(inspection.meta) ?? {};
  const events = Array.isArray(inspection.events)
    ? inspection.events.filter((event) => event && typeof event === 'object')
    : [];

  const windowEvents = selectEventWindow(events, turnLimit, maxEvents);
  const folded = foldTurns(windowEvents);
  folded.sort((left, right) => left.turn - right.turn);
  const selected = folded.slice(-turnLimit);

  const changes = await Promise.all(
    selected.map((state) => readChangesSummary(ctx, logger, id, state.changesSeq)),
  );
  const attachments = getService(ctx, 'attachments');
  selected.forEach((state, index) => {
    state.changes = changes[index];
    if (Array.isArray(state.attachments) && state.attachments.length > 0) {
      state.attachmentViews = projectAttachments(attachments, state.attachments);
    }
  });

  const titles = await readTitleBatch(ctx, [id], signal, logger);
  return {
    id,
    title: titles.get(id) ?? null,
    cwd: toNullableString(meta.cwd),
    turns: selected.map((state) => turnStateToView(state)),
  };
}

/**
 * Pick the event window that contains the last `turnLimit` turns.
 *
 * A turn's `turn/start` opens the window, and any user message the Host wrote
 * just before that start (pending inbox claim) is pulled in as well.
 *
 * @param {object[]} events
 * @param {number} turnLimit
 * @param {number} maxEvents
 * @returns {object[]}
 */
function selectEventWindow(events, turnLimit, maxEvents) {
  if (events.length === 0) return [];

  const startIndexes = [];
  for (let index = 0; index < events.length; index += 1) {
    if (eventType(events[index]) === 'turn/start') startIndexes.push(index);
  }

  let from = 0;
  if (startIndexes.length > turnLimit) {
    from = startIndexes[startIndexes.length - turnLimit];
  } else if (startIndexes.length > 0) {
    from = startIndexes[0];
  }

  let scanStart = from;
  for (let index = from - 1; index >= 0; index -= 1) {
    const type = eventType(events[index]);
    if (type === 'turn/start' || type === 'turn/end') break;
    if (type === 'user/message') scanStart = index;
  }

  const windowEvents = events.slice(scanStart);
  if (windowEvents.length <= maxEvents) return windowEvents;
  return windowEvents.slice(windowEvents.length - maxEvents);
}

/**
 * Sequentially fold a chronological event slice into turn states.
 *
 * @param {object[]} events
 * @returns {object[]}
 */
function foldTurns(events) {
  /** @type {Map<number, object>} */
  const states = new Map();
  /** @type {string[]} */
  let pendingUserTexts = [];
  /** @type {number | null} */
  let openTurn = null;
  /** @type {number | null} */
  let lastTurn = null;

  const ensureTurn = (turn) => {
    let state = states.get(turn);
    if (!state) {
      state = createTurnState(turn);
      states.set(turn, state);
    }
    return state;
  };

  const explicitTurn = (data, fallback = null) => {
    const value = toFiniteNumber(data?.turn);
    return value == null ? fallback : Math.trunc(value);
  };

  // A user prompt can be written before its turn opens. Such text waits here
  // and is attached to the next turn that proves it owns a turn number. Normal
  // logs resolve this on `turn/start`; logs without turn markers resolve it on
  // the first turn-scoped event instead.
  const flushPendingUserTexts = (state) => {
    if (pendingUserTexts.length === 0 || state.userTexts.length > 0) return;
    state.userTexts.push(...pendingUserTexts);
    pendingUserTexts = [];
  };

  for (const event of events) {
    const type = eventType(event);
    const data = eventData(event);
    const time = eventTime(event);

    if (type === 'turn/start') {
      const turn = explicitTurn(data, lastTurn == null ? 1 : lastTurn + 1);
      const state = ensureTurn(turn);
      state.hasStart = true;
      state.startedAt = time;
      openTurn = turn;
      lastTurn = turn;
      flushPendingUserTexts(state);
      continue;
    }

    if (type === 'turn/end') {
      const turn = explicitTurn(data, openTurn);
      if (turn == null) continue;
      const state = ensureTurn(turn);
      state.endReason = normalizeEndReason(data.reason);
      state.errorMessage = turnEndErrorMessage(data.reason);
      state.endedAt = time;
      if (openTurn === turn) openTurn = null;
      lastTurn = lastTurn == null ? turn : Math.max(lastTurn, turn);
      continue;
    }

    if (type === 'user/message') {
      const sourceKind = data?.source?.kind;
      // Only user-authored surface events belong in `userText`; replayed model
      // or system messages are skipped. A missing source is tolerated as user.
      if (sourceKind != null && sourceKind !== 'user') continue;
      const text = textFromContent(data?.content);
      if (!text) continue;
      const turn = explicitTurn(data, openTurn);
      if (turn == null) {
        pendingUserTexts.push(text);
        continue;
      }
      ensureTurn(turn).userTexts.push(text);
      continue;
    }

    if (type === 'assistant/message') {
      const turn = explicitTurn(data, openTurn);
      if (turn == null) continue;
      const state = ensureTurn(turn);
      flushPendingUserTexts(state);
      const message = asRecord(data?.message) ?? {};
      for (const block of contentBlocks(message.content)) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          state.assistantTexts.push(block.text);
        } else if (block?.type === 'image' && asRecord(block.attachment)) {
          state.attachments.push({ kind: 'image', ref: asRecord(block.attachment) });
        } else if (block?.type === 'file' && asRecord(block.attachment)) {
          state.attachments.push({ kind: 'file', ref: asRecord(block.attachment) });
        }
      }
      for (const call of toolCallsFromContent(message.content)) {
        const record = ensureTool(state, call.id);
        record.name = call.name;
        record.argsPreview = previewText(call.arguments);
      }
      addUsage(state, data?.usage);
      continue;
    }

    if (type === 'tool/call') {
      const turn = explicitTurn(data, openTurn);
      if (turn == null) continue;
      const state = ensureTurn(turn);
      flushPendingUserTexts(state);
      const record = ensureTool(state, toNullableString(data?.callId));
      record.name = toNullableString(data?.name) ?? record.name;
      record.argsPreview = previewText(data?.arguments);
      continue;
    }

    if (type === 'tool/result') {
      const turn = explicitTurn(data, openTurn);
      if (turn == null) continue;
      const state = ensureTurn(turn);
      flushPendingUserTexts(state);
      const message = asRecord(data?.message) ?? {};
      const callId =
        toNullableString(message.toolCallId) ?? toNullableString(data?.callId);
      const record = ensureTool(state, callId);
      const resultText = textFromContent(message.content);
      record.resultPreview = previewText(resultText);
      const failure = asRecord(data?.error);
      const failed = message.isError === true || failure != null;
      record.ok = !failed;
      record.error = failed ? describeToolFailure(failure, record.resultPreview) : null;
      continue;
    }

    // The `present` tool's successful calls append this event with absolute
    // paths; it is the authoritative deliverable list the DSH UI renders.
    if (type === 'deliverables/presented') {
      const turn = explicitTurn(data, openTurn);
      if (turn == null) continue;
      const state = ensureTurn(turn);
      flushPendingUserTexts(state);
      const files = Array.isArray(data?.files) ? data.files : [];
      for (const file of files) {
        const record = asRecord(file);
        const path = toNullableString(record?.path);
        if (path === null) continue;
        state.deliverables.push({ path, description: toNullableString(record?.description) });
      }
      continue;
    }

    if (type === 'workspace/changes') {
      const turn = explicitTurn(data, openTurn);
      if (turn == null) continue;
      const seq = eventSeq(event);
      if (seq == null) continue;
      const state = ensureTurn(turn);
      flushPendingUserTexts(state);
      state.changesSeq = seq;
    }
  }

  return [...states.values()];
}

/**
 * Read and project one workspace change summary; failures are non-fatal.
 *
 * @param {object} ctx
 * @param {object | null} logger
 * @param {string} sessionId
 * @param {number | null} seq
 * @returns {Promise<TurnChangesView | null>}
 */
async function readChangesSummary(ctx, logger, sessionId, seq) {
  if (seq == null) return null;
  const service = getService(ctx, 'workspaceChanges');
  if (!service || typeof service.summary !== 'function') return null;
  try {
    return projectChangesSummary(await service.summary(sessionId, seq));
  } catch (error) {
    warn(logger, `Workspace changes summary failed for ${sessionId}`, error);
    return null;
  }
}

/**
 * @param {unknown} summary
 * @returns {TurnChangesView | null}
 */
function projectChangesSummary(summary) {
  const record = asRecord(summary);
  if (!record) return null;

  const files = [];
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      const item = asRecord(file);
      if (!item) continue;
      const path = toNullableString(item.path) ?? '';
      files.push({
        path,
        display: toNullableString(item.display) ?? path,
        added: toCount(item.added),
        deleted: toCount(item.deleted),
        binary: item.binary === true,
        oversized: item.oversized === true,
      });
    }
  }

  return {
    total: toFiniteNumber(record.total) ?? files.length,
    added: toFiniteNumber(record.added) ?? files.reduce((sum, file) => sum + file.added, 0),
    deleted: toFiniteNumber(record.deleted) ?? files.reduce((sum, file) => sum + file.deleted, 0),
    files,
  };
}

/**
 * Project one turn's model-attached images/files into sendable records.
 *
 * Attachments are read through the Host attachments service; when the provider
 * does not expose a Host path (e.g. a browser-only store) the entry is kept but
 * stays unsendable and the command layer skips it.
 *
 * @param {object | undefined} service Host attachments service
 * @param {Array<{ kind: 'image'|'file', ref: object }>} entries
 * @returns {TurnAttachmentView[]}
 */
function projectAttachments(service, entries) {
  const views = [];
  const seen = new Set();
  for (const entry of entries) {
    const ref = entry.ref ?? {};
    const id = toNullableString(ref.attachmentId) ?? toNullableString(ref.name) ?? null;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    let hostPath = null;
    try {
      hostPath = entry.kind === 'image'
        ? toNullableString(service?.imageHostPath?.(ref))
        : toNullableString(service?.fileHostPath?.(ref));
    } catch {
      hostPath = null;
    }
    views.push({
      kind: entry.kind,
      name: toNullableString(ref.name) ?? (entry.kind === 'image' ? 'image' : 'file'),
      mediaType: toNullableString(ref.mediaType),
      bytes: toFiniteNumber(ref.bytes),
      hostPath,
    });
  }
  return views;
}

/**
 * @param {object} state
 * @returns {TurnView}
 */
function turnStateToView(state) {
  return {
    turn: state.turn,
    userText: state.userTexts.join('\n\n'),
    assistantText: state.assistantTexts.join('\n\n'),
    assistantTexts: state.assistantTexts.slice(),
    attachments: Array.isArray(state.attachmentViews) ? state.attachmentViews : [],
    deliverables: Array.isArray(state.deliverables) ? state.deliverables.slice() : [],
    tools: state.tools.map((tool) => ({
      name: tool.name,
      ok: tool.ok,
      argsPreview: tool.argsPreview,
      resultPreview: tool.resultPreview,
      error: tool.error,
    })),
    endReason: state.endReason ?? 'open',
    errorMessage: state.errorMessage ?? null,
    usage: {
      input: state.usage.input,
      output: state.usage.output,
      cacheRead: state.usage.cacheRead,
      cacheWrite: state.usage.cacheWrite,
      total: state.usage.total,
    },
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    changes: state.changes ?? null,
  };
}

/**
 * @param {number} turn
 * @returns {object}
 */
function createTurnState(turn) {
  return {
    turn,
    hasStart: false,
    userTexts: [],
    assistantTexts: [],
    attachments: [],
    deliverables: [],
    tools: [],
    toolByCallId: new Map(),
    endReason: null,
    errorMessage: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    startedAt: null,
    endedAt: null,
    changesSeq: null,
    changes: null,
  };
}

/**
 * Find or create the tool record for one call id, preserving call order.
 *
 * @param {object} state
 * @param {string | null} callId
 * @returns {object}
 */
function ensureTool(state, callId) {
  if (callId != null) {
    const existing = state.toolByCallId.get(callId);
    if (existing) return existing;
  }
  const record = {
    callId: callId ?? null,
    name: 'tool',
    ok: false,
    argsPreview: '',
    resultPreview: '',
    error: null,
  };
  state.tools.push(record);
  if (callId != null) state.toolByCallId.set(callId, record);
  return record;
}

/**
 * @param {object} state
 * @param {unknown} usage
 */
function addUsage(state, usage) {
  const record = asRecord(usage);
  if (!record) return;
  const input = toCount(record.inputTokens);
  const output = toCount(record.outputTokens);
  const cacheRead = toCount(record.cacheReadTokens);
  const cacheWrite = toCount(record.cacheWriteTokens);
  state.usage.input += input;
  state.usage.output += output;
  state.usage.cacheRead += cacheRead;
  state.usage.cacheWrite += cacheWrite;
  state.usage.total += input + output + cacheRead + cacheWrite;
}

/**
 * @param {unknown} reason
 * @returns {TurnView['endReason']}
 */
function normalizeEndReason(reason) {
  const kind = asRecord(reason)?.kind;
  return typeof kind === 'string' && TURN_END_REASONS.has(kind)
    ? /** @type {TurnView['endReason']} */ (kind)
    : 'completed';
}

/**
 * @param {unknown} reason
 * @returns {string | null}
 */
function turnEndErrorMessage(reason) {
  const record = asRecord(reason);
  if (!record) return null;
  return (
    toNullableString(record.error && asRecord(record.error)?.message) ??
    toNullableString(record.reason && asRecord(record.reason)?.reason) ??
    toNullableString(record.message)
  );
}

/**
 * @param {object | null} failure
 * @param {string} fallbackText
 * @returns {string}
 */
function describeToolFailure(failure, fallbackText) {
  const record = failure && asRecord(failure);
  return (
    toNullableString(record?.reason) ??
    toNullableString(record?.message) ??
    toNullableString(record?.code) ??
    toNullableString(record?.name) ??
    fallbackText ??
    'Tool failed'
  );
}

// ---------------------------------------------------------------------------
// Session mutations
// ---------------------------------------------------------------------------

/**
 * Admit one user prompt into a session.
 *
 * @param {object} ctx
 * @param {object | null} logger
 * @param {string} sessionId
 * @param {string} text
 * @param {{ mode?: 'queue' | 'steer', signal?: AbortSignal }} options
 * @returns {Promise<{ accepted: true }>}
 */
async function promptImpl(ctx, logger, sessionId, text, options) {
  const id = requireSessionId(sessionId);
  const controller = requireSessionController(ctx);
  const request = {
    requestId: randomUUID(),
    sessionId: id,
    mode: options?.mode === 'steer' ? 'steer' : 'queue',
    content: [
      {
        type: 'text',
        text: typeof text === 'string' ? text : String(text ?? ''),
      },
    ],
    clientTimeZone: resolvedTimeZone(),
  };
  try {
    // The Host's session-controller prompt method takes a REQUIRED
    // AbortSignal (it calls signal.throwIfAborted() on admission), unlike the
    // read-only methods that tolerate an omitted one. Never pass undefined.
    const signal = options?.signal ?? new AbortController().signal;
    await controller.prompt(request, signal);
  } catch (error) {
    throw translateServiceError(error);
  }
  return { accepted: true };
}

/**
 * Cancel the active turn of one session (pending inbox stays queued).
 *
 * @param {object} ctx
 * @param {object | null} logger
 * @param {string} sessionId
 * @returns {Promise<{ accepted: true }>}
 */
async function cancelImpl(ctx, logger, sessionId) {
  const id = requireSessionId(sessionId);
  const controller = requireSessionController(ctx);
  try {
    await controller.cancel({ sessionId: id });
  } catch (error) {
    throw translateServiceError(error);
  }
  return { accepted: true };
}

/**
 * Create a new blank session.
 *
 * @param {object} ctx
 * @param {object | null} logger
 * @param {{ cwd?: string, workspaceId?: string }} options
 * @returns {Promise<{ sessionId: string }>}
 */
async function createSessionImpl(ctx, logger, options) {
  const controller = requireSessionController(ctx);
  const request = {};
  if (options?.cwd !== undefined) request.cwd = options.cwd;
  if (options?.workspaceId !== undefined) request.workspaceId = options.workspaceId;

  let result;
  try {
    result = await controller.create(request);
  } catch (error) {
    throw translateServiceError(error);
  }

  const sessionId =
    toNullableString(result?.sessionId) ??
    toNullableString(result?.session?.sessionId) ??
    toNullableString(result?.id);
  if (!sessionId) {
    throw new BridgeError('unavailable', 'Session controller did not return a session id');
  }
  return { sessionId };
}

/**
 * Rename one session.
 *
 * @param {object} ctx
 * @param {object | null} logger
 * @param {string} sessionId
 * @param {string} title
 * @returns {Promise<{ title: string, seq: number | null }>}
 */
async function renameImpl(ctx, logger, sessionId, title) {
  const id = requireSessionId(sessionId);
  const controller = requireSessionController(ctx);
  const nextTitle = typeof title === 'string' ? title : String(title ?? '');

  let result;
  try {
    result = await controller.rename({ sessionId: id, title: nextTitle });
  } catch (error) {
    throw translateServiceError(error);
  }
  return {
    title: toNullableString(result?.title) ?? nextTitle,
    seq: toFiniteNumber(result?.seq) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Optional Host capabilities
// ---------------------------------------------------------------------------

/**
 * Whether an owner Client event stream is attached (forwarded approvals etc.).
 *
 * @param {object} ctx
 * @returns {boolean}
 */
function hasLiveClientImpl(ctx) {
  const gateway = getService(ctx, 'typertGateway');
  if (!gateway || typeof gateway.hasLiveClient !== 'function') return false;
  try {
    return gateway.hasLiveClient() === true;
  } catch {
    return false;
  }
}

/**
 * URL of the advertised Web GUI, when this deployment serves one.
 *
 * @param {object} ctx
 * @returns {string | undefined}
 */
function advertisedUrlImpl(ctx) {
  const webApp = getService(ctx, 'webApp');
  if (!webApp || typeof webApp.getAdvertisedUrl !== 'function') return undefined;
  try {
    const url = webApp.getAdvertisedUrl();
    if (typeof url === 'string' && url.trim()) return url;
    if (url && typeof url.href === 'string' && url.href.trim()) return url.href;
  } catch {
    // Optional capability: absence is the answer.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

/**
 * Resolve a user query against a session list.
 *
 * Query precedence: 1-based index, exact id, unique case-insensitive id prefix,
 * then unique case-insensitive title substring. Ambiguous id/title matches
 * return up to {@link MAX_FIND_CANDIDATES} candidates instead of guessing.
 *
 * @param {SessionSummaryView[]} sessions
 * @param {string} query
 * @returns {{ match: SessionSummaryView } | { candidates: SessionSummaryView[] } | { error: 'not-found' | 'ambiguous' }}
 */
function findSessionImpl(sessions, query) {
  const list = Array.isArray(sessions)
    ? sessions.filter((session) => session && typeof session === 'object')
    : [];
  const needle = typeof query === 'string' ? query.trim() : String(query ?? '').trim();
  if (!needle) return { error: 'not-found' };

  if (/^\d+$/.test(needle)) {
    const index = Number(needle);
    if (index >= 1 && index <= list.length) return { match: list[index - 1] };
  }

  const exact = list.find((session) => String(session.id) === needle);
  if (exact) return { match: exact };

  const lower = needle.toLowerCase();
  const prefixMatches = list.filter(
    (session) =>
      typeof session.id === 'string' && session.id.toLowerCase().startsWith(lower),
  );
  if (prefixMatches.length === 1) return { match: prefixMatches[0] };
  if (prefixMatches.length > 1) {
    return { candidates: prefixMatches.slice(0, MAX_FIND_CANDIDATES) };
  }

  const titleMatches = list.filter(
    (session) =>
      typeof session.title === 'string' && session.title.toLowerCase().includes(lower),
  );
  if (titleMatches.length === 1) return { match: titleMatches[0] };
  if (titleMatches.length > 1) {
    return { candidates: titleMatches.slice(0, MAX_FIND_CANDIDATES) };
  }

  return { error: 'not-found' };
}

// ---------------------------------------------------------------------------
// Title enrichment
// ---------------------------------------------------------------------------

/**
 * Batch-read titles; every failure path degrades to "no title for that id".
 *
 * @param {object} ctx
 * @param {string[]} sessionIds
 * @param {AbortSignal | undefined} signal
 * @param {object | null} logger
 * @returns {Promise<Map<string, string>>}
 */
async function readTitleBatch(ctx, sessionIds, signal, logger) {
  /** @type {Map<string, string>} */
  const titles = new Map();
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return titles;

  const sessionQuery = getService(ctx, 'sessionQuery');
  if (!sessionQuery || typeof sessionQuery.readTitleSnapshots !== 'function') return titles;

  let results;
  try {
    results = await sessionQuery.readTitleSnapshots(sessionIds, signal);
  } catch (error) {
    warn(logger, 'Session title batch read failed', error);
    return titles;
  }
  if (!Array.isArray(results)) return titles;

  for (const result of results) {
    if (!result || result.status !== 'fulfilled') continue;
    const sessionId =
      toNullableString(result.sessionId) ?? toNullableString(result.value?.session?.id);
    const title = toNullableString(result.value?.title?.title);
    if (sessionId && title) titles.set(sessionId, title);
  }
  return titles;
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} summary
 * @returns {SessionSummaryView | null}
 */
function summaryToView(summary) {
  const record = asRecord(summary);
  if (!record) return null;
  const id = toNullableString(record.sessionId);
  if (!id) return null;
  return {
    id,
    title: inlineProjectionTitle(record.projections),
    running: record.running === true,
    cwd: toNullableString(record.cwd),
    updatedAt: toFiniteNumber(record.updatedAt) ?? 0,
    agentAvailable: record.agentAvailable === true,
    blank: record.blank === true,
    parentSessionId: toNullableString(record.parentSessionId),
    origin: policyString(record.origin),
  };
}

/**
 * @param {unknown} projections SessionProjectionHints from a session summary.
 * @returns {string | null}
 */
function inlineProjectionTitle(projections) {
  const record = asRecord(projections);
  if (!record) return null;
  const values = asRecord(record.values);
  return toNullableString(values?.title) ?? toNullableString(record.title);
}

/**
 * @param {unknown} result SessionProjectionsValue
 * @returns {Record<string, unknown> | null}
 */
function projectionValues(result) {
  const record = asRecord(result);
  if (!record) return null;
  return asRecord(record.values);
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Translate a Host service failure into a {@link BridgeError}.
 *
 * @param {unknown} error
 * @returns {BridgeError}
 */
function translateServiceError(error) {
  if (error instanceof BridgeError) return error;
  const code = classifyServiceError(error);
  const rawMessage =
    error && typeof error.message === 'string' ? error.message.trim() : '';
  const message =
    rawMessage ||
    (code === 'session-not-found'
      ? 'Session not found'
      : code === 'session-busy'
        ? 'Session is busy'
        : 'Session controller call failed');
  return new BridgeError(code, message, error);
}

/**
 * @param {unknown} error
 * @returns {'session-not-found' | 'session-busy' | 'unavailable'}
 */
function classifyServiceError(error) {
  const parts = [];
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    for (const key of ['code', 'name', 'message']) {
      const value = error[key];
      if (typeof value === 'string') parts.push(value);
    }
  } else if (typeof error === 'string') {
    parts.push(error);
  }
  const text = parts.join(' ').toLowerCase();
  if (/(not[ _-]?found|missing|does not exist|no such)/.test(text)) {
    return 'session-not-found';
  }
  if (/(busy|writer|locked|in progress|already running|conflict)/.test(text)) {
    return 'session-busy';
  }
  return 'unavailable';
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve one optional Host service; `ctx.get` itself may be absent or throw.
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {any}
 */
function getService(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return null;
  try {
    return ctx.get(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} ctx
 * @returns {object | null}
 */
function resolveLogger(ctx) {
  const candidates = [];
  try {
    candidates.push(ctx?.logger);
  } catch {
    // ignore a throwing logger getter
  }
  candidates.push(getService(ctx, 'logger'));
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      (typeof candidate.warn === 'function' || typeof candidate.info === 'function')
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Log through the shared Host logger without ever letting logging fail a call.
 *
 * @param {object | null} logger
 * @param {string} message
 * @param {unknown} error
 */
function warn(logger, message, error) {
  try {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(message, error);
    } else if (logger && typeof logger.info === 'function') {
      logger.info(message, error);
    }
  } catch {
    // Diagnostics must never break a bot command.
  }
}

/**
 * @param {object} ctx
 * @returns {object}
 */
function requireSessionController(ctx) {
  const controller = getService(ctx, 'sessionController');
  if (!controller) throw new BridgeError('unavailable', SESSION_CONTROLLER_UNAVAILABLE);
  return controller;
}

/**
 * @param {unknown} sessionId
 * @returns {string}
 */
function requireSessionId(sessionId) {
  if (typeof sessionId === 'string' && sessionId.trim()) return sessionId.trim();
  throw new BridgeError('session-not-found', 'A session id is required');
}

/**
 * @param {number} value
 * @returns {string | null}
 */
function toNullableString(value) {
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Project a counter defensively: missing/negative/non-finite becomes 0.
 *
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  const number = toFiniteNumber(value);
  if (number == null || number <= 0) return 0;
  return Math.trunc(number);
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInteger(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < min) return fallback;
  return Math.min(integer, max);
}

/**
 * Project a permission-ish value (string or `{ kind | mode | name }`) to text.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function policyString(value) {
  if (typeof value === 'string') return value.trim() ? value : null;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ['kind', 'mode', 'name', 'type', 'preset', 'label', 'id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

/**
 * @param {object} event SessionEvent
 * @returns {string}
 */
function eventType(event) {
  return typeof event?.type === 'string' ? event.type : '';
}

/**
 * @param {object} event
 * @returns {Record<string, any>}
 */
function eventData(event) {
  return asRecord(event?.data) ?? event ?? {};
}

/**
 * @param {object} event
 * @returns {number | null}
 */
function eventSeq(event) {
  return toFiniteNumber(event?.seq);
}

/**
 * @param {object} event
 * @returns {number | null}
 */
function eventTime(event) {
  return toFiniteNumber(event?.time);
}

/**
 * @param {unknown} content Message content blocks (or a plain string).
 * @returns {Array<Record<string, any>>}
 */
function contentBlocks(content) {
  if (Array.isArray(content)) {
    return content.filter((block) => block && typeof block === 'object');
  }
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function textFromContent(content) {
  const texts = [];
  for (const block of contentBlocks(content)) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      texts.push(block.text);
    }
  }
  return texts.join('\n');
}

/**
 * @param {unknown} content
 * @returns {Array<{ id: string | null, name: string, arguments: unknown }>}
 */
function toolCallsFromContent(content) {
  const calls = [];
  for (const block of contentBlocks(content)) {
    if (block.type !== 'tool-call') continue;
    calls.push({
      id: toNullableString(block.id),
      name: toNullableString(block.name) ?? 'tool',
      arguments: block.arguments,
    });
  }
  return calls;
}

/**
 * One-line, bounded preview for tool arguments/results.
 *
 * @param {unknown} value
 * @param {number} [maxChars]
 * @returns {string}
 */
function previewText(value, maxChars = PREVIEW_MAX_CHARS) {
  if (value == null) return '';
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = '';
    }
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  let cut = flat.slice(0, Math.max(0, maxChars - 1));
  if (cut.length > 0 && /[\uD800-\uDBFF]/.test(cut[cut.length - 1])) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/**
 * @returns {string | undefined}
 */
function resolvedTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone ? zone : undefined;
  } catch {
    return undefined;
  }
}
