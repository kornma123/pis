import express, { type Express } from 'express'
import request from 'supertest'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let db: DatabaseSync

vi.mock('../src/database/DatabaseManager.js', () => ({
  getDatabase: () => db,
}))

type Fixture = {
  id: string
  username: string
  operation: string
  description: string
  requestData?: string | null
  responseData?: string | null
  outcome?: string | null
  createdAt: string
}

const FIXTURES: Fixture[] = [
  { id: 'login', username: 'admin', operation: 'LOGIN', description: '登录系统', createdAt: '2026-07-18 08:00:00' },
  { id: 'create-inventory', username: 'admin', operation: 'POST inventory', description: '新增库存', requestData: '{"module":"inventory","sku":"I-1"}', createdAt: '2026-07-18 09:00:00' },
  { id: 'update-inbound', username: 'zhangsan', operation: 'PUT inbound', description: '修改入库单', requestData: '{"module":"inbound"}', createdAt: '2026-07-17 09:00:00' },
  { id: 'denied-inventory', username: 'alice', operation: 'DENIED POST inventory', description: '写库存被拒', requestData: '{"status":403,"code":"FORBIDDEN"}', outcome: 'denied', createdAt: '2026-07-18 10:00:00' },
  { id: 'unknown-inventory', username: 'alice', operation: 'APPROVE inventory', description: '未知动作', requestData: '{"module":"inventory"}', createdAt: '2026-07-16 09:00:00' },
  { id: 'delete-outbound', username: 'admin', operation: 'DELETE outbound', description: '删除出库单', requestData: '{"module":"outbound"}', createdAt: '2026-07-15 09:00:00' },
  { id: 'logout', username: 'admin', operation: 'LOGOUT', description: '退出系统', createdAt: '2026-07-18 11:00:00' },
  { id: 'create-users', username: 'admin', operation: 'POST users', description: '新增用户', requestData: '{"module":"users"}', createdAt: '2026-07-18 12:00:00' },
]

let app: Express

beforeAll(async () => {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE operation_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      username TEXT,
      operation TEXT NOT NULL,
      description TEXT NOT NULL,
      request_data TEXT,
      response_data TEXT,
      ip TEXT,
      user_agent TEXT,
      outcome TEXT,
      created_at DATETIME NOT NULL
    )
  `)
  const insert = db.prepare(`
    INSERT INTO operation_logs (
      id, user_id, username, operation, description, request_data,
      response_data, ip, user_agent, outcome, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of FIXTURES) {
    insert.run(
      row.id,
      `user-${row.username}`,
      row.username,
      row.operation,
      row.description,
      row.requestData ?? null,
      row.responseData ?? null,
      '127.0.0.1',
      'contract-test',
      row.outcome ?? null,
      row.createdAt,
    )
  }

  const { default: logsRouter } = await import('../src/routes/logs-v1.1.js')
  app = express()
  app.use(express.json())
  app.use('/api/v1/logs', logsRouter)
})

afterAll(() => db.close())

async function list(query: string) {
  return request(app).get(`/api/v1/logs${query}`)
}

function ids(response: request.Response) {
  return new Set(response.body.data.list.map((row: { id: string }) => row.id))
}

describe('logs route evidence contract', () => {
  it.each([
    ['?type=create', ['create-inventory', 'create-users']],
    ['?type=login', ['login']],
    ['?type=denied', ['denied-inventory']],
    ['?type=unknown', ['unknown-inventory']],
    ['?module=inventory', ['create-inventory', 'denied-inventory', 'unknown-inventory']],
    ['?username=alice', ['denied-inventory', 'unknown-inventory']],
    ['?startDate=2026-07-18&endDate=2026-07-18', ['login', 'create-inventory', 'denied-inventory', 'logout', 'create-users']],
  ])('visible filter %s changes the server result set', async (query, expectedIds) => {
    const response = await list(query)
    expect(response.status).toBe(200)
    expect(ids(response)).toEqual(new Set(expectedIds))
    expect(response.body.data.pagination.total).toBe(expectedIds.length)
  })

  it('pagination total describes the filtered server result, not only the current page', async () => {
    const response = await list('?type=create&page=1&pageSize=1')
    expect(response.status).toBe(200)
    expect(response.body.data.list).toHaveLength(1)
    expect(response.body.data.pagination).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 })
  })

  it('returns safe derived evidence used by the module label and action display', async () => {
    const response = await list('?username=admin&type=create&module=inventory')
    expect(response.status).toBe(200)
    expect(response.body.data.list).toHaveLength(1)
    expect(response.body.data.list[0]).toMatchObject({
      id: 'create-inventory',
      module: 'inventory',
      actionType: 'create',
      outcome: null,
    })
    expect(response.body.data.list[0]).not.toHaveProperty('requestData')
  })

  it('preserves denied and unknown evidence without mapping either action to login', async () => {
    const response = await list('?username=alice')
    expect(response.status).toBe(200)
    const rows = Object.fromEntries(response.body.data.list.map((row: { id: string }) => [row.id, row]))
    expect(rows['denied-inventory']).toMatchObject({
      operation: 'DENIED POST inventory',
      actionType: 'denied',
      outcome: 'denied',
    })
    expect(rows['unknown-inventory']).toMatchObject({
      operation: 'APPROVE inventory',
      actionType: 'unknown',
    })
    expect(rows['denied-inventory'].actionType).not.toBe('login')
    expect(rows['unknown-inventory'].actionType).not.toBe('login')
  })

  it.each([
    ['?type=create', ['create-inventory', 'create-users']],
    ['?module=inventory', ['create-inventory', 'denied-inventory', 'unknown-inventory']],
    ['?username=alice', ['denied-inventory', 'unknown-inventory']],
    ['?startDate=2026-07-18&endDate=2026-07-18', ['login', 'create-inventory', 'denied-inventory', 'logout', 'create-users']],
  ])('export applies the visible filter %s on the server', async (query, expectedIds) => {
    const response = await request(app).get(`/api/v1/logs/export${query}`)
    expect(response.status).toBe(200)
    expect(new Set(response.body.data.rows.map((row: { id: string }) => row.id))).toEqual(new Set(expectedIds))
    expect(response.body.data.total).toBe(expectedIds.length)
  })

  it('exports safe evidence rows with the exact same server filters as the list', async () => {
    const response = await request(app).get('/api/v1/logs/export?type=create&module=inventory&username=admin&format=csv')
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({ total: 1, maxRows: 10000 })
    expect(response.body.data.rows).toEqual([
      expect.objectContaining({
        id: 'create-inventory',
        username: 'admin',
        actionType: 'create',
        module: 'inventory',
        outcome: null,
      }),
    ])
    expect(response.body.data.rows[0]).not.toHaveProperty('requestData')
    expect(response.body.data.rows[0]).not.toHaveProperty('responseData')
  })

  it('refuses to silently truncate an export above the evidence limit', async () => {
    db.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 10001
      )
      INSERT INTO operation_logs (id, username, operation, description, created_at)
      SELECT 'bulk-' || value, 'bulk-user', 'LOGIN', 'bulk export fixture', '2026-07-18 13:00:00'
      FROM sequence
    `)

    try {
      const response = await request(app).get('/api/v1/logs/export?username=bulk-user')
      expect(response.status).toBe(413)
      expect(response.body.error.code).toBe('EXPORT_LIMIT_EXCEEDED')
    } finally {
      db.exec("DELETE FROM operation_logs WHERE username = 'bulk-user'")
    }
  })

  it('rejects an inverted date range instead of returning a misleading empty table', async () => {
    const response = await list('?startDate=2026-07-19&endDate=2026-07-18')
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_QUERY')
  })
})
