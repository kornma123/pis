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
  { id: 'canonical-path', username: 'canonical', operation: 'GET /api/v1/inventory/items', description: '路径模块', createdAt: '2026-07-14 09:00:00' },
  { id: 'canonical-request', username: 'canonical', operation: 'POST ignored', description: '请求模块', requestData: '{"module":" inventory "}', createdAt: '2026-07-14 10:00:00' },
  { id: 'canonical-underscore', username: 'canonical', operation: 'POST lab_a', description: '下划线模块', createdAt: '2026-07-14 11:00:00' },
  { id: 'canonical-neighbor', username: 'canonical', operation: 'POST labxa', description: '相邻模块', createdAt: '2026-07-14 12:00:00' },
  { id: 'query-description', username: 'query-user', operation: 'POST inventory', description: 'query-user POST /api/v1/inventory/items?token=synthetic-value', requestData: '{"module":"inventory"}', createdAt: '2026-07-14 13:00:00' },
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

function insertBulkLogs(username: string, count: number) {
  db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO operation_logs (id, username, operation, description, created_at)
    SELECT ? || value, ?, 'LOGIN', 'bulk export fixture', '2026-07-18 13:00:00'
    FROM sequence
  `).run(count, `${username}-`, username)
}

function deleteBulkLogs(username: string) {
  db.prepare('DELETE FROM operation_logs WHERE username = ?').run(username)
}

describe('logs route evidence contract', () => {
  it.each([
    ['?type=create', ['create-inventory', 'create-users', 'canonical-request', 'canonical-underscore', 'canonical-neighbor', 'query-description']],
    ['?type=login', ['login']],
    ['?type=denied', ['denied-inventory']],
    ['?type=unknown', ['unknown-inventory', 'canonical-path']],
    ['?module=inventory', ['create-inventory', 'denied-inventory', 'unknown-inventory', 'canonical-path', 'canonical-request', 'query-description']],
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
    expect(response.body.data.pagination).toMatchObject({ page: 1, pageSize: 1, total: 6, totalPages: 6 })
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

  it('uses one canonical module classification for SQL filtering and displayed evidence', async () => {
    const response = await list('?username=canonical&module=inventory')
    expect(response.status).toBe(200)
    expect(ids(response)).toEqual(new Set(['canonical-path', 'canonical-request']))
    expect(response.body.data.list.map((row: { module: string }) => row.module)).toEqual(['inventory', 'inventory'])
  })

  it('treats an underscore in a module filter as evidence, not a SQL wildcard', async () => {
    const response = await list('?username=canonical&module=lab_a')
    expect(response.status).toBe(200)
    expect(ids(response)).toEqual(new Set(['canonical-underscore']))
    expect(response.body.data.list[0].module).toBe('lab_a')
  })

  it('removes query values from the safe description projection used by list and export', async () => {
    const listResponse = await list('?username=query-user')
    const exportResponse = await request(app).get('/api/v1/logs/export?username=query-user')

    expect(listResponse.status).toBe(200)
    expect(exportResponse.status).toBe(200)
    expect(listResponse.body.data.list[0].description).toBe('query-user POST /api/v1/inventory/items')
    expect(exportResponse.body.data.rows[0].description).toBe('query-user POST /api/v1/inventory/items')
    expect(JSON.stringify(exportResponse.body.data.rows)).not.toContain('synthetic-value')
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
    ['?type=create', ['create-inventory', 'create-users', 'canonical-request', 'canonical-underscore', 'canonical-neighbor', 'query-description']],
    ['?module=inventory', ['create-inventory', 'denied-inventory', 'unknown-inventory', 'canonical-path', 'canonical-request', 'query-description']],
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
    insertBulkLogs('bulk-over-limit', 10001)

    try {
      const response = await request(app).get('/api/v1/logs/export?username=bulk-over-limit')
      expect(response.status).toBe(413)
      expect(response.body.error.code).toBe('EXPORT_LIMIT_EXCEEDED')
      expect(response.body.error.message).toContain('10000')
    } finally {
      deleteBulkLogs('bulk-over-limit')
    }
  })

  it('exports exactly 10000 evidence rows without rejecting or truncating the boundary', async () => {
    insertBulkLogs('bulk-at-limit', 10000)

    try {
      const response = await request(app).get('/api/v1/logs/export?username=bulk-at-limit')
      expect(response.status).toBe(200)
      expect(response.body.data).toMatchObject({ total: 10000, maxRows: 10000 })
      expect(response.body.data.rows).toHaveLength(10000)
    } finally {
      deleteBulkLogs('bulk-at-limit')
    }
  })

  it('rejects an inverted date range instead of returning a misleading empty table', async () => {
    const response = await list('?startDate=2026-07-19&endDate=2026-07-18')
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_QUERY')
  })
})
