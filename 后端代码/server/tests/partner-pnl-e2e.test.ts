/**
 * W6 + W5 完整 P&L 端到端 —— 回填 ABC 成本医院维度 → 院级 P&L（实收/实验室收入/成本/毛利）。
 * 用真实和睦家 S26-02725（实收2100，with_diagnosis）+ 合成成本800 验证毛利1300。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { v4 as uuidv4 } from 'uuid'

let app: any, db: any, adminToken = '', pathoToken = ''
async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function req() { return (await import('supertest')).default }

const PID = 'PT-PNL-1'

beforeAll(async () => {
  db = await getDb()
  // 合作医院（with_diagnosis）
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'PT-90001', '上海和睦家医院', 'with_diagnosis', 1)`).run(PID)
  // LIS 病例（含数量）
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, he_slide_count, block_count, ihc_count, specimen_type)
              VALUES (?, 'S26-02725', ?, 5, 5, 2, 'tissue')`).run(`LC-${uuidv4()}`, PID)
  // 财务实收
  db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, partner_name, net_amount, gross_amount, discount_rate, service_month, line_count)
              VALUES (?, 'S26-02725', ?, '上海和睦家医院', 2100, 2625, 0.8, '2026-06', 7)`).run(`CR-${uuidv4()}`, PID)
  // ABC 成本明细（partner_id 暂空，待回填）；total_cost 800，cost_month 2026-06
  db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, case_no, total_cost, cost_month, cost_status)
              VALUES (?, ?, 'S26-02725', 800, '2026-06', 'costed')`).run(`OAD-${uuidv4()}`, `OB-${uuidv4()}`)

  const authRoutes = (await import('../src/routes/auth.js')).default
  const pnlRoutes = (await import('../src/routes/partner-pnl-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/partner-pnl', router: pnlRoutes },
  ])
  adminToken = await login('admin', 'admin123')
  pathoToken = await login('yishi1', 'CoreOne2026!')
})

describe('W6：回填 ABC 成本医院维度', () => {
  it('回填前成本未挂医院（P&L cost=0，costMatched=false）', async () => {
    const request = await req()
    const res = await request(app).get('/api/v1/partner-pnl?serviceMonth=2026-06').set('Authorization', `Bearer ${adminToken}`)
    const p = res.body.data.list.find((x: any) => x.partnerId === PID)
    expect(p.costTotal).toBe(0)
    expect(p.costMatched).toBe(false)
  })

  it('POST /backfill-abc-partner → 按 case_no 回填 partner_id', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/partner-pnl/backfill-abc-partner').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toBeGreaterThanOrEqual(1)
  })
})

describe('W5 完整：院级 P&L = 收入 − 成本', () => {
  it('和睦家：实收2100 / 实验室收入2100(with_diagnosis) / 成本800 / 毛利1300 / 毛利率0.619', async () => {
    const request = await req()
    const res = await request(app).get('/api/v1/partner-pnl?serviceMonth=2026-06').set('Authorization', `Bearer ${adminToken}`)
    const p = res.body.data.list.find((x: any) => x.partnerId === PID)
    expect(p.netRevenueTotal).toBe(2100)
    expect(p.labRevenueTotal).toBe(2100)
    expect(p.costTotal).toBe(800)
    expect(p.grossMargin).toBe(1300)
    expect(p.marginRate).toBe(0.619)
    expect(p.costMatched).toBe(true)
    expect(p.qualityCounts.ok).toBe(1)
  })
})

describe('W6/W5 RBAC（成本敏感）', () => {
  it('pathologist（无 cost_analysis）查 P&L 被拒 403；回填(reconciliation W)亦被拒 403', async () => {
    const request = await req()
    expect((await request(app).get('/api/v1/partner-pnl').set('Authorization', `Bearer ${pathoToken}`)).status).toBe(403)
    expect((await request(app).post('/api/v1/partner-pnl/backfill-abc-partner').set('Authorization', `Bearer ${pathoToken}`)).status).toBe(403)
  })
})
