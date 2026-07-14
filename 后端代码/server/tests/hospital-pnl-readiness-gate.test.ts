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
import { buildTestApp, getDb, loginAdmin, loginAs } from './p0-harness.js'
import { buildHospitalCmTrend, buildHospitalCmTrendByPartner } from '../src/utils/hospital-cm-service.js'

let app: any
let token = ''
let readOnlyToken = ''
let financeToken = ''

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
  readOnlyToken = await loginAs(app, 'caigou', 'CoreOne2026!')
  financeToken = await loginAs(app, 'caiwu', 'CoreOne2026!')
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe('就绪谓词端点 /readiness（校准视图数据源）', () => {
  it('始终可读，返回 ready=false + 4 条就绪清单（每条带 owner+due 或 configError）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/readiness').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const r = res.body.data
    expect(r.ready).toBe(false) // 现实：三门未绿/池未认账/历史0/首周期未校验
    expect(r.hospitalCmFormulaVersion).toBe('2026-07-12.a')
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
    expect(r.asOfSource).toBe('server')
    expect(r.milestones).toHaveLength(4)
    expect(r.milestones.find((m: any) => m.conditionKey === 'denominator')).toMatchObject({
      ownerRole: 'business',
      ownerName: null,
      ownerAssigned: false,
      due: '2026-08-31',
    })
    expect(r.sources.denominator).toMatchObject({ state: 'connected', targetPhase: 'B', targetServiceMonth: null })
    expect(r.sources.history).toMatchObject({ state: 'not_connected', targetPhase: 'C' })
    expect(r.milestones.find((m: any) => m.conditionKey === 'first_period')).toMatchObject({
      reviewerRole: 'independent_reviewer',
      reviewerName: null,
      reviewerAssigned: false,
    })
  })

  it('asOf 只认服务器业务日期；URL 不允许回填旧日期隐藏逾期', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/readiness?asOf=2000-01-01').set(auth())
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('UNSUPPORTED_QUERY_PARAMETER')
  })

  it('GET 是纯读；显式重跑真实探针才会追加 failed/pass 证据', async () => {
    const db = await getDb()
    const count = () => Number((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_runs').get() as any).n)
    const before = count()

    const read = await request(app).get('/api/v1/hospital-pnl/readiness').set(auth())
    expect(read.status).toBe(200)
    expect(count()).toBe(before)

    const run = await request(app)
      .post('/api/v1/hospital-pnl/readiness/probes/foundation')
      .set(auth())
      .send({ reasonCode: 'MONTHLY_REVIEW', ticketRef: 'COREONE-HCM-A' })
    expect(run.status).toBe(201)
    expect(run.body.data.run.overallStatus).toBe('failed')
    expect(run.body.data.readiness.ready).toBe(false)
    expect(count()).toBe(before + 1)

    const duplicate = await request(app)
      .post('/api/v1/hospital-pnl/readiness/probes/foundation')
      .set(auth())
      .send({ reasonCode: 'DATA_REPAIR_RECHECK', ticketRef: 'COREONE-HCM-A' })
    expect(duplicate.status).toBe(429)
    expect(duplicate.body.error.code).toBe('READINESS_PROBE_COOLDOWN')
    expect(count()).toBe(before + 1)
  })

  it('写端点拒绝调用者提交 ready/met/passed 等结论字段', async () => {
    for (const body of [
      { reasonCode: 'MONTHLY_REVIEW', ready: true },
      { reasonCode: 'MONTHLY_REVIEW', met: true },
      { reasonCode: 'MONTHLY_REVIEW', checks: [{ key: 'period_key', met: true }] },
    ]) {
      const res = await request(app)
        .post('/api/v1/hospital-pnl/readiness/probes/foundation')
        .set(auth())
        .send(body)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('READINESS_RESULT_INPUT_FORBIDDEN')
    }
  })

  it('只有 cost_analysis:W 可触发重跑；R 用户仍可读但写入 403', async () => {
    const getRes = await request(app)
      .get('/api/v1/hospital-pnl/readiness')
      .set({ Authorization: `Bearer ${readOnlyToken}` })
    expect(getRes.status).toBe(200)

    const postRes = await request(app)
      .post('/api/v1/hospital-pnl/readiness/probes/foundation')
      .set({ Authorization: `Bearer ${readOnlyToken}` })
      .send({ reasonCode: 'MONTHLY_REVIEW' })
    expect(postRes.status).toBe(403)
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

describe('增量 B · 固定成本池逐月版本 + 具名 RATIFIED', () => {
  const serviceMonth = '2026-07'
  const sourceHash = 'a'.repeat(64)
  const ratificationHash = 'b'.repeat(64)
  let v1: any

  it('未配置时 readiness 只说数据源已接线，不泄漏固定池金额或伪造 0', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/readiness').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.data.sources.denominator).toMatchObject({
      state: 'connected',
      targetServiceMonth: null,
      configured: false,
      value: null,
      targetPhase: 'B',
    })
  })

  it('写入必须有 cost_analysis:W、Idempotency-Key 且不接受调用者伪造版本/结论', async () => {
    const body = {
      serviceMonth,
      amountMinor: 1_234_567,
      currency: 'CNY',
      scopeAttestation: 'FIXED_ONLY_EXCLUDES_MATERIALS_AND_VARIABLE_COSTS',
      sourceEvidenceRef: 'finance-manifest://2026-07/fixed-pool',
      sourceEvidenceHash: sourceHash,
      changeReason: '初次建立月度固定开销池',
    }
    const unauthenticated = await request(app)
      .post('/api/v1/hospital-pnl/readiness/fixed-pools')
      .set('Idempotency-Key', 'hcm-route-unauth-001')
      .send(body)
    expect(unauthenticated.status).toBe(401)

    const noKey = await request(app)
      .post('/api/v1/hospital-pnl/readiness/fixed-pools')
      .set(auth())
      .send(body)
    expect(noKey.status).toBe(400)
    expect(noKey.body.error.code).toBe('FIXED_POOL_IDEMPOTENCY_KEY_INVALID')

    const forged = await request(app)
      .post('/api/v1/hospital-pnl/readiness/fixed-pools')
      .set(auth())
      .set('Idempotency-Key', 'hcm-route-forged-001')
      .send({ ...body, version: '2026-07.v99', ready: true, ratified: true, actor: { userId: 'USER-FIN' } })
    expect(forged.status).toBe(400)
    expect(forged.body.error.code).toBe('FIXED_POOL_RESULT_INPUT_FORBIDDEN')

    const readOnly = await request(app)
      .post('/api/v1/hospital-pnl/readiness/fixed-pools')
      .set({ Authorization: `Bearer ${readOnlyToken}`, 'Idempotency-Key': 'hcm-route-read-only-001' })
      .send(body)
    expect(readOnly.status).toBe(403)

    const created = await request(app)
      .post('/api/v1/hospital-pnl/readiness/fixed-pools')
      .set(auth())
      .set('Idempotency-Key', 'hcm-route-create-v1-001')
      .send(body)
    expect(created.status).toBe(201)
    v1 = created.body.data.version
    expect(v1).toMatchObject({ serviceMonth, version: '2026-07.v1', amountMinor: 1_234_567, value: 12_345.67 })
    expect(created.body.data.readiness.ready).toBe(false)
  })

  it('只有数据库中已具名的 denominator owner 可签；admin 的 W 不能代签', async () => {
    const db = await getDb()
    db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET owner_user_id = 'USER-FIN',
          owner_name = '孙财务',
          owner_assignment_revision = owner_assignment_revision + 1,
          previous_due_date = due_date,
          previous_projected_date = projected_date,
          revision = revision + 1,
          change_reason = 'PM 待验收具名指派：路由集成测试用户',
          updated_by = 'test:approved-owner-fixture'
      WHERE condition_key = 'denominator'
    `).run()
    const body = {
      expectedContentHash: v1.contentHash,
      evidenceRef: 'approval://finance-owner/2026-07',
      evidenceHash: ratificationHash,
      reason: '已核对该月固定开销台账与口径',
    }
    const adminAttempt = await request(app)
      .post(`/api/v1/hospital-pnl/readiness/fixed-pools/${v1.id}/ratifications`)
      .set(auth())
      .set('Idempotency-Key', 'hcm-route-admin-sign-001')
      .send(body)
    expect(adminAttempt.status).toBe(403)
    expect(adminAttempt.body.error.code).toBe('FIXED_POOL_RATIFIER_NOT_OWNER')

    const signed = await request(app)
      .post(`/api/v1/hospital-pnl/readiness/fixed-pools/${v1.id}/ratifications`)
      .set({ Authorization: `Bearer ${financeToken}`, 'Idempotency-Key': 'hcm-route-owner-sign-001' })
      .send(body)
    expect(signed.status).toBe(201)
    expect(signed.body.data.decision).toMatchObject({ decision: 'RATIFIED', version: '2026-07.v1' })
    expect(signed.body.data.readiness.checklist.find((item: any) => item.key === 'denominator').met).toBe(true)
    expect(signed.body.data.readiness.ready).toBe(false) // C 的三期+首期仍未到
  })

  it('GET 审计视图可追 v1；readiness 公共载荷只露版本/证据，不露金额', async () => {
    const history = await request(app)
      .get(`/api/v1/hospital-pnl/readiness/fixed-pools?serviceMonth=${serviceMonth}`)
      .set({ Authorization: `Bearer ${readOnlyToken}` })
    expect(history.status).toBe(200)
    expect(history.body.data.current).toMatchObject({
      version: '2026-07.v1',
      ratifiedVersion: '2026-07.v1',
      currentDecision: 'RATIFIED',
    })

    const readiness = await request(app).get('/api/v1/hospital-pnl/readiness').set(auth())
    expect(readiness.status).toBe(200)
    const serialized = JSON.stringify(readiness.body.data)
    expect(serialized).not.toContain('1234567')
    expect(serialized).not.toContain('12345.67')
  })

  it('即使 B 已签，C 仍未完成时 full-health 仍 403 且不出完整数值', async () => {
    const res = await request(app)
      .get(`/api/v1/hospital-pnl/full-health?serviceMonth=${serviceMonth}`)
      .set(auth())
    expect(res.status).toBe(403)
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('totalCm')
    expect(serialized).not.toContain('coverageMultiple')
    expect(serialized).not.toContain('12345.67')
  })

  it('同月新增 v2 后旧签字自动失效，无需任何 ready 开关', async () => {
    const created = await request(app)
      .post('/api/v1/hospital-pnl/readiness/fixed-pools')
      .set(auth())
      .set('Idempotency-Key', 'hcm-route-create-v2-001')
      .send({
        serviceMonth,
        amountMinor: 1_300_000,
        currency: 'CNY',
        scopeAttestation: 'FIXED_ONLY_EXCLUDES_MATERIALS_AND_VARIABLE_COSTS',
        sourceEvidenceRef: 'finance-manifest://2026-07/fixed-pool-revised',
        sourceEvidenceHash: 'c'.repeat(64),
        changeReason: '年度调薪后修订',
      })
    expect(created.status).toBe(201)
    expect(created.body.data.version.version).toBe('2026-07.v2')
    expect(created.body.data.readiness.checklist.find((item: any) => item.key === 'denominator').met).toBe(false)

    const replayedV1 = await request(app)
      .post('/api/v1/hospital-pnl/readiness/fixed-pools')
      .set(auth())
      .set('Idempotency-Key', 'hcm-route-create-v1-001')
      .send({
        serviceMonth,
        amountMinor: 1_234_567,
        currency: 'CNY',
        scopeAttestation: 'FIXED_ONLY_EXCLUDES_MATERIALS_AND_VARIABLE_COSTS',
        sourceEvidenceRef: 'finance-manifest://2026-07/fixed-pool',
        sourceEvidenceHash: sourceHash,
        changeReason: '初次建立月度固定开销池',
      })
    expect(replayedV1.status).toBe(201)
    expect(replayedV1.body.data.version.id).toBe(v1.id)
    expect(replayedV1.body.message).toBe('固定成本池版本写入已记录或幂等返回；当前有效状态以 readiness 为准')
    expect(replayedV1.body.message).not.toContain('新版本已追加')

    const history = await request(app)
      .get(`/api/v1/hospital-pnl/readiness/fixed-pools?serviceMonth=${serviceMonth}`)
      .set(auth())
    expect(history.body.data.current).toMatchObject({
      version: '2026-07.v2',
      ratifiedVersion: '2026-07.v1',
      invalidationCode: 'CURRENT_VERSION_UNRATIFIED',
    })
    const oldSign = await request(app)
      .post(`/api/v1/hospital-pnl/readiness/fixed-pools/${v1.id}/ratifications`)
      .set({ Authorization: `Bearer ${financeToken}`, 'Idempotency-Key': 'hcm-route-old-resign-001' })
      .send({
        expectedContentHash: v1.contentHash,
        evidenceRef: 'approval://finance-owner/2026-07/retry',
        evidenceHash: 'd'.repeat(64),
        reason: '尝试重签旧版',
      })
    expect(oldSign.status).toBe(409)
    expect(oldSign.body.error.code).toBe('FIXED_POOL_VERSION_SUPERSEDED')
  })
})

describe('校准态内容始终可读（影子模式·消费者=今天看旧视图的人）', () => {
  it('/ 对照表 200（第 2 层·始终可用）', async () => {
    const res = await request(app).get('/api/v1/hospital-pnl/').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data.list)).toBe(true) // 空库 → 空列表（不臆造）
    expect(res.body.data.hospitalCmFormulaVersion).toBe('2026-07-12.a')
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
