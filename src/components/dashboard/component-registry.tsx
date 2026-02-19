import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DashboardSection } from '@/shared/dashboard-schema'
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts'

type DashboardData = {
  memoryLogs: Array<{ file: string; lines: string[] }>
  lastRestart: string
  activeTasks: Array<{ pid: string; command: string; cpu: string; mem: string }>
  systemStatus: {
    hostname: string
    platform: string
    nodeVersion: string
    uptimeSeconds: number
    loadAverage: number[]
    memory: { usedMb: number; totalMb: number; usedPercent: number }
  }
  chat: {
    status: 'idle' | 'thinking' | 'processing'
    statusText: string
    history: Array<{ role: 'user' | 'assistant' | 'system'; message: string; timestamp: string }>
  }
  internalState: {
    queuedMessages: string[]
    upcomingEvents: Array<{ title: string; at: string }>
    restartReasons: string[]
  }
  plexWatchTime?: Array<{ label: string; hours: number }>
  usageSummary?: {
    last24h: {
      requests: number
      inputTokens: number
      outputTokens: number
      totalTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
    }
    byModel: Array<{
      model: string
      requests: number
      inputTokens: number
      outputTokens: number
      totalTokens: number
    }>
    lastEventAt: string | null
  }
}

type DashboardComponent = DashboardSection

const uptime = (seconds: number) => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function StatCard({
  title,
  description,
  value,
}: { title?: string; description?: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}

export function renderDashboardComponent(component: DashboardComponent, data: DashboardData) {
  switch (component.type) {
    case 'memory-log-list':
      return (
        <Card key={component.id}>
          <CardHeader>
            <CardTitle>{component.title ?? 'Memory Logs'}</CardTitle>
            <CardDescription>{component.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.memoryLogs.map((log) => (
              <div key={log.file} className="rounded-lg border p-3">
                <div className="mb-2 text-sm font-medium">{log.file}</div>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {log.lines.map((line, idx) => (
                    <li key={`${log.file}-${idx}`}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )

    case 'active-tasks-table':
      return (
        <Card key={component.id}>
          <CardHeader>
            <CardTitle>{component.title ?? 'Active Tasks'}</CardTitle>
            <CardDescription>{component.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PID</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead>CPU %</TableHead>
                  <TableHead>MEM %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.activeTasks.map((task) => (
                  <TableRow key={task.pid}>
                    <TableCell>{task.pid}</TableCell>
                    <TableCell>{task.command}</TableCell>
                    <TableCell>{task.cpu}</TableCell>
                    <TableCell>{task.mem}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )

    case 'system-status':
      return (
        <Card key={component.id}>
          <CardHeader>
            <CardTitle>{component.title ?? 'System Status'}</CardTitle>
            <CardDescription>{component.description}</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <div>Hostname: {data.systemStatus.hostname}</div>
            <div>Platform: {data.systemStatus.platform}</div>
            <div>Node: {data.systemStatus.nodeVersion}</div>
            <div>Uptime: {uptime(data.systemStatus.uptimeSeconds)}</div>
            <div>Load Avg: {data.systemStatus.loadAverage.join(' / ')}</div>
            <div>
              RAM: {data.systemStatus.memory.usedMb} / {data.systemStatus.memory.totalMb} MB (
              {data.systemStatus.memory.usedPercent}%)
            </div>
          </CardContent>
        </Card>
      )

    case 'last-restart-card':
      return (
        <StatCard
          key={component.id}
          title={component.title ?? 'Last Restart Timestamp'}
          description={component.description}
          value={new Date(data.lastRestart).toLocaleString()}
        />
      )

    case 'internal-state':
      return (
        <Card key={component.id}>
          <CardHeader>
            <CardTitle>{component.title ?? 'Internal State'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="mb-2 font-medium">Queued Messages</div>
              <div className="flex flex-wrap gap-2">
                {data.internalState.queuedMessages.map((item) => (
                  <Badge key={item} variant="secondary">
                    {item}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 font-medium">Upcoming Events</div>
              <ul className="list-disc pl-5 text-muted-foreground">
                {data.internalState.upcomingEvents.map((event) => (
                  <li key={`${event.title}-${event.at}`}>
                    {event.title} — {new Date(event.at).toLocaleString()}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-2 font-medium">Restart Reasons</div>
              <ul className="list-disc pl-5 text-muted-foreground">
                {data.internalState.restartReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )

    case 'bar-chart': {
      const source =
        component.dataKey && component.dataKey in data
          ? (data[component.dataKey as keyof DashboardData] as unknown)
          : data.plexWatchTime
      const values = Array.isArray(source)
        ? (source as NonNullable<DashboardData['plexWatchTime']>)
        : []
      return (
        <Card key={component.id}>
          <CardHeader>
            <CardTitle>{component.title ?? 'Bar Chart'}</CardTitle>
            <CardDescription>{component.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              className="min-h-[220px] w-full"
              config={{
                hours: {
                  label: 'Hours',
                  color: 'hsl(var(--chart-1))',
                },
              }}
            >
              <BarChart accessibilityLayer data={values}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="hours" fill="var(--color-hours)" radius={6} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )
    }

    case 'usage-summary': {
      const usage = data.usageSummary
      return (
        <Card key={component.id}>
          <CardHeader>
            <CardTitle>{component.title ?? 'Claude Usage Summary (24h)'}</CardTitle>
            <CardDescription>{component.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>Requests: {usage?.last24h.requests ?? 0}</div>
              <div>Total Tokens: {usage?.last24h.totalTokens ?? 0}</div>
              <div>Input Tokens: {usage?.last24h.inputTokens ?? 0}</div>
              <div>Output Tokens: {usage?.last24h.outputTokens ?? 0}</div>
              <div>Cache Read: {usage?.last24h.cacheReadInputTokens ?? 0}</div>
              <div>Cache Create: {usage?.last24h.cacheCreationInputTokens ?? 0}</div>
            </div>
            <div>
              <div className="mb-2 font-medium">Top Models</div>
              <ul className="list-disc pl-5 text-muted-foreground">
                {(usage?.byModel ?? []).slice(0, 5).map((entry) => (
                  <li key={entry.model}>
                    {entry.model}: {entry.requests} req / {entry.totalTokens} tok
                  </li>
                ))}
              </ul>
            </div>
            <div className="text-xs text-muted-foreground">
              Last event:{' '}
              {usage?.lastEventAt ? new Date(usage.lastEventAt).toLocaleString() : 'No data yet'}
            </div>
          </CardContent>
        </Card>
      )
    }

    default:
      return (
        <Card key={component.id}>
          <CardHeader>
            <CardTitle>{component.title ?? component.type}</CardTitle>
            <CardDescription>
              Unknown component type. Add a renderer for <code>{component.type}</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      )
  }
}

export function ChatDock({ data }: { data: DashboardData }) {
  const tone =
    data.chat.status === 'thinking'
      ? 'bg-amber-500'
      : data.chat.status === 'processing'
        ? 'bg-sky-500'
        : 'bg-emerald-500'

  return (
    <Card className="fixed bottom-0 left-0 right-0 z-40 rounded-none border-x-0 border-b-0 md:left-auto md:right-4 md:bottom-4 md:w-[380px] md:rounded-lg md:border">
      <CardHeader className="py-3">
        <CardTitle className="text-base">Friday Chat Stream</CardTitle>
        <CardDescription className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${tone}`} />
          {data.chat.statusText}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-52 pr-3">
          <div className="space-y-2">
            {data.chat.history.map((entry, idx) => (
              <div key={`${entry.timestamp}-${idx}`} className="rounded-md border p-2 text-sm">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{entry.role}</span>
                  <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                </div>
                <p>{entry.message}</p>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

export type { DashboardData, DashboardComponent }
