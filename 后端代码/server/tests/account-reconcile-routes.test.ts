/**
 * Phase 1 账实核对 —— 路由 + 状态机集成（设计基线 §1.4/§1.5/§4）。
 * 端到端：compute → 认定(6原因·补收gate) → 复核完成(前置=全认定) → 关账(定版) + 反向必填理由。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin, loginAs, seedReviewer } from './p0-harness.js'

const PARTNER = 'PT-RECON-1'
const MONTH = '2026-06'
let app: any
let token = ''

async function mountApp() {
  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    {
      path: '/api/v1/account-reconcile',
      router: routes,
      middleware: [authenticateToken, requirePermission('account_reconcile', 'R')],
    },
  ])
}

function seed(db: any) {
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-1', '测试医院', 1)`).run(PARTNER)
  const bill = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  // A: 免疫组化 5，与 LIS 5 相等 → 无差异
  bill.run('l-a1', 'CA', PARTNER, '免疫组化染色', 5, 100, MONTH)
  // B: 免疫组化 3，LIS 5 → 实际>账单 → 漏收 -2
  bill.run('l-b1', 'CB', PARTNER, '免疫组化染色', 3, 100, MONTH)
  // C: 免疫组化 6，LIS 4 → 账单>实际 → 计费用错 +2；特染 2，LIS 1 → +1
  bill.run('l-c1', 'CC', PARTNER, '免疫组化染色', 6, 100, MONTH)
  bill.run('l-c2', 'CC', PARTNER, '特殊染色', 2, 30, MONTH)
  const lis = db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
  lis.run('lc-a', 'CA', PARTNER, 5, 0, '2026-06-10')
  lis.run('lc-b', 'CB', PARTNER, 5, 0, '2026-06-11')
  lis.run('lc-c', 'CC', PARTNER, 4, 1, '2026-06-12')
  // 收入侧：已确认实收锚
  db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
    .run('cr-1', 'CA', PARTNER, MONTH, 1000, 830, 830)
}

let reviewerToken = ''
beforeAll(async () => {
  const db = await getDb()
  seed(db)
  await seedReviewer(db)
  app = await mountApp()
  token = await loginAdmin(app)
  reviewerToken = await loginAs(app, 'reviewer2', 'CoreOne2026!')
})

const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)

describe('账实核对路由 · compute + 总览 + 工作台', () => {
  it('POST /compute → 全对齐(正常) 出 3 条差异（B漏收/C计费用错/C特染）', async () => {
    const res = await auth(request(app).post('/api/v1/account-reconcile/compute').send({ partnerId: PARTNER, serviceMonth: MONTH }))
    expect(res.status).toBe(200)
    expect(res.body.data.matchStatus).toBe('正常')
    expect(res.body.data.diffCount).toBe(3)
  })

  it('GET /overview → 看板计入该院（待复核 1）', async () => {
    const res = await auth(request(app).get(`/api/v1/account-reconcile/overview?serviceMonth=${MONTH}`))
    expect(res.status).toBe(200)
    expect(res.body.data.board.待复核).toBe(1)
    expect(res.body.data.list[0].partnerId).toBe(PARTNER)
  })

  it('GET /workbench → 3 条差异 + 系统初判正确', async () => {
    const res = await auth(request(app).get(`/api/v1/account-reconcile/workbench?partnerId=${PARTNER}&serviceMonth=${MONTH}`))
    expect(res.status).toBe(200)
    const diffs = res.body.data.diffs as any[]
    expect(diffs.length).toBe(3)
    const bIhc = diffs.find((d) => d.caseNo === 'CB' && d.lineType === '免疫组化')
    expect(bIhc.delta).toBe(-2)
    expect(bIhc.systemHint).toBe('疑似漏收，需补收')
    const cIhc = diffs.find((d) => d.caseNo === 'CC' && d.lineType === '免疫组化')
    expect(cIhc.systemHint).toBe('疑似计费项目用错')
    expect(res.body.data.unmatched.length).toBe(0)
  })
})

describe('账实核对路由 · 认定 + 补收 gate + 复核完成前置 + 关账', () => {
  let diffs: any[] = []
  it('复核完成前置：有待认定 → 400 拒绝', async () => {
    const wb = await auth(request(app).get(`/api/v1/account-reconcile/workbench?partnerId=${PARTNER}&serviceMonth=${MONTH}`))
    diffs = wb.body.data.diffs
    const hmId = wb.body.data.hospitalMonth.id
    const res = await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${hmId}/complete`).send({}))
    expect(res.status).toBe(400)
  })

  it('认定「漏收，需补收」→ 生成补收单；其它原因不驱动补收', async () => {
    const bIhc = diffs.find((d) => d.caseNo === 'CB')
    const cIhc = diffs.find((d) => d.caseNo === 'CC' && d.lineType === '免疫组化')
    const cSs = diffs.find((d) => d.caseNo === 'CC' && d.lineType === '特染')
    let r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${bIhc.id}/verdict`).send({ reason: '漏收，需补收' }))
    expect(r.status).toBe(200)
    expect(r.body.data.followUp).toBe('supplement')
    r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${cIhc.id}/verdict`).send({ reason: '计费项目用错' }))
    expect(r.body.data.followUp).toBe('external_fix')
    r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${cSs.id}/verdict`).send({ reason: '核对无误' }))
    expect(r.body.data.pendingCount).toBe(0)

    const sup = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${MONTH}`))
    expect(sup.body.data.list.length).toBe(1)
    expect(sup.body.data.list[0].caseNo).toBe('CB')
    expect(sup.body.data.list[0].status).toBe('待补收')
    expect(sup.body.data.list[0].amount).toBe(200) // |−2|×100
  })

  it('全认定后 复核完成 → confirmed_lab_revenue=830', async () => {
    const wb = await auth(request(app).get(`/api/v1/account-reconcile/workbench?partnerId=${PARTNER}&serviceMonth=${MONTH}`))
    const hmId = wb.body.data.hospitalMonth.id
    const res = await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${hmId}/complete`).send({}))
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('复核完成')
    expect(res.body.data.confirmedLabRevenue).toBe(830)
  })

  it('反向重新打开 → 必填理由（缺理由 400）', async () => {
    const wb = await auth(request(app).get(`/api/v1/account-reconcile/workbench?partnerId=${PARTNER}&serviceMonth=${MONTH}`))
    const hmId = wb.body.data.hospitalMonth.id
    const noReason = await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${hmId}/reopen`).send({}))
    expect(noReason.status).toBe(400)
  })

  it('关账（复核完成→已关账 定版）；关账后认定被拒', async () => {
    const res = await auth(request(app).post('/api/v1/account-reconcile/close').send({ serviceMonth: MONTH, partnerIds: [PARTNER] }))
    expect(res.status).toBe(200)
    expect(res.body.data.closed).toContain(PARTNER)
    // 关账后 compute 被拒（定版不可改）
    const recompute = await auth(request(app).post('/api/v1/account-reconcile/compute').send({ partnerId: PARTNER, serviceMonth: MONTH }))
    expect(recompute.status).toBe(409)
  })

  it('补收单标记已补收 → 计入本月实收', async () => {
    const sup = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${MONTH}`))
    const soId = sup.body.data.list[0].id
    // 项D：收款前须独立签发（认定人=admin，故由 reviewer2 签发；SoD 不能自签）
    const appr = await request(app).post(`/api/v1/account-reconcile/supplements/${soId}/approve`).set('Authorization', `Bearer ${reviewerToken}`).send({})
    expect(appr.status).toBe(200)
    const res = await auth(request(app).post(`/api/v1/account-reconcile/supplements/${soId}/collect`).send({ collectedMonth: '2026-07' }))
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('已补收')
    expect(res.body.data.collectedMonth).toBe('2026-07')
  })
})

describe('账实核对路由 · 账单片数 floor（回归：statement 无 qty 也不误报 billCount=0）', () => {
  const P2 = 'PT-RECON-2'
  const M2 = '2026-05'
  it('免疫组化两行无 qty（statement 落库风格，只有 gross）→ billCount=2 行数 floor、非 0', async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-2', '测试医院2', 1)`).run(P2)
    // 模拟 statement-import /commit：case_revenue_lines 只写 gross_amount，qty/unit_price 缺省 0
    const ins = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, gross_amount, service_month) VALUES (?, ?, ?, ?, ?, ?)`)
    ins.run('l2-1', 'SC', P2, '免疫组化染色', 120, M2)
    ins.run('l2-2', 'SC', P2, '免疫组化染色', 120, M2)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`).run('lc2', 'SC', P2, 3, 0, '2026-05-15')
    const comp = await auth(request(app).post('/api/v1/account-reconcile/compute').send({ partnerId: P2, serviceMonth: M2 }))
    expect(comp.status).toBe(200)
    const wb = await auth(request(app).get(`/api/v1/account-reconcile/workbench?partnerId=${P2}&serviceMonth=${M2}`))
    const d = wb.body.data.diffs.find((x: any) => x.caseNo === 'SC' && x.lineType === '免疫组化')
    expect(d.billCount).toBe(2) // 行数 floor，若退回旧 bug 则为 0
    expect(d.lisCount).toBe(3)
    expect(d.delta).toBe(-1)
    expect(d.amountImpact).toBeCloseTo(120, 2) // |−1| × (240/2)
  })
})
