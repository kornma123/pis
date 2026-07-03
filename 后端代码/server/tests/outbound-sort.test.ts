process.env.DATABASE_PATH = ':memory:'

import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'

// 延迟导入 app，确保 DATABASE_PATH 已设置
const getApp = async () => {
  const { default: app } = await import('../src/app.js')
  const { getDatabase } = await import('../src/database/DatabaseManager.js')
  return { app, db: getDatabase() }
}

async function loginAdmin(app: any): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: 'admin123' })
  expect(res.status).toBe(200)
  return res.body.data.token
}

function seed(db: any, suffix: string) {
  const categoryId = `cat-sort-${suffix}`
  const supplierId = `sup-sort-${suffix}`
  const locationId = `loc-sort-${suffix}`
  const matA = `mat-sortA-${suffix}` // 单价 10
  const matB = `mat-sortB-${suffix}` // 单价 100

  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, ?)')
    .run(categoryId, `CAT-SORT-${suffix}`, '排序分类', 1)
  db.prepare('INSERT INTO suppliers (id, code, name, status) VALUES (?, ?, ?, ?)')
    .run(supplierId, `SUP-SORT-${suffix}`, '排序供应商', 1)
  db.prepare('INSERT INTO locations (id, code, name, type, zone, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(locationId, `LOC-SORT-${suffix}`, '排序库位', 'shelf', 'A区', 1)
  db.prepare('INSERT INTO materials (id, code, name, spec, unit, category_id, supplier_id, price, location_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(matA, `MAT-SORTA-${suffix}`, '排序物料A', '1ml', '瓶', categoryId, supplierId, 10, locationId, 1)
  db.prepare('INSERT INTO materials (id, code, name, spec, unit, category_id, supplier_id, price, location_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(matB, `MAT-SORTB-${suffix}`, '排序物料B', '1ml', '瓶', categoryId, supplierId, 100, locationId, 1)

  return { categoryId, supplierId, locationId, matA, matB }
}

describe('出库列表排序（后端白名单，防注入）', () => {
  let app: any
  let db: any
  let token: string
  let projectId: string
  // 出库单号 → 便于按顺序断言
  let ob1: string // cost 50,  qty 5, created 2026-03-03（最新）
  let ob2: string // cost 130, qty 4, created 2026-01-01（最早）
  let ob3: string // cost 200, qty 2, created 2026-02-02（居中）

  async function listNos(query: Record<string, string>) {
    const res = await request(app)
      .get('/api/v1/outbound')
      .query({ projectId, pageSize: '50', ...query })
      .set('Authorization', `Bearer ${token}`)
    return res
  }

  beforeAll(async () => {
    ;({ app, db } = await getApp())
    token = await loginAdmin(app)
    const suffix = `sort-${Date.now()}`
    const f = seed(db, suffix)

    // 入库形成库存
    for (const [mat, price] of [[f.matA, 10], [f.matB, 100]] as const) {
      const inb = await request(app)
        .post('/api/v1/inbound')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'direct', materialId: mat, batchNo: `B-${mat}`,
          quantity: 100, price, supplierId: f.supplierId, locationId: f.locationId,
          expiryDate: '2030-12-31',
        })
      expect(inb.status).toBe(201)
    }

    const projRes = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `P-SORT-${suffix}`, name: '排序项目', type: 'ihc', status: 'active' })
    expect(projRes.status).toBe(201)
    projectId = projRes.body.data.id

    const mk = async (items: any[]) => {
      const res = await request(app)
        .post('/api/v1/outbound')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'project', projectId, items })
      expect(res.status).toBe(201)
      return res.body.data.outboundNo as string
    }
    ob1 = await mk([{ materialId: f.matA, quantity: 5 }])                                  // 50 / 5
    ob2 = await mk([{ materialId: f.matA, quantity: 3 }, { materialId: f.matB, quantity: 1 }]) // 130 / 4
    ob3 = await mk([{ materialId: f.matB, quantity: 2 }])                                  // 200 / 2

    // 固化 created_at，使「时间序」既区别于「金额序」也区别于「数量序」
    const setTime = (no: string, t: string) =>
      db.prepare('UPDATE outbound_records SET created_at = ? WHERE outbound_no = ?').run(t, no)
    setTime(ob1, '2026-03-03 10:00:00')
    setTime(ob2, '2026-01-01 10:00:00')
    setTime(ob3, '2026-02-02 10:00:00')
  })

  it('缺省无排序参数 → 按出库时间倒序（向后兼容）', async () => {
    const res = await listNos({})
    expect(res.status).toBe(200)
    expect(res.body.data.list.map((r: any) => r.outboundNo)).toEqual([ob1, ob3, ob2])
  })

  it('sortField=totalCost&sortOrder=asc → 金额升序', async () => {
    const res = await listNos({ sortField: 'totalCost', sortOrder: 'asc' })
    expect(res.status).toBe(200)
    expect(res.body.data.list.map((r: any) => r.outboundNo)).toEqual([ob1, ob2, ob3])
  })

  it('sortField=totalCost&sortOrder=desc → 金额降序', async () => {
    const res = await listNos({ sortField: 'totalCost', sortOrder: 'desc' })
    expect(res.body.data.list.map((r: any) => r.outboundNo)).toEqual([ob3, ob2, ob1])
  })

  it('sortField=quantity&sortOrder=asc → 数量升序（跨明细汇总，非金额序）', async () => {
    const res = await listNos({ sortField: 'quantity', sortOrder: 'asc' })
    expect(res.body.data.list.map((r: any) => r.outboundNo)).toEqual([ob3, ob2, ob1])
  })

  it('sortField=quantity&sortOrder=desc → 数量降序', async () => {
    const res = await listNos({ sortField: 'quantity', sortOrder: 'desc' })
    expect(res.body.data.list.map((r: any) => r.outboundNo)).toEqual([ob1, ob2, ob3])
  })

  it('sortOrder 大小写不敏感（ASC 归一为升序）', async () => {
    const res = await listNos({ sortField: 'createdAt', sortOrder: 'ASC' })
    expect(res.status).toBe(200)
    expect(res.body.data.list.map((r: any) => r.outboundNo)).toEqual([ob2, ob3, ob1])
  })

  it('非白名单排序列 → 400 拒绝（不落入 ORDER BY）', async () => {
    const res = await listNos({ sortField: 'operator' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_PARAMETER')
  })

  it('SQL 注入式排序列 → 400 拒绝', async () => {
    const res = await listNos({ sortField: 'created_at; DROP TABLE outbound_records' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_PARAMETER')
    // 表仍在：注入未生效
    const stillThere = db.prepare("SELECT COUNT(*) as c FROM outbound_records").get() as any
    expect(stillThere.c).toBeGreaterThanOrEqual(3)
  })

  it('非法排序方向 → 400 拒绝', async () => {
    const res = await listNos({ sortField: 'totalCost', sortOrder: 'sideways' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_PARAMETER')
  })

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    '原型链键 %s 不绕过白名单 → 400（而非落入破损 ORDER BY 报 500）',
    async (key) => {
      const res = await listNos({ sortField: key })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('INVALID_PARAMETER')
    }
  )
})

describe('出库排序：跨全部分页真排序 + 同值稳定 tiebreaker', () => {
  let app: any
  let db: any
  let token: string
  let projectId: string

  async function nosOf(query: Record<string, string>) {
    const res = await request(app)
      .get('/api/v1/outbound')
      .query({ projectId, sortField: 'totalCost', sortOrder: 'asc', ...query })
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    return res.body.data.list.map((r: any) => r.outboundNo) as string[]
  }

  beforeAll(async () => {
    ;({ app, db } = await getApp())
    token = await loginAdmin(app)
    const suffix = `paged-${Date.now()}`
    const f = seed(db, suffix)
    // 只需 matB（单价 100）即可用整数金额编排
    const inb = await request(app)
      .post('/api/v1/inbound')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'direct', materialId: f.matB, batchNo: `B-${f.matB}`, quantity: 200, price: 100, supplierId: f.supplierId, locationId: f.locationId, expiryDate: '2030-12-31' })
    expect(inb.status).toBe(201)

    const projRes = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: `P-PAGED-${suffix}`, name: '分页排序项目', type: 'ihc', status: 'active' })
    expect(projRes.status).toBe(201)
    projectId = projRes.body.data.id

    // 5 单：金额 100 / 200 / 200 / 300 / 400 —— 两单同为 200，用于压中 tiebreaker
    for (const qty of [1, 2, 2, 3, 4]) {
      const res = await request(app)
        .post('/api/v1/outbound')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'project', projectId, items: [{ materialId: f.matB, quantity: qty }] })
      expect(res.status).toBe(201)
    }
  })

  it('金额升序整页顺序：100,200,200,300,400（同值相邻）', async () => {
    const res = await request(app)
      .get('/api/v1/outbound')
      .query({ projectId, sortField: 'totalCost', sortOrder: 'asc', pageSize: '50' })
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.list.map((r: any) => r.totalCost)).toEqual([100, 200, 200, 300, 400])
  })

  it('pageSize=2 逐页拼接 === 整页顺序（证明后端跨全部分页真排序，非仅当前页；边界压在同值对上验 tiebreaker 稳定、不重不漏）', async () => {
    const full = await nosOf({ pageSize: '50' })
    expect(full).toHaveLength(5)

    const p1 = await nosOf({ pageSize: '2', page: '1' })
    const p2 = await nosOf({ pageSize: '2', page: '2' })
    const p3 = await nosOf({ pageSize: '2', page: '3' })
    expect(p1).toHaveLength(2)
    expect(p2).toHaveLength(2)
    expect(p3).toHaveLength(1)

    const stitched = [...p1, ...p2, ...p3]
    // 跨页拼接必须逐位等于整页顺序：若 ORDER BY 被误改成「仅当前页排序」或 tiebreaker 缺失，
    // 同值对会在分页边界抖动 → 顺序不符 / 出现重复或遗漏。
    expect(stitched).toEqual(full)
    expect(new Set(stitched).size).toBe(5) // 不重不漏
  })
})
