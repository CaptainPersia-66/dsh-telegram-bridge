import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  truncate,
  chunkText,
  formatDuration,
  formatRelativeTime,
  formatTokens,
} from '../lib/format.js';

/** Matches any unpaired UTF-16 surrogate, i.e. a split supplementary character. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ------------------------------------------------------------------ escapeHtml

test('escapeHtml escapes &, <, > and stringifies non-strings', () => {
  assert.equal(escapeHtml('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
  assert.equal(escapeHtml('"quoted" & \'single\''), '"quoted" &amp; \'single\'');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
  // Already-escaped text is escaped again: escaping is not idempotent by design.
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml('&<>'), '&amp;&lt;&gt;');
});

// -------------------------------------------------------------------- truncate

test('truncate returns inputs that already fit unchanged', () => {
  assert.equal(truncate('hello', 5), 'hello');
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('', 0), '');
  assert.equal(truncate('😀', 2), '😀');
});

test('truncate appends the suffix and respects maxChars', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abcdefgh', 6, '..'), 'abcd..');
  assert.equal(truncate('abcdef', 1), '…'); // maxChars <= suffix.length
  assert.equal(truncate('abcdef', 0), '');
  const result = truncate('x'.repeat(100), 20);
  assert.equal(result.length, 20);
  assert.ok(result.endsWith('…'));
});

test('truncate cuts on code-point boundaries', () => {
  const emoji = '😀😀😀😀';
  const cut = truncate(emoji, 4);
  assert.equal(cut, '😀…');
  assert.ok(cut.length <= 4);
  assert.ok(!LONE_SURROGATE.test(cut));

  const tiny = truncate('😀😀😀', 2); // only one code unit of room for content
  assert.equal(tiny, '…');
  assert.ok(!LONE_SURROGATE.test(tiny));
});

// ------------------------------------------------------------------- chunkText

test('chunkText handles empty and already-small inputs', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('hello'), ['hello']);
  assert.deepEqual(chunkText('😀😀'), ['😀😀']);
  const exact = 'a'.repeat(20);
  assert.deepEqual(chunkText(exact, 20), [exact]);
});

test('chunkText hard splits when no separator is available, without data loss', () => {
  const input = 'abcdefghijklmnopqrstuvwxyz';
  const chunks = chunkText(input, 10);
  assert.deepEqual(chunks, ['abcdefghij', 'klmnopqrst', 'uvwxyz']);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 10));
});

test('chunkText prefers blank lines, then newlines, then spaces', () => {
  assert.deepEqual(chunkText('aaa\n\nbbbbbb', 8), ['aaa\n\n', 'bbbbbb']);
  assert.deepEqual(chunkText('abc def\nghi', 10), ['abc def\n', 'ghi']);
  assert.deepEqual(chunkText('abc defgh', 6), ['abc ', 'defgh']);
});

test('chunkText never splits a surrogate pair', () => {
  const input = '😀😀😀😀😀';
  const chunks = chunkText(input, 3);
  assert.equal(chunks.join(''), input);
  assert.deepEqual(chunks, ['😀', '😀', '😀', '😀', '😀']);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 3));
  assert.ok(chunks.every((chunk) => !LONE_SURROGATE.test(chunk)));
});

test('chunkText preserves every character across awkward inputs', () => {
  const samples = [
    'a',
    'a b',
    'a\nb\nc',
    'x'.repeat(37),
    '😀a\n\n😀 b',
    'line1\nline2\n\nline3',
    ' \n ',
    '\n\n\n',
    'a\n\n\n\nb',
  ];
  for (const input of samples) {
    for (const limit of [2, 3, 5, 7, 10]) {
      const chunks = chunkText(input, limit);
      assert.equal(chunks.join(''), input, `join mismatch for ${JSON.stringify(input)} limit ${limit}`);
      assert.ok(chunks.length > 0, `expected chunks for ${JSON.stringify(input)}`);
      assert.ok(
        chunks.every((chunk) => chunk.length > 0 && chunk.length <= limit),
        `bad chunk size for ${JSON.stringify(input)} limit ${limit}`,
      );
      assert.ok(chunks.every((chunk) => !LONE_SURROGATE.test(chunk)));
    }
  }
});

test('chunkText defaults to 3900 UTF-16 units', () => {
  const input = 'a'.repeat(4000);
  const chunks = chunkText(input);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 3900);
  assert.equal(chunks[1].length, 100);
  assert.equal(chunks.join(''), input);
});

test('chunkText rejects unusable maxChars values', () => {
  assert.throws(() => chunkText('abc', 1), RangeError);
  assert.throws(() => chunkText('abc', 0), RangeError);
  assert.throws(() => chunkText('abc', Number.NaN), RangeError);
});

// --------------------------------------------------------------- formatDuration

test('formatDuration formats milliseconds, seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(850), '850ms');
  assert.equal(formatDuration(999), '999ms');
  assert.equal(formatDuration(-5), '0ms');
  assert.equal(formatDuration(Number.NaN), '0ms');
  assert.equal(formatDuration(1000), '1s');
  assert.equal(formatDuration(3200), '3.2s');
  assert.equal(formatDuration(60_000), '1m');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(3_900_000), '1h 5m');
  assert.equal(formatDuration(5_400_000), '1h 30m');
});

// ---------------------------------------------------------- formatRelativeTime

test('formatRelativeTime describes past and future timestamps', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now - 5_000, now), 'just now');
  assert.equal(formatRelativeTime(now - 9_999, now), 'just now');
  assert.equal(formatRelativeTime(now + 5_000, now), 'just now');
  assert.equal(formatRelativeTime(now - 10_000, now), '10s ago');
  assert.equal(formatRelativeTime(now - 12_000, now), '12s ago');
  assert.equal(formatRelativeTime(now - 60_000, now), '1m ago');
  assert.equal(formatRelativeTime(now - 300_000, now), '5m ago');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), '2d ago');
  assert.equal(formatRelativeTime(now + 300_000, now), 'in 5m');
  assert.equal(formatRelativeTime(now + 3 * 3_600_000, now), 'in 3h');
  assert.equal(formatRelativeTime(Number.NaN, now), 'just now');
});

// -------------------------------------------------------------- formatTokens

test('formatTokens compacts thousands and millions', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(10_000), '10k');
  assert.equal(formatTokens(2_500_000), '2.5M');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(formatTokens(999_999), '1M');
  assert.equal(formatTokens(-1234), '-1.2k');
  assert.equal(formatTokens(Number.NaN), 'NaN');
});
