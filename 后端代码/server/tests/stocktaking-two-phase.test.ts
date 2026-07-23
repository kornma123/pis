import { beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
let seq = 0

function seedMaterial(stock: number): string {
  const id = `MAT-TP-${++seq}`
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES (?, ?, ?, 'pcs', 'CAT', 10, 1, 0)
  `).run(id, id, id)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock) VALUES (?, ?, ?, 0)')
    .run(`INV-${id}`, id, stock)
  db.prepare(`
    INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`B-${id}`, id, `B-${id}`, stock, stock, `IN-${id}`, stock > 0 ? 1 : 0)
  return id
}

function stockOf(materialId: string): number {
  return Number((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any).stock)
}

beforeAll(async () => {
  db = await getDb()
  const routes = (await import('../src/routes/stocktaking-v1.1.js')).default
  const injectWriteUser = (req: any, _res: any, next: any) => {
    req.user = { userId: 'TEST-ADMIN', username: 'system', role: 'admin', roles: ['admin'] }
    next()
  }
  app = await buildTestApp([{ path: '/api/v1/stocktaking', router: routes, middleware: [injectWriteUser] }])
})

describe('LOC-001 stocktaking two-phase contract', () => {
  it('keeps a nonzero material-only count as a draft with no inventory side effect', async () => {
    const request = (await import('supertest')).default
    const materialId = seedMaterial(100)
    const response = await request(app).post('/api/v1/stocktaking').send({ materialId, actualStock: 90 })
    expect(response.status).toBe(200)
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ?').get(response.body.data.id) as any
    expect(record.status).toBe('pending')
    expect(Number(record.difference)).toBe(-10)
    expect(stockOf(materialId)).toBe(100)
    expect((db.prepare('SELECT remaining FROM batches WHERE material_id = ?').get(materialId) as any).remaining).toBe(100)
  })

  it('records a legal zero difference as completed', async () => {
    const request = (await import('supertest')).default
    const materialId = seedMaterial(50)
    const response = await request(app).post('/api/v1/stocktaking').send({ materialId, actualStock: 50 })
    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('completed')
    expect(stockOf(materialId)).toBe(50)
  })

  it('fails closed when applying a draft that lacks batch-level truth', async () => {
    const request = (await import('supertest')).default
    const materialId = seedMaterial(100)
    const created = await request(app).post('/api/v1/stocktaking').send({ materialId, actualStock: 90 })
    const before = {
      stock: stockOf(materialId),
      batch: db.prepare('SELECT remaining FROM batches WHERE material_id = ?').get(materialId),
      logs: db.prepare('SELECT COUNT(*) c FROM stock_logs WHERE related_id = ?').get(created.body.data.id),
    }
    const adjusted = await request(app).post(`/api/v1/stocktaking/${created.body.data.id}/adjust`).send({ reason: 'physical' })
    expect(adjusted.status).toBe(422)
    expect(adjusted.body.error.code).toBe('BATCH_DETAIL_REQUIRED')
    expect({
      stock: stockOf(materialId),
      batch: db.prepare('SELECT remaining FROM batches WHERE material_id = ?').get(materialId),
      logs: db.prepare('SELECT COUNT(*) c FROM stock_logs WHERE related_id = ?').get(created.body.data.id),
    }).toEqual(before)
  })

  it('treats a corrupt cache as unknown instead of accepting a stocktaking draft', async () => {
    const request = (await import('supertest')).default
    const materialId = seedMaterial(100)
    db.prepare('UPDATE inventory SET stock = 99 WHERE material_id = ?').run(materialId)
    const response = await request(app).post('/api/v1/stocktaking').send({ materialId, actualStock: 99 })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('INVENTORY_LEDGER_CORRUPT')
  })

  it('soft-deletes a pending draft without touching batch facts', async () => {
    const request = (await import('supertest')).default
    const materialId = seedMaterial(100)
    const created = await request(app).post('/api/v1/stocktaking').send({ materialId, actualStock: 90 })
    const response = await request(app).delete(`/api/v1/stocktaking/${created.body.data.id}`)
    expect(response.status).toBe(200)
    expect(stockOf(materialId)).toBe(100)
    expect((db.prepare('SELECT remaining FROM batches WHERE material_id = ?').get(materialId) as any).remaining).toBe(100)
  })

  it('refuses to reverse a legacy applied adjustment without an allocation fact', async () => {
    const request = (await import('supertest')).default
    const materialId = seedMaterial(100)
    const id = `ST-LEGACY-${seq}`
    db.prepare(`
      INSERT INTO stocktaking_records
        (id, stocktaking_no, material_id, system_stock, actual_stock, difference, operator, status)
      VALUES (?, ?, ?, 100, 90, -10, 'system', 'confirmed')
    `).run(id, id, materialId)
    const response = await request(app).delete(`/api/v1/stocktaking/${id}`)
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('ALLOCATION_NOT_FOUND')
    expect(stockOf(materialId)).toBe(100)
  })
})
