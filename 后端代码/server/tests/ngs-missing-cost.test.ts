/**
 * PRD-0 T3 — NGS 缺成本/售价质量标记（TC5）。
 *
 * §7.2 口径：
 *  - 缺售价 = 硬 400（无法确定收入金额，不落库）。
 *  - 缺外包成本 = 允许落库但写质量标记 cost_confirmed=0；院级 P&L 默认排除正常毛利（单列「未核 NGS 毛利」），不得按 0 成本计入。
 *  - 响应返回 missingPriceCount / missingCostCount。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { buildPartnerPnl, loadNgsByPartner } from '../src/utils/partner-pnl-service.js'

let app: any, db: any, financeToken = ''
const PID = 'PT-NGSQ'

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function imp(orders: any[], confirm?: boolean) {
  const request = (await import('supertest')).default
  return request(app).post('/api/v1/ngs/import').set('Authorization', `Bearer ${financeToken}`).send({ orders, confirm })
}

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,service_scope,status) VALUES (?, 'PT-NGSQ','NGS质量医院','technical_only',1)`).run(PID)
  const authRoutes = (await import('../src/routes/auth.js')).default
  const ngsRoutes = (await import('../src/routes/ngs-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/ngs', router: ngsRoutes },
  ])
  financeToken = await login('caiwu', 'CoreOne2026!')
})

describe('TC5 缺售价 → 硬 400', () => {
  it('订单有成本无售价 → 400，不落库', async () => {
    const res = await imp([{ 订单号: 'NP1', 产品名称: 'panel大', 送检医院: 'NGS质量医院', 外包成本: 1000 }])
    expect(res.status).toBe(400)
    const cnt = (db.prepare(`SELECT COUNT(*) t FROM ngs_orders WHERE order_no='NP1'`).get() as any).t
    expect(cnt).toBe(0)
  })
})

describe('TC5 缺外包成本 → confirm 门禁 + 质量标记 + P&L 排除', () => {
  it('无成本且未 confirm → 409 NEEDS_CONFIRM，不落库', async () => {
    const res = await imp([{ 订单号: 'NC1', 产品名称: 'panel小', 送检医院: 'NGS质量医院', 售价: 8500 }])
    expect(res.status).toBe(409)
    expect((db.prepare(`SELECT COUNT(*) t FROM ngs_orders WHERE order_no='NC1'`).get() as any).t).toBe(0)
  })

  it('confirm:true → 200 落库，标 cost_confirmed=0，响应返回 missingPriceCount/missingCostCount', async () => {
    // 同批含一单成本齐全（NC2）+ 一单缺成本（NC1）
    const res = await imp([
      { 订单号: 'NC1', 产品名称: 'panel小', 送检医院: 'NGS质量医院', 售价: 8500 },
      { 订单号: 'NC2', 产品名称: 'panel齐', 送检医院: 'NGS质量医院', 售价: 9000, 外包成本: 1400 },
    ], true)
    expect(res.status).toBe(200)
    expect(res.body.data.missingCostCount).toBe(1)
    expect(res.body.data.missingPriceCount).toBe(0)
    const nc1 = db.prepare(`SELECT cost_confirmed, outsource_cost FROM ngs_orders WHERE order_no='NC1'`).get() as any
    const nc2 = db.prepare(`SELECT cost_confirmed FROM ngs_orders WHERE order_no='NC2'`).get() as any
    expect(Number(nc1.cost_confirmed)).toBe(0) // 缺成本 → 标记未核
    expect(Number(nc2.cost_confirmed)).toBe(1) // 成本齐全 → 已核
  })

  it('院级 P&L：未核成本单不进正常毛利，单列「未核 NGS 毛利」', () => {
    const agg = loadNgsByPartner(db).get(PID)!
    // 正常路径只含 NC2（成本齐全）：收入 9000 / 成本 1400 / 毛利 7600
    expect(agg.revenue).toBe(9000)
    expect(agg.cost).toBe(1400)
    expect(agg.margin).toBe(7600)
    expect(agg.orderCount).toBe(1)
    // 未核成本单 NC1：收入单列、不进毛利
    expect(agg.unconfirmedRevenue).toBe(8500)
    expect(agg.unconfirmedCount).toBe(1)

    const pnl = buildPartnerPnl(db, { partnerId: PID }).find((p) => p.partnerId === PID)!
    expect(pnl.ngsMargin).toBe(7600) // 不含 NC1 的 8500「伪毛利」
    expect(pnl.ngsUnconfirmedRevenue).toBe(8500)
    expect(pnl.ngsUnconfirmedCount).toBe(1)
    expect(pnl.totalMargin).toBe(7600) // 院内 0 + NGS 正常毛利 7600（未核单不污染）
  })
})
