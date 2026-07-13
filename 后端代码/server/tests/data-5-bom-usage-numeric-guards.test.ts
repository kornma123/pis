/**
 * DATA-5 / #137: BOM material usage must be a strict finite, non-negative
 * number before a durable transaction, BOM mutation, or version snapshot.
 * Existing zero and finite numeric-string semantics remain unchanged.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { Test } from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let auditedApp: any
let db: any
let adminToken = ''
let sequence = 0
let materialId = ''
let resetDenialTracker: () => void

const INVALID_USAGE_VALUES: unknown[] = [
  null,
  true,
  false,
  '',
  '   ',
  [],
  {},
  -1,
  '-1',
  'Infinity',
  '-Infinity',
  'NaN',
  'not-a-number',
]
const INVALID_MATERIAL_LIST_VALUES: unknown[] = [null, {}, 'not-an-array', true, false, 1]
const RAW_OVERFLOW = '__RAW_OVERFLOW__'

function nextId(label: string): string {
  sequence += 1
  return `DATA5-${label}-${Date.now()}-${sequence}`
}

function auth(test: Test, idempotencyKey?: string): Test {
  test.set('Authorization', `Bearer ${adminToken}`)
  if (idempotencyKey) test.set('Idempotency-Key', idempotencyKey)
  return test
}

async function recordExec<T>(action: () => Promise<T>): Promise<{ result: T; execCalls: string[] }> {
  const execSpy = vi.spyOn(db, 'exec')
  try {
    const result = await action()
    return { result, execCalls: execSpy.mock.calls.map(([sql]: any[]) => String(sql)) }
  } finally {
    execSpy.mockRestore()
  }
}

function expectNoTransaction(execCalls: string[]): void {
  expect(execCalls.some(sql => /\bBEGIN(?:\s+IMMEDIATE)?\b/i.test(sql))).toBe(false)
  expect(db.isTransaction).toBe(false)
}

function rawJsonBody(payload: Record<string, unknown>): string {
  return JSON.stringify(payload).replace(`"${RAW_OVERFLOW}"`, '1e400')
}

function bomState(id: string) {
  return {
    bom: db.prepare(`
      SELECT id, code, name, version, type, description, supportable_samples, status, is_deleted
      FROM boms WHERE id = ?
    `).get(id),
    items: db.prepare(`
      SELECT id, bom_id, material_id, usage_per_sample, unit
      FROM bom_items WHERE bom_id = ? ORDER BY id
    `).all(id),
    versions: db.prepare(`
      SELECT id, bom_id, version, snapshot, diff_summary, change_log, effective_scope, impact_summary, changed_by
      FROM bom_versions WHERE bom_id = ? ORDER BY id
    `).all(id),
  }
}

function bomCodeState(code: string) {
  return db.prepare(`
    SELECT b.id, b.code, b.name, b.version, b.supportable_samples,
           bi.id AS item_id, bi.material_id, bi.usage_per_sample,
           bv.id AS version_id, bv.snapshot
    FROM boms b
    LEFT JOIN bom_items bi ON bi.bom_id = b.id
    LEFT JOIN bom_versions bv ON bv.bom_id = b.id
    WHERE b.code = ?
    ORDER BY b.id, bi.id, bv.id
  `).all(code)
}

function inventoryState() {
  return {
    inventory: db.prepare(`
      SELECT id, material_id, stock, locked_stock
      FROM inventory WHERE material_id = ? ORDER BY id
    `).all(materialId),
    stockLogs: db.prepare('SELECT id FROM stock_logs WHERE material_id = ? ORDER BY id').all(materialId),
  }
}

function seedBom(label: string) {
  const id = nextId(`BOM-${label}`)
  const code = nextId(`CODE-${label}`)
  db.prepare(`
    INSERT INTO boms (id, code, name, version, type, description, supportable_samples, status, is_deleted)
    VALUES (?, ?, 'DATA-5 BOM', 'v1.0', 'ihc', 'before', 30, 1, 0)
  `).run(id, code)
  db.prepare(`
    INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
    VALUES (?, ?, ?, 2.5, 'mL')
  `).run(nextId(`ITEM-${label}`), id, materialId)
  return { id, code }
}

beforeAll(async () => {
  db = await getDb()
  const bomRoutes = (await import('../src/routes/bom-v1.1.js')).default
  const authRoutes = (await import('../src/routes/auth.js')).default
  const express = (await import('express')).default
  const { auditWrite, __resetDenialTrackerForTest } = await import('../src/middleware/audit-log.js')

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/boms', router: bomRoutes },
  ])
  auditedApp = express()
  auditedApp.use(express.json())
  auditedApp.use(auditWrite)
  auditedApp.use('/api/v1/boms', bomRoutes)
  resetDenialTracker = __resetDenialTrackerForTest
  adminToken = await loginAdmin(app)

  materialId = nextId('MATERIAL')
  const categoryId = nextId('CATEGORY')
  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, 1)')
    .run(categoryId, categoryId, 'DATA-5 BOM 数值护栏分类')
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES (?, ?, 'DATA-5 BOM 物料', 'mL', ?, 12.5, 1, 0)
  `).run(materialId, nextId('MATERIAL-CODE'), categoryId)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock) VALUES (?, ?, 100, 0)')
    .run(nextId('INVENTORY'), materialId)
})

describe('DATA-5 BOM usagePerSample numeric guard', () => {
  it.each(INVALID_USAGE_VALUES)(
    'POST rejects coercive, negative, or non-finite usagePerSample=%j before business effects',
    async (invalidValue) => {
      const code = nextId('POST-INVALID')
      const idempotencyKey = nextId('IDEM-POST')
      const beforeInventory = inventoryState()
      const { result: response, execCalls } = await recordExec(() => auth(
        request(app).post('/api/v1/boms'),
        idempotencyKey,
      ).send({
        code,
        name: 'DATA-5 非法用量 BOM',
        type: 'ihc',
        materials: [{ materialId, usagePerSample: invalidValue, unit: 'mL' }],
      }))

      expect(response.status, `usagePerSample=${JSON.stringify(invalidValue)}`).toBe(400)
      expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
      expect(bomCodeState(code)).toEqual([])
      expect(inventoryState()).toEqual(beforeInventory)
      // BOM CRUD has no idempotency middleware; this only locks that invalid
      // input cannot accidentally claim a key, not that the endpoint is replay-safe.
      expect(db.prepare('SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?').get(idempotencyKey)).toBeUndefined()
      expectNoTransaction(execCalls)
    },
  )

  it.each(INVALID_USAGE_VALUES)(
    'PUT rejects coercive, negative, or non-finite usagePerSample=%j without partial BOM/version writes',
    async (invalidValue) => {
      const fixture = seedBom('PUT-INVALID')
      const beforeBom = bomState(fixture.id)
      const beforeInventory = inventoryState()
      const idempotencyKey = nextId('IDEM-PUT')
      const { result: response, execCalls } = await recordExec(() => auth(
        request(app).put(`/api/v1/boms/${fixture.id}`),
        idempotencyKey,
      ).send({
        name: '不应被局部写入的名称',
        description: '不应被局部写入的描述',
        materials: [{ materialId, usagePerSample: invalidValue, unit: 'mL' }],
      }))

      expect(response.status, `usagePerSample=${JSON.stringify(invalidValue)}`).toBe(400)
      expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
      expect(bomState(fixture.id)).toEqual(beforeBom)
      expect(inventoryState()).toEqual(beforeInventory)
      expect(db.prepare('SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?').get(idempotencyKey)).toBeUndefined()
      expectNoTransaction(execCalls)
    },
  )

  it('POST rejects raw JSON 1e400 before BOM, item, version, inventory, or transaction effects', async () => {
    const code = nextId('POST-RAW')
    const idempotencyKey = nextId('IDEM-POST-RAW')
    const beforeInventory = inventoryState()
    const body = rawJsonBody({
      code,
      name: 'DATA-5 溢出用量 BOM',
      type: 'ihc',
      materials: [{ materialId, usagePerSample: RAW_OVERFLOW, unit: 'mL' }],
    })
    const { result: response, execCalls } = await recordExec(() => auth(
      request(app).post('/api/v1/boms').set('Content-Type', 'application/json'),
      idempotencyKey,
    ).send(body))

    expect(response.status).toBe(400)
    expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
    expect(bomCodeState(code)).toEqual([])
    expect(inventoryState()).toEqual(beforeInventory)
    expect(db.prepare('SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?').get(idempotencyKey)).toBeUndefined()
    expectNoTransaction(execCalls)
  })

  it('PUT rejects raw JSON 1e400 before replacing items or writing a new version', async () => {
    const fixture = seedBom('PUT-RAW')
    const beforeBom = bomState(fixture.id)
    const beforeInventory = inventoryState()
    const idempotencyKey = nextId('IDEM-PUT-RAW')
    const body = rawJsonBody({
      name: '不应写入的溢出更新',
      materials: [{ materialId, usagePerSample: RAW_OVERFLOW, unit: 'mL' }],
    })
    const { result: response, execCalls } = await recordExec(() => auth(
      request(app).put(`/api/v1/boms/${fixture.id}`).set('Content-Type', 'application/json'),
      idempotencyKey,
    ).send(body))

    expect(response.status).toBe(400)
    expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
    expect(bomState(fixture.id)).toEqual(beforeBom)
    expect(inventoryState()).toEqual(beforeInventory)
    expect(db.prepare('SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?').get(idempotencyKey)).toBeUndefined()
    expectNoTransaction(execCalls)
  })

  it('rejects a null material entry as invalid input instead of throwing a server error', async () => {
    const code = nextId('NULL-ITEM')
    const { result: response, execCalls } = await recordExec(() => auth(
      request(app).post('/api/v1/boms'),
    ).send({ code, name: 'DATA-5 空物料项 BOM', type: 'ihc', materials: [null] }))

    expect(response.status).toBe(400)
    expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
    expect(bomCodeState(code)).toEqual([])
    expectNoTransaction(execCalls)
  })

  it.each(INVALID_MATERIAL_LIST_VALUES)(
    'POST rejects an explicit malformed materials=%j value instead of silently creating an empty BOM',
    async (invalidMaterials) => {
      const code = nextId('INVALID-LIST-POST')
      const beforeInventory = inventoryState()
      const { result: response, execCalls } = await recordExec(() => auth(
        request(app).post('/api/v1/boms'),
      ).send({
        code,
        name: 'DATA-5 非法物料列表 BOM',
        type: 'ihc',
        materials: invalidMaterials,
      }))

      expect(response.status).toBe(400)
      expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
      expect(bomCodeState(code)).toEqual([])
      expect(inventoryState()).toEqual(beforeInventory)
      expectNoTransaction(execCalls)
    },
  )

  it.each(INVALID_MATERIAL_LIST_VALUES)(
    'PUT rejects an explicit malformed materials=%j value without metadata, item, or version writes',
    async (invalidMaterials) => {
      const fixture = seedBom('INVALID-LIST-PUT')
      const beforeBom = bomState(fixture.id)
      const beforeInventory = inventoryState()
      const { result: response, execCalls } = await recordExec(() => auth(
        request(app).put(`/api/v1/boms/${fixture.id}`),
      ).send({
        name: '不应写入的非法列表更新',
        materials: invalidMaterials,
      }))

      expect(response.status).toBe(400)
      expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
      expect(bomState(fixture.id)).toEqual(beforeBom)
      expect(inventoryState()).toEqual(beforeInventory)
      expectNoTransaction(execCalls)
    },
  )

  it('validates every material before creating anything when a later item is invalid', async () => {
    const code = nextId('LATE-INVALID')
    const beforeInventory = inventoryState()
    const { result: response, execCalls } = await recordExec(() => auth(
      request(app).post('/api/v1/boms'),
    ).send({
      code,
      name: 'DATA-5 后项非法 BOM',
      type: 'ihc',
      materials: [
        { materialId, usagePerSample: '2.5', unit: 'mL' },
        { materialId: nextId('SECOND-MATERIAL'), usagePerSample: true, unit: 'mL' },
      ],
    }))

    expect(response.status).toBe(400)
    expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
    expect(bomCodeState(code)).toEqual([])
    expect(inventoryState()).toEqual(beforeInventory)
    expectNoTransaction(execCalls)
  })

  it('keeps POST required-field validation ahead of usage validation', async () => {
    const { result: response, execCalls } = await recordExec(() => auth(
      request(app).post('/api/v1/boms'),
    ).send({
      name: 'DATA-5 缺少编码 BOM',
      type: 'ihc',
      materials: [{ materialId, usagePerSample: true, unit: 'mL' }],
    }))

    expect(response.status).toBe(400)
    expect(response.body?.error).toMatchObject({
      code: 'INVALID_PARAMETER',
      message: 'Missing required fields',
    })
    expectNoTransaction(execCalls)
  })

  it('keeps PUT not-found precedence ahead of usage validation', async () => {
    const { result: response, execCalls } = await recordExec(() => auth(
      request(app).put(`/api/v1/boms/${nextId('MISSING')}`),
    ).send({
      materials: [{ materialId, usagePerSample: true, unit: 'mL' }],
    }))

    expect(response.status).toBe(404)
    expect(response.body?.error?.code).toBe('NOT_FOUND')
    expectNoTransaction(execCalls)
  })

  it('preserves explicit zero and normalizes a trimmed finite numeric string on create and update', async () => {
    const code = nextId('VALID')
    const created = await auth(request(app).post('/api/v1/boms')).send({
      code,
      name: 'DATA-5 合法用量 BOM',
      type: 'ihc',
      materials: [{ materialId, usagePerSample: ' 2.5 ', unit: 'mL' }],
    })

    expect(created.status).toBe(201)
    expect(bomState(created.body.data.id).items).toHaveLength(1)
    expect(bomState(created.body.data.id).items[0].usage_per_sample).toBe(2.5)
    expect(bomState(created.body.data.id).versions).toHaveLength(1)
    expect(JSON.parse(bomState(created.body.data.id).versions[0].snapshot).materials[0].usagePerSample).toBe(2.5)

    const updated = await auth(request(app).put(`/api/v1/boms/${created.body.data.id}`)).send({
      materials: [{ materialId, usagePerSample: 0, unit: 'mL' }],
    })

    expect(updated.status).toBe(200)
    expect(bomState(created.body.data.id).items).toHaveLength(1)
    expect(bomState(created.body.data.id).items[0].usage_per_sample).toBe(0)
    expect(bomState(created.body.data.id).versions).toHaveLength(2)
    const latestVersion = bomState(created.body.data.id).versions.find((version: any) => version.version === 'v1.1')
    expect(JSON.parse(latestVersion.snapshot).materials[0].usagePerSample).toBe(0)
  })

  it('preserves omitted-materials compatibility for empty create and metadata-only update', async () => {
    const code = nextId('OMITTED-LIST')
    const created = await auth(request(app).post('/api/v1/boms')).send({
      code,
      name: 'DATA-5 省略物料 BOM',
      type: 'ihc',
    })

    expect(created.status).toBe(201)
    expect(bomState(created.body.data.id).items).toEqual([])
    expect(bomState(created.body.data.id).versions).toHaveLength(1)

    const populatedFixture = seedBom('OMITTED-LIST-PUT')
    const beforeItems = bomState(populatedFixture.id).items
    const updated = await auth(request(app).put(`/api/v1/boms/${populatedFixture.id}`)).send({
      name: 'DATA-5 仅元数据更新 BOM',
    })

    expect(updated.status).toBe(200)
    expect(bomState(populatedFixture.id).bom).toMatchObject({
      name: 'DATA-5 仅元数据更新 BOM',
      version: 'v1.1',
    })
    expect(bomState(populatedFixture.id).items).toEqual(beforeItems)
    expect(bomState(populatedFixture.id).versions).toHaveLength(1)
  })

  it('records only a scrubbed denied audit for invalid BOM usage', async () => {
    resetDenialTracker()
    const code = nextId('AUDIT')
    const marker = nextId('BOM-CANARY')
    const idempotencyKey = nextId('IDEM-AUDIT')
    const operationLogCount = Number((db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get() as any).count)
    const { result: response, execCalls } = await recordExec(() => auth(
      request(auditedApp).post('/api/v1/boms'),
      idempotencyKey,
    ).send({
      code,
      name: marker,
      type: 'ihc',
      materials: [{ materialId, usagePerSample: true, unit: 'mL' }],
    }))

    expect(response.status).toBe(400)
    expect(bomCodeState(code)).toEqual([])
    expect(db.prepare('SELECT 1 FROM idempotency_keys WHERE idempotency_key = ?').get(idempotencyKey)).toBeUndefined()
    expectNoTransaction(execCalls)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get() as any).count)).toBe(operationLogCount + 1)
    const audit = db.prepare("SELECT * FROM operation_logs WHERE outcome = 'denied' ORDER BY rowid DESC LIMIT 1").get() as any
    expect(audit.username).toBe('admin')
    expect(String(audit.operation)).toContain('DENIED POST boms')
    expect(Object.keys(JSON.parse(audit.request_data)).sort()).toEqual(['code', 'status'])
    expect(audit.response_data).toBeNull()
    expect(String(audit.request_data)).not.toContain(marker)
    expect(String(audit.description)).not.toContain(marker)
  })
})
