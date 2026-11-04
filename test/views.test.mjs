/**
 * Unit tests for notification rendering: the turn-finished push must carry the
 * complete final assistant message without breaking Telegram's message limits or
 * producing invalid HTML.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { turnEndParts } from '../lib/views.js'

/** @param {{ html: string }[]} parts */
function visible(parts) {
  return parts.map((part) => part.html.replace(/<[^>]+>/g, '')).join('')
}

test('turn-end notification sends the complete answer in safe chunks', () => {
  const answer = 'Sentence with <html> & "quotes". '.repeat(300)
  const parts = turnEndParts(
    { id: 'session-long', title: 'Long answer', cwd: 'C:\\work' },
    {
      turn: 3,
      reason: 'completed',
      sessionId: 'session-long',
      turnView: {
        turns: [{ turn: 3, endReason: 'completed', assistantText: answer, usage: { input: 10, output: 20 } }],
      },
    },
  )
  assert.ok(parts.length > 2, 'long answers must be split into several messages')
  for (const part of parts) assert.ok(part.html.length <= 4096, `part too long: ${part.html.length}`)
  assert.ok(parts[parts.length - 1].keyboard, 'action buttons ride on the final part')
  const text = visible(parts)
  // Every escaped sentence survives; chunk boundaries may split at most a few.
  assert.ok(text.split('Sentence with &lt;html&gt; &amp; "quotes".').length - 1 >= 290)
  assert.ok(!parts.map((part) => part.html).join('').includes('<html>'), 'model text must be escaped')
})

test('turn-end notification truncates when snippetChars is positive', () => {
  const parts = turnEndParts(
    { id: 's', title: 'T' },
    {
      turn: 1,
      reason: 'completed',
      sessionId: 's',
      snippetChars: 400,
      turnView: { turns: [{ turn: 1, endReason: 'completed', assistantText: 'x'.repeat(5000), usage: null }] },
    },
  )
  const text = visible(parts)
  assert.ok(text.includes('truncated'))
  assert.ok(text.length < 900)
})

test('turn-end notification includes the error line for a failed turn', () => {
  const parts = turnEndParts(
    { id: 's', title: 'T' },
    {
      turn: 1,
      reason: 'error',
      sessionId: 's',
      turnView: { turns: [{ turn: 1, endReason: 'error', assistantText: '', errorMessage: 'model exploded', usage: null }] },
    },
  )
  assert.ok(parts[0].html.includes('model exploded'))
})

test('turn-end header carries usage and session link instead of a footer bubble', () => {
  const parts = turnEndParts(
    { id: 'session-x', title: 'T', cwd: 'C:\\w' },
    {
      turn: 2,
      reason: 'completed',
      sessionId: 'session-x',
      url: 'http://127.0.0.1:1234',
      turnView: {
        turns: [{ turn: 2, endReason: 'completed', assistantText: 'Short answer.', usage: { input: 10, output: 20 } }],
      },
    },
  )
  // Two messages: header (status + usage + link) and the answer. No third
  // one-line footer message.
  assert.equal(parts.length, 2)
  assert.ok(parts[0].html.includes('Turn finished'))
  assert.ok(parts[0].html.includes('Open DSH'))
  assert.ok(parts[0].html.includes('tokens'))
  assert.ok(parts[1].html.includes('Short answer.'))
  assert.ok(parts[1].keyboard, 'action buttons ride on the answer message')
})
