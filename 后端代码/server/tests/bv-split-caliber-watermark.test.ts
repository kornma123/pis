/**
 * 止损执法点 · 拆分口径未认账水印（LEG-2 / 公理一）—— HTTP 集成回归门禁。
 *
 * 守：① 每个**消费拆分结论**的对外输出响应都带 `caliberRatification`（ratified=false·同视线水印）；
 *     ② 水印是**附加字段**——原数字字段与之并存、值不变（golden 零回归·additive 不动钱）；
 *     ③ 精度：裸时序数组端点(/trend)形状不改；非拆分消费端点(cross-partner-audit)**不误挂**水印。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin, loginAs } from './p0-harness.js'
import { v4 as uuidv4 } from 'uuid'
import { SPLIT_FORMULA_VERSION } from '../src/utils/statement-revenue.js'

let app: any, db: any, adminToken = '', financeToken = ''
const PID = 'PT-WM-1'
const MONTH = '2026-06'

async function st() { return (await import('supertest')).default }

/** 断言一个响应携带的水印为「未认账」形态。 */
function expectUnratifiedWatermark(cr: any) {
  expect(cr).toBeTruthy()
  expect(cr.ratified).toBe(false)
  expect(cr.state).toBe('UNRATIFIED')
  expect(cr.label).toBe('口径未经业务认账')
  expect(cr.sourceTag).toBe('derived')
  expect(cr.basisVersion).toBe(SPLIT_FORMULA_VERSION)
  expect(cr.ratifiedAt).toBeNull()
}

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'WM-1', '水印测试医院', 1)`).run(PID)
  // 一条含 lab_revenue 的 case_revenue（供 partner-pnl / hospital-cm / account-reconcile 有数）
  db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, partner_name, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, 'WM-CASE-1', ?, '水印测试医院', ?, 1000, 830, 830, 'statement')`)
    .run(`CR-${uuidv4()}`, PID, MONTH)

  const authRoutes = (await import('../src/routes/auth.js')).default
  const pnlRoutes = (await import('../src/routes/partner-pnl-v1.1.js')).default
  const hospPnlRoutes = (await import('../src/routes/hospital-pnl-v1.1.js')).default
  const reconRoutes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const impRoutes = (await import('../src/routes/statement-import-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/partner-pnl', router: pnlRoutes },
    { path: '/api/v1/hospital-pnl', router: hospPnlRoutes },
    { path: '/api/v1/account-reconcile', router: reconRoutes, middleware: [authenticateToken, requirePermission('account_reconcile', 'R')] },
    { path: '/api/v1/statement-import', router: impRoutes },
  ])
  adminToken = await loginAdmin(app)
  financeToken = await loginAs(app, 'caiwu', 'CoreOne2026!')
})

const A = (r: any) => r.set('Authorization', `Bearer ${adminToken}`)

describe('拆分结论对外输出携带未认账水印', () => {
  it('GET /partner-pnl（列表）带水印·且 labRevenueTotal 数字并存不变', async () => {
    const r = await A((await st())(app).get(`/api/v1/partner-pnl?serviceMonth=${MONTH}`))
    expect(r.status).toBe(200)
    expectUnratifiedWatermark(r.body.data.caliberRatification)
    const p = r.body.data.list.find((x: any) => x.partnerId === PID)
    expect(p.labRevenueTotal).toBe(830) // 水印是 additive：拆分数字字段仍在、值不变
  })

  it('GET /partner-pnl/cases（列表）带水印', async () => {
    const r = await A((await st())(app).get(`/api/v1/partner-pnl/cases?serviceMonth=${MONTH}&partnerId=${PID}`))
    expectUnratifiedWatermark(r.body.data.caliberRatification)
  })

  it('GET /hospital-pnl（对照表）带水印', async () => {
    const r = await A((await st())(app).get(`/api/v1/hospital-pnl?serviceMonth=${MONTH}`))
    expect(r.status).toBe(200)
    expectUnratifiedWatermark(r.body.data.caliberRatification)
  })

  it('GET /hospital-pnl/health（体检）带水印·且既有 shadowNote 并存', async () => {
    const r = await A((await st())(app).get(`/api/v1/hospital-pnl/health?serviceMonth=${MONTH}`))
    expect(r.status).toBe(200)
    expectUnratifiedWatermark(r.body.data.caliberRatification)
    expect(r.body.data.shadowNote).toBeTruthy() // 与既有影子模式提示并存·不互相覆盖
  })

  it('GET /account-reconcile/overview（复核总览）带水印·且 board 并存', async () => {
    const r = await A((await st())(app).get(`/api/v1/account-reconcile/overview?serviceMonth=${MONTH}`))
    expect(r.status).toBe(200)
    expectUnratifiedWatermark(r.body.data.caliberRatification)
    expect(r.body.data.board).toBeTruthy()
  })

  it('POST /statement-import/preview 带水印·且 revenue.labRevenue 并存', async () => {
    const grid = [
      ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
      ['WM-P-1', '手术标本检查与诊断', '190', '0.8', '152'],
      ['合计', '', '190', '', '152'],
    ]
    const r = await (await st())(app).post('/api/v1/statement-import/preview')
      .set('Authorization', `Bearer ${financeToken}`).send({ partnerId: PID, grid })
    expect(r.status).toBe(200)
    expectUnratifiedWatermark(r.body.data.caliberRatification)
    expect(typeof r.body.data.revenue.labRevenue).toBe('number')
  })
})

describe('精度：不误挂 / 不改形状', () => {
  it('GET /partner-pnl/trend 仍是裸时序数组（形状不改·防破坏消费者）', async () => {
    const r = await A((await st())(app).get(`/api/v1/partner-pnl/trend?partnerId=${PID}`))
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.data)).toBe(true) // 未被包成 {trend,caliberRatification}
  })

  it('GET /partner-pnl/cross-partner-audit（非拆分消费）不挂水印', async () => {
    const r = await A((await st())(app).get('/api/v1/partner-pnl/cross-partner-audit'))
    expect(r.status).toBe(200)
    expect(r.body.data?.caliberRatification).toBeUndefined() // 只给真正消费拆分结论的输出打水印
  })
})
