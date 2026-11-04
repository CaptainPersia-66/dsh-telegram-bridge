/**
 * Minimal Telegram Bot API client (long polling) for the DSH Telegram bridge.
 *
 * Zero dependencies: only global `fetch`, `AbortController`/`AbortSignal` and
 * timers are used, so the module runs inside the Electron Host process.
 *
 * Security: the bot token is part of every request URL. It must never appear in
 * a log line, error message, or diagnostic, so everything that leaves this
 * module first passes through {@link TelegramApi#_redact}.
 *
 * @module telegram-bridge/telegram-api
 */

import { chunkText } from './format.js';

const DEFAULT_BASE_URL = 'https://api.telegram.org';
/** Anything shaped like a Bot API token: 6+ digits, colon, 20+ word chars. */
const TOKEN_SHAPE = /\d{6,}:[\w-]{20,}/g;
/** Telegram's own text limit is 4096; keep headroom for HTML entities. */
const SEND_CHUNK_CHARS = 3900;
const RETRY_AFTER_CAP_MS = 30_000;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 8_000;
/** Safety net so a wedged connection without a caller signal cannot hang. */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** Long polls get their own deadline on top of the Bot API `timeout`. */
const LONG_POLL_HEADROOM_MS = 15_000;
/** Default ceiling for a Bot API file download (voice notes are far smaller). */
const DEFAULT_FILE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** File uploads are slower than JSON calls; give them a larger deadline. */
const UPLOAD_TIMEOUT_MS = 120_000;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const PARSE_ENTITY_PATTERN = /parse entities/i;
const NOT_MODIFIED_PATTERN = /message is not modified/i;

/**
 * Error raised for Bot API failures and exhausted transport retries.
 *
 * `message` is user-safe (token redacted). `code` is the HTTP-style
 * `error_code` from Telegram, or `null` for network/timeout failures. Instances
 * are still regular `Error`s so callers can rely on `instanceof Error`.
 */
export class TelegramApiError extends Error {
  /**
   * @param {string} message user-safe description
   * @param {{code?: number|null, description?: string, method?: string,
   *          retryAfterSeconds?: number, isParseError?: boolean, cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'TelegramApiError';
    /** @type {number|null} */
    this.code = details.code ?? null;
    /** @type {string} */
    this.description = details.description ?? '';
    /** @type {string} */
    this.method = details.method ?? '';
    /** @type {number|undefined} */
    this.retryAfterSeconds = details.retryAfterSeconds;
    /** @type {boolean} */
    this.isParseError = details.isParseError === true;
  }
}

/**
 * Telegram Bot API client with long polling, retries, chunking and per-chat
 * rate limiting.
 */
export class TelegramApi {
  /**
   * @param {{token: string, baseUrl?: string,
   *          logger?: {info?: Function, warn?: Function, error?: Function}|null,
   *          fetchImpl?: typeof fetch, maxRetries?: number,
   *          minSendIntervalMs?: number, maxConcurrentCalls?: number,
   *          signal?: AbortSignal|null}} options
   */
  constructor(options = {}) {
    const token = typeof options.token === 'string' ? options.token.trim() : '';
    if (token === '') throw new Error('TelegramApi requires a non-empty bot token');
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('TelegramApi requires a fetch implementation (global fetch is unavailable)');
    }
    const baseUrl =
      typeof options.baseUrl === 'string' && options.baseUrl.trim() !== ''
        ? options.baseUrl.trim()
        : DEFAULT_BASE_URL;
    this._token = token;
    this._baseUrl = baseUrl.replace(/\/+$/, '');
    this._logger = options.logger ?? null;
    this._fetch = fetchImpl;
    this._maxRetries = normalizeCount(options.maxRetries, 3, 0);
    this._minSendIntervalMs = normalizeCount(options.minSendIntervalMs, 60, 0);
    this._maxConcurrentCalls = normalizeCount(options.maxConcurrentCalls, 4, 1);
    this._lifecycleSignal = options.signal ?? null;

    /** @type {number} */ this._activeCalls = 0;
    /** @type {Array<{resolve: Function, reject: Function, signal: AbortSignal|undefined, cleanup: Function}>} */
    this._slotWaiters = [];
    /** @type {Map<string, {tail: Promise<void>, lastSendStartedAt: number}>} */
    this._chatStates = new Map();
    /** Transport failures are retryable; TelegramError code `null` alone is not. */
    this._transportErrors = new WeakSet();
  }

  /**
   * Perform one raw Bot API method call.
   *
   * `ok:false` responses and transport failures are wrapped in
   * {@link TelegramApiError}; aborts propagate as `AbortError`. Retries cover
   * 429 (honoring `retry_after`, capped at 30s), all 5xx, and network/timeout
   * errors. Other 4xx responses are never retried.
   *
   * @param {string} method Bot API method name
   * @param {Record<string, unknown>} [params] JSON body
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
   *   `timeoutMs` is an internal per-attempt network deadline; callers normally
   *   leave it unset.
   * @returns {Promise<any>} the Bot API `result` payload
   */
  async call(method, params = {}, options = {}) {
    if (typeof method !== 'string' || !METHOD_PATTERN.test(method)) {
      throw new TypeError('TelegramApi.call requires a valid Bot API method name');
    }
    let body;
    try {
      body = JSON.stringify(params ?? {});
    } catch {
      throw new TypeError('TelegramApi.call params must be JSON-serializable');
    }
    const callerSignal = options?.signal ?? undefined;
    const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
      ? Math.max(0, Number(options.timeoutMs))
      : DEFAULT_CALL_TIMEOUT_MS;
    const combined = combineSignals([this._lifecycleSignal, callerSignal]);

    let attempt = 0;
    for (;;) {
      this._throwIfAborted(combined);
      /** @type {TelegramApiError} */
      let failure;
      try {
        return await this._request(method, body, combined, timeoutMs);
      } catch (error) {
        if (isAbortError(error)) throw createAbortError(combined);
        failure = this._toApiError(method, error);
      }
      const delayMs = this._retryDelay(failure, attempt);
      if (delayMs === null) throw failure;
      this._log(
        'warn',
        `Telegram ${method} failed (${failure.code ?? 'network'}); retry ${attempt + 1}/${this._maxRetries} in ${delayMs}ms`,
      );
      await sleep(delayMs, combined);
      attempt += 1;
    }
  }

  /**
   * Bot identity lookup.
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object>} the Telegram `User` object
   */
  async getMe(options = {}) {
    return this.call('getMe', {}, { signal: options?.signal });
  }

  /**
   * Long-poll for updates.
   *
   * The request gets `timeout * 1000 + 15000` as a network deadline so a stalled
   * long poll cannot hang the bridge forever; a caller abort still wins.
   *
   * @param {{offset?: number, timeoutSeconds?: number, limit?: number,
   *          allowedUpdates?: string[]|null, signal?: AbortSignal}} [options]
   * @returns {Promise<object[]>} updates (`[]` on a poll timeout)
   */
  async getUpdates(options = {}) {
    const offset = Number.isFinite(Number(options.offset)) ? Number(options.offset) : 0;
    const timeoutSeconds = Number.isFinite(Number(options.timeoutSeconds))
      ? Math.max(0, Number(options.timeoutSeconds))
      : 25;
    const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 100;
    const allowedUpdates = options.allowedUpdates === undefined
      ? ['message', 'callback_query']
      : options.allowedUpdates;
    /** @type {Record<string, unknown>} */
    const params = { offset, timeout: timeoutSeconds, limit };
    if (allowedUpdates !== null) params.allowed_updates = allowedUpdates;
    const result = await this.call('getUpdates', params, {
      signal: options.signal,
      timeoutMs: timeoutSeconds * 1000 + LONG_POLL_HEADROOM_MS,
    });
    return Array.isArray(result) ? result : [];
  }

  /**
   * Resolve one Telegram-hosted file (voice notes, audio) to a download path.
   * @param {string} fileId Bot API `file_id`
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{file_id: string, file_path?: string, file_size?: number}>}
   */
  async getFile(fileId, options = {}) {
    if (typeof fileId !== 'string' || fileId === '') {
      throw new TypeError('TelegramApi.getFile requires a file id');
    }
    return this.call('getFile', { file_id: fileId }, { signal: options?.signal });
  }

  /**
   * Download the bytes of a file resolved through `getFile`.
   *
   * Bot API file downloads are a plain HTTPS GET on `/file/bot<token>/<path>`
   * (not a JSON method), so this method bypasses `call` while still using the
   * same abort, timeout, and token-redaction rules.
   *
   * @param {string} filePath the `file_path` returned by getFile
   * @param {{signal?: AbortSignal, maxBytes?: number}} [options]
   * @returns {Promise<Uint8Array>}
   */
  async downloadFile(filePath, options = {}) {
    if (typeof filePath !== 'string' || filePath === '') {
      throw new TypeError('TelegramApi.downloadFile requires a file path');
    }
    const maxBytes = Number.isFinite(Number(options?.maxBytes))
      ? Math.max(1, Number(options.maxBytes))
      : DEFAULT_FILE_DOWNLOAD_MAX_BYTES;
    const combined = combineSignals([this._lifecycleSignal, options?.signal]);
    const bounded = combineSignals([combined, AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS)]);
    this._throwIfAborted(bounded);
    const url = `${this._baseUrl}/file/bot${this._token}/${String(filePath).replace(/^\/+/, '')}`;
    let response;
    try {
      response = await this._fetch(url, { signal: bounded });
    } catch (error) {
      if (isAbortError(error)) throw createAbortError(bounded);
      throw new TelegramApiError(this._redact(`Telegram file download failed: ${error?.message ?? error}`), {
        method: 'downloadFile',
        cause: error,
      });
    }
    if (!response.ok) {
      const description = `Telegram file download failed with HTTP ${response.status}`;
      throw new TelegramApiError(this._redact(description), {
        code: response.status,
        description,
        method: 'downloadFile',
      });
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new TelegramApiError(`Telegram file is too large (${declared} bytes; limit ${maxBytes})`, {
        description: 'file too large',
        method: 'downloadFile',
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new TelegramApiError(`Telegram file is too large (${bytes.byteLength} bytes; limit ${maxBytes})`, {
        description: 'file too large',
        method: 'downloadFile',
      });
    }
    return bytes;
  }

  /**
   * Upload one file with a Bot API media method (`sendPhoto`, `sendVideo`,
   * `sendAudio`, `sendDocument`, …) as multipart/form-data.
   *
   * @param {{chatId: string|number, method?: string, field?: string,
   *          filename?: string, bytes: Uint8Array, mimeType?: string|null,
   *          caption?: string|null}} request
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object>} the sent `Message`
   */
  async sendFile(request, options = {}) {
    const chatId = request?.chatId;
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('sendFile requires a chatId');
    }
    const method = typeof request?.method === 'string' && request.method !== '' ? request.method : 'sendDocument';
    if (!METHOD_PATTERN.test(method)) throw new TypeError('sendFile requires a valid Bot API method name');
    const field = typeof request?.field === 'string' && request.field !== '' ? request.field : 'document';
    const bytes = request?.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypeError('sendFile requires non-empty file bytes');
    }
    const bounded = combineSignals([this._lifecycleSignal, options?.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]);
    this._throwIfAborted(bounded);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    const threadId = Number(request.messageThreadId);
    if (Number.isSafeInteger(threadId) && threadId > 0) form.append('message_thread_id', String(threadId));
    if (typeof request.caption === 'string' && request.caption !== '') {
      form.append('caption', request.caption.slice(0, 1024));
    }
    form.append(
      field,
      new Blob([bytes], { type: request.mimeType ?? 'application/octet-stream' }),
      request.filename || 'file',
    );
    let response;
    try {
      response = await this._fetch(`${this._baseUrl}/bot${this._token}/${method}`, {
        method: 'POST',
        body: form,
        signal: bounded,
      });
    } catch (error) {
      if (isAbortError(error)) throw createAbortError(bounded);
      throw new TelegramApiError(this._redact(`Telegram ${method} failed: ${error?.message ?? error}`), {
        method,
        cause: error,
      });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.ok !== true) {
      const description = this._redact(
        typeof payload?.description === 'string' ? payload.description : `Telegram ${method} failed with HTTP ${response.status}`,
      );
      throw new TelegramApiError(description, {
        code: payload?.error_code ?? response.status,
        description,
        method,
      });
    }
    return payload.result;
  }

  /**
   * Create one forum topic in a supergroup where the bot may manage topics.
   *
   * @param {{chatId: string|number, name: string, iconColor?: number}} request
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{message_thread_id: number, name: string}>}
   */
  async createForumTopic(request, options = {}) {
    const chatId = request?.chatId;
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('createForumTopic requires a chatId');
    }
    const name = String(request?.name ?? '').trim();
    if (name === '') throw new Error('createForumTopic requires a name');
    /** @type {Record<string, unknown>} */
    const params = { chat_id: chatId, name: name.slice(0, 128) };
    const iconColor = Number(request?.iconColor);
    if (Number.isSafeInteger(iconColor) && iconColor >= 0) params.icon_color = iconColor;
    return this.call('createForumTopic', params, { signal: options?.signal });
  }

  /**
   * Rename (and optionally edit) one forum topic.
   *
   * @param {{chatId: string|number, messageThreadId: number, name?: string}} request
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<true>}
   */
  async editForumTopic(request, options = {}) {
    const threadId = Number(request?.messageThreadId);
    if (!Number.isSafeInteger(threadId) || threadId <= 0) {
      throw new Error('editForumTopic requires a positive messageThreadId');
    }
    /** @type {Record<string, unknown>} */
    const params = { chat_id: request.chatId, message_thread_id: threadId };
    if (typeof request.name === 'string' && request.name.trim() !== '') params.name = request.name.trim().slice(0, 128);
    try {
      return await this.call('editForumTopic', params, { signal: options?.signal });
    } catch (error) {
      // Editing a topic to its current name is a successful no-op.
      if (error instanceof TelegramApiError && error.code === 400 && /TOPIC_NOT_MODIFIED/i.test(error.description)) {
        return true;
      }
      throw error;
    }
  }

  /**
   * Send text to a chat, splitting it into Telegram-sized chunks.
   *
   * The inline keyboard and reply target are attached to the first chunk only.
   * If Telegram rejects a chunk because of unparsable entities, that chunk is
   * retried once as plain text (without `parse_mode` or `reply_markup`).
   *
   * @param {{chatId: string|number, text: string, parseMode?: string|null,
   *          keyboard?: unknown, disableWebPagePreview?: boolean,
   *          replyToMessageId?: number|string|null, messageThreadId?: number}} message
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object[]>} sent `Message` objects, one per chunk
   */
  async sendMessage(message, options = {}) {
    const chatId = message?.chatId;
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('sendMessage requires a chatId');
    }
    const parseMode = message.parseMode === undefined ? 'HTML' : message.parseMode;
    const keyboard = message.keyboard ?? null;
    const disableWebPagePreview = message.disableWebPagePreview !== false;
    const replyToMessageId = message.replyToMessageId ?? null;
    const messageThreadId = Number(message.messageThreadId);
    const text = message.text === undefined || message.text === null ? '' : String(message.text);
    const chunks = chunkText(text, SEND_CHUNK_CHARS);
    if (chunks.length === 0) return [];
    const combined = combineSignals([this._lifecycleSignal, options?.signal]);
    return this._runChatSerialized(String(chatId), combined, async (state) => {
      /** @type {object[]} */
      const sent = [];
      for (let index = 0; index < chunks.length; index += 1) {
        await this._throttleChat(state, combined);
        /** @type {Record<string, unknown>} */
        const params = { chat_id: chatId, text: chunks[index] };
        if (parseMode) params.parse_mode = parseMode;
        if (disableWebPagePreview) params.disable_web_page_preview = true;
        if (Number.isSafeInteger(messageThreadId) && messageThreadId > 0) params.message_thread_id = messageThreadId;
        if (index === 0) {
          if (keyboard) params.reply_markup = keyboard;
          if (replyToMessageId !== null) params.reply_to_message_id = replyToMessageId;
        }
        try {
          sent.push(await this.call('sendMessage', params, { signal: combined }));
        } catch (error) {
          if (!(error instanceof TelegramApiError) || !error.isParseError || !params.parse_mode) throw error;
          // Telegram cannot render the markup; still deliver the plain text.
          /** @type {Record<string, unknown>} */
          const fallback = { ...params };
          delete fallback.parse_mode;
          delete fallback.reply_markup;
          sent.push(await this.call('sendMessage', fallback, { signal: combined }));
        }
      }
      return sent;
    });
  }

  /**
   * Edit an existing message. Returns `true` for the Telegram "not modified"
   * no-op so callers can re-render idempotently.
   *
   * @param {{chatId: string|number, messageId: number, text: string,
   *          parseMode?: string|null, keyboard?: unknown}} message
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object|true>} edited `Message` or `true`
   */
  async editMessageText(message, options = {}) {
    requireChatAndMessage(message, 'editMessageText');
    const parseMode = message.parseMode === undefined ? 'HTML' : message.parseMode;
    /** @type {Record<string, unknown>} */
    const params = {
      chat_id: message.chatId,
      message_id: message.messageId,
      text: message.text === undefined || message.text === null ? '' : String(message.text),
    };
    if (parseMode) params.parse_mode = parseMode;
    if (message.keyboard) params.reply_markup = message.keyboard;
    const combined = combineSignals([this._lifecycleSignal, options?.signal]);
    try {
      return await this.call('editMessageText', params, { signal: combined });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        if (error.code === 400 && NOT_MODIFIED_PATTERN.test(error.description)) return true;
        if (error.isParseError && params.parse_mode) {
          /** @type {Record<string, unknown>} */
          const fallback = { ...params };
          delete fallback.parse_mode;
          return this.call('editMessageText', fallback, { signal: combined });
        }
      }
      throw error;
    }
  }

  /**
   * Replace an existing message's inline keyboard. Passing `null` clears it.
   *
   * @param {{chatId: string|number, messageId: number, keyboard?: unknown}} message
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object|true>} edited `Message` or `true`
   */
  async editMessageReplyMarkup(message, options = {}) {
    requireChatAndMessage(message, 'editMessageReplyMarkup');
    /** @type {Record<string, unknown>} */
    const params = {
      chat_id: message.chatId,
      message_id: message.messageId,
      reply_markup: message.keyboard ?? { inline_keyboard: [] },
    };
    const combined = combineSignals([this._lifecycleSignal, options?.signal]);
    try {
      return await this.call('editMessageReplyMarkup', params, { signal: combined });
    } catch (error) {
      if (error instanceof TelegramApiError && error.code === 400 && NOT_MODIFIED_PATTERN.test(error.description)) {
        return true;
      }
      throw error;
    }
  }

  /**
   * Acknowledge an inline-keyboard button press.
   *
   * @param {{callbackQueryId: string, text?: string|null, showAlert?: boolean}} query
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<true>} always `true`
   */
  async answerCallbackQuery(query, options = {}) {
    const callbackQueryId = query?.callbackQueryId;
    if (typeof callbackQueryId !== 'string' || callbackQueryId === '') {
      throw new Error('answerCallbackQuery requires a callbackQueryId');
    }
    /** @type {Record<string, unknown>} */
    const params = { callback_query_id: callbackQueryId };
    if (query.text !== null && query.text !== undefined) params.text = String(query.text);
    if (query.showAlert === true) params.show_alert = true;
    await this.call('answerCallbackQuery', params, { signal: options?.signal });
    return true;
  }

  /**
   * Delete a message.
   *
   * @param {{chatId: string|number, messageId: number}} message
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<true>} always `true`
   */
  async deleteMessage(message, options = {}) {
    requireChatAndMessage(message, 'deleteMessage');
    await this.call(
      'deleteMessage',
      { chat_id: message.chatId, message_id: message.messageId },
      { signal: options?.signal },
    );
    return true;
  }

  // ---------------------------------------------------------------- internals

  /**
   * POST one request body and decode the standard Bot API envelope.
   *
   * @param {string} method
   * @param {string} body serialized JSON
   * @param {AbortSignal|undefined} signal
   * @param {number} timeoutMs
   * @returns {Promise<any>} `result`
   */
  async _request(method, body, signal, timeoutMs) {
    const response = await this._withSlot(
      () => this._fetchOnce(this._endpoint(method), body, signal, timeoutMs),
      signal,
    );
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw createAbortError(signal);
      throw new Error(
        `Telegram ${method}: failed to read response body (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    let data = null;
    if (typeof text === 'string' && text.trim() !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (data !== null && typeof data === 'object' && data.ok === true) return data.result;
    throw this._apiErrorFromResponse(method, response, data);
  }

  /**
   * Map a non-`ok` Bot API reply to {@link TelegramApiError}.
   *
   * @param {string} method
   * @param {Response} response
   * @param {any} data decoded body, `null` when not JSON
   * @returns {TelegramApiError}
   */
  _apiErrorFromResponse(method, response, data) {
    const status = Number.isFinite(Number(response?.status)) ? Number(response.status) : 0;
    const errorObject = data !== null && typeof data === 'object' ? data : null;
    let code = null;
    if (errorObject !== null && Number.isFinite(Number(errorObject.error_code))) {
      code = Number(errorObject.error_code);
    } else if (status >= 400) {
      code = status;
    }
    let description;
    if (errorObject !== null && typeof errorObject.description === 'string' && errorObject.description !== '') {
      description = errorObject.description;
    } else if (data === null) {
      description = 'Invalid JSON response from Telegram';
    } else {
      description = `Telegram responded with HTTP ${status}`;
    }
    const fromBody = errorObject?.parameters?.retry_after;
    const fromHeader = retryAfterFromHeader(response);
    const rawRetryAfter = fromBody ?? fromHeader;
    const retryAfterSeconds =
      rawRetryAfter !== undefined && rawRetryAfter !== null && Number.isFinite(Number(rawRetryAfter))
        ? Number(rawRetryAfter)
        : undefined;
    const safeDescription = this._redact(description);
    const message = `Telegram ${method} failed${code === null ? '' : ` (code ${code})`}: ${safeDescription}`;
    return new TelegramApiError(message, {
      code,
      description: safeDescription,
      method,
      retryAfterSeconds,
      isParseError: PARSE_ENTITY_PATTERN.test(description),
    });
  }

  /**
   * Run `fetch` once under an internal timeout and the combined abort signals.
   *
   * @param {string} url
   * @param {string} body
   * @param {AbortSignal|undefined} callerSignal
   * @param {number} timeoutMs
   * @returns {Promise<Response>}
   */
  async _fetchOnce(url, body, callerSignal, timeoutMs) {
    const controller = new AbortController();
    const combined = combineSignals([controller.signal, this._lifecycleSignal, callerSignal]);
    if (combined?.aborted) throw createAbortError(combined);
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
    }
    try {
      const response = await this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: combined,
      });
      if (callerSignal?.aborted) throw createAbortError(callerSignal);
      if (this._lifecycleSignal?.aborted) throw createAbortError(this._lifecycleSignal);
      return response;
    } catch (error) {
      if (callerSignal?.aborted) throw createAbortError(callerSignal);
      if (this._lifecycleSignal?.aborted) throw createAbortError(this._lifecycleSignal);
      if (controller.signal.aborted) throw timeoutError(timeoutMs);
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Decide whether `error` should be retried. `null` means "give up".
   *
   * @param {TelegramApiError} error
   * @param {number} attempt zero-based retry attempt
   * @returns {number|null} delay before the next attempt, in ms
   */
  _retryDelay(error, attempt) {
    if (attempt >= this._maxRetries) return null;
    if (error.code === 429) {
      const seconds = Number.isFinite(error.retryAfterSeconds) ? Math.max(0, error.retryAfterSeconds) : 1;
      return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
    }
    if (this._transportErrors.has(error)) return backoffDelay(attempt);
    if (error.code !== null && error.code >= 500 && error.code <= 599) return backoffDelay(attempt);
    return null; // other 4xx: never retry
  }

  /**
   * Wrap a transport failure in {@link TelegramApiError} with `code: null`.
   *
   * @param {string} method
   * @param {unknown} error
   * @returns {TelegramApiError}
   */
  _toApiError(method, error) {
    if (error instanceof TelegramApiError) return error;
    const timedOut = isTimeoutError(error);
    const raw = error instanceof Error ? error.message : String(error);
    const safe = this._redact(raw);
    const description = this._redact(timedOut ? 'Telegram request timed out' : safe);
    const message = timedOut
      ? `Telegram ${method} request timed out`
      : `Telegram ${method} request failed: ${safe}`;
    // Keep the original cause only when its message carries no token.
    const cause = error instanceof Error && raw !== safe ? new Error(safe) : error;
    const wrapped = new TelegramApiError(message, {
      code: null,
      description,
      method,
      isParseError: false,
      cause,
    });
    this._transportErrors.add(wrapped);
    return wrapped;
  }

  /**
   * Strip the bot token from any diagnostic text.
   *
   * @param {unknown} value
   * @returns {string}
   */
  _redact(value) {
    let text = value instanceof Error ? value.message : String(value);
    if (this._token) text = text.split(this._token).join('<redacted>');
    return text.replace(TOKEN_SHAPE, '<redacted>');
  }

  /**
   * Build the tokenized method URL. Never returned to callers verbatim.
   *
   * @param {string} method
   * @returns {string}
   */
  _endpoint(method) {
    return `${this._baseUrl}/bot${this._token}/${method}`;
  }

  /**
   * Log without ever letting logging break the bridge.
   *
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   */
  _log(level, message) {
    const logger = this._logger;
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.log;
    if (typeof fn !== 'function') return;
    try {
      fn.call(logger, `[dsh-telegram] ${this._redact(message)}`);
    } catch {
      // Diagnostics must not take the bridge down.
    }
  }

  /**
   * Acquire a global in-flight slot, waiting (abortably) when saturated.
   *
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<void>}
   */
  _acquire(signal) {
    if (this._activeCalls < this._maxConcurrentCalls) {
      this._activeCalls += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, cleanup: () => {} };
      const onAbort = () => {
        const index = this._slotWaiters.indexOf(waiter);
        if (index !== -1) this._slotWaiters.splice(index, 1);
        reject(createAbortError(signal));
      };
      waiter.cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) {
        if (signal.aborted) {
          reject(createAbortError(signal));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this._slotWaiters.push(waiter);
    });
  }

  /** Release a slot, handing it directly to the next waiter when present. */
  _release() {
    const next = this._slotWaiters.shift();
    if (next) {
      next.cleanup();
      next.resolve();
    } else {
      this._activeCalls -= 1;
    }
  }

  /**
   * Run `fn` while holding one of the global in-flight slots.
   *
   * @param {() => Promise<any>} fn
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<any>}
   */
  async _withSlot(fn, signal) {
    await this._acquire(signal);
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  /**
   * State object serializing sends to one chat. Kept for the process lifetime
   * so the minimum send gap also applies across separate public calls.
   *
   * @param {string} key
   */
  _chatState(key) {
    let state = this._chatStates.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), lastSendStartedAt: 0 };
      this._chatStates.set(key, state);
    }
    return state;
  }

  /**
   * Serialize a task behind the previous task for the same chat, abortably.
   *
   * The chain link is released in `finally`, and on an abort while queued the
   * link is released as soon as the predecessor settles, so an aborted waiter
   * can never deadlock later sends.
   *
   * @template T
   * @param {string} key chat id as string
   * @param {AbortSignal|undefined} signal
   * @param {(state: {lastSendStartedAt: number}) => Promise<T>} task
   * @returns {Promise<T>}
   */
  async _runChatSerialized(key, signal, task) {
    const state = this._chatState(key);
    const previous = state.tail;
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve();
    });
    state.tail = previous.then(() => gate);
    try {
      await waitForAbortable(previous, signal);
    } catch (error) {
      // We never held the gate; free it once the predecessor finishes so the
      // chain keeps moving for later senders.
      previous.then(
        () => release(),
        () => release(),
      );
      throw error;
    }
    try {
      return await task(state);
    } finally {
      release();
    }
  }

  /**
   * Wait out the per-chat minimum gap before starting the next send.
   *
   * @param {{lastSendStartedAt: number}} state
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<void>}
   */
  async _throttleChat(state, signal) {
    const waitMs = state.lastSendStartedAt + this._minSendIntervalMs - Date.now();
    if (waitMs > 0) await sleep(waitMs, signal);
    state.lastSendStartedAt = Date.now();
  }

  /**
   * Throw the current abort reason if the signal fired.
   *
   * @param {AbortSignal|undefined} signal
   */
  _throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError(signal);
  }
}

// ------------------------------------------------------------------ helpers

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @returns {number}
 */
function normalizeCount(value, fallback, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.floor(number));
}

/**
 * @param {Array<AbortSignal|undefined|null>} signals
 * @returns {AbortSignal|undefined}
 */
function combineSignals(signals) {
  const list = signals.filter((signal) => signal !== null && signal !== undefined);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

/**
 * @param {AbortSignal|undefined} signal
 * @returns {Error}
 */
function createAbortError(signal) {
  const reason = signal?.reason;
  if (reason && reason.name === 'AbortError') return reason;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  return Boolean(error) && error.name === 'AbortError';
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isTimeoutError(error) {
  return Boolean(error) && error.name === 'TimeoutError';
}

/**
 * @param {number} timeoutMs
 * @returns {Error}
 */
function timeoutError(timeoutMs) {
  const error = new Error(`Telegram API request timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

/**
 * Exponential backoff with jitter: `200ms * 2^attempt` capped at 8s.
 *
 * @param {number} attempt zero-based attempt
 * @returns {number} delay in ms
 */
function backoffDelay(attempt) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/**
 * Abortable sleep. Resolves immediately for a non-positive delay.
 *
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError(signal));
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Await `promise`, but reject with the abort reason as soon as `signal` fires.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<T>}
 */
function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(createAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Best-effort `Retry-After` header parsing (Telegram usually uses the body).
 *
 * @param {Response} response
 * @returns {number|undefined}
 */
function retryAfterFromHeader(response) {
  const headers = response?.headers;
  if (!headers || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('retry-after');
  if (raw === null || raw === undefined || raw === '') return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * @param {{chatId?: unknown, messageId?: unknown}} message
 * @param {string} method
 */
function requireChatAndMessage(message, method) {
  if (message?.chatId === undefined || message.chatId === null || message.chatId === '') {
    throw new Error(`${method} requires a chatId`);
  }
  if (message.messageId === undefined || message.messageId === null || message.messageId === '') {
    throw new Error(`${method} requires a messageId`);
  }
}
