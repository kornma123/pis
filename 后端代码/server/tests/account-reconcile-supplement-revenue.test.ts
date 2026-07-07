/**
 * 补收 → 计入本月实收（设计基线 §1.4：已补收→自动计入本月实收，往月记本月）。
 * 口径：补收单 amount = 账单口径 gross；已补收时按「收费×扣率」折成实收 collected_revenue，
 *       计入 collected_month 的实收；反向（恢复待补收）→ 清零、退出实收。**不写 case_revenue**（只读收入侧算扣率），保护 golden。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin, loginAs, seedReviewer } from './p0-harness.js'
import { partnerMonthLabRate, partnerMonthDiscountRate } from '../src/utils/reconcile-compute.js'

const P = 'PT-SR-1'
const M = '2026-08'
let app: any
let token = ''
let reviewerToken = '' // 第二审核人（项D maker-checker：认定人 admin 不能签发自己的补收单，须独立 approve）
let supId = ''

/** 项D：补收单收款前须独立签发（SoD）。认定人=admin，故由 reviewer2 签发。 */
async function approve(id: string) {
  return request(app).post(`/api/v1/account-reconcile/supplements/${id}/approve`).set('Authorization', `Bearer ${reviewerToken}`).send({})
}

async function mountApp() {
  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    { path: '/api/v1/account-reconcile', router: routes, middleware: [authenticateToken, requirePermission('account_reconcile', 'R')] },
  ])
}

function seed(db: any) {
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'SR-1', '补收实收测试院', 1)`).run(P)
  // 免疫组化 bill 3 片（LIS 5）→ delta −2 → amount_impact = 2×100 = 200
  db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('sr-l1', 'SR1', P, '免疫组化染色', 3, 100, M)
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('sr-lc1', 'SR1', P, 5, 0, '2026-08-10')
  // 收入侧：gross 1000 / net 800 → 扣率 0.8（partnerMonthDiscountRate）
  db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
    .run('sr-cr1', 'SR1', P, M, 1000, 800, 800)
}

beforeAll(async () => {
  const db = await getDb()
  seed(db)
  await seedReviewer(db)
  app = await mountApp()
  token = await loginAdmin(app)
  reviewerToken = await loginAs(app, 'reviewer2', 'CoreOne2026!')
})
const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)

describe('补收 → 计入本月实收', () => {
  it('认定漏收 → 生成补收单（gross ¥200）', async () => {
    await auth(request(app).post('/api/v1/account-reconcile/compute').send({ partnerId: P, serviceMonth: M }))
    const wb = await auth(request(app).get(`/api/v1/account-reconcile/workbench?partnerId=${P}&serviceMonth=${M}`))
    const diff = wb.body.data.diffs.find((d: any) => d.caseNo === 'SR1')
    expect(diff.amountImpact).toBe(200)
    await auth(request(app).post(`/api/v1/account-reconcile/diffs/${diff.id}/verdict`).send({ reason: '漏收，需补收' }))
    const sup = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}`))
    expect(sup.body.data.list.length).toBe(1)
    supId = sup.body.data.list[0].id
    expect(sup.body.data.list[0].amount).toBe(200)
  })

  it('未签发直接收款 → 409 NOT_APPROVED（项D 人闸）', async () => {
    const res = await auth(request(app).post(`/api/v1/account-reconcile/supplements/${supId}/collect`).send({ collectedMonth: M }))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_APPROVED')
  })

  it('标记已补收（计入 2026-08）→ collected_revenue = 200×0.8 = 160', async () => {
    await approve(supId) // 项D：独立签发人先 approve，才可收款
    const res = await auth(request(app).post(`/api/v1/account-reconcile/supplements/${supId}/collect`).send({ collectedMonth: M }))
    expect(res.status).toBe(200)
    const sup = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}`))
    const s = sup.body.data.list[0]
    expect(s.status).toBe('已补收')
    expect(s.collectedRevenue).toBeCloseTo(160, 2) // 200 × 扣率0.8
    expect(sup.body.data.board.已补收实收).toBeCloseTo(160, 2)
  })

  it('总览 确认实收 含补收实收（院待复核·base=0 → 确认实收=补收实收=160）', async () => {
    const ov = await auth(request(app).get(`/api/v1/account-reconcile/overview?serviceMonth=${M}`))
    expect(ov.body.data.board.补收实收).toBeCloseTo(160, 2)
    expect(ov.body.data.board.确认实收).toBeCloseTo(160, 2)
  })

  it('反向恢复待补收 → collected_revenue 清零、退出实收', async () => {
    await auth(request(app).post(`/api/v1/account-reconcile/supplements/${supId}/reopen`).send({ reason: '误标' }))
    const ov = await auth(request(app).get(`/api/v1/account-reconcile/overview?serviceMonth=${M}`))
    expect(ov.body.data.board.补收实收).toBeCloseTo(0, 2)
    const sup = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}`))
    expect(sup.body.data.list[0].collectedRevenue == null || sup.body.data.list[0].collectedRevenue === 0).toBe(true)
  })

  it('已补收→放弃 → 清折实收、退出实收（LOW 修复）', async () => {
    await approve(supId) // reopen 已把复核态回退 pending_review，收款前须重新签发
    await auth(request(app).post(`/api/v1/account-reconcile/supplements/${supId}/collect`).send({ collectedMonth: M }))
    await auth(request(app).post(`/api/v1/account-reconcile/supplements/${supId}/giveup`).send({ reason: '收不回' }))
    const sup = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}`))
    const s = sup.body.data.list[0]
    expect(s.status).toBe('已放弃')
    expect(s.collectedRevenue == null).toBe(true)
    const ov = await auth(request(app).get(`/api/v1/account-reconcile/overview?serviceMonth=${M}`))
    expect(ov.body.data.board.补收实收).toBeCloseTo(0, 2)
  })
})

describe('折实收扣率：实验室工序行扣率隔离诊断扣率（HIGH #1 修复）', () => {
  const LP = 'PT-LR-1'
  const LM = '2026-09'
  it('免疫组化行扣率 0.8（≠ 全票 0.65·诊断行 0.5 不污染）', async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'LR-1', '扣率隔离测试院', 1)`).run(LP)
    const ins = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, gross_amount, net_amount, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    ins.run('lr-i1', 'LC1', LP, '免疫组化染色', 500, 400, LM) // 扣率 0.8
    ins.run('lr-i2', 'LC1', LP, '免疫组化染色', 500, 400, LM) // 扣率 0.8
    ins.run('lr-d1', 'LC1', LP, '组织病理学检查', 1000, 500, LM) // 诊断 扣率 0.5（不应污染）
    db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
      .run('lr-cr1', 'LC1', LP, LM, 2000, 1300, 800)
    expect(partnerMonthLabRate(db, LP, LM)).toBeCloseTo(0.8, 4) // 仅免疫组化行 800/1000
    expect(partnerMonthDiscountRate(db, LP, LM)).toBeCloseTo(0.65, 4) // 全票 1300/2000（被诊断稀释）
  })
})
