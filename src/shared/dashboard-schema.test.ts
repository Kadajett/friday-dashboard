import { describe, expect, it } from 'vitest'
import { dashboardComponentTypes, dashboardConfigSchema } from './dashboard-schema'

describe('dashboard schema', () => {
  it('accepts every supported component type', () => {
    const components = dashboardComponentTypes.map((type, idx) => ({
      id: `comp-${idx}`,
      type,
      title: `Component ${idx}`,
    }))

    const parsed = dashboardConfigSchema.parse({
      app: { title: 'Friday', refreshIntervalMs: 4000 },
      components,
    })

    expect(parsed.components).toHaveLength(dashboardComponentTypes.length)
  })

  it('rejects unknown component type', () => {
    expect(() =>
      dashboardConfigSchema.parse({
        app: { title: 'Friday', refreshIntervalMs: 4000 },
        components: [{ id: 'x', type: 'not-real' }],
      }),
    ).toThrowError(/Invalid option/)
  })

  it('rejects duplicated component ids', () => {
    expect(() =>
      dashboardConfigSchema.parse({
        app: { title: 'Friday', refreshIntervalMs: 4000 },
        components: [
          { id: 'dup', type: 'system-status' },
          { id: 'dup', type: 'memory-log-list' },
        ],
      }),
    ).toThrowError(/Component ids must be unique/)
  })
})
