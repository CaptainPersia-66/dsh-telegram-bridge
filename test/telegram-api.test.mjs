import test from 'node:test';
import assert from 'node:assert/strict';

import { TelegramApi, TelegramApiError } from '../lib/telegram-api.js';
import { startFakeTelegram } from './fake-telegram.mjs';

/**
 * Run a test body against a fresh fake Bot API server, always closing it.
 *
 * @template T
 * @param {{token?: string, longPollDelayMs?: number}} options
 * @param {(fake: Awaited<ReturnType<typeof startFakeTelegram>>) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withFake(options, body) {
  const fake = await startFakeTelegram(options);
  try {
    return await body(fake);
  } finally {
    await fake.close();
  }
}

/**
 * @param {Awaited<ReturnType<typeof startFakeTelegram>>} fake
 * @param {Record<string, unknown>} [overrides]
 * @returns {TelegramApi}
 */
function makeApi(fake, overrides = {}) {
  return new TelegramApi({
    token: fake.token,
    baseUrl: fake.baseUrl,
    minSendIntervalMs: 0,
    ...overrides,
  });
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- construction

test('constructor rejects missing or blank tokens', () => {
  assert.throws(() => new TelegramApi({}), /token/i);
  assert.throws(() => new TelegramApi({ token: '   ' }), /token/i);
});

test('call rejects invalid method names', async () => {
  const fake = { token: '1:abc' };
  const api = new TelegramApi({ token: fake.token, baseUrl: 'http://127.0.0.1:1', fetchImpl: async () => null });
  await assert.rejects(api.call('bad method'), TypeError);
  await assert.rejects(api.call(''), TypeError);
});

// ------------------------------------------------------------- URL & envelope

test('getMe posts to <baseUrl>/bot<token>/getMe and returns the result', async () => {
  await withFake({}, async (fake) => {
    /** @type {string|null} */
    let requestedUrl = null;
    const api = new TelegramApi({
      token: fake.token,
      baseUrl: `${fake.baseUrl}/`, // trailing slash must be normalized away
      minSendIntervalMs: 0,
      fetchImpl: (url, init) => {
        requestedUrl = String(url);
        return fetch(url, init);
      },
    });
    const me = await api.getMe();
    assert.equal(me.is_bot, true);
    assert.equal(requestedUrl, `${fake.baseUrl}/bot${fake.token}/getMe`);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].params, {});
  });
});

test('Bot API errors are wrapped in TelegramApiError with fields and no retry', async () => {
  await withFake({}, async (fake) => {
    fake.setBehavior('getMe', () => ({
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    }));
    const api = makeApi(fake);
    await assert.rejects(api.getMe(), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'TelegramApiError');
      assert.equal(error.code, 400);
      assert.equal(error.method, 'getMe');
      assert.equal(error.isParseError, false);
      assert.equal(error.retryAfterSeconds, undefined);
      assert.match(error.description, /chat not found/);
      assert.match(error.message, /400/);
      return true;
    });
    assert.equal(fake.calls.filter((call) => call.method === 'getMe').length, 1);
  });
});

test('unknown Bot API methods answer 404 without retrying', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    await assert.rejects(api.call('noSuchMethod'), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, 404);
      assert.match(error.description, /not found/i);
      return true;
    });
    assert.equal(fake.calls.length, 1);
  });
});

test('a token mismatch is a 401 and the error never contains a token', async () => {
  await withFake({}, async (fake) => {
    const foreignToken = '999999:OTHER-TOKEN-abcdefghijklmnopqrstuvwxyz';
    const api = new TelegramApi({
      token: foreignToken,
      baseUrl: fake.baseUrl,
      minSendIntervalMs: 0,
      maxRetries: 0,
    });
    await assert.rejects(api.getMe(), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, 401);
      assert.ok(!error.message.includes(foreignToken), 'message leaked the token');
      assert.ok(!error.message.includes(fake.token), 'message leaked the fake token');
      assert.ok(!String(error).includes(foreignToken), 'String(error) leaked the token');
      return true;
    });
    assert.equal(fake.calls.length, 0, 'token is validated before dispatch is recorded');
  });
});

// --------------------------------------------------------------------- retries

test('429 responses are retried after honoring retry_after', async () => {
  await withFake({}, async (fake) => {
    let attempts = 0;
    fake.setBehavior('getMe', () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 429,
          body: {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 0.2',
            parameters: { retry_after: 0.2 },
          },
        };
      }
      return { status: 200, body: { ok: true, result: { id: 7, is_bot: true, first_name: 'x', username: 'x' } } };
    });
    const api = makeApi(fake, { maxRetries: 2 });
    const startedAt = Date.now();
    const me = await api.getMe();
    const elapsed = Date.now() - startedAt;
    assert.equal(me.id, 7);
    assert.equal(attempts, 2);
    assert.ok(elapsed >= 150, `expected the retry_after delay to be honored, elapsed ${elapsed}ms`);
    assert.ok(elapsed < 4000, `429 retry took unexpectedly long: ${elapsed}ms`);
  });
});

test('5xx responses use backoff and are retried until success', async () => {
  await withFake({}, async (fake) => {
    let attempts = 0;
    fake.setBehavior('getMe', () => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } };
      }
      return { status: 200, body: { ok: true, result: { id: 8, is_bot: true, first_name: 'x', username: 'x' } } };
    });
    const api = makeApi(fake, { maxRetries: 2 });
    const startedAt = Date.now();
    const me = await api.getMe();
    assert.equal(me.id, 8);
    assert.equal(attempts, 2);
    assert.ok(Date.now() - startedAt >= 80, 'expected exponential backoff before the retry');
  });
});

test('exhausted 429 retries report code and retryAfterSeconds', async () => {
  await withFake({}, async (fake) => {
    fake.setBehavior('getMe', () => ({
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry later',
        parameters: { retry_after: 0.05 },
      },
    }));
    const api = makeApi(fake, { maxRetries: 1 });
    const startedAt = Date.now();
    await assert.rejects(api.getMe(), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, 429);
      assert.equal(error.retryAfterSeconds, 0.05);
      assert.equal(error.isParseError, false);
      return true;
    });
    assert.equal(fake.calls.length, 2);
    assert.ok(Date.now() - startedAt >= 40, 'retry_after was not honored');
  });
});

test('persistent 5xx failures exhaust retries and throw the API error', async () => {
  await withFake({}, async (fake) => {
    fake.setBehavior('getMe', () => ({
      status: 503,
      body: { ok: false, error_code: 503, description: 'Service Unavailable' },
    }));
    const api = makeApi(fake, { maxRetries: 1 });
    await assert.rejects(api.getMe(), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, 503);
      return true;
    });
    assert.equal(fake.calls.length, 2);
  });
});

test('network errors become TelegramApiError code null with the token redacted', async () => {
  await withFake({}, async (fake) => {
    const api = new TelegramApi({
      token: fake.token,
      baseUrl: 'http://127.0.0.1:1',
      minSendIntervalMs: 0,
      maxRetries: 0,
      fetchImpl: async (url) => {
        throw new Error(`connect ECONNREFUSED while requesting ${url}`);
      },
    });
    await assert.rejects(api.getMe(), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, null);
      assert.equal(error.method, 'getMe');
      assert.ok(!error.message.includes(fake.token), 'message leaked the token');
      assert.ok(!String(error).includes(fake.token), 'String(error) leaked the token');
      assert.ok(!error.cause.message.includes(fake.token), 'cause leaked the token');
      return true;
    });
  });
});

test('timeouts are retried and finally surface as code null', async () => {
  await withFake({}, async (fake) => {
    const api = new TelegramApi({
      token: fake.token,
      baseUrl: 'http://127.0.0.1:1',
      minSendIntervalMs: 0,
      maxRetries: 0,
      fetchImpl: async () => {
        const error = new Error('request timed out');
        error.name = 'TimeoutError';
        throw error;
      },
    });
    await assert.rejects(api.getMe(), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, null);
      assert.match(error.message, /timed out/i);
      return true;
    });
  });
});

// ---------------------------------------------------------------------- aborts

test('aborting a long poll rejects with AbortError and leaves the server clean', async () => {
  await withFake({ longPollDelayMs: 2000 }, async (fake) => {
    const api = makeApi(fake);
    const controller = new AbortController();
    const pending = api.getUpdates({ timeoutSeconds: 5, signal: controller.signal });
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    });
    assert.ok(Date.now() - startedAt < 1000, 'abort should be immediate');
    assert.equal(fake.lastCall('getUpdates') !== undefined, true);
  });
});

test('aborting during a retry backoff propagates AbortError', async () => {
  await withFake({}, async (fake) => {
    fake.setBehavior('getMe', () => ({
      status: 502,
      body: { ok: false, error_code: 502, description: 'Bad Gateway' },
    }));
    const api = makeApi(fake, { maxRetries: 3 });
    const controller = new AbortController();
    const pending = api.getMe({ signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const startedAt = Date.now();
    await assert.rejects(pending, (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    });
    assert.ok(Date.now() - startedAt < 1000, 'abort must interrupt the backoff sleep');
    assert.equal(fake.calls.length, 1);
  });
});

test('the plugin lifetime signal aborts new calls', async () => {
  await withFake({}, async (fake) => {
    const controller = new AbortController();
    const api = makeApi(fake, { signal: controller.signal });
    controller.abort();
    await assert.rejects(api.getMe(), (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    });
    assert.equal(fake.calls.length, 0);
  });
});

// ------------------------------------------------------------------- getUpdates

test('getUpdates sends Bot API long-poll parameters and returns updates', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    fake.pushUpdate({ update_id: 3, message: { message_id: 1, text: 'hi' } });
    const updates = await api.getUpdates({ offset: 2, timeoutSeconds: 1, limit: 5 });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update_id, 3);
    assert.deepEqual(fake.lastCall('getUpdates').params, {
      offset: 2,
      timeout: 1,
      limit: 5,
      allowed_updates: ['message', 'callback_query'],
    });

    const defaults = await api.getUpdates();
    assert.ok(Array.isArray(defaults));
    assert.deepEqual(fake.lastCall('getUpdates').params, {
      offset: 0,
      timeout: 25,
      limit: 100,
      allowed_updates: ['message', 'callback_query'],
    });
  });
});

test('a pushed update wakes a pending long poll', async () => {
  await withFake({ longPollDelayMs: 5000 }, async (fake) => {
    const api = makeApi(fake);
    const pending = api.getUpdates({ timeoutSeconds: 5 });
    setTimeout(() => fake.pushUpdate({ update_id: 1, message: { message_id: 1 } }), 30);
    const startedAt = Date.now();
    const updates = await pending;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update_id, 1);
    assert.ok(Date.now() - startedAt < 2000, 'long poll should wake on push, not wait for the server delay');
  });
});

test('getUpdates returns an empty array for a non-array result', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    fake.setBehavior('getUpdates', () => ({ status: 200, body: { ok: true, result: {} } }));
    assert.deepEqual(await api.getUpdates(), []);
  });
});

// ------------------------------------------------------------------ sendMessage

test('sendMessage splits text, keeps the keyboard on the first chunk only', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    const text = 'a'.repeat(4000);
    const keyboard = { inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] };
    const sent = await api.sendMessage({ chatId: 42, text, keyboard, replyToMessageId: 7 });

    assert.equal(sent.length, 2);
    assert.equal(fake.messages.length, 2);
    assert.deepEqual(fake.messages.map((message) => message.text), [text.slice(0, 3900), text.slice(3900)]);
    assert.equal(fake.messages.map((message) => message.text).join(''), text);
    assert.equal(fake.messages[0].chatId, 42);
    assert.equal(fake.messages[0].parseMode, 'HTML');
    assert.deepEqual(fake.messages[0].keyboard, keyboard);
    assert.equal(fake.messages[1].keyboard, null);
    assert.equal(sent[0].message_id, fake.messages[0].messageId);
    assert.equal(sent[1].message_id, fake.messages[1].messageId);

    const sendCalls = fake.calls.filter((call) => call.method === 'sendMessage');
    assert.equal(sendCalls[0].params.reply_to_message_id, 7);
    assert.equal(sendCalls[0].params.disable_web_page_preview, true);
    assert.equal(sendCalls[1].params.reply_to_message_id, undefined);
    assert.equal(sendCalls[1].params.reply_markup, undefined);
  });
});

test('sendMessage returns [] for empty text without calling the API', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    assert.deepEqual(await api.sendMessage({ chatId: 1, text: '' }), []);
    assert.equal(fake.calls.length, 0);
  });
});

test('sendMessage omits parse mode and link preview when disabled', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    await api.sendMessage({ chatId: 1, text: 'hi', parseMode: null, disableWebPagePreview: false });
    const params = fake.lastCall('sendMessage').params;
    assert.equal(params.parse_mode, undefined);
    assert.equal(params.disable_web_page_preview, undefined);
    assert.equal(params.text, 'hi');
  });
});

test('sendMessage falls back to plain text when Telegram cannot parse entities', async () => {
  await withFake({}, async (fake) => {
    let sends = 0;
    fake.setBehavior('sendMessage', (params) => {
      sends += 1;
      if (params.parse_mode) {
        return {
          status: 400,
          body: {
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities: Unsupported start tag",
          },
        };
      }
      return { status: 200, body: { ok: true, result: { message_id: 900, date: 1, chat: { id: 1 } } } };
    });
    const api = makeApi(fake);
    const keyboard = { inline_keyboard: [[{ text: 'x', callback_data: 'x' }]] };
    const sent = await api.sendMessage({ chatId: 1, text: '<b>broken', keyboard });
    assert.equal(sent.length, 1);
    assert.equal(sends, 2);

    const sendCalls = fake.calls.filter((call) => call.method === 'sendMessage');
    assert.equal(sendCalls.length, 2);
    assert.equal(sendCalls[0].params.parse_mode, 'HTML');
    assert.equal(sendCalls[1].params.parse_mode, undefined);
    assert.equal(sendCalls[1].params.reply_markup, undefined);
    assert.equal(sendCalls[1].params.text, '<b>broken');
  });
});

test('sendMessage throws when the parse-entities fallback also fails', async () => {
  await withFake({}, async (fake) => {
    fake.setBehavior('sendMessage', () => ({
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: nope" },
    }));
    const api = makeApi(fake);
    await assert.rejects(api.sendMessage({ chatId: 1, text: 'x' }), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.isParseError, true);
      assert.equal(error.code, 400);
      return true;
    });
    assert.equal(fake.calls.filter((call) => call.method === 'sendMessage').length, 2);
  });
});

test('a failed middle chunk throws but earlier chunks were already sent', async () => {
  await withFake({}, async (fake) => {
    let sends = 0;
    fake.setBehavior('sendMessage', () => {
      sends += 1;
      if (sends === 2) {
        return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message is too long' } };
      }
      return undefined; // fall through to the default success handler
    });
    const api = makeApi(fake);
    await assert.rejects(api.sendMessage({ chatId: 1, text: 'a'.repeat(4000) }), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, 400);
      return true;
    });
    assert.equal(fake.messages.length, 1);
    assert.equal(fake.messages[0].text.length, 3900);
  });
});

// --------------------------------------------------------------- chat rate limit

test('sendMessage serializes sends to the same chat with a minimum gap', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake, { minSendIntervalMs: 80 });
    await Promise.all([
      api.sendMessage({ chatId: 5, text: 'one' }),
      api.sendMessage({ chatId: 5, text: 'two' }),
    ]);
    const sendCalls = fake.calls.filter((call) => call.method === 'sendMessage');
    assert.equal(sendCalls.length, 2);
    assert.deepEqual(fake.messages.map((message) => message.text), ['one', 'two']);
    const gap = sendCalls[1].at - sendCalls[0].at;
    assert.ok(gap >= 60, `expected a per-chat gap near 80ms, got ${gap}ms`);
  });
});

test('aborting a queued send releases the per-chat queue', async () => {
  await withFake({}, async (fake) => {
    const slowFetch = async (url, init) => {
      await delay(100);
      return fetch(url, init);
    };
    const api = new TelegramApi({
      token: fake.token,
      baseUrl: fake.baseUrl,
      minSendIntervalMs: 0,
      fetchImpl: slowFetch,
    });
    const first = api.sendMessage({ chatId: 8, text: 'first' });
    await fake.waitForCall('sendMessage');

    const controller = new AbortController();
    const queued = api.sendMessage({ chatId: 8, text: 'queued' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const startedAt = Date.now();
    await assert.rejects(queued, (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    });
    assert.ok(Date.now() - startedAt < 1000);

    assert.equal((await first).length, 1);
    // The queue must not be deadlocked by the aborted waiter.
    assert.equal((await api.sendMessage({ chatId: 8, text: 'third' })).length, 1);
    assert.equal(fake.lastCall('sendMessage').params.text, 'third');
  });
});

test('aborting a call that waits for a global slot releases the slot', async () => {
  await withFake({}, async (fake) => {
    fake.setBehavior('getMe', async () => {
      await delay(80);
      return { status: 200, body: { ok: true, result: { id: 1, is_bot: true, first_name: 'x', username: 'x' } } };
    });
    const api = makeApi(fake, { maxConcurrentCalls: 1 });
    const first = api.getMe();
    const controller = new AbortController();
    const queued = api.getMe({ signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    await assert.rejects(queued, (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    });
    assert.equal((await first).id, 1);
    // The single slot must be usable again after the queued abort.
    assert.equal((await api.getMe()).id, 1);
  });
});

test('global concurrency cap bounds simultaneous requests', async () => {
  await withFake({}, async (fake) => {
    fake.setBehavior('getMe', async () => {
      await delay(40);
      return { status: 200, body: { ok: true, result: { id: 1, is_bot: true, first_name: 'x', username: 'x' } } };
    });
    let active = 0;
    let maxActive = 0;
    const wrappedFetch = async (url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await fetch(url, init);
      } finally {
        active -= 1;
      }
    };
    const api = new TelegramApi({
      token: fake.token,
      baseUrl: fake.baseUrl,
      minSendIntervalMs: 0,
      maxConcurrentCalls: 2,
      fetchImpl: wrappedFetch,
    });
    const results = await Promise.all([api.getMe(), api.getMe(), api.getMe(), api.getMe()]);
    assert.equal(results.length, 4);
    assert.ok(maxActive <= 2, `concurrency cap violated: ${maxActive}`);
    assert.ok(maxActive >= 1);
  });
});

// ------------------------------------------------------------------- edits misc

test('editMessageText sends the expected params and tolerates "not modified"', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    const keyboard = { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] };
    assert.equal(await api.editMessageText({ chatId: 1, messageId: 5, text: 'hello', keyboard }), true);
    assert.deepEqual(fake.lastCall('editMessageText').params, {
      chat_id: 1,
      message_id: 5,
      text: 'hello',
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    fake.setBehavior('editMessageText', () => ({
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
    }));
    assert.equal(await api.editMessageText({ chatId: 1, messageId: 5, text: 'hello' }), true);
  });
});

test('editMessageText falls back to plain text on parse errors', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    fake.setBehavior('editMessageText', (params) => {
      if (params.parse_mode) {
        return { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } };
      }
      return { status: 200, body: { ok: true, result: true } };
    });
    assert.equal(await api.editMessageText({ chatId: 1, messageId: 6, text: '<b>x' }), true);
    const calls = fake.calls.filter((call) => call.method === 'editMessageText');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.parse_mode, undefined);
  });
});

test('editMessageReplyMarkup passes keyboards and clears with null', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    const keyboard = { inline_keyboard: [[{ text: 'B', callback_data: 'b' }]] };
    assert.equal(await api.editMessageReplyMarkup({ chatId: 1, messageId: 2, keyboard }), true);
    assert.deepEqual(fake.lastCall('editMessageReplyMarkup').params, {
      chat_id: 1,
      message_id: 2,
      reply_markup: keyboard,
    });
    assert.equal(await api.editMessageReplyMarkup({ chatId: 1, messageId: 2 }), true);
    assert.deepEqual(fake.lastCall('editMessageReplyMarkup').params.reply_markup, { inline_keyboard: [] });
  });
});

test('answerCallbackQuery sends only the provided optional fields', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    assert.equal(await api.answerCallbackQuery({ callbackQueryId: 'cb1', text: 'Done', showAlert: true }), true);
    assert.deepEqual(fake.lastCall('answerCallbackQuery').params, {
      callback_query_id: 'cb1',
      text: 'Done',
      show_alert: true,
    });
    assert.equal(await api.answerCallbackQuery({ callbackQueryId: 'cb2' }), true);
    assert.deepEqual(fake.lastCall('answerCallbackQuery').params, { callback_query_id: 'cb2' });
  });
});

test('deleteMessage sends the expected params and returns true', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    assert.equal(await api.deleteMessage({ chatId: 1, messageId: 9 }), true);
    assert.deepEqual(fake.lastCall('deleteMessage').params, { chat_id: 1, message_id: 9 });
  });
});

test('message methods validate their identifiers', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    await assert.rejects(api.sendMessage({ text: 'x' }), /chatId/);
    await assert.rejects(api.editMessageText({ chatId: 1, text: 'x' }), /messageId/);
    await assert.rejects(api.deleteMessage({ messageId: 1 }), /chatId/);
    await assert.rejects(api.answerCallbackQuery({}), /callbackQueryId/);
  });
});

test('sendReports records one result array per sendMessage call', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    await api.sendMessage({ chatId: 3, text: 'hi' });
    assert.equal(fake.sendReports.length, 1);
    assert.equal(fake.sendReports[0][0].message_id, fake.messages[0].messageId);
  });
});

test('getFile resolves a download path and downloadFile returns the bytes', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    fake.setFile('voice/test.ogg', new Uint8Array([1, 2, 3, 4]));
    const file = await api.getFile('file-1');
    assert.equal(file.file_path, 'voice/test.ogg');
    assert.equal(file.file_size, 4);
    assert.equal(fake.calls.filter((call) => call.method === 'getFile').length, 1);
    const bytes = await api.downloadFile(file.file_path, { maxBytes: 1024 });
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
    assert.equal(fake.fileDownloads.length, 1);
    assert.equal(fake.fileDownloads[0].path, 'voice/test.ogg');
  });
});

test('downloadFile enforces maxBytes and reports missing files', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    fake.setFile('voice/test.ogg', new Uint8Array(32));
    await assert.rejects(api.downloadFile('voice/test.ogg', { maxBytes: 8 }), /too large/);
    await assert.rejects(api.downloadFile('voice/missing.ogg'), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, 404);
      return true;
    });
    await assert.rejects(api.getFile(''), /file id/);
  });
});

test('sendFile uploads multipart media and records the Bot API method', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    const result = await api.sendFile({
      chatId: 77,
      method: 'sendVideo',
      field: 'video',
      filename: 'clip.mp4',
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'video/mp4',
      caption: 'clip.mp4 · 4 B',
    });
    assert.equal(typeof result.message_id, 'number');
    const call = fake.calls.find((entry) => entry.method === 'sendVideo');
    assert.ok(call, 'fake must record the media call');
    assert.equal(call.params.multipart, true);
    await assert.rejects(
      api.sendFile({ chatId: 77, method: 'sendVideo', field: 'video', filename: 'x', bytes: new Uint8Array() }),
      /file bytes/,
    );
    await assert.rejects(api.sendFile({ bytes: new Uint8Array([1]) }), /chatId/);
  });
});

test('editForumTopic treats TOPIC_NOT_MODIFIED as a successful no-op', async () => {
  await withFake({}, async (fake) => {
    const api = makeApi(fake);
    fake.setBehavior('editForumTopic', () => ({
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: TOPIC_NOT_MODIFIED' },
    }));
    const result = await api.editForumTopic({ chatId: 5, messageThreadId: 9, name: 'Same name' });
    assert.equal(result, true);

    fake.setBehavior('editForumTopic', () => ({
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: TOPIC_NAME_EMPTY' },
    }));
    await assert.rejects(
      api.editForumTopic({ chatId: 5, messageThreadId: 9, name: 'x' }),
      (error) => {
        assert.ok(error instanceof TelegramApiError);
        assert.match(error.description, /TOPIC_NAME_EMPTY/);
        return true;
      },
    );
  });
});
