/**
 * LOC-015 partner-pnl 主线消费者：收入/计数证据 typed unavailable + 只扣留受污染结果。
 *
 * base 666ce6d 上 `loadCasePnls` 用 `Number(r.net_amount) || 0`、
 * `Number(r.lab_revenue) || 0`、`Number(r.ihc_count) || 0` 等宽松投影，
 * 把 text/Infinity/NULL 折成 0 并发布成功 P&L（RED 根因）。本测试要求：
 *   - 任一 amount/count 不可信 -> case 扣留、院级行带 evidence.status='unavailable'；
 *   - /partner-pnl、/cases、/trend 不发布 0/成功金额（金额字段为 null）；
 *   - 合法显式 0（net_amount=0 + LIS 0）保真；
 *   - NGS 聚合事实（margin=Infinity）同样 unavailable，不按 0 发布。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildPartnerPnl,
  loadCasePnls,
  loadCasePnlsWithCostEvidence,
  loadNgsByPartner,
} from '../src/utils/partner-pnl-service.js'
import { loadChargeCatalog } from '../src/utils/charge-catalog.js'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let adminToken: string
let catalog: any

const MONTH = '2099-01'
const CLEAN = 'EV-PP-CLEAN'
const ZERO = 'EV-PP-ZERO'
const TEXT = 'EV-PP-TEXT' // net_amount='oops'（statement 分支）
const LABTEXT = 'EV-PP-LABTEXT' // lab_revenue='abc'
const PARTIAL = 'EV-PP-PARTIAL' // LIS he_slide_count=1 但 ihc_count 为文本（部分计数损坏）
const NGS_BAD = 'EV-NGS-BAD' // ngs margin=Infinity
const NGS_OK = 'EV-NGS-OK'

async function get(path: string) {
  const request = (await import('supertest')).default
  return request(app).get(path).set('Authorization', `Bearer ${adminToken}`)
}

beforeAll(async () => {
  db = await getDb()
  const partner = (id: string, name: string) =>
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, ?, ?, 'technical_only', 1)`).run(id, id, name)
  for (const id of [CLEAN, ZERO, TEXT, LABTEXT, PARTIAL, NGS_BAD, NGS_OK]) partner(id, id)

  const cr = (id: string, caseNo: string, pid: string, fields: string) =>
    db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, diagnosis_revenue, discount_rate, revenue_source, service_month, line_count)
      VALUES (?, ?, ?, ${fields})`).run(id, caseNo, pid)

  // statement：lab_revenue 非空（已对账权威）；net_amount 合法 152
  cr('EV-PP-CR-1', 'EV-PP-001', CLEAN, "190, 152, 152, 0, 0, 0.8, 'statement', '2099-01', 1")
  // 合法显式 0：net_amount=0 且无 lab_revenue（估计路径），LIS 计数全 0
  cr('EV-PP-CR-2', 'EV-PP-002', ZERO, "0, 0, NULL, 0, 0, 1, 'estimated', '2099-01', 1")
  // net_amount 为文本（金额损坏）
  cr('EV-PP-CR-3', 'EV-PP-003', TEXT, "190, 'oops', 152, 0, 0, 0.8, 'statement', '2099-01', 1")
  // lab_revenue 为文本（金额损坏）
  cr('EV-PP-CR-4', 'EV-PP-004', LABTEXT, "190, 152, 'abc', 0, 0, 0.8, 'statement', '2099-01', 1")
  // 估计路径：LIS 部分计数损坏（he=1 但 ihc='x'）
  cr('EV-PP-CR-5', 'EV-PP-005', PARTIAL, "100, 100, NULL, 0, 0, 1, 'estimated', '2099-01', 1")

  const lc = (id: string, caseNo: string, pid: string, he: unknown, block: unknown, ihc: unknown) =>
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, he_slide_count, block_count, ihc_count, special_stain_count, eber_count, pdl1_count, specimen_type)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'tissue')`).run(id, caseNo, pid, he, block, ihc)
  lc('EV-PP-LC-1', 'EV-PP-001', CLEAN, 1, 1, 0)
  lc('EV-PP-LC-2', 'EV-PP-002', ZERO, 0, 0, 0)
  lc('EV-PP-LC-5', 'EV-PP-005', PARTIAL, 1, 1, 'x')

  const ngs = (id: string, pid: string, margin: unknown) =>
    db.prepare(`INSERT INTO ngs_orders (id, order_no, partner_id, partner_name, product_name, sell_price, outsource_cost, margin, order_month)
      VALUES (?, ?, ?, ?, ?, 8500, 1350, ?, ?)`).run(id, `NO-${pid}`, pid, pid, 'panel-1', margin, MONTH)
  ngs('EV-NGS-1', NGS_BAD, Infinity)
  ngs('EV-NGS-2', NGS_OK, 7150)

  catalog = loadChargeCatalog(db)
  const authRoutes = (await import('../src/routes/auth.js')).default
  const pnlRoutes = (await import('../src/routes/partner-pnl-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/partner-pnl', router: pnlRoutes },
  ])
  adminToken = await loginAdmin(app)
})

describe('service：amount/count 证据 typed unavailable', () => {
  it('loadCasePnls 只返回干净 case；污染 case 被扣留不进列表', () => {
    const cases = loadCasePnls(db, catalog, { serviceMonth: MONTH })
    const caseNos = cases.map((c) => c.caseNo)
    expect(caseNos).toContain('EV-PP-001')
    expect(caseNos).toContain('EV-PP-002')
    expect(caseNos).not.toContain('EV-PP-003')
    expect(caseNos).not.toContain('EV-PP-004')
    expect(caseNos).not.toContain('EV-PP-005')
  })

  it('loadCasePnlsWithCostEvidence：withheld 带 caseNo/field/reason（amount + count 两路）', () => {
    const { rows, withheld } = loadCasePnlsWithCostEvidence(db, { serviceMonth: MONTH })
    expect(rows.map((r) => r.caseNo)).toEqual(['EV-PP-001', 'EV-PP-002'])
    const byCase = new Map(withheld.map((w) => [w.caseNo, w.issues]))
    expect(byCase.get('EV-PP-003')![0]).toMatchObject({ field: 'net_amount', reason: 'malformed' })
    expect(byCase.get('EV-PP-004')![0]).toMatchObject({ field: 'lab_revenue', reason: 'malformed' })
    expect(byCase.get('EV-PP-005')![0]).toMatchObject({ field: 'ihc_count', reason: 'malformed' })
  })

  it('buildPartnerPnl：污染院行 evidenceUnavailable（含 NGS 聚合），干净院/合法 0 不误伤', () => {
    const rows = buildPartnerPnl(db, { serviceMonth: MONTH })
    const clean = rows.find((r) => r.partnerId === CLEAN)!
    expect((clean as any).evidenceUnavailable).toBeUndefined()
    expect(clean.labRevenueTotal).toBe(152)

    const zero = rows.find((r) => r.partnerId === ZERO)!
    expect((zero as any).evidenceUnavailable).toBeUndefined()
    expect(zero.labRevenueTotal).toBe(0)

    for (const [pid, field] of [
      [TEXT, 'net_amount'], [LABTEXT, 'lab_revenue'], [PARTIAL, 'ihc_count'],
    ] as const) {
      const row = rows.find((r) => r.partnerId === pid)!
      const ev = (row as any).evidenceUnavailable
      expect(ev, pid).toBeTruthy()
      expect(ev.issues.some((i: any) => i.field === field), pid).toBe(true)
    }

    const ngsBad = rows.find((r) => r.partnerId === NGS_BAD)!
    const ngsEv = (ngsBad as any).evidenceUnavailable
    expect(ngsEv).toBeTruthy()
    expect(ngsEv.issues.some((i: any) => i.field === 'ngs_margin' && i.reason === 'non_finite')).toBe(true)
    const ngsOk = rows.find((r) => r.partnerId === NGS_OK)!
    expect((ngsOk as any).evidenceUnavailable).toBeUndefined()
  })

  it('loadNgsByPartner：坏 NGS 聚合标记 evidenceUnavailable，不折 0 发布', () => {
    const bad = loadNgsByPartner(db).get(NGS_BAD)!
    expect((bad as any).evidenceUnavailable).toBeTruthy()
    expect((bad as any).evidenceUnavailable.issues[0].reason).toBe('non_finite')
    const ok = loadNgsByPartner(db).get(NGS_OK)!
    expect(ok.margin).toBe(7150)
  })
})

describe('API：具名不可用状态，绝不发布 0/成功金额', () => {
  it('GET /partner-pnl：污染院金额全 null + evidence unavailable；干净院/合法0保真', async () => {
    const res = await get(`/api/v1/partner-pnl?serviceMonth=${MONTH}`)
    expect(res.status).toBe(200)
    const list = res.body.data.list
    const clean = list.find((r: any) => r.partnerId === CLEAN)!
    expect(clean.labRevenueTotal).toBe(152)
    expect(clean.evidence.status).toBe('ok')
    const zero = list.find((r: any) => r.partnerId === ZERO)!
    expect(zero.labRevenueTotal).toBe(0)
    expect(zero.evidence.status).toBe('ok')

    for (const [pid, field] of [
      [TEXT, 'net_amount'], [LABTEXT, 'lab_revenue'], [PARTIAL, 'ihc_count'], [NGS_BAD, 'ngs_margin'],
    ] as const) {
      const row = list.find((r: any) => r.partnerId === pid)!
      expect(row.evidence.status, pid).toBe('unavailable')
      expect(row.evidence.issues.some((i: any) => i.field === field), pid).toBe(true)
      for (const key of ['labRevenueTotal', 'grossMargin', 'totalMargin', 'netRevenueTotal', 'ngsRevenue', 'ngsMargin']) {
        expect(row[key], `${pid}.${key}`).toBeNull()
      }
      expect(JSON.stringify(row), pid).not.toContain('"grossMargin":152')
    }
  })

  it('GET /partner-pnl/cases：污染 case 行证据 unavailable 且金额 null；onlyFlagged 不得吞掉污染行', async () => {
    const res = await get(`/api/v1/partner-pnl/cases?serviceMonth=${MONTH}`)
    expect(res.status).toBe(200)
    const body = res.body.data
    expect(body.total).toBe(5) // 2 干净 + 3 污染
    const bad = body.list.find((r: any) => r.caseNo === 'EV-PP-003')!
    expect(bad.labRevenue).toBeNull()
    expect(bad.costTotal).toBeNull()
    expect(bad.grossMargin).toBeNull()
    expect(bad.evidence.status).toBe('unavailable')
    expect(bad.evidence.issues[0].field).toBe('net_amount')
    const good = body.list.find((r: any) => r.caseNo === 'EV-PP-001')!
    expect(good.labRevenue).toBe(152)

    const flagged = await get(`/api/v1/partner-pnl/cases?serviceMonth=${MONTH}&onlyFlagged=true`)
    const flaggedCases = flagged.body.data.list.map((r: any) => r.caseNo)
    expect(flaggedCases).toContain('EV-PP-003') // 污染行不得被 onlyFlagged 过滤吞掉
    expect(flaggedCases).toContain('EV-PP-005')
  })

  it('GET /partner-pnl/trend：污染月点金额 null + evidence unavailable；合法 0 月点保真', async () => {
    const bad = await get(`/api/v1/partner-pnl/trend?partnerId=${TEXT}`)
    const point = bad.body.data.find((p: any) => p.serviceMonth === MONTH)!
    expect(point.labRevenueTotal).toBeNull()
    expect(point.grossMargin).toBeNull()
    expect(point.evidence.status).toBe('unavailable')

    const ok = await get(`/api/v1/partner-pnl/trend?partnerId=${ZERO}`)
    const okPoint = ok.body.data.find((p: any) => p.serviceMonth === MONTH)!
    expect(okPoint.labRevenueTotal).toBe(0)
    expect(okPoint.evidence.status).toBe('ok')
  })
})
