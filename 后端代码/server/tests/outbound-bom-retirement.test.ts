/**
 * Issue #136 — `/outbound/bom` 产品下线契约。
 *
 * PM 已确认项目尚未上线、没有仓外消费者，并选择删除无人消费的 BOM
 * 一键出库写端点。保留 `type = 'bom'` 的历史读取/重算兼容；专用路径返回
 * 统一 404，其他写入口显式拒绝该退役类型，且不得触碰库存、批次、出库、流水
 * 或幂等状态。
 */
process.env.DATABASE_PATH = ':memory:'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-outbound-bom-retirement'

import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: Express
let db: DatabaseSync
let token = ''

const FIXTURE = {
  categoryId: 'retired-bom-category',
  materialId: 'retired-bom-material',
  inboundId: 'retired-bom-inbound',
  batchId: 'retired-bom-batch',
  projectId: 'retired-bom-project',
  bomId: 'retired-bom-definition',
  liveOutboundId: 'retired-bom-live-outbound',
  historicalOutboundId: 'retired-bom-historical-outbound',
}

function businessState() {
  const count = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)

  return {
    outboundRecords: count('outbound_records'),
    outboundRecordState: db.prepare(`
      SELECT id, type, project_id, total_cost, status, is_deleted
      FROM outbound_records
      ORDER BY id
    `).all(),
    outboundItems: count('outbound_items'),
    outboundItemState: db.prepare(`
      SELECT id, outbound_id, material_id, batch_id, quantity, total_cost
      FROM outbound_items
      ORDER BY id
    `).all(),
    batchUsage: count('batch_usage_tracking'),
    inventory: db.prepare('SELECT id, stock, locked_stock FROM inventory ORDER BY id').all(),
    batches: db.prepare('SELECT id, quantity, remaining, status FROM batches ORDER BY id').all(),
    stockLogs: count('stock_logs'),
    abcDetails: count('outbound_abc_details'),
    costExceptions: count('cost_exceptions'),
    overrideLogs: count('override_log'),
    idempotencyKeys: count('idempotency_keys'),
  }
}

beforeAll(async () => {
  db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const outboundRoutes = (await import('../src/routes/outbound-v1.1.js')).default

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/outbound',
      router: outboundRoutes,
      middleware: [authenticateToken, requirePermission('outbound', 'R')],
    },
  ])
  token = await loginAdmin(app)

  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, 1)')
    .run(FIXTURE.categoryId, 'RET-BOM-CAT', '退役端点回归分类')
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, price, status)
    VALUES (?, 'RET-BOM-MAT', '退役端点回归物料', '瓶', ?, 10, 1)
  `).run(FIXTURE.materialId, FIXTURE.categoryId)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock) VALUES (?, ?, 100, 0)')
    .run('retired-bom-inventory', FIXTURE.materialId)
  db.prepare(`
    INSERT INTO batches
      (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price,
       expiry_date, status)
    VALUES (?, ?, 'RET-BOM-BATCH', 100, 100, ?, 10, '2035-12-31', 1)
  `).run(FIXTURE.batchId, FIXTURE.materialId, FIXTURE.inboundId)
  db.prepare(`
    INSERT INTO projects (id, code, name, type, status)
    VALUES (?, 'RET-BOM-PROJECT', '退役端点回归项目', 'ihc', 1)
  `).run(FIXTURE.projectId)
  db.prepare(`
    INSERT INTO boms (id, code, name, version, type, status)
    VALUES (?, 'RET-BOM-DEFINITION', '退役端点回归 BOM', 'v1.0', 'ihc', 1)
  `).run(FIXTURE.bomId)
  db.prepare(`
    INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
    VALUES ('retired-bom-item', ?, ?, 1, '瓶')
  `).run(FIXTURE.bomId, FIXTURE.materialId)
  db.prepare(`
    INSERT INTO outbound_records
      (id, outbound_no, type, project_id, total_cost, operator, status, is_deleted)
    VALUES
      (?, 'RET-LIVE-OUTBOUND', 'project', ?, 10, 'retirement-test', 'completed', 0),
      (?, 'RET-HISTORICAL-BOM', 'bom', ?, 10, 'retirement-test', 'completed', 0)
  `).run(
    FIXTURE.liveOutboundId,
    FIXTURE.projectId,
    FIXTURE.historicalOutboundId,
    FIXTURE.projectId,
  )
  db.prepare(`
    INSERT INTO outbound_items
      (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost,
       total_cost, usage)
    VALUES
      ('retired-live-outbound-item', ?, ?, ?, 'RET-BOM-BATCH', 1, '瓶', 10, 10, 'self'),
      ('retired-historical-bom-item', ?, ?, ?, 'RET-BOM-BATCH', 1, '瓶', 10, 10, 'self')
  `).run(
    FIXTURE.liveOutboundId,
    FIXTURE.materialId,
    FIXTURE.batchId,
    FIXTURE.historicalOutboundId,
    FIXTURE.materialId,
    FIXTURE.batchId,
  )
})

describe('Issue #136 — retired POST /outbound/bom', () => {
  it('keeps historical BOM outbound records visible through the read API', async () => {
    const response = await request(app)
      .get('/api/v1/outbound')
      .query({ type: 'bom' })
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.body.data.list).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: FIXTURE.historicalOutboundId,
        type: 'bom',
        items: expect.arrayContaining([
          expect.objectContaining({ materialId: FIXTURE.materialId }),
        ]),
      }),
    ]))
  })

  it('returns NOT_FOUND to an authenticated writer without business side effects', async () => {
    const before = businessState()

    const response = await request(app)
      .post('/api/v1/outbound/bom')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'retired-outbound-bom-probe')
      .send({ projectId: FIXTURE.projectId, bomId: FIXTURE.bomId, sampleCount: 1 })

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    })
    expect(businessState()).toEqual(before)
  })

  it('cannot recreate BOM outbound through the ordinary create endpoint', async () => {
    const before = businessState()

    const response = await request(app)
      .post('/api/v1/outbound')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'retired-bom-type-create-probe')
      .send({
        type: 'bom',
        projectId: FIXTURE.projectId,
        items: [{ materialId: FIXTURE.materialId, quantity: 1 }],
      })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'INVALID_PARAMETER' },
    })
    expect(businessState()).toEqual(before)
  })

  it('cannot convert a live outbound record into the retired BOM type', async () => {
    const before = businessState()

    const response = await request(app)
      .put(`/api/v1/outbound/${FIXTURE.liveOutboundId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'bom',
        projectId: FIXTURE.projectId,
        items: [{ materialId: FIXTURE.materialId, quantity: 1 }],
      })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'INVALID_PARAMETER' },
    })
    expect(businessState()).toEqual(before)
  })

  it.each([
    { method: 'put' as const, label: 'update' },
    { method: 'delete' as const, label: 'delete' },
  ])('keeps historical BOM outbound read-only on $label', async ({ method }) => {
    const before = businessState()
    const requestBuilder = request(app)[method](`/api/v1/outbound/${FIXTURE.historicalOutboundId}`)
      .set('Authorization', `Bearer ${token}`)
    const response = method === 'put'
      ? await requestBuilder.send({
        type: 'project',
        projectId: FIXTURE.projectId,
        items: [{ materialId: FIXTURE.materialId, quantity: 1 }],
      })
      : await requestBuilder.send({})

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'OUTBOUND_TYPE_RETIRED' },
    })
    expect(businessState()).toEqual(before)
  })
})
