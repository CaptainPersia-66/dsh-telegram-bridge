/**
 * Unit tests for deliverable selection: which produced files are forwarded to
 * Telegram, which are skipped, and how they map onto Bot API methods.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_EXTENSIONS, describeSkippedMedia, planTurnMedia } from '../lib/media.js'

test('planTurnMedia forwards media/documents and ignores code files', () => {
  const turn = {
    attachments: [{ kind: 'image', name: 'shot.png', hostPath: 'C:\\tmp\\shot.png', bytes: 100 }],
    changes: {
      files: [
        { path: 'out/clip.mp4', display: 'out/clip.mp4' },
        { path: 'src/app.js', display: 'src/app.js' },
        { path: 'docs/report.pdf', display: 'docs/report.pdf' },
        { path: 'notes.xyz', display: 'notes.xyz' },
      ],
    },
  }
  const plan = planTurnMedia(turn, { cwd: 'C:\\work' })
  const names = plan.files.map((file) => file.name)
  assert.ok(names.includes('shot.png'))
  assert.ok(names.includes('clip.mp4'))
  assert.ok(names.includes('report.pdf'))
  assert.ok(!names.includes('app.js'))
  assert.ok(!names.includes('notes.xyz'))
  const clip = plan.files.find((file) => file.name === 'clip.mp4')
  assert.equal(clip.kind, 'video')
  assert.match(clip.path, /out[\\/]clip\.mp4$/)
  const image = plan.files.find((file) => file.name === 'shot.png')
  assert.equal(image.kind, 'image')
})

test('planTurnMedia deduplicates and respects an explicit extension map', () => {
  const turn = {
    attachments: [],
    changes: {
      files: [
        { path: 'clip.mp4', display: 'clip.mp4' },
        { path: 'clip.mp4', display: 'clip.mp4' },
        { path: 'manual.epub', display: 'manual.epub' },
      ],
    },
  }
  const plan = planTurnMedia(turn, { cwd: '/work', extensions: { epub: 'document', mp4: 'video' } })
  assert.equal(plan.files.filter((file) => file.name === 'clip.mp4').length, 1)
  assert.equal(plan.files.find((file) => file.name === 'manual.epub').kind, 'document')
  // An explicit map replaces the default allow-list.
  const only = planTurnMedia({ changes: { files: [{ path: 'a.png', display: 'a.png' }] } }, { cwd: '/w', extensions: { epub: 'document' } })
  assert.equal(only.files.length, 0)
})

test('attachments without a Host path are ignored; unsupported ones are reported', () => {
  const plan = planTurnMedia(
    {
      attachments: [
        { kind: 'image', name: 'browser-only.png', hostPath: null },
        { kind: 'file', name: 'clip.exe', hostPath: 'C:\\tmp\\clip.exe' },
      ],
      changes: null,
    },
    { cwd: 'C:\\work' },
  )
  assert.equal(plan.files.length, 0)
  assert.ok(plan.skipped.some((item) => item.name === 'clip.exe'))
})

test('the default allow-list covers common reviewable formats', () => {
  assert.equal(DEFAULT_EXTENSIONS.mp4, 'video')
  assert.equal(DEFAULT_EXTENSIONS.png, 'image')
  assert.equal(DEFAULT_EXTENSIONS.mp3, 'audio')
  assert.equal(DEFAULT_EXTENSIONS.pdf, 'document')
  assert.equal(DEFAULT_EXTENSIONS.js, undefined)
})

test('present deliverables are forwarded regardless of the allow-list', () => {
  const plan = planTurnMedia(
    {
      attachments: [],
      deliverables: [
        { path: 'C:\\out\\final.md', description: 'Runbook' },
        { path: 'C:\\out\\render.mov', description: null },
        { path: 'C:\\out\\final.md', description: 'duplicate' },
      ],
      changes: null,
    },
    { cwd: 'C:\\work' },
  )
  assert.deepEqual(plan.files.map((file) => file.name).sort(), ['final.md', 'render.mov'])
  assert.equal(plan.files.find((file) => file.name === 'final.md').kind, 'document')
  assert.equal(plan.files.find((file) => file.name === 'render.mov').kind, 'video')
  assert.equal(plan.files.find((file) => file.name === 'final.md').description, 'Runbook')
})

test('describeSkippedMedia summarizes at most three files', () => {
  assert.equal(describeSkippedMedia([]), '')
  const note = describeSkippedMedia([
    { name: 'a.mp4', reason: 'too-large (60 MB)' },
    { name: 'b.mp4', reason: 'send-failed' },
    { name: 'c.mp4', reason: 'send-failed' },
    { name: 'd.mp4', reason: 'send-failed' },
  ])
  assert.match(note, /a\.mp4/)
  assert.match(note, /\+1 more/)
})
