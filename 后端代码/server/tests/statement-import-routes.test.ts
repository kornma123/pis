/**
 * P4 — 对账单导入 API 路由测试（/preview 干跑不落库 + /classify-rule 写回该院配置立即生效 + RBAC）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any, db: any
let adminToken = '', financeToken = '', pathoToken = ''
const PID = 'PT-IMP-1'

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  const r = await request(app).post('/api/v1/auth/login').send({ username: u, password: p })
  return r.body?.data?.token || ''
}
async function st() { return (await import('supertest')).default }

// 合成 line_item 网格：S26-001 组织学(默认命中 IN) + S26-002「组织学中英文报告」默认未匹配 + 合计行
const GRID = [
  ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
  ['S26-001', '手术标本检查与诊断(小标本)', '190', '0.8', '152'],
  ['S26-002', '组织学中英文报告-外籍人士', '150', '1', '150'],
  ['合计', '', '340', '', '302'],
]

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'PT-IMP01', '导入测试医院', 1)`).run(PID)
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id) VALUES ('LC-I1','S26-001',?)`).run(PID)
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id) VALUES ('LC-I2','S26-002',?)`).run(PID)
  const authRoutes = (await import('../src/routes/auth.js')).default
  const cfgRoutes = (await import('../src/routes/partner-config-v1.1.js')).default
  const impRoutes = (await import('../src/routes/statement-import-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/partner-config', router: cfgRoutes },
    { path: '/api/v1/statement-import', router: impRoutes },
  ])
  adminToken = await login('admin', 'admin123')
  financeToken = await login('caiwu', 'CoreOne2026!')
  pathoToken = await login('yishi1', 'CoreOne2026!')
})

describe('POST /preview（干跑，不落库）', () => {
  it('finance 预览 → 200：labRevenue=152，未匹配 1 行(组织学报告)，对账闭合 302', async () => {
    const request = await st()
    const res = await request(app).post('/api/v1/statement-import/preview').set('Authorization', `Bearer ${financeToken}`)
      .send({ partnerId: PID, grid: GRID })
    expect(res.status).toBe(200)
    expect(res.body.data.template).toBe('line_item')
    expect(res.body.data.declaredTotal).toBe(302)
    expect(res.body.data.revenue.labRevenue).toBe(152)
    expect(res.body.data.revenue.totalSettle).toBe(302) // 守恒
    expect(res.body.data.revenue.counts.unmatched).toBe(1)
    expect(res.body.data.needsAttention.some((r: any) => r.no === 'S26-002')).toBe(true)
  })
  it('正向病例匹配命中 LIS（S26-001/002 都在 LIS）', async () => {
    const request = await st()
    const res = await request(app).post('/api/v1/statement-import/preview').set('Authorization', `Bearer ${adminToken}`).send({ partnerId: PID, grid: GRID })
    expect(res.body.data.score.caseMatch.forward.pass).toBe(true)
  })
  it('pathologist → 403', async () => {
    const request = await st()
    const res = await request(app).post('/api/v1/statement-import/preview').set('Authorization', `Bearer ${pathoToken}`).send({ partnerId: PID, grid: GRID })
    expect(res.status).toBe(403)
  })
  it('干跑未落库：case_revenue + partner_configs 均 0 行（preview 不 seed 配置·codex F4）', () => {
    expect((db.prepare('SELECT COUNT(*) AS t FROM case_revenue WHERE partner_id=?').get(PID) as any).t).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS t FROM partner_configs WHERE partner_id=?').get(PID) as any).t).toBe(0)
  })
  it('缺 grid → 400', async () => {
    const request = await st()
    const res = await request(app).post('/api/v1/statement-import/preview').set('Authorization', `Bearer ${adminToken}`).send({ partnerId: PID })
    expect(res.status).toBe(400)
  })
})

describe('POST /classify-rule（写回该院配置，立即生效）', () => {
  it('给 histo 加识别词「报告」→ 版本+1，再预览该行计入 IN（守恒不变）', async () => {
    const request = await st()
    const rule = await request(app).post('/api/v1/statement-import/classify-rule').set('Authorization', `Bearer ${financeToken}`)
      .send({ partnerId: PID, lineKey: 'histo', ruleType: 'keyword', value: '报告' })
    expect(rule.status).toBe(200)
    expect(rule.body.data.version).toBeGreaterThan(1)

    // 配置已写入「报告」识别词
    const cfg = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${adminToken}`)
    expect(cfg.body.data.config.lines.find((l: any) => l.key === 'histo').keywords).toContain('报告')

    // 重新预览：S26-002 现命中 histo IN → labRevenue=302、未匹配 0
    const res = await request(app).post('/api/v1/statement-import/preview').set('Authorization', `Bearer ${adminToken}`).send({ partnerId: PID, grid: GRID })
    expect(res.body.data.revenue.labRevenue).toBe(302)
    expect(res.body.data.revenue.counts.unmatched).toBe(0)
  })
  it('新建业务线（scope out）+ 识别词', async () => {
    const request = await st()
    const res = await request(app).post('/api/v1/statement-import/classify-rule').set('Authorization', `Bearer ${financeToken}`)
      .send({ partnerId: PID, newLine: { name: '特殊外送线', scope: 'out' }, ruleType: 'keyword', value: '特殊外送项' })
    expect(res.status).toBe(200)
    expect(res.body.data.scope).toBe('out')
    const cfg = await request(app).get(`/api/v1/partner-config/${PID}`).set('Authorization', `Bearer ${adminToken}`)
    expect(cfg.body.data.config.lines.some((l: any) => l.name === '特殊外送线' && l.scope === 'out')).toBe(true)
  })
  it('参数无效（ruleType 非法）→ 400', async () => {
    const request = await st()
    const res = await request(app).post('/api/v1/statement-import/classify-rule').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: PID, lineKey: 'histo', ruleType: 'bogus', value: 'x' })
    expect(res.status).toBe(400)
  })
  it('pathologist → 403', async () => {
    const request = await st()
    const res = await request(app).post('/api/v1/statement-import/classify-rule').set('Authorization', `Bearer ${pathoToken}`)
      .send({ partnerId: PID, lineKey: 'histo', ruleType: 'keyword', value: 'x' })
    expect(res.status).toBe(403)
  })
})
