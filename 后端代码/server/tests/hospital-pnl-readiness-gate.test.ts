/**
 * 院级贡献毛利 · 就绪谓词端点 + **URL 后门焊到数据层**回归门禁（DEC-7 + 公理二 · 专家终裁 §六.6）。
 *
 * 守（红线·有牙）：
 *   ① `/readiness` 始终可读 → 校准视图渲染就绪清单（ready=false·checklist 4 条带 owner/due·findings）。
 *   ② `/full-health` 就绪谓词为假 ⇒ **403 + 降级载荷**——完整体检数值（totalCm/coverageMultiple 等）**绝不出门**，
 *      即便绕过前端直打 API（防书签 `?mode=full` / 直接 curl）。
 *   ③ 校准态内容（对照表 `/`、趋势-only 体检 `/health`）**始终可读**（影子模式·消费者=今天看旧视图的人）。
 *   ④ 注入 asOf 越过死线 → 就绪清单出现 overdue（红·上 GOV-3 豁免面板）——过期是被观测的事件。
 * 一旦有人让 `/full-health` 在未就绪时漏出完整数值、或把 `/readiness`/`/`/`/health` 意外锁死 → 本测试翻红。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'
import { buildHospitalCmTrend, buildHospitalCmTrendByPartner } from '../src/utils/hospital-cm-service.js'

let app: any
let token = ''

async function mountApp() {
  const routes = (await import('../src/routes/hospital-pnl-v1.1.js')).default
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    { path: '/api/v1/hospital-pnl', router: routes },
  ])
}

beforeAll(async () => {
  await getDb() // 初始化隔离内存库（三件套表存在但空 → 无 P0 结果·就绪现实=false）
  app = await mountApp()
  token = await loginAdmin(app)
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe('就绪谓词端点 /readiness（校准视图数据源）', () => {
  it('始终可读，返回 ready=false + 4 条就绪清单（每条带 owner+due 或 configError）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/readiness').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const r = res.body.data
    expect(r.ready).toBe(false) // 现实：三门未绿/池未认账/历史0/首周期未校验
    const keys = r.checklist.map((c: any) => c.key).sort()
    expect(keys).toEqual(['denominator', 'first_period', 'foundation', 'history'])
    for (const c of r.checklist) {
      expect(typeof c.owner).toBe('string') // 每个未满足条件 = 带 owner 的任务
      // 公理一：未满足条件必有 due，或被显式标 configError（渲染红）——绝不「忘填死线=永久绿」
      expect(c.met === true || c.due != null || c.configError === true).toBe(true)
    }
    // 认账门归属 = 业务方（不可代签）
    expect(r.checklist.find((c: any) => c.key === 'denominator').owner).toBe('business')
    expect(r.shadowNote).toBeTruthy() // 影子提示随响应带
  })

  it('注入 asOf 越过所有死线 → 出现 overdue finding（过期是被观测的事件·上豁免面板）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/readiness?asOf=2099-01-01').set(auth())
    expect(res.status).toBe(200)
    const overdue = res.body.data.findings.filter((f: any) => f.type === 'overdue')
    expect(overdue.length).toBeGreaterThan(0)
    // 对应条件也被标红 overdue
    expect(res.body.data.checklist.some((c: any) => c.overdue === true)).toBe(true)
  })
})

describe('URL 后门焊到数据层 /full-health（红线·§六.6）', () => {
  it('就绪谓词为假 ⇒ 403 + 降级载荷（完整体检数值绝不出门）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/full-health').set(auth())
    expect(res.status).toBe(403)
    expect(res.body.success).toBe(false)
    expect(res.body.error.code).toBe('READINESS_NOT_MET')
    // 降级载荷带就绪清单（为何被挡）——但**绝不含**完整体检数值
    expect(res.body.readiness.ready).toBe(false)
    expect(res.body.readiness.checklist.length).toBe(4)
    // 承重断言：完整态数值（totalCm/coverageMultiple/capacityUtilization 等）在响应任何层级都不存在
    const flat = JSON.stringify(res.body)
    expect(res.body.data).toBeUndefined()
    expect(flat).not.toMatch(/"totalCm"/)
    expect(flat).not.toMatch(/"coverageMultiple"/)
    expect(flat).not.toMatch(/"fullState"/)
  })

  it('带 serviceMonth / asOf 也一样 403（无 query 能强制唤出完整数据）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/full-health?serviceMonth=2026-03&asOf=2099-12-31').set(auth())
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('READINESS_NOT_MET')
    expect(JSON.stringify(res.body)).not.toMatch(/"coverageMultiple"/)
  })
})

describe('校准态内容始终可读（影子模式·消费者=今天看旧视图的人）', () => {
  it('/ 对照表 200（第 2 层·始终可用）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data.list)).toBe(true) // 空库 → 空列表（不臆造）
    expect(res.body.data.caliberRatification.ratified).toBe(false) // 水印随响应（fail-closed）
  })

  it('/health 体检（趋势-only）200 且标 shadowMode（第 1 层校准态·始终可用）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/health').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.data.shadowMode).toBe(true)
    expect(res.body.data.coverageMultipleTrendOnly).toBe(true) // 覆盖倍数只看趋势
  })
})

describe('鉴权（无 token → 401，非泄漏）', () => {
  it('/full-health 无 token → 401（不是 403·先鉴权后就绪门）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/full-health')
    expect(res.status).toBe(401)
  })
})

// 真数据 → 对照表可用（默认贡献降序 + 内联 trendPoints·含逐月口径·元素③/⑨）。
describe('第 2 层对照表 · 真数据（内联趋势·同账户历史·逐月口径）', () => {
  const P = 'PT-CM-TREND'
  beforeAll(async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'CMT', '趋势院', 1)`).run(P)
    db.prepare(`INSERT OR IGNORE INTO antibodies (id, name, category, per_test_price, price_status, status, is_deleted) VALUES ('AB-CMT','CK7','一抗',5,'has_price',1,0)`).run()
    // 两个月各一个染色 case（trendPoints 2 点·同账户历史③）
    const cr = (id: string, caseNo: string, lab: number, month: string) =>
      db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count) VALUES (?, ?, ?, ?, ?, ?, 0, 0.8, 'statement', ?, 1)`).run(id, caseNo, P, lab + 10, lab, lab, month)
    cr('CMT-CR1', 'CMT-A', 200, '2026-02')
    cr('CMT-CR2', 'CMT-B', 260, '2026-03')
    const lc = (id: string, caseNo: string) =>
      db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES (?, ?, ?, 1, 1, 0, 'tissue')`).run(id, caseNo, P)
    lc('CMT-LC1', 'CMT-A'); lc('CMT-LC2', 'CMT-B')
    const mk = (id: string, caseNo: string) =>
      db.prepare(`INSERT OR IGNORE INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES (?, ?, ?, 'CK7', 'Y000001')`).run(id, caseNo, P)
    mk('CMT-M1', 'CMT-A'); mk('CMT-M2', 'CMT-B')
  })

  it('GET / 该院行带 trendPoints（同账户 2 月·各含 caliber）+ detail 口径', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/').set(auth())
    expect(res.status).toBe(200)
    const row = res.body.data.list.find((r: any) => r.partnerId === P)
    expect(row).toBeTruthy()
    expect(row.cm).toBeGreaterThan(0) // 真算出的绝对贡献（默认排序键）
    expect(Array.isArray(row.trendPoints)).toBe(true)
    expect(row.trendPoints.length).toBe(2) // 同账户历史·两个月
    expect(row.trendPoints.map((p: any) => p.serviceMonth)).toEqual(['2026-02', '2026-03']) // 时序
    expect(row.trendPoints[0].caliber).toBeTruthy() // 逐月口径（⑨ 口径变更竖标数据源）
    expect(row.detail.caliber).toBeTruthy()
    expect(row.measurable).toBe(true)
  })

  it('批量趋势 buildHospitalCmTrendByPartner 与逐院 buildHospitalCmTrend **逐点等价**（N+1 修复不改结果）', async () => {
    const db = await getDb()
    const perPartner = buildHospitalCmTrend(db, P)
    const batch = buildHospitalCmTrendByPartner(db).get(P)
    expect(batch).toEqual(perPartner) // 深比对：批量一次装载 = 逐院分别装载·零差异
  })
})
