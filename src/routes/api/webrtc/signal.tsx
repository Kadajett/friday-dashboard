import { relaySignal } from '@/server/voice-realtime'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/webrtc/signal')({
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
          type?: unknown
          from?: unknown
          to?: unknown
          roomId?: unknown
          payload?: unknown
        }
        const isValidType = ['offer', 'answer', 'candidate', 'bye'].includes(String(candidate.type))
        if (
          !isValidType ||
          typeof candidate.from !== 'string' ||
          !candidate.from ||
          typeof candidate.to !== 'string' ||
          !candidate.to ||
          typeof candidate.roomId !== 'string' ||
          !candidate.roomId
        ) {
          return json({ ok: false, error: 'Invalid signaling payload' }, { status: 400 })
        }

        await relaySignal({
          type: candidate.type as 'offer' | 'answer' | 'candidate' | 'bye',
          from: candidate.from,
          to: candidate.to,
          roomId: candidate.roomId,
          payload: candidate.payload,
          at: new Date().toISOString(),
        })

        return json({ ok: true })
      },
    },
  },
})
