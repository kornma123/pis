/**
 * Issue #31 — 成本分析的环比尚未计算时必须返回 null，不能伪装成精确 0%。
 *
 * 使用真实 reports 路由与 :memory: SQLite，覆盖项目/物料两条 API；同时快照
 * 相关业务表，证明读取契约修复不会产生写入副作用。
 */
process.env.DATABASE_PATH = ':memory:'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-reports-change-rate-null'

import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: Express
let db: DatabaseSync
let token = ''

const FIXTURE = {
  categoryId: 'report-null-category',
  materialId: 'report-null-material',
  projectId: 'report-null-project',
  outboundId: 'report-null-outbound',
  outboundItemId: 'report-null-outbound-item',
}

function businessState() {
  const count = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)

  return {
    projects: count('projects'),
    materials: count('materials'),
    outboundRecords: count('outbound_records'),
    outboundItems: count('outbound_items'),
    fixtureRecord: db.prepare(`
      SELECT id, project_id, total_cost, status, is_deleted
      FROM outbound_records
      WHERE id = ?
    `).get(FIXTURE.outboundId),
    fixtureItem: db.prepare(`
      SELECT id, outbound_id, material_id, quantity, total_cost
      FROM outbound_items
      WHERE id = ?
    `).get(FIXTURE.outboundItemId),
  }
}

beforeAll(async () => {
  db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const reportRoutes = (await import('../src/routes/reports-v1.1.js')).default

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/reports',
      router: reportRoutes,
      middleware: [authenticateToken, requirePermission('cost_analysis', 'R')],
    },
  ])
  token = await loginAdmin(app)

  db.prepare(`
    INSERT INTO material_categories (id, code, name, level)
    VALUES (?, 'REPORT-NULL-CAT', '环比空值回归分类', 1)
  `).run(FIXTURE.categoryId)
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, price, status)
    VALUES (?, 'REPORT-NULL-MAT', '环比空值回归物料', '瓶', ?, 12.5, 1)
  `).run(FIXTURE.materialId, FIXTURE.categoryId)
  db.prepare(`
    INSERT INTO projects (id, code, name, type, status)
    VALUES (?, 'REPORT-NULL-PROJECT', '环比空值回归项目', 'ihc', 1)
  `).run(FIXTURE.projectId)
  db.prepare(`
    INSERT INTO outbound_records
      (id, outbound_no, type, project_id, total_cost, operator, status, is_deleted)
    VALUES (?, 'REPORT-NULL-OUTBOUND', 'project', ?, 25, 'report-null-test', 'completed', 0)
  `).run(FIXTURE.outboundId, FIXTURE.projectId)
  db.prepare(`
    INSERT INTO outbound_items
      (id, outbound_id, material_id, quantity, unit, unit_cost, total_cost)
    VALUES (?, ?, ?, 2, '瓶', 12.5, 25)
  `).run(FIXTURE.outboundItemId, FIXTURE.outboundId, FIXTURE.materialId)
})

describe('Issue #31 — uncomputed report change rate', () => {
  it.each([
    {
      path: '/api/v1/reports/cost-by-project',
      collection: 'projects',
      fixtureId: FIXTURE.projectId,
    },
    {
      path: '/api/v1/reports/cost-by-material',
      collection: 'materials',
      fixtureId: FIXTURE.materialId,
    },
  ])('returns null from $path without business writes', async ({ path, collection, fixtureId }) => {
    const before = businessState()

    const response = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.body.data[collection]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixtureId, changeRate: null }),
    ]))
    expect(businessState()).toEqual(before)
  })
})
