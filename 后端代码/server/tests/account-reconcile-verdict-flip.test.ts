/**
 * 边界④ 超期免费 —— 认定翻转（免费 ↔ 补收）不变量。
 * 口径（用户 2026-07-02 拍板）：超期免费=财务判断，非系统硬规则；「免费」是暂态——
 * 日后合作医院同意补，改认定「漏收，需补收」即自动生成补收单；反向亦然。
 * 后端 verdict 端点本就支持重认定，此测锁死翻转对补收单的增删口径。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

const P = 'PT-FLIP-1'
const M = '2026-08'
const S = 'STMT-FLIP-1'
const R = 'RECON-FLIP-1'
let app: any
let token = ''
let diffId = ''

async function mountApp() {
  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    { path: '/api/v1/account-reconcile', router: routes, middleware: [authenticateToken, requirePermission('account_reconcile', 'R')] },
  ])
}

beforeAll(async () => {
  const db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'FLIP', '翻转测试院', 1)`).run(P)
  db.prepare(
    `INSERT INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
     VALUES ('BATCH-FLIP-1', ?, 'HASH-FLIP-1', 'test', 'r1', 'c1', ?, ?, 1, 1, 1, 'posted')`,
  ).run(P, M, S)
  db.prepare(
    `INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
     VALUES ('RAW-FLIP-1', 'BATCH-FLIP-1', ?, 'sheet', 1, '{}')`,
  ).run(S)
  db.prepare(
    `INSERT INTO statement_normalized_lines
      (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
       case_no, item_name, source_sheet, source_row, source_column, source_label,
       template_family, row_kind, line_grain, business_line, amount_role, amount, classification_status)
     VALUES ('LINE-FLIP-1', 'BATCH-FLIP-1', ?, ?, ?, ?, 'FC1', '免疫组化染色*2',
             'sheet', 1, 'amount', '免疫组化染色*2', 'test', 'detail', 'case',
             'IN', 'gross', 200, 'classified')`,
  ).run(S, P, M, M)
  // 账单免疫组化 2 片 vs LIS 5 片 → 漏收 -3（amount 300）
  db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('fl-1', 'FC1', P, '免疫组化染色', 2, 100, M)
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('flc-1', 'FC1', P, 5, 0, '2026-08-10')
  app = await mountApp()
  token = await loginAdmin(app)
})

const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)
const exactBinding = { partnerId: P, settlementMonth: M, statementGenerationId: S, reconcileGenerationId: R }
const supCount = async () => {
  const s = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}&status=待补收`))
  return s.body.data.list.length
}

describe('账实核对 · 认定翻转（超期免费 ↔ 漏收补收）', () => {
  it('compute → 得漏收差异', async () => {
    const c = await auth(request(app).post('/api/v1/account-reconcile/compute').send(exactBinding))
    expect(c.status).toBe(200)
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(exactBinding))
    const d = wb.body.data.diffs.find((x: any) => x.caseNo === 'FC1')
    expect(d.systemHint).toBe('疑似漏收，需补收')
    diffId = d.id
  })

  it('认定「超期，免费做的」→ 不生成补收单', async () => {
    const r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${diffId}/verdict`).send({ reason: '超期，免费做的' }))
    expect(r.status).toBe(200)
    expect(r.body.data.followUp).toBe('free')
    expect(await supCount()).toBe(0)
  })

  it('翻转：改认定「漏收，需补收」→ 自动生成补收单（¥300 待补收）', async () => {
    const r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${diffId}/verdict`).send({ reason: '漏收，需补收' }))
    expect(r.status).toBe(200)
    expect(r.body.data.followUp).toBe('supplement')
    const s = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}&status=待补收`))
    expect(s.body.data.list.length).toBe(1)
    expect(s.body.data.list[0].amount).toBe(300)
  })

  it('翻回「超期，免费做的」→ 待补收单被清（免费状态可逆）', async () => {
    const r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${diffId}/verdict`).send({ reason: '超期，免费做的' }))
    expect(r.status).toBe(200)
    expect(await supCount()).toBe(0)
  })
})
