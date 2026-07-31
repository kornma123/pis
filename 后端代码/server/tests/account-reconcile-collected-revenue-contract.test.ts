/**
 * Issue #94：supplement_orders.collected_revenue canonical 合同（route 层）。
 *
 * 合同：SQLite integer/real、有限、非负、精度不超过既有金额小数位（DECIMAL(18,4)）、
 * 上限复用仓库既有 canonical amount 权威（canonicalReconciliationAmount：
 * 直接 Number 需 abs < 2^39，scaled safe-integer 边界以内，≤4 位小数）。
 * collect 路由在写入前分别验证源 amount、扣率与计算结果；异常稳定 fail-closed，
 * 零业务写、零业务审计写（abc_audit_logs 无 supplement_collect 增量）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin, loginAs, seedReviewer } from './p0-harness.js'

const MONTH = '2026-09'
const CHAIN_MONTH = '2026-10'
let app: any
let token = ''
let reviewerToken = ''
let seq = 0

async function mountApp() {
  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    {
      path: '/api/v1/account-reconcile',
      router: routes,
      middleware: [authenticateToken, requirePermission('account_reconcile', 'R')],
    },
  ])
}

const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)

async function seedSupplement(tag: string, month = MONTH): Promise<{ db: any; supId: string; lineId: string }> {
  const db = await getDb()
  const suffix = `${tag}-${++seq}`
  const partnerId = `PT-I94-${suffix}`
  const statementGenerationId = `STMT-I94-${suffix}`
  const reconcileGenerationId = `RECON-I94-${suffix}`
  const batchId = `BATCH-I94-${suffix}`
  const lineId = `LINE-I94-${suffix}`
  const caseNo = `CASE-I94-${suffix}`
  const binding = {
    partnerId,
    settlementMonth: month,
    statementGenerationId,
    reconcileGenerationId,
  }

  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)`)
    .run(partnerId, `I94-${suffix}`, `Issue94 ${suffix}`)
  db.prepare(`
    INSERT INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
    VALUES (?, ?, ?, 'test', 'r1', 'c1', ?, ?, 1, 1, 1, 'posted')
  `).run(batchId, partnerId, `HASH-${suffix}`, month, statementGenerationId)
  db.prepare(`
    INSERT INTO statement_raw_rows (id, batch_id, generation_id, source_sheet, source_row, row_json)
    VALUES (?, ?, ?, 'sheet', 1, '{}')
  `).run(`RAW-${suffix}`, batchId, statementGenerationId)
  db.prepare(`
    INSERT INTO statement_normalized_lines
      (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
       case_no, item_name, source_sheet, source_row, source_column, source_label,
       template_family, row_kind, line_grain, business_line, amount_role, amount, classification_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, '免疫组化染色*3', 'sheet', 1, 'amount', '免疫组化染色*3',
            'test', 'detail', 'case', 'IN', 'gross', 300, 'classified')
  `).run(`NORM-${suffix}`, batchId, statementGenerationId, partnerId, month, month, caseNo)
  db.prepare(`
    INSERT INTO case_revenue_lines
      (id, case_no, partner_id, charge_item, qty, unit_price, service_month)
    VALUES (?, ?, ?, '免疫组化染色', 3, 100, ?)
  `).run(lineId, caseNo, partnerId, month)
  db.prepare(`
    INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time)
    VALUES (?, ?, ?, 5, 0, ?)
  `).run(`LIS-${suffix}`, caseNo, partnerId, `${month}-10`)
  db.prepare(`
    INSERT OR IGNORE INTO case_revenue
      (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
    VALUES (?, ?, ?, ?, 1000, 800, 800, 'statement')
  `).run(`REV-${suffix}`, caseNo, partnerId, month)

  const computed = await auth(request(app).post('/api/v1/account-reconcile/compute').send(binding))
  expect(computed.status).toBe(200)
  const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(binding))
  const diff = (wb.body.data.diffs as Array<{ id: string }>)[0]
  const verdict = await auth(request(app)
    .post(`/api/v1/account-reconcile/diffs/${diff.id}/verdict`)
    .send({ ...binding, reason: '漏收，需补收' }))
  expect(verdict.status).toBe(200)
  const sup = db.prepare('SELECT id FROM supplement_orders WHERE source_diff_id = ?')
    .get(diff.id) as { id: string }
  const approved = await request(app)
    .post(`/api/v1/account-reconcile/supplements/${sup.id}/approve`)
    .set('Authorization', `Bearer ${reviewerToken}`)
    .send({})
  expect(approved.status).toBe(200)
  return { db, supId: sup.id, lineId }
}

beforeAll(async () => {
  const db = await getDb()
  await seedReviewer(db)
  app = await mountApp()
  token = await loginAdmin(app)
  reviewerToken = await loginAs(app, 'reviewer2', 'CoreOne2026!')
})

describe('Issue #94 collect 路由：collected_revenue canonical 合同', () => {
  it('异常源 amount（负数/NaN 文本/Infinity 文本/1e308/2^39 边界）→ 409 且零业务写、零业务审计写', async () => {
    const badAmounts: unknown[] = [-1, 'NaN', 'Infinity', 1e308, 549755813888]
    for (const bad of badAmounts) {
      const { db, supId } = await seedSupplement(`amount-${String(bad)}`)
      db.prepare('UPDATE supplement_orders SET amount = ? WHERE id = ?').run(bad, supId)
      const snapshot = () => db.prepare(
        'SELECT status, collected_at, collected_month, collected_revenue FROM supplement_orders WHERE id = ?',
      ).get(supId)
      const auditCount = () => (db.prepare(
        'SELECT COUNT(*) AS n FROM abc_audit_logs WHERE action = ? AND target_id = ?',
      ).get('supplement_collect', supId) as { n: number }).n
      const before = snapshot()
      const auditBefore = auditCount()

      const res = await auth(request(app)
        .post(`/api/v1/account-reconcile/supplements/${supId}/collect`)
        .send({ collectedMonth: MONTH }))
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('SUPPLEMENT_SOURCE_AMOUNT_INVALID')
      expect(snapshot()).toEqual(before)
      expect(auditCount()).toBe(auditBefore)
    }
  })

  it('异常扣率（负数/大于 1/Infinity）→ 409 且零业务写、零业务审计写', async () => {
    const badRates = [
      { label: 'negative', gross: 100, net: -100 },
      { label: 'over-one', gross: 100, net: 200 },
      { label: 'infinite', gross: 100, net: Infinity },
    ]
    for (const rate of badRates) {
      const { db, supId, lineId } = await seedSupplement(`rate-${rate.label}`)
      db.prepare('UPDATE case_revenue_lines SET gross_amount = ?, net_amount = ? WHERE id = ?')
        .run(rate.gross, rate.net, lineId)
      const snapshot = () => db.prepare(
        'SELECT status, collected_at, collected_month, collected_revenue FROM supplement_orders WHERE id = ?',
      ).get(supId)
      const auditCount = () => (db.prepare(
        'SELECT COUNT(*) AS n FROM abc_audit_logs WHERE action = ? AND target_id = ?',
      ).get('supplement_collect', supId) as { n: number }).n
      const before = snapshot()
      const auditBefore = auditCount()

      const res = await auth(request(app)
        .post(`/api/v1/account-reconcile/supplements/${supId}/collect`)
        .send({ collectedMonth: MONTH }))
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('SUPPLEMENT_RATE_INVALID')
      expect(snapshot()).toEqual(before)
      expect(auditCount()).toBe(auditBefore)
    }
  })

  it('合法 0 与 canonical 边界值（2^39 以内、≤4 位小数）collect 成功', async () => {
    const zero = await seedSupplement('zero')
    zero.db.prepare('UPDATE supplement_orders SET amount = 0 WHERE id = ?').run(zero.supId)
    const zeroRes = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${zero.supId}/collect`)
      .send({ collectedMonth: MONTH }))
    expect(zeroRes.status).toBe(200)
    expect(zeroRes.body.data.collectedRevenue).toBe(0)
    expect(zero.db.prepare(
      'SELECT status, collected_month, collected_revenue FROM supplement_orders WHERE id = ?',
    ).get(zero.supId)).toMatchObject({ status: '已补收', collected_month: MONTH, collected_revenue: 0 })

    const boundary = await seedSupplement('boundary')
    boundary.db.prepare('UPDATE supplement_orders SET amount = ? WHERE id = ?')
      .run(549755813887.99, boundary.supId)
    const boundaryRes = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${boundary.supId}/collect`)
      .send({ collectedMonth: MONTH }))
    expect(boundaryRes.status).toBe(200)
    expect(boundaryRes.body.data.collectedRevenue)
      .toBe(Math.round(549755813887.99 * 0.8 * 100) / 100)
    expect(boundary.db.prepare(
      'SELECT collected_revenue FROM supplement_orders WHERE id = ?',
    ).get(boundary.supId)).toMatchObject({ collected_revenue: Math.round(549755813887.99 * 0.8 * 100) / 100 })
  })

  it('合法 collect → giveup → reopen 清理链与 board 汇总保持 GREEN（配对清理）', async () => {
    const { db, supId } = await seedSupplement('chain', CHAIN_MONTH)
    const snapshot = () => db.prepare(
      'SELECT status, collected_at, collected_month, collected_revenue FROM supplement_orders WHERE id = ?',
    ).get(supId)

    const collected = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supId}/collect`)
      .send({ collectedMonth: CHAIN_MONTH }))
    expect(collected.status).toBe(200)
    expect(collected.body.data.collectedRevenue).toBe(160)
    expect(snapshot()).toMatchObject({ status: '已补收', collected_month: CHAIN_MONTH, collected_revenue: 160 })

    const gaveUp = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supId}/giveup`)
      .send({ reason: 'Issue94 链测试' }))
    expect(gaveUp.status).toBe(200)
    expect(snapshot()).toMatchObject({ status: '已放弃', collected_month: null, collected_revenue: null })

    const reopened = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supId}/reopen`)
      .send({ reason: 'Issue94 链测试' }))
    expect(reopened.status).toBe(200)
    expect(snapshot()).toMatchObject({ status: '待补收', collected_month: null, collected_revenue: null })

    await request(app)
      .post(`/api/v1/account-reconcile/supplements/${supId}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({})
    const recollected = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supId}/collect`)
      .send({ collectedMonth: CHAIN_MONTH }))
    expect(recollected.status).toBe(200)
    const board = await auth(request(app)
      .get('/api/v1/account-reconcile/supplements')
      .query({ serviceMonth: CHAIN_MONTH }))
    expect(board.body.data.board.已补收实收).toBeCloseTo(160, 2)
  })
})
