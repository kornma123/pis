/**
 * 账实核对补收单 maker-checker 人闸 + SoD 回归门禁（非-P0 审计项 D 止血）。
 *
 * 背景：verdict 认定端点在同一请求内直接 INSERT 真金补收单（supplement_orders），无第二审核人 →
 * 方向偏差信号（floor-to-1 令 bill<台账 → 判「疑似漏收，需补收」）直通不可逆真金动作、中间无人。
 * = P0「检测与处方分离 + 人闸居中」的病换器官。
 *
 * 止血：补收单加 review_status（默认 pending_review）+ 独立 approve 端点（唯一 →approved）+ SoD
 * （认定人 submitted_by ≠ 签发人）+ collect 前置门（未 approved 拒收款）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin, loginAs, seedReviewer } from './p0-harness.js'

const P = 'PT-DGATE-1'
const M = '2026-08'
const S = 'STMT-DGATE-1'
const R = 'RECON-DGATE-1'
let app: any
let token = '' // admin = 认定人/提交人
let reviewerToken = '' // reviewer2 = 独立签发人

async function mountApp() {
  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    { path: '/api/v1/account-reconcile', router: routes, middleware: [authenticateToken, requirePermission('account_reconcile', 'R')] },
  ])
}

function seed(db: any) {
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'DG-1', '人闸测试院', 1)`).run(P)
  db.prepare(
    `INSERT INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
     VALUES ('BATCH-DGATE-1', ?, 'HASH-DGATE-1', 'test', 'r1', 'c1', ?, ?, 1, 1, 1, 'posted')`,
  ).run(P, M, S)
  db.prepare(
    `INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
     VALUES ('RAW-DGATE-1', 'BATCH-DGATE-1', ?, 'sheet', 1, '{}')`,
  ).run(S)
  db.prepare(
    `INSERT INTO statement_normalized_lines
      (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
       case_no, item_name, source_sheet, source_row, source_column, source_label,
       template_family, row_kind, line_grain, business_line, amount_role, amount, classification_status)
     VALUES ('LINE-DGATE-1', 'BATCH-DGATE-1', ?, ?, ?, ?, 'DG1', '免疫组化染色*3',
             'sheet', 1, 'amount', '免疫组化染色*3', 'test', 'detail', 'case',
             'IN', 'gross', 300, 'classified')`,
  ).run(S, P, M, M)
  // 免疫组化 bill 3 片（LIS 5）→ delta −2 → 判「疑似漏收，需补收」→ 驱动补收单
  db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('dg-l1', 'DG1', P, '免疫组化染色', 3, 100, M)
  db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('dg-lc1', 'DG1', P, 5, 0, '2026-08-10')
  db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
    .run('dg-cr1', 'DG1', P, M, 1000, 800, 800)
}

const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)
const asReviewer = (r: any) => r.set('Authorization', `Bearer ${reviewerToken}`)
const get = (path: string) => auth(request(app).get(path))
const post = (path: string, body: any = {}) => auth(request(app).post(path).send(body))
const exactBinding = { partnerId: P, settlementMonth: M, statementGenerationId: S, reconcileGenerationId: R }
async function supId(): Promise<string> {
  const sup = await get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}`)
  return sup.body.data.list[0].id
}

beforeAll(async () => {
  const db = await getDb()
  seed(db)
  await seedReviewer(db)
  app = await mountApp()
  token = await loginAdmin(app)
  reviewerToken = await loginAs(app, 'reviewer2', 'CoreOne2026!')
  // 计算差异 → 认定漏收 → 生成补收单（submitted_by=admin, review_status=pending_review）
  await post('/api/v1/account-reconcile/compute', exactBinding)
  const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(exactBinding))
  const diff = wb.body.data.diffs.find((d: any) => d.caseNo === 'DG1' && d.amountImpact === 200)
  await post(`/api/v1/account-reconcile/diffs/${diff.id}/verdict`, { reason: '漏收，需补收' })
})

describe('D · 补收单 maker-checker 人闸', () => {
  it('SG-1 认定生成的补收单默认 pending_review、submitted_by=认定人', async () => {
    const sup = await get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}`)
    const s = sup.body.data.list[0]
    expect(s.amount).toBe(200)
    expect(s.status).toBe('待补收')
    expect(s.reviewStatus).toBe('pending_review')
    expect(s.submittedBy).toBe('admin')
    expect(sup.body.data.board.待签发数).toBe(1)
  })

  it('SG-2 未签发直接收款 → 409 NOT_APPROVED（人闸拦截真金动作）', async () => {
    const res = await post(`/api/v1/account-reconcile/supplements/${await supId()}/collect`, { collectedMonth: M })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_APPROVED')
  })

  it('SG-3 SoD：认定人（admin）签发自己提交的补收单 → 403 SELF_REVIEW_FORBIDDEN', async () => {
    const res = await post(`/api/v1/account-reconcile/supplements/${await supId()}/approve`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SELF_REVIEW_FORBIDDEN')
  })

  it('SG-4 独立签发人（reviewer2）approve → 200 approved；随后 collect 放行', async () => {
    const id = await supId()
    const appr = await asReviewer(request(app).post(`/api/v1/account-reconcile/supplements/${id}/approve`).send({}))
    expect(appr.status).toBe(200)
    expect(appr.body.data.reviewStatus).toBe('approved')
    expect(appr.body.data.reviewedBy).toBe('reviewer2')
    const col = await post(`/api/v1/account-reconcile/supplements/${id}/collect`, { collectedMonth: M })
    expect(col.status).toBe(200)
    expect(col.body.data.status).toBe('已补收')
  })

  it('SG-5 重复签发 → 409（已 approved / 非待补收）', async () => {
    // 已 collect → 状态已补收，approve 应拒
    const res = await asReviewer(request(app).post(`/api/v1/account-reconcile/supplements/${await supId()}/approve`).send({}))
    expect(res.status).toBe(409)
  })

  it('SG-6 reopen 回退复核态 → 再收款须重新签发（防绕过人闸）', async () => {
    const id = await supId()
    await post(`/api/v1/account-reconcile/supplements/${id}/reopen`, { reason: '误标' })
    const sup = await get(`/api/v1/account-reconcile/supplements?serviceMonth=${M}`)
    expect(sup.body.data.list[0].reviewStatus).toBe('pending_review') // 复核态被回退
    // 未重新签发直接收款 → 再次 409
    const col = await post(`/api/v1/account-reconcile/supplements/${id}/collect`, { collectedMonth: M })
    expect(col.status).toBe(409)
    expect(col.body.error.code).toBe('NOT_APPROVED')
  })

  it('SG-7 approve 不存在的补收单 → 404', async () => {
    const res = await asReviewer(request(app).post(`/api/v1/account-reconcile/supplements/nonexistent/approve`).send({}))
    expect(res.status).toBe(404)
  })

  it('SG-8 fail-closed：submitted_by 缺失(空串)的补收单不可签发 → 403（防 SoD 短路绕过）', async () => {
    const db = await getDb()
    db.prepare(`INSERT INTO supplement_orders (id, partner_id, service_month, case_no, amount, status, review_status, submitted_by)
                VALUES ('SO-EMPTY-SUB', ?, ?, 'X', 100, '待补收', 'pending_review', '')`).run(P, M)
    const res = await asReviewer(request(app).post(`/api/v1/account-reconcile/supplements/SO-EMPTY-SUB/approve`).send({}))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SELF_REVIEW_FORBIDDEN')
  })
})
