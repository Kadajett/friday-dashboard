import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { type DashboardConfig, dashboardConfigSchema } from '@/shared/dashboard-schema'

const execFileAsync = promisify(execFile)

const CONFIG_PATH = path.resolve(process.cwd(), 'config/dashboard-config.json')
const SERVER_STARTED_AT = new Date().toISOString()

let cachedConfig: DashboardConfig | null = null
let cachedRaw = ''
let cachedMtime = 0

async function loadConfigFromDisk() {
  const stat = await fs.stat(CONFIG_PATH)
  if (cachedConfig && stat.mtimeMs === cachedMtime) {
    return cachedConfig
  }

  const raw = await fs.readFile(CONFIG_PATH, 'utf-8')
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedConfig = dashboardConfigSchema.parse(JSON.parse(raw))
  }

  cachedMtime = stat.mtimeMs
  return cachedConfig as DashboardConfig
}

async function readLatestMemoryLogs(config: DashboardConfig) {
  const memoryDir = path.resolve(process.cwd(), config.memory?.directory ?? '../memory')
  const maxFiles = config.memory?.maxFiles ?? 2
  const maxLines = config.memory?.maxLines ?? 14

  try {
    const entries = await fs.readdir(memoryDir)
    const markdownFiles = entries
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .slice(-maxFiles)

    const logs = await Promise.all(
      markdownFiles.map(async (fileName) => {
        const abs = path.join(memoryDir, fileName)
        const content = await fs.readFile(abs, 'utf-8')
        const lines = content
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-maxLines)

        return {
          file: fileName,
          lines,
        }
      }),
    )

    return logs
  } catch {
    return []
  }
}

async function readTopProcesses() {
  try {
    const { stdout } = await execFileAsync('sh', [
      '-c',
      'ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 7 | tail -n +2',
    ])

    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pid, command, cpu, mem] = line.split(/\s+/)
        return { pid, command, cpu, mem }
      })
  } catch {
    return []
  }
}

function readSystemStatus() {
  const [l1, l5, l15] = os.loadavg()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem

  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(os.uptime()),
    loadAverage: [l1, l5, l15].map((n) => Number(n.toFixed(2))),
    memory: {
      usedMb: Math.round(usedMem / 1024 / 1024),
      totalMb: Math.round(totalMem / 1024 / 1024),
      usedPercent: Number(((usedMem / totalMem) * 100).toFixed(1)),
    },
  }
}

export function readUsageSummary(dbPath: string) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const cutoff = Date.now() - 24 * 60 * 60 * 1000

    const last24h = db
      .prepare(
        `
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens
      FROM llm_usage_events
      WHERE ts >= ?
    `,
      )
      .get(cutoff) as {
      requests: number
      input_tokens: number
      output_tokens: number
      total_tokens: number
      cache_read_input_tokens: number
      cache_creation_input_tokens: number
    }

    const byModel = db
      .prepare(
        `
      SELECT
        COALESCE(NULLIF(model, ''), 'unknown') AS model,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM llm_usage_events
      WHERE ts >= ?
      GROUP BY COALESCE(NULLIF(model, ''), 'unknown')
      ORDER BY total_tokens DESC
    `,
      )
      .all(cutoff) as Array<{
      model: string
      requests: number
      input_tokens: number
      output_tokens: number
      total_tokens: number
    }>

    const latest = db.prepare('SELECT MAX(ts) AS ts FROM llm_usage_events').get() as {
      ts: number | null
    }

    db.close()

    return {
      last24h: {
        requests: last24h.requests ?? 0,
        inputTokens: last24h.input_tokens ?? 0,
        outputTokens: last24h.output_tokens ?? 0,
        totalTokens: last24h.total_tokens ?? 0,
        cacheReadInputTokens: last24h.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: last24h.cache_creation_input_tokens ?? 0,
      },
      byModel: byModel.map((row) => ({
        model: row.model,
        requests: row.requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
      })),
      lastEventAt: latest.ts ? new Date(latest.ts).toISOString() : null,
    }
  } catch {
    return {
      last24h: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      byModel: [],
      lastEventAt: null,
    }
  }
}

let pollerInitialized = false
function ensureConfigPoller() {
  if (pollerInitialized) return
  pollerInitialized = true

  setInterval(async () => {
    try {
      await loadConfigFromDisk()
    } catch {
      // keep serving cached config
    }
  }, 2000).unref()
}

export async function getDashboardPayload() {
  ensureConfigPoller()
  const config = await loadConfigFromDisk()

  const [memoryLogs, activeTasks] = await Promise.all([
    readLatestMemoryLogs(config),
    readTopProcesses(),
  ])

  const usageLedgerDbPath =
    typeof config.data?.usageLedgerDbPath === 'string'
      ? config.data.usageLedgerDbPath
      : path.resolve(process.cwd(), '../.openclaw/state/usage-ledger.db')

  return {
    config,
    data: {
      memoryLogs,
      lastRestart: SERVER_STARTED_AT,
      activeTasks,
      systemStatus: readSystemStatus(),
      usageSummary: readUsageSummary(usageLedgerDbPath),
      chat: {
        status: config.chat?.status ?? 'idle',
        statusText: config.chat?.statusText ?? 'Standing by',
        history: config.chat?.history ?? [],
      },
      internalState: {
        queuedMessages: config.internalState?.queuedMessages ?? [],
        upcomingEvents: config.internalState?.upcomingEvents ?? [],
        restartReasons: config.internalState?.restartReasons ?? [],
      },
      plexWatchTime: config.data?.plexWatchTime ?? [],
      generatedAt: new Date().toISOString(),
    },
  }
}
