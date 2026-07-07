/**
 * 对账单导入落库闸·独立锚 + 期间键 回归门禁（非-P0 审计项 B）。
 *
 * 背景：/commit 闭合闸自指（totalSettle==declaredTotal 同源）→ 拆分口径被改坏、lab_revenue 静默缩水也平账落库；
 * serviceMonth 只格式校验 → 传错月静默新建平行 case_revenue 行。补两个不依赖当期口径的软锚（NEEDS_CONFIRM·可 confirm 旁路）：
 *  ① 在范围份额偏离 partner 近 N 期中位数；② serviceMonth 与台账(lis_cases)主导月不符。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { partnerRecentMedianLabShare, dominantLedgerMonth, buildImportAnchorReasons, ANCHOR_MAX_DEVIATION } from '../src/utils/import-gates.js'

let app: any, db: any
let financeToken = ''

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  const r = await request(app).post('/api/v1/auth/login').send({ username: u, password: p })
  return r.body?.data?.token || ''
}
async function commit(partnerId: string, grid: any[], serviceMonth: string, confirm?: boolean) {
  const request = (await import('supertest')).default
  return request(app).post('/api/v1/statement-import/commit').set('Authorization', `Bearer ${financeToken}`).send({ partnerId, grid, serviceMonth, confirm })
}
function seedHistory(partnerId: string, month: string, lab: number, net: number) {
  db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`).run(`CRH-${partnerId}-${month}`, `H-${month}`, partnerId, month, net, net, lab)
}
const inGrid = (rows: Array<[string, number, number]>, total: number) => [
  ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
  ...rows.map(([no, g, n]) => [no, '手术标本检查与诊断', String(g), String(Math.round((n / g) * 10000) / 10000), String(n)]),
  ['合计', '', String(rows.reduce((s, r) => s + r[1], 0)), '', String(total)],
]

beforeAll(async () => {
  db = await getDb()
  for (const [id, code, name] of [['PT-B-ANCHOR', 'B-A', '锚测试院'], ['PT-B-PERIOD', 'B-P', '期间键测试院'], ['PT-B-FRESH', 'B-F', '新院']]) {
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)`).run(id, code, name)
  }
  const authRoutes = (await import('../src/routes/auth.js')).default
  const impRoutes = (await import('../src/routes/statement-import-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/statement-import', router: impRoutes },
  ])
  financeToken = await login('caiwu', 'CoreOne2026!')
})

describe('B · 纯函数锚', () => {
  it('BG-1 partnerRecentMedianLabShare：足期→中位数；不足(<3)→null；排除当期；钳 [0,1]', () => {
    const P = 'PT-B-U1'
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'B-U1', 'U1', 1)`).run(P)
    expect(partnerRecentMedianLabShare(db, P, '2026-05')).toBeNull() // 无历史
    seedHistory(P, '2026-01', 500, 1000) // 0.5
    seedHistory(P, '2026-02', 600, 1000) // 0.6
    expect(partnerRecentMedianLabShare(db, P, '2026-05')).toBeNull() // 仅 2 期 < MIN_PERIODS(3)
    seedHistory(P, '2026-03', 700, 1000) // 0.7
    seedHistory(P, '2026-04', 800, 1000) // 0.8
    const a = partnerRecentMedianLabShare(db, P, '2026-05')
    expect(a).not.toBeNull()
    expect(a!.n).toBe(4)
    expect(a!.median).toBeCloseTo(0.65, 4) // median(0.5,0.6,0.7,0.8)=(0.6+0.7)/2
    // 排除当期：把 2026-02 当当期 → 只剩 01/03/04 → median(0.5,0.7,0.8)=0.7，n=3
    const b = partnerRecentMedianLabShare(db, P, '2026-02')
    expect(b!.n).toBe(3)
    expect(b!.median).toBeCloseTo(0.7, 4)
    // 钳 [0,1]：lab>net 坏账月(labShare 1.4)不进 median
    seedHistory(P, '2026-05', 1400, 1000) // labShare 1.4 → 被钳掉
    expect(partnerRecentMedianLabShare(db, P, '2026-09')!.n).toBe(4) // 仍 4（1.4 那期被剔）
  })
  it('BG-2 dominantLedgerMonth：众数月；无命中→null', () => {
    const P = 'PT-B-U2'
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'B-U2', 'U2', 1)`).run(P)
    expect(dominantLedgerMonth(db, P, ['X1', 'X2'])).toBeNull()
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, operate_time) VALUES ('lu1','X1',?,'2026-05-10')`).run(P)
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, operate_time) VALUES ('lu2','X2',?,'2026/05/20')`).run(P) // 斜杠也归一
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, operate_time) VALUES ('lu3','X3',?,'2026-06-01')`).run(P)
    expect(dominantLedgerMonth(db, P, ['X1', 'X2', 'X3'])).toBe('2026-05') // 05 有 2 票 > 06 的 1 票
  })
  it('BG-3 buildImportAnchorReasons：偏离锚 + 期间不符 各出一条；无锚无台账→空', () => {
    const P = 'PT-B-U3'
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'B-U3', 'U3', 1)`).run(P)
    expect(buildImportAnchorReasons(db, P, '2026-05', 100, 100, [])).toEqual([]) // 无历史无台账
    seedHistory(P, '2026-01', 500, 1000); seedHistory(P, '2026-02', 500, 1000); seedHistory(P, '2026-03', 500, 1000) // median 0.5 (≥3 期)
    // labShare=1.0 偏离 0.5 超 0.20 → 一条
    const r1 = buildImportAnchorReasons(db, P, '2026-05', 100, 100, [])
    expect(r1.length).toBe(1)
    expect(r1[0]).toContain('在范围份额')
  })
})

describe('B · /commit 集成', () => {
  it('BG-4 在范围份额偏离历史中位数 → 409 NEEDS_CONFIRM；confirm:true 旁路落库', async () => {
    const P = 'PT-B-ANCHOR'
    // 历史 3 期 labShare≈0.5
    seedHistory(P, '2026-01', 500, 1000); seedHistory(P, '2026-02', 500, 1000); seedHistory(P, '2026-03', 500, 1000)
    // 新月全 IN → labShare≈1.0，偏离 0.5 超 0.15
    const grid = inGrid([['B-001', 1000, 800], ['B-002', 1000, 800]], 1600)
    const res = await commit(P, grid, '2026-04')
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NEEDS_CONFIRM')
    expect(res.body.error.message).toContain('在范围份额')
    // 未落库
    expect((db.prepare(`SELECT COUNT(*) t FROM case_revenue WHERE partner_id=? AND service_month='2026-04'`).get(P) as any).t).toBe(0)
    // confirm 旁路
    const ok = await commit(P, grid, '2026-04', true)
    expect(ok.status).toBe(200)
    expect((db.prepare(`SELECT COUNT(*) t FROM case_revenue WHERE partner_id=? AND service_month='2026-04'`).get(P) as any).t).toBe(2)
  })

  it('BG-5 serviceMonth 与台账主导月不符 → 409；传对月则放行', async () => {
    const P = 'PT-B-PERIOD'
    // 台账登记在 2026-05，但试图按 2026-07 落库
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, operate_time) VALUES ('lp1','B-100',?,'2026-05-10')`).run(P)
    const grid = inGrid([['B-100', 1000, 800]], 800)
    const wrong = await commit(P, grid, '2026-07')
    expect(wrong.status).toBe(409)
    expect(wrong.body.error.message).toContain('台账主导月')
    // 传对月（2026-05）→ 期间键通过（无历史锚 → 不触发份额闸）→ 落库
    const right = await commit(P, grid, '2026-05')
    expect(right.status).toBe(200)
    expect((db.prepare(`SELECT COUNT(*) t FROM case_revenue WHERE partner_id=? AND service_month='2026-05'`).get(P) as any).t).toBe(1)
  })

  it('BG-6 向后兼容：新院无历史无台账 → 两软锚都不触发（首次落库不被误拦）', async () => {
    const P = 'PT-B-FRESH'
    const grid = inGrid([['B-200', 1000, 800]], 800)
    const res = await commit(P, grid, '2026-06')
    expect(res.status).toBe(200) // 闭合 ok + 无锚 → 直接落库，无需 confirm
    expect((db.prepare(`SELECT COUNT(*) t FROM case_revenue WHERE partner_id=? AND service_month='2026-06'`).get(P) as any).t).toBe(1)
  })
})
