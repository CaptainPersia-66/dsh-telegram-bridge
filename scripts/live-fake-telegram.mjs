/**
 * Standalone fake Telegram Bot API used for a live Host smoke test.
 *
 * Usage: node scripts/live-fake-telegram.mjs <output-dir> [port]
 *
 * - `getUpdates` reads and consumes `<output-dir>/updates.json` (an array of
 *   Update objects), waiting briefly for the file to appear.
 * - Every other call is appended to `<output-dir>/calls.jsonl`.
 * - A `ready` file with the base URL is written once the server listens.
 *
 * Not part of the plugin runtime. Tests import the in-process fake instead;
 * this file exists so the Lead can point a *real* DSH Host at a local Bot API
 * without a real bot token.
 */

import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputDirectory = process.argv[2]
const port = Number(process.argv[3] ?? 18765)
if (!outputDirectory) {
  console.error('usage: node live-fake-telegram.mjs <output-dir> [port]')
  process.exit(2)
}
const token = process.env.LIVE_FAKE_TOKEN ?? '123456:LIVE-SMOKE-TOKEN-abcdefghijklmnopqrstuvwxyz'
await mkdir(outputDirectory, { recursive: true })
const updatesPath = join(outputDirectory, 'updates.json')
const callsPath = join(outputDirectory, 'calls.jsonl')

/** @param {unknown} body */
function send(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  response.end(text)
}

let nextMessageId = 500
let pendingUpdateReads = Promise.resolve()

/** @returns {Promise<any[]>} */
async function takeUpdates() {
  // Serialize reads so two concurrent long polls cannot deliver the same update twice.
  const previous = pendingUpdateReads
  let release
  pendingUpdateReads = new Promise((resolve) => {
    release = resolve
  })
  await previous
  try {
    let text
    try {
      text = await readFile(updatesPath, 'utf8')
    } catch {
      return []
    }
    await rename(updatesPath, `${updatesPath}.consumed`).catch(() => {})
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  } finally {
    release()
  }
}

/** @param {string} method @param {any} params */
async function handle(method, params) {
  switch (method) {
    case 'getMe':
      await writeFile(callsPath, `${JSON.stringify({ at: Date.now(), method, params })}\n`, { flag: 'a' })
      return { id: 123456789, is_bot: true, first_name: 'Live Smoke', username: 'live_smoke_bot' }
    case 'getUpdates': {
      const timeoutSeconds = Math.min(Number(params.timeout ?? 0), 2)
      const deadline = Date.now() + Math.min(timeoutSeconds * 1000, 400)
      while (Date.now() < deadline) {
        const updates = await takeUpdates()
        if (updates.length > 0) return updates
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return []
    }
    case 'sendMessage': {
      const messageId = nextMessageId
      nextMessageId += 1
      await writeFile(callsPath, `${JSON.stringify({ at: Date.now(), method, params: { ...params, messageId } })}\n`, { flag: 'a' })
      return { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: params.chat_id, type: 'private' }, text: params.text }
    }
    default:
      await writeFile(callsPath, `${JSON.stringify({ at: Date.now(), method, params })}\n`, { flag: 'a' })
      return true
  }
}

const server = createServer((request, response) => {
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    raw += chunk
  })
  request.on('end', () => {
    void (async () => {
      const path = (request.url ?? '').split('?')[0]
      const match = /^\/bot([^/]+)\/([A-Za-z0-9_]+)$/.exec(path)
      if (!match) return send(response, 404, { ok: false, error_code: 404, description: 'Not Found' })
      if (match[1] !== token) return send(response, 401, { ok: false, error_code: 401, description: 'Unauthorized' })
      let params = {}
      try {
        if (raw.trim() !== '') {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed
        }
      } catch {
        return send(response, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid JSON' })
      }
      try {
        const result = await handle(match[2], params)
        send(response, 200, { ok: true, result })
      } catch (error) {
        send(response, 500, { ok: false, error_code: 500, description: String(error?.message ?? error) })
      }
    })()
  })
})

server.listen(port, '127.0.0.1', async () => {
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  await writeFile(join(outputDirectory, 'ready.json'), JSON.stringify({ baseUrl, token, pid: process.pid }), 'utf8')
  console.log(`live-fake-telegram listening at ${baseUrl}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
