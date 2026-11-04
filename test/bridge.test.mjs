/**
 * Unit tests for lib/bridge.js.
 *
 * The fake ctx mirrors the verified Host service contracts (see SPEC.md
 * section 6): `sessionController`, `sessionQuery`, `workspaceChanges`,
 * `typertGateway`, `webApp`, all resolved lazily through `ctx.get(name)`.
 * Synthetic log events match the verified `SessionEventMap` data shapes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BridgeError, createBridge } from '../lib/bridge.js';

const S1 = 'sess-0001';
const S2 = 'sess-0002';

// ---------------------------------------------------------------------------
// Fake Host context
// ---------------------------------------------------------------------------

function sessionSummary(overrides = {}) {
  return {
    agentAvailable: true,
    sessionId: S1,
    updatedAt: 1_000,
    running: false,
    blank: false,
    ...overrides,
  };
}

function createController(overrides = {}) {
  const calls = {
    list: [],
    projections: [],
    inspect: [],
    prompt: [],
    cancel: [],
    create: [],
    rename: [],
  };
  const controller = {
    async list(request, signal) {
      calls.list.push({ request, signal });
      if (overrides.list) return overrides.list(request, signal);
      return { items: [] };
    },
    async projections(request, signal) {
      calls.projections.push({ request, signal });
      if (overrides.projections) return overrides.projections(request, signal);
      return null;
    },
    async inspect(sessionId, signal) {
      calls.inspect.push({ sessionId, signal });
      if (overrides.inspect) return overrides.inspect(sessionId, signal);
      return null;
    },
    async prompt(request, signal) {
      calls.prompt.push({ request, signal });
      if (overrides.prompt) return overrides.prompt(request, signal);
      return { accepted: true };
    },
    async cancel(request) {
      calls.cancel.push({ request });
      if (overrides.cancel) return overrides.cancel(request);
      return { accepted: true };
    },
    async create(request) {
      calls.create.push({ request });
      if (overrides.create) return overrides.create(request);
      return { sessionId: 'created-session' };
    },
    async rename(request) {
      calls.rename.push({ request });
      if (overrides.rename) return overrides.rename(request);
      return { title: request.title, seq: 7 };
    },
  };
  return { controller, calls };
}

function createContext(services = {}) {
  const logger = {
    warnings: [],
    warn(message, error) {
      this.warnings.push({ message, error });
    },
  };
  const ctx = {
    logger,
    get(name) {
      return services[name];
    },
  };
  return { ctx, logger };
}

function contextFor(controller, extras = {}) {
  return createContext({ sessionController: controller, ...extras });
}

// ---------------------------------------------------------------------------
// Synthetic session log helpers
// ---------------------------------------------------------------------------

function ev(seq, type, data, time) {
  return { seq, type, time, data };
}

function makeInspection(events, overrides = {}) {
  return {
    meta: { version: 1, id: S1, createdAt: 1, cwd: 'C:/work', isSeeded: false },
    inheritedEventCount: 0,
    events,
    ...overrides,
  };
}

const ASSISTANT_SOURCE = { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' };

/**
 * Two completed turns:
 * - turn 1: user text, one successful tool call, workspace changes, completed.
 * - turn 2: two assistant messages (usage aggregation), a failed tool call,
 *   workspace changes, error end reason.
 * A replayed `source.kind: 'model'` user/message must not leak into userText.
 */
function twoTurnEvents() {
  return [
    ev(1, 'turn/start', { turn: 1 }, 1_000),
    ev(
      2,
      'user/message',
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello there' }],
      },
      1_010,
    ),
    ev(
      3,
      'user/message',
      {
        role: 'user',
        source: { kind: 'model' },
        content: [{ type: 'text', text: 'ignored replayed text' }],
      },
      1_020,
    ),
    ev(
      4,
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          source: ASSISTANT_SOURCE,
          content: [
            { type: 'text', text: 'Hi there' },
            {
              type: 'tool-call',
              id: 'call-1',
              name: 'read_file',
              arguments: '{"path":"a.txt"}',
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5 },
      },
      1_030,
    ),
    ev(
      5,
      'tool/call',
      { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      1_040,
    ),
    ev(
      6,
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' },
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'file contents ok' }],
        },
      },
      1_050,
    ),
    ev(7, 'workspace/changes', { turn: 1 }, 1_060),
    ev(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_100),
    ev(9, 'turn/start', { turn: 2 }, 2_000),
    ev(
      10,
      'user/message',
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'second prompt' }],
      },
      2_010,
    ),
    ev(
      11,
      'assistant/message',
      {
        turn: 2,
        step: 1,
        message: {
          role: 'assistant',
          source: ASSISTANT_SOURCE,
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool-call', id: 'call-2', name: 'grep', arguments: '{"q":"x"}' },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1 },
      },
      2_020,
    ),
    ev(
      12,
      'tool/call',
      { turn: 2, step: 1, callId: 'call-2', name: 'grep', arguments: '{"q":"x"}' },
      2_030,
    ),
    ev(
      13,
      'tool/result',
      {
        turn: 2,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call-2' },
          toolCallId: 'call-2',
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        },
        error: { name: 'ToolError', code: 'tool_failed', reason: 'bad input' },
      },
      2_040,
    ),
    ev(
      14,
      'assistant/message',
      {
        turn: 2,
        step: 2,
        message: {
          role: 'assistant',
          source: ASSISTANT_SOURCE,
          content: [{ type: 'text', text: 'I failed' }],
        },
        usage: { inputTokens: 7, outputTokens: 3 },
      },
      2_050,
    ),
    ev(15, 'workspace/changes', { turn: 2 }, 2_060),
    ev(
      16,
      'turn/end',
      { turn: 2, reason: { kind: 'error', error: { code: 'rate_limit', message: 'LLM exploded' } } },
      2_100,
    ),
  ];
}

const TWO_TURN_SUMMARIES = new Map([
  [
    7,
    {
      turn: 1,
      cwd: 'C:/work',
      files: [
        { path: 'a.txt', display: 'a.txt', added: 10, deleted: 3 },
        {
          path: 'bin.dat',
          display: 'bin.dat',
          added: 0,
          deleted: 0,
          binary: true,
          oversized: true,
        },
      ],
      total: 2,
      added: 10,
      deleted: 3,
    },
  ],
  [
    15,
    {
      turn: 2,
      cwd: 'C:/work',
      files: [{ path: 'b.txt', display: 'b.txt', added: 1, deleted: 1 }],
      total: 1,
      added: 1,
      deleted: 1,
    },
  ],
]);

function createTitleQuery({ title = 'Fold title', failures = false } = {}) {
  const calls = [];
  return {
    calls,
    sessionQuery: {
      async readTitleSnapshots(ids, signal) {
        calls.push({ ids: [...ids], signal });
        if (failures) throw new Error('title store offline');
        return ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled',
          value: { session: { id: sessionId }, title: { title } },
        }));
      },
    },
  };
}

// ---------------------------------------------------------------------------
// BridgeError
// ---------------------------------------------------------------------------

test('BridgeError carries code, message and cause', () => {
  const cause = new Error('underlying');
  const error = new BridgeError('session-busy', 'Session is busy', cause);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'BridgeError');
  assert.equal(error.code, 'session-busy');
  assert.equal(error.message, 'Session is busy');
  assert.equal(error.cause, cause);
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

test('listSessions sorts newest-first and isolates a rejected title read', async () => {
  const { controller, calls } = createController({
    async list() {
      return {
        items: [
          sessionSummary({ sessionId: S2, updatedAt: 100, cwd: 'C:/two', origin: 'subagent' }),
          sessionSummary({ sessionId: S1, updatedAt: 900, running: true }),
        ],
      };
    },
  });

  const titleCalls = [];
  const { ctx } = contextFor(controller, {
    sessionQuery: {
      async readTitleSnapshots(ids, signal) {
        titleCalls.push({ ids: [...ids], signal });
        return ids.map((sessionId) =>
          sessionId === S1
            ? {
                sessionId,
                status: 'fulfilled',
                value: { session: { id: sessionId }, title: { title: 'First session' } },
              }
            : { sessionId, status: 'rejected', reason: new Error('title store down') },
        );
      },
    },
  });

  const sessions = await createBridge(ctx).listSessions();

  assert.equal(calls.list.length, 1);
  assert.deepEqual(calls.list[0].request, {});
  assert.deepEqual(titleCalls[0].ids, [S2, S1]);
  assert.deepEqual(
    sessions.map((session) => session.id),
    [S1, S2],
  );
  assert.deepEqual(sessions[0], {
    id: S1,
    title: 'First session',
    running: true,
    cwd: null,
    updatedAt: 900,
    agentAvailable: true,
    blank: false,
    parentSessionId: null,
    origin: null,
    archived: false,
  });
  assert.equal(sessions[1].title, null);
  assert.equal(sessions[1].cwd, 'C:/two');
  assert.equal(sessions[1].origin, 'subagent');
  assert.equal(sessions[1].running, false);
});

test('listSessions keeps inline projection titles when the title batch fails', async () => {
  const { controller } = createController({
    async list() {
      return {
        items: [
          sessionSummary({
            sessionId: S1,
            projections: { kind: 'sequenced', asOfSeq: 3, values: { title: 'Inline title' } },
          }),
        ],
      };
    },
  });
  const { ctx, logger } = contextFor(controller, {
    sessionQuery: {
      async readTitleSnapshots() {
        throw new Error('query backend offline');
      },
    },
  });

  const sessions = await createBridge(ctx).listSessions();
  assert.equal(sessions[0].title, 'Inline title');
  assert.equal(logger.warnings.length, 1);
});

test('listSessions works without the optional sessionQuery service', async () => {
  const { controller } = createController({
    async list() {
      return { items: [sessionSummary({ sessionId: S1 })] };
    },
  });
  const { ctx } = contextFor(controller);
  const sessions = await createBridge(ctx).listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, null);
});

test('listSessions translates a not-found service error', async () => {
  const cause = new Error('Session not found: missing');
  const { controller } = createController({
    async list() {
      throw cause;
    },
  });
  const { ctx } = contextFor(controller);

  await assert.rejects(createBridge(ctx).listSessions(), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'session-not-found');
    assert.equal(error.cause, cause);
    return true;
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('getStatus maps the base summary and every projection value', async () => {
  const { controller, calls } = createController({
    async list() {
      return {
        items: [
          sessionSummary({
            sessionId: S1,
            running: true,
            updatedAt: 5_000,
            cwd: 'C:/project',
            blank: false,
          }),
        ],
      };
    },
    async projections() {
      return {
        kind: 'sequenced',
        asOfSeq: 42,
        values: {
          title: 'Alpha',
          tokenUsage: {
            totals: {
              uncachedInputTokens: 1_200,
              outputTokens: 300,
              cacheReadTokens: 400,
              cacheWriteTokens: 50,
            },
          },
          sessionStats: { turns: 4, steps: 9, lastTurn: 3 },
          modelSelection: {
            lastUsed: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
          },
          permissions: { preset: 'default', sandbox: 'workspace-write', approval: 'never' },
          contextPressure: { surfaceTokens: 1_000, contextWindow: 64_000 },
          sessionListMetadata: { blank: false, lastPromptAt: 1_234 },
        },
      };
    },
  });
  const { ctx } = contextFor(controller);

  const status = await createBridge(ctx).getStatus(S1);

  assert.deepEqual(status, {
    id: S1,
    title: 'Alpha',
    running: true,
    cwd: 'C:/project',
    updatedAt: 5_000,
    blank: false,
    parentSessionId: null,
    origin: null,
    lastTurn: 3,
    turns: 4,
    steps: 9,
    usage: { input: 1_200, output: 300, cacheRead: 400, cacheWrite: 50 },
    contextTokens: 1_000,
    contextWindow: 64_000,
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    preset: 'default',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    updatedAtModel: null,
  });
  assert.deepEqual(calls.projections[0].request, { sessionId: S1 });
});

test('getStatus projects missing projection values to null or zero', async () => {
  const { controller } = createController({
    async list() {
      return {
        items: [sessionSummary({ sessionId: S1, updatedAt: 2_500, cwd: 'C:/p' })],
      };
    },
    async projections() {
      return null;
    },
  });
  const { sessionQuery } = createTitleQuery({ title: 'Snapshot title' });
  const { ctx } = contextFor(controller, { sessionQuery });

  const status = await createBridge(ctx).getStatus(S1);

  assert.equal(status.id, S1);
  assert.equal(status.title, 'Snapshot title');
  assert.equal(status.running, false);
  assert.equal(status.cwd, 'C:/p');
  assert.equal(status.updatedAt, 2_500);
  assert.equal(status.blank, false);
  assert.equal(status.parentSessionId, null);
  assert.equal(status.origin, null);
  assert.equal(status.lastTurn, null);
  assert.equal(status.turns, 0);
  assert.equal(status.steps, 0);
  assert.deepEqual(status.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(status.contextTokens, null);
  assert.equal(status.contextWindow, null);
  assert.equal(status.model, null);
  assert.equal(status.reasoningEffort, null);
  assert.equal(status.preset, null);
  assert.equal(status.approvalPolicy, null);
  assert.equal(status.sandbox, null);
  assert.equal(status.updatedAtModel, null);
});

test('getStatus tolerates a profile without projections or sessionQuery', async () => {
  const { controller } = createController({
    async list() {
      return {
        items: [
          sessionSummary({
            sessionId: S1,
            projections: { kind: 'cached', asOfSeq: 1, values: { title: 'Inline status title' } },
          }),
        ],
      };
    },
  });
  delete controller.projections;
  const { ctx, logger } = contextFor(controller);

  const status = await createBridge(ctx).getStatus(S1);
  assert.equal(status.title, 'Inline status title');
  assert.equal(status.lastTurn, null);
  assert.equal(logger.warnings.length, 0);
});

test('getStatus rejects unknown sessions with session-not-found', async () => {
  const { controller } = createController({
    async list() {
      return { items: [sessionSummary({ sessionId: S2 })] };
    },
    async projections() {
      return null;
    },
  });
  const { ctx } = contextFor(controller);

  await assert.rejects(createBridge(ctx).getStatus('missing-session'), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'session-not-found');
    assert.match(error.message, /not found/i);
    return true;
  });
});

test('getStatus degrades to null projections when a projection read fails', async () => {
  const { controller } = createController({
    async list() {
      return { items: [sessionSummary({ sessionId: S1 })] };
    },
    async projections() {
      throw new Error('projection backend exploded');
    },
  });
  const { ctx, logger } = contextFor(controller);

  const status = await createBridge(ctx).getStatus(S1);
  assert.equal(status.lastTurn, null);
  assert.equal(status.turns, 0);
  assert.equal(logger.warnings.length, 1);
});

test('getStatus keeps session-not-found from a projection read', async () => {
  const { controller } = createController({
    async list() {
      return { items: [sessionSummary({ sessionId: S1 })] };
    },
    async projections() {
      throw new Error('session/not-found');
    },
  });
  const { ctx } = contextFor(controller);

  await assert.rejects(createBridge(ctx).getStatus(S1), (error) => {
    assert.equal(error.code, 'session-not-found');
    return true;
  });
});

// ---------------------------------------------------------------------------
// readRecentTurns
// ---------------------------------------------------------------------------

function twoTurnBridge({ title = 'Fold title', workspaceChanges } = {}) {
  const inspection = makeInspection(twoTurnEvents());
  const { controller, calls } = createController({
    async inspect() {
      return inspection;
    },
  });
  const { sessionQuery } = createTitleQuery({ title });
  const { ctx, logger } = contextFor(controller, { sessionQuery, workspaceChanges });
  return { bridge: createBridge(ctx), calls, logger };
}

test('readRecentTurns folds turns with tools, usage, changes and end reasons', async () => {
  const summaryCalls = [];
  const workspaceChanges = {
    summary(sessionId, seq) {
      summaryCalls.push({ sessionId, seq });
      return TWO_TURN_SUMMARIES.get(seq);
    },
  };
  const { bridge, calls } = twoTurnBridge({ workspaceChanges });

  const view = await bridge.readRecentTurns(S1, { turns: 2 });

  assert.equal(calls.inspect.length, 1);
  assert.equal(calls.inspect[0].sessionId, S1);
  assert.equal(view.id, S1);
  assert.equal(view.title, 'Fold title');
  assert.equal(view.cwd, 'C:/work');
  assert.equal(view.turns.length, 2);

  const [first, second] = view.turns;
  assert.equal(first.turn, 1);
  assert.equal(first.userText, 'hello there');
  assert.equal(first.assistantText, 'Hi there');
  assert.deepEqual(first.assistantTexts, ['Hi there']);
  assert.deepEqual(first.tools, [
    {
      name: 'read_file',
      ok: true,
      argsPreview: '{"path":"a.txt"}',
      resultPreview: 'file contents ok',
      error: null,
    },
  ]);
  assert.equal(first.endReason, 'completed');
  assert.equal(first.errorMessage, null);
  assert.deepEqual(first.usage, {
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 5,
    total: 175,
  });
  assert.equal(first.startedAt, 1_000);
  assert.equal(first.endedAt, 1_100);
  assert.deepEqual(first.changes, {
    total: 2,
    added: 10,
    deleted: 3,
    files: [
      { path: 'a.txt', display: 'a.txt', added: 10, deleted: 3, binary: false, oversized: false },
      { path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0, binary: true, oversized: true },
    ],
  });

  assert.equal(second.turn, 2);
  assert.equal(second.userText, 'second prompt');
  assert.equal(second.assistantText, 'working\n\nI failed');
  assert.deepEqual(second.assistantTexts, ['working', 'I failed']);
  assert.deepEqual(second.tools, [
    {
      name: 'grep',
      ok: false,
      argsPreview: '{"q":"x"}',
      resultPreview: 'boom',
      error: 'bad input',
    },
  ]);
  assert.equal(second.endReason, 'error');
  assert.equal(second.errorMessage, 'LLM exploded');
  assert.deepEqual(second.usage, {
    input: 17,
    output: 8,
    cacheRead: 1,
    cacheWrite: 0,
    total: 26,
  });
  assert.equal(second.startedAt, 2_000);
  assert.equal(second.endedAt, 2_100);
  assert.deepEqual(second.changes, {
    total: 1,
    added: 1,
    deleted: 1,
    files: [{ path: 'b.txt', display: 'b.txt', added: 1, deleted: 1, binary: false, oversized: false }],
  });

  assert.deepEqual(summaryCalls, [
    { sessionId: S1, seq: 7 },
    { sessionId: S1, seq: 15 },
  ]);
});

test('readRecentTurns defaults to the newest turn only', async () => {
  const { bridge } = twoTurnBridge();
  const view = await bridge.readRecentTurns(S1);
  assert.deepEqual(
    view.turns.map((turn) => turn.turn),
    [2],
  );
});

test('readRecentTurns marks an unterminated last turn as open', async () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }, 1_000),
    ev(
      2,
      'user/message',
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] },
      1_001,
    ),
    ev(
      3,
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'first answer' }] },
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      1_002,
    ),
    ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_003),
    // The prompt claim can be written just before its turn opens: the fold must
    // still attribute it to turn 2.
    ev(
      5,
      'user/message',
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] },
      1_090,
    ),
    ev(6, 'turn/start', { turn: 2 }, 1_100),
    ev(7, 'step/start', { turn: 2, step: 1 }, 1_101),
    ev(
      8,
      'assistant/message',
      {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: 'partial' }] },
      },
      1_102,
    ),
  ];
  const { controller } = createController({
    async inspect() {
      return makeInspection(events);
    },
  });
  const { ctx } = contextFor(controller);
  const bridge = createBridge(ctx);

  const latest = await bridge.readRecentTurns(S1);
  assert.deepEqual(
    latest.turns.map((turn) => turn.turn),
    [2],
  );
  assert.equal(latest.turns[0].endReason, 'open');
  assert.equal(latest.turns[0].userText, 'second');
  assert.equal(latest.turns[0].assistantText, 'partial');
  assert.equal(latest.turns[0].startedAt, 1_100);
  assert.equal(latest.turns[0].endedAt, null);
  assert.deepEqual(latest.turns[0].usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  assert.equal(latest.turns[0].changes, null);
  assert.equal(latest.title, null);
  assert.equal(latest.cwd, 'C:/work');

  const both = await bridge.readRecentTurns(S1, { turns: 2 });
  assert.deepEqual(
    both.turns.map((turn) => turn.turn),
    [1, 2],
  );
  assert.equal(both.turns[0].endReason, 'completed');
});

test('readRecentTurns attributes pre-turn user text when turn markers are absent', async () => {
  // Legacy logs without `turn/start` still expose turn numbers on assistant
  // events; the pending user text must attach to that first turn-scoped event.
  const events = [
    ev(
      1,
      'user/message',
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'legacy prompt' }] },
      1_000,
    ),
    ev(
      2,
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'legacy answer' }] },
      },
      1_001,
    ),
  ];
  const { controller } = createController({
    async inspect() {
      return makeInspection(events);
    },
  });
  const { ctx } = contextFor(controller);

  const view = await createBridge(ctx).readRecentTurns(S1);
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0].turn, 1);
  assert.equal(view.turns[0].userText, 'legacy prompt');
  assert.equal(view.turns[0].assistantText, 'legacy answer');
  assert.equal(view.turns[0].endReason, 'open');
});

test('readRecentTurns leaves changes null when the summary service fails', async () => {
  const workspaceChanges = {
    summary() {
      throw new Error('summary store unavailable');
    },
  };
  const { bridge, logger } = twoTurnBridge({ workspaceChanges });

  const view = await bridge.readRecentTurns(S1, { turns: 2 });
  assert.equal(view.turns[0].changes, null);
  assert.equal(view.turns[1].changes, null);
  assert.equal(logger.warnings.length, 2);
});

test('readRecentTurns isolates title read failures', async () => {
  const { controller } = createController({
    async inspect() {
      return makeInspection(twoTurnEvents());
    },
  });
  const { ctx, logger } = contextFor(controller, {
    sessionQuery: {
      async readTitleSnapshots() {
        throw new Error('title store offline');
      },
    },
  });

  const view = await createBridge(ctx).readRecentTurns(S1, { turns: 2 });
  assert.equal(view.title, null);
  assert.equal(view.turns.length, 2);
  assert.equal(logger.warnings.length, 1);
});

test('readRecentTurns translates Host session errors', async () => {
  const cause = Object.assign(new Error('Session not found'), { code: 'session/not-found' });
  const { controller } = createController({
    async inspect() {
      throw cause;
    },
  });
  const { ctx } = contextFor(controller);

  await assert.rejects(createBridge(ctx).readRecentTurns('missing-session'), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'session-not-found');
    assert.equal(error.cause, cause);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Session mutations
// ---------------------------------------------------------------------------

test('prompt sends the verified SessionPromptRequest payload', async () => {
  const { controller, calls } = createController();
  const { ctx } = contextFor(controller);

  const result = await createBridge(ctx).prompt(S1, 'hello world');
  assert.deepEqual(result, { accepted: true });
  assert.equal(calls.prompt.length, 1);

  const { request, signal } = calls.prompt[0];
  assert.match(
    request.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(request.sessionId, S1);
  assert.equal(request.mode, 'queue');
  assert.deepEqual(request.content, [{ type: 'text', text: 'hello world' }]);
  assert.equal(request.clientTimeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  // The live Host session controller calls signal.throwIfAborted(), so the
  // second argument must never be undefined even when the caller omits it.
  assert.ok(signal instanceof AbortSignal, 'prompt must forward a real AbortSignal');
});

test('prompt forwards a caller-supplied AbortSignal unchanged', async () => {
  const { controller, calls } = createController();
  const { ctx } = contextFor(controller);
  const callerSignal = new AbortController().signal;

  await createBridge(ctx).prompt(S1, 'with signal', { signal: callerSignal });
  assert.equal(calls.prompt[0].signal, callerSignal);
});

test('steer uses mode steer and invalid modes fall back to queue', async () => {
  const { controller, calls } = createController();
  const { ctx } = contextFor(controller);
  const bridge = createBridge(ctx);

  await bridge.steer(S1, 'go left');
  assert.equal(calls.prompt[0].request.mode, 'steer');

  await bridge.prompt(S1, 'go', { mode: 'steer' });
  assert.equal(calls.prompt[1].request.mode, 'steer');

  await bridge.prompt(S1, 'go', { mode: 'not-a-mode' });
  assert.equal(calls.prompt[2].request.mode, 'queue');
});

test('cancel, createSession and rename send the verified request payloads', async () => {
  const { controller, calls } = createController({
    async create() {
      return { sessionId: 'created-1' };
    },
    async rename() {
      return { title: 'Renamed', seq: 42 };
    },
  });
  const { ctx } = contextFor(controller);
  const bridge = createBridge(ctx);

  assert.deepEqual(await bridge.cancel(S1), { accepted: true });
  assert.deepEqual(calls.cancel[0].request, { sessionId: S1 });

  assert.deepEqual(await bridge.createSession(), { sessionId: 'created-1' });
  assert.deepEqual(calls.create[0].request, {});
  await bridge.createSession({ cwd: 'C:/work' });
  assert.deepEqual(calls.create[1].request, { cwd: 'C:/work' });
  await bridge.createSession({ cwd: undefined, workspaceId: 'workspace-1' });
  assert.deepEqual(calls.create[2].request, { workspaceId: 'workspace-1' });

  assert.deepEqual(await bridge.rename(S1, 'New title'), { title: 'Renamed', seq: 42 });
  assert.deepEqual(calls.rename[0].request, { sessionId: S1, title: 'New title' });
});

test('createSession rejects a create result without a session id', async () => {
  const { controller } = createController({
    async create() {
      return {};
    },
  });
  const { ctx } = contextFor(controller);

  await assert.rejects(createBridge(ctx).createSession(), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'unavailable');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

test('a busy writer becomes session-busy with the original cause preserved', async () => {
  const writerCause = Object.assign(new Error('Session writer held'), {
    code: 'session/writer-held',
  });
  const promptController = createController({
    async prompt() {
      throw writerCause;
    },
    async cancel() {
      throw new Error('Agent is busy');
    },
  });
  const { ctx } = contextFor(promptController.controller);
  const bridge = createBridge(ctx);

  await assert.rejects(bridge.prompt(S1, 'hi'), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'session-busy');
    assert.equal(error.cause, writerCause);
    return true;
  });
  await assert.rejects(bridge.cancel(S1), (error) => {
    assert.equal(error.code, 'session-busy');
    return true;
  });
});

test('unexpected service failures become unavailable with cause preserved', async () => {
  const cause = new Error('kaboom');
  const { controller } = createController({
    async create() {
      throw cause;
    },
  });
  const { ctx } = contextFor(controller);

  await assert.rejects(createBridge(ctx).createSession(), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'unavailable');
    assert.equal(error.message, 'kaboom');
    assert.equal(error.cause, cause);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Optional Host capabilities
// ---------------------------------------------------------------------------

test('hasLiveClient and advertisedUrl tolerate missing or broken services', () => {
  const bare = createBridge(createContext().ctx);
  assert.equal(bare.hasLiveClient(), false);
  assert.equal(bare.advertisedUrl(), undefined);

  const throwing = createBridge({
    get() {
      throw new Error('service registry unavailable');
    },
  });
  assert.equal(throwing.hasLiveClient(), false);
  assert.equal(throwing.advertisedUrl(), undefined);

  const { ctx } = createContext({
    typertGateway: {
      hasLiveClient() {
        return true;
      },
    },
    webApp: {
      getAdvertisedUrl() {
        return 'http://127.0.0.1:65361';
      },
    },
  });
  const bridge = createBridge(ctx);
  assert.equal(bridge.hasLiveClient(), true);
  assert.equal(bridge.advertisedUrl(), 'http://127.0.0.1:65361');

  const broken = createBridge({
    get(name) {
      if (name === 'typertGateway') {
        return {
          hasLiveClient() {
            throw new Error('gateway exploded');
          },
        };
      }
      if (name === 'webApp') {
        return {
          getAdvertisedUrl() {
            throw new Error('web app exploded');
          },
        };
      }
      return null;
    },
  });
  assert.equal(broken.hasLiveClient(), false);
  assert.equal(broken.advertisedUrl(), undefined);
});

// ---------------------------------------------------------------------------
// findSession
// ---------------------------------------------------------------------------

test('findSession resolves index, exact id, prefix and title queries', () => {
  const sessions = [
    { id: 'aa11', title: 'Alpha Project' },
    { id: 'aa22', title: 'Beta' },
    { id: 'bb33', title: 'alpha two' },
  ];
  const bridge = createBridge(createContext().ctx);

  assert.equal(bridge.findSession(sessions, '2').match, sessions[1]);
  assert.equal(bridge.findSession(sessions, ' aa22 ').match, sessions[1]);
  assert.equal(bridge.findSession(sessions, 'aa1').match, sessions[0]);
  assert.equal(bridge.findSession(sessions, 'BB').match, sessions[2]);
  assert.equal(bridge.findSession(sessions, 'beta').match, sessions[1]);
  assert.equal(bridge.findSession(sessions, 'Beta').match, sessions[1]);
  assert.deepEqual(bridge.findSession(sessions, 'aa').candidates, [
    sessions[0],
    sessions[1],
  ]);
  assert.deepEqual(bridge.findSession(sessions, 'alpha').candidates, [
    sessions[0],
    sessions[2],
  ]);
  assert.deepEqual(bridge.findSession(sessions, 'nope'), { error: 'not-found' });
  assert.deepEqual(bridge.findSession(sessions, '9'), { error: 'not-found' });
  assert.deepEqual(bridge.findSession(sessions, ''), { error: 'not-found' });
  assert.deepEqual(bridge.findSession(sessions, '   '), { error: 'not-found' });
  assert.deepEqual(bridge.findSession([], '1'), { error: 'not-found' });
});

// ---------------------------------------------------------------------------
// Missing sessionController
// ---------------------------------------------------------------------------

test('session operations require the sessionController service', async () => {
  const bridge = createBridge(createContext().ctx);
  const expectedMessage = 'Session controller is not available in this profile';

  const operations = [
    () => bridge.listSessions(),
    () => bridge.getStatus(S1),
    () => bridge.readRecentTurns(S1),
    () => bridge.prompt(S1, 'hi'),
    () => bridge.steer(S1, 'hi'),
    () => bridge.cancel(S1),
    () => bridge.createSession(),
    () => bridge.rename(S1, 'title'),
  ];

  for (const operation of operations) {
    await assert.rejects(operation(), (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'unavailable');
      assert.equal(error.message, expectedMessage);
      return true;
    });
  }
});
