// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readUsageSummary } from './dashboard-config'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('readUsageSummary', () => {
  it('aggregates ledger rows from the last 24h', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'usage-ledger-test-'))
    tempDirs.push(dir)
    const dbPath = path.join(dir, 'usage-ledger.db')

    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE llm_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0
      );
    `)

    const now = Date.now()
    const insert = db.prepare(
      'INSERT INTO llm_usage_events(ts, model, input_tokens, output_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )

    insert.run(now - 1000, 'claude-sonnet', 100, 50, 150, 10, 30)
    insert.run(now - 2000, 'claude-sonnet', 25, 10, 35, 0, 5)
    insert.run(now - 25 * 60 * 60 * 1000, 'old-model', 999, 999, 1998, 0, 0)

    db.close()

    const summary = readUsageSummary(dbPath)

    expect(summary.last24h.requests).toBe(2)
    expect(summary.last24h.inputTokens).toBe(125)
    expect(summary.last24h.outputTokens).toBe(60)
    expect(summary.last24h.totalTokens).toBe(185)
    expect(summary.last24h.cacheCreationInputTokens).toBe(10)
    expect(summary.last24h.cacheReadInputTokens).toBe(35)
    expect(summary.byModel[0]?.model).toBe('claude-sonnet')
    expect(summary.byModel[0]?.totalTokens).toBe(185)
    expect(summary.lastEventAt).toBeTruthy()
  })
})
