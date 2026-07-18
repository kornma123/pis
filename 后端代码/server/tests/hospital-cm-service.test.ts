/**
 * 院级贡献毛利 DB 装载层 + 路由（§10.A SQL 契约 + 两层框架 API + RBAC）。
 *
 * 覆盖：① lab_revenue 分子（非 net_amount）· revenue_source 准入 · 同源闸（代阅片 lab_revenue=0 归诊断桶不减）；
 *       ② 缺价一抗诚实降级（不进桶B·计缺价片数）；③ 对照表默认按绝对贡献降序·无排名列；
 *       ④ 影子模式标注；⑤ RBAC：cost_analysis:R → 200 / 无成本权（pathologist）→ 403。
 * DB 路径 tissueProcessing=null（scope resolver 未建）→ 一律「仅染色」（不减组织处理·符合 §7 诚实边界）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'
import { buildHospitalCmByPartner } from '../src/utils/hospital-cm-service.js'

let app: any
let db: any
let adminToken: string
let pathoToken: string // pathologist：无 cost_analysis（诊断线只读）→ 403 样本

const A = 'HCM-A' // 全流程院
const B = 'HCM-B' // 代送加做院

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error('login failed: ' + JSON.stringify(res.body))
  return res.body.data.token
}
async function get(path: string, token?: string) {
  const request = (await import('supertest')).default
  const req = request(app).get(path)
  return token ? req.set('Authorization', `Bearer ${token}`) : req
}

beforeAll(async () => {
  db = await getDb()
  // partners
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'HCMA', '全流程院', 'with_diagnosis', 1)`).run(A)
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'HCMB', '代送院', 'technical_only', 1)`).run(B)
  // antibodies（CK7=¥5、Ki-67=¥8；PD-1 不入 = 缺价）
  db.prepare(`INSERT OR IGNORE INTO antibodies (id, name, category, per_test_price, price_status, status, is_deleted) VALUES ('AB-CK7','CK7','一抗',5,'has_price',1,0)`).run()
  db.prepare(`INSERT OR IGNORE INTO antibodies (id, name, category, per_test_price, price_status, status, is_deleted) VALUES ('AB-KI67','Ki-67','一抗',8,'has_price',1,0)`).run()

  // case_revenue（lab_revenue 分子·revenue_source=statement·service_month 2026-03）
  const cr = (id: string, caseNo: string, pid: string, lab: number) =>
    db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0.8, 'statement', '2026-03', 1)`).run(id, caseNo, pid, lab + 10, lab, lab)
  cr('HCR-1', 'A-001', A, 200) // 全流程 case（CK7/Ki-67/CK7）
  cr('HCR-2', 'A-002', A, 0) // 代阅片（lab_revenue=0·有 marker）→ 诊断桶
  cr('HCR-3', 'B-001', B, 120) // 代送加做（CK7/PD-1·PD-1 缺价）

  // lis_cases 标量（special_stain_count=0 → 特染均价不影响 CM·确定性）
  const lc = (id: string, caseNo: string, pid: string, blocks: number, ihc: number) =>
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES (?, ?, ?, ?, ?, 0, 'tissue')`).run(id, caseNo, pid, blocks, ihc)
  lc('HLC-1', 'A-001', A, 2, 3)
  lc('HLC-2', 'A-002', A, 1, 1)
  lc('HLC-3', 'B-001', B, 1, 2)

  // lis_case_markers（真抗体 Y000001·逐切片行）
  const mk = (id: string, caseNo: string, pid: string, name: string) =>
    db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES (?, ?, ?, ?, 'Y000001')`).run(id, caseNo, pid, name)
  mk('HM-1', 'A-001', A, 'CK7'); mk('HM-2', 'A-001', A, 'Ki-67'); mk('HM-3', 'A-001', A, 'CK7')
  mk('HM-4', 'A-002', A, 'CK7') // 代阅片也有 marker（Q4 守卫：仍不减）
  mk('HM-5', 'B-001', B, 'CK7'); mk('HM-6', 'B-001', B, 'PD-1')

  const authRoutes = (await import('../src/routes/auth.js')).default
  const hospitalRoutes = (await import('../src/routes/hospital-pnl-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/hospital-pnl', router: hospitalRoutes },
  ])
  adminToken = await loginAdmin(app)
  pathoToken = await login('yishi1', 'CoreOne2026!')
})

describe('DB 装载（§10.A 契约·纯服务层）', () => {
  it('HCM-A：仅染色 CM=137（桶A45+桶B18=63·tissue 未减）· 诊断桶=1（代阅片）', () => {
    const rows = buildHospitalCmByPartner(db, { serviceMonth: '2026-03' })
    const a = rows.find((r) => r.partnerId === A)!
    // 桶A = 3片×15 = 45；桶B = CK7(5)+Ki-67(8)+CK7(5) = 18（DB 路径 tissue=null → 不减组织处理）
    expect(a.bucketA).toBe(45)
    expect(a.bucketB).toBe(18)
    expect(a.hospitalCm).toBe(137) // 200 − 63
    expect(a.labRevenueInRate).toBe(200)
    expect(a.caliber).toBe('仅染色')
    expect(a.diagnosisCaseCount).toBe(1) // A-002 代阅片（有 marker 但 lab_revenue=0）不减、归诊断桶
    expect(a.revenueCaseCount).toBe(1)
    expect(a.state).toBe('经营线未定·仅供观察')
  })
  it('HCM-B：CM=85（PD-1 缺价不进桶B）· 缺价率=0.5', () => {
    const b = buildHospitalCmByPartner(db, { serviceMonth: '2026-03' }).find((r) => r.partnerId === B)!
    expect(b.bucketA).toBe(30) // 2片×15
    expect(b.bucketB).toBe(5) // CK7(5)，PD-1 缺价跳过
    expect(b.hospitalCm).toBe(85) // 120 − 35
    expect(b.quality.missingPriceRate).toBe(0.5) // 1 缺价 / 2 真抗体行
  })
})

describe('路由 · 两层框架 API', () => {
  it('GET / 对照表：默认按绝对贡献降序（HCM-A 137 > HCM-B 85）·无排名列', async () => {
    const res = await get('/api/v1/hospital-pnl?serviceMonth=2026-03', adminToken)
    expect(res.status).toBe(200)
    const list = res.body.data.list
    expect(list.map((r: any) => r.partnerId)).toEqual([A, B]) // 绝对贡献降序
    expect(list[0].cm).toBe(137)
    // 系统不排名不打分 → 无 rank/score 字段
    expect(list[0]).not.toHaveProperty('rank')
    expect(list[0]).not.toHaveProperty('score')
    // 率是表里一列（存在但非排序依据）+ 固定成本覆盖份额
    expect(list[0]).toHaveProperty('cmRate')
    expect(list[0]).toHaveProperty('fixedCoverageShare')
  })

  it('GET /health 组合体检：覆盖倍数只看趋势 + 影子模式', async () => {
    const res = await get('/api/v1/hospital-pnl/health?serviceMonth=2026-03&fixedPool=1000', adminToken)
    expect(res.status).toBe(200)
    const h = res.body.data
    expect(h.coverageMultipleTrendOnly).toBe(true)
    expect(h.shadowMode).toBe(true) // 三门未验收
    expect(h.totalCm).toBe(222) // 137 + 85
    expect(h.coverageMultiple).toBe(0.222) // 222/1000
    expect(h.shadowNote).toBeTruthy()
  })

  it('D2：GET /health 缺固定池与完整分母时以 null 出门，不能折成正常零', async () => {
    const res = await get('/api/v1/hospital-pnl/health?serviceMonth=2026-03', adminToken)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      fixedPool: null,
      coverageMultiple: null,
      fixedPoolProvided: false,
      unmeasuredRevenueShare: null,
      reopenAutomationQuestion: null,
    })
  })

  it('GET /trend：同院月度趋势', async () => {
    const res = await get(`/api/v1/hospital-pnl/trend?partnerId=${A}`, adminToken)
    expect(res.status).toBe(200)
    const pts = res.body.data
    expect(pts.find((p: any) => p.serviceMonth === '2026-03')?.hospitalCm).toBe(137)
  })
})

describe('RBAC · cost_analysis:R（复用 partner-pnl 门禁·零 MODULES 漂移）', () => {
  it('admin（有 cost_analysis）→ 200', async () => {
    expect((await get('/api/v1/hospital-pnl?serviceMonth=2026-03', adminToken)).status).toBe(200)
  })
  it('pathologist（无成本权限·诊断线只读）→ 403', async () => {
    expect((await get('/api/v1/hospital-pnl?serviceMonth=2026-03', pathoToken)).status).toBe(403)
    expect((await get('/api/v1/hospital-pnl/health', pathoToken)).status).toBe(403)
  })
  it('无 token → 401', async () => {
    expect((await get('/api/v1/hospital-pnl?serviceMonth=2026-03')).status).toBe(401)
  })
})
