import { getDashboardPayload } from '@/server/dashboard-config'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/dashboard-config')({
  server: {
    handlers: {
      GET: async () => {
        const payload = await getDashboardPayload()
        return json(payload)
      },
    },
  },
})
