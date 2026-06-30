/**
 * W4 收尾：财务收费单据导入路由 —— aggregateBilling→case_revenue + 医院 upsert + 病理号匹配 LIS + 未命中清单 + 幂等 + RBAC。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { v4 as uuidv4 } from 'uuid'

let app: any, db: any, adminToken = '', whmToken = ''
async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function req() { return (await import('supertest')).default }

const H = '上海和睦家医院'
function L(seq: number, caseNo: string, code: string, price: number, qty: number, gross: number, disc: string, net: number, hosp = H) {
  return { 序号: seq, 病理号: caseNo, 送检医院: hosp, 登记类型: '组织病理', 收费代码: code, 收费项目: code, 单价: price, 数量: qty, 计费金额: gross, 扣率: disc, 开单金额: net, 计费时间: '2026-06-05 15:38:39' }
}
// S26-02725(7行,实收2100) + S26-02646(2行,282) + S26-99999(1行,100·LIS无)
const LINES = [
  L(1, 'S26-02725', '270500002b', 100, 2, 200, '80%', 160), L(2, 'S26-02725', '270500002a', 200, 8, 1600, '80%', 1280),
  L(3, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132), L(4, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132),
  L(5, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132), L(6, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132),
  L(7, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132),
  L(1, 'S26-02646', '270900099-2', 150, 1, 150, '100%', 150), L(2, 'S26-02646', '270300002b', 165, 1, 165, '80%', 132),
  L(1, 'S26-99999', '270300005a', 125, 1, 125, '80%', 100),
  { 序号: '', 病理号: '小计', 开单金额: 9999 }, // 噪声跳过
]

beforeAll(async () => {
  db = await getDb()
  // 预置 LIS 病例供匹配（S26-02725 / S26-02646 命中；S26-99999 不命中）
  db.prepare('INSERT OR IGNORE INTO lis_cases (id, case_no) VALUES (?, ?)').run(`LC-${uuidv4()}`, 'S26-02725')
  db.prepare('INSERT OR IGNORE INTO lis_cases (id, case_no) VALUES (?, ?)').run(`LC-${uuidv4()}`, 'S26-02646')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const crRoutes = (await import('../src/routes/case-revenue-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/case-revenue', router: crRoutes },
  ])
  adminToken = await login('admin', 'admin123')
  whmToken = await login('cangguan', 'CoreOne2026!')
})

describe('W4 收尾：账单导入 → case_revenue + 匹配', () => {
  it('导入 3 case（跳小计）、实收 2482、命中 LIS 2、未命中 S26-99999', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/case-revenue/import').set('Authorization', `Bearer ${adminToken}`).send({ lines: LINES, docNo: '2026062607544902' })
    expect(res.status).toBe(200)
    expect(res.body.data.caseCount).toBe(3)
    expect(res.body.data.netTotal).toBe(2482) // 2100+282+100
    expect(res.body.data.matchedToLis).toBe(2)
    expect(res.body.data.unmatchedCount).toBe(1)
    expect(res.body.data.unmatchedCases).toContain('S26-99999')
    expect(res.body.data.partnersCreated).toBe(1) // 和睦家
  })

  it('GET 列表：S26-02725 实收 2100 / 扣率 0.8 / 服务月 2026-06', async () => {
    const request = await req()
    const res = await request(app).get('/api/v1/case-revenue?keyword=S26-02725').set('Authorization', `Bearer ${adminToken}`)
    const c = res.body.data.list.find((x: any) => x.caseNo === 'S26-02725')
    expect(c.netAmount).toBe(2100)
    expect(c.discountRate).toBe(0.8)
    expect(c.serviceMonth).toBe('2026-06')
    expect(c.partnerName).toBe(H)
  })

  it('幂等：重复导入不重复明细行（先删后插）', async () => {
    const request = await req()
    await request(app).post('/api/v1/case-revenue/import').set('Authorization', `Bearer ${adminToken}`).send({ lines: LINES })
    const cnt = (db.prepare("SELECT COUNT(*) c FROM case_revenue_lines WHERE case_no='S26-02725'").get() as any).c
    expect(cnt).toBe(7) // 不翻倍
    const rev = (db.prepare("SELECT COUNT(*) c FROM case_revenue WHERE case_no='S26-02725'").get() as any).c
    expect(rev).toBe(1)
  })
})

describe('W4 RBAC', () => {
  it('warehouse_manager（reconciliation R 无 W）导入被拒 403', async () => {
    const request = await req()
    expect((await request(app).post('/api/v1/case-revenue/import').set('Authorization', `Bearer ${whmToken}`).send({ lines: LINES })).status).toBe(403)
  })
})
