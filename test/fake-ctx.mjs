/**
 * Fake DeepSeek-Harness Host context for end-to-end plugin tests.
 *
 * Implements only the slice the bridge touches: `ctx.get()` service lookup,
 * Cordis-style `ctx.on` / `ctx.effect` / `ctx.logger`, the session-controller
 * contract, title snapshots, workspace-change summaries, and a waterfall
 * dispatcher for `approval/request` and `user-questions/request`. Events are
 * emitted explicitly by tests so a whole interaction can be driven without a
 * real model, session log, or desktop client.
 */

import { readFile, writeFile } from 'node:fs/promises'

/**
 * Mirrors the DSH recognizer's canonical-WAV validation so the fake rejects a
 * wrong container exactly like the real provider does.
 * @param {Uint8Array} audio
 * @returns {boolean}
 */
function isCanonicalWav(audio) {
  if (!(audio instanceof Uint8Array)) return false
  const bytes = Buffer.from(audio)
  if (bytes.length < 46) return false
  return (
    bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WAVE'
    && bytes.toString('ascii', 12, 16) === 'fmt '
    && bytes.readUInt32LE(16) === 16
    && bytes.readUInt16LE(20) === 1
    && bytes.readUInt16LE(22) === 1
    && bytes.readUInt32LE(24) === 16000
    && bytes.readUInt32LE(28) === 32000
    && bytes.readUInt16LE(32) === 2
    && bytes.readUInt16LE(34) === 16
    && bytes.toString('ascii', 36, 40) === 'data'
    && bytes.readUInt32LE(4) === bytes.length - 8
    && bytes.readUInt32LE(40) === bytes.length - 44
    && (bytes.length - 44) % 2 === 0
  )
}

/** @param {number} seq @param {string} type @param {any} data */
export function sessionEvent(seq, type, data) {
  return { type, seq, time: Date.now(), data, surfaceOp: 'append' }
}

/** @param {number} seq @param {number} turn */
export function turnStart(seq, turn) {
  return sessionEvent(seq, 'turn/start', { turn })
}

/** @param {number} seq @param {number} turn @param {string} reason */
export function turnEnd(seq, turn, reason = 'completed') {
  return sessionEvent(seq, 'turn/end', { turn, reason: { kind: reason } })
}

/** @param {number} seq @param {number} turn @param {number} step @param {string} text */
export function assistantMessage(seq, turn, step, text, usage) {
  return sessionEvent(seq, 'assistant/message', {
    turn,
    step,
    message: { id: `msg-${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fake', model: 'fake-model' } },
    stream: [],
    ...(usage ? { usage } : {}),
  })
}

/** @param {number} seq @param {number} turn @param {number} step @param {string} text */
export function userMessage(seq, turn, step, text) {
  return sessionEvent(seq, 'user/message', {
    id: `msg-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    turn,
    step,
  })
}

/** @param {number} seq @param {number} turn @param {number} step @param {{ callId: string, name: string, args: string }} call */
export function toolCall(seq, turn, step, call) {
  return sessionEvent(seq, 'tool/call', { turn, step, callId: call.callId, name: call.name, arguments: call.args })
}

/** @param {number} seq @param {number} turn @param {number} step @param {{ callId: string, text: string, isError?: boolean }} result */
export function toolResult(seq, turn, step, result) {
  return sessionEvent(seq, 'tool/result', {
    turn,
    step,
    message: {
      id: `msg-${seq}`,
      role: 'tool',
      content: [{ type: 'text', text: result.text }],
      source: { kind: 'tool', callId: result.callId },
      toolCallId: result.callId,
      ...(result.isError ? { isError: true } : {}),
    },
  })
}

/** @param {number} seq @param {number} turn */
export function workspaceChanges(seq, turn) {
  return sessionEvent(seq, 'workspace/changes', { turn })
}

/**
 * @param {object} [options]
 * @param {boolean} [options.liveClient]
 */
export function createFakeHost(options = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const disposers = []
  /** @type {Array<{ level: string, text: string }>} */
  const logs = []
  /** @type {any[]} */
  const prompts = []
  /** @type {any[]} */
  const cancels = []
  /** @type {any[]} */
  const creates = []
  /** @type {any[]} */
  const renames = []
  /** @type {Map<string, any>} */
  const sessions = new Map()
  /** @type {Map<string, any>} */
  const workspaceSummaries = new Map()
  /** @type {string[]} registry-global archived session ids */
  const archivedSessionIds = []
  let liveClient = options.liveClient ?? false
  let sessionCounter = 0

  const logger = {
    info: (...args) => logs.push({ level: 'info', text: args.map(String).join(' ') }),
    warn: (...args) => logs.push({ level: 'warn', text: args.map(String).join(' ') }),
    error: (...args) => logs.push({ level: 'error', text: args.map(String).join(' ') }),
    debug: (...args) => logs.push({ level: 'debug', text: args.map(String).join(' ') }),
  }

  function recordOf(sessionId) {
    const record = sessions.get(String(sessionId))
    if (!record) throw new Error(`session ${sessionId} not found`)
    return record
  }

  function summaryOf(record) {
    return {
      agentAvailable: true,
      sessionId: record.id,
      updatedAt: record.updatedAt,
      running: Boolean(record.running),
      blank: record.events.length === 0,
      cwd: record.cwd,
      ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
    }
  }

  function handleFor(sessionId) {
    const record = recordOf(sessionId)
    return { id: record.id, header: { id: record.id, cwd: record.cwd, ...(record.origin ? { origin: record.origin } : {}) }, session: record.handle }
  }

  const services = {
    sessionController: {
      async list() {
        return {
          items: [...sessions.values()]
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(summaryOf),
        }
      },
      async projections({ sessionId }) {
        const record = recordOf(sessionId)
        const asOfSeq = record.events.length > 0 ? record.events[record.events.length - 1].seq : -1
        return { kind: 'sequenced', asOfSeq, values: record.projections ?? {} }
      },
      async inspect(sessionId) {
        const record = recordOf(sessionId)
        return {
          meta: { id: record.id, cwd: record.cwd, isSeeded: false, origin: record.origin, parentSession: record.parentSessionId },
          inheritedEventCount: 0,
          events: record.events.map((event) => structuredClone(event)),
        }
      },
      async prompt(request) {
        prompts.push(structuredClone(request))
        return { accepted: true }
      },
      cancel(request) {
        cancels.push(structuredClone(request))
        return { accepted: true }
      },
      async create(request = {}) {
        creates.push(structuredClone(request))
        sessionCounter += 1
        const id = `session-fake-${sessionCounter}`
        sessions.set(id, {
          id,
          title: request.cwd ? `New (${request.cwd})` : 'New session',
          cwd: request.cwd ?? 'C:\\fake\\workspace',
          updatedAt: Date.now(),
          running: false,
          events: [],
          projections: { title: 'New session' },
        })
        return { sessionId: id }
      },
      async rename({ sessionId, title }) {
        const record = recordOf(sessionId)
        record.title = title
        record.projections = { ...(record.projections ?? {}), title }
        renames.push({ sessionId, title })
        return { title, seq: 0 }
      },
    },
    sessionQuery: {
      async readTitleSnapshots(sessionIds) {
        return sessionIds.map((sessionId) => {
          const record = sessions.get(String(sessionId))
          if (!record) return { sessionId, status: 'rejected', reason: new Error('not found') }
          return {
            sessionId,
            status: 'fulfilled',
            value: {
              session: { id: record.id, cwd: record.cwd },
              ...(record.title ? { title: { title: record.title, eventSeq: 0, updatedAt: record.updatedAt, messageSeqs: [], source: { kind: 'user' } } } : {}),
            },
          }
        })
      },
    },
    workspaceChanges: {
      summary(sessionId, seq) {
        return workspaceSummaries.get(`${sessionId}:${seq}`)
      },
      async diff() {
        return undefined
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() {
        return [...archivedSessionIds]
      },
    },
    typertGateway: {
      hasLiveClient() {
        return liveClient
      },
    },
    webApp: {
      getAdvertisedUrl() {
        return 'http://127.0.0.1:12345'
      },
    },
    credentials: {
      async resolve() {
        return undefined
      },
    },
    systemPrompt: {
      sections: [],
      section(section) {
        this.sections.push(section)
        return () => {}
      },
    },
  }

  if (options.voice) {
    const voiceTranscript = typeof options.voice.transcript === 'string' ? options.voice.transcript : 'hello from voice'
    let voicePhase = typeof options.voice.phase === 'string' ? options.voice.phase : 'ready'
    const provider = {
      info: { id: 'sensevoice-local', name: 'SenseVoice Small', location: 'host-local', languages: ['auto', 'en', 'zh'] },
      async transcribe() {
        return {
          text: voiceTranscript,
          audioSeconds: Number(options.voice.audioSeconds ?? 2),
          inferenceSeconds: Number(options.voice.inferenceSeconds ?? 0.1),
        }
      },
    }
    services.speechToText = {
      snapshot() {
        return {
          providers: [{ ...provider.info, preparation: { phase: voicePhase } }],
          selection: { providerId: 'sensevoice-local', language: 'auto' },
        }
      },
      resolve(request) {
        const audio = request.audio instanceof Uint8Array ? request.audio : new Uint8Array(request.audio ?? [])
        if (!isCanonicalWav(audio)) throw new Error('Invalid speech WAV')
        return { audio, language: 'auto', provider }
      },
      prepare() {
        voicePhase = 'ready'
      },
      async transcribe(spec) {
        if (voicePhase !== 'ready' && voicePhase !== 'standby') throw new Error('voice model is not ready')
        return spec.provider.transcribe()
      },
    }
    // Test double for the Host subprocess: "ffmpeg" copies its input verbatim.
    services.subprocess = {
      async resolveExecutable(command) {
        if (command === 'ffmpeg') return 'ffmpeg'
        throw new Error(`executable not found: ${command}`)
      },
      spawn(spec) {
        const argv = Array.isArray(spec?.argv) ? spec.argv : []
        const inputIndex = argv.indexOf('-i')
        const input = inputIndex >= 0 ? argv[inputIndex + 1] : null
        const output = argv.length > 0 ? argv[argv.length - 1] : null
        const done = (async () => {
          if (!input || !output) return { exitCode: 1 }
          const bytes = await readFile(input)
          await writeFile(output, bytes)
          return { exitCode: 0 }
        })()
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: '' }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    }
  }

  /** @param {string} event @param {Function} handler */
  function on(event, handler) {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    return () => {
      const current = listeners.get(event) ?? []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  }

  /** @param {() => any} factory */
  function effect(factory) {
    const disposer = factory()
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  }

  /** @param {string} event @param {...any} args */
  function emit(event, ...args) {
    for (const handler of [...(listeners.get(event) ?? [])]) {
      try {
        handler(...args)
      } catch {
        // Test drivers treat a throwing listener as the listener's problem.
      }
    }
  }

  /**
   * Dispatch a Cordis waterfall: each listener receives (payload, next) and may
   * claim the request by returning a value, or delegate by calling next().
   * @param {string} event
   * @param {any} payload
   * @param {() => Promise<any>} fallback
   */
  async function waterfall(event, payload, fallback) {
    const chain = [...(listeners.get(event) ?? [])]
    let index = 0
    const next = async () => {
      if (index >= chain.length) return fallback()
      const handler = chain[index]
      index += 1
      return handler(payload, next)
    }
    return next()
  }

  const ctx = { logger, get: (serviceName) => services[serviceName], on, effect, emit, waterfall }
  // Some plugins read services as context properties; keep both access styles working.
  for (const [serviceName, serviceValue] of Object.entries(services)) ctx[serviceName] = serviceValue

  /** @param {any} record */
  function addSession(record) {
    const id = String(record.id ?? `session-fake-${(sessionCounter += 1)}`)
    const stored = {
      id,
      title: record.title ?? null,
      cwd: record.cwd ?? 'C:\\fake\\workspace',
      updatedAt: record.updatedAt ?? Date.now(),
      running: Boolean(record.running),
      origin: record.origin,
      parentSessionId: record.parentSessionId,
      events: (record.events ?? []).map((event) => structuredClone(event)),
      projections: record.projections ?? {},
    }
    stored.handle = { id, header: { id, cwd: stored.cwd, isSeeded: false } }
    sessions.set(id, stored)
    return stored
  }

  /**
   * Append a live session event and notify listeners.
   * @param {string} sessionId
   * @param {any} event
   */
  function pushSessionEvent(sessionId, event) {
    const record = recordOf(sessionId)
    record.events.push(structuredClone(event))
    record.updatedAt = Date.now()
    emit('session/event', record.handle, event)
  }

  /** @param {string} sessionId @param {number} seq @param {any} summary */
  function setWorkspaceSummary(sessionId, seq, summary) {
    workspaceSummaries.set(`${sessionId}:${seq}`, summary)
  }

  /** @param {string[]} sessionIds */
  function setArchivedSessionIds(sessionIds) {
    archivedSessionIds.length = 0
    for (const sessionId of sessionIds) archivedSessionIds.push(String(sessionId))
  }

  async function dispose() {
    for (const disposer of disposers.reverse()) {
      try {
        await disposer()
      } catch {
        // teardown failures are reported by the plugin's own logger
      }
    }
    disposers.length = 0
    listeners.clear()
  }

  return {
    ctx,
    services,
    logs,
    prompts,
    cancels,
    creates,
    renames,
    sessions,
    promptSections: services.systemPrompt.sections,
    addSession,
    pushSessionEvent,
    setWorkspaceSummary,
    setArchivedSessionIds,
    waterfall,
    emit,
    dispose,
    setLiveClient(value) {
      liveClient = Boolean(value)
    },
  }
}

/**
 * Poll a predicate until it is truthy.
 * @param {() => any} predicate
 * @param {{ timeoutMs?: number, label?: string, intervalMs?: number }} [options]
 */
export async function waitUntil(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000
  const intervalMs = options.intervalMs ?? 10
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate()
      if (value) return value
      lastError = null
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.label ?? 'condition'}${lastError ? `: ${lastError.message}` : ''}`)
}
