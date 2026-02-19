import { z } from 'zod'

export const dashboardComponentTypes = [
  'memory-log-list',
  'active-tasks-table',
  'system-status',
  'last-restart-card',
  'internal-state',
  'bar-chart',
  'usage-summary',
] as const

export const dashboardComponentTypeSchema = z.enum(dashboardComponentTypes)

export type DashboardComponentType = z.infer<typeof dashboardComponentTypeSchema>

export const dashboardSectionSchema = z.object({
  id: z.string().min(1),
  type: dashboardComponentTypeSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  dataKey: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
})

const dashboardSectionsSchema = z
  .array(dashboardSectionSchema)
  .min(1)
  .refine((sections) => new Set(sections.map((section) => section.id)).size === sections.length, {
    message: 'Component ids must be unique',
  })

export const dashboardConfigSchema = z.object({
  app: z.object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    refreshIntervalMs: z.number().int().positive(),
  }),
  components: dashboardSectionsSchema,
  memory: z
    .object({
      directory: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
      maxFiles: z.number().int().positive().optional(),
    })
    .optional(),
  internalState: z
    .object({
      queuedMessages: z.array(z.string()).optional(),
      upcomingEvents: z.array(z.object({ title: z.string(), at: z.string() })).optional(),
      restartReasons: z.array(z.string()).optional(),
    })
    .optional(),
  chat: z
    .object({
      status: z.enum(['idle', 'thinking', 'processing']).optional(),
      statusText: z.string().optional(),
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant', 'system']),
            message: z.string(),
            timestamp: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
  data: z
    .object({
      plexWatchTime: z.array(z.object({ label: z.string(), hours: z.number() })).optional(),
    })
    .catchall(z.unknown())
    .optional(),
})

export type DashboardConfig = z.infer<typeof dashboardConfigSchema>
export type DashboardSection = z.infer<typeof dashboardSectionSchema>
