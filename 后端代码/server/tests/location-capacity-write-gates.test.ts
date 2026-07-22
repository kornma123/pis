/**
 * LOC-029 v2 库位容量写门（fail-closed）行为测试。
 *
 * 冻结口径（任务合同 K3-LOC-029-LOCATION-CAPACITY-V2）：
 * - 所有会增加、迁入或恢复库位库存占用的活跃写路径，以及库位容量修改路径，
 *   必须在 BEGIN IMMEDIATE 后按锁内事实执行 fail-closed 容量门；
 * - used = 同事务 SUM(inventory.stock WHERE location_id=?)，绝不读 locations.used；
 *   每个库存事实与聚合都必须有限、非负、安全；未知不等于零（corrupt → fail closed）；
 * - capacity=0 是合法零容量；999999 是有限的数值硬上限，不是隐式无限哨兵；
 * - projected > capacity → 稳定 409 LOCATION_CAPACITY_EXCEEDED，且业务行/批次/库存/
 *   幂等键/库存流水零部分态；精确等于容量放行；容量调低到低于当前占用 → 409；
 * - 目标库位须 active 且未删除（unknown/inactive/deleted → fail closed）；
 * - 拒绝审计走生产 auditWrite 中间件（outcome='denied'，request_data 仅 {status,code}，绝无请求体）；
 * - actor 只信认证上下文 req.user。
 *
 * 测试姿势：
 * - 真实生产 Express 全应用（src/app.ts 默认导出，含 auditWrite）+ node:sqlite 文件库；
 * - 文件库让第二个真实 DatabaseSync 连接（rival）能在「预检之后、拿锁之前」提交占用
 *   （确定性 committed-race harness，同 delete-reference-guards.test.ts：固定的是调度，不是造假的写入）；
 * - DATABASE_PATH / JWT_SECRET 在任何 src 模块 import 之前覆写。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type express from 'express'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'coreone-loc029-capacity-v2-'))
const DB_FILE = join(TMP_DIR, 'location-capacity.db')
process.env.DATABASE_PATH = DB_FILE
process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
  ? process.env.JWT_SECRET
  : 'loc029-capacity-v2-test-secret-0123456789abcdef'

const PROBE_VALUE = 'loc029-body-probe-value'
const CAPACITY_CODE = 'LOCATION_CAPACITY_EXCEEDED'

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

beforeEach(() => resetDenialTracker?.())

afterAll(() => {
  try { rival?.close() } catch { /* already closed */ }
  try { closeDatabaseForTest?.() } catch { /* already closed */ }
  rmSync(TMP_DIR, { recursive: true, force: true })
}, 120_000)

// ── 通用 helper ─────────────────────────────────────────────────────────────

let seq = 0
function sfx(): string {
  seq += 1
  return `s${seq}`
}

const post = (path: string, body: object) =>
  request(app).post(path).set('Authorization', `Bearer ${adminToken}`).send(body)
const put = (path: string, body: object) =>
  request(app).put(path).set('Authorization', `Bearer ${adminToken}`).send(body)
const del = (path: string, body?: object) =>
  request(app).delete(path).set('Authorization', `Bearer ${adminToken}`).send(body ?? {})
const postKey = (path: string, body: object, key: string) =>
  request(app).post(path).set('Authorization', `Bearer ${adminToken}`).set('Idempotency-Key', key).send(body)

const row = (table: string, id: string) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c as number

function snapshotTables(tables: string[]): Record<string, number> {
  return Object.fromEntries(tables.map((table) => [table, count(table)]))
}

function expectSnapshotUnchanged(before: Record<string, number>, tables: string[]) {
  for (const table of tables) {
    expect(count(table), `table ${table} row count changed`).toBe(before[table])
  }
}

function seedLocation(id: string, opts: { capacity?: unknown; status?: number; isDeleted?: number } = {}) {
  db.prepare('INSERT INTO locations (id, code, name, type, zone, capacity, status, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `LOC-${id}`, `库位-${id}`, 'shelf', 'CAP区',
      opts.capacity === undefined ? 999999 : opts.capacity,
      opts.status ?? 1, opts.isDeleted ?? 0)
}

function seedMaterial(id: string, opts: { locationId?: string | null } = {}) {
  db.prepare("INSERT INTO materials (id, code, name, unit, category_id, location_id, status, is_deleted) VALUES (?, ?, ?, '盒', 'CAT-CAP', ?, 1, 0)")
    .run(id, `MAT-${id}`, `物料-${id}`, opts.locationId ?? null)
}

/** 种一组自洽的批次+库存事实（批次是唯一事实源，inventory 为派生缓存）。 */
function seedStock(materialId: string, locationId: string | null, quantity: number, opts: { batchId?: string; batchNo?: string } = {}) {
  const batchId = opts.batchId ?? `B-${materialId}`
  const batchNo = opts.batchNo ?? `BN-${materialId}`
  db.prepare(`
    INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, status)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(batchId, materialId, batchNo, quantity, quantity, `SEED-INBOUND-${materialId}`, quantity > 0 ? 1 : 0)
  db.prepare('INSERT INTO inventory (id, material_id, stock, locked_stock, location_id) VALUES (?, ?, ?, 0, ?)')
    .run(`INV-${materialId}`, materialId, quantity, locationId)
  return { batchId, batchNo }
}

function stockOf(materialId: string): number {
  return (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock
}

function locationOf(materialId: string): string | null {
  return (db.prepare('SELECT location_id FROM inventory WHERE material_id = ?').get(materialId) as any)?.location_id ?? null
}

function idempotencyRow(key: string) {
  return db.prepare('SELECT * FROM idempotency_keys WHERE idempotency_key = ?').get(key)
}

/** 最新的容量门拒绝审计：仅 {status,code} 元数据、actor 来自认证上下文、绝无请求体泄漏 */
function expectCapacityDenialAudit(method: string, moduleMarker: string, pathMarker?: string) {
  const logs = db.prepare(
    `SELECT * FROM operation_logs WHERE outcome = 'denied' AND operation = ? ORDER BY rowid DESC`,
  ).all(`DENIED ${method} ${moduleMarker}`) as Array<{ description: string; request_data: string; username: string }>
  const log = logs.find((entry) => entry.description.includes('409')
    && entry.description.includes(CAPACITY_CODE)
    && (!pathMarker || entry.description.includes(pathMarker)))
  expect(log, `missing capacity denial audit row for ${method} ${moduleMarker} ${pathMarker ?? ''}`).toBeTruthy()
  expect(log!.request_data).toBe(`{"status":409,"code":"${CAPACITY_CODE}"}`)
  expect(log!.request_data).not.toContain(PROBE_VALUE)
  expect(log!.description).not.toContain(PROBE_VALUE)
  expect(log!.username).toBe('admin')
}

/** 确定性 committed-race：rival（真实第二连接、自提交）在首个 BEGIN IMMEDIATE 之前提交占用变化 */
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

const BUSINESS_TABLES = [
  'inbound_records', 'return_records', 'scrap_records', 'outbound_records', 'outbound_items',
  'supplier_returns', 'stocktaking_records', 'stock_logs', 'batches', 'inventory', 'idempotency_keys',
]

// ── inbound create ──────────────────────────────────────────────────────────

describe('inbound create（POST /api/v1/inbound）容量门', () => {
  it('精确等于容量放行（used 0 + 10 → cap 10）', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    const res = await post('/api/v1/inbound', {
      type: 'direct', materialId: `M-${s}`, quantity: 10, locationId: `L-${s}`, price: 1,
    })
    expect(res.status).toBe(201)
    expect(stockOf(`M-${s}`)).toBe(10)
    expect(locationOf(`M-${s}`)).toBe(`L-${s}`)
  })

  it('超容一个单位 → 稳定 409 + 零部分态 + 拒绝审计脱敏', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    const before = snapshotTables(BUSINESS_TABLES)
    const res = await post('/api/v1/inbound', {
      type: 'direct', materialId: `M-${s}`, quantity: 11, locationId: `L-${s}`, price: 1, probeNote: PROBE_VALUE,
    })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(row('inventory', `INV-M-${s}`)).toBeUndefined()
    expectCapacityDenialAudit('POST', 'inbound')
  })

  it('容量 0 是合法零容量：任何正数入库 → 409', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 0 })
    seedMaterial(`M-${s}`)
    const res = await post('/api/v1/inbound', {
      type: 'direct', materialId: `M-${s}`, quantity: 1, locationId: `L-${s}`,
    })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expect(row('inventory', `INV-M-${s}`)).toBeUndefined()
  })

  it('999999 是有限数值硬上限：used 999998 + 1 → 201；再 +1 → 409', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 999999 })
    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, 999998)
    seedMaterial(`M-${s}`)
    const ok = await post('/api/v1/inbound', {
      type: 'direct', materialId: `M-${s}`, quantity: 1, locationId: `L-${s}`,
    })
    expect(ok.status).toBe(201)
    seedMaterial(`M2-${s}`)
    const over = await post('/api/v1/inbound', {
      type: 'direct', materialId: `M2-${s}`, quantity: 1, locationId: `L-${s}`,
    })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expect(row('inventory', `INV-M2-${s}`)).toBeUndefined()
  })

  it('inactive / 已删除 / 未知目标库位 → 409', async () => {
    const s = sfx()
    seedLocation(`LI-${s}`, { status: 0 })
    seedLocation(`LD-${s}`, { isDeleted: 1 })
    for (const locationId of [`LI-${s}`, `LD-${s}`, `L-UNKNOWN-${s}`]) {
      const m = `M-${locationId}`
      seedMaterial(m)
      const res = await post('/api/v1/inbound', { type: 'direct', materialId: m, quantity: 1, locationId })
      expect(res.status, `location ${locationId}`).toBe(409)
      expect(res.body?.error?.code).toBe(CAPACITY_CODE)
      expect(row('inventory', `INV-${m}`)).toBeUndefined()
    }
  })

  it('corrupt 容量（TEXT / 负数 / NULL / 不安全整数）一律 fail closed → 409', async () => {
    const s = sfx()
    const cases: Array<[string, unknown]> = [
      [`LC-T-${s}`, 'corrupt'],
      [`LC-N-${s}`, -1],
      [`LC-U-${s}`, null],
      [`LC-B-${s}`, 1e20],
    ]
    for (const [locationId, capacity] of cases) {
      seedLocation(locationId, { capacity })
      const m = `M-${locationId}`
      seedMaterial(m)
      const res = await post('/api/v1/inbound', { type: 'direct', materialId: m, quantity: 1, locationId })
      expect(res.status, `capacity=${String(capacity)}`).toBe(409)
      expect(res.body?.error?.code).toBe(CAPACITY_CODE)
      expect(row('inventory', `INV-${m}`)).toBeUndefined()
    }
  })

  it('corrupt 库存事实（该库位下其他物料 stock 为 TEXT）→ 409', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 100 })
    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, 5)
    db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run('corrupt', `F-${s}`)
    seedMaterial(`M-${s}`)
    const res = await post('/api/v1/inbound', {
      type: 'direct', materialId: `M-${s}`, quantity: 1, locationId: `L-${s}`,
    })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expect(row('inventory', `INV-M-${s}`)).toBeUndefined()
  })

  it('projected used 超出安全数值范围 → 409', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: Number.MAX_SAFE_INTEGER })
    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, Number.MAX_SAFE_INTEGER - 1)
    seedMaterial(`M-${s}`)
    const res = await post('/api/v1/inbound', {
      type: 'direct', materialId: `M-${s}`, quantity: 2, locationId: `L-${s}`,
    })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expect(row('inventory', `INV-M-${s}`)).toBeUndefined()
  })

  it('同幂等键重试：两次稳定 409 零幂等部分态；容量修复后同键成功且只入账一次', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    const key = `idem-cap-${s}`
    const body = { type: 'direct', materialId: `M-${s}`, quantity: 11, locationId: `L-${s}` }
    const recordsBefore = count('inbound_records')
    const first = await postKey('/api/v1/inbound', body, key)
    expect(first.status).toBe(409)
    expect(idempotencyRow(key)).toBeUndefined()
    const second = await postKey('/api/v1/inbound', body, key)
    expect(second.status).toBe(409)
    expect(idempotencyRow(key)).toBeUndefined()
    expect(count('inbound_records')).toBe(recordsBefore)

    const raise = await put(`/api/v1/locations/L-${s}`, { capacity: 11 })
    expect(raise.status).toBe(200)
    const third = await postKey('/api/v1/inbound', body, key)
    expect(third.status).toBe(201)
    expect(count('inbound_records')).toBe(recordsBefore + 1)
    expect(stockOf(`M-${s}`)).toBe(11)

    const replay = await postKey('/api/v1/inbound', body, key)
    expect(replay.status).toBe(201)
    expect(count('inbound_records')).toBe(recordsBefore + 1)
    expect(stockOf(`M-${s}`)).toBe(11)
  })

  it('锁内重读：rival 在拿锁前把库位填满 → 409', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, 0)
    seedMaterial(`M-${s}`)
    const race = installCommittedRace(() => {
      rival.prepare('UPDATE inventory SET stock = 10 WHERE material_id = ?').run(`F-${s}`)
    })
    const res = await post('/api/v1/inbound', {
      type: 'direct', materialId: `M-${s}`, quantity: 1, locationId: `L-${s}`,
    })
    race.restore()
    expect(race.fired()).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expect(row('inventory', `INV-M-${s}`)).toBeUndefined()
  })
})

// ── inbound update（数量增加 / 恢复 / 库位变更）──────────────────────────────

describe('inbound update（PUT /api/v1/inbound/:id）容量门', () => {
  async function createInbound(materialId: string, locationId: string, quantity: number): Promise<string> {
    const res = await post('/api/v1/inbound', { type: 'direct', materialId, quantity, locationId, price: 1 })
    expect(res.status).toBe(201)
    return res.body.data.id as string
  }

  it('已完成记录数量上调超容 → 409 零部分态；调到精确容量 → 200', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    const id = await createInbound(`M-${s}`, `L-${s}`, 5)
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await put(`/api/v1/inbound/${id}`, { quantity: 11, probeNote: PROBE_VALUE })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(row('inbound_records', id).quantity).toBe(5)
    expect(stockOf(`M-${s}`)).toBe(5)
    expectCapacityDenialAudit('PUT', 'inbound')

    const exact = await put(`/api/v1/inbound/${id}`, { quantity: 10 })
    expect(exact.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(10)
  })

  it('取消后恢复（restore）超容 → 409 零部分态；清出空间后恢复 → 200', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    const id = await createInbound(`M-${s}`, `L-${s}`, 8)
    const cancel = await put(`/api/v1/inbound/${id}`, { status: 'cancelled' })
    expect(cancel.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(0)

    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, 3)
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await put(`/api/v1/inbound/${id}`, { status: 'completed' })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(row('inbound_records', id).status).toBe('cancelled')
    expect(stockOf(`M-${s}`)).toBe(0)

    db.prepare('UPDATE inventory SET stock = 2 WHERE material_id = ?').run(`F-${s}`)
    db.prepare('UPDATE batches SET quantity = 2, remaining = 2 WHERE material_id = ?').run(`F-${s}`)
    const exact = await put(`/api/v1/inbound/${id}`, { status: 'completed' })
    expect(exact.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(8)
  })

  it('库位变更 = 整物料库存迁移：目标库位放不下 → 409 零部分态；放得下 → 200', async () => {
    const s = sfx()
    seedLocation(`L1-${s}`, { capacity: 100 })
    seedLocation(`L2-${s}`, { capacity: 5 })
    seedMaterial(`M-${s}`)
    const id = await createInbound(`M-${s}`, `L1-${s}`, 8)
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await put(`/api/v1/inbound/${id}`, { locationId: `L2-${s}` })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(locationOf(`M-${s}`)).toBe(`L1-${s}`)
    expect(row('inbound_records', id).location_id).toBe(`L1-${s}`)

    const raise = await put(`/api/v1/locations/L2-${s}`, { capacity: 8 })
    expect(raise.status).toBe(200)
    const ok = await put(`/api/v1/inbound/${id}`, { locationId: `L2-${s}` })
    expect(ok.status).toBe(200)
    expect(locationOf(`M-${s}`)).toBe(`L2-${s}`)
  })
})

// ── transfers（目的地迁入 / 撤销回迁）────────────────────────────────────────

describe('transfers 容量门', () => {
  function seedMaterialWithStock(s: string, locationId: string, quantity: number): string {
    const materialId = `M-${s}`
    seedMaterial(materialId)
    seedStock(materialId, locationId, quantity)
    return materialId
  }

  it('迁入目的地：精确容量 → 200；超容 → 409 零部分态', async () => {
    const s = sfx()
    seedLocation(`L1-${s}`, { capacity: 100 })
    seedLocation(`L2-${s}`, { capacity: 10 })
    const materialId = seedMaterialWithStock(s, `L1-${s}`, 10)
    const exact = await post('/api/v1/transfers/inbound', {
      materialId, quantity: 10, fromLocationId: `L1-${s}`, toLocationId: `L2-${s}`,
    })
    expect(exact.status).toBe(200)
    expect(locationOf(materialId)).toBe(`L2-${s}`)

    seedLocation(`L3-${s}`, { capacity: 9 })
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await post('/api/v1/transfers/inbound', {
      materialId, quantity: 10, fromLocationId: `L2-${s}`, toLocationId: `L3-${s}`, probeNote: PROBE_VALUE,
    })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(locationOf(materialId)).toBe(`L2-${s}`)
    expectCapacityDenialAudit('POST', 'transfers', '/transfers/inbound')
  })

  it('source=destination 仍然 400（既有契约不变）', async () => {
    const s = sfx()
    seedLocation(`L1-${s}`, { capacity: 100 })
    const materialId = seedMaterialWithStock(s, `L1-${s}`, 10)
    const res = await post('/api/v1/transfers/inbound', {
      materialId, quantity: 1, fromLocationId: `L1-${s}`, toLocationId: `L1-${s}`,
    })
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('INVALID_PARAMETER')
  })

  it('零库存迁移进容量 0 库位 → 200（projected 0 ≤ 0）；进 corrupt 容量库位 → 409（未知不是零）', async () => {
    const s = sfx()
    seedLocation(`L1-${s}`, { capacity: 100 })
    seedLocation(`LZ-${s}`, { capacity: 0 })
    seedLocation(`LC-${s}`, { capacity: 'corrupt' })
    const materialId = seedMaterialWithStock(s, `L1-${s}`, 0)

    const zero = await post('/api/v1/transfers/inbound', {
      materialId, quantity: 1, fromLocationId: `L1-${s}`, toLocationId: `LZ-${s}`,
    })
    expect(zero.status).toBe(200)
    expect(locationOf(materialId)).toBe(`LZ-${s}`)

    const corrupt = await post('/api/v1/transfers/inbound', {
      materialId, quantity: 1, fromLocationId: `LZ-${s}`, toLocationId: `LC-${s}`,
    })
    expect(corrupt.status).toBe(409)
    expect(corrupt.body?.error?.code).toBe(CAPACITY_CODE)
    expect(locationOf(materialId)).toBe(`LZ-${s}`)
  })

  it('撤销调拨回迁来源库位：来源放不下 → 409 零部分态；放得下 → 200', async () => {
    const s = sfx()
    seedLocation(`L1-${s}`, { capacity: 100 })
    seedLocation(`L2-${s}`, { capacity: 100 })
    const materialId = seedMaterialWithStock(s, `L1-${s}`, 10)
    const created = await post('/api/v1/transfers/inbound', {
      materialId, quantity: 10, fromLocationId: `L1-${s}`, toLocationId: `L2-${s}`,
    })
    expect(created.status).toBe(200)
    const transferId = created.body.data.id as string

    const lower = await put(`/api/v1/locations/L1-${s}`, { capacity: 5 })
    expect(lower.status).toBe(200)
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await del(`/api/v1/transfers/${transferId}`, { probeNote: PROBE_VALUE })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(locationOf(materialId)).toBe(`L2-${s}`)
    expect(row('inbound_records', transferId).is_deleted).toBe(0)
    expectCapacityDenialAudit('DELETE', 'transfers')

    const raise = await put(`/api/v1/locations/L1-${s}`, { capacity: 10 })
    expect(raise.status).toBe(200)
    const ok = await del(`/api/v1/transfers/${transferId}`)
    expect(ok.status).toBe(200)
    expect(locationOf(materialId)).toBe(`L1-${s}`)
  })
})

// ── returns create（客户退库入库）────────────────────────────────────────────

describe('returns create 容量门', () => {
  it('退库入库：精确容量 → 200；超容 → 409 零部分态（含幂等键）', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`, { locationId: `L-${s}` })
    seedStock(`M-${s}`, `L-${s}`, 8)

    const exact = await post('/api/v1/returns', { materialId: `M-${s}`, quantity: 2, reason: '客户退回' })
    expect(exact.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(10)

    const key = `idem-ret-${s}`
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await postKey('/api/v1/returns', { materialId: `M-${s}`, quantity: 1, reason: '客户退回', probeNote: PROBE_VALUE }, key)
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(idempotencyRow(key)).toBeUndefined()
    expect(stockOf(`M-${s}`)).toBe(10)
    expectCapacityDenialAudit('POST', 'returns')
  })
})

// ── scraps cancel（撤销报废恢复占用）─────────────────────────────────────────

describe('scraps cancel 容量门', () => {
  it('撤销报废恢复占用：精确容量 → 200；容量期间被调低 → 409 零部分态', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    const { batchId, batchNo } = seedStock(`M-${s}`, `L-${s}`, 10)
    const created = await post('/api/v1/scraps', { materialId: `M-${s}`, quantity: 4, reason: '损坏', batchId, batchNo })
    expect(created.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(6)
    const scrapId = created.body.data.id as string

    const lower = await put(`/api/v1/locations/L-${s}`, { capacity: 8 })
    expect(lower.status).toBe(200)
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await del(`/api/v1/scraps/${scrapId}`, { probeNote: PROBE_VALUE })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(row('scrap_records', scrapId).is_deleted).toBe(0)
    expect(stockOf(`M-${s}`)).toBe(6)
    expectCapacityDenialAudit('DELETE', 'scraps')

    const raise = await put(`/api/v1/locations/L-${s}`, { capacity: 10 })
    expect(raise.status).toBe(200)
    const exact = await del(`/api/v1/scraps/${scrapId}`)
    expect(exact.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(10)
  })

  it('恢复占用时目标库位未知（悬空 location_id）→ 409', async () => {
    const s = sfx()
    seedMaterial(`M-${s}`)
    const { batchId, batchNo } = seedStock(`M-${s}`, `L-GONE-${s}`, 10)
    const created = await post('/api/v1/scraps', { materialId: `M-${s}`, quantity: 4, reason: '损坏', batchId, batchNo })
    expect(created.status).toBe(200)
    const res = await del(`/api/v1/scraps/${created.body.data.id}`)
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expect(stockOf(`M-${s}`)).toBe(6)
  })
})

// ── outbound restore（删除/修改出库恢复占用）─────────────────────────────────

describe('outbound restore 容量门', () => {
  async function setupOutbound(s: string): Promise<string> {
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    seedStock(`M-${s}`, `L-${s}`, 10)
    const created = await post('/api/v1/outbound', {
      type: 'direct', items: [{ materialId: `M-${s}`, quantity: 4 }],
    })
    expect(created.status).toBe(201)
    expect(stockOf(`M-${s}`)).toBe(6)
    return created.body.data.id as string
  }

  it('删除出库恢复占用：容量期间被调低 → 409 零部分态；恢复后 → 200', async () => {
    const s = sfx()
    const outboundId = await setupOutbound(s)
    const lower = await put(`/api/v1/locations/L-${s}`, { capacity: 8 })
    expect(lower.status).toBe(200)
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await del(`/api/v1/outbound/${outboundId}`, { probeNote: PROBE_VALUE })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(row('outbound_records', outboundId).is_deleted).toBe(0)
    expect(stockOf(`M-${s}`)).toBe(6)
    expectCapacityDenialAudit('DELETE', 'outbound')

    const raise = await put(`/api/v1/locations/L-${s}`, { capacity: 10 })
    expect(raise.status).toBe(200)
    const exact = await del(`/api/v1/outbound/${outboundId}`)
    expect(exact.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(10)
  })

  it('修改出库（先恢复原明细）：恢复即超容 → 409 零部分态；精确容量 → 200', async () => {
    const s = sfx()
    const outboundId = await setupOutbound(s)
    const lower = await put(`/api/v1/locations/L-${s}`, { capacity: 8 })
    expect(lower.status).toBe(200)
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await put(`/api/v1/outbound/${outboundId}`, {
      items: [{ materialId: `M-${s}`, quantity: 3 }], probeNote: PROBE_VALUE,
    })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(stockOf(`M-${s}`)).toBe(6)
    const items = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(outboundId) as any[]
    expect(items.length).toBe(1)
    expect(items[0].quantity).toBe(4)
    expectCapacityDenialAudit('PUT', 'outbound')

    const raise = await put(`/api/v1/locations/L-${s}`, { capacity: 10 })
    expect(raise.status).toBe(200)
    const exact = await put(`/api/v1/outbound/${outboundId}`, {
      items: [{ materialId: `M-${s}`, quantity: 5 }],
    })
    expect(exact.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(5)
  })
})

// ── stocktaking upward（盘点上调）────────────────────────────────────────────

describe('stocktaking 容量门', () => {
  it('盘点上调超容 → 409 零部分态；精确容量 → 200；下调不走容量门', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    seedStock(`M-${s}`, `L-${s}`, 5)

    const created = await post('/api/v1/stocktaking', { materialId: `M-${s}`, actualStock: 11 })
    expect(created.status).toBe(200)
    expect(created.body.data.status).toBe('pending')
    const before = snapshotTables(BUSINESS_TABLES)
    const over = await post(`/api/v1/stocktaking/${created.body.data.id}/adjust`, { reason: 'normal', probeNote: PROBE_VALUE })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(row('stocktaking_records', created.body.data.id).status).toBe('pending')
    expect(stockOf(`M-${s}`)).toBe(5)
    expectCapacityDenialAudit('POST', 'stocktaking', '/adjust')

    const exact = await post('/api/v1/stocktaking', { materialId: `M-${s}`, actualStock: 10 })
    expect(exact.status).toBe(200)
    const adjusted = await post(`/api/v1/stocktaking/${exact.body.data.id}/adjust`, { reason: 'normal' })
    expect(adjusted.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(10)

    const down = await post('/api/v1/stocktaking', { materialId: `M-${s}`, actualStock: 3 })
    expect(down.status).toBe(200)
    const downAdjusted = await post(`/api/v1/stocktaking/${down.body.data.id}/adjust`, { reason: 'normal' })
    expect(downAdjusted.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(3)
  })

  it('批量盘点任一行上调超容 → 整单 409 零部分态', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M1-${s}`)
    seedStock(`M1-${s}`, `L-${s}`, 5)
    seedMaterial(`M2-${s}`, { locationId: null })
    seedStock(`M2-${s}`, null, 1)
    const before = snapshotTables(BUSINESS_TABLES)
    const res = await post('/api/v1/stocktaking/batch', {
      items: [
        { materialId: `M2-${s}`, actualStock: 2 },
        { materialId: `M1-${s}`, actualStock: 11 },
      ],
      probeNote: PROBE_VALUE,
    })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(stockOf(`M1-${s}`)).toBe(5)
    expect(stockOf(`M2-${s}`)).toBe(1)
    expectCapacityDenialAudit('POST', 'stocktaking', '/batch')
  })

  it('无库位物料的上调不入任何容量账本 → 放行（容量门只守有主占用）', async () => {
    const s = sfx()
    seedMaterial(`M-${s}`, { locationId: null })
    seedStock(`M-${s}`, null, 5)
    const created = await post('/api/v1/stocktaking', { materialId: `M-${s}`, actualStock: 10 })
    expect(created.status).toBe(200)
    const adjusted = await post(`/api/v1/stocktaking/${created.body.data.id}/adjust`, { reason: 'normal' })
    expect(adjusted.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(10)
  })
})

// ── supplier-returns reversal（取消/删除恢复占用）────────────────────────────

describe('supplier-returns reversal 容量门', () => {
  it('status→cancelled 恢复占用超容 → 409 零部分态；DELETE pending 恢复超容 → 409；容量修复后 → 200', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`M-${s}`)
    seedStock(`M-${s}`, `L-${s}`, 10)
    const created = await post('/api/v1/supplier-returns', { materialId: `M-${s}`, quantity: 4, reason: '质量问题' })
    expect(created.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(6)
    const returnId = created.body.data.id as string

    const lower = await put(`/api/v1/locations/L-${s}`, { capacity: 8 })
    expect(lower.status).toBe(200)

    const beforeCancel = snapshotTables(BUSINESS_TABLES)
    const overCancel = await put(`/api/v1/supplier-returns/${returnId}/status`, { status: 'cancelled', probeNote: PROBE_VALUE })
    expect(overCancel.status).toBe(409)
    expect(overCancel.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(beforeCancel, BUSINESS_TABLES)
    expect(row('supplier_returns', returnId).status).toBe('pending')
    expect(stockOf(`M-${s}`)).toBe(6)
    expectCapacityDenialAudit('PUT', 'supplier-returns')

    const beforeDelete = snapshotTables(BUSINESS_TABLES)
    const overDelete = await del(`/api/v1/supplier-returns/${returnId}`, { probeNote: PROBE_VALUE })
    expect(overDelete.status).toBe(409)
    expect(overDelete.body?.error?.code).toBe(CAPACITY_CODE)
    expectSnapshotUnchanged(beforeDelete, BUSINESS_TABLES)
    expect(row('supplier_returns', returnId).is_deleted).toBe(0)
    expect(stockOf(`M-${s}`)).toBe(6)
    expectCapacityDenialAudit('DELETE', 'supplier-returns')

    const raise = await put(`/api/v1/locations/L-${s}`, { capacity: 10 })
    expect(raise.status).toBe(200)
    const exact = await put(`/api/v1/supplier-returns/${returnId}/status`, { status: 'cancelled' })
    expect(exact.status).toBe(200)
    expect(stockOf(`M-${s}`)).toBe(10)
  })
})

// ── locations 容量修改路径 ───────────────────────────────────────────────────

describe('locations 容量修改容量门', () => {
  it('调低容量低于当前占用 → 409 零部分态；调到精确等于占用 → 200；调高 → 200', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, 8)

    const over = await put(`/api/v1/locations/L-${s}`, { capacity: 7, probeNote: PROBE_VALUE })
    expect(over.status).toBe(409)
    expect(over.body?.error?.code).toBe(CAPACITY_CODE)
    expect(row('locations', `L-${s}`).capacity).toBe(10)
    expectCapacityDenialAudit('PUT', 'locations')

    const exact = await put(`/api/v1/locations/L-${s}`, { capacity: 8 })
    expect(exact.status).toBe(200)
    expect(row('locations', `L-${s}`).capacity).toBe(8)

    const raise = await put(`/api/v1/locations/L-${s}`, { capacity: 100 })
    expect(raise.status).toBe(200)
    expect(row('locations', `L-${s}`).capacity).toBe(100)
  })

  it('容量改为 0 且占用为 0 → 200（合法零容量）', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    const res = await put(`/api/v1/locations/L-${s}`, { capacity: 0 })
    expect(res.status).toBe(200)
    expect(row('locations', `L-${s}`).capacity).toBe(0)
  })

  it('容量输入非法（负数 / 小数 / 字符串 / 不安全整数）→ 400 且不写库', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    for (const capacity of [-1, 1.5, 'abc', Number.MAX_SAFE_INTEGER + 1]) {
      const res = await put(`/api/v1/locations/L-${s}`, { capacity })
      expect(res.status, `capacity=${capacity}`).toBe(400)
      expect(row('locations', `L-${s}`).capacity).toBe(10)
    }
  })

  it('占用事实 corrupt 时修改容量 → 409 fail closed', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, 8)
    db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run('corrupt', `F-${s}`)
    const res = await put(`/api/v1/locations/L-${s}`, { capacity: 9 })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expect(row('locations', `L-${s}`).capacity).toBe(10)
  })

  it('不含 capacity 字段的普通编辑不触发容量门（存量超占 legacy 也可改名）', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 5 })
    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, 8)
    const res = await put(`/api/v1/locations/L-${s}`, { name: `改名-${s}` })
    expect(res.status).toBe(200)
    expect(row('locations', `L-${s}`).name).toBe(`改名-${s}`)
    const over = await put(`/api/v1/locations/L-${s}`, { capacity: 6 })
    expect(over.status).toBe(409)
    expect(row('locations', `L-${s}`).capacity).toBe(5)
  })

  it('创建库位 capacity=0 如实存 0；非法容量 → 400', async () => {
    const s = sfx()
    const zero = await post('/api/v1/locations', { name: `零容-${s}`, zone: 'CAP区', capacity: 0 })
    expect(zero.status).toBe(201)
    expect(row('locations', zero.body.data.id).capacity).toBe(0)

    const invalid = await post('/api/v1/locations', { name: `非法-${s}`, zone: 'CAP区', capacity: -5 })
    expect(invalid.status).toBe(400)

    const def = await post('/api/v1/locations', { name: `默认-${s}`, zone: 'CAP区' })
    expect(def.status).toBe(201)
    expect(row('locations', def.body.data.id).capacity).toBe(999999)
  })

  it('锁内重读：rival 在拿锁前抬高占用 → 调低容量 409', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    seedMaterial(`F-${s}`)
    seedStock(`F-${s}`, `L-${s}`, 3)
    const race = installCommittedRace(() => {
      rival.prepare('UPDATE inventory SET stock = 8 WHERE material_id = ?').run(`F-${s}`)
    })
    const res = await put(`/api/v1/locations/L-${s}`, { capacity: 5 })
    race.restore()
    expect(race.fired()).toBe(true)
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe(CAPACITY_CODE)
    expect(row('locations', `L-${s}`).capacity).toBe(10)
  })
})

// ── R2 修复：supplied locationId 形状（K3-LOC-029 R2 finding 1）────────────────

describe('inbound supplied locationId 形状校验（R2 修复）', () => {
  async function createInbound(materialId: string, locationId: string, quantity: number): Promise<string> {
    const res = await post('/api/v1/inbound', { type: 'direct', materialId, quantity, locationId, price: 1 })
    expect(res.status).toBe(201)
    return res.body.data.id as string
  }

  it('PUT：数字 locationId 稳定 400 零部分态（reviewer 复现：迁入 capacity=0 的数字 id 库位被错误放行）', async () => {
    const s = sfx()
    const numericLocationId = String(100000 + seq)
    seedLocation(numericLocationId, { capacity: 0 })
    seedLocation(`L1-${s}`, { capacity: 100 })
    seedMaterial(`M-${s}`)
    const id = await createInbound(`M-${s}`, `L1-${s}`, 5)
    const before = snapshotTables(BUSINESS_TABLES)
    const res = await put(`/api/v1/inbound/${id}`, { locationId: Number(numericLocationId), probeNote: PROBE_VALUE })
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('INVALID_PARAMETER')
    expectSnapshotUnchanged(before, BUSINESS_TABLES)
    expect(locationOf(`M-${s}`)).toBe(`L1-${s}`)
    expect(row('inbound_records', id).location_id).toBe(`L1-${s}`)
  })

  it('PUT：空串 / 全空白 / 首尾空白（trim-confused）/ null / object / array → 稳定 400 零部分态', async () => {
    const s = sfx()
    seedLocation(`L1-${s}`, { capacity: 100 })
    seedMaterial(`M-${s}`)
    const id = await createInbound(`M-${s}`, `L1-${s}`, 5)
    const badValues: unknown[] = ['', '   ', ` L1-${s} `, null, { id: `L1-${s}` }, [`L1-${s}`]]
    for (const bad of badValues) {
      const before = snapshotTables(BUSINESS_TABLES)
      const res = await put(`/api/v1/inbound/${id}`, { locationId: bad })
      expect(res.status, `locationId=${JSON.stringify(bad)}`).toBe(400)
      expect(res.body?.error?.code).toBe('INVALID_PARAMETER')
      expectSnapshotUnchanged(before, BUSINESS_TABLES)
      expect(row('inbound_records', id).location_id).toBe(`L1-${s}`)
    }
    expect(locationOf(`M-${s}`)).toBe(`L1-${s}`)
  })

  it('PUT：合法字符串 locationId 仍按既有语义迁移（形状校验不误伤正常迁移）', async () => {
    const s = sfx()
    seedLocation(`L1-${s}`, { capacity: 100 })
    seedLocation(`L2-${s}`, { capacity: 100 })
    seedMaterial(`M-${s}`)
    const id = await createInbound(`M-${s}`, `L1-${s}`, 5)
    const res = await put(`/api/v1/inbound/${id}`, { locationId: `L2-${s}` })
    expect(res.status).toBe(200)
    expect(locationOf(`M-${s}`)).toBe(`L2-${s}`)
  })

  it('POST create：数字或 trim-confused 的 locationId → 400', async () => {
    const s = sfx()
    seedLocation(`L1-${s}`, { capacity: 100 })
    seedMaterial(`M-${s}`)
    for (const bad of [12345, ` L1-${s} `] as unknown[]) {
      const before = snapshotTables(BUSINESS_TABLES)
      const res = await post('/api/v1/inbound', { type: 'direct', materialId: `M-${s}`, quantity: 1, locationId: bad })
      expect(res.status, `locationId=${JSON.stringify(bad)}`).toBe(400)
      expect(res.body?.error?.code).toBe('INVALID_PARAMETER')
      expectSnapshotUnchanged(before, BUSINESS_TABLES)
    }
    expect(row('inventory', `INV-M-${s}`)).toBeUndefined()
  })
})

// ── R2 修复：显式 capacity:null 不等于字段缺失（K3-LOC-029 R2 finding 2）──────

describe('locations 显式 null 容量（R2 修复）', () => {
  it('创建库位：显式 capacity:null 与 blank/object/array → 400；仅字段缺失才用默认 999999', async () => {
    const s = sfx()
    for (const capacity of [null, ' ', {}, []] as unknown[]) {
      const before = count('locations')
      const res = await post('/api/v1/locations', { name: `显式非法-${s}`, zone: 'CAP区', capacity })
      expect(res.status, `capacity=${JSON.stringify(capacity)}`).toBe(400)
      expect(count('locations')).toBe(before)
    }
    const absent = await post('/api/v1/locations', { name: `缺省-${s}`, zone: 'CAP区' })
    expect(absent.status).toBe(201)
    expect(row('locations', absent.body.data.id).capacity).toBe(999999)
  })

  it('编辑库位：显式 capacity:null → 400 且不写库', async () => {
    const s = sfx()
    seedLocation(`L-${s}`, { capacity: 10 })
    const res = await put(`/api/v1/locations/L-${s}`, { capacity: null })
    expect(res.status).toBe(400)
    expect(row('locations', `L-${s}`).capacity).toBe(10)
  })
})
