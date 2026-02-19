import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { generateId } from '@/lib/utils'
import { Mic, MicOff, Phone, PhoneOff, Radio, Signal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

type ChatEntry = { role: 'user' | 'assistant' | 'system'; message: string; timestamp: string }

type VoiceCallProps = {
  roomId?: string
  onTranscript: (entry: ChatEntry) => void
  onNetworkChange?: (payload: {
    latencyMs: number | null
    quality: 'secure' | 'connecting' | 'degraded'
  }) => void
}

export function VoiceCall({
  roomId = 'friday-default-room',
  onTranscript,
  onNetworkChange,
}: VoiceCallProps) {
  const peerId = useMemo(() => `user-${generateId()}`, [])
  const botPeerId = useMemo(() => `friday-voice-bot-${peerId}`, [peerId])
  const [callStatus, setCallStatus] = useState<
    'idle' | 'connecting' | 'connected' | 'reconnecting'
  >('idle')
  const [isMuted, setIsMuted] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [outputLevel, setOutputLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)

  const localPcRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const userEventsRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const remotePlaybackRef = useRef<HTMLAudioElement | null>(null)
  const meterStopsRef = useRef<Array<() => void>>([])
  const outputMeterStopRef = useRef<(() => void) | null>(null)
  const networkStopRef = useRef<(() => void) | null>(null)
  const callStatusRef = useRef(callStatus)
  const pendingLocalCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const lastAssistantTurnIdRef = useRef<string | null>(null)

  useEffect(() => {
    callStatusRef.current = callStatus
  }, [callStatus])

  useEffect(() => {
    return () => cleanup()
  }, [])

  useEffect(() => {
    const handleOnline = () => {
      if (callStatusRef.current === 'idle') return
      setError(null)
      scheduleReconnect()
    }
    const handleOffline = () => {
      if (callStatusRef.current === 'idle') return
      setCallStatus('reconnecting')
      setError('Network dropped. Reconnecting when connection recovers.')
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    if (callStatus !== 'connected') return
    const timer = window.setInterval(() => setElapsedSec((current) => current + 1), 1000)
    return () => window.clearInterval(timer)
  }, [callStatus])

  function stopMeters() {
    for (const stop of meterStopsRef.current) {
      stop()
    }
    meterStopsRef.current = []
  }

  function cleanup({ resetStatus = true }: { resetStatus?: boolean } = {}) {
    userEventsRef.current?.close()
    userEventsRef.current = null
    localPcRef.current?.close()
    localPcRef.current = null
    networkStopRef.current?.()
    networkStopRef.current = null
    stopMeters()
    outputMeterStopRef.current?.()
    outputMeterStopRef.current = null
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
    }
    streamRef.current = null
    if (remotePlaybackRef.current) {
      remotePlaybackRef.current.pause()
      remotePlaybackRef.current.srcObject = null
    }
    remotePlaybackRef.current = null
    pendingLocalCandidatesRef.current = []
    lastAssistantTurnIdRef.current = null
    setElapsedSec(0)
    setLatencyMs(null)
    setMicLevel(0)
    setOutputLevel(0)
    setIsMuted(false)
    setError(null)
    if (resetStatus) {
      setCallStatus('idle')
    }
  }

  function pushTurnToUi(payload: {
    userEntry?: ChatEntry
    reply: ChatEntry
  }) {
    if (payload.userEntry?.message) {
      onTranscript(payload.userEntry)
    }
    if (payload.reply?.message) {
      onTranscript(payload.reply)
    }
  }

  function shouldIgnoreAssistantEvent(id?: unknown) {
    if (typeof id !== 'string' || !id) return false
    if (lastAssistantTurnIdRef.current === id) {
      return true
    }
    lastAssistantTurnIdRef.current = id
    return false
  }

  function isValidAssistantPayload(payload: unknown): payload is {
    turnId?: string
    userEntry?: ChatEntry
    reply: ChatEntry
  } {
    if (!payload || typeof payload !== 'object') return false
    const candidate = payload as { reply?: unknown }
    if (!candidate.reply || typeof candidate.reply !== 'object') return false
    const reply = candidate.reply as { role?: unknown; message?: unknown; timestamp?: unknown }
    if (
      (reply.role !== 'assistant' && reply.role !== 'system' && reply.role !== 'user') ||
      typeof reply.message !== 'string' ||
      typeof reply.timestamp !== 'string'
    ) {
      return false
    }
    return true
  }

  async function postSignal(payload: unknown) {
    const res = await fetch('/api/webrtc/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      throw new Error(`Signaling failed (${res.status})`)
    }
  }

  function startSignalStream() {
    userEventsRef.current?.close()

    const userEvents = new EventSource(
      `/api/webrtc/events?peerId=${encodeURIComponent(peerId)}&roomId=${encodeURIComponent(roomId)}`,
    )

    userEvents.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type?: string
          to?: string
          payload?: unknown
        }

        if (data.type === 'answer' && data.to === peerId) {
          const localPc = localPcRef.current
          if (!localPc) return
          await localPc.setRemoteDescription(data.payload as RTCSessionDescriptionInit)
          for (const candidate of pendingLocalCandidatesRef.current) {
            await localPc.addIceCandidate(candidate).catch(() => {})
          }
          pendingLocalCandidatesRef.current = []
          setCallStatus('connected')
          reconnectAttemptRef.current = 0
          setError(null)
          return
        }

        if (data.type === 'assistant' && data.to === peerId) {
          if (!isValidAssistantPayload(data.payload)) return
          if (shouldIgnoreAssistantEvent(data.payload.turnId)) return
          pushTurnToUi(data.payload)
          setError(null)
          return
        }

        if (data.type === 'candidate' && data.to === peerId) {
          const localPc = localPcRef.current
          if (!localPc) return
          const candidate = data.payload as RTCIceCandidateInit
          if (!localPc.remoteDescription) {
            pendingLocalCandidatesRef.current.push(candidate)
            return
          }
          await localPc.addIceCandidate(candidate)
          return
        }

        if (data.type === 'system' && data.to === peerId) {
          const payload = data.payload as { message?: unknown } | undefined
          const message = typeof payload?.message === 'string' ? payload.message : ''
          if (message === 'offer_handling_failed') {
            setError('Server failed to establish WebRTC call.')
            return
          }
          if (message === 'wrtc_unavailable') {
            setError('Server WebRTC runtime unavailable (@roamhq/wrtc).')
            return
          }
          if (message === 'stt_binary_missing') {
            setError('Server STT binary is missing (FRIDAY_STT_BIN).')
            return
          }
          if (message === 'tts_binary_missing') {
            setError('Server TTS binary is missing (FRIDAY_TTS_BIN).')
            return
          }
          if (message === 'ffmpeg_missing') {
            setError('Server ffmpeg binary is missing (FRIDAY_FFMPEG_BIN).')
            return
          }
          if (message === 'voice_turn_detected') {
            onTranscriptRef.current({
              role: 'system',
              message: 'Server detected a voice turn.',
              timestamp: new Date().toISOString(),
            })
            return
          }
          if (message === 'transcription_empty') {
            setError('Server received audio but could not transcribe this turn.')
          }
        }
      } catch (err) {
        console.error('Failed handling signaling event', err)
      }
    }

    userEvents.onerror = () => {
      if (callStatusRef.current !== 'idle') {
        scheduleReconnect()
      }
      userEvents.close()
    }

    userEventsRef.current = userEvents
  }

  function scheduleReconnect() {
    if (callStatusRef.current === 'idle') return
    if (reconnectTimerRef.current) return
    setCallStatus('reconnecting')
    const timeout = Math.min(5000, 700 * 2 ** reconnectAttemptRef.current)
    reconnectAttemptRef.current += 1
    reconnectTimerRef.current = window.setTimeout(async () => {
      reconnectTimerRef.current = null
      await startCall()
    }, timeout)
  }

  function createLevelMeter(stream: MediaStream, setter: (n: number) => void) {
    const audioCtx = new AudioContext()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.35
    source.connect(analyser)
    const timeDomain = new Float32Array(analyser.fftSize)
    let active = true
    let smoothed = 0

    const tick = () => {
      if (!active) return
      analyser.getFloatTimeDomainData(timeDomain)
      let sumSquares = 0
      for (let index = 0; index < timeDomain.length; index += 1) {
        const sample = timeDomain[index] ?? 0
        sumSquares += sample * sample
      }
      const rms = Math.sqrt(sumSquares / timeDomain.length)
      const level = Math.min(1, rms * 8.5)
      smoothed = Math.max(level, smoothed * 0.82)
      setter(Math.min(100, Math.round(smoothed * 100)))
      if (active) requestAnimationFrame(tick)
    }

    audioCtx.resume().catch(() => {})
    tick()
    return () => {
      active = false
      source.disconnect()
      analyser.disconnect()
      audioCtx.close().catch(() => {})
    }
  }

  function startNetworkMonitor(pc: RTCPeerConnection) {
    const timer = window.setInterval(async () => {
      if (callStatusRef.current === 'idle') {
        window.clearInterval(timer)
        return
      }

      const stats = await pc.getStats().catch(() => null)
      if (!stats) return
      let rtt: number | null = null
      for (const report of stats.values()) {
        if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          'currentRoundTripTime' in report
        ) {
          const next = Math.round((report.currentRoundTripTime as number) * 1000)
          if (Number.isFinite(next)) {
            rtt = next
          }
        }
      }

      setLatencyMs(rtt)
      const quality = !rtt || rtt < 120 ? 'secure' : rtt < 280 ? 'connecting' : 'degraded'
      onNetworkChange?.({ latencyMs: rtt, quality })
    }, 2000)

    return () => window.clearInterval(timer)
  }

  async function startCall() {
    cleanup({ resetStatus: false })
    setError(null)
    setCallStatus('connecting')

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const isHttps = window.location.protocol === 'https:'
      const message = !isHttps
        ? 'Microphone access requires a secure context (HTTPS or localhost).'
        : 'Your browser does not support microphone access.'
      setError(message)
      setCallStatus('idle')
      return
    }

    try {
      startSignalStream()

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream

      const localPc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      })
      localPcRef.current = localPc

      for (const track of stream.getAudioTracks()) {
        localPc.addTrack(track, stream)
      }

      localPc.ontrack = (event) => {
        const [remoteStream] = event.streams
        if (!remoteStream) return
        if (!remotePlaybackRef.current) {
          const remoteAudio = new Audio()
          remoteAudio.autoplay = true
          remoteAudio.setAttribute('playsinline', 'true')
          remotePlaybackRef.current = remoteAudio
        }
        const remoteAudio = remotePlaybackRef.current
        if (remoteAudio.srcObject !== remoteStream) {
          remoteAudio.srcObject = remoteStream
          remoteAudio.play().catch((err) => {
            console.error('Remote call playback failed', err)
          })
        }
        outputMeterStopRef.current?.()
        outputMeterStopRef.current = createLevelMeter(remoteStream, setOutputLevel)
      }

      localPc.onicecandidate = async (event) => {
        if (!event.candidate) return
        await postSignal({
          type: 'candidate',
          from: peerId,
          to: botPeerId,
          roomId,
          payload: event.candidate.toJSON(),
        })
      }

      localPc.onconnectionstatechange = () => {
        if (localPc.connectionState === 'connected') {
          setCallStatus('connected')
          reconnectAttemptRef.current = 0
          setError(null)
        }
        if (localPc.connectionState === 'failed' || localPc.connectionState === 'disconnected') {
          scheduleReconnect()
        }
      }

      const offer = await localPc.createOffer({ offerToReceiveAudio: true })
      await localPc.setLocalDescription(offer)

      await postSignal({
        type: 'offer',
        from: peerId,
        to: botPeerId,
        roomId,
        payload: offer,
      })

      meterStopsRef.current.push(
        createLevelMeter(stream, (level) => {
          setMicLevel(level)
        }),
      )
      networkStopRef.current = startNetworkMonitor(localPc)
    } catch (err) {
      console.error('Call failed:', err)
      const message =
        err instanceof Error ? err.message : 'Failed to start call. Check microphone permissions.'
      setError(message)
      cleanup()
    }
  }

  async function endCall() {
    cleanup()
    await fetch('/api/webrtc/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bye', from: peerId, to: botPeerId, roomId }),
    }).catch((err) => {
      console.error('Failed posting bye signal', err)
    })
  }

  const quality =
    !latencyMs || latencyMs < 120 ? 'secure' : latencyMs < 280 ? 'connecting' : 'degraded'
  const timerLabel = `${String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:${String(elapsedSec % 60).padStart(2, '0')}`

  return (
    <Card className="border-[#1f6feb]/40 bg-gradient-to-b from-[#0b1627] to-[#0a1220] text-slate-100 shadow-[0_0_45px_rgba(56,189,248,0.2)]">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 uppercase tracking-[0.18em]">
          <Radio className="h-4 w-4 text-cyan-300" />
          Voice Call
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-xs text-slate-300">
          <span>Status: {callStatus}</span>
          <div className="flex items-center gap-2">
            <Signal className="h-3.5 w-3.5 text-cyan-200" />
            <span>{latencyMs ? `${latencyMs}ms` : '--'}</span>
            <span className="rounded px-1.5 py-0.5 bg-white/10">{quality}</span>
          </div>
        </div>

        <div className="rounded-md bg-white/5 p-2">
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-slate-300">
            <span>Call Timer</span>
            <span>{timerLabel}</span>
          </div>
          <Waveform micLevel={micLevel} active={callStatus !== 'idle'} />
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 p-2 text-[10px] text-destructive border border-destructive/20 animate-in fade-in zoom-in duration-200">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <Meter label="Mic" value={micLevel} color="from-cyan-500 to-blue-500" />
          <Meter label="Output" value={outputLevel} color="from-violet-500 to-fuchsia-500" />
        </div>

        <div className="flex items-center gap-2 pt-1">
          {callStatus === 'idle' ? (
            <Button onClick={startCall} className="flex-1 bg-[#1f6feb] hover:bg-[#1a5fd1]">
              <Phone className="mr-2 h-4 w-4" />
              Start Call
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  const track = streamRef.current?.getAudioTracks()[0]
                  if (!track) return
                  track.enabled = !track.enabled
                  setIsMuted(!track.enabled)
                }}
                className="flex-1"
              >
                {isMuted ? <MicOff className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
                {isMuted ? 'Unmute' : 'Mute'}
              </Button>
              <Button variant="destructive" onClick={endCall} className="flex-1">
                <PhoneOff className="mr-2 h-4 w-4" />
                End Call
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px] uppercase tracking-[0.2em] text-slate-300">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="h-2 rounded-full bg-slate-900/60 overflow-hidden">
        <div
          className={`h-full bg-gradient-to-r ${color} transition-[width] duration-150`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  )
}

function Waveform({ micLevel, active }: { micLevel: number; active: boolean }) {
  return (
    <div className="flex items-end gap-1 h-8">
      {Array.from({ length: 18 }).map((_, index) => {
        const seed = ((index % 5) + 1) * 6
        const dynamic = active ? Math.max(12, ((micLevel + seed) % 100) / 2) : 6
        return (
          <div
            key={index}
            className="w-1 rounded-full bg-gradient-to-t from-cyan-500 to-blue-200 transition-all duration-150"
            style={{
              height: `${dynamic}%`,
              opacity: active ? 0.85 : 0.35,
            }}
          />
        )
      })}
    </div>
  )
}
