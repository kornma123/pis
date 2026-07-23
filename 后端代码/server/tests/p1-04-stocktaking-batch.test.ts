import { beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any

function seedMaterial(id: string, stock: number) {
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
}

beforeAll(async () => {
  db = await getDb()
  const stocktakingRoutes = (await import('../src/routes/stocktaking-v1.1.js')).default
  const injectWriteUser = (req: any, _res: any, next: any) => {
    req.user = { userId: 'TEST-ADMIN', username: 'system', role: 'admin', roles: ['admin'] }
    next()
  }
  app = await buildTestApp([
    { path: '/api/v1/stocktaking', router: stocktakingRoutes, middleware: [injectWriteUser] },
  ])
  seedMaterial('MAT-A', 100)
  seedMaterial('MAT-B', 50)
  seedMaterial('MAT-C', 30)
})

describe('LOC-001 batch stocktaking contract', () => {
  it('rejects a material-only adjustment atomically when any line differs', async () => {
    const request = (await import('supertest')).default
    const before = {
      records: db.prepare('SELECT COUNT(*) c FROM stocktaking_records').get(),
      stock: db.prepare('SELECT material_id, stock FROM inventory ORDER BY material_id').all(),
      batches: db.prepare('SELECT id, remaining FROM batches ORDER BY id').all(),
      logs: db.prepare("SELECT COUNT(*) c FROM stock_logs WHERE related_type = 'stocktaking'").get(),
    }
    const response = await request(app).post('/api/v1/stocktaking/batch').send({
      items: [
        { materialId: 'MAT-A', actualStock: 90 },
        { materialId: 'MAT-B', actualStock: 50 },
      ],
    })
    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('BATCH_DETAIL_REQUIRED')
    expect({
      records: db.prepare('SELECT COUNT(*) c FROM stocktaking_records').get(),
      stock: db.prepare('SELECT material_id, stock FROM inventory ORDER BY material_id').all(),
      batches: db.prepare('SELECT id, remaining FROM batches ORDER BY id').all(),
      logs: db.prepare("SELECT COUNT(*) c FROM stock_logs WHERE related_type = 'stocktaking'").get(),
    }).toEqual(before)
  })

  it('records an all-zero batch under one sheet without mutating inventory facts', async () => {
    const request = (await import('supertest')).default
    const response = await request(app).post('/api/v1/stocktaking/batch').send({
      operator: 'wm01',
      items: [
        { materialId: 'MAT-A', actualStock: 100 },
        { materialId: 'MAT-B', actualStock: 50 },
        { materialId: 'MAT-C', actualStock: 30 },
      ],
    })
    expect(response.status).toBe(201)
    const rows = db.prepare('SELECT * FROM stocktaking_records WHERE sheet_no = ? ORDER BY material_id')
      .all(response.body.data.sheetNo) as any[]
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.status === 'completed' && Number(row.difference) === 0)).toBe(true)
    expect(db.prepare("SELECT COUNT(*) c FROM stock_logs WHERE related_type = 'stocktaking'").get()).toEqual({ c: 0 })
  })

  it('rejects an invalid row without retaining earlier rows', async () => {
    const request = (await import('supertest')).default
    const before = (db.prepare('SELECT COUNT(*) c FROM stocktaking_records').get() as any).c
    const response = await request(app).post('/api/v1/stocktaking/batch').send({
      items: [
        { materialId: 'MAT-A', actualStock: 100 },
        { materialId: 'MAT-NOPE', actualStock: 10 },
      ],
    })
    expect(response.status).toBe(422)
    expect((db.prepare('SELECT COUNT(*) c FROM stocktaking_records').get() as any).c).toBe(before)
  })

  it('rejects an empty batch', async () => {
    const request = (await import('supertest')).default
    const response = await request(app).post('/api/v1/stocktaking/batch').send({ items: [] })
    expect(response.status).toBe(400)
  })
})
