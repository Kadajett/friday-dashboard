import { createSignalEventStream } from '@/server/voice-realtime'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/webrtc/events')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const peerId = url.searchParams.get('peerId')
        const roomId = url.searchParams.get('roomId') ?? 'friday-default-room'

        if (!peerId) {
          return new Response('peerId query param is required', { status: 400 })
        }

        const stream = createSignalEventStream(peerId, roomId)
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      },
    },
  },
})
