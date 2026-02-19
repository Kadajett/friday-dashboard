import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChartLegend: () => <div>legend</div>,
  ChartLegendContent: () => <div>legend-content</div>,
  ChartTooltip: () => <div>tooltip</div>,
  ChartTooltipContent: () => <div>tooltip-content</div>,
}))

import {
  ChatDock,
  type DashboardComponent,
  type DashboardData,
  renderDashboardComponent,
} from './component-registry'

const data: DashboardData = {
  memoryLogs: [{ file: '2026-02-18.md', lines: ['note 1', 'note 2'] }],
  lastRestart: '2026-02-18T00:00:00.000Z',
  activeTasks: [{ pid: '1', command: 'node', cpu: '1.2', mem: '2.3' }],
  systemStatus: {
    hostname: 'shire',
    platform: 'linux',
    nodeVersion: 'v22',
    uptimeSeconds: 3601,
    loadAverage: [0.2, 0.3, 0.4],
    memory: { usedMb: 512, totalMb: 2048, usedPercent: 25 },
  },
  chat: {
    status: 'idle',
    statusText: 'Standing by',
    history: [{ role: 'user', message: 'hello', timestamp: '2026-02-18T00:00:00.000Z' }],
  },
  internalState: {
    queuedMessages: ['a'],
    upcomingEvents: [{ title: 'Check', at: '2026-02-18T01:00:00.000Z' }],
    restartReasons: ['deploy'],
  },
  plexWatchTime: [{ label: 'Mon', hours: 2 }],
}

function renderComponent(component: DashboardComponent) {
  render(renderDashboardComponent(component, data))
}

describe('renderDashboardComponent', () => {
  it.each([
    ['memory-log-list', 'Memory Logs'],
    ['active-tasks-table', 'Active Tasks'],
    ['system-status', 'System Status'],
    ['last-restart-card', 'Last Restart Timestamp'],
    ['internal-state', 'Internal State'],
    ['bar-chart', 'Bar Chart'],
  ] as const)('renders %s', (type, title) => {
    renderComponent({ id: type, type })
    expect(screen.getByText(title)).toBeInTheDocument()
  })

  it('renders unknown type fallback', () => {
    render(renderDashboardComponent({ id: 'x', type: 'unknown' as never, title: 'Unknown' }, data))

    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText(/Unknown component type/)).toBeInTheDocument()
  })
})

describe('ChatDock', () => {
  it('shows status text and chat message', () => {
    render(<ChatDock data={data} />)

    expect(screen.getByText('Friday Chat Stream')).toBeInTheDocument()
    expect(screen.getByText('Standing by')).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
  })
})
