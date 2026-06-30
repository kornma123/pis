/**
 * PRD-0 T1（全链路补漏）— case-revenue / NGS 导入的 LIS 病例号→partner 规范化在跨院同号时不得随机选院。
 *
 * 背景：case-revenue-v1.1 / ngs-v1.1 用 `SELECT partner_id FROM lis_cases WHERE case_no=?` 把账单/订单的
 * partner 规范化到 LIS partner（治医院名别名）。但跨院同号时 .get() 取第一行 = 随机选院（违反 §7.1）。
 * 修复：仅当该 case_no 在 LIS 精确对应【单一】partner 时才规范化；歧义则退回账单/订单自带的医院名解析。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any, db: any, token = ''
const A = 'CRX-A', B = 'CRX-B'

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
const bill = (caseNo: string, hosp: string, gross: number, net: number) => ({
  序号: 1, 病理号: caseNo, 送检医院: hosp, 登记类型: '组织病理', 收费代码: 'X', 收费项目: 'X',
  单价: gross, 数量: 1, 计费金额: gross, 扣率: net / gross, 开单金额: net, 计费时间: '2026-06-05 15:38:39',
})

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES (?, 'CRX-A','跨院账单A院',1)`).run(A)
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES (?, 'CRX-B','跨院账单B院',1)`).run(B)
  // 同号 CR-DUP 在 A、B 两院 LIS 都有（撞号）
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id) VALUES ('LCRA','CR-DUP',?)`).run(A)
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id) VALUES ('LCRB','CR-DUP',?)`).run(B)
  // 单院 CR-SOLO 仅 A 院 LIS
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id) VALUES ('LCRS','CR-SOLO',?)`).run(A)
  const authRoutes = (await import('../src/routes/auth.js')).default
  const crRoutes = (await import('../src/routes/case-revenue-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/case-revenue', router: crRoutes },
  ])
  token = await login('caiwu', 'CoreOne2026!')
})

async function imp(lines: any[]) {
  const request = (await import('supertest')).default
  return request(app).post('/api/v1/case-revenue/import').set('Authorization', `Bearer ${token}`).send({ lines })
}

describe('跨院同号账单导入：歧义不随机选院', () => {
  it('CR-DUP 账单标 B 院 → 落到 B（不被 LIS 第一行 A 院规范化串走）', async () => {
    const res = await imp([bill('CR-DUP', '跨院账单B院', 100, 80)])
    expect(res.status).toBe(200)
    const row = db.prepare(`SELECT partner_id FROM case_revenue WHERE case_no='CR-DUP'`).get() as any
    expect(row.partner_id).toBe(B) // 歧义 → 退回账单医院名 B，而非随机选到 A
  })

  it('CR-SOLO 单院 LIS → 规范化到该院 A（精确匹配路径不变）', async () => {
    const res = await imp([bill('CR-SOLO', '跨院账单A院', 200, 160)])
    expect(res.status).toBe(200)
    const row = db.prepare(`SELECT partner_id FROM case_revenue WHERE case_no='CR-SOLO'`).get() as any
    expect(row.partner_id).toBe(A)
  })
})
