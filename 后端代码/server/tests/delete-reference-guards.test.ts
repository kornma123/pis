/**
 * LOC-025A 五类软删除关联校验（supplier/role/location/user/project）行为测试。
 *
 * 冻结口径（任务合同 K3-LOC-025A-DELETE-GUARDS-V1）：
 * - 历史/审计引用不拦截软删除；活引用（在途单据/有效分配/未决义务）拦截；
 * - 引用发现与软删除写入共处一个 BEGIN IMMEDIATE 事务，带锁内重读；稳定拒绝 = HTTP 409 ENTITY_IN_USE；
 * - 拒绝审计走生产 auditWrite 中间件（outcome='denied'，request_data 仅 {status,code} 元数据，绝无请求体）；
 * - 未知/畸形状态不等于合法零（按不安全处理、拦截）；精确的合法零事实（无活引用）放行；
 * - actor 只信认证上下文 req.user，不信请求体里的 operator/actor。
 *
 * 测试姿势：
 * - 真实生产 Express 全应用（src/app.ts 默认导出，含 auditWrite）+ node:sqlite 文件库；
 * - 文件库让第二个真实 DatabaseSync 连接（rival）能在「预检之后、拿锁之前」提交活引用
 *   （确定性 committed-race harness，同 reconcile-close-race.test.ts：固定的是调度，不是造假的写入）；
 * - DATABASE_PATH / JWT_SECRET 在任何 src 模块 import 之前覆写（同 p0-harness / reconcile-close-race）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type express from 'express'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'coreone-loc025a-delete-guards-'))
const DB_FILE = join(TMP_DIR, 'delete-guards.db')
process.env.DATABASE_PATH = DB_FILE
process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
  ? process.env.JWT_SECRET
  : 'loc025a-delete-guards-test-secret-0123456789abcdef'

const PROBE_VALUE = 'loc025a-leak-probe'
// suppliers/locations/projects 路由没有 rejectUntrustedAuditActorFields：可夹带伪造 operator，
// 证明 actor 只取认证上下文；roles/users 有该中间件，只放探针字段。
const SPOOF_BODY = { operator: 'spoofed-body-operator', probeNote: PROBE_VALUE }
const PLAIN_BODY = { probeNote: PROBE_VALUE }

let app: express.Express
let db: DatabaseSync
let rival: DatabaseSync
let adminToken: string
let request: typeof import('supertest')['default']
let resetDenialTracker: () => void
let closeDatabaseForTest: () => void

beforeAll(async () => {
  app = (await import('../src/app.js')).default
  const dm = await import('../src/database/DatabaseManager.js')
  db = dm.getDatabase()
  closeDatabaseForTest = dm.closeDatabase
  request = (await import('supertest')).default
  resetDenialTracker = (await import('../src/middleware/audit-log.js')).__resetDenialTrackerForTest
  const login = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })
  if (!login.body?.data?.token) throw new Error('admin login failed: ' + JSON.stringify(login.body))
  adminToken = login.body.data.token
  rival = new DatabaseSync(DB_FILE)
}, 120_000)

// 拒绝审计中间件有每分钟聚合阈值：逐条行只在前 20 次出现。每个用例重置，保证断言拿到逐条 denied 行。
beforeEach(() => resetDenialTracker?.())

afterAll(() => {
  try { rival?.close() } catch { /* already closed */ }
  try { closeDatabaseForTest?.() } catch { /* already closed */ }
  rmSync(TMP_DIR, { recursive: true, force: true })
}, 120_000)

// ── 通用 helper ─────────────────────────────────────────────────────────────

const del = (path: string, body?: object) =>
  request(app).delete(path).set('Authorization', `Bearer ${adminToken}`).send(body ?? {})

const row = (table: string, id: string) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)

function seedSupplier(id: string) {
  db.prepare(`INSERT INTO suppliers (id, code, name, status, is_deleted) VALUES (?, ?, ?, 1, 0)`)
    .run(id, `SUPC-${id}`, `供应商-${id}`)
}

function seedLocation(id: string) {
  db.prepare(`INSERT INTO locations (id, code, name, type, zone, status, is_deleted) VALUES (?, ?, ?, 'shelf', 'DG区', 1, 0)`)
    .run(id, `LOC-${id}`, `库位-${id}`)
}

function seedMaterial(id: string, opts: { locationId?: string | null; isDeleted?: number } = {}) {
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, location_id, status, is_deleted) VALUES (?, ?, ?, '盒', 'CAT-DG', ?, 1, ?)`)
    .run(id, `MAT-${id}`, `物料-${id}`, opts.locationId ?? null, opts.isDeleted ?? 0)
}

function seedRole(id: string, code: string) {
  db.prepare(`INSERT INTO roles (id, code, name, description, permissions, status, is_deleted) VALUES (?, ?, ?, '', ?, 1, 0)`)
    .run(id, code, code, JSON.stringify({ inventory: 'R' }))
}

function seedUser(id: string, username: string, roleCode: string, opts: { isDeleted?: number; status?: number } = {}) {
  db.prepare(`INSERT INTO users (id, username, password, real_name, role, primary_role, status, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, username, 'dg-not-a-login-hash', username, roleCode, roleCode, opts.status ?? 1, opts.isDeleted ?? 0)
  db.prepare(`INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)`)
    .run(`UR-${id}-${roleCode}`, id, roleCode)
}

function seedProject(id: string, opts: { type?: string; manager?: string | null; status?: number; isDeleted?: number } = {}) {
  db.prepare(`INSERT INTO projects (id, code, name, type, manager, status, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `PRJ-${id}`, `项目-${id}`, opts.type ?? 'custom_unmapped', opts.manager ?? null, opts.status ?? 1, opts.isDeleted ?? 0)
}

function seedPurchaseOrder(id: string, supplierId: string, status: string | null, opts: { isDeleted?: number } = {}) {
  db.prepare(`INSERT INTO purchase_orders (id, order_no, material_id, supplier_id, ordered_qty, unit, status, is_deleted) VALUES (?, ?, ?, ?, 5, '盒', ?, ?)`)
    .run(id, `PO-NO-${id}`, `MAT-${id}`, supplierId, status, opts.isDeleted ?? 0)
}

function seedInbound(id: string, supplierId: string, status: string | null, opts: { isDeleted?: number } = {}) {
  seedLocation(`LOC-${id}`)
  db.prepare(`INSERT INTO inbound_records (id, inbound_no, type, material_id, quantity, unit, location_id, operator, status, is_deleted, supplier_id) VALUES (?, ?, 'purchase', ?, 5, '盒', ?, 'admin', ?, ?, ?)`)
    .run(id, `IB-NO-${id}`, `MAT-${id}`, `LOC-${id}`, status, opts.isDeleted ?? 0, supplierId)
}

function seedSupplierReturn(id: string, supplierId: string, status: string | null, opts: { isDeleted?: number } = {}) {
  db.prepare(`INSERT INTO supplier_returns (id, return_no, material_id, quantity, reason, operator, status, supplier_id, is_deleted) VALUES (?, ?, ?, 1, '质量问题', 'admin', ?, ?, ?)`)
    .run(id, `SR-NO-${id}`, `MAT-${id}`, status, supplierId, opts.isDeleted ?? 0)
}

function seedOutbound(id: string, projectId: string | null, status: string | null, opts: { operator?: string; isDeleted?: number } = {}) {
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, operator, status, project_id, is_deleted) VALUES (?, ?, 'use', ?, ?, ?, ?)`)
    .run(id, `OB-NO-${id}`, opts.operator ?? 'admin', status, projectId, opts.isDeleted ?? 0)
}

function seedLisCase(id: string, projectId: string) {
  db.prepare(`INSERT INTO lis_cases (id, case_no, project_id, status) VALUES (?, ?, ?, 'normal')`)
    .run(id, `CASE-${id}`, projectId)
}

function seedCatalogMapping(id: string, projectCode: string) {
  db.prepare(`INSERT INTO code_mappings (id, system, alias_code, alias_norm, catalog_code, source) VALUES (?, 'project_code', ?, ?, 'PC-IHC-STD', 'delete-guard-test')`)
    .run(id, projectCode, projectCode.toLowerCase())
}

function seedCostException(id: string, projectId: string, status: string | null) {
  db.prepare(`INSERT INTO cost_exceptions (id, exception_no, source_module, source_type, exception_type, project_id, status, message) VALUES (?, ?, 'outbound', 'cost', 'dg_exception', ?, ?, ?)`)
    .run(id, `EX-NO-${id}`, projectId, status, `dg-exception-${id}`)
}

/** 拒绝写审计：仅 {status,code} 元数据、actor 来自认证上下文、绝无请求体泄漏 */
function expectSanitizedDenialAudit(module: string, marker: string) {
  const logs = db.prepare(
    `SELECT * FROM operation_logs WHERE outcome = 'denied' AND operation = ? ORDER BY rowid DESC`,
  ).all(`DENIED DELETE ${module}`) as Array<{ description: string; request_data: string }>
  const log = logs.find((entry) => typeof entry.description === 'string' && entry.description.includes(marker))
  expect(log, `missing denial audit row for ${module} ${marker}`).toBeTruthy()
  expect(log.request_data).toBe('{"status":409,"code":"ENTITY_IN_USE"}')
  expect(log.request_data).not.toContain(PROBE_VALUE)
  expect(log.description).not.toContain(PROBE_VALUE)
  expect(log.description).not.toContain('spoofed-body-operator')
  expect(log.username).toBe('admin')
}

/** 确定性 committed-race：rival（真实第二连接、自提交）在首个 BEGIN IMMEDIATE 之前提交活引用 */
function installCommittedRace(write: () => void) {
  const original = db.exec.bind(db)
  let fired = false
  const spy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !fired) {
      fired = true
      write()
    }
    return original(sql)
  })
  return {
    fired: () => fired,
    restore: () => spy.mockRestore(),
  }
}

/** 引用拒绝也必须先取得写锁；不能以锁前 advisory 查询提前返回。 */
function installBeginTrace() {
  const original = db.exec.bind(db)
  let beginCount = 0
  const spy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE') beginCount += 1
    return original(sql)
  })
  return {
    beginCount: () => beginCount,
    restore: () => spy.mockRestore(),
  }
}

/** 故障回滚：对软删除 UPDATE 强制失败 → 500 脱敏 + 行不变 + 可重试 */
async function expectFaultRollback(opts: {
  table: string
  id: string
  path: string
  triggerName: string
}) {
  const before = row(opts.table, opts.id)
  db.exec(`
    CREATE TRIGGER ${opts.triggerName}
    AFTER UPDATE OF is_deleted ON ${opts.table}
    WHEN OLD.id = '${opts.id}'
    BEGIN
      SELECT RAISE(FAIL, 'forced delete failure');
    END
  `)
  try {
    const res = await del(opts.path, PLAIN_BODY)
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } })
    expect(res.body.error.message).not.toContain('forced delete failure')
    expect(row(opts.table, opts.id)).toEqual(before)

    db.exec(`DROP TRIGGER ${opts.triggerName}`)
    const retry = await del(opts.path, PLAIN_BODY)
    expect(retry.status).toBe(200)
    expect(row(opts.table, opts.id)).toMatchObject({ id: opts.id, is_deleted: 1 })
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS ${opts.triggerName}`)
  }
}

/**
 * 回滚命令本身故障时，路由必须丢弃 singleton 连接；关闭连接由 SQLite 回滚未提交事务。
 * 下一次 getDatabase() 必须得到新连接，业务行保持原值且请求可安全重试。
 */
async function expectRollbackCommandFault(opts: {
  table: string
  id: string
  path: string
  triggerName: string
}) {
  const before = row(opts.table, opts.id)
  db.exec(`
    CREATE TRIGGER ${opts.triggerName}
    AFTER UPDATE OF is_deleted ON ${opts.table}
    WHEN OLD.id = '${opts.id}'
    BEGIN
      SELECT RAISE(FAIL, 'forced delete failure before rollback fault');
    END
  `)
  const originalDb = db
  const originalExec = originalDb.exec.bind(originalDb)
  let rollbackFaultHit = false
  const spy = vi.spyOn(originalDb, 'exec').mockImplementation((sql: string) => {
    if (sql === 'ROLLBACK' && !rollbackFaultHit) {
      rollbackFaultHit = true
      throw new Error('forced rollback command failure')
    }
    return originalExec(sql)
  })

  let currentDb: DatabaseSync
  try {
    const res = await del(opts.path, PLAIN_BODY)
    expect(rollbackFaultHit).toBe(true)
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } })
    expect(res.body.error.message).not.toContain('forced rollback command failure')

    spy.mockRestore()
    const dm = await import('../src/database/DatabaseManager.js')
    currentDb = dm.getDatabase()
    expect(currentDb === originalDb).toBe(false)
    db = currentDb
    expect(row(opts.table, opts.id)).toEqual(before)

    db.exec(`DROP TRIGGER ${opts.triggerName}`)
    const retry = await del(opts.path, PLAIN_BODY)
    expect(retry.status).toBe(200)
    expect(row(opts.table, opts.id)).toMatchObject({ id: opts.id, is_deleted: 1 })
  } finally {
    spy.mockRestore()
    if (!currentDb || currentDb === originalDb) {
      try { originalExec('ROLLBACK') } catch { /* test cleanup after expected RED */ }
    }
    const dm = await import('../src/database/DatabaseManager.js')
    db = dm.getDatabase()
    db.exec(`DROP TRIGGER IF EXISTS ${opts.triggerName}`)
  }
}

// ── supplier ────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/suppliers/:id — 供应商活引用拦截', () => {
  it('在途采购订单（pending PO）→ 409 ENTITY_IN_USE，零业务写 + 拒绝审计不含请求体', async () => {
    const id = 'SUP-DG-PO-LIVE'
    seedSupplier(id)
    seedPurchaseOrder('PO-DG-LIVE', id, 'pending')
    const before = { supplier: row('suppliers', id), po: row('purchase_orders', 'PO-DG-LIVE') }

    const trace = installBeginTrace()
    let res
    try {
      res = await del(`/api/v1/suppliers/${id}`, SPOOF_BODY)
    } finally {
      trace.restore()
    }

    expect(trace.beginCount()).toBe(1)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('suppliers', id)).toEqual(before.supplier)
    expect(row('purchase_orders', 'PO-DG-LIVE')).toEqual(before.po)
    expectSanitizedDenialAudit('suppliers', id)
  })

  it('在途入库记录（pending inbound）→ 409 ENTITY_IN_USE', async () => {
    const id = 'SUP-DG-INB-LIVE'
    seedSupplier(id)
    seedInbound('INB-DG-LIVE', id, 'pending')
    const before = { supplier: row('suppliers', id), inbound: row('inbound_records', 'INB-DG-LIVE') }

    const res = await del(`/api/v1/suppliers/${id}`, SPOOF_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('suppliers', id)).toEqual(before.supplier)
    expect(row('inbound_records', 'INB-DG-LIVE')).toEqual(before.inbound)
    expectSanitizedDenialAudit('suppliers', id)
  })

  it('未结退货义务（pending supplier_return）→ 409 ENTITY_IN_USE', async () => {
    const id = 'SUP-DG-RET-LIVE'
    seedSupplier(id)
    seedSupplierReturn('RET-DG-LIVE', id, 'pending')
    const before = { supplier: row('suppliers', id), ret: row('supplier_returns', 'RET-DG-LIVE') }

    const res = await del(`/api/v1/suppliers/${id}`, SPOOF_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('suppliers', id)).toEqual(before.supplier)
    expect(row('supplier_returns', 'RET-DG-LIVE')).toEqual(before.ret)
    expectSanitizedDenialAudit('suppliers', id)
  })

  it('未知/畸形状态不是合法零：未知状态采购单 → 409 ENTITY_IN_USE', async () => {
    const id = 'SUP-DG-PO-UNKNOWN'
    seedSupplier(id)
    seedPurchaseOrder('PO-DG-UNKNOWN', id, 'unexpected_future_state')

    const res = await del(`/api/v1/suppliers/${id}`, SPOOF_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('suppliers', id)).toMatchObject({ id, is_deleted: 0 })
  })

  it('仅历史引用（completed PO / completed-or-cancelled inbound / refunded return / 关联物料 / 软删入库）→ 删除成功且引用行不变', async () => {
    const id = 'SUP-DG-HIST'
    seedSupplier(id)
    seedMaterial('MAT-DG-HIST')
    db.prepare('UPDATE materials SET supplier_id = ? WHERE id = ?').run(id, 'MAT-DG-HIST')
    seedPurchaseOrder('PO-DG-HIST', id, 'completed')
    seedInbound('INB-DG-HIST-DONE', id, 'completed')
    seedInbound('INB-DG-HIST-CXL', id, 'cancelled')
    seedInbound('INB-DG-HIST-DEL', id, 'completed', { isDeleted: 1 })
    seedSupplierReturn('RET-DG-HIST', id, 'refunded')
    const beforeRefs = {
      po: row('purchase_orders', 'PO-DG-HIST'),
      inboundDone: row('inbound_records', 'INB-DG-HIST-DONE'),
      inboundCxl: row('inbound_records', 'INB-DG-HIST-CXL'),
      inboundDel: row('inbound_records', 'INB-DG-HIST-DEL'),
      ret: row('supplier_returns', 'RET-DG-HIST'),
      material: row('materials', 'MAT-DG-HIST'),
    }

    const res = await del(`/api/v1/suppliers/${id}`, SPOOF_BODY)

    expect(res.status).toBe(200)
    expect(row('suppliers', id)).toMatchObject({ id, is_deleted: 1 })
    expect(row('purchase_orders', 'PO-DG-HIST')).toEqual(beforeRefs.po)
    expect(row('inbound_records', 'INB-DG-HIST-DONE')).toEqual(beforeRefs.inboundDone)
    expect(row('inbound_records', 'INB-DG-HIST-CXL')).toEqual(beforeRefs.inboundCxl)
    expect(row('inbound_records', 'INB-DG-HIST-DEL')).toEqual(beforeRefs.inboundDel)
    expect(row('supplier_returns', 'RET-DG-HIST')).toEqual(beforeRefs.ret)
    expect(row('materials', 'MAT-DG-HIST')).toEqual(beforeRefs.material)
  })

  it('committed-race：锁前窗口被第二连接提交在途采购订单 → 锁内重读拦截，零部分写', async () => {
    const id = 'SUP-DG-RACE'
    seedSupplier(id)
    const race = installCommittedRace(() => {
      rival.prepare(`INSERT INTO purchase_orders (id, order_no, material_id, supplier_id, ordered_qty, unit, status, is_deleted) VALUES ('PO-DG-RACE', 'PO-NO-DG-RACE', 'MAT-DG-RACE', ?, 5, '盒', 'pending', 0)`).run(id)
    })

    let res
    try {
      res = await del(`/api/v1/suppliers/${id}`, SPOOF_BODY)
    } finally {
      race.restore()
    }

    expect(race.fired()).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('suppliers', id)).toMatchObject({ id, is_deleted: 0 })
    expect(row('purchase_orders', 'PO-DG-RACE')).toMatchObject({ id: 'PO-DG-RACE', is_deleted: 0 })
  })

  it('故障回滚：软删除写入被强制失败 → 500 脱敏、行不变、可重试', async () => {
    const id = 'SUP-DG-FAULT'
    seedSupplier(id)
    await expectFaultRollback({ table: 'suppliers', id, path: `/api/v1/suppliers/${id}`, triggerName: 'dg_supplier_forced_error' })
  })

  it('ROLLBACK 命令故障：关闭并替换连接，未提交删除回滚且可重试', async () => {
    const id = 'SUP-DG-ROLLBACK-FAULT'
    seedSupplier(id)
    await expectRollbackCommandFault({ table: 'suppliers', id, path: `/api/v1/suppliers/${id}`, triggerName: 'dg_supplier_rollback_fault' })
  })

  it('未知 id → 404 NOT_FOUND；重复删除同一 id → 第二次 404', async () => {
    const id = 'SUP-DG-404'
    seedSupplier(id)

    const missing = await del('/api/v1/suppliers/SUP-DG-UNKNOWN', PLAIN_BODY)
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })

    expect((await del(`/api/v1/suppliers/${id}`, PLAIN_BODY)).status).toBe(200)
    const again = await del(`/api/v1/suppliers/${id}`, PLAIN_BODY)
    expect(again.status).toBe(404)
    expect(again.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
  })
})

// ── role ────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/roles/:id — 角色活跃用户分配拦截', () => {
  it('用户经 user_roles 持有该角色 → 409 ENTITY_IN_USE，零业务写 + 拒绝审计不含请求体', async () => {
    const id = 'ROLE-DG-LIVE'
    seedRole(id, 'dg_role_live')
    seedUser('USER-DG-ROLE-LIVE', 'dg_role_live_user', 'dg_role_live')
    const before = { role: row('roles', id), user: row('users', 'USER-DG-ROLE-LIVE') }

    const res = await del(`/api/v1/roles/${id}`, PLAIN_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('roles', id)).toEqual(before.role)
    expect(row('users', 'USER-DG-ROLE-LIVE')).toEqual(before.user)
    expectSanitizedDenialAudit('roles', id)
  })

  it('用户经 users.role 兜底持有该角色（无 user_roles 行）→ 409 ENTITY_IN_USE', async () => {
    const id = 'ROLE-DG-FALLBACK'
    seedRole(id, 'dg_role_fallback')
    seedUser('USER-DG-ROLE-FB', 'dg_role_fallback_user', 'dg_role_fallback')
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run('USER-DG-ROLE-FB')

    const res = await del(`/api/v1/roles/${id}`, PLAIN_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('roles', id)).toMatchObject({ id, is_deleted: 0 })
  })

  it('仅软删用户引用 → 删除成功，用户行不变', async () => {
    const id = 'ROLE-DG-HIST'
    seedRole(id, 'dg_role_hist')
    seedUser('USER-DG-ROLE-HIST', 'dg_role_hist_user', 'dg_role_hist', { isDeleted: 1 })
    const beforeUser = row('users', 'USER-DG-ROLE-HIST')

    const res = await del(`/api/v1/roles/${id}`, PLAIN_BODY)

    expect(res.status).toBe(200)
    expect(row('roles', id)).toMatchObject({ id, is_deleted: 1 })
    expect(row('users', 'USER-DG-ROLE-HIST')).toEqual(beforeUser)
  })

  it('仅停用用户持有角色 → 删除成功，停用用户行不变', async () => {
    const id = 'ROLE-DG-INACTIVE'
    seedRole(id, 'dg_role_inactive')
    seedUser('USER-DG-ROLE-INACTIVE', 'dg_role_inactive_user', 'dg_role_inactive', { status: 0 })
    const beforeUser = row('users', 'USER-DG-ROLE-INACTIVE')

    const res = await del(`/api/v1/roles/${id}`, PLAIN_BODY)

    expect(res.status).toBe(200)
    expect(row('roles', id)).toMatchObject({ id, is_deleted: 1 })
    expect(row('users', 'USER-DG-ROLE-INACTIVE')).toEqual(beforeUser)
  })

  it('committed-race：锁前窗口被第二连接提交用户分配 → 锁内重读拦截，零部分写', async () => {
    const id = 'ROLE-DG-RACE'
    seedRole(id, 'dg_role_race')
    seedUser('USER-DG-ROLE-RACE', 'dg_role_race_user', 'dg_role_race')
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run('USER-DG-ROLE-RACE')
    db.prepare(`UPDATE users SET role = 'technician', primary_role = 'technician' WHERE id = ?`).run('USER-DG-ROLE-RACE')
    const race = installCommittedRace(() => {
      rival.prepare(`INSERT INTO user_roles (id, user_id, role_code) VALUES ('UR-DG-RACE', 'USER-DG-ROLE-RACE', 'dg_role_race')`).run()
    })

    let res
    try {
      res = await del(`/api/v1/roles/${id}`, PLAIN_BODY)
    } finally {
      race.restore()
    }

    expect(race.fired()).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('roles', id)).toMatchObject({ id, is_deleted: 0 })
    expect(db.prepare('SELECT * FROM user_roles WHERE id = ?').get('UR-DG-RACE')).toBeTruthy()
  })

  it('故障回滚：软删除写入被强制失败 → 500 脱敏、行不变、可重试', async () => {
    const id = 'ROLE-DG-FAULT'
    seedRole(id, 'dg_role_fault')
    await expectFaultRollback({ table: 'roles', id, path: `/api/v1/roles/${id}`, triggerName: 'dg_role_forced_error' })
  })

  it('未知 id → 404 NOT_FOUND；重复删除同一 id → 第二次 404', async () => {
    const id = 'ROLE-DG-404'
    seedRole(id, 'dg_role_404')

    const missing = await del('/api/v1/roles/ROLE-DG-UNKNOWN', PLAIN_BODY)
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })

    expect((await del(`/api/v1/roles/${id}`, PLAIN_BODY)).status).toBe(200)
    const again = await del(`/api/v1/roles/${id}`, PLAIN_BODY)
    expect(again.status).toBe(404)
    expect(again.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
  })
})

// ── location ────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/locations/:id — 库位在途运营引用拦截（ENTITY_IN_USE）', () => {
  it('库位仍有生效物料主数据指派 → 409 ENTITY_IN_USE，零业务写 + 拒绝审计不含请求体', async () => {
    const id = 'LOC-DG-MAT-LIVE'
    seedLocation(id)
    seedMaterial('MAT-DG-LOC-LIVE', { locationId: id })
    const before = { location: row('locations', id), material: row('materials', 'MAT-DG-LOC-LIVE') }

    const trace = installBeginTrace()
    let res
    try {
      res = await del(`/api/v1/locations/${id}`, SPOOF_BODY)
    } finally {
      trace.restore()
    }

    expect(trace.beginCount()).toBe(1)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('locations', id)).toEqual(before.location)
    expect(row('materials', 'MAT-DG-LOC-LIVE')).toEqual(before.material)
    expectSanitizedDenialAudit('locations', id)
  })

  it('库位仍有生效设备指派 → 409 ENTITY_IN_USE', async () => {
    const id = 'LOC-DG-EQ-LIVE'
    seedLocation(id)
    db.prepare(`INSERT INTO equipment (id, code, name, location_id, status, is_deleted) VALUES (?, ?, ?, ?, 1, 0)`)
      .run('EQ-DG-LOC-LIVE', 'EQ-CODE-DG-LIVE', '设备-DG-LIVE', id)
    const before = { location: row('locations', id), equipment: row('equipment', 'EQ-DG-LOC-LIVE') }

    const res = await del(`/api/v1/locations/${id}`, SPOOF_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('locations', id)).toEqual(before.location)
    expect(row('equipment', 'EQ-DG-LOC-LIVE')).toEqual(before.equipment)
    expectSanitizedDenialAudit('locations', id)
  })

  it('既有库存/批次守卫保持 CONFLICT 码（既有路由合同不变）', async () => {
    const id = 'LOC-DG-LEGACY'
    seedLocation(id)
    seedMaterial('MAT-DG-LEGACY')
    db.prepare(`INSERT INTO inventory (id, material_id, stock, locked_stock, location_id) VALUES (?, ?, 3, 0, ?)`)
      .run('INV-DG-LEGACY', 'MAT-DG-LEGACY', id)

    const res = await del(`/api/v1/locations/${id}`, SPOOF_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'CONFLICT' } })
    expect(row('locations', id)).toMatchObject({ id, is_deleted: 0 })
  })

  it('仅历史引用（软删物料 / 软删设备 / 已完成入库+用尽批次）→ 删除成功', async () => {
    const id = 'LOC-DG-HIST'
    seedLocation(id)
    seedMaterial('MAT-DG-HIST-LOC', { locationId: id, isDeleted: 1 })
    db.prepare(`INSERT INTO equipment (id, code, name, location_id, status, is_deleted) VALUES (?, ?, ?, ?, 1, 1)`)
      .run('EQ-DG-HIST-LOC', 'EQ-CODE-DG-HIST', '设备-DG-HIST', id)
    db.prepare(`INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_no, quantity, unit, location_id, operator, status, is_deleted) VALUES (?, 'IB-NO-DG-HIST', 'purchase', 'MAT-DG-HIST-LOC', 'B-DG-HIST', 5, '盒', ?, 'admin', 'completed', 0)`)
      .run('INB-DG-HIST', id)
    db.prepare(`INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status) VALUES (?, 'MAT-DG-HIST-LOC', 'B-DG-HIST', 5, 0, 'INB-DG-HIST', 0)`)
      .run('BAT-DG-HIST')

    const res = await del(`/api/v1/locations/${id}`, SPOOF_BODY)

    expect(res.status).toBe(200)
    expect(row('locations', id)).toMatchObject({ id, is_deleted: 1 })
    expect(row('materials', 'MAT-DG-HIST-LOC')).toMatchObject({ id: 'MAT-DG-HIST-LOC', is_deleted: 1 })
    expect(row('equipment', 'EQ-DG-HIST-LOC')).toMatchObject({ id: 'EQ-DG-HIST-LOC', is_deleted: 1 })
  })

  it('committed-race：锁前窗口被第二连接提交物料指派 → 锁内重读拦截，零部分写', async () => {
    const id = 'LOC-DG-RACE'
    seedLocation(id)
    const race = installCommittedRace(() => {
      rival.prepare(`INSERT INTO materials (id, code, name, unit, category_id, location_id, status, is_deleted) VALUES ('MAT-DG-RACE', 'MAT-CODE-DG-RACE', '物料-DG-RACE', '盒', 'CAT-DG', ?, 1, 0)`).run(id)
    })

    let res
    try {
      res = await del(`/api/v1/locations/${id}`, SPOOF_BODY)
    } finally {
      race.restore()
    }

    expect(race.fired()).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('locations', id)).toMatchObject({ id, is_deleted: 0 })
    expect(row('materials', 'MAT-DG-RACE')).toMatchObject({ id: 'MAT-DG-RACE', is_deleted: 0 })
  })

  it('未知 id → 404 NOT_FOUND；重复删除同一 id → 第二次 404', async () => {
    const id = 'LOC-DG-404'
    seedLocation(id)

    const missing = await del('/api/v1/locations/LOC-DG-UNKNOWN', PLAIN_BODY)
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })

    expect((await del(`/api/v1/locations/${id}`, PLAIN_BODY)).status).toBe(200)
    const again = await del(`/api/v1/locations/${id}`, PLAIN_BODY)
    expect(again.status).toBe(404)
    expect(again.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
  })

  it('ROLLBACK 命令故障：关闭并替换连接，未提交删除回滚且可重试', async () => {
    const id = 'LOC-DG-ROLLBACK-FAULT'
    seedLocation(id)
    await expectRollbackCommandFault({ table: 'locations', id, path: `/api/v1/locations/${id}`, triggerName: 'dg_location_rollback_fault' })
  })
})

// ── user ────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/users/:id — 用户活持有/在途分配拦截', () => {
  it('用户是生效项目负责人（projects.manager=username, status=1）→ 409 ENTITY_IN_USE，零业务写 + 拒绝审计不含请求体', async () => {
    const id = 'USER-DG-MGR-LIVE'
    seedUser(id, 'dg_manager_live', 'technician')
    seedProject('PRJ-DG-MGR-LIVE', { manager: 'dg_manager_live' })
    const before = { user: row('users', id), project: row('projects', 'PRJ-DG-MGR-LIVE') }

    const res = await del(`/api/v1/users/${id}`, PLAIN_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('users', id)).toEqual(before.user)
    expect(row('projects', 'PRJ-DG-MGR-LIVE')).toEqual(before.project)
    expectSanitizedDenialAudit('users', id)
  })

  it('用户持有在途出库单（operator=username, status=pending）→ 409 ENTITY_IN_USE', async () => {
    const id = 'USER-DG-OB-LIVE'
    seedUser(id, 'dg_outbound_live', 'technician')
    seedOutbound('OB-DG-USER-LIVE', null, 'pending', { operator: 'dg_outbound_live' })

    const res = await del(`/api/v1/users/${id}`, PLAIN_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('users', id)).toMatchObject({ id, is_deleted: 0 })
    expect(row('outbound_records', 'OB-DG-USER-LIVE')).toMatchObject({ id: 'OB-DG-USER-LIVE', is_deleted: 0 })
    expectSanitizedDenialAudit('users', id)
  })

  it('仅历史引用（停用项目负责人 / 已完成出库经办 / 操作日志）→ 删除成功', async () => {
    const id = 'USER-DG-HIST'
    seedUser(id, 'dg_hist_user', 'technician')
    seedProject('PRJ-DG-HIST-INACTIVE', { manager: 'dg_hist_user', status: 0 })
    seedProject('PRJ-DG-HIST-DELETED', { manager: 'dg_hist_user', isDeleted: 1 })
    seedOutbound('OB-DG-HIST', null, 'completed', { operator: 'dg_hist_user' })
    db.prepare(`INSERT INTO operation_logs (id, user_id, username, operation, description) VALUES (?, ?, ?, 'DELETE test', '历史审计引用')`)
      .run('LOG-DG-HIST', id, 'dg_hist_user')

    const res = await del(`/api/v1/users/${id}`, PLAIN_BODY)

    expect(res.status).toBe(200)
    expect(row('users', id)).toMatchObject({ id, is_deleted: 1 })
    expect(row('projects', 'PRJ-DG-HIST-INACTIVE')).toMatchObject({ manager: 'dg_hist_user', status: 0 })
    expect(row('outbound_records', 'OB-DG-HIST')).toMatchObject({ operator: 'dg_hist_user', status: 'completed' })
    expect(row('operation_logs', 'LOG-DG-HIST')).toMatchObject({ user_id: id })
  })

  it('committed-race：锁前窗口被第二连接提交生效项目负责关系 → 锁内重读拦截，零部分写', async () => {
    const id = 'USER-DG-RACE'
    seedUser(id, 'dg_race_user', 'technician')
    const race = installCommittedRace(() => {
      rival.prepare(`INSERT INTO projects (id, code, name, type, manager, status, is_deleted) VALUES ('PRJ-DG-RACE', 'PRJ-CODE-DG-RACE', '项目-DG-RACE', 'custom_unmapped', 'dg_race_user', 1, 0)`).run()
    })

    let res
    try {
      res = await del(`/api/v1/users/${id}`, PLAIN_BODY)
    } finally {
      race.restore()
    }

    expect(race.fired()).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('users', id)).toMatchObject({ id, is_deleted: 0 })
    expect(row('projects', 'PRJ-DG-RACE')).toMatchObject({ id: 'PRJ-DG-RACE', is_deleted: 0 })
  })

  it('故障回滚：软删除写入被强制失败 → 500 脱敏、行不变、可重试', async () => {
    const id = 'USER-DG-FAULT'
    seedUser(id, 'dg_fault_user', 'technician')
    await expectFaultRollback({ table: 'users', id, path: `/api/v1/users/${id}`, triggerName: 'dg_user_forced_error' })
  })

  it('未知 id → 404 NOT_FOUND；重复删除同一 id → 第二次 404', async () => {
    const id = 'USER-DG-404'
    seedUser(id, 'dg_404_user', 'technician')

    const missing = await del('/api/v1/users/USER-DG-UNKNOWN', PLAIN_BODY)
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })

    expect((await del(`/api/v1/users/${id}`, PLAIN_BODY)).status).toBe(200)
    const again = await del(`/api/v1/users/${id}`, PLAIN_BODY)
    expect(again.status).toBe(404)
    expect(again.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
  })
})

// ── project ─────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/projects/:id — 项目活跃引用拦截', () => {
  it('仅有 project_code 目录映射 → 删除成功且映射历史行不变', async () => {
    const id = 'PRJ-DG-CAT-HIST'
    seedProject(id)
    seedCatalogMapping('CM-DG-HIST', `PRJ-${id}`)
    const beforeMapping = row('code_mappings', 'CM-DG-HIST')

    const trace = installBeginTrace()
    let res
    try {
      res = await del(`/api/v1/projects/${id}`, SPOOF_BODY)
    } finally {
      trace.restore()
    }

    expect(trace.beginCount()).toBe(1)
    expect(res.status).toBe(200)
    expect(row('projects', id)).toMatchObject({ id, is_deleted: 1 })
    expect(row('code_mappings', 'CM-DG-HIST')).toEqual(beforeMapping)
  })

  it('仅有历史 LIS 病例 → 删除成功且病例历史行不变', async () => {
    const id = 'PRJ-DG-CASE-HIST'
    seedProject(id)
    seedLisCase('LC-DG-HIST', id)
    const beforeLisCase = row('lis_cases', 'LC-DG-HIST')

    const res = await del(`/api/v1/projects/${id}`, SPOOF_BODY)

    expect(res.status).toBe(200)
    expect(row('projects', id)).toMatchObject({ id, is_deleted: 1 })
    expect(row('lis_cases', 'LC-DG-HIST')).toEqual(beforeLisCase)
  })

  it('项目有在途出库单（pending outbound）→ 409 ENTITY_IN_USE', async () => {
    const id = 'PRJ-DG-OB-LIVE'
    seedProject(id)
    seedOutbound('OB-DG-PRJ-LIVE', id, 'pending')

    const res = await del(`/api/v1/projects/${id}`, SPOOF_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('projects', id)).toMatchObject({ id, is_deleted: 0 })
    expect(row('outbound_records', 'OB-DG-PRJ-LIVE')).toMatchObject({ id: 'OB-DG-PRJ-LIVE', is_deleted: 0 })
    expectSanitizedDenialAudit('projects', id)
  })

  it('项目有未决成本异常（open cost_exception）→ 409 ENTITY_IN_USE', async () => {
    const id = 'PRJ-DG-EX-LIVE'
    seedProject(id)
    seedCostException('EX-DG-LIVE', id, 'open')

    const res = await del(`/api/v1/projects/${id}`, SPOOF_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('projects', id)).toMatchObject({ id, is_deleted: 0 })
    expect(row('cost_exceptions', 'EX-DG-LIVE')).toMatchObject({ id: 'EX-DG-LIVE', status: 'open' })
    expectSanitizedDenialAudit('projects', id)
  })

  it('未知/畸形状态不是合法零：未知出库与成本异常状态 → 409 ENTITY_IN_USE', async () => {
    const id = 'PRJ-DG-STATE-UNKNOWN'
    seedProject(id)
    seedOutbound('OB-DG-PRJ-UNKNOWN', id, 'unexpected_future_state')
    seedCostException('EX-DG-UNKNOWN', id, 'unexpected_future_state')

    const res = await del(`/api/v1/projects/${id}`, SPOOF_BODY)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('projects', id)).toMatchObject({ id, is_deleted: 0 })
  })

  it('仅历史引用（已完成出库 / 已解决成本异常 / 软删出库）→ 删除成功且引用行不变', async () => {
    const id = 'PRJ-DG-HIST'
    seedProject(id)
    seedOutbound('OB-DG-PRJ-HIST', id, 'completed')
    seedOutbound('OB-DG-PRJ-HIST-CXL', id, 'cancelled')
    seedOutbound('OB-DG-PRJ-HIST-DEL', id, 'pending', { isDeleted: 1 })
    seedCostException('EX-DG-HIST', id, 'resolved')
    seedCostException('EX-DG-HIST-CLOSED', id, 'closed')
    seedCostException('EX-DG-HIST-IGNORED', id, 'ignored')
    const beforeRefs = {
      obDone: row('outbound_records', 'OB-DG-PRJ-HIST'),
      obCxl: row('outbound_records', 'OB-DG-PRJ-HIST-CXL'),
      obDel: row('outbound_records', 'OB-DG-PRJ-HIST-DEL'),
      exception: row('cost_exceptions', 'EX-DG-HIST'),
      exceptionClosed: row('cost_exceptions', 'EX-DG-HIST-CLOSED'),
      exceptionIgnored: row('cost_exceptions', 'EX-DG-HIST-IGNORED'),
    }

    const res = await del(`/api/v1/projects/${id}`, SPOOF_BODY)

    expect(res.status).toBe(200)
    expect(row('projects', id)).toMatchObject({ id, is_deleted: 1 })
    expect(row('outbound_records', 'OB-DG-PRJ-HIST')).toEqual(beforeRefs.obDone)
    expect(row('outbound_records', 'OB-DG-PRJ-HIST-CXL')).toEqual(beforeRefs.obCxl)
    expect(row('outbound_records', 'OB-DG-PRJ-HIST-DEL')).toEqual(beforeRefs.obDel)
    expect(row('cost_exceptions', 'EX-DG-HIST')).toEqual(beforeRefs.exception)
    expect(row('cost_exceptions', 'EX-DG-HIST-CLOSED')).toEqual(beforeRefs.exceptionClosed)
    expect(row('cost_exceptions', 'EX-DG-HIST-IGNORED')).toEqual(beforeRefs.exceptionIgnored)
  })

  it('committed-race：锁前窗口被第二连接提交在途出库 → 锁内重读拦截，零部分写', async () => {
    const id = 'PRJ-DG-CRACE'
    seedProject(id)
    const race = installCommittedRace(() => {
      rival.prepare(`INSERT INTO outbound_records (id, outbound_no, type, operator, status, project_id, is_deleted) VALUES ('OB-DG-PRJ-RACE', 'OB-NO-DG-PRJ-RACE', 'use', 'admin', 'pending', ?, 0)`).run(id)
    })

    let res
    try {
      res = await del(`/api/v1/projects/${id}`, SPOOF_BODY)
    } finally {
      race.restore()
    }

    expect(race.fired()).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, error: { code: 'ENTITY_IN_USE' } })
    expect(row('projects', id)).toMatchObject({ id, is_deleted: 0 })
    expect(row('outbound_records', 'OB-DG-PRJ-RACE')).toMatchObject({ id: 'OB-DG-PRJ-RACE' })
  })

  it('故障回滚：软删除写入被强制失败 → 500 脱敏、行不变、可重试', async () => {
    const id = 'PRJ-DG-FAULT'
    seedProject(id)
    await expectFaultRollback({ table: 'projects', id, path: `/api/v1/projects/${id}`, triggerName: 'dg_project_forced_error' })
  })

  it('ROLLBACK 命令故障：关闭并替换连接，未提交删除回滚且可重试', async () => {
    const id = 'PRJ-DG-ROLLBACK-FAULT'
    seedProject(id)
    await expectRollbackCommandFault({ table: 'projects', id, path: `/api/v1/projects/${id}`, triggerName: 'dg_project_rollback_fault' })
  })

  it('未知 id → 404 NOT_FOUND；重复删除同一 id → 第二次 404', async () => {
    const id = 'PRJ-DG-404'
    seedProject(id)

    const missing = await del('/api/v1/projects/PRJ-DG-UNKNOWN', PLAIN_BODY)
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })

    expect((await del(`/api/v1/projects/${id}`, PLAIN_BODY)).status).toBe(200)
    const again = await del(`/api/v1/projects/${id}`, PLAIN_BODY)
    expect(again.status).toBe(404)
    expect(again.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
  })
})
