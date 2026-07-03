/**
 * 库存盘点「真两阶段」契约（Lane A · 单条盘点做真）
 *
 * 背景：master 旧口径 POST /stocktaking 在**创建时即入账**（改 inventory.stock + 写 stock_logs），
 *   把「清点」和「审批入账」两个动作压成一步——盘点单一提交就悄悄改了账面，缺审批环节（内控弱点），
 *   且前端「处理盘点差异 / 确认调整」弹窗因此无真实后端可接（inventory 已被改过，再改就双计）。
 *
 * 本轮受控落地（单条盘点）改为两阶段：
 *   1. 创建（POST /）：只登记，不入账。差异≠0 → status='pending'；差异=0 → status='completed'（相符，无需入账）。
 *      不改 inventory、不写 stock_logs。
 *   2. 处理差异（POST /:id/adjust）：受控原因(normal/record/physical/other) + 处理说明 → 真正入账
 *      （inventory.stock=实盘 + 写 stock_logs 'adjust'），status→'confirmed'，原因落 remark。
 *      幂等：非 pending 不可重复处理；防过期：入账前账面已变 → 409 不入账。
 *   3. 撤销（DELETE /:id）：仅对**已入账**（status≠'pending' 且差异≠0）回滚库存；pending 从未入账 → 只软删不回滚。
 *
 * 批量盘点 POST /batch 本轮**保持一阶段**（创建即入账，见 p1-04-stocktaking-batch.test.ts），不在本次改造范围。
 *
 * 红→绿：改造前 /adjust 路由不存在（404）、且创建即入账（inventory 变了）→ 本文件断言全红。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any

let seq = 0
function seedMaterial(stock: number): string {
  const id = `MAT-TP-${++seq}`
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES (?, ?, ?, '瓶', 'CAT', 10, 1, 0)`).run(id, id, id)
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES (?, ?, ?)`).run(`INV-${id}`, id, stock)
  return id
}

function stockOf(materialId: string): number {
  return Number((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any).stock)
}
function logCount(recordId: string): number {
  return Number((db.prepare("SELECT COUNT(*) c FROM stock_logs WHERE related_id = ? AND related_type = 'stocktaking'").get(recordId) as any).c)
}
function recordOf(recordId: string): any {
  return db.prepare('SELECT * FROM stocktaking_records WHERE id = ?').get(recordId) as any
}

async function post(path: string, body: any) {
  const request = (await import('supertest')).default
  return request(app).post(path).send(body)
}
async function del(path: string) {
  const request = (await import('supertest')).default
  return request(app).delete(path)
}

beforeAll(async () => {
  db = await getDb()
  const stocktakingRoutes = (await import('../src/routes/stocktaking-v1.1.js')).default
  app = await buildTestApp([{ path: '/api/v1/stocktaking', router: stocktakingRoutes }])
})

describe('盘点两阶段 · 创建只登记不入账', () => {
  it('TP-01: 差异≠0 → status=pending，库存不变、不写流水', async () => {
    const mid = seedMaterial(100)
    const res = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 90, remark: '待处理' })
    expect(res.status).toBe(200)
    const id = res.body.data.id
    const rec = recordOf(id)
    expect(rec.status).toBe('pending')
    expect(Number(rec.difference)).toBe(-10)
    expect(Number(rec.system_stock)).toBe(100)
    expect(Number(rec.actual_stock)).toBe(90)
    // 关键：创建不入账
    expect(stockOf(mid)).toBe(100)
    expect(logCount(id)).toBe(0)
  })

  it('TP-02: 差异=0 → status=completed（相符），库存不变、不写流水', async () => {
    const mid = seedMaterial(50)
    const res = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 50 })
    expect(res.status).toBe(200)
    const rec = recordOf(res.body.data.id)
    expect(rec.status).toBe('completed')
    expect(Number(rec.difference)).toBe(0)
    expect(stockOf(mid)).toBe(50)
    expect(logCount(res.body.data.id)).toBe(0)
  })
})

describe('盘点两阶段 · 处理差异才入账', () => {
  it('TP-03: 受控原因确认 → 库存入账到实盘、写 adjust 流水、status=confirmed、原因落 remark', async () => {
    const mid = seedMaterial(100)
    const { body } = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 90 })
    const id = body.data.id

    const res = await post(`/api/v1/stocktaking/${id}/adjust`, { reason: 'physical', remark: '月末实物复核' })
    expect(res.status).toBe(200)

    expect(stockOf(mid)).toBe(90) // 入账
    expect(logCount(id)).toBe(1)
    const log = db.prepare("SELECT * FROM stock_logs WHERE related_id = ? AND related_type = 'stocktaking'").get(id) as any
    expect(log.type).toBe('adjust')
    expect(Number(log.quantity)).toBe(-10)
    expect(Number(log.before_stock)).toBe(100)
    expect(Number(log.after_stock)).toBe(90)

    const rec = recordOf(id)
    expect(rec.status).toBe('confirmed')
    expect(rec.remark).toContain('实物问题') // 原因中文标签
    expect(rec.remark).toContain('月末实物复核')
  })

  it('TP-04: 非受控原因 → 400，且无任何库存副作用（不入账、状态仍 pending）', async () => {
    const mid = seedMaterial(100)
    const { body } = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 88 })
    const id = body.data.id

    const res = await post(`/api/v1/stocktaking/${id}/adjust`, { reason: '临时手写原因', remark: '不应通过' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_PARAMETER')

    expect(stockOf(mid)).toBe(100)
    expect(logCount(id)).toBe(0)
    expect(recordOf(id).status).toBe('pending')
  })

  it('TP-04b: 原型链键(constructor/toString)不得绕过原因白名单 → 400，无库存副作用', async () => {
    for (const bad of ['constructor', 'toString', 'hasOwnProperty']) {
      const mid = seedMaterial(100)
      const { body } = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 90 })
      const id = body.data.id
      const res = await post(`/api/v1/stocktaking/${id}/adjust`, { reason: bad })
      expect(res.status).toBe(400)
      expect(stockOf(mid)).toBe(100)
      expect(logCount(id)).toBe(0)
      expect(recordOf(id).status).toBe('pending')
    }
  })

  it('TP-05: 缺原因 → 400', async () => {
    const mid = seedMaterial(100)
    const { body } = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 80 })
    const res = await post(`/api/v1/stocktaking/${body.data.id}/adjust`, { remark: '没选原因' })
    expect(res.status).toBe(400)
  })

  it('TP-06: 幂等 —— 已处理(confirmed)不可重复处理，库存不被双计', async () => {
    const mid = seedMaterial(100)
    const { body } = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 90 })
    const id = body.data.id
    const first = await post(`/api/v1/stocktaking/${id}/adjust`, { reason: 'normal' })
    expect(first.status).toBe(200)
    expect(stockOf(mid)).toBe(90)

    const second = await post(`/api/v1/stocktaking/${id}/adjust`, { reason: 'normal' })
    expect(second.status).toBe(400)
    expect(stockOf(mid)).toBe(90) // 未被二次入账
    expect(logCount(id)).toBe(1)
  })

  it('TP-07: 防过期 —— 入账前账面已变 → 409，不入账', async () => {
    const mid = seedMaterial(100)
    const { body } = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 90 })
    const id = body.data.id
    // 外部把库存改了（如期间发生出库），与创建时快照不符
    db.prepare('UPDATE inventory SET stock = 95 WHERE material_id = ?').run(mid)

    const res = await post(`/api/v1/stocktaking/${id}/adjust`, { reason: 'physical' })
    expect(res.status).toBe(409)
    expect(stockOf(mid)).toBe(95) // 未被旧盘点覆盖
    expect(logCount(id)).toBe(0)
    expect(recordOf(id).status).toBe('pending')
  })

  it('TP-08: 记录不存在 → 404', async () => {
    const res = await post('/api/v1/stocktaking/nope-nope/adjust', { reason: 'physical' })
    expect(res.status).toBe(404)
  })
})

describe('盘点两阶段 · 撤销按是否入账区分', () => {
  it('TP-09: 撤销 pending（从未入账）→ 只软删不回滚库存', async () => {
    const mid = seedMaterial(100)
    const { body } = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 90 })
    const id = body.data.id
    expect(stockOf(mid)).toBe(100)

    const res = await del(`/api/v1/stocktaking/${id}`)
    expect(res.status).toBe(200)
    expect(stockOf(mid)).toBe(100) // 未曾入账 → 撤销不动库存
    expect(recordOf(id).is_deleted).toBe(1)
  })

  it('TP-10: 撤销 confirmed（已入账）→ 回滚库存到账面并写 cancel 流水', async () => {
    const mid = seedMaterial(100)
    const { body } = await post('/api/v1/stocktaking', { materialId: mid, actualStock: 90 })
    const id = body.data.id
    await post(`/api/v1/stocktaking/${id}/adjust`, { reason: 'physical' })
    expect(stockOf(mid)).toBe(90)

    const res = await del(`/api/v1/stocktaking/${id}`)
    expect(res.status).toBe(200)
    expect(stockOf(mid)).toBe(100) // 回滚到账面
    const cancel = db.prepare("SELECT COUNT(*) c FROM stock_logs WHERE related_id = ? AND related_type = 'stocktaking_cancel'").get(id) as any
    expect(Number(cancel.c)).toBe(1)
  })
})
