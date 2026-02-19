import { addChatEntry, getChatHistory } from '@/server/voice-realtime'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/webrtc/chat')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const roomId = url.searchParams.get('roomId') ?? 'friday-default-room'
        return json({ history: getChatHistory(roomId) })
      },
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 })
        }

        const candidate = body as {
          roomId?: unknown
          role?: unknown
          message?: unknown
        }
        const role = candidate.role
        if (
          (role !== 'user' && role !== 'assistant' && role !== 'system') ||
          typeof candidate.message !== 'string' ||
          !candidate.message.trim()
        ) {
          return json({ ok: false, error: 'Invalid chat payload' }, { status: 400 })
        }

        const roomId =
          typeof candidate.roomId === 'string' && candidate.roomId
            ? candidate.roomId
            : 'friday-default-room'
        const entry = {
          role,
          message: candidate.message,
          timestamp: new Date().toISOString(),
        } as const

        addChatEntry(roomId, entry)

        return json({ ok: true, entry })
      },
    },
  },
})
