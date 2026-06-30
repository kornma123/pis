/**
 * 云端深审（Codex）修复验证：① 成本排除 pending_cost/cost_exception；③ 账单医院名与 LIS 不一致时以 LIS partner 为权威 + mismatch 预警。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { v4 as uuidv4 } from 'uuid'
import { getPartnerCostRollup } from '../src/utils/abc-partner-link.js'

let app: any, db: any, adminToken = ''
const PA = 'PT-FIXA'
const PB = 'PT-FIXB'
async function req() { return (await import('supertest')).default }

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'PT-FX01', '甲医院', 'with_diagnosis', 1)`).run(PA)
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'PT-FX02', '甲医院别名', 'with_diagnosis', 1)`).run(PB)
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, he_slide_count, block_count) VALUES (?, 'CC1', ?, 3, 1)`).run(`LC-${uuidv4()}`, PA)
  // 同一医院：一条 costed(800) + 一条 pending_cost(500) + 一条 cost_exception(700)
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, case_no, partner_id, total_cost, cost_month, cost_status) VALUES (?, ?, 'CC1', ?, 800, '2026-06', 'costed')`).run(`OAD-${uuidv4()}`, `OB-${uuidv4()}`, PA)
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, case_no, partner_id, total_cost, cost_month, cost_status) VALUES (?, ?, 'CC1', ?, 500, '2026-06', 'pending_cost')`).run(`OAD-${uuidv4()}`, `OB-${uuidv4()}`, PA)
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, case_no, partner_id, total_cost, cost_month, cost_status) VALUES (?, ?, 'CC1', ?, 700, '2026-06', 'cost_exception')`).run(`OAD-${uuidv4()}`, `OB-${uuidv4()}`, PA)

  const authRoutes = (await import('../src/routes/auth.js')).default
  const crRoutes = (await import('../src/routes/case-revenue-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/case-revenue', router: crRoutes },
  ])
  adminToken = (await (await req())(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })).body?.data?.token || ''
})

describe('① 成本排除 pending_cost / cost_exception', () => {
  it('getPartnerCostRollup 只计 costed 800，不含 pending(500)/exception(700)', () => {
    const cost = getPartnerCostRollup(db, { serviceMonth: '2026-06' }).get(PA)
    expect(cost?.costTotal).toBe(800)
  })
})

describe('③ 账单医院名 ≠ LIS：以 LIS partner 为权威 + mismatch 预警', () => {
  it('CC1 账单写「甲医院别名」(PB)，但 LIS 是 PA → 收入落 PA，且 nameMismatch 报 1，不新建医院', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/case-revenue/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ lines: [{ 序号: 1, 病理号: 'CC1', 送检医院: '甲医院别名', 收费代码: 'X', 计费金额: 100, 扣率: '80%', 开单金额: 80, 计费时间: '2026-06-01' }] })
    expect(res.status).toBe(200)
    expect(res.body.data.matchedToLis).toBe(1)
    expect(res.body.data.partnersCreated).toBe(0)
    expect(res.body.data.nameMismatchCount).toBe(1)
    const got = (await request(app).get('/api/v1/case-revenue?keyword=CC1').set('Authorization', `Bearer ${adminToken}`)).body.data.list[0]
    expect(got.partnerId).toBe(PA) // 收入归 LIS canonical PA，而非账单名对应的 PB
  })
})
