/**
 * Telegram voice-note transcription.
 *
 * Telegram delivers voice notes as OGG/Opus files that the Harness speech
 * recognizers do not accept directly, so the pipeline is:
 *
 *   Bot API getFile → download bytes → ffmpeg (16 kHz mono PCM16 WAV)
 *   → ctx.speechToText.resolve/prepare/transcribe → plain text
 *
 * Everything runs inside the Host process. Audio never leaves the machine: the
 * local SenseVoice provider is the default recognizer. Temp files live in the
 * OS temp directory and are removed even when transcription fails.
 *
 * @module telegram-bridge/voice
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Error raised for a voice-pipeline failure with a user-facing message. */
export class VoiceError extends Error {
  /**
   * @param {'disabled'|'unavailable'|'telegram-down'|'no-file'|'too-large'|'too-long'|'subprocess-unavailable'|'ffmpeg-missing'|'convert-failed'|'no-provider'|'prepare-failed'|'prepare-cancelled'|'prepare-timeout'|'transcribe-failed'|'empty'} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'VoiceError'
    this.code = code
  }
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Human-readable progress line for a transcription step.
 * @param {any} progress
 * @returns {string}
 */
export function describeVoiceProgress(progress) {
  switch (progress?.phase) {
    case 'downloading-audio':
      return '⬇️ Downloading voice message…'
    case 'converting':
      return '🎛️ Converting audio…'
    case 'preparing': {
      const preparation = progress.preparation ?? {}
      if (preparation.phase === 'downloading') {
        const done = Number(preparation.completedBytes ?? 0)
        const total = Number(preparation.totalBytes ?? 0)
        const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null
        const size = total > 0 ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(done)
        return `⬇️ Downloading voice model… ${percent === null ? size : `${percent}% (${size})`}`
      }
      if (preparation.phase === 'checking') return '🔎 Checking voice model files…'
      if (preparation.phase === 'loading') return '⚙️ Loading voice model…'
      if (preparation.phase === 'waking') return '⚡ Waking voice model…'
      return '⚙️ Preparing voice model…'
    }
    case 'ready':
      return '✅ Voice model ready'
    case 'transcribing':
      return '📝 Transcribing…'
    default:
      return '🎤 Processing voice message…'
  }
}

/** @param {number} ms @param {AbortSignal|undefined} signal */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** @param {string} filePath */
function extensionOf(filePath) {
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(String(filePath ?? ''))
  return match ? `.${match[1]}` : '.ogg'
}

/**
 * Wrap raw 16 kHz mono PCM16 samples in the byte-exact canonical WAV container
 * DSH speech recognizers validate. ffmpeg's WAV muxer is not used because it
 * inserts a `LIST/INFO` metadata chunk, which the recognizer rejects.
 *
 * @param {Uint8Array} pcm raw little-endian PCM16 samples
 * @returns {Uint8Array} RIFF/WAVE with a 44-byte header and one `data` chunk
 */
function canonicalWav(pcm) {
  const dataLength = pcm.byteLength - (pcm.byteLength % 2)
  const bytes = new Uint8Array(44 + dataLength)
  const view = new DataView(bytes.buffer)
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, 16000, true) // sample rate
  view.setUint32(28, 32000, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataLength, true)
  bytes.set(pcm.subarray(0, dataLength), 44)
  return bytes
}

/**
 * Start preparing a recognizer, then wait until it can serve a transcript.
 * Preparation happens once per model (cached under the DSH home), and its
 * download progress is surfaced to the chat.
 *
 * @param {any} stt
 * @param {string} providerId
 * @param {import('./config.js').ResolvedConfig} config
 * @param {(progress: any) => void} [onProgress]
 * @param {AbortSignal|undefined} signal
 */
async function ensurePrepared(stt, providerId, config, onProgress, signal) {
  const viewOf = () => {
    try {
      const snapshot = stt.snapshot()
      const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
      return providers.find((provider) => provider.id === providerId)
        ?? providers.find((provider) => provider.id === snapshot?.selection?.providerId)
    } catch {
      return undefined
    }
  }
  const current = viewOf()?.preparation?.phase
  if (current === 'ready' || current === 'standby') return
  try {
    stt.prepare(providerId)
  } catch (error) {
    throw new VoiceError('prepare-failed', `The voice model could not start preparing: ${error?.message ?? error}`, error)
  }
  const deadline = Date.now() + config.voice.prepareTimeoutMs
  let lastReport = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new VoiceError('prepare-cancelled', 'Voice transcription was cancelled.')
    const preparation = viewOf()?.preparation ?? { phase: 'checking' }
    if (preparation.phase === 'ready' || preparation.phase === 'standby') {
      onProgress?.({ phase: 'ready' })
      return
    }
    if (preparation.phase === 'failed') {
      throw new VoiceError(
        'prepare-failed',
        `The voice model could not be prepared: ${preparation.message ?? 'unknown error'}`,
      )
    }
    if (preparation.phase === 'cancelled') {
      throw new VoiceError('prepare-cancelled', 'Voice model preparation was cancelled.')
    }
    const now = Date.now()
    if (onProgress !== undefined && now - lastReport >= 1000) {
      lastReport = now
      onProgress({ phase: 'preparing', preparation })
    }
    await sleep(500, signal)
  }
  throw new VoiceError(
    'prepare-timeout',
    'The voice model is still downloading. Check your network, or open DSH Settings → Voice input to inspect preparation, then try again.',
  )
}

/**
 * Decode Telegram audio (OGG/Opus, M4A, MP4, …) into raw 16 kHz mono PCM16
 * samples. The WAV container is built in JS afterwards because ffmpeg's WAV
 * muxer adds a `LIST/INFO` chunk that the recognizer's canonical-WAV validator
 * rejects. Uses the Host subprocess service so the command follows the same
 * sandbox and lifecycle rules as other Host tools.
 *
 * @param {any} ctx
 * @param {import('./config.js').ResolvedConfig} config
 * @param {string} input absolute path
 * @param {string} output absolute path of the raw `.pcm` file
 * @param {AbortSignal|undefined} signal
 */
async function convertToPcm(ctx, config, input, output, signal) {
  const subprocess = ctx?.get?.('subprocess')
  if (!subprocess || typeof subprocess.spawn !== 'function' || typeof subprocess.resolveExecutable !== 'function') {
    throw new VoiceError('subprocess-unavailable', 'The Host subprocess service is unavailable, so audio cannot be converted.')
  }
  let executable = config.voice.ffmpegPath
  if (!executable) {
    try {
      executable = await subprocess.resolveExecutable('ffmpeg', undefined, signal)
    } catch {
      executable = null
    }
  }
  if (!executable) {
    throw new VoiceError('ffmpeg-missing', 'ffmpeg was not found on the Host PATH. Install ffmpeg to transcribe voice messages.')
  }
  let handle
  try {
    handle = subprocess.spawn({
      argv: [
        executable,
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-acodec',
        'pcm_s16le',
        '-f',
        's16le',
        output,
      ],
      cwd: tmpdir(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 5000,
      signal,
    })
  } catch (error) {
    throw new VoiceError('convert-failed', `ffmpeg could not be started: ${error?.message ?? error}`, error)
  }
  const outcome = await handle.done
  if (outcome?.exitCode !== 0) {
    let stderr = ''
    try {
      stderr = handle.collected?.stderr?.readFrom?.(0)?.text ?? ''
    } catch {
      stderr = ''
    }
    const detail = stderr.trim() === '' ? '' : `: ${stderr.trim().slice(0, 300)}`
    throw new VoiceError('convert-failed', `ffmpeg could not decode the voice message${detail}`)
  }
}

/**
 * @param {any} stt
 * @param {Uint8Array} wav
 * @param {import('./config.js').ResolvedConfig} config
 */
function resolveSpec(stt, wav, config) {
  /** @type {{audio: Uint8Array, language?: string}} */
  const request = { audio: wav }
  if (config.voice.language) request.language = config.voice.language
  try {
    return stt.resolve(request)
  } catch (error) {
    throw new VoiceError(
      'no-provider',
      `No speech recognizer is available: ${error?.message ?? error}. Enable DSH Settings → Voice input and prepare the local model.`,
      error,
    )
  }
}

/**
 * @param {object} deps
 * @param {any} deps.ctx Host context (reads `speechToText` and `subprocess`)
 * @param {import('./config.js').ResolvedConfig} deps.config
 * @param {{ warn?: Function, info?: Function }} deps.log
 * @param {() => any} deps.apiProvider
 */
export function createVoice(deps) {
  const { ctx, config, log } = deps

  /**
   * Transcribe one Telegram voice/audio/video-note message.
   *
   * @param {{ file_id?: string, duration?: number, mime_type?: string, file_size?: number }} voice
   * @param {{ onProgress?: (progress: any) => void, signal?: AbortSignal }} [options]
   * @returns {Promise<{ text: string, audioSeconds: number, inferenceSeconds: number, providerId: string }>}
   */
  async function transcribeVoice(voice, options = {}) {
    const { onProgress, signal } = options
    if (!config.voice.enabled) {
      throw new VoiceError('disabled', 'Voice transcription is disabled by configuration (voice.enabled = false).')
    }
    const stt = ctx?.get?.('speechToText')
    if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') {
      throw new VoiceError(
        'unavailable',
        'Voice input is not available in this DSH profile. Enable the Voice Input bundle in Settings → Plugins (then restart DSH) and try again.',
      )
    }
    const client = deps.apiProvider()
    if (!client) {
      throw new VoiceError('telegram-down', 'The Telegram connection is not ready yet.')
    }
    const fileId = typeof voice?.file_id === 'string' ? voice.file_id : ''
    if (fileId === '') throw new VoiceError('no-file', 'That message did not include a downloadable audio file.')
    const duration = Number(voice?.duration)
    if (Number.isFinite(duration) && duration > config.voice.maxDurationSeconds) {
      throw new VoiceError(
        'too-long',
        `The voice message is ${Math.round(duration)}s long; the limit is ${config.voice.maxDurationSeconds}s.`,
      )
    }

    onProgress?.({ phase: 'downloading-audio' })
    let file
    try {
      file = await client.getFile(fileId, { signal })
    } catch (error) {
      throw new VoiceError('telegram-down', `Telegram could not resolve the voice file (${error?.message ?? error}).`, error)
    }
    if (!file || typeof file.file_path !== 'string' || file.file_path === '') {
      throw new VoiceError('no-file', 'Telegram did not return a download path for that voice message.')
    }
    if (Number(file.file_size) > config.voice.maxDownloadBytes) {
      throw new VoiceError('too-large', `That voice file is too large (${formatBytes(file.file_size)}).`)
    }
    let audio
    try {
      audio = await client.downloadFile(file.file_path, { maxBytes: config.voice.maxDownloadBytes, signal })
    } catch (error) {
      throw new VoiceError('telegram-down', `The voice file could not be downloaded (${error?.message ?? error}).`, error)
    }

    const work = await mkdtemp(join(tmpdir(), 'dsh-telegram-voice-'))
    try {
      const input = join(work, `voice${extensionOf(file.file_path)}`)
      const output = join(work, 'voice.pcm')
      await writeFile(input, audio)
      onProgress?.({ phase: 'converting' })
      await convertToPcm(ctx, config, input, output, signal)
      const pcm = new Uint8Array(await readFile(output))
      if (pcm.byteLength < 2) throw new VoiceError('convert-failed', 'The converted audio is empty.')
      const wav = canonicalWav(pcm)
      if (wav.byteLength > config.voice.maxWavBytes) {
        const maxSeconds = Math.floor((config.voice.maxWavBytes - 44) / 32000)
        throw new VoiceError('too-long', `That voice message is too long for the local recognizer (about ${maxSeconds}s max).`)
      }
      const spec = resolveSpec(stt, wav, config)
      const providerId = String(spec?.provider?.info?.id ?? '')
      await ensurePrepared(stt, providerId, config, onProgress, signal)
      onProgress?.({ phase: 'transcribing' })
      let transcript
      try {
        transcript = await stt.transcribe(spec, signal)
      } catch (error) {
        throw new VoiceError('transcribe-failed', `Transcription failed: ${error?.message ?? error}`, error)
      }
      const text = String(transcript?.text ?? '').trim()
      if (text === '') {
        throw new VoiceError('empty', 'I could not make out any speech in that voice message. Try again closer to the microphone.')
      }
      return {
        text,
        audioSeconds: Number(transcript?.audioSeconds ?? duration ?? 0),
        inferenceSeconds: Number(transcript?.inferenceSeconds ?? 0),
        providerId,
      }
    } finally {
      await rm(work, { recursive: true, force: true }).catch((error) => {
        log?.warn?.(`telegram-bridge: voice temp cleanup failed (${error?.message ?? error})`)
      })
    }
  }

  return { transcribeVoice }
}
