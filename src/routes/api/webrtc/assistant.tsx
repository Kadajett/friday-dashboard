import {
  addChatEntry,
  synthesizeAssistantReply,
  transcribeAudioInput,
} from '@/server/voice-realtime'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/webrtc/assistant')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 })
        }

        const candidate = body as {
          roomId?: unknown
          transcript?: unknown
          fallbackTranscript?: unknown
          inputAudioBase64?: unknown
          inputAudioMimeType?: unknown
        }

        const transcriptFromBody =
          typeof candidate.transcript === 'string' ? candidate.transcript.trim() : ''
        const fallbackTranscript =
          typeof candidate.fallbackTranscript === 'string'
            ? candidate.fallbackTranscript.trim()
            : ''
        const inputAudioBase64 =
          typeof candidate.inputAudioBase64 === 'string' && candidate.inputAudioBase64
            ? candidate.inputAudioBase64
            : null
        const inputAudioMimeType =
          typeof candidate.inputAudioMimeType === 'string' && candidate.inputAudioMimeType
            ? candidate.inputAudioMimeType
            : null

        let transcript = ''
        if (inputAudioBase64) {
          transcript = (await transcribeAudioInput(inputAudioBase64, inputAudioMimeType)) ?? ''
        }
        if (!transcript) transcript = transcriptFromBody || fallbackTranscript

        if (!transcript) {
          return json(
            {
              ok: false,
              error:
                'inputAudioBase64 required for server STT; fallback transcript can be provided',
            },
            { status: 400 },
          )
        }

        const roomId =
          typeof candidate.roomId === 'string' && candidate.roomId
            ? candidate.roomId
            : 'friday-default-room'
        const { text, audioBase64 } = await synthesizeAssistantReply(transcript)

        const entry = {
          role: 'assistant' as const,
          message: text,
          timestamp: new Date().toISOString(),
        }

        addChatEntry(roomId, entry)

        return json({
          ok: true,
          transcript,
          reply: entry,
          audioBase64,
          audioMimeType: audioBase64 ? 'audio/ogg' : null,
        })
      },
    },
  },
})
