import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { generateId } from '@/lib/utils'
import type {
  nonstandard as WrtcNonstandard,
  RTCPeerConnection as WrtcPeerConnection,
} from '@roamhq/wrtc'

const execFileAsync = promisify(execFile)

const BOT_PEER_PREFIX = 'friday-voice-bot-'
const TURN_SILENCE_MS = 2000
const TURN_MIN_MS = 500
const TURN_MAX_MS = 18_000
const PRE_ROLL_FRAMES = 22
const VAD_START_RMS = 0.015
const VAD_HOLD_RMS = 0.008
const MAX_CHAT_HISTORY = 250
const PLAYBACK_SAMPLE_RATE = 48_000
const PLAYBACK_FRAME_MS = 10
const MAX_PENDING_SERVER_CANDIDATES = 80

type SignalEvent = {
  type: 'offer' | 'answer' | 'candidate' | 'bye' | 'chat' | 'system' | 'assistant'
  from: string
  to?: string
  roomId: string
  payload?: unknown
  at: string
}

type ChatEntry = {
  role: 'user' | 'assistant' | 'system'
  message: string
  timestamp: string
}

type AssistantTurnPayload = {
  turnId: string
  userEntry: ChatEntry
  reply: ChatEntry
  audioBase64: string | null
  audioMimeType: string | null
}

type AudioFrameLike = {
  samples: Int16Array
  sampleRate: number
  channelCount?: number
}

type TurnSegment = {
  samples: Int16Array
  sampleRate: number
}

type PlaybackItem = {
  samples: Int16Array
  sampleRate: number
  cursor: number
}

type VadState = {
  inSpeech: boolean
  lastVoiceAt: number
  utteranceStartedAt: number
  utteranceSampleRate: number
  utteranceSamples: number
  utteranceFrames: Int16Array[]
  preRollFrames: Int16Array[]
}

type ServerCallSession = {
  roomId: string
  userPeerId: string
  botPeerId: string
  pc: WrtcPeerConnection
  sink: WrtcNonstandard.RTCAudioSink | null
  source: WrtcNonstandard.RTCAudioSource
  sourceTrack: MediaStreamTrack
  vad: VadState
  turnQueue: TurnSegment[]
  processingTurn: boolean
  lastTranscript: string
  lastTranscriptAt: number
  playbackQueue: PlaybackItem[]
  playbackTimer: NodeJS.Timeout | null
}

type WrtcRuntime = {
  RTCPeerConnection: new (
    ...args: ConstructorParameters<typeof WrtcPeerConnection>
  ) => WrtcPeerConnection
  nonstandard: {
    RTCAudioSink: new (track: MediaStreamTrack) => WrtcNonstandard.RTCAudioSink
    RTCAudioSource: new () => WrtcNonstandard.RTCAudioSource
  }
}

const subscribers = new Map<string, Set<ReadableStreamDefaultController<string>>>()
const roomChat = new Map<string, ChatEntry[]>()
const serverSessions = new Map<string, ServerCallSession>()
const pendingServerCandidates = new Map<string, RTCIceCandidateInit[]>()
let wrtcLoadPromise: Promise<WrtcRuntime | null> | null = null

function roomPeerKey(roomId: string, peerId: string) {
  return `${roomId}::${peerId}`
}

function subscriberKey(peerId: string, roomId: string) {
  return `${roomId}::${peerId}`
}

function emit(peerId: string, roomId: string, event: SignalEvent) {
  const sinks = subscribers.get(subscriberKey(peerId, roomId))
  if (!sinks?.size) return

  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const sink of sinks) {
    try {
      sink.enqueue(line)
    } catch {
      // ignore dead stream
    }
  }
}

function emitSystem(peerId: string, roomId: string, message: string) {
  emit(peerId, roomId, {
    type: 'system',
    from: 'server',
    to: peerId,
    roomId,
    at: new Date().toISOString(),
    payload: { message },
  })
}

export function createSignalEventStream(peerId: string, roomId: string) {
  const key = subscriberKey(peerId, roomId)
  let controllerRef: ReadableStreamDefaultController<string> | null = null

  return new ReadableStream<string>({
    start(controller) {
      controllerRef = controller
      const set = subscribers.get(key) ?? new Set<ReadableStreamDefaultController<string>>()
      set.add(controller)
      subscribers.set(key, set)

      controller.enqueue(`event: ready\ndata: ${JSON.stringify({ peerId, roomId })}\n\n`)
      emitSystem(peerId, roomId, 'signaling_connected')
    },
    cancel() {
      const set = subscribers.get(key)
      if (!set) return
      if (controllerRef) {
        set.delete(controllerRef)
      }
      if (!set.size) {
        subscribers.delete(key)
      }
    },
  })
}

function isServerBotPeer(peerId: string) {
  return peerId.startsWith(BOT_PEER_PREFIX)
}

function asSessionDescription(payload: unknown): RTCSessionDescriptionInit | null {
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as { type?: unknown; sdp?: unknown }
  if (typeof candidate.type !== 'string' || typeof candidate.sdp !== 'string') return null
  if (candidate.type !== 'offer' && candidate.type !== 'answer' && candidate.type !== 'pranswer') {
    return null
  }
  return {
    type: candidate.type,
    sdp: candidate.sdp,
  }
}

function asIceCandidate(payload: unknown): RTCIceCandidateInit | null {
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as RTCIceCandidateInit
  if (typeof candidate.candidate !== 'string') return null
  return candidate
}

function createWavFromPcm16Mono(samples: Int16Array, sampleRate: number) {
  const byteLength = samples.length * 2
  const out = Buffer.allocUnsafe(44 + byteLength)

  out.write('RIFF', 0)
  out.writeUInt32LE(36 + byteLength, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(byteLength, 40)

  const view = new DataView(out.buffer, out.byteOffset + 44, byteLength)
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true)
  }

  return out
}

function concatInt16(frames: Int16Array[]) {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

function downmixToMono(samples: Int16Array, channelCount: number) {
  if (channelCount <= 1) {
    return Int16Array.from(samples)
  }

  const frameCount = Math.floor(samples.length / channelCount)
  const mono = new Int16Array(frameCount)
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    let sum = 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      sum += samples[frameIndex * channelCount + channel] ?? 0
    }
    mono[frameIndex] = Math.max(-32768, Math.min(32767, Math.round(sum / channelCount)))
  }
  return mono
}

function rmsLevel(samples: Int16Array) {
  if (!samples.length) return 0
  let sumSquares = 0
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = (samples[index] ?? 0) / 32768
    sumSquares += normalized * normalized
  }
  return Math.sqrt(sumSquares / samples.length)
}

function safeBufferFromBase64(base64: string) {
  try {
    return Buffer.from(base64, 'base64')
  } catch {
    return null
  }
}

async function loadWrtc() {
  if (!wrtcLoadPromise) {
    wrtcLoadPromise = (async () => {
      try {
        console.log('[webrtc] attempting primary wrtc load')
        // Use a dynamic import that Vite won't try to bundle as an absolute path
        const m = await import('@roamhq/wrtc')
        const wrtc = (m.default ?? m) as any
        if (wrtc.RTCPeerConnection) {
          console.log('[webrtc] primary wrtc load success')
          return wrtc as WrtcRuntime
        }
        throw new Error('primary load yielded invalid object')
      } catch (e: any) {
        console.warn('[webrtc] wrtc load failed:', e.message)
      }
      return null
    })()
  }
  return wrtcLoadPromise
}

async function executableExists(bin: string) {
  if (!bin.trim()) return false
  if (bin.includes('/')) {
    try {
      await fs.access(bin)
      return true
    } catch {
      return false
    }
  }
  try {
    await execFileAsync('which', [bin], { timeout: 3_000 })
    return true
  } catch {
    return false
  }
}

async function verifyVoiceTooling(session: ServerCallSession) {
  const sttBin = process.env.FRIDAY_STT_BIN ?? path.join(process.cwd(), 'jarvis-stt')
  const ttsBin = process.env.FRIDAY_TTS_BIN ?? path.join(process.cwd(), 'jarvis-tts')
  const ffmpegBin = process.env.FRIDAY_FFMPEG_BIN ?? 'ffmpeg'
  const apiKey = process.env.FRIDAY_LLM_API_KEY ?? process.env.OPENAI_API_KEY

  const [sttReady, ttsReady, ffmpegReady] = await Promise.all([
    executableExists(sttBin),
    executableExists(ttsBin),
    executableExists(ffmpegBin),
  ])

  if (!sttReady && !apiKey) {
    emitSystem(session.userPeerId, session.roomId, 'stt_binary_missing')
  }
  if (!ttsReady && !apiKey) {
    emitSystem(session.userPeerId, session.roomId, 'tts_binary_missing')
  }
  if (!ffmpegReady) {
    emitSystem(session.userPeerId, session.roomId, 'ffmpeg_missing')
  }
}

function pushVadFrame(vad: VadState, frame: Int16Array) {
  vad.preRollFrames.push(frame)
  if (vad.preRollFrames.length > PRE_ROLL_FRAMES) {
    vad.preRollFrames.shift()
  }
}

function resetVad(vad: VadState) {
  vad.inSpeech = false
  vad.lastVoiceAt = 0
  vad.utteranceStartedAt = 0
  vad.utteranceSampleRate = 0
  vad.utteranceSamples = 0
  vad.utteranceFrames = []
}

function enqueueTurn(session: ServerCallSession, turn: TurnSegment) {
  session.turnQueue.push(turn)
  if (session.turnQueue.length > 3) {
    session.turnQueue.shift()
  }
  void drainTurnQueue(session)
}

function maybeFinalizeUtterance(session: ServerCallSession, now: number) {
  const { vad } = session
  if (!vad.inSpeech) return
  if (!vad.utteranceSampleRate || !vad.utteranceSamples) return

  const utteranceMs = (vad.utteranceSamples / vad.utteranceSampleRate) * 1000
  const silenceMs = now - vad.lastVoiceAt

  if (utteranceMs < TURN_MAX_MS && (silenceMs < TURN_SILENCE_MS || utteranceMs < TURN_MIN_MS)) {
    return
  }

  const samples = concatInt16(vad.utteranceFrames)
  const sampleRate = vad.utteranceSampleRate
  resetVad(vad)

  if (!samples.length || utteranceMs < TURN_MIN_MS) {
    return
  }

  emitSystem(session.userPeerId, session.roomId, 'voice_turn_detected')
  enqueueTurn(session, { samples, sampleRate })
}

function handleInboundAudioFrame(session: ServerCallSession, frame: AudioFrameLike) {
  const sampleRate = Number(frame.sampleRate)
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) {
    return
  }

  const channelCount = Number(frame.channelCount ?? 1)
  const monoFrame = downmixToMono(frame.samples, Number.isFinite(channelCount) ? channelCount : 1)
  const now = Date.now()
  const level = rmsLevel(monoFrame)

  pushVadFrame(session.vad, monoFrame)

  if (level >= VAD_START_RMS && !session.vad.inSpeech) {
    session.vad.inSpeech = true
    session.vad.lastVoiceAt = now
    session.vad.utteranceStartedAt = now
    session.vad.utteranceSampleRate = sampleRate
    session.vad.utteranceFrames = session.vad.preRollFrames.map((item) => Int16Array.from(item))
    session.vad.utteranceSamples = session.vad.utteranceFrames.reduce(
      (sum, item) => sum + item.length,
      0,
    )
  }

  if (session.vad.inSpeech) {
    session.vad.utteranceFrames.push(Int16Array.from(monoFrame))
    session.vad.utteranceSamples += monoFrame.length
    if (level >= VAD_HOLD_RMS) {
      session.vad.lastVoiceAt = now
    }
    maybeFinalizeUtterance(session, now)
  }
}

function startPlaybackLoop(session: ServerCallSession) {
  if (session.playbackTimer) return
  const frameSize = Math.round((PLAYBACK_SAMPLE_RATE * PLAYBACK_FRAME_MS) / 1000)

  session.playbackTimer = setInterval(() => {
    const current = session.playbackQueue[0]
    if (!current) {
      if (session.playbackTimer) {
        clearInterval(session.playbackTimer)
        session.playbackTimer = null
      }
      return
    }

    if (current.cursor >= current.samples.length) {
      session.playbackQueue.shift()
      return
    }

    const nextEnd = Math.min(current.samples.length, current.cursor + frameSize)
    let frame = current.samples.subarray(current.cursor, nextEnd)
    current.cursor = nextEnd

    if (frame.length < frameSize) {
      const padded = new Int16Array(frameSize)
      padded.set(frame)
      frame = padded
    }

    try {
      session.source.onData({
        samples: frame,
        sampleRate: PLAYBACK_SAMPLE_RATE,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: frame.length,
      })
    } catch (err) {
      console.warn('[webrtc] source.onData failed', err)
      session.playbackQueue = []
      if (session.playbackTimer) {
        clearInterval(session.playbackTimer)
        session.playbackTimer = null
      }
    }
  }, PLAYBACK_FRAME_MS)
}

function enqueueAssistantAudio(session: ServerCallSession, samples: Int16Array) {
  if (!samples.length) return
  session.playbackQueue.push({
    samples,
    sampleRate: PLAYBACK_SAMPLE_RATE,
    cursor: 0,
  })
  startPlaybackLoop(session)
}

function closeSession(roomId: string, userPeerId: string) {
  const key = roomPeerKey(roomId, userPeerId)
  const session = serverSessions.get(key)
  if (!session) return

  pendingServerCandidates.delete(key)
  serverSessions.delete(key)

  resetVad(session.vad)
  session.sink?.stop()
  session.sink = null

  if (session.playbackTimer) {
    clearInterval(session.playbackTimer)
    session.playbackTimer = null
  }
  session.playbackQueue = []

  try {
    session.sourceTrack.stop()
  } catch {
    // ignore
  }

  try {
    session.pc.close()
  } catch {
    // ignore
  }
}

async function createServerSession(roomId: string, userPeerId: string, botPeerId: string) {
  closeSession(roomId, userPeerId)

  const wrtc = await loadWrtc()
  if (!wrtc) {
    emitSystem(userPeerId, roomId, 'wrtc_unavailable')
    return null
  }

  const pc = new wrtc.RTCPeerConnection()
  const source = new wrtc.nonstandard.RTCAudioSource()
  const sourceTrack = source.createTrack()
  pc.addTrack(sourceTrack)

  const session: ServerCallSession = {
    roomId,
    userPeerId,
    botPeerId,
    pc,
    sink: null,
    source,
    sourceTrack,
    vad: {
      inSpeech: false,
      lastVoiceAt: 0,
      utteranceStartedAt: 0,
      utteranceSampleRate: 0,
      utteranceSamples: 0,
      utteranceFrames: [],
      preRollFrames: [],
    },
    turnQueue: [],
    processingTurn: false,
    lastTranscript: '',
    lastTranscriptAt: 0,
    playbackQueue: [],
    playbackTimer: null,
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate) return
    const candidate = event.candidate.toJSON()
    emit(userPeerId, roomId, {
      type: 'candidate',
      from: botPeerId,
      to: userPeerId,
      roomId,
      payload: candidate,
      at: new Date().toISOString(),
    })
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closeSession(roomId, userPeerId)
      return
    }
    if (pc.connectionState === 'disconnected') {
      emitSystem(userPeerId, roomId, 'connection_disconnected')
    }
  }

  pc.ontrack = (event) => {
    if (event.track.kind !== 'audio') return

    session.sink?.stop()
    const sink = new wrtc.nonstandard.RTCAudioSink(event.track)
    sink.ondata = (audioData: unknown) => {
      handleInboundAudioFrame(session, audioData as AudioFrameLike)
    }
    session.sink = sink

    event.track.addEventListener('ended', () => {
      sink.stop()
      if (session.sink === sink) {
        session.sink = null
      }
    })
  }

  serverSessions.set(roomPeerKey(roomId, userPeerId), session)
  void verifyVoiceTooling(session)
  return session
}

function getServerSession(roomId: string, userPeerId: string) {
  return serverSessions.get(roomPeerKey(roomId, userPeerId)) ?? null
}

async function transcribeAudioBuffer(audio: Buffer, audioMimeType?: string | null) {
  const sttBin = process.env.FRIDAY_STT_BIN ?? path.join(process.cwd(), 'jarvis-stt')
  const ext = guessAudioExtension(audioMimeType)
  const inPath = path.join(os.tmpdir(), `friday-stt-${generateId()}.${ext}`)

  try {
    await fs.writeFile(inPath, audio)
    const { stdout } = await execFileAsync(sttBin, [inPath], { timeout: 30_000 })
    await fs.unlink(inPath).catch(() => {})
    const transcript = stdout.trim()
    if (transcript) {
      return transcript
    }
  } catch (err) {
    await fs.unlink(inPath).catch(() => {})
    console.warn('[webrtc] stt transcription failed', err)
  }
  return transcribeWithOpenAi(audio, audioMimeType)
}

async function transcribePcmTurn(turn: TurnSegment) {
  const wavBuffer = createWavFromPcm16Mono(turn.samples, turn.sampleRate)
  return transcribeAudioBuffer(wavBuffer, 'audio/wav')
}

function guessAudioExtension(mimeType?: string | null) {
  const normalized = (mimeType || '').toLowerCase()
  if (normalized.includes('ogg')) return 'ogg'
  if (normalized.includes('wav')) return 'wav'
  if (normalized.includes('mp3') || normalized.includes('mpeg')) return 'mp3'
  return 'webm'
}

async function decodeAudioToPcm16Mono(audioBuffer: Buffer, inputExt: string) {
  const safeExt = inputExt.replace(/[^a-z0-9]/gi, '') || 'bin'
  const inputPath = path.join(os.tmpdir(), `friday-tts-in-${generateId()}.${safeExt}`)
  const outputPath = path.join(os.tmpdir(), `friday-tts-out-${generateId()}.s16le`)

  try {
    await fs.writeFile(inputPath, audioBuffer)
    await execFileAsync(
      process.env.FRIDAY_FFMPEG_BIN ?? 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(PLAYBACK_SAMPLE_RATE),
        outputPath,
      ],
      { timeout: 25_000 },
    )
    const raw = await fs.readFile(outputPath)
    const aligned = raw.byteOffset % 2 === 0 ? raw : Buffer.from(raw)
    return Int16Array.from(
      new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 2)),
    )
  } catch (err) {
    console.warn('[webrtc] failed to decode assistant audio', err)
    return null
  } finally {
    await fs.unlink(inputPath).catch(() => {})
    await fs.unlink(outputPath).catch(() => {})
  }
}

async function tryJarvisTtsBuffer(text: string) {
  const ttsBin = process.env.FRIDAY_TTS_BIN ?? path.join(process.cwd(), 'jarvis-tts')
  const outPath = path.join(os.tmpdir(), `friday-tts-${generateId()}.ogg`)

  try {
    await execFileAsync(ttsBin, [text, outPath], { timeout: 30_000 })
    const buffer = await fs.readFile(outPath)
    await fs.unlink(outPath).catch(() => {})
    return buffer
  } catch (err) {
    await fs.unlink(outPath).catch(() => {})
    console.warn('[webrtc] tts synthesis failed', err)
    return null
  }
}

function getLlmConfig() {
  return {
    endpoint:
      process.env.FRIDAY_LLM_ENDPOINT ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.FRIDAY_LLM_API_KEY ?? process.env.OPENAI_API_KEY,
    model: process.env.FRIDAY_LLM_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  }
}

async function transcribeWithOpenAi(audio: Buffer, audioMimeType?: string | null) {
  const { endpoint, apiKey } = getLlmConfig()
  if (!apiKey) {
    return null
  }

  const models = [process.env.FRIDAY_STT_MODEL ?? 'gpt-4o-mini-transcribe', 'whisper-1']
  for (const model of models) {
    try {
      const form = new FormData()
      form.append('model', model)
      const bytes = Uint8Array.from(audio)
      form.append(
        'file',
        new Blob([bytes], { type: audioMimeType ?? 'audio/wav' }),
        `input.${guessAudioExtension(audioMimeType)}`,
      )

      const res = await fetch(`${endpoint.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      })
      if (!res.ok) {
        continue
      }
      const json = (await res.json()) as { text?: unknown }
      if (typeof json.text === 'string' && json.text.trim()) {
        return json.text.trim()
      }
    } catch {
      // try next model
    }
  }

  return null
}

async function tryOpenAiTtsBuffer(text: string) {
  const { endpoint, apiKey } = getLlmConfig()
  if (!apiKey) {
    return null
  }

  const ttsModel = process.env.FRIDAY_TTS_MODEL ?? 'gpt-4o-mini-tts'
  const ttsVoice = process.env.FRIDAY_TTS_VOICE ?? 'alloy'
  const ttsFormat = process.env.FRIDAY_TTS_FORMAT ?? 'mp3'

  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/audio/speech`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: ttsModel,
        voice: ttsVoice,
        input: text,
        response_format: ttsFormat,
      }),
    })

    if (!res.ok) {
      return null
    }

    const buffer = Buffer.from(await res.arrayBuffer())
    return {
      buffer,
      format: ttsFormat,
    }
  } catch {
    return null
  }
}

function getFridaySystemPrompt() {
  return [
    'You are Friday, an elite mission-control voice assistant.',
    'Tone: sharp, concise, and confident.',
    'No filler, no hedging, no emojis.',
    'Default to 1-2 short sentences unless detail is explicitly requested.',
    'If unsure, ask one precise clarifying question.',
  ].join('\n')
}

async function requestLlmReply(input: string) {
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? ''
  const sessionKey = process.env.OPENCLAW_SESSION_KEY ?? 'agent:lorene-whatsapp-gated:main'

  console.log('[webrtc] sending turn to openclaw brain:', input)
  const res = await fetch('http://localhost:18789/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gatewayToken}`,
      'x-openclaw-session-key': sessionKey,
    },
    body: JSON.stringify({
      model: 'openclaw',
      input,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('[webrtc] openclaw brain failed:', res.status, errText)
    throw new Error(`OpenClaw brain failed (${res.status})`)
  }

  const json = (await res.json()) as any
  // Extract text from OpenResponses item format
  const replyText = json.output?.[0]?.content?.[0]?.text?.trim() || 'Proceeding.'
  console.log('[webrtc] openclaw brain reply:', replyText)
  return replyText
}

export async function synthesizeAssistantReply(input: string) {
  let text = 'Proceeding.'

  try {
    text = await requestLlmReply(input)
  } catch {
    text = 'Comms degraded. Retry in a moment.'
  }

  let audioBuffer = await tryJarvisTtsBuffer(text)
  let audioFormat = 'ogg'
  if (!audioBuffer) {
    const openAiTts = await tryOpenAiTtsBuffer(text)
    audioBuffer = openAiTts?.buffer ?? null
    audioFormat = openAiTts?.format ?? audioFormat
  }
  return {
    text,
    audioBuffer,
    audioFormat,
    audioBase64: audioBuffer ? audioBuffer.toString('base64') : null,
  }
}

async function drainTurnQueue(session: ServerCallSession) {
  if (session.processingTurn) return
  session.processingTurn = true

  try {
    while (session.turnQueue.length) {
      const turn = session.turnQueue.shift()
      if (!turn) break

      const transcript = (await transcribePcmTurn(turn))?.trim()
      if (!transcript) {
        emitSystem(session.userPeerId, session.roomId, 'transcription_empty')
        continue
      }

      const now = Date.now()
      if (transcript === session.lastTranscript && now - session.lastTranscriptAt < 2500) {
        continue
      }
      session.lastTranscript = transcript
      session.lastTranscriptAt = now

      const userEntry: ChatEntry = {
        role: 'user',
        message: transcript,
        timestamp: new Date().toISOString(),
      }
      addChatEntry(session.roomId, userEntry)

      const { text, audioBuffer, audioFormat } = await synthesizeAssistantReply(transcript)
      const reply: ChatEntry = {
        role: 'assistant',
        message: text,
        timestamp: new Date().toISOString(),
      }
      addChatEntry(session.roomId, reply)

      if (audioBuffer) {
        const pcm = await decodeAudioToPcm16Mono(audioBuffer, audioFormat)
        if (pcm?.length) {
          enqueueAssistantAudio(session, pcm)
        }
      }

      const payload: AssistantTurnPayload = {
        turnId: generateId(),
        userEntry,
        reply,
        audioBase64: null,
        audioMimeType: null,
      }

      emit(session.userPeerId, session.roomId, {
        type: 'assistant',
        from: 'server',
        to: session.userPeerId,
        roomId: session.roomId,
        payload,
        at: new Date().toISOString(),
      })
    }
  } finally {
    session.processingTurn = false
  }
}

async function handleServerBotSignal(event: SignalEvent) {
  const key = roomPeerKey(event.roomId, event.from)

  if (event.type === 'bye') {
    closeSession(event.roomId, event.from)
    return
  }

  if (event.type === 'candidate') {
    const candidate = asIceCandidate(event.payload)
    if (!candidate) return
    const session = getServerSession(event.roomId, event.from)
    if (!session) {
      const queue = pendingServerCandidates.get(key) ?? []
      queue.push(candidate)
      if (queue.length > MAX_PENDING_SERVER_CANDIDATES) {
        queue.shift()
      }
      pendingServerCandidates.set(key, queue)
      return
    }
    await session.pc.addIceCandidate(candidate).catch((err) => {
      console.warn('[webrtc] failed to add candidate on server bot peer', err)
    })
    return
  }

  if (event.type !== 'offer') {
    return
  }

  const offer = asSessionDescription(event.payload)
  if (!offer || offer.type !== 'offer') {
    emitSystem(event.from, event.roomId, 'invalid_offer_payload')
    return
  }

  let session: ServerCallSession | null = null
  try {
    session = await createServerSession(
      event.roomId,
      event.from,
      event.to ?? `${BOT_PEER_PREFIX}server`,
    )
  } catch (err) {
    console.error('[webrtc] failed creating server call session', err)
    emitSystem(event.from, event.roomId, 'wrtc_unavailable')
    return
  }
  if (!session) {
    return
  }

  try {
    await session.pc.setRemoteDescription(offer)

    const queued = pendingServerCandidates.get(key)
    if (queued?.length) {
      for (const candidate of queued) {
        await session.pc.addIceCandidate(candidate).catch(() => {})
      }
      pendingServerCandidates.delete(key)
    }

    const answer = await session.pc.createAnswer()
    await session.pc.setLocalDescription(answer)

    emit(event.from, event.roomId, {
      type: 'answer',
      from: session.botPeerId,
      to: event.from,
      roomId: event.roomId,
      payload: session.pc.localDescription,
      at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[webrtc] failed handling offer', err)
    emitSystem(event.from, event.roomId, 'offer_handling_failed')
    closeSession(event.roomId, event.from)
  }
}

export async function relaySignal(event: SignalEvent) {
  if (event.type === 'bye') {
    closeSession(event.roomId, event.from)
    if (event.to) {
      closeSession(event.roomId, event.to)
    }
  }

  if (event.to && isServerBotPeer(event.to)) {
    await handleServerBotSignal(event)
    return
  }

  if (!event.to) return
  emit(event.to, event.roomId, event)
}

export function addChatEntry(roomId: string, entry: ChatEntry) {
  const existing = roomChat.get(roomId) ?? []
  const next = [...existing, entry].slice(-MAX_CHAT_HISTORY)
  roomChat.set(roomId, next)
}

export function getChatHistory(roomId: string) {
  return roomChat.get(roomId) ?? []
}

export async function transcribeAudioInput(audioBase64: string, audioMimeType?: string | null) {
  const buffer = safeBufferFromBase64(audioBase64)
  if (!buffer || !buffer.length) return null
  return transcribeAudioBuffer(buffer, audioMimeType)
}
