import { dashboardComponentTypes } from '@/shared/dashboard-schema'
// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { getDashboardPayload } from './dashboard-config'

describe('getDashboardPayload', () => {
  it('returns config and runtime data', async () => {
    const payload = await getDashboardPayload()

    expect(payload.config.app.title.length).toBeGreaterThan(0)
    expect(payload.data.memoryLogs).toBeDefined()
    expect(payload.data.activeTasks).toBeDefined()
    expect(payload.data.systemStatus.nodeVersion).toMatch(/^v/)
    expect(payload.data.chat.status).toBeDefined()
  })

  it('contains only registered component types in config', async () => {
    const payload = await getDashboardPayload()
    const types = payload.config.components.map((component) => component.type)

    for (const type of types) {
      expect(dashboardComponentTypes).toContain(type)
    }
  })
})
