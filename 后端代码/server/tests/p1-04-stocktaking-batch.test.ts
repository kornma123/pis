/**
 * P1-04 盘点一物一单无批量 → 新增批量盘点 POST /stocktaking/batch
 *
 * Bug: stocktaking-v1.1.ts POST '/' 只收单 materialId，一物一单；
 *   现场盘点常一次清点多物料，逐条提交既慢又无法把同一次盘点归组。
 *
 * 修复（落到 master 实际代码）：
 *   - 新增 POST /stocktaking/batch：body { items: [{materialId, actualStock, remark?}], operator?, remark? }
 *   - 全行预校验（任一行非法 → 整单 422，不写任何记录、不动库存 = all-or-nothing 回滚）
 *   - 合法则单事务内为每行创建一条 stocktaking_records，共享同一 sheet_no（归组）
 *   - 差异行联动 inventory + stock_logs（与单条 POST 同口径）
 *   - DatabaseManager 给 stocktaking_records 加 sheet_no 列（幂等迁移）
 *
 * 红测试（修复前 batch 路由不存在 → 404）：
 *   1. 多物料一次 /batch → 201，同一 sheet_no 下全部创建，差异行库存已更新
 *   2. 含一行非法（物料不存在 / actualStock 为负）→ 422，无任何 stocktaking_records 残留、库存不变
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any

function seedMaterial(id: string, code: string, stock: number) {
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES (?, ?, ?, '瓶', 'CAT', 10, 1, 0)`).run(id, code, code)
  db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES (?, ?, ?)`).run(`INV-${id}`, id, stock)
}

beforeAll(async () => {
  db = await getDb()
  const stocktakingRoutes = (await import('../src/routes/stocktaking-v1.1.js')).default
  // 写端点现有 requirePermission('stocktaking','W') 守卫（依赖 req.user）。注入写角色用户，
  // 模拟 authenticateToken 已设置 req.user（生产链路一致；本文件测批量业务逻辑，非 RBAC）。
  const injectWriteUser = (req: any, _res: any, next: any) => {
    req.user = { userId: 'TEST-ADMIN', username: 'system', role: 'admin' }
    next()
  }
  app = await buildTestApp([
    { path: '/api/v1/stocktaking', router: stocktakingRoutes, middleware: [injectWriteUser] },
  ])

  seedMaterial('MAT-A', 'A', 100) // 实盘 90 → 差异 -10
  seedMaterial('MAT-B', 'B', 50)  // 实盘 50 → 差异 0
  seedMaterial('MAT-C', 'C', 30)  // 实盘 35 → 差异 +5
  // 用于非法整单场景
  seedMaterial('MAT-D', 'D', 20)
})

describe('P1-04 批量盘点 POST /stocktaking/batch', () => {
  it('多物料一次提交 → 201，同一 sheet_no 全部创建、差异行库存联动', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).post('/api/v1/stocktaking/batch').send({
      operator: 'wm01',
      items: [
        { materialId: 'MAT-A', actualStock: 90 },
        { materialId: 'MAT-B', actualStock: 50 },
        { materialId: 'MAT-C', actualStock: 35 },
      ],
    })
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    const sheetNo = res.body.data.sheetNo
    expect(sheetNo).toBeTruthy()
    expect(res.body.data.count).toBe(3)

    const rows = db.prepare('SELECT * FROM stocktaking_records WHERE sheet_no = ? ORDER BY material_id').all(sheetNo) as any[]
    expect(rows.length).toBe(3)
    // 全部归到同一 sheet_no
    expect(new Set(rows.map(r => r.sheet_no))).toEqual(new Set([sheetNo]))

    // 差异计算正确
    const byMat: Record<string, any> = Object.fromEntries(rows.map(r => [r.material_id, r]))
    expect(Number(byMat['MAT-A'].difference)).toBe(-10)
    expect(Number(byMat['MAT-B'].difference)).toBe(0)
    expect(Number(byMat['MAT-C'].difference)).toBe(5)

    // 差异行库存已更新到实盘值；零差异行库存不变
    expect(Number((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get('MAT-A') as any).stock)).toBe(90)
    expect(Number((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get('MAT-B') as any).stock)).toBe(50)
    expect(Number((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get('MAT-C') as any).stock)).toBe(35)

    // 差异行写了 stock_logs（adjust），零差异行不写
    const logsA = db.prepare("SELECT COUNT(*) c FROM stock_logs WHERE material_id = ? AND related_type = 'stocktaking'").get('MAT-A') as any
    expect(Number(logsA.c)).toBe(1)
    const logsB = db.prepare("SELECT COUNT(*) c FROM stock_logs WHERE material_id = ? AND related_type = 'stocktaking'").get('MAT-B') as any
    expect(Number(logsB.c)).toBe(0)
  })

  it('含一行非法（物料不存在）→ 422，整单回滚，无任何记录残留、库存不变', async () => {
    const request = (await import('supertest')).default
    const beforeCount = (db.prepare('SELECT COUNT(*) c FROM stocktaking_records').get() as any).c
    const dStockBefore = Number((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get('MAT-D') as any).stock)

    const res = await request(app).post('/api/v1/stocktaking/batch').send({
      operator: 'wm01',
      items: [
        { materialId: 'MAT-D', actualStock: 25 }, // 合法行（若不回滚会被写入/改库存）
        { materialId: 'MAT-NOPE', actualStock: 10 }, // 非法：物料不存在
      ],
    })
    expect(res.status).toBe(422)
    expect(res.body.success).toBe(false)

    // 整单回滚：记录总数不变
    const afterCount = (db.prepare('SELECT COUNT(*) c FROM stocktaking_records').get() as any).c
    expect(afterCount).toBe(beforeCount)
    // 合法行的库存也未被改动
    expect(Number((db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get('MAT-D') as any).stock)).toBe(dStockBefore)
    // MAT-D 没有 stocktaking 调整日志
    const logsD = db.prepare("SELECT COUNT(*) c FROM stock_logs WHERE material_id = ? AND related_type = 'stocktaking'").get('MAT-D') as any
    expect(Number(logsD.c)).toBe(0)
  })

  it('含一行非法（actualStock 为负）→ 422，整单回滚', async () => {
    const request = (await import('supertest')).default
    const beforeCount = (db.prepare('SELECT COUNT(*) c FROM stocktaking_records').get() as any).c

    const res = await request(app).post('/api/v1/stocktaking/batch').send({
      items: [
        { materialId: 'MAT-A', actualStock: 88 },
        { materialId: 'MAT-B', actualStock: -1 }, // 非法
      ],
    })
    expect(res.status).toBe(422)
    expect(res.body.success).toBe(false)

    const afterCount = (db.prepare('SELECT COUNT(*) c FROM stocktaking_records').get() as any).c
    expect(afterCount).toBe(beforeCount)
  })

  it('items 为空 → 400', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).post('/api/v1/stocktaking/batch').send({ items: [] })
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
  })
})
