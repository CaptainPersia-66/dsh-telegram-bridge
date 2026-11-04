/**
 * Transcode oversized video/audio deliverables into a copy small enough for the
 * Telegram Bot API's ~50 MB upload ceiling. Uses the Host subprocess service and
 * ffmpeg (the same executable resolution as voice transcription).
 *
 * The compressor tries progressively cheaper renditions and stops at the first
 * output that fits; the original file is never modified.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

const VIDEO_ATTEMPTS = [
  { label: '1080p', args: ['-vf', 'scale=-2:1080:force_original_aspect_ratio=decrease,crop=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'] },
  { label: '720p', args: ['-vf', 'scale=-2:720:force_original_aspect_ratio=decrease,crop=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30'] },
  { label: '480p', args: ['-vf', 'scale=-2:480:force_original_aspect_ratio=decrease,crop=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32'] },
]

/**
 * @param {any} subprocess Host subprocess service
 * @param {string[]} argv
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function runFfmpeg(subprocess, argv, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let handle
  try {
    handle = subprocess.spawn({
      argv,
      cwd: tmpdir(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 65536 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 5000,
      signal: combined,
    })
  } catch {
    return false
  }
  try {
    const outcome = await handle.done
    return outcome?.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Build a compressor bound to one Host context and plugin config.
 *
 * @param {{ ctx: any, config: import('./config.js').ResolvedConfig, log?: any }} deps
 * @returns {(request: { path: string, name: string, kind: 'video' | 'audio', maxBytes: number,
 *           signal?: AbortSignal }) => Promise<{ bytes: Uint8Array, filename: string,
 *           mimeType: string } | null>}
 */
export function createMediaCompressor({ ctx, config, log }) {
  return async function compress(request) {
    const { path, name, kind, maxBytes, signal } = request
    if (!config.deliverables.compression.enabled) return null
    if (finitePositive(maxBytes) === null) return null

    const subprocess = ctx?.get?.('subprocess')
    if (!subprocess || typeof subprocess.spawn !== 'function' || typeof subprocess.resolveExecutable !== 'function') {
      log?.warn?.('telegram-bridge: subprocess service unavailable; cannot compress oversized media')
      return null
    }
    let ffmpeg = config.voice.ffmpegPath
    if (!ffmpeg) {
      try {
        ffmpeg = await subprocess.resolveExecutable('ffmpeg', undefined, signal)
      } catch {
        ffmpeg = null
      }
    }
    if (!ffmpeg) {
      log?.warn?.('telegram-bridge: ffmpeg was not found; oversized media cannot be compressed')
      return null
    }

    const workDir = await mkdtemp(join(tmpdir(), 'dsh-tg-compress-'))
    const baseName = basename(name, extname(name)) || 'media'
    const attempts = kind === 'audio'
      ? [{ label: 'audio', args: ['-vn', '-c:a', 'aac', '-b:a', '128k'], ext: '.m4a', mimeType: 'audio/mp4' }]
      : VIDEO_ATTEMPTS.map((attempt) => ({
        ...attempt,
        args: [...attempt.args, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
        ext: '.mp4',
        mimeType: 'video/mp4',
      }))
    try {
      for (const attempt of attempts) {
        const output = join(workDir, `${baseName}-compressed-${attempt.label}${attempt.ext}`)
        const argv = [
          ffmpeg,
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          path,
          ...attempt.args,
          '-f',
          'mp4',
          output,
        ]
        const ok = await runFfmpeg(subprocess, argv, signal, config.deliverables.compression.timeoutMs)
        if (!ok) continue
        const info = await stat(output).catch(() => null)
        if (!info || !info.isFile() || info.size === 0 || info.size > maxBytes) {
          await rm(output, { force: true }).catch(() => {})
          continue
        }
        const bytes = new Uint8Array(await readFile(output))
        return {
          bytes,
          filename: `${baseName}-compressed${attempt.ext}`,
          mimeType: attempt.mimeType,
        }
      }
      return null
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** @param {unknown} value */
function finitePositive(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
