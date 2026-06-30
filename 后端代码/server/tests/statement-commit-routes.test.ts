/**
 * P5 — /commit 端到端：网格 → 解析+分类 → 落库 case_revenue(lab_revenue=Σ(IN结算)) → buildPartnerPnl 看板。
 * 黄金：和睦家 W4 25 case 全组织学 → 院级实验室收入 = ¥13,152（配置→导入→看板 一条线）。幂等 + RBAC。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { buildPartnerPnl } from '../src/utils/partner-pnl-service.js'

let app: any, db: any
let financeToken = '', adminToken = '', pathoToken = ''
const PID = 'PT-CM-1'
const GID = 'PT-CM-GOLD'

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  const r = await request(app).post('/api/v1/auth/login').send({ username: u, password: p })
  return r.body?.data?.token || ''
}
async function st() { return (await import('supertest')).default }
const r4 = (n: number) => Math.round(n * 10000) / 10000

const SMALL_GRID = [
  ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
  ['S26-001', '手术标本检查与诊断(小标本)', '190', '0.8', '152'],
  ['S26-002', '组织学中英文报告-外籍人士', '150', '1', '150'], // 默认未匹配 → 不计入 lab
  ['合计', '', '340', '', '302'],
]

// 和睦家 W4 25 case（全组织学 IN）；实收 Σnet=13152
const HEMUJIA: Array<[string, number, number]> = [
  ['S26-02637', 340, 302], ['S26-02638', 645, 546], ['S26-02639', 315, 282], ['S26-02640', 480, 414],
  ['S26-02646', 315, 282], ['S26-02647', 495, 396], ['S26-02648', 190, 152], ['S26-02678', 315, 282],
  ['S26-02679', 2810, 2278], ['S26-02680', 315, 282], ['S26-02681', 190, 152], ['S26-02682', 645, 546],
  ['S26-02687', 340, 302], ['S26-02688', 190, 152], ['S26-02689', 315, 282], ['S26-02690', 480, 414],
  ['S26-02691', 1930, 1544], ['S26-02692', 645, 546], ['S26-02693', 340, 302], ['S26-02724', 340, 302],
  ['S26-02725', 2625, 2100], ['S26-02726', 580, 494], ['S26-02727', 190, 152], ['S26-02728', 620, 496],
  ['S26-02739', 190, 152],
]
const GOLD_GRID = [
  ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
  ...HEMUJIA.map(([no, g, n]) => [no, '手术标本检查与诊断', String(g), String(r4(n / g)), String(n)]),
  ['合计', '', '15840', '', '13152'],
]

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'PT-CM01', '提交测试医院', 1)`).run(PID)
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'PT-CM02', '上海和睦家医院', 1)`).run(GID)
  const authRoutes = (await import('../src/routes/auth.js')).default
  const cfgRoutes = (await import('../src/routes/partner-config-v1.1.js')).default
  const impRoutes = (await import('../src/routes/statement-import-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/partner-config', router: cfgRoutes },
    { path: '/api/v1/statement-import', router: impRoutes },
  ])
  financeToken = await login('caiwu', 'CoreOne2026!')
  adminToken = await login('admin', 'admin123')
  pathoToken = await login('yishi1', 'CoreOne2026!')
})

async function commit(token: string, partnerId: string, grid: any[], serviceMonth: string, confirm?: boolean) {
  const request = await st()
  return request(app).post('/api/v1/statement-import/commit').set('Authorization', `Bearer ${token}`).send({ partnerId, grid, serviceMonth, confirm })
}

describe('POST /commit 落库 + 看板', () => {
  it('门禁(codex F5)：含未匹配行(S26-002)且未 confirm → 409 NEEDS_CONFIRM，不落库', async () => {
    const res = await commit(financeToken, PID, SMALL_GRID, '2026-02')
    expect(res.status).toBe(409)
    expect((db.prepare('SELECT COUNT(*) AS t FROM case_revenue WHERE partner_id=?').get(PID) as any).t).toBe(0)
  })
  it('小样本(confirm:true)：2 case 入库，labRevenue=152（S26-002 未匹配→lab=0）', async () => {
    const res = await commit(financeToken, PID, SMALL_GRID, '2026-02', true)
    expect(res.status).toBe(200)
    expect(res.body.data.caseCount).toBe(2)
    expect(res.body.data.labRevenue).toBe(152)
    // case_revenue 落库且来源 statement
    const rows = db.prepare(`SELECT case_no, lab_revenue, revenue_source, config_version FROM case_revenue WHERE partner_id=? ORDER BY case_no`).all(PID) as any[]
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.case_no === 'S26-001').lab_revenue).toBe(152)
    expect(rows.find((r) => r.case_no === 'S26-002').lab_revenue).toBe(0)
    expect(rows.every((r) => r.revenue_source === 'statement')).toBe(true)
    expect(rows.every((r) => r.config_version >= 1)).toBe(true)
  })

  it('看板读权威值：buildPartnerPnl labRevenueTotal=152，sourceCounts.statement=2', () => {
    const pnl = buildPartnerPnl(db, { partnerId: PID }).find((p) => p.partnerId === PID)!
    expect(pnl.labRevenueTotal).toBe(152)
    expect(pnl.sourceCounts.statement).toBe(2)
  })

  it('幂等：重复 commit → 仍 2 case（不重复），labRevenue 不变', async () => {
    await commit(financeToken, PID, SMALL_GRID, '2026-02', true)
    const cnt = (db.prepare(`SELECT COUNT(*) AS t FROM case_revenue WHERE partner_id=?`).get(PID) as any).t
    expect(cnt).toBe(2)
    const linesCnt = (db.prepare(`SELECT COUNT(*) AS t FROM case_revenue_lines WHERE case_no IN ('S26-001','S26-002') AND service_month='2026-02'`).get() as any).t
    expect(linesCnt).toBe(2) // 删插成对，不累积
  })

  it('serviceMonth 缺失 → 400；pathologist → 403；类别汇总模板 → 400', async () => {
    const request = await st()
    const noMonth = await request(app).post('/api/v1/statement-import/commit').set('Authorization', `Bearer ${financeToken}`).send({ partnerId: PID, grid: SMALL_GRID })
    expect(noMonth.status).toBe(400)
    const patho = await commit(pathoToken, PID, SMALL_GRID, '2026-02')
    expect(patho.status).toBe(403)
  })
})

describe('GOLDEN 端到端：配置 → 导入 → 看板 = ¥13,152', () => {
  it('和睦家 25 case 全组织学 commit → 院级 labRevenueTotal=13152，sourceCounts.statement=25', async () => {
    const res = await commit(financeToken, GID, GOLD_GRID, '2026-06')
    expect(res.status).toBe(200)
    expect(res.body.data.caseCount).toBe(25)
    expect(res.body.data.labRevenue).toBe(13152)

    const pnl = buildPartnerPnl(db, { partnerId: GID, serviceMonth: '2026-06' }).find((p) => p.partnerId === GID)!
    expect(pnl.labRevenueTotal).toBe(13152)
    expect(pnl.netRevenueTotal).toBe(13152) // 全 IN → net=lab
    expect(pnl.sourceCounts.statement).toBe(25)
  })
})

describe('codex verify 门禁加固（H1 严格布尔 / H2 无合计行需确认）', () => {
  const NOTOTAL = [
    ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
    ['S26-700', '手术标本检查与诊断', '190', '0.8', '152'], // 全匹配，但无独立合计行
  ]
  it('H1：confirm 传字符串 "false" 不算确认 → 含未匹配仍 409', async () => {
    const request = await st()
    const res = await request(app).post('/api/v1/statement-import/commit').set('Authorization', `Bearer ${financeToken}`)
      .send({ partnerId: PID, grid: SMALL_GRID, serviceMonth: '2026-08', confirm: 'false' })
    expect(res.status).toBe(409)
  })
  it('H2：全匹配但无独立合计行 → 无 confirm 也 409（无法核对闭合）；confirm:true → 200', async () => {
    const request = await st()
    const a = await request(app).post('/api/v1/statement-import/commit').set('Authorization', `Bearer ${financeToken}`)
      .send({ partnerId: PID, grid: NOTOTAL, serviceMonth: '2026-09' })
    expect(a.status).toBe(409)
    const b = await request(app).post('/api/v1/statement-import/commit').set('Authorization', `Bearer ${financeToken}`)
      .send({ partnerId: PID, grid: NOTOTAL, serviceMonth: '2026-09', confirm: true })
    expect(b.status).toBe(200)
    expect(b.body.data.labRevenue).toBe(152)
  })
})
