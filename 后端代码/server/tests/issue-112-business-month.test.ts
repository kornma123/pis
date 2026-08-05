/**
 * Issue #112 回归：出库成本异常（ledger_drift）缺省 yearMonth 必须采用服务端
 * Asia/Shanghai 业务月份（shanghaiBusinessMonth），而不是 UTC 月份。
 *
 * 证据分层：
 * 1) 单位层：recordCostException 缺省月份在月界/年界/普通日上的确定性断言（冻结时钟）；
 * 2) 路由层：/api/v1/outbound 创建漂移路径写入 cost_exceptions.year_month
 *    与服务端上海业务月份一致；完成态更新按 G2 合同 fail closed 且零写；
 * 3) 共享函数等价证明：recordLedgerDrift 调用 recordCostException 时显式传入
 *    shanghaiBusinessMonth()（mutation「漏传业务月份」会精确变红）。
 */
process.env.DATABASE_PATH = ':memory:'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-issue112-at-least-32-characters'

import { describe, it, expect, beforeAll, vi } from 'vitest'
import request from 'supertest'
import { recordCostException } from '../src/utils/cost-exceptions.js'
import { shanghaiBusinessMonth } from '../src/utils/business-time.js'

// 包装真实实现：既有调用链照常写库，同时可断言 recordLedgerDrift 是否显式传入业务月份。
vi.mock('../src/utils/cost-exceptions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/cost-exceptions.js')>()
  return { ...actual, recordCostException: vi.fn(actual.recordCostException) }
})

const getApp = async () => {
  const { default: app } = await import('../src/app.js')
  const { getDatabase } = await import('../src/database/DatabaseManager.js')
  return { app, db: getDatabase() }
}

let app: any
let db: any
let token: string

async function loginAdmin(): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })
  expect(res.status).toBe(200)
  return res.body.data.token
}

let seq = 0
/** 直接播种 物料+库存+批次。batchPrice 负数/非法 → 批次在但价异常 → 双账本漂移告警路径。 */
function seed(opts: { stock: number; materialPrice?: number; batchPrice?: number | null; batchStatus?: number; batchRemaining?: number }): string {
  const s = `i112-${++seq}-${Date.now()}`
  const catId = `cat-${s}`, supId = `sup-${s}`, locId = `loc-${s}`, matId = `mat-${s}`
  db.prepare('INSERT INTO material_categories (id, code, name, level) VALUES (?, ?, ?, 1)').run(catId, `C-${s}`, '分类')
  db.prepare('INSERT INTO suppliers (id, code, name, status) VALUES (?, ?, ?, 1)').run(supId, `S-${s}`, '供应商')
  db.prepare("INSERT INTO locations (id, code, name, type, zone, status) VALUES (?, ?, ?, 'shelf', 'A', 1)").run(locId, `L-${s}`, '库位')
  db.prepare('INSERT INTO materials (id, code, name, spec, unit, category_id, supplier_id, price, location_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
    .run(matId, `M-${s}`, '物料', '1ml', '瓶', catId, supId, opts.materialPrice ?? 0, locId)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock, location_id) VALUES (?, ?, ?, 0, ?)').run(`inv-${s}`, matId, opts.stock, locId)
  if (opts.batchPrice !== null && opts.batchPrice !== undefined) {
    const status = opts.batchStatus ?? 1
    const remaining = opts.batchRemaining ?? opts.stock
    const batchId = `bat-${s}`
    db.prepare('INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, supplier_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(batchId, matId, `B-${s}`, opts.stock, remaining, `ib-${s}`, opts.batchPrice, supId, status)
    if (status === 1 && remaining > 0) {
      db.prepare(`
        INSERT INTO inventory_positions (id, material_id, batch_id, location_id, quantity)
        VALUES (?, ?, ?, ?, ?)
      `).run(`pos-${s}`, matId, batchId, locId, remaining)
    }
  }
  return matId
}

function createOutbound(materialId: string, quantity: number) {
  return request(app).post('/api/v1/outbound')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'project', items: [{ materialId, quantity }], operator: 'i112-test' })
}

function updateOutbound(id: string, materialId: string, quantity: number) {
  return request(app).put(`/api/v1/outbound/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ materialId, quantity }], operator: 'i112-test' })
}

function driftRows(outboundId: string): any[] {
  return db.prepare(`
    SELECT id, year_month, exception_type, source_type
      FROM cost_exceptions
     WHERE outbound_id = ? AND exception_type = 'ledger_drift'
     ORDER BY rowid ASC
  `).all(outboundId)
}

function explicitBusinessMonthCalls(outboundId: string): any[] {
  return vi.mocked(recordCostException).mock.calls
    .map((call) => call[1])
    .filter((input: any) => input?.sourceModule === 'outbound' && input?.sourceType === 'ledger_drift' && input?.outboundId === outboundId)
}

beforeAll(async () => {
  ;({ app, db } = await getApp())
  token = await loginAdmin()
})

describe('recordCostException 缺省月份：服务端 Asia/Shanghai 业务月份（Issue #112）', () => {
  it.each([
    ['上海月界前最后一分钟（UTC 与上海同月）', '2026-08-31T15:59:00.000Z', '2026-08'],
    ['上海月界后第一分钟（UTC 仍为 8 月）', '2026-08-31T16:00:00.000Z', '2026-09'],
    ['上海月界后半小时（UTC 仍为 8 月）', '2026-08-31T16:30:00.000Z', '2026-09'],
    ['上海年界后第一分钟（UTC 仍为 12 月）', '2026-12-31T16:00:00.000Z', '2027-01'],
    ['普通日对照稳定', '2026-08-15T12:00:00.000Z', '2026-08'],
  ])('%s：缺省 yearMonth → %s', (_label, instant, expected) => {
    vi.setSystemTime(new Date(instant))
    try {
      const rec = recordCostException(db, {
        sourceModule: 'i112-unit', sourceType: 'issue112', exceptionType: 'issue112',
        message: 'issue112 default business month',
      })
      const row = db.prepare('SELECT year_month FROM cost_exceptions WHERE id = ?').get(rec.id) as any
      expect(row.year_month).toBe(expected)
      expect(shanghaiBusinessMonth(new Date(instant))).toBe(expected)
    } finally {
      vi.useRealTimers()
    }
  })

  it('显式合法 yearMonth 原样保存，不被服务端月份覆盖', () => {
    // 独立冻结时刻（上海 2026-10，UTC 2026-09），避免与矩阵用例共用同一毫秒撞 generateNo 序号。
    vi.setSystemTime(new Date('2026-09-30T16:30:00.000Z'))
    try {
      const rec = recordCostException(db, {
        sourceModule: 'i112-unit', sourceType: 'issue112', exceptionType: 'issue112',
        yearMonth: '2026-07', message: 'issue112 explicit month',
      })
      const row = db.prepare('SELECT year_month FROM cost_exceptions WHERE id = ?').get(rec.id) as any
      expect(row.year_month).toBe('2026-07')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('活跃 /api/v1/outbound 漂移路径使用服务端业务月份（Issue #112）', () => {
  it('创建路径：上海月界后（16:00Z）落库月份 = 2026-09，且显式传入共享业务月份', async () => {
    vi.setSystemTime(new Date('2026-08-31T16:00:00.000Z'))
    try {
      // 内存库隔离：清除单位层用例留下的同刻记录，避免 generateNo 撞号（vitest 用例间模块状态复位）。
      db.exec('DELETE FROM cost_exceptions')
      token = await loginAdmin()
      const mat = seed({ stock: 10, materialPrice: 8, batchPrice: -1 })
      const res = await createOutbound(mat, 4)
      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      const rows = driftRows(res.body.data.id)
      expect(rows.length).toBe(1)
      expect(rows[0].year_month).toBe('2026-09')
      const calls = explicitBusinessMonthCalls(res.body.data.id)
      expect(calls.length).toBe(1)
      expect(calls[0].yearMonth).toBe(shanghaiBusinessMonth(new Date('2026-08-31T16:00:00.000Z')))
    } finally {
      vi.useRealTimers()
    }
  })

  it('创建路径：上海月界后半小时（16:30Z）落库月份 = 2026-09', async () => {
    vi.setSystemTime(new Date('2026-08-31T16:30:00.000Z'))
    try {
      db.exec('DELETE FROM cost_exceptions')
      token = await loginAdmin()
      const mat = seed({ stock: 10, materialPrice: 8, batchPrice: -1 })
      const res = await createOutbound(mat, 3)
      expect(res.status).toBe(201)
      const rows = driftRows(res.body.data.id)
      expect(rows.length).toBe(1)
      expect(rows[0].year_month).toBe('2026-09')
      const calls = explicitBusinessMonthCalls(res.body.data.id)
      expect(calls.length).toBe(1)
      expect(calls[0].yearMonth).toBe(shanghaiBusinessMonth(new Date('2026-08-31T16:30:00.000Z')))
    } finally {
      vi.useRealTimers()
    }
  })

  it('完成态更新路径：进入 G2 补偿链且不伪造业务月漂移事实', async () => {
    vi.setSystemTime(new Date('2026-12-31T16:00:00.000Z'))
    try {
      db.exec('DELETE FROM cost_exceptions')
      token = await loginAdmin()
      const goodMat = seed({ stock: 10, batchPrice: 21 })
      const created = await createOutbound(goodMat, 2)
      expect(created.status).toBe(201)
      expect(driftRows(created.body.data.id).length).toBe(0)

      const driftMat = seed({ stock: 10, materialPrice: 8, batchPrice: -1 })
      const before = {
        record: db.prepare('SELECT * FROM outbound_records WHERE id = ?').get(created.body.data.id),
        items: db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id').all(created.body.data.id),
        driftInventory: db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(driftMat),
        driftPositions: db.prepare('SELECT batch_id, location_id, quantity FROM inventory_positions WHERE material_id = ? ORDER BY id').all(driftMat),
      }
      const res = await updateOutbound(created.body.data.id, driftMat, 3)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('COMPENSATION_CHAIN_REQUIRED')
      expect(driftRows(created.body.data.id)).toEqual([])
      expect(explicitBusinessMonthCalls(created.body.data.id)).toEqual([])
      expect({
        record: db.prepare('SELECT * FROM outbound_records WHERE id = ?').get(created.body.data.id),
        items: db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id').all(created.body.data.id),
        driftInventory: db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(driftMat),
        driftPositions: db.prepare('SELECT batch_id, location_id, quantity FROM inventory_positions WHERE material_id = ? ORDER BY id').all(driftMat),
      }).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
