/**
 * Phase 2 · /preview·/commit 端到端接线 LIS 蜡块拆分（split + 诊断桶 + 对账单×LIS join）。
 *
 * 证明：① /preview 传 LIS 蜡块 → 制片按真蜡块拆、surface diagnosisSettle；
 *       ② /commit 落库 lab_revenue + diagnosis_revenue，逐病例守恒 net = lab + diag + out；
 *       ③ 无 LIS 的院 → 制片降级账单数量（数值不同），证明路由确实读了 LIS（非空跑）。
 * 零回归：默认模板全 in/out，不建 split 线 → 本文件不影响既有 13,152 等锚。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { seedDefaultConfig, saveConfig, normalizeConfig, type PartnerConfigLine } from '../src/utils/partner-config.js'

let app: any, db: any, financeToken = ''
const P_LIS = 'PT-SPLIT-LIS' // 有 LIS 蜡块
const P_NOLIS = 'PT-SPLIT-NOLIS' // 无 LIS → 降级数量
const genId = () => `PC-${Math.round(Math.random() * 1e9)}` // 测试内非并发，够用

// 拆分口径配置：组织检诊 split(36,LIS蜡块) + 报告 diagnosis
function splitConfig(partnerId: string) {
  const c = seedDefaultConfig({ name: partnerId, code: partnerId })
  c.lines = [
    { key: 'histo', name: '组织制片', on: true, scope: 'split', splitProcRate: 36, splitWorkload: 'lis_blk', prefixes: [], keywords: ['检查与诊断'], remarks: [] },
    { key: 'report', name: '报告(诊断桶)', on: true, scope: 'diagnosis', prefixes: [], keywords: ['报告'], remarks: [] },
  ] as PartnerConfigLine[]
  return normalizeConfig(c)
}

// SP-1：制片行(结算400) + 报告行(结算100)；合计 500（可核闭合）
const GRID = [
  ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
  ['SP-1', '手术标本检查与诊断', '500', '0.8', '400'],
  ['SP-1', '组织学中英文报告', '100', '1', '100'],
  ['合计', '', '600', '', '500'],
]

// 手核（LIS 蜡块=2）：f = 36×2/(36×2+105) = 72/177 = 0.40678 → 制片 400×f = 162.71，诊断 400−162.71 = 237.29
// labRevenue = 162.71；diagnosisSettle = 237.29 + 报告100 = 337.29；守恒 162.71+337.29 = 500
const LAB_LIS = 162.71, DIAG_LIS = 337.29
// 无 LIS（降级数量=1）：f = 36/(36+105) = 0.25532 → 制片 400×f = 102.13
const LAB_NOLIS = 102.13

beforeAll(async () => {
  db = await getDb()
  for (const pid of [P_LIS, P_NOLIS]) db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)`).run(pid, pid, pid)
  // 仅 P_LIS 有 LIS 蜡块（SP-1 = 2 块）
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, block_count, status) VALUES ('LC-SP1', 'SP-1', ?, 2, 'normal')`).run(P_LIS)
  saveConfig(db, P_LIS, splitConfig(P_LIS), { changedBy: 'test', tab: '业务分类', genId })
  saveConfig(db, P_NOLIS, splitConfig(P_NOLIS), { changedBy: 'test', tab: '业务分类', genId })

  const authRoutes = (await import('../src/routes/auth.js')).default
  const impRoutes = (await import('../src/routes/statement-import-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/statement-import', router: impRoutes },
  ])
  const request = (await import('supertest')).default
  const r = await request(app).post('/api/v1/auth/login').send({ username: 'caiwu', password: 'CoreOne2026!' })
  financeToken = r.body?.data?.token || ''
})

async function post(path: string, body: any) {
  const request = (await import('supertest')).default
  return request(app).post(`/api/v1/statement-import/${path}`).set('Authorization', `Bearer ${financeToken}`).send(body)
}

describe('/preview 接 LIS 蜡块：制片按真蜡块拆 + 诊断桶', () => {
  it('有 LIS → labRevenue=162.71，diagnosisSettle=337.29，守恒 500', async () => {
    const res = await post('preview', { partnerId: P_LIS, grid: GRID })
    expect(res.status).toBe(200)
    const rev = res.body.data.revenue
    expect(rev.labRevenue).toBe(LAB_LIS)
    expect(rev.diagnosisSettle).toBe(DIAG_LIS)
    expect(Math.round(rev.labRevenue + rev.diagnosisSettle + rev.outSettle)).toBe(500)
  })
  it('无 LIS 的院 → 制片降级账单数量 → labRevenue=102.13（≠有 LIS），证明路由确实读了 LIS', async () => {
    const res = await post('preview', { partnerId: P_NOLIS, grid: GRID })
    const rev = res.body.data.revenue
    expect(rev.labRevenue).toBe(LAB_NOLIS)
    expect(rev.labRevenue).not.toBe(LAB_LIS)
  })
})

describe('/commit 落库诊断桶 + 逐病例守恒', () => {
  it('confirm:true → 落库 lab_revenue + diagnosis_revenue，net = lab + diag + out', async () => {
    const res = await post('commit', { partnerId: P_LIS, grid: GRID, serviceMonth: '2026-02', confirm: true })
    expect(res.status).toBe(200)
    expect(res.body.data.caseCount).toBe(1)
    expect(res.body.data.labRevenue).toBe(LAB_LIS)
    expect(res.body.data.diagnosisSettle).toBe(DIAG_LIS)

    const row = db.prepare(`SELECT gross_amount, net_amount, lab_revenue, diagnosis_revenue, out_revenue FROM case_revenue WHERE partner_id=? AND case_no='SP-1' AND service_month='2026-02'`).get(P_LIS) as any
    expect(row.lab_revenue).toBe(LAB_LIS)
    expect(row.diagnosis_revenue).toBe(DIAG_LIS)
    expect(row.out_revenue).toBe(0)
    expect(row.net_amount).toBe(500)
    expect(row.gross_amount).toBe(600)
    // 逐病例守恒红线：net = lab + diagnosis + out
    expect(row.lab_revenue + row.diagnosis_revenue + row.out_revenue).toBe(row.net_amount)
  })
})
