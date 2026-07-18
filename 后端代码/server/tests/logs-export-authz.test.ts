import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Express, Request, RequestHandler } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

type RequestUser = {
  userId: string
  username: string
  role: string
  roles: string[]
}

type AuthRequest = Request & { user?: RequestUser }

type GuardContract = {
  module: string | null
  level: 'R' | 'W' | null
  conditions: string[]
}

type GuardSnapshot = {
  guards: Record<string, GuardContract>
}

let app: Express
let db: DatabaseSync

const injectRoleFromTestHeader: RequestHandler = (req, _res, next) => {
  const role = req.header('x-test-role')
  if (role) {
    ;(req as AuthRequest).user = {
      userId: `authz-test-${role}`,
      username: role,
      role,
      roles: [role],
    }
  }
  next()
}

function exportAs(role: string) {
  return request(app).get('/api/v1/logs/export').set('x-test-role', role)
}

function totalChanges() {
  return (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
}

function serializedOperationLogs() {
  return JSON.stringify(db.prepare('SELECT * FROM operation_logs ORDER BY id').all())
}

beforeAll(async () => {
  db = await getDb()
  const [{ default: logsRouter }, { requirePermission }] = await Promise.all([
    import('../src/routes/logs-v1.1.js'),
    import('../src/middleware/permissions.js'),
  ])

  app = await buildTestApp([
    {
      path: '/api/v1/logs',
      router: logsRouter,
      middleware: [injectRoleFromTestHeader, requirePermission('logs', 'R')],
    },
  ])
})

describe('GET /api/v1/logs/export authorization contract', () => {
  it('uses the same least-privilege logs:R snapshot contract as existing log reads', () => {
    const snapshot = JSON.parse(
      fs.readFileSync(new URL('../src/shadow-matrix/expected-guards.snapshot.json', import.meta.url), 'utf8'),
    ) as GuardSnapshot
    const expected: GuardContract = { module: 'logs', level: 'R', conditions: [] }

    expect(snapshot.guards['GET /api/v1/logs']).toEqual(expected)
    expect(snapshot.guards['GET /api/v1/logs/operation']).toEqual(expected)
    expect(snapshot.guards['GET /api/v1/logs/override-frequency']).toEqual(expected)
    expect(snapshot.guards['GET /api/v1/logs/export']).toEqual(expected)
  })

  it.each(['admin', 'lab_director', 'finance'])(
    'allows the existing logs reader role %s',
    async (role) => {
      const response = await exportAs(role)
      expect(response.status).toBe(200)
      expect(response.body.data).toMatchObject({ rows: expect.any(Array), total: expect.any(Number) })
    },
  )

  it.each(['warehouse_manager', 'technician', 'pathologist', 'procurement'])(
    'denies the known role %s without logs:R',
    async (role) => {
      const response = await exportAs(role)
      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('FORBIDDEN')
    },
  )

  it.each(['unknown_role', '__proto__', 'constructor', 'prototype', 'toString'])(
    'fails closed with 403 for unknown/prototype role key %s',
    async (role) => {
      const response = await exportAs(role)
      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('FORBIDDEN')
    },
  )

  it('does not write audit or business rows while exporting', async () => {
    const changesBefore = totalChanges()
    const logsBefore = serializedOperationLogs()

    const response = await exportAs('finance')

    expect(response.status).toBe(200)
    expect(totalChanges()).toBe(changesBefore)
    expect(serializedOperationLogs()).toBe(logsBefore)
  })
})
