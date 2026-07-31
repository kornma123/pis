/**
 * LOC-015 hospital-cm 主线消费者：LIS 计数证据 typed unavailable + 只扣留受污染结果。
 *
 * base 666ce6d 上 `inputFor` 用 `Number(r.ihc_count) || 0` 把 text/Infinity/NULL/unsafe
 * 计数折成 0 并发布成功 CM（RED 根因）。本测试要求：
 *   - 任一 count 事实不可信 -> 该 case 扣留、院月结果带具名 evidence.status='unavailable'；
 *   - API 不再返回 0/成功金额（cm/cmRate/fixedCoverageShare 为 null）；
 *   - 合法显式 0（lab_revenue=0、count=0）保真：仍是数值 0 而非 unavailable；
 *   - 干净医院照常发布数字。
 *
 * 行为矩阵：blank('') / text / Infinity 走真实 DB -> 真实 API；
 * missing(NULL) / container / NaN / unsafe(2^53) 在 evidence-fact.test.ts 的纯函数矩阵覆盖
 * （lis_cases 计数列 schema 为 NOT NULL DEFAULT 0，DB 层无法表示 NULL；NaN 绑定为 NULL；
 *  超界 INTEGER 由 node:sqlite 驱动自身拒绝读取——fail-closed 先行）。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { buildHospitalCmByPartner } from '../src/utils/hospital-cm-service.js'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let adminToken: string

const MONTH = '2099-01'
const CLEAN = 'EV-CLEAN' // 合法正数 + 合法显式 0 计数
const ZERO = 'EV-ZERO' // lab_revenue=0（代阅片/诊断桶），必须保真 0
const TEXT = 'EV-TEXT' // ihc_count='oops'
const BLANK = 'EV-BLANK' // special_stain_count=''
const INF = 'EV-INF' // ihc_count=Infinity

const EXPECTED_REASON: Record<string, { field: string; reason: string }> = {
  [TEXT]: { field: 'ihc_count', reason: 'malformed' },
  [BLANK]: { field: 'special_stain_count', reason: 'blank' },
  [INF]: { field: 'ihc_count', reason: 'non_finite' },
}

async function get(path: string) {
  const request = (await import('supertest')).default
  return request(app).get(path).set('Authorization', `Bearer ${adminToken}`)
}

beforeAll(async () => {
  db = await getDb()
  const partner = (id: string, code: string, name: string) =>
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, ?, ?, 'technical_only', 1)`).run(id, code, name)
  for (const [id, code] of [
    [CLEAN, 'EV-C01'], [ZERO, 'EV-C02'], [TEXT, 'EV-C03'], [BLANK, 'EV-C04'],
    [INF, 'EV-C06'],
  ] as const) partner(id, code, id)

  db.prepare(`INSERT OR IGNORE INTO antibodies (id, name, category, per_test_price, price_status, status, is_deleted) VALUES ('AB-CK7','CK7','一抗',5,'has_price',1,0)`).run()

  const cr = (id: string, caseNo: string, pid: string, lab: number) =>
    db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'statement', ?, 1)`).run(id, caseNo, pid, lab + 10, lab, lab, MONTH)
  cr('EV-CR-1', 'EV-C-001', CLEAN, 300)
  cr('EV-CR-2', 'EV-C-002', ZERO, 0)
  cr('EV-CR-3', 'EV-C-003', TEXT, 200)
  cr('EV-CR-4', 'EV-C-004', BLANK, 200)
  cr('EV-CR-6', 'EV-C-006', INF, 200)

  const lc = (id: string, caseNo: string, pid: string, block: unknown, ihc: unknown, ss: unknown) =>
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES (?, ?, ?, ?, ?, ?, 'tissue')`).run(id, caseNo, pid, block, ihc, ss)
  lc('EV-LC-1', 'EV-C-001', CLEAN, 2, 2, 0)
  lc('EV-LC-2', 'EV-C-002', ZERO, 0, 0, 0)
  lc('EV-LC-3', 'EV-C-003', TEXT, 1, 'oops', 0)
  lc('EV-LC-4', 'EV-C-004', BLANK, 1, 1, '')
  lc('EV-LC-6', 'EV-C-006', INF, 1, Infinity, 0)

  const mk = (id: string, caseNo: string, pid: string) =>
    db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES (?, ?, ?, 'CK7', 'Y000001')`).run(id, caseNo, pid)
  mk('EV-MK-1', 'EV-C-001', CLEAN)
  mk('EV-MK-2', 'EV-C-002', ZERO)
  mk('EV-MK-3', 'EV-C-003', TEXT)
  mk('EV-MK-4', 'EV-C-004', BLANK)
  mk('EV-MK-6', 'EV-C-006', INF)

  const authRoutes = (await import('../src/routes/auth.js')).default
  const hospitalRoutes = (await import('../src/routes/hospital-pnl-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/hospital-pnl', router: hospitalRoutes },
  ])
  adminToken = await loginAdmin(app)
})

describe('service：计数证据 typed unavailable（只扣留受污染结果）', () => {
  it('干净医院照常发布 CM=280；合法 0 计数（special_stain_count=0）不触发 unavailable', () => {
    const row = buildHospitalCmByPartner(db, { serviceMonth: MONTH }).find((r) => r.partnerId === CLEAN)!
    expect(row).toBeTruthy()
    expect(row.hospitalCm).toBe(280) // 300 - (15 + 5)
    expect((row as any).evidenceUnavailable).toBeUndefined()
  })

  it('合法显式 0：lab_revenue=0 的诊断桶保真为 cm=0，不是 unavailable', () => {
    const row = buildHospitalCmByPartner(db, { serviceMonth: MONTH }).find((r) => r.partnerId === ZERO)!
    expect(row.hospitalCm).toBe(0)
    expect(row.diagnosisCaseCount).toBe(1)
    expect((row as any).evidenceUnavailable).toBeUndefined()
  })

  it('text/blank/Infinity 计数 -> caseCount=1 且具名 reason', () => {
    const rows = buildHospitalCmByPartner(db, { serviceMonth: MONTH })
    for (const [pid, expected] of Object.entries(EXPECTED_REASON)) {
      const row = rows.find((r) => r.partnerId === pid)!
      const ev = (row as any).evidenceUnavailable
      expect(ev, pid).toBeTruthy()
      expect(ev.caseCount).toBe(1)
      expect(ev.issues[0].field).toBe(expected.field)
      expect(ev.issues[0].reason).toBe(expected.reason)
      expect(ev.issues[0].caseNo).toBeTruthy()
    }
  })
})

describe('API：具名不可用状态，绝不发布 0/成功金额', () => {
  it('GET /hospital-pnl：污染院行 cm/cmRate/fixedCoverageShare=null + evidence unavailable；干净院照常数字', async () => {
    const res = await get(`/api/v1/hospital-pnl?serviceMonth=${MONTH}`)
    expect(res.status).toBe(200)
    const list = res.body.data.list
    const clean = list.find((r: any) => r.partnerId === CLEAN)!
    expect(clean.cm).toBe(280)
    expect(clean.evidence).toEqual({ status: 'ok' })

    for (const [pid, expected] of Object.entries(EXPECTED_REASON)) {
      const row = list.find((r: any) => r.partnerId === pid)!
      expect(row.cm, pid).toBeNull()
      expect(row.cmRate, pid).toBeNull()
      expect(row.fixedCoverageShare, pid).toBeNull()
      expect(row.measurable, pid).toBe(false)
      expect(row.detail, pid).toBeNull()
      expect(row.evidence.status, pid).toBe('unavailable')
      expect(row.evidence.issues[0].reason, pid).toBe(expected.reason)
      expect(row.evidence.issues[0].field, pid).toBe(expected.field)
      // 成功金额必须缺席：polluted 行不得出现 200 或 ¥200
      expect(JSON.stringify(row), pid).not.toContain('"cm":200')
    }
  })

  it('GET /hospital-pnl：合法显式 0 保真（cm=0 数值，非 unavailable）', async () => {
    const res = await get(`/api/v1/hospital-pnl?serviceMonth=${MONTH}`)
    const row = res.body.data.list.find((r: any) => r.partnerId === ZERO)!
    expect(row.cm).toBe(0)
    expect(row.evidence.status).toBe('ok')
  })

  it('GET /health：任一污染院 -> 汇总证据 unavailable，totalCm/coverageMultiple 不得发布 0/成功值', async () => {
    const res = await get(`/api/v1/hospital-pnl/health?serviceMonth=${MONTH}&fixedPool=1000`)
    expect(res.status).toBe(200)
    const h = res.body.data
    expect(h.evidence.status).toBe('unavailable')
    expect(h.evidence.affectedPartners).toEqual(expect.arrayContaining([TEXT, INF]))
    expect(h.totalCm).toBeNull()
    expect(h.coverageMultiple).toBeNull()
    expect(JSON.stringify(h)).not.toContain('"totalCm":280')
  })

  it('GET /trend：污染月点 hospitalCm=null + evidence unavailable；合法 0 月点保真 0', async () => {
    const bad = await get(`/api/v1/hospital-pnl/trend?partnerId=${TEXT}`)
    const badPoint = bad.body.data.find((p: any) => p.serviceMonth === MONTH)!
    expect(badPoint.hospitalCm).toBeNull()
    expect(badPoint.labRevenueInRate).toBeNull()
    expect(badPoint.cmRate).toBeNull()
    expect(badPoint.revenueCaseCount).toBeNull()
    expect(badPoint.evidence.status).toBe('unavailable')

    const ok = await get(`/api/v1/hospital-pnl/trend?partnerId=${ZERO}`)
    const okPoint = ok.body.data.find((p: any) => p.serviceMonth === MONTH)!
    expect(okPoint.hospitalCm).toBe(0)
    expect(okPoint.evidence.status).toBe('ok')
  })
})
