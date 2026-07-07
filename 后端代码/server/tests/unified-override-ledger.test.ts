/**
 * 统一旁路台账回归门禁（非-P0 审计项 ⑦）。
 *
 * E/A/B/D 各道闸修完后的人工旁路/软兜底（B confirm 强制落库 / A 出库软兜底 / D 补收单签发）汇入一张 override_log 表
 * （gate_type + operator + reason 必填 + before/after 快照）+「旁路使用频率」体检指标。防旁路无声搬家成新的无守卫写路径。
 */
process.env.DATABASE_PATH = ':memory:'

import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { recordOverride, getOverrideFrequency } from '../src/utils/override-log.js'

const getApp = async () => {
  const { default: app } = await import('../src/app.js')
  const { getDatabase } = await import('../src/database/DatabaseManager.js')
  return { app, db: getDatabase() }
}
let app: any, db: any, token = ''
async function login(): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })
  return res.body.data.token
}
const overrideRows = (gate?: string) =>
  db.prepare(`SELECT * FROM override_log ${gate ? 'WHERE gate_type = ?' : ''} ORDER BY created_at DESC`).all(...(gate ? [gate] : [])) as any[]

beforeAll(async () => {
  ;({ app, db } = await getApp())
  token = await login()
})

describe('⑦ · recordOverride / getOverrideFrequency 纯函数', () => {
  it('OV-1 recordOverride 落一行；getOverrideFrequency 按 gate_type 聚合', () => {
    recordOverride(db, { gateType: 'import_confirm', module: 'statement_import', targetId: 'P:2026-01', operator: 'u1', reason: '越闸理由', before: { a: 1 }, after: { b: 2 } })
    recordOverride(db, { gateType: 'import_confirm', module: 'statement_import', targetId: 'P:2026-02', operator: 'u2', reason: 'r2' })
    recordOverride(db, { gateType: 'supplement_approve', module: 'account_reconcile', targetId: 'SO-1', operator: 'u1', reason: 'r3' })
    const freq = getOverrideFrequency(db)
    const imp = freq.byGate.find((g) => g.gateType === 'import_confirm')!
    expect(imp.count).toBe(2)
    expect(imp.distinctOperators).toBe(2)
    expect(freq.byGate.find((g) => g.gateType === 'supplement_approve')!.count).toBe(1)
    expect(freq.total).toBeGreaterThanOrEqual(3)
  })
  it('OV-2 空 reason → 落 "(未提供理由)" 而非丢失记录（reason 列 NOT NULL 也不崩）', () => {
    recordOverride(db, { gateType: 'ledger_drift_fallback', module: 'outbound', targetId: 'OB-X', operator: 'sys', reason: '   ' })
    const row = overrideRows('ledger_drift_fallback').find((r) => r.target_id === 'OB-X')
    expect(row).toBeTruthy()
    expect(row.reason).toBe('(未提供理由)')
  })
})

describe('⑦ · B confirm 旁路必须留 overrideReason + 落台账', () => {
  const PID = 'PT-OV-1'
  const NOTOTAL = [
    ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
    ['OV-700', '手术标本检查与诊断', '190', '0.8', '152'], // 全匹配但无独立合计行 → closure 闸
  ]
  beforeAll(() => {
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'OV-1', 'OV院', 1)`).run(PID)
  })
  const commit = (body: any) => request(app).post('/api/v1/statement-import/commit').set('Authorization', `Bearer ${token}`).send(body)

  it('OV-3 confirm 越闸缺 overrideReason → 400 OVERRIDE_REASON_REQUIRED', async () => {
    const res = await commit({ partnerId: PID, grid: NOTOTAL, serviceMonth: '2026-03', confirm: true })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('OVERRIDE_REASON_REQUIRED')
  })
  it('OV-4 带 overrideReason → 200 落库 + override_log 记 import_confirm（含 reason/operator/快照）', async () => {
    const res = await commit({ partnerId: PID, grid: NOTOTAL, serviceMonth: '2026-03', confirm: true, overrideReason: '无合计行·财务已核' })
    expect(res.status).toBe(200)
    const row = overrideRows('import_confirm').find((r) => r.target_id === `${PID}:2026-03`)
    expect(row).toBeTruthy()
    expect(row.reason).toBe('无合计行·财务已核')
    expect(row.operator).toBe('admin')
    expect(JSON.parse(row.before_snapshot).gateReasons.length).toBeGreaterThan(0)
    expect(JSON.parse(row.after_snapshot).caseCount).toBe(1)
  })
})

describe('⑦ · 体检端点 GET /logs/override-frequency', () => {
  it('OV-5 返回按 gate_type 聚合的旁路频率', async () => {
    const res = await request(app).get('/api/v1/logs/override-frequency').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.byGate)).toBe(true)
    expect(res.body.data.total).toBeGreaterThan(0)
    // 至少含前面测试造的 import_confirm
    expect(res.body.data.byGate.some((g: any) => g.gateType === 'import_confirm')).toBe(true)
  })
})
