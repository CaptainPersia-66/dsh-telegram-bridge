/**
 * Pure formatting helpers used to render Telegram messages.
 *
 * The module is dependency-free and side-effect free so it can be unit tested
 * outside the Host process. It contains no I/O and reads no configuration.
 *
 * @module telegram-bridge/format
 */

/** Characters that Telegram's HTML parse mode requires to be escaped. */
const HTML_ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** UTF-16 ranges for surrogate halves; used to avoid splitting emoji. */
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/**
 * Escape text for Telegram's HTML parse mode.
 *
 * Only `&`, `<` and `>` are special in Telegram's minimal HTML subset; quotes
 * are legal and are deliberately left untouched.
 *
 * @param {unknown} value value to stringify and escape
 * @returns {string} escaped text
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => HTML_ENTITY[char]);
}

/**
 * Truncate text to at most `maxChars` UTF-16 code units, appending `suffix`.
 *
 * Cuts on a code-point boundary so a surrogate pair (for example an emoji) is
 * never split. When the suffix itself does not fit, a prefix of the suffix is
 * returned instead; the caller gets a total length `<= maxChars` whenever
 * `maxChars > suffix.length`.
 *
 * @param {unknown} text value to stringify and truncate
 * @param {number} maxChars maximum length of the returned string
 * @param {string} [suffix='…'] appended when truncation happens
 * @returns {string} shortened text
 */
export function truncate(text, maxChars, suffix = '…') {
  const str = String(text);
  const limit = Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 0;
  const tail = String(suffix ?? '');
  if (str.length <= limit) return str;
  if (limit <= 0) return '';
  const room = limit - tail.length;
  if (room <= 0) return sliceCodePoints(tail, limit);
  return str.slice(0, safeCutIndex(str, room)) + tail;
}

/**
 * Split text into Telegram-sized chunks without losing a single character.
 *
 * Chunk boundaries are chosen with a priority order: after a blank line, after
 * a newline, after a space, then a hard split. Separator characters stay in the
 * earlier chunk (chunks concatenate back to the exact input), and a UTF-16
 * surrogate pair is never split.
 *
 * @param {unknown} text string to split
 * @param {number} [maxChars=3900] maximum chunk length (`>= 2`)
 * @returns {string[]} non-empty chunks; `[]` for empty input
 */
export function chunkText(text, maxChars = 3900) {
  const str = String(text);
  const limit = Math.floor(Number(maxChars));
  if (!Number.isFinite(limit) || limit < 2) {
    throw new RangeError('chunkText requires maxChars to be a finite number >= 2');
  }
  if (str.length === 0) return [];
  if (str.length <= limit) return [str];

  /** @type {string[]} */
  const chunks = [];
  let start = 0;
  while (start < str.length) {
    const remaining = str.length - start;
    if (remaining <= limit) {
      chunks.push(str.slice(start));
      break;
    }
    const windowEnd = start + limit; // exclusive: this is the hard-split limit
    let cut = -1;
    const blankLine = lastSeparatorInWindow(str, '\n\n', start, windowEnd);
    if (blankLine !== -1) {
      cut = blankLine + 2;
    } else {
      const newline = lastSeparatorInWindow(str, '\n', start, windowEnd);
      if (newline !== -1) {
        cut = newline + 1;
      } else {
        const space = lastSeparatorInWindow(str, ' ', start, windowEnd);
        cut = space !== -1 ? space + 1 : windowEnd;
      }
    }
    cut = safeCutIndex(str, cut);
    // Separator cuts always advance by at least one code unit; this guard only
    // protects the (unreachable with limit >= 2) case of an empty chunk.
    if (cut <= start) cut = Math.min(start + 2, str.length);
    chunks.push(str.slice(start, cut));
    start = cut;
  }
  return chunks;
}

/**
 * Human readable duration, e.g. `850ms`, `3.2s`, `1m 5s`, `1h 30m`.
 *
 * Zero, negative and non-finite inputs collapse to `0ms`; sub-second precision
 * is kept because individual tool calls are usually fast.
 *
 * @param {number} ms duration in milliseconds
 * @returns {string} compact duration
 */
export function formatDuration(ms) {
  const total = Number(ms);
  if (!Number.isFinite(total) || total <= 0) return '0ms';
  const roundedMs = Math.round(total);
  if (roundedMs < 1000) return `${roundedMs}ms`;
  if (roundedMs < 60_000) {
    const seconds = Math.round(roundedMs / 100) / 10;
    // 59.96s rounds to a full minute; report it as such instead of `60s`.
    if (seconds >= 60) return '1m';
    return `${seconds}s`;
  }
  const totalSeconds = Math.round(roundedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/**
 * Relative time such as `just now`, `12s ago`, `5m ago`, `in 3h`.
 *
 * Everything under ten seconds (past or future) is reported as `just now`; the
 * clock skew tolerance keeps noisy timestamps from flickering between units.
 *
 * @param {number} epochMs timestamp to describe
 * @param {number} [now=Date.now()] reference time
 * @returns {string} relative description
 */
export function formatRelativeTime(epochMs, now = Date.now()) {
  const timestamp = Number(epochMs);
  const reference = Number(now);
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)) return 'just now';
  const diff = reference - timestamp; // positive means the timestamp is in the past
  const magnitude = Math.abs(diff);
  if (magnitude < 10_000) return 'just now';
  let value;
  let unit;
  if (magnitude < 60_000) {
    value = Math.floor(magnitude / 1000);
    unit = 's';
  } else if (magnitude < 3_600_000) {
    value = Math.floor(magnitude / 60_000);
    unit = 'm';
  } else if (magnitude < 86_400_000) {
    value = Math.floor(magnitude / 3_600_000);
    unit = 'h';
  } else {
    value = Math.floor(magnitude / 86_400_000);
    unit = 'd';
  }
  return diff > 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
}

/**
 * Compact token count: `999`, `1.2k`, `1.2M`.
 *
 * Rounds to one decimal above a thousand and drops a trailing `.0`, so the
 * common `1_234_567` case reads `1.2M` rather than `1234567`.
 *
 * @param {number} count number of tokens
 * @returns {string} compact count
 */
export function formatTokens(count) {
  const value = Number(count);
  if (!Number.isFinite(value)) return String(count);
  const magnitude = Math.abs(value);
  if (magnitude < 999.5) return String(Math.round(value));
  const units = ['k', 'M', 'G'];
  let unitIndex = 0;
  let scaled = value / 1000;
  // Threshold is slightly under 1000 so values like 999_960 promote to `1M`
  // instead of rendering as `1000k`.
  while (Math.abs(scaled) >= 999.95 && unitIndex < units.length - 1) {
    unitIndex += 1;
    scaled /= 1000;
  }
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${units[unitIndex]}`;
}

/**
 * Slice a string to a code-point-safe prefix of at most `maxUnits` code units.
 *
 * @param {string} str source
 * @param {number} maxUnits maximum UTF-16 code units
 * @returns {string} prefix without a dangling high surrogate
 */
function sliceCodePoints(str, maxUnits) {
  return str.slice(0, safeCutIndex(str, maxUnits));
}

/**
 * Move a cut position left by one unit if it would split a surrogate pair.
 *
 * @param {string} str source
 * @param {number} index candidate cut position
 * @returns {number} safe cut position
 */
function safeCutIndex(str, index) {
  if (index <= 0 || index >= str.length) return Math.max(0, index);
  const before = str.charCodeAt(index - 1);
  const after = str.charCodeAt(index);
  if (isHighSurrogate(before) && isLowSurrogate(after)) return index - 1;
  return index;
}

/**
 * Find the last occurrence of a separator fully contained in `[start, end)`.
 *
 * @param {string} str source
 * @param {string} separator needle
 * @param {number} start inclusive search start
 * @param {number} end exclusive chunk boundary
 * @returns {number} code unit index of the separator, or `-1`
 */
function lastSeparatorInWindow(str, separator, start, end) {
  const index = str.lastIndexOf(separator, end - separator.length);
  return index >= start ? index : -1;
}

/** @param {number} code @returns {boolean} */
function isHighSurrogate(code) {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

/** @param {number} code @returns {boolean} */
function isLowSurrogate(code) {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}
