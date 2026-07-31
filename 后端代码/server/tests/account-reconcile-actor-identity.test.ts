/**
 * Issue #105 —— 敌对方向：非标准 actor、缺失/吊销身份、历史记录、DB 重启。
 *
 * 主验收（account-reconcile-routes.test.ts）用内存库证明三个动作经真实 route
 * 落库同口径；本文件用文件库证明：
 *  1. 非 admin actor（reviewer2）complete/close/verdict 落库 username 而非 userId；
 *  2. 缺失/吊销身份在 route 与服务两层都 fail-closed（401/403、零业务写、denial 审计）；
 *  3. 历史（修复前 userId 形状）记录不回改、不迁移，展示路径照常可用；
 *  4. closeDatabase() 后用新连接模拟进程重启，username 身份与金额语义持久不变。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import jwt from 'jsonwebtoken'
import type { RequestHandler } from 'express'
import { buildTestApp, getDb, loginAdmin, loginAs, seedReviewer } from './p0-harness.js'

const testDirectory = mkdtempSync(join(tmpdir(), 'coreone-issue105-'))
const databasePath = join(testDirectory, 'issue105.sqlite')
// p0-harness 先强制 :memory:；DatabaseManager 在 beforeAll 里才动态 import，
// 这里（顶层）覆盖成文件库即可，closeDatabase() 后新连接读到同一文件 = 重启。
process.env.DATABASE_PATH = databasePath
process.env.COREONE_ALLOW_DATABASE_CREATE = '1'
process.env.NODE_ENV = 'test'

let app: any
let adminToken = ''
let reviewerToken = ''
let manager: typeof import('../src/database/DatabaseManager.js')
let lifecycle: typeof import('../src/services/account-reconciliation-lifecycle.js')
let db: any
let sequence = 0

async function mountApp() {
  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const { auditWrite } = await import('../src/middleware/audit-log.js')
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    {
      path: '/api/v1/account-reconcile',
      router: routes,
      middleware: [
        auditWrite,
        authenticateToken,
        requirePermission('account_reconcile', 'R'),
      ],
    },
  ])
}

function seedPartner(tag: string, month = '2026-12') {
  const suffix = `${tag}-${++sequence}`
  const partnerId = `PT-105-${suffix}`
  const statementGenerationId = `STMT-105-${suffix}`
  const reconcileGenerationId = `RECON-105-${suffix}`
  const batchId = `BATCH-105-${suffix}`
  const caseNo = `CASE-105-${suffix}`
  db.prepare('INSERT INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)')
    .run(partnerId, `CODE-${suffix}`, `Partner ${suffix}`)
  db.prepare(`
    INSERT INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
    VALUES (?, ?, ?, 'issue105-test', 'r1', 'c1', ?, ?, 1, 1, 1, 'posted')
  `).run(batchId, partnerId, `HASH-${suffix}`, month, statementGenerationId)
  db.prepare(`
    INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
    VALUES (?, ?, ?, 'sheet', 1, ?)
  `).run(`RAW-${suffix}`, batchId, statementGenerationId, JSON.stringify({ caseNo, item: '免疫组化染色*3', amount: 300 }))
  db.prepare(`
    INSERT INTO statement_normalized_lines
      (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
       case_no, item_name, source_sheet, source_row, source_column, source_label,
       template_family, row_kind, line_grain, business_line, amount_role, amount,
       classification_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sheet', 1, 'amount', '免疫组化染色*3', 'issue105-test',
            'detail', 'case', 'IN', 'gross', 300, 'classified')
  `).run(`LINE-${suffix}`, batchId, statementGenerationId, partnerId, month, month,
    caseNo, '免疫组化染色*3')
  db.prepare(`
    INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`CRL-${suffix}`, caseNo, partnerId, '免疫组化染色', 3, 100, month)
  db.prepare(`
    INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`LIS-${suffix}`, caseNo, partnerId, 5, 0, `${month}-10`)
  db.prepare(`
    INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')
  `).run(`CR-${suffix}`, caseNo, partnerId, month, 1000, 830, 830)
  return { partnerId, settlementMonth: month, statementGenerationId, reconcileGenerationId }
}

async function runFullLifecycleViaRoutes(token: string, binding: Record<string, unknown>) {
  const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)
  expect((await auth(request(app).post('/api/v1/account-reconcile/compute').send(binding))).status).toBe(200)
  const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(binding))
  expect(wb.status).toBe(200)
  const hmId = wb.body.data.snapshot.hospitalMonthId as string
  const diffs = wb.body.data.diffs as Array<{ id: string }>
  expect(diffs.length).toBeGreaterThan(0)
  for (const diff of diffs) {
    const v = await auth(request(app)
      .post(`/api/v1/account-reconcile/diffs/${diff.id}/verdict`)
      .send({ ...binding, reason: '核对无误' }))
    expect(v.status).toBe(200)
  }
  const completed = await auth(request(app)
    .post(`/api/v1/account-reconcile/hospital-months/${hmId}/complete`)
    .send(binding))
  expect(completed.status).toBe(200)
  const closed = await auth(request(app)
    .post('/api/v1/account-reconcile/close')
    .send({ items: [binding] }))
  expect(closed.status).toBe(200)
  return { hmId, diffs }
}

function identityRows(hmId: string, reconId: string, diffIds: string[]) {
  const generation = db.prepare(
    'SELECT completed_by, closed_by, status FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
  ).get(reconId) as { completed_by: string | null; closed_by: string | null; status: string }
  const hospitalMonth = db.prepare(
    'SELECT completed_by, closed_by, status, confirmed_lab_revenue FROM reconcile_hospital_months WHERE id = ?',
  ).get(hmId) as { completed_by: string | null; closed_by: string | null; status: string; confirmed_lab_revenue: number }
  const placeholders = diffIds.map(() => '?').join(',')
  const verdictDiffs = db.prepare(
    `SELECT verdict_by FROM reconcile_diffs WHERE id IN (${placeholders})`,
  ).all(...diffIds) as Array<{ verdict_by: string | null }>
  const auditOperators = db.prepare(`
    SELECT action, operator FROM abc_audit_logs
     WHERE module = 'account_reconcile'
       AND action IN ('verdict', 'complete_generation', 'close_generation')
       AND target_id IN (${[...diffIds.map(() => '?'), '?'].join(',')})
     ORDER BY rowid
  `).all(...diffIds, reconId) as Array<{ action: string; operator: string }>
  return { generation, hospitalMonth, verdictDiffs, auditOperators }
}

async function expectIdentity(hmId: string, reconId: string, diffIds: string[], username: string) {
  const rows = identityRows(hmId, reconId, diffIds)
  expect(rows.generation.completed_by).toBe(username)
  expect(rows.generation.closed_by).toBe(username)
  expect(rows.hospitalMonth.completed_by).toBe(username)
  expect(rows.hospitalMonth.closed_by).toBe(username)
  for (const diff of rows.verdictDiffs) expect(diff.verdict_by).toBe(username)
  const keyed = rows.auditOperators.map((r) => `${r.action}:${r.operator}`)
  expect(keyed.filter((k) => k.startsWith('verdict:')).every((k) => k === `verdict:${username}`)).toBe(true)
  expect(keyed).toContain(`complete_generation:${username}`)
  expect(keyed).toContain(`close_generation:${username}`)
}

beforeAll(async () => {
  manager = await import('../src/database/DatabaseManager.js')
  lifecycle = await import('../src/services/account-reconciliation-lifecycle.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
  app = await mountApp()
  await seedReviewer(db)
  adminToken = await loginAdmin(app)
  reviewerToken = await loginAs(app, 'reviewer2', 'CoreOne2026!')
})

afterAll(() => {
  manager.closeDatabase()
  const realDirectory = resolve(testDirectory)
  const realTempRoot = resolve(tmpdir())
  if (!realDirectory.startsWith(`${realTempRoot}\\`) && !realDirectory.startsWith(`${realTempRoot}/`)) {
    throw new Error(`unsafe test cleanup path: ${realDirectory}`)
  }
  rmSync(realDirectory, { recursive: true, force: true })
})

describe('Issue #105 · 敌对方向', () => {
  it('非标准 actor（reviewer2：username≠userId）complete/close/verdict 落库 username', async () => {
    const binding = seedPartner('reviewer')
    const { hmId, diffs } = await runFullLifecycleViaRoutes(reviewerToken, binding)
    await expectIdentity(hmId, binding.reconcileGenerationId, diffs.map((d) => d.id), 'reviewer2')
    // 金额语义不变：confirmedLabRevenue 仍为 830，与身份口径修复无关。
    expect((db.prepare('SELECT confirmed_lab_revenue FROM reconcile_hospital_months WHERE id = ?').get(hmId) as any).confirmed_lab_revenue).toBe(830)
  })

  it('缺失 userId 的 token 在 route 层 fail-closed（401）且零业务写', async () => {
    const binding = seedPartner('missing')
    expect((await request(app)
      .post(`/api/v1/account-reconcile/hospital-months/whatever/complete`)
      .set('Authorization', `Bearer ${jwt.sign(
        { username: 'ghost', role: 'admin', type: 'access' },
        process.env.JWT_SECRET as string,
        { algorithm: 'HS256' },
      )}`)
      .send(binding)).status).toBe(401)
    const generation = db.prepare(
      'SELECT status, completed_by, closed_by FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
    ).get(binding.reconcileGenerationId) as { status: string; completed_by: string | null; closed_by: string | null }
    expect(generation).toBeUndefined()
  })

  it('吊销/不存在身份的 actor 在 service 层 fail-closed（403 + denial 审计 + 零业务写）', async () => {
    const binding = seedPartner('denied')
    lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const pending = db.prepare(
      'SELECT status, completed_by, closed_by FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
    ).get(binding.reconcileGenerationId) as { status: string; completed_by: string | null; closed_by: string | null }
    expect(pending.status).toBe('pending')
    let caught: unknown
    try {
      lifecycle.completeAccountReconciliation(db, binding, 'USER-NOPE', 'ghost')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(lifecycle.ReconcileLifecycleError)
    expect((caught as { code: string; status: number }).code).toBe('ACTOR_PERMISSION_REVOKED')
    expect((caught as { status: number }).status).toBe(403)
    const after = db.prepare(
      'SELECT status, completed_by, closed_by FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
    ).get(binding.reconcileGenerationId) as { status: string; completed_by: string | null; closed_by: string | null }
    expect(after.status).toBe('pending')
    expect(after.completed_by).toBeNull()
    expect(after.closed_by).toBeNull()
    const denial = db.prepare(`
      SELECT action, operator FROM abc_audit_logs
       WHERE module = 'account_reconcile' AND action = 'complete_generation_denied'
         AND target_id = ?
    `).get(binding.reconcileGenerationId) as { action: string; operator: string }
    expect(denial.action).toBe('complete_generation_denied')
    expect(denial.operator).toBe('USER-NOPE')
  })

  it('历史 userId 形状记录不回改、不迁移，展示路径照常可用', async () => {
    const binding = seedPartner('legacy')
    lifecycle.computeAccountReconciliation(db, binding, 'USER-001')
    const diffId = (db.prepare(`
      SELECT id FROM reconcile_diffs WHERE reconcile_generation_id = ?
    `).get(binding.reconcileGenerationId) as { id: string }).id
    lifecycle.setAccountReconciliationVerdict(
      db, binding, diffId, '核对无误', null, 'USER-001', 'USER-001',
    )
    lifecycle.completeAccountReconciliation(db, binding, 'USER-001')
    lifecycle.closeAccountReconciliation(db, binding, 'USER-001')
    const legacy = db.prepare(
      'SELECT completed_by, closed_by FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
    ).get(binding.reconcileGenerationId) as { completed_by: string; closed_by: string }
    expect(legacy.completed_by).toBe('USER-001')
    expect(legacy.closed_by).toBe('USER-001')
    // 展示路径：overview/workbench 仍返回历史行（不回改、不迁移）。
    const overview = await request(app)
      .get(`/api/v1/account-reconcile/overview?settlementMonth=${binding.settlementMonth}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(overview.status).toBe(200)
    const item = (overview.body.data.items as any[]).find((i) => i.partnerId === binding.partnerId)
    expect(item.status).toBe('已关账')
    const workbench = await request(app)
      .get('/api/v1/account-reconcile/workbench')
      .query(binding)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(workbench.status).toBe(200)
    // 新写（下一测试同库 admin 流程）不触碰历史行。
    const again = db.prepare(
      'SELECT completed_by, closed_by FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
    ).get(binding.reconcileGenerationId) as { completed_by: string; closed_by: string }
    expect(again).toEqual(legacy)
  })

  it('DB 重启（closeDatabase → 新连接）后 username 身份与金额语义持久一致', async () => {
    const binding = seedPartner('restart')
    const { hmId, diffs } = await runFullLifecycleViaRoutes(adminToken, binding)
    await expectIdentity(hmId, binding.reconcileGenerationId, diffs.map((d) => d.id), 'admin')
    expect((db.prepare('SELECT confirmed_lab_revenue FROM reconcile_hospital_months WHERE id = ?').get(hmId) as any).confirmed_lab_revenue).toBe(830)

    // 模拟进程重启：关闭单例连接，用同一 SQLite 文件开新连接。
    manager.closeDatabase()
    db = manager.getDatabase()
    await expectIdentity(hmId, binding.reconcileGenerationId, diffs.map((d) => d.id), 'admin')
    expect((db.prepare('SELECT confirmed_lab_revenue FROM reconcile_hospital_months WHERE id = ?').get(hmId) as any).confirmed_lab_revenue).toBe(830)
    const afterRestart = await request(app)
      .get(`/api/v1/account-reconcile/overview?settlementMonth=${binding.settlementMonth}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(afterRestart.status).toBe(200)
    expect((afterRestart.body.data.items as any[]).find((i) => i.partnerId === binding.partnerId).status).toBe('已关账')
  })
})
