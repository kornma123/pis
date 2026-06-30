/**
 * W7 后端聚合 + 导入向导 API —— case 级 CM 筛查(负毛利) / 月度趋势 / 账单·LIS 干跑预览。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { v4 as uuidv4 } from 'uuid'

let app: any, db: any, adminToken = ''
const PID = 'PT-VIEW-1'
async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function req() { return (await import('supertest')).default }

function lis(caseNo: string, he: number, block: number, ihc: number) {
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, he_slide_count, block_count, ihc_count, specimen_type) VALUES (?, ?, ?, ?, ?, ?, 'tissue')`).run(`LC-${uuidv4()}`, caseNo, PID, he, block, ihc)
}
function rev(caseNo: string, net: number, month: string) {
  db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, partner_name, net_amount, gross_amount, discount_rate, service_month, line_count) VALUES (?, ?, ?, '趋势医院', ?, ?, 0.8, ?, 1)`).run(`CR-${uuidv4()}`, caseNo, PID, net, net, month)
}
function cost(caseNo: string, total: number, month: string) {
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, case_no, partner_id, total_cost, cost_month, cost_status) VALUES (?, ?, ?, ?, ?, ?, 'costed')`).run(`OAD-${uuidv4()}`, `OB-${uuidv4()}`, caseNo, PID, total, month)
}

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'PT-V0001', '趋势医院', 'with_diagnosis', 1)`).run(PID)
  // 2026-06：CMA 盈利(lab2100-cost800=+1300) / CMB 亏损(lab100-cost300=-200)
  lis('CMA', 5, 5, 2); rev('CMA', 2100, '2026-06'); cost('CMA', 800, '2026-06')
  lis('CMB', 0, 1, 0); rev('CMB', 100, '2026-06'); cost('CMB', 300, '2026-06')
  // 2026-05：CMC(lab500-cost200=+300)
  lis('CMC', 2, 1, 0); rev('CMC', 500, '2026-05'); cost('CMC', 200, '2026-05')

  const authRoutes = (await import('../src/routes/auth.js')).default
  const pnlRoutes = (await import('../src/routes/partner-pnl-v1.1.js')).default
  const crRoutes = (await import('../src/routes/case-revenue-v1.1.js')).default
  const lisRoutes = (await import('../src/routes/lis-cases-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/partner-pnl', router: pnlRoutes },
    { path: '/api/v1/case-revenue', router: crRoutes },
    { path: '/api/v1/lis-cases', router: lisRoutes },
  ])
  adminToken = await login('admin', 'admin123')
})

describe('W7 case 级 CM 筛查（负毛利）', () => {
  it('GET /cases?serviceMonth=2026-06：负毛利 CMB 置顶，CMA 毛利1300', async () => {
    const r = await (await req())(app).get('/api/v1/partner-pnl/cases?serviceMonth=2026-06&partnerId=' + PID).set('Authorization', `Bearer ${adminToken}`)
    const list = r.body.data.list
    expect(list[0].caseNo).toBe('CMB')
    expect(list[0].grossMargin).toBe(-200)
    expect(list[0].flagged).toBe(true)
    const cma = list.find((x: any) => x.caseNo === 'CMA')
    expect(cma.grossMargin).toBe(1300)
    expect(cma.flagged).toBe(false)
  })
  it('GET /cases?onlyFlagged=true：只剩亏损 case', async () => {
    const r = await (await req())(app).get('/api/v1/partner-pnl/cases?serviceMonth=2026-06&onlyFlagged=true&partnerId=' + PID).set('Authorization', `Bearer ${adminToken}`)
    expect(r.body.data.list.every((x: any) => x.flagged)).toBe(true)
    expect(r.body.data.list.map((x: any) => x.caseNo)).toContain('CMB')
    expect(r.body.data.list.map((x: any) => x.caseNo)).not.toContain('CMA')
  })
})

describe('W7 月度趋势 + benchmark', () => {
  it('GET /trend：2026-05(毛利300) → 2026-06(毛利1100)', async () => {
    const r = await (await req())(app).get('/api/v1/partner-pnl/trend?partnerId=' + PID).set('Authorization', `Bearer ${adminToken}`)
    const pts = r.body.data
    expect(pts.map((p: any) => p.serviceMonth)).toEqual(['2026-05', '2026-06'])
    expect(pts[0].grossMargin).toBe(300)
    expect(pts[1].grossMargin).toBe(1100) // 2200-1100
    expect(pts[1].caseCount).toBe(2)
  })
  it('GET / 含 benchmark（avg per case + 未校正标注）', async () => {
    const r = await (await req())(app).get('/api/v1/partner-pnl?serviceMonth=2026-06').set('Authorization', `Bearer ${adminToken}`)
    const p = r.body.data.list.find((x: any) => x.partnerId === PID)
    expect(p.avgLabRevenuePerCase).toBe(1100) // 2200/2
    expect(p.benchmarkCorrected).toBe(false)
  })
})

describe('W7 导入向导：干跑预览（不落库）', () => {
  it('POST /case-revenue/preview：汇总 + 未命中 LIS 预警，且不写库', async () => {
    const before = (db.prepare("SELECT COUNT(*) c FROM case_revenue").get() as any).c
    const lines = [
      { 序号: 1, 病理号: 'CMA', 送检医院: '趋势医院', 收费代码: '270300002b', 计费金额: 100, 扣率: '80%', 开单金额: 80, 计费时间: '2026-06-01' },
      { 序号: 1, 病理号: 'PREVIEW-X', 送检医院: '趋势医院', 收费代码: '270300002b', 计费金额: 100, 扣率: '80%', 开单金额: 80, 计费时间: '2026-06-01' },
    ]
    const r = await (await req())(app).post('/api/v1/case-revenue/preview').set('Authorization', `Bearer ${adminToken}`).send({ lines })
    expect(r.status).toBe(200)
    expect(r.body.data.caseCount).toBe(2)
    expect(r.body.data.unmatchedToLis).toBe(1)
    expect(r.body.data.unmatchedCases).toContain('PREVIEW-X')
    expect(r.body.data.warnings.length).toBeGreaterThan(0)
    const after = (db.prepare("SELECT COUNT(*) c FROM case_revenue").get() as any).c
    expect(after).toBe(before) // 未落库
  })
  it('POST /lis-cases/preview：新建医院预判 + 样本分布，且不写库', async () => {
    const before = (db.prepare("SELECT COUNT(*) c FROM partners").get() as any).c
    const cases = [
      { 病理号: 'PV1', 送检医院: '趋势医院', 送检部位: '淋巴结', 蜡块数: 1 },
      { 病理号: 'PV2', 送检医院: '预览新医院', 送检部位: '胸水', 蜡块数: 1 },
      { 病理号: '', 送检医院: '' },
    ]
    const r = await (await req())(app).post('/api/v1/lis-cases/preview').set('Authorization', `Bearer ${adminToken}`).send({ cases })
    expect(r.body.data.valid).toBe(2)
    expect(r.body.data.skipped).toBe(1)
    expect(r.body.data.newHospitals).toContain('预览新医院')
    expect(r.body.data.newHospitals).not.toContain('趋势医院')
    expect(r.body.data.specimenDistribution.cytology).toBe(1) // 胸水
    expect(r.body.data.specimenDistribution.tissue).toBe(1)
    const after = (db.prepare("SELECT COUNT(*) c FROM partners").get() as any).c
    expect(after).toBe(before) // 未建院
  })
})
