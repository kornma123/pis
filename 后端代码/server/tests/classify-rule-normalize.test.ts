/**
 * PRD-0 T2 补漏 — classify-rule 配置写回路径也须归一（对抗复核 HIGH）。
 *
 * statement-import /classify-rule 把归类规则写回该院 config 后 saveConfig，原未经 normalizeConfig →
 * 是 PUT 之外第二个配置写路径，会在坏历史配置上叠加新版本、把坏值再次持久化（row2config best-effort
 * 对【含其它无法归一字段】的配置整体回退原值 → def=90 未被治理）。补：写前严格归一，与 PUT 路由一致。
 *  - 健康历史坏扣率（def=90、key 合法）经 classify-rule 写回 → 新版本已归一为 0.9（顺带治理）。
 *  - 无法归一的坏配置（空 line key）→ classify-rule 400，不在坏配置上生成新版本。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'
import { v4 as uuidv4 } from 'uuid'
import { seedDefaultConfig, type PartnerConfig } from '../src/utils/partner-config.js'

let app: any, db: any, token = ''

function injectCurrent(partnerId: string, config: PartnerConfig) {
  db.prepare(`UPDATE partner_configs SET is_current=0 WHERE partner_id=?`).run(partnerId)
  db.prepare(`INSERT INTO partner_configs (id, partner_id, version, config_json, is_current, is_baseline, created_by)
              VALUES (?, ?, 1, ?, 1, 0, 'test')`).run(`PC-${uuidv4()}`, partnerId, JSON.stringify(config))
}
async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function classify(partnerId: string, lineKey: string, value: string) {
  const request = (await import('supertest')).default
  return request(app).post('/api/v1/statement-import/classify-rule').set('Authorization', `Bearer ${token}`)
    .send({ partnerId, lineKey, ruleType: 'keyword', value })
}

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES ('CRN-OK','CRN1','治理院',1)`).run()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES ('CRN-BAD','CRN2','坏配置院',1)`).run()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const impRoutes = (await import('../src/routes/statement-import-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/statement-import', router: impRoutes },
  ])
  token = await login('caiwu', 'CoreOne2026!')
})

describe('T2 classify-rule 写回归一', () => {
  it('历史坏扣率 def=90（key 合法）经 classify-rule 写回 → 新版本已归一 0.9 + 关键词已加', async () => {
    const bad = seedDefaultConfig({ name: '治理院', code: 'x' }); (bad.discount as any).def = 90
    injectCurrent('CRN-OK', bad)
    const res = await classify('CRN-OK', 'histo', '新识别词A')
    expect(res.status).toBe(200)
    const cur = db.prepare(`SELECT config_json FROM partner_configs WHERE partner_id='CRN-OK' AND is_current=1`).get() as any
    const cfg = JSON.parse(cur.config_json)
    expect(cfg.discount.def).toBe(0.9) // 写回时已归一，不再把 90 持久化
    expect(cfg.lines.find((l: any) => l.key === 'histo').keywords).toContain('新识别词A')
  })

  it('无法归一的坏配置（空 line key）→ classify-rule 400，不在坏配置上生成新版本', async () => {
    const broken: any = seedDefaultConfig({ name: '坏配置院', code: 'x' })
    broken.lines[0].key = '' // 整体无法归一 → row2config 回退原值 → 写回须拒绝
    broken.discount.def = 90
    injectCurrent('CRN-BAD', broken)
    const res = await classify('CRN-BAD', 'cyto', '关键词')
    expect(res.status).toBe(400)
    const cnt = (db.prepare(`SELECT COUNT(*) t FROM partner_configs WHERE partner_id='CRN-BAD'`).get() as any).t
    expect(cnt).toBe(1) // 未生成 v2（不在坏配置上叠加）
  })
})
