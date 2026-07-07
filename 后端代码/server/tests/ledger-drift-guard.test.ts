/**
 * 库存双账本守恒守卫（非-P0 审计项 A）回归门禁。
 *
 * 背景：不变量 inventory.stock == Σ(batches.remaining WHERE status=1) 被出库按 FEFO 派生单位成本依赖，
 * 但 returns/scraps/stocktaking 只改 stock 不碰 batches → 出现「库存足却无可消耗批次」漂移。
 * 旧三处 `unitCost = batch?.inbound_price || 0` 在漂移时**静默回退 0** → 成本单向算低 → 喂低 P0 CM 分母。
 *
 * 红→绿：改造前出库缺批次 unit_cost 静默=0；本文件断言缺批次时按物料均价/基准价兜底(绝不 0)、落漂移告警，
 * 并单测纯 resolver（batch/avg/price/none/strict）与体检 findLedgerDriftMaterials。
 */
process.env.DATABASE_PATH = ':memory:'

import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { resolveOutboundUnitCost, LedgerDriftError } from '../src/utils/outbound-cost.js'
import { findLedgerDriftMaterials } from '../src/utils/inventory-consistency.js'

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
/** 直接播种 物料+库存(+可选批次)。batchPrice=null → 不建批次(制造漂移)。 */
function seed(opts: { stock: number; materialPrice?: number; batchPrice?: number | null; batchStatus?: number; batchRemaining?: number }): string {
  const s = `ld-${++seq}-${Date.now()}`
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
    db.prepare('INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, supplier_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`bat-${s}`, matId, `B-${s}`, opts.stock, remaining, `ib-${s}`, opts.batchPrice, supId, status)
  }
  return matId
}

async function outbound(materialId: string, quantity: number) {
  return request(app).post('/api/v1/outbound').set('Authorization', `Bearer ${token}`)
    .send({ type: 'project', items: [{ materialId, quantity }], operator: 'test' })
}
function itemOf(materialId: string): any {
  return db.prepare('SELECT unit_cost, total_cost, batch_id FROM outbound_items WHERE material_id = ? ORDER BY id DESC LIMIT 1').get(materialId)
}
function driftExceptionCount(materialId: string): number {
  return Number((db.prepare("SELECT COUNT(*) c FROM cost_exceptions WHERE exception_type = 'ledger_drift' AND details LIKE ?").get(`%${materialId}%`) as any).c)
}

beforeAll(async () => {
  ;({ app, db } = await getApp())
  token = await loginAdmin()
})

describe('resolveOutboundUnitCost 纯函数（warn 默认 + strict）', () => {
  it('LD-U1 正常路径：选到批次且单价>0 → 用批次价，drift=false', () => {
    const r = resolveOutboundUnitCost(db, 'any', { inbound_price: 21 })
    expect(r).toMatchObject({ unitCost: 21, source: 'batch', drift: false })
  })
  it('LD-U2 缺批次 + 物料有历史批次均价 → 均价兜底(绝不0)，drift=true', () => {
    const mat = seed({ stock: 10, batchPrice: 12, batchStatus: 0, batchRemaining: 0 }) // 已耗尽批次仍留价
    const r = resolveOutboundUnitCost(db, mat, undefined)
    expect(r.drift).toBe(true)
    expect(r.source).toBe('material_avg')
    expect(r.unitCost).toBeCloseTo(12, 4)
  })
  it('LD-U3 缺批次 + 无历史批次价 + 物料基准价 → 基准价兜底(绝不0)', () => {
    const mat = seed({ stock: 10, materialPrice: 8, batchPrice: null })
    const r = resolveOutboundUnitCost(db, mat, undefined)
    expect(r).toMatchObject({ source: 'material_price', drift: true })
    expect(r.unitCost).toBeCloseTo(8, 4)
  })
  it('LD-U4 缺批次 + 无任何价格来源 → 显式 drift、source=none、unitCost=0（非静默）', () => {
    const mat = seed({ stock: 10, materialPrice: 0, batchPrice: null })
    const r = resolveOutboundUnitCost(db, mat, undefined)
    expect(r).toMatchObject({ source: 'none', drift: true, unitCost: 0 })
    expect(r.note).toContain('须补价')
  })
  it('LD-U5 strict 模式缺批次 → 抛 LEDGER_DRIFT(409)，不回退', () => {
    const mat = seed({ stock: 10, materialPrice: 8, batchPrice: null })
    expect(() => resolveOutboundUnitCost(db, mat, undefined, 'strict')).toThrow(LedgerDriftError)
    try { resolveOutboundUnitCost(db, mat, undefined, 'strict') } catch (e: any) {
      expect(e.code).toBe('LEDGER_DRIFT'); expect(e.http).toBe(409)
    }
  })
  it('LD-U6 批次存在但价为 0（真赠品/免费入库）→ 尊重真实零价(source=batch, drift=false)，不误报漂移不抬价', () => {
    // 对抗复核 D1：漂移主信号是「批次行缺失」而非「价>0」；present 零价批次是合法业务，不得塌进漂移兜底
    const r = resolveOutboundUnitCost(db, 'any', { id: 'b1', inbound_price: 0 })
    expect(r).toMatchObject({ unitCost: 0, source: 'batch', drift: false })
  })
  it('LD-U7 批次存在但价 NaN/负数 = 数据异常 → 兜底（不用负成本、不静默）', () => {
    const mat = seed({ stock: 10, materialPrice: 7, batchPrice: null })
    expect(resolveOutboundUnitCost(db, mat, { id: 'b', inbound_price: 'x' }).source).not.toBe('batch')
    const neg = resolveOutboundUnitCost(db, mat, { id: 'b', inbound_price: -5 })
    expect(neg.source).not.toBe('batch')
    expect(neg.unitCost).toBeGreaterThanOrEqual(0)
  })
})

describe('findLedgerDriftMaterials 对账体检', () => {
  it('LD-R1 正向漂移(stock>Σremaining) 被检出、drift>0', () => {
    const mat = seed({ stock: 10, batchPrice: null }) // 有库存无批次 → +10 漂移
    const rows = findLedgerDriftMaterials(db, true)
    const hit = rows.find((r) => r.materialId === mat)
    expect(hit).toBeTruthy()
    expect(hit!.drift).toBeCloseTo(10, 4)
  })
  it('LD-R2 账实相符(stock==Σremaining) 不报', () => {
    const mat = seed({ stock: 10, batchPrice: 5 }) // 批次 remaining=10 == stock
    expect(findLedgerDriftMaterials(db).find((r) => r.materialId === mat)).toBeFalsy()
  })
})

describe('出库 HTTP 集成：缺批次绝不静默 0 + 落漂移告警', () => {
  it('LD-I1 正常有批次出库 → unit_cost=批次价，无 ledger_drift 告警', async () => {
    const mat = seed({ stock: 10, batchPrice: 21 })
    const res = await outbound(mat, 4)
    expect(res.body.success).toBe(true)
    expect(Number(itemOf(mat).unit_cost)).toBeCloseTo(21, 4)
    expect(driftExceptionCount(mat)).toBe(0)
  })
  it('LD-I2 漂移出库(有库存无批次·物料基准价8) → unit_cost=8(非0) + 落 1 条 ledger_drift 告警', async () => {
    const mat = seed({ stock: 10, materialPrice: 8, batchPrice: null })
    const res = await outbound(mat, 5)
    expect(res.body.success).toBe(true)
    const it = itemOf(mat)
    expect(Number(it.unit_cost)).toBeCloseTo(8, 4) // 核心不变量：绝不静默 0
    expect(Number(it.total_cost)).toBeCloseTo(40, 4)
    expect(it.batch_id).toBeNull()
    expect(driftExceptionCount(mat)).toBe(1)
  })
  it('LD-I3 漂移出库回归旧病：unit_cost 不得为 0（有价格来源时）', async () => {
    const mat = seed({ stock: 10, materialPrice: 6, batchPrice: null })
    await outbound(mat, 3)
    expect(Number(itemOf(mat).unit_cost)).not.toBe(0)
  })
  it('LD-I4 有活跃批次但零价（真赠品）→ unit_cost=0、无 ledger_drift 假告警（对抗复核 D1）', async () => {
    const mat = seed({ stock: 10, batchPrice: 0 }) // 活跃批次 remaining=10、inbound_price=0
    const res = await outbound(mat, 4)
    expect(res.body.success).toBe(true)
    expect(Number(itemOf(mat).unit_cost)).toBe(0) // 尊重真实零价，不抬到均价
    expect(itemOf(mat).batch_id).not.toBeNull() // 用了真实批次
    expect(driftExceptionCount(mat)).toBe(0) // 不落假漂移告警
  })
})
