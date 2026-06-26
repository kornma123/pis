/**
 * Phase1 收尾：验证真实 BOM 出库（POST /outbound/bom）会写入 outbound_abc_details，
 * 使 ABC 引擎在真实出库流程上有数据可归集（此前仅黄金用例 seed 数据）。
 * 数据库隔离由 vitest setupFiles 强制 :memory:（同 abc-cost.test.ts）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import app from '../../src/app.js'
import { getDatabase } from '../../src/database/DatabaseManager.js'
import { v4 as uuidv4 } from 'uuid'

describe('POST /outbound/bom 写入 ABC 明细', () => {
  let token: string
  let db: any
  const projectId = uuidv4()
  const materialId = uuidv4()
  const bomId = uuidv4()
  const batchId = uuidv4()

  beforeAll(async () => {
    db = getDatabase()
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })
    token = loginRes.body.data.token

    db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(materialId, 'M-ABC-HOOK', '苏木素', '瓶', 'cat-abc-hook', 10)
    db.prepare(`INSERT INTO inventory (material_id, stock) VALUES (?, ?)`).run(materialId, 100)
    db.prepare(`INSERT INTO batches (id, material_id, batch_no, quantity, remaining, status, inbound_price, expiry_date, inbound_id)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(batchId, materialId, 'B-ABC-HOOK', 100, 100, 10, '2030-12-31', 'inb-abc-hook')
    db.prepare(`INSERT INTO projects (id, code, name, type, is_deleted) VALUES (?, ?, ?, ?, 0)`)
      .run(projectId, 'P-ABC-HOOK', 'HE制片', 'routine')
    db.prepare(`INSERT INTO boms (id, code, name, type, status, is_deleted) VALUES (?, ?, ?, ?, 'active', 0)`)
      .run(bomId, 'BOM-ABC-HOOK', 'HE制片BOM', 'project')
    db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), bomId, materialId, 2, '瓶')
  })

  it('真实 BOM 出库后 outbound_abc_details 落库且材料/总成本为正', async () => {
    const res = await request(app)
      .post('/api/v1/outbound/bom')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId, bomId, sampleCount: 3 })

    expect(res.status).toBe(201)
    const outboundId = res.body.data.id
    expect(outboundId).toBeTruthy()

    const abc = db.prepare('SELECT * FROM outbound_abc_details WHERE outbound_id = ?').get(outboundId) as any
    expect(abc).toBeTruthy()
    expect(abc.sample_count).toBe(3)
    // 材料成本 = usage_per_sample(2) × sampleCount(3) × 批次进价(10) = 60
    expect(Number(abc.material_cost)).toBeGreaterThan(0)
    expect(Number(abc.total_cost)).toBeGreaterThan(0)

    // outbound_records 的 ABC 字段也被回填
    const rec = db.prepare('SELECT abc_total_cost, cost_status FROM outbound_records WHERE id = ?').get(outboundId) as any
    expect(Number(rec.abc_total_cost)).toBeGreaterThan(0)
  })
})
