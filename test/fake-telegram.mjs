/**
 * In-process fake Telegram Bot API server for tests.
 *
 * Binds `127.0.0.1:0` and implements the small subset of the Bot API that the
 * bridge uses (SPEC.md section 5). Other workstreams import `startFakeTelegram`
 * from their tests, so the returned shape is part of the package contract.
 *
 * @module telegram-bridge/test/fake-telegram
 */

import http from 'node:http';

const DEFAULT_TOKEN = '123456:TEST-TOKEN-abcdefghijklmnopqrstuvwxyz';
/** Bounded but large enough for the small media uploads tests forward. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {object} FakeCall
 * @property {string} method Bot API method name
 * @property {Record<string, unknown>} params decoded JSON body
 * @property {number} at epoch milliseconds
 */

/**
 * @typedef {object} FakeMessage
 * @property {string|number} chatId chat id from `chat_id`
 * @property {string} text sent text
 * @property {string|null} parseMode `parse_mode` or `null`
 * @property {unknown} keyboard `reply_markup` or `null`
 * @property {number} messageId generated message id
 * @property {number} at epoch milliseconds
 */

/**
 * @typedef {object} FakeBehaviorOverride
 * @property {number} [status=200] HTTP status to answer with
 * @property {unknown} [body] JSON body to answer with
 */

/**
 * Start a fake Bot API server.
 *
 * `setBehavior(method, fn)` lets a test intercept a method. Returning an
 * override `{ status, body }` replaces the default response; returning
 * `undefined` falls through to the default handler. Returning `{ chatId }`
 * style objects is not supported; only `status`/`body` are read.
 *
 * @param {{token?: string, longPollDelayMs?: number}} [options] server options
 * @returns {Promise<{
 *   baseUrl: string,
 *   token: string,
 *   calls: FakeCall[],
 *   messages: FakeMessage[],
 *   sendReports: unknown[][],
 *   updates: object[],
 *   pushUpdate: (update: object) => void,
 *   queueUpdates: (list: object[]) => void,
 *   waitForCall: (method: string, predicate?: (call: FakeCall) => boolean, timeoutMs?: number) => Promise<FakeCall>,
 *   waitForMessage: (predicate?: (message: FakeMessage) => boolean, timeoutMs?: number) => Promise<FakeMessage>,
 *   lastCall: (method: string) => FakeCall | undefined,
 *   setBehavior: (method: string, fn: ((params: Record<string, unknown>, call: FakeCall) => FakeBehaviorOverride | undefined | Promise<FakeBehaviorOverride | undefined>) | null) => void,
 *   close: () => Promise<void>,
 * }>} handle to the running fake
 */
export async function startFakeTelegram(options = {}) {
  const token =
    typeof options.token === 'string' && options.token.trim() !== '' ? options.token.trim() : DEFAULT_TOKEN;
  const longPollDelayMs = Number.isFinite(Number(options.longPollDelayMs))
    ? Math.max(0, Math.floor(Number(options.longPollDelayMs)))
    : 10;

  /** @type {FakeCall[]} */
  const calls = [];
  /** @type {FakeMessage[]} */
  const messages = [];
  /** One entry per HTTP `sendMessage`: the message objects that call produced. */
  const sendReports = [];
  /** @type {object[]} */
  const updates = [];
  /** @type {Map<string, Function>} */
  const behaviors = new Map();
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** @type {Array<{ path: string, at: number }>} */
  const fileDownloads = [];
  /** @type {Set<object>} */
  const callWaiters = new Set();
  /** @type {Set<object>} */
  const messageWaiters = new Set();
  /** @type {Set<object>} */
  const updateWaiters = new Set();
  let nextMessageId = 100;
  let closed = false;
  let closePromise = null;

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   */
  function respond(res, status, body) {
    if (res.writableEnded || res.destroyed) return;
    const text = JSON.stringify(body ?? { ok: true, result: true });
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  /**
   * Resolve every waiter in a set whose matcher accepts the value.
   *
   * @param {Set<object>} waiters
   * @param {unknown} value
   */
  function notify(waiters, value) {
    for (const waiter of [...waiters]) {
      let matches = false;
      try {
        matches = Boolean(waiter.match(value));
      } catch {
        matches = false; // a throwing test predicate must not kill the server
      }
      if (matches) waiter.finish(value);
    }
  }

  /**
   * @param {Set<object>} waiters
   * @param {(value: any) => boolean} match
   * @param {number} timeoutMs
   * @param {string} label
   */
  function createWaiter(waiters, match, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const waiter = { match, finish: null, fail: null };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      waiter.finish = (value) => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(value);
      };
      waiter.fail = (error) => {
        clearTimeout(timer);
        waiters.delete(waiter);
        reject(error);
      };
      waiters.add(waiter);
    });
  }

  /**
   * Long-poll wait: resolve on the next pushed update, a timer, or request close.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {number} delayMs
   */
  function waitForUpdatePush(res, delayMs) {
    return new Promise((resolve) => {
      const waiter = { match: () => true, finish: null };
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        updateWaiters.delete(waiter);
        res.off('close', onClose);
        resolve();
      };
      const onClose = () => finish();
      waiter.finish = finish;
      const timer = setTimeout(finish, delayMs);
      updateWaiters.add(waiter);
      res.on('close', onClose);
    });
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {Record<string, unknown>} params
   */
  async function handleGetUpdates(res, params) {
    const offset = Number.isFinite(Number(params.offset)) ? Number(params.offset) : 0;
    const limit =
      Number.isFinite(Number(params.limit)) && Number(params.limit) > 0 ? Math.floor(Number(params.limit)) : 100;
    const timeoutSeconds = Number.isFinite(Number(params.timeout)) ? Math.max(0, Number(params.timeout)) : 0;
    const collect = () =>
      updates
        .filter((update) => {
          const updateId = Number(update?.update_id);
          return Number.isFinite(updateId) ? updateId >= offset : true;
        })
        .slice(0, limit);
    let result = collect();
    if (result.length === 0 && timeoutSeconds > 0 && longPollDelayMs > 0) {
      await waitForUpdatePush(res, Math.min(longPollDelayMs, timeoutSeconds * 1000));
      result = collect();
    }
    respond(res, 200, { ok: true, result });
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {Record<string, unknown>} params
   */
  function handleSendMessage(res, params) {
    const messageId = nextMessageId;
    nextMessageId += 1;
    const at = Date.now();
    const message = {
      message_id: messageId,
      date: Math.floor(at / 1000),
      chat: { id: params.chat_id, type: 'private' },
      text: params.text,
    };
    if (params.message_thread_id !== undefined) message.message_thread_id = params.message_thread_id;
    const record = {
      chatId: params.chat_id,
      text: typeof params.text === 'string' ? params.text : String(params.text ?? ''),
      parseMode: typeof params.parse_mode === 'string' ? params.parse_mode : null,
      keyboard: params.reply_markup ?? null,
      threadId: params.message_thread_id ?? null,
      messageId,
      at,
    };
    messages.push(record);
    sendReports.push([message]);
    respond(res, 200, { ok: true, result: message });
    notify(messageWaiters, record);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} raw
   */
  async function dispatch(req, res, raw) {
    const rawUrl = req.url ?? '';
    const queryIndex = rawUrl.indexOf('?');
    const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    // Bot API file downloads are a plain GET under /file/bot<token>/<path>.
    const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(pathname);
    if (fileMatch) {
      const [, fileToken, encodedPath] = fileMatch;
      if (fileToken !== token) {
        respond(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }
      let filePath = encodedPath;
      try {
        filePath = decodeURIComponent(encodedPath);
      } catch {
        filePath = encodedPath;
      }
      fileDownloads.push({ path: filePath, at: Date.now() });
      const bytes = files.get(filePath);
      if (!bytes) {
        respond(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
        return;
      }
      const buffer = Buffer.from(bytes);
      res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Content-Length': buffer.length });
      res.end(buffer);
      return;
    }
    const match = /^\/bot([^/]+)\/([A-Za-z0-9_]+)$/.exec(pathname);
    if (!match) {
      respond(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
      return;
    }
    const [, requestToken, method] = match;
    if (requestToken !== token) {
      respond(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      return;
    }
    /** @type {Record<string, unknown>} */
    let params = {};
    // Media uploads are multipart/form-data; the fake records the call and does
    // not decode the body (tests assert the method, not the wire fields).
    const contentType = String(req.headers?.['content-type'] ?? '');
    if (/multipart\/form-data/i.test(contentType)) {
      params = { multipart: true, bytes: raw.length };
    } else if (raw.trim() !== '') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed;
      } catch {
        respond(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid JSON' });
        return;
      }
    }
    /** @type {FakeCall} */
    const call = { method, params, at: Date.now() };
    calls.push(call);
    notify(callWaiters, call);

    const behavior = behaviors.get(method);
    if (typeof behavior === 'function') {
      let override;
      try {
        override = await behavior(params, call);
      } catch (error) {
        respond(res, 500, {
          ok: false,
          error_code: 500,
          description: `fake behavior failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (override !== undefined && override !== null) {
        respond(res, override.status ?? 200, override.body ?? { ok: true, result: true });
        return;
      }
    }

    switch (method) {
      case 'getMe':
        respond(res, 200, {
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'Fake', username: 'fake_bot' },
        });
        return;
      case 'getUpdates':
        await handleGetUpdates(res, params);
        return;
      case 'sendMessage':
        handleSendMessage(res, params);
        return;
      case 'createForumTopic': {
        const threadId = nextMessageId;
        nextMessageId += 1;
        respond(res, 200, {
          ok: true,
          result: {
            message_thread_id: threadId,
            name: params.name,
            icon_color: params.icon_color ?? 0,
          },
        });
        return;
      }
      case 'editForumTopic': {
        respond(res, 200, { ok: true, result: true });
        return;
      }
      case 'sendDocument':
      case 'sendVideo':
      case 'sendAudio':
      case 'sendPhoto':
      case 'sendAnimation':
      case 'sendVoice': {
        const messageId = nextMessageId;
        nextMessageId += 1;
        respond(res, 200, {
          ok: true,
          result: {
            message_id: messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 0, type: 'private' },
          },
        });
        return;
      }
      case 'getFile': {
        const entry = [...files.entries()][0];
        if (!entry) {
          respond(res, 400, { ok: false, error_code: 400, description: 'Bad Request: file not found' });
          return;
        }
        const [filePath, bytes] = entry;
        respond(res, 200, {
          ok: true,
          result: {
            file_id: typeof params.file_id === 'string' ? params.file_id : 'fake-file',
            file_path: filePath,
            file_size: bytes.byteLength,
          },
        });
        return;
      }
      case 'editMessageText':
      case 'editMessageReplyMarkup':
      case 'answerCallbackQuery':
      case 'deleteMessage':
        respond(res, 200, { ok: true, result: true });
        return;
      default:
        respond(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BYTES) {
        respond(res, 413, { ok: false, error_code: 413, description: 'Request entity too large' });
        req.destroy();
      }
    });
    req.on('error', () => {
      // Client aborts are expected; nothing to clean up beyond the response.
    });
    req.on('end', () => {
      void dispatch(req, res, raw).catch((error) => {
        respond(res, 500, {
          ok: false,
          error_code: 500,
          description: `fake server error: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Fake Telegram server failed to acquire a TCP address');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    token,
    calls,
    messages,
    sendReports,
    updates,
    files,
    fileDownloads,
    /**
     * Register the bytes `getFile`/`/file/...` will serve.
     * @param {string} filePath
     * @param {Uint8Array} bytes
     */
    setFile(filePath, bytes) {
      files.set(String(filePath), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },
    pushUpdate(update) {
      updates.push(update);
      notify(updateWaiters, update);
    },
    queueUpdates(list) {
      if (!Array.isArray(list)) return;
      for (const update of list) {
        updates.push(update);
        notify(updateWaiters, update);
      }
    },
    waitForCall(method, predicate = () => true, timeoutMs = 3000) {
      const match = (call) => call.method === method && Boolean(predicate(call));
      const existing = calls.find(match);
      if (existing) return Promise.resolve(existing);
      if (closed) return Promise.reject(new Error('Fake Telegram server is closed'));
      return createWaiter(callWaiters, match, timeoutMs, `call ${method}`);
    },
    waitForMessage(predicate = () => true, timeoutMs = 3000) {
      const match = (message) => Boolean(predicate(message));
      const existing = messages.find(match);
      if (existing) return Promise.resolve(existing);
      if (closed) return Promise.reject(new Error('Fake Telegram server is closed'));
      return createWaiter(messageWaiters, match, timeoutMs, 'message');
    },
    lastCall(method) {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        if (calls[index].method === method) return calls[index];
      }
      return undefined;
    },
    setBehavior(method, fn) {
      if (typeof fn === 'function') behaviors.set(method, fn);
      else behaviors.delete(method);
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        for (const waiter of [...callWaiters]) waiter.fail(new Error('Fake Telegram server closed'));
        for (const waiter of [...messageWaiters]) waiter.fail(new Error('Fake Telegram server closed'));
        for (const waiter of [...updateWaiters]) waiter.finish();
        await new Promise((resolve) => {
          server.close(() => resolve());
          // Fetch keep-alive sockets would otherwise hold `node --test` open.
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        });
      })();
      return closePromise;
    },
  };
}
