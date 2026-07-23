import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import {
  allowDefaultFixtureUsers,
  hashMatchesKnownLeakedDefaultPassword,
  initialAdminPasswordProblem,
} from '../config/security.js'
import { HISTORICAL_DEFAULT_ACCOUNTS } from '../config/historical-default-accounts.js'
import { join, dirname, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { SEED_MATRIX } from '../middleware/rbac-matrix.js'
import { CHARGE_CODE_SEED, chargeDefToRow } from '../utils/charge-catalog.js'
import { seedProjectCatalog } from '../utils/project-catalog.js'
import { NGS_PRODUCT_SEED, ngsProductToRow } from '../utils/ngs-catalog.js'
import { ANTIBODY_LEDGER_SEED, DETECTION_LEDGER_SEED, ANTIBODY_LEDGER_SOURCE } from '../utils/antibody-catalog.js'
import { DEFAULT_IHC_COST_PARAMS } from '../utils/antibody-cost.js'
import { ANTIBODY_SYNONYM_SEED, ANTIBODY_MISSING_PRICE_SEED } from '../utils/antibody-name-map.js'
import { ensureHospitalCmAccountRosterSchema } from '../utils/hospital-cm-account-roster.js'
import { ensureHospitalCmReadinessSchema } from '../utils/hospital-cm-readiness-runtime.js'
import { ensureHospitalCmPeriodEvidenceSchema } from '../utils/hospital-cm-period-evidence.js'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function assertExistingCoreoneDatabase(databasePath: string): void {
  let probe: DatabaseSync | undefined
  try {
    // Node 22 runtime supports readOnly; the repository's older @types/node 20
    // declaration does not yet expose that experimental option.
    probe = new DatabaseSync(databasePath, { readOnly: true } as any)
    const quickCheck = probe.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
    if (quickCheck?.quick_check !== 'ok') throw new Error('SQLite quick_check failed')
    const hasUsers = probe
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get() as { ok?: number } | undefined
    if (!hasUsers?.ok) throw new Error('missing COREONE users table')
    const columns = new Set(
      (probe.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(column => column.name)
    )
    const missing = ['username', 'password'].filter(column => !columns.has(column))
    if (missing.length) throw new Error(`users missing required columns: ${missing.join(', ')}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown validation failure'
    throw new Error(`[SECURITY] DATABASE_PATH 不是可识别的 COREONE 生产库：${detail}`)
  } finally {
    probe?.close()
  }
}

const configuredDatabasePath = process.env.DATABASE_PATH
const fixtureDatabase = allowDefaultFixtureUsers()
if (!fixtureDatabase && (!configuredDatabasePath || !isAbsolute(configuredDatabasePath))) {
  throw new Error('[SECURITY] 生产级环境必须显式设置绝对路径 DATABASE_PATH；拒绝静默创建或检查错误数据库。')
}
const DB_PATH = configuredDatabasePath || join(__dirname, '../../data/coreone.db')

if (!fixtureDatabase) {
  if (fs.existsSync(DB_PATH)) {
    const stat = fs.statSync(DB_PATH)
    if (!stat.isFile()) {
      throw new Error('[SECURITY] DATABASE_PATH 必须指向普通数据库文件。')
    }
    if (stat.size === 0) {
      if (process.env.COREONE_ALLOW_DATABASE_CREATE !== '1') {
        throw new Error('[SECURITY] DATABASE_PATH 是空文件；仅全新首装可一次性设置 COREONE_ALLOW_DATABASE_CREATE=1。')
      }
    } else {
      assertExistingCoreoneDatabase(DB_PATH)
    }
  } else if (process.env.COREONE_ALLOW_DATABASE_CREATE !== '1') {
    throw new Error(
      '[SECURITY] DATABASE_PATH 指向的生产数据库不存在；仅全新首装可一次性设置 COREONE_ALLOW_DATABASE_CREATE=1。'
    )
  }
}

fs.mkdirSync(dirname(DB_PATH), { recursive: true })

export type ManagedDatabaseSync = DatabaseSync & {
  /**
   * Detach this exact handle from the singleton owner before best-effort close.
   * A stale handle cannot invalidate a newer replacement connection.
   */
  invalidateConnection: () => void
}

let db: ManagedDatabaseSync | null = null

function openManagedDatabase(): ManagedDatabaseSync {
  const connection = new DatabaseSync(DB_PATH) as ManagedDatabaseSync
  Object.defineProperty(connection, 'invalidateConnection', {
    configurable: false,
    enumerable: false,
    value: () => {
      invalidateDatabaseConnection(connection)
    },
  })
  return connection
}

const USERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    real_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operator',
    department TEXT,
    phone TEXT,
    email TEXT,
    status INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    updated_by TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0
  )
`

export function getDatabase(): ManagedDatabaseSync {
  if (!db) {
    db = openManagedDatabase()
  }
  return db
}

export function resetDatabase(): void {
  if (db) {
    const current = db
    db = null
    current.close()
  }
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH)
    console.log('Old database removed:', DB_PATH)
  }
}

function usersTableExists(database: DatabaseSync): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()
  )
}

function normalizeInitialAdminPassword(password: string | undefined): string | undefined {
  return password === '' ? undefined : password
}

function assertInitialAdminPasswordUsable(password: string | undefined): void {
  if (password === undefined) return
  const problem = initialAdminPasswordProblem(password)
  if (problem) {
    throw new Error(`[SECURITY] ADMIN_INITIAL_PASSWORD 不合格：${problem}；生产环境拒绝启动，未创建或修改 admin。`)
  }
}

/**
 * 聚焦迁移：仓库管理员 / 采购 的「退货给供应商」(supplier_returns) 权限补齐。
 *
 * 背景：本系统采用数据驱动 RBAC —— `roles.permissions` 是权限的单一事实源。
 * `SEED_MATRIX` 后来新增了 supplier_returns 模块，并授予 warehouse_manager / procurement 'W'，
 * 但任何「该模块加入之前」就已存在的库（含提交进仓库、CI 直接 checkout 使用的测试
 * `data/coreone.db`，以及任何已部署的生产库）的角色权限里没有这个模块；而
 * initializeDatabase 的回填只补「完全为空」的权限、不会补「新增模块」。结果这两个角色
 * 实际拿不到 supplier_returns → 虽然矩阵给了权限却在建/删退货时 403、前端退货看板被隐藏。
 * 这是一处真实的「升级迁移缺口」（新增权限模块无法触达既有库的既有角色）。
 *
 * 修复：每次初始化时确保这两个角色的权限含 supplier_returns（与 SEED_MATRIX 的 'W' 对齐）。
 * 兼容两种存储形态：旧扁平数组 ['inventory',...]（列出的码即 'W'）与对象 {mod:'R'|'W'}。
 * 幂等：已含则不重复写。含 '*'(admin) 不处理。
 *
 * ⚠️ 范围注记（有意为之，勿擅自扩大）：本迁移刻意只动 warehouse_manager / procurement
 * 两个角色的 supplier_returns 一项，不做「全角色 × 全矩阵」覆盖。SEED_MATRIX 是全新安装的
 * 默认权限；既有部署的 roles.permissions 可能包含经角色管理页确认过的本地策略，不能在启动时
 * 无条件重写。若要把其它既有角色强制对齐默认矩阵，须作为独立 RBAC 迁移逐项评审。
 */
export function reconcileSupplierReturnsPerms(database: DatabaseSync): void {
  for (const code of ['warehouse_manager', 'procurement']) {
    const row = database.prepare('SELECT permissions FROM roles WHERE code = ?').get(code) as
      | { permissions: string }
      | undefined
    if (!row) continue
    let val: unknown
    try {
      val = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions
    } catch {
      continue // 解析不了的脏值不动，避免覆盖
    }
    if (Array.isArray(val)) {
      if (val.includes('*') || val.includes('supplier_returns')) continue
      val.push('supplier_returns')
      database.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(val), code)
    } else if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>
      if (obj.supplier_returns === 'W') continue
      obj.supplier_returns = 'W'
      database.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(obj), code)
    }
  }
}

/**
 * 聚焦迁移：补齐 实验室主任(lab_director) 的 退库/盘点 写权限（returns/stocktaking → 'W'）。
 *
 * 背景（同 reconcileSupplierReturnsPerms 的 RBAC 迁移缺口，记忆 coreone-rbac-live-vs-seed-matrix）：
 * roles.permissions 是单一事实源、会 shadow SEED_MATRIX——getEffectivePermissionsForRoles 先读
 * roles 行、行缺失才回退矩阵（permissions.ts:46-48）。ROLE-DIR 自 defaultRoles 落库后，既有库的
 * lab_director 行固化了当时的 returns:'R'/stocktaking:'R'；2026-07-06 PM 拍板把这两键改 'W' 只动了
 * SEED_MATRIX，对既有库是静默无效（INSERT OR IGNORE 不覆盖既有行、backfillRolePerms 只补空值）。
 * 此函数把既有 lab_director 行的这两键对齐到 'W'，保证口径在所有库生效、无需重建库。
 * 纪律同 reconcileSupplierReturnsPerms：只动这一角色这两键、R→W 幂等、不碰其余键、
 * 不覆盖脏值/'*'——保留库中其他有意的角色×矩阵不一致（如 finance 旧形态）。
 */
export function reconcileLabDirectorInventoryPerms(database: DatabaseSync): void {
  const row = database.prepare('SELECT permissions FROM roles WHERE code = ?').get('lab_director') as
    | { permissions: string }
    | undefined
  if (!row) return // 行缺失 → getEffectivePermissionsForRoles 回退 SEED_MATRIX（已含 'W'），无需迁移
  let val: unknown
  try {
    val = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions
  } catch {
    return // 解析不了的脏值不动，避免覆盖
  }
  if (Array.isArray(val)) {
    // 旧扁平数组形态（无 R/W 粒度，presence=可访问）：确保两键在列
    if (val.includes('*')) return
    let changed = false
    for (const key of ['returns', 'stocktaking']) {
      if (!val.includes(key)) { val.push(key); changed = true }
    }
    if (changed) database.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(val), 'lab_director')
  } else if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>
    let changed = false
    for (const key of ['returns', 'stocktaking']) {
      if (obj[key] !== 'W') { obj[key] = 'W'; changed = true }
    }
    if (changed) database.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(obj), 'lab_director')
  }
}

/**
 * 聚焦迁移：补齐 财务(finance) 的 账实核对(account_reconcile) 写权限。
 *
 * 背景（同上两个 reconcile* 的 RBAC 迁移缺口，记忆 coreone-rbac-live-vs-seed-matrix）：
 * SEED_MATRIX 早已给 finance account_reconcile:'W'（财务是账实核对/补收签发的业务 owner，
 * 见路由头「写端点要 W：财务/管理员」），但既有库（含提交进仓库、CI 直接 checkout 的
 * data/coreone.db）的 finance 行是旧的最小数组 ['dashboard','cost_analysis','logs']、无此模块；
 * roles.permissions 会 shadow SEED_MATRIX（getEffectivePermissionsForRoles 先读 roles 行、
 * backfillRolePerms 只补空值不覆盖既有非空行）→ 既有库 finance 实际拿不到 account_reconcile → 403。
 *
 * 直接动因（PR #94 披露）：补收单独立签发(SoD)要求签发人≠提交人；若全库只有 admin 一个
 * account_reconcile:'W' 用户，admin 提交的补收单无人可签 = 确定性死锁。补 finance 'W' 提供
 * 第二签发人（≥2 人持 W），解锁 SoD。2026-07-07 PM 拍板「给财务也开这个权限」。
 *
 * 纪律同 reconcileSupplierReturnsPerms/LabDirector：只动 finance 这一角色这一键、幂等、
 * 不碰其余键、不覆盖脏值/'*'——保留库中其他有意的角色×矩阵不一致（如 finance 旧退货 R 语义）。
 * 兼容旧扁平数组（presence=W）与对象 {mod:'R'|'W'} 两形态。
 */
export function reconcileFinanceAccountReconcilePerms(database: DatabaseSync): void {
  const row = database.prepare('SELECT permissions FROM roles WHERE code = ?').get('finance') as
    | { permissions: string }
    | undefined
  if (!row) return // 行缺失 → getEffectivePermissionsForRoles 回退 SEED_MATRIX（已含 'W'），无需迁移
  let val: unknown
  try {
    val = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions
  } catch {
    return // 解析不了的脏值不动，避免覆盖
  }
  if (Array.isArray(val)) {
    if (val.includes('*') || val.includes('account_reconcile')) return
    val.push('account_reconcile')
    database.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(val), 'finance')
  } else if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>
    if (obj.account_reconcile === 'W') return
    obj.account_reconcile = 'W'
    database.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(obj), 'finance')
  }
}

const HISTORICAL_DEFAULT_USERNAMES = HISTORICAL_DEFAULT_ACCOUNTS.map(account => account.username)

/**
 * 生产级启动门禁：只核验历史上由默认种子创建的八个账号，bcrypt 工作量有明确上界。
 * status/is_deleted 旧库缺列或值为 NULL 时按活跃处理；username/password 缺列则无法安全核验，拒绝启动。
 */
export function assertNoActiveLeakedDefaultPasswords(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  const columnNames = new Set(columns.map(column => column.name))
  if (!columnNames.has('username') || !columnNames.has('password')) {
    throw new Error('[SECURITY] 拒绝启动：既有 users 表必须同时包含 username 与 password 列，无法安全核验历史账号。')
  }

  const placeholders = HISTORICAL_DEFAULT_USERNAMES.map(() => '?').join(', ')
  const conditions = [`username IN (${placeholders})`]
  if (columnNames.has('status')) conditions.push('(status IS NULL OR status <> 0)')
  if (columnNames.has('is_deleted')) conditions.push('(is_deleted IS NULL OR is_deleted <> 1)')
  const historicalUsers = database
    .prepare(`SELECT username, password FROM users WHERE ${conditions.join(' AND ')}`)
    .all(...HISTORICAL_DEFAULT_USERNAMES) as Array<{ username: string; password: string }>
  const compromisedUsernames = historicalUsers
    .filter(user => hashMatchesKnownLeakedDefaultPassword(user.password))
    .map(user => user.username)

  if (compromisedUsernames.length > 0) {
    throw new Error(
      `[SECURITY] 拒绝启动：以下活跃账号仍使用已泄露的默认口令：${compromisedUsernames.join(', ')}。` +
        '请先运行受控 reset-passwords 流程轮换这些账号；禁用或软删除账号不会触发此门禁。'
    )
  }
}

/**
 * 默认账号种子（安全止血·fail-closed，见 config/security.ts）。抽成独立可测函数。
 * - allowFixtures=true（仅显式 dev/test）：种固定口令夹具账号
 *   admin/admin123 + 5 角色/CoreOne2026! 并强制启用（E2E 依赖，行为与历史一致）。
 * - allowFixtures=false（**未声明环境=生产级**）：先核验历史八账号；不种固定口令账号、不强制启用；
 *   仅当无 admin 且提供合格的 ADMIN_INITIAL_PASSWORD 时受控创建 admin。
 */
export function seedDefaultUsers(
  database: DatabaseSync,
  opts?: { allowFixtures?: boolean; adminInitialPassword?: string }
): void {
  const allowFixtures = opts?.allowFixtures ?? allowDefaultFixtureUsers()
  const adminInitialPassword = normalizeInitialAdminPassword(
    opts?.adminInitialPassword ?? process.env.ADMIN_INITIAL_PASSWORD
  )
  if (!allowFixtures) assertNoActiveLeakedDefaultPasswords(database)
  seedDefaultUsersAfterCredentialCheck(database, allowFixtures, adminInitialPassword)
}

function seedDefaultUsersAfterCredentialCheck(
  database: DatabaseSync,
  allowFixtures: boolean,
  adminInitialPassword: string | undefined
): void {
  const existingAdmin = database.prepare('SELECT id FROM users WHERE username = ?').get('admin') as
    | { id: string }
    | undefined

  if (allowFixtures) {
    if (!existingAdmin) {
      const hashedPassword = bcrypt.hashSync('admin123', 12)
      database
        .prepare('INSERT INTO users (id, username, password, real_name, role, department, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('USER-001', 'admin', hashedPassword, '管理员', 'admin', '病理科', 1)
    }
    // 确保 admin 始终可用（防止 E2E 测试软删除后无法恢复）
    database.prepare('UPDATE users SET is_deleted = 0, status = 1 WHERE username = ?').run('admin')

    // 插入 E2E 测试所需的标准角色用户 (密码: CoreOne2026!)
    const testUsers = [
      { id: 'USER-WHM', username: 'cangguan', realName: '王仓库', role: 'warehouse_manager', department: '病理科' },
      { id: 'USER-TECH1', username: 'jishuyuan1', realName: '张技术', role: 'technician', department: '病理科' },
      { id: 'USER-DOC1', username: 'yishi1', realName: '刘医师', role: 'pathologist', department: '病理科' },
      { id: 'USER-PRO', username: 'caigou', realName: '赵采购', role: 'procurement', department: '设备科' },
      { id: 'USER-FIN', username: 'caiwu', realName: '孙财务', role: 'finance', department: '财务科' },
    ]
    const hashedTestPw = bcrypt.hashSync('CoreOne2026!', 12)
    const insertUser = database.prepare(
      'INSERT OR IGNORE INTO users (id, username, password, real_name, role, department, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (const u of testUsers) {
      insertUser.run(u.id, u.username, hashedTestPw, u.realName, u.role, u.department, 1)
    }
    // 确保 E2E 测试用户始终可用（防止被软删除后无法恢复）
    database
      .prepare("UPDATE users SET is_deleted = 0, status = 1 WHERE username IN ('cangguan','jishuyuan1','yishi1','caigou','caiwu')")
      .run()
    return
  }

  assertInitialAdminPasswordUsable(adminInitialPassword)

  // 生产级不种固定口令账号、不强制启用既有账号。
  if (!existingAdmin) {
    if (adminInitialPassword !== undefined) {
      const hashedPassword = bcrypt.hashSync(adminInitialPassword, 12)
      database
        .prepare('INSERT INTO users (id, username, password, real_name, role, department, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('USER-001', 'admin', hashedPassword, '管理员', 'admin', '病理科', 1)
      console.warn('[SECURITY] 已用 ADMIN_INITIAL_PASSWORD 创建初始 admin；请首次登录后立即改密。')
    } else {
      console.warn(
        '[SECURITY] 未声明 dev/test 的环境未创建默认 admin（无已知口令账号）。请注入合格的 ADMIN_INITIAL_PASSWORD 或通过受控方式创建管理员。'
      )
    }
  }
}

export function initializeDatabase(): void {
  const database = getDatabase()
  const allowFixtures = allowDefaultFixtureUsers()
  const adminInitialPassword = normalizeInitialAdminPassword(process.env.ADMIN_INITIAL_PASSWORD)
  // 显式提供的弱初始口令必须在任何 DDL/迁移写入前拒绝，避免失败启动留下半升级数据库。
  if (!allowFixtures) assertInitialAdminPasswordUsable(adminInitialPassword)
  const hadUsersTable = usersTableExists(database)

  // 旧库必须在任何 DDL/迁移写之前核验；新库只先创建 canonical users 表，再核验空表。
  if (hadUsersTable) {
    if (!allowFixtures) assertNoActiveLeakedDefaultPasswords(database)
  } else {
    database.exec(USERS_TABLE_SQL)
    if (!allowFixtures) assertNoActiveLeakedDefaultPasswords(database)
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS material_categories (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, parent_id TEXT, level INTEGER NOT NULL, sort_order INTEGER DEFAULT 0, status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, spec TEXT, unit TEXT NOT NULL, spec_qty DECIMAL(18, 4) DEFAULT 0, spec_unit TEXT, category_id TEXT NOT NULL, supplier_id TEXT, price DECIMAL(18, 4) DEFAULT 0, min_stock INTEGER DEFAULT 0, max_stock INTEGER DEFAULT 999999, safety_stock INTEGER DEFAULT 0, location_id TEXT, status INTEGER NOT NULL DEFAULT 1, remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, address TEXT, tax_no TEXT, bank_name TEXT, bank_account TEXT, status INTEGER NOT NULL DEFAULT 1, cooperation_count INTEGER DEFAULT 0, total_amount DECIMAL(18, 4) DEFAULT 0, rating INTEGER DEFAULT 5, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  // 合作医院(客户)主数据 —— 第三方诊断中心按医院核成本/盈利的核心维度（可经 LIS 按 code 导入/匹配）。
  // service_scope: 本中心对该医院承担的范围（technical_only=仅技术 / with_diagnosis=含诊断），决定收入取哪些组分。
  database.exec(`
    CREATE TABLE IF NOT EXISTS partners (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      short_name TEXT,
      contact TEXT, phone TEXT, address TEXT,
      contract_no TEXT,
      service_scope TEXT NOT NULL DEFAULT 'technical_only',
      status INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT, updated_by TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'shelf', parent_id TEXT, zone TEXT NOT NULL, shelf TEXT, position TEXT, capacity INTEGER DEFAULT 999999, used INTEGER DEFAULT 0, status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, material_id TEXT NOT NULL UNIQUE, stock DECIMAL(18, 4) NOT NULL DEFAULT 0, locked_stock DECIMAL(18, 4) NOT NULL DEFAULT 0, location_id TEXT, last_inbound_id TEXT, last_inbound_date TEXT, last_outbound_id TEXT, last_outbound_date TEXT, update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, material_id TEXT NOT NULL, batch_no TEXT NOT NULL, quantity DECIMAL(18, 4) NOT NULL DEFAULT 0, remaining DECIMAL(18, 4) NOT NULL DEFAULT 0, production_date TEXT, expiry_date TEXT, inbound_id TEXT NOT NULL, inbound_price DECIMAL(18, 4) DEFAULT 0, supplier_id TEXT, status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(material_id, batch_no))
  `)

  // 兼容旧数据库：移除 batches.expiry_date 的 NOT NULL 约束
  try {
    const batchCols = database.prepare("PRAGMA table_info(batches)").all() as any[]
    const expiryCol = batchCols.find(c => c.name === 'expiry_date')
    if (expiryCol && expiryCol.notnull === 1) {
      database.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE batches_new (
          id TEXT PRIMARY KEY, material_id TEXT NOT NULL, batch_no TEXT NOT NULL,
          quantity DECIMAL(18, 4) NOT NULL DEFAULT 0, remaining DECIMAL(18, 4) NOT NULL DEFAULT 0,
          production_date TEXT, expiry_date TEXT, inbound_id TEXT NOT NULL,
          inbound_price DECIMAL(18, 4) DEFAULT 0, supplier_id TEXT,
          status INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(material_id, batch_no)
        );
        INSERT INTO batches_new SELECT * FROM batches;
        DROP TABLE batches;
        ALTER TABLE batches_new RENAME TO batches;
        COMMIT;
      `)
      console.log('Migrated batches table: removed NOT NULL from expiry_date')
    }
  } catch (e: any) { console.error('Migration error for batches:', e.message) }
  database.exec(`
    CREATE TABLE IF NOT EXISTS inbound_records (id TEXT PRIMARY KEY, inbound_no TEXT NOT NULL UNIQUE, type TEXT NOT NULL, material_id TEXT NOT NULL, batch_id TEXT, batch_no TEXT, quantity DECIMAL(18, 4) NOT NULL, unit TEXT NOT NULL, price DECIMAL(18, 4) DEFAULT 0, amount DECIMAL(18, 4) DEFAULT 0, supplier_id TEXT, location_id TEXT NOT NULL, production_date TEXT, expiry_date TEXT, operator TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', remark TEXT, cancel_reason TEXT, purchase_order_id TEXT, purchase_order_no TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)

  // 兼容旧数据库：添加 purchase_order_id / purchase_order_no 字段
  try {
    const inboundCols = database.prepare("PRAGMA table_info(inbound_records)").all() as any[]
    if (!inboundCols.find(c => c.name === 'purchase_order_id')) {
      database.exec("ALTER TABLE inbound_records ADD COLUMN purchase_order_id TEXT")
    }
    if (!inboundCols.find(c => c.name === 'purchase_order_no')) {
      database.exec("ALTER TABLE inbound_records ADD COLUMN purchase_order_no TEXT")
    }
  } catch (_e) { /* ignore */ }

  // 兼容旧数据库：添加 purchase_orders.is_deleted 字段
  try {
    const poCols = database.prepare("PRAGMA table_info(purchase_orders)").all() as any[]
    if (!poCols.find(c => c.name === 'is_deleted')) {
      database.exec("ALTER TABLE purchase_orders ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
      console.log('Migrated purchase_orders table: added is_deleted column')
    }
  } catch (_e) { /* ignore */ }

  // 兼容旧数据库：添加 return_records.is_deleted 字段
  try {
    const rrCols = database.prepare("PRAGMA table_info(return_records)").all() as any[]
    if (!rrCols.find(c => c.name === 'is_deleted')) {
      database.exec("ALTER TABLE return_records ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
      console.log('Migrated return_records table: added is_deleted column')
    }
  } catch (_e) { /* ignore */ }

  // 兼容旧数据库：添加 scrap_records.is_deleted 字段
  try {
    const srCols = database.prepare("PRAGMA table_info(scrap_records)").all() as any[]
    if (!srCols.find(c => c.name === 'is_deleted')) {
      database.exec("ALTER TABLE scrap_records ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
      console.log('Migrated scrap_records table: added is_deleted column')
    }
  } catch (_e) { /* ignore */ }

  // 兼容旧数据库：添加 stocktaking_records.is_deleted / sheet_no 字段
  try {
    const stCols = database.prepare("PRAGMA table_info(stocktaking_records)").all() as any[]
    if (!stCols.find(c => c.name === 'is_deleted')) {
      database.exec("ALTER TABLE stocktaking_records ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
      console.log('Migrated stocktaking_records table: added is_deleted column')
    }
    // P1-04 批量盘点：同一次盘点的多条记录用 sheet_no 归组（单条盘点为 NULL）
    if (!stCols.find(c => c.name === 'sheet_no')) {
      database.exec("ALTER TABLE stocktaking_records ADD COLUMN sheet_no TEXT")
      console.log('Migrated stocktaking_records table: added sheet_no column')
    }
  } catch (_e) { /* ignore */ }
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbound_records (id TEXT PRIMARY KEY, outbound_no TEXT NOT NULL UNIQUE, type TEXT NOT NULL, project_id TEXT, total_cost DECIMAL(18, 4) NOT NULL DEFAULT 0, operator TEXT NOT NULL, approver TEXT, approved_at TEXT, status TEXT NOT NULL DEFAULT 'completed', remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbound_items (id TEXT PRIMARY KEY, outbound_id TEXT NOT NULL, material_id TEXT NOT NULL, batch_id TEXT, batch_no TEXT, quantity DECIMAL(18, 4) NOT NULL, unit TEXT NOT NULL, unit_cost DECIMAL(18, 4) NOT NULL, total_cost DECIMAL(18, 4) NOT NULL, usage TEXT DEFAULT 'self', receiver TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL, cycle TEXT, bom_id TEXT, supportable_samples INTEGER, manager TEXT, description TEXT, status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS boms (id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL DEFAULT 'v1.0', type TEXT NOT NULL, service_id TEXT, description TEXT, supportable_samples INTEGER, unit_cost DECIMAL(18, 4) DEFAULT 0, status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(code, version))
  `)
  // is_alternative：0=主料 / 1=辅料（通用试剂/耗材/质控），二者**同时消耗**（"都要用"），非二选一替代料。
  //   成本口径须计入辅料用量；出库时辅料缺货跳过、主料缺货阻断（见 outbound-v1.1.ts）。
  //   ⚠ 字段名 is_alternative/main_item_id 是历史误名，勿据名推断为"主料—替代料二选一"。
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_items (id TEXT PRIMARY KEY, bom_id TEXT NOT NULL, material_id TEXT NOT NULL, usage_per_sample DECIMAL(18, 4) NOT NULL, unit TEXT NOT NULL, is_alternative INTEGER NOT NULL DEFAULT 0, main_item_id TEXT, sort_order INTEGER DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(bom_id, material_id))
  `)
  // BOM 标准用量版本快照：每次合法变更（BOM 编辑 / 对账核准）落一行，保留可追溯历史 + 影响范围
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_versions (
      id TEXT PRIMARY KEY,
      bom_id TEXT NOT NULL,
      version TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      diff_summary TEXT,
      change_log TEXT,
      effective_scope TEXT NOT NULL DEFAULT 'future_only',
      impact_summary TEXT,
      changed_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bom_id, version)
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS stock_logs (id TEXT PRIMARY KEY, type TEXT NOT NULL, material_id TEXT NOT NULL, quantity DECIMAL(18, 4) NOT NULL, before_stock DECIMAL(18, 4) NOT NULL, after_stock DECIMAL(18, 4) NOT NULL, related_id TEXT, related_type TEXT, operator TEXT NOT NULL, remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  // 幂等键：入库/出库等写入提交防止网络重试/双击/代理重发造成重复入账。
  // 客户端为同一次提交动作生成稳定 key，后端对同一 key 仅入账一次，重复请求回放首次结果。
  // status_code / response_body 在写入事务内随首次成功结果一并落库（claim+finalize 同事务，保证已提交行必为完整结果）。
  database.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (idempotency_key TEXT PRIMARY KEY, scope TEXT NOT NULL, request_fingerprint TEXT NOT NULL, status_code INTEGER, response_body TEXT, operator TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, threshold INTEGER, threshold_days INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, type TEXT NOT NULL, level TEXT NOT NULL, material_id TEXT NOT NULL, material_name TEXT, current_stock INTEGER, threshold INTEGER, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', handled_by TEXT, handled_at TEXT, remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, permissions TEXT NOT NULL DEFAULT '[]', status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  // 数据驱动多角色 RBAC：一个用户可持多角色（鉴权按所有角色权限并集）
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role_code TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, role_code)
    )
  `)
  // 通用配置项（如成本可见性开关 cost_visibility_roles）
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (id TEXT PRIMARY KEY, user_id TEXT, username TEXT, operation TEXT NOT NULL, description TEXT NOT NULL, request_data TEXT, response_data TEXT, ip TEXT, user_agent TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS stocktaking_records (id TEXT PRIMARY KEY, stocktaking_no TEXT NOT NULL UNIQUE, sheet_no TEXT, material_id TEXT NOT NULL, system_stock DECIMAL(18, 4) NOT NULL, actual_stock DECIMAL(18, 4) NOT NULL, difference DECIMAL(18, 4) NOT NULL, operator TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS return_records (id TEXT PRIMARY KEY, return_no TEXT NOT NULL UNIQUE, material_id TEXT NOT NULL, batch_id TEXT, quantity DECIMAL(18, 4) NOT NULL, reason TEXT NOT NULL, operator TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS supplier_returns (
      id TEXT PRIMARY KEY,
      return_no TEXT NOT NULL UNIQUE,
      material_id TEXT NOT NULL,
      batch_id TEXT,
      batch_no TEXT,
      quantity DECIMAL(18, 4) NOT NULL,
      supplier_id TEXT,
      purchase_order_id TEXT,
      inbound_record_id TEXT,
      reason TEXT NOT NULL,
      refund_amount DECIMAL(18, 4) DEFAULT 0,
      tracking_no TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      operator TEXT NOT NULL,
      remark TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS scrap_records (id TEXT PRIMARY KEY, scrap_no TEXT NOT NULL UNIQUE, material_id TEXT NOT NULL, batch_id TEXT, quantity DECIMAL(18, 4) NOT NULL, reason TEXT NOT NULL, operator TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      material_id TEXT NOT NULL,
      material_name TEXT,
      supplier_id TEXT,
      ordered_qty DECIMAL(18, 4) NOT NULL DEFAULT 0,
      received_qty DECIMAL(18, 4) NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT '个',
      unit_price DECIMAL(18, 4) DEFAULT 0,
      total_amount DECIMAL(18, 4) DEFAULT 0,
      expected_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      remark TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )
  `)
  // batch_usage_tracking：批次「在用」台账。出库时给自用领出的批次建 in-use 记录、出库撤销时删除；
  // 入库删除/取消用它拦「该批次正在使用中、不可误删」。用户可见的「消耗对账」功能已下线（2026-07-09），
  // 但此表是出入库共用的库存完整性机制（inbound/outbound 直接读写），保留。
  // （原配套的 batch_depletion 表随功能一并删除——它此前仅被已废的 /depletion 写接口写入。）
  database.exec(`
    CREATE TABLE IF NOT EXISTS batch_usage_tracking (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      material_name TEXT,
      batch TEXT NOT NULL,
      spec TEXT,
      total_qty DECIMAL(18, 4) NOT NULL DEFAULT 0,
      remaining DECIMAL(18, 4) NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'ml',
      start_date TEXT NOT NULL,
      days_used INTEGER DEFAULT 0,
      expected_days INTEGER DEFAULT 0,
      progress INTEGER DEFAULT 0,
      usage TEXT DEFAULT 'self',
      receiver TEXT,
      status TEXT NOT NULL DEFAULT 'in-use',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  // 成本对账：LIS病例数据
  database.exec(`
    CREATE TABLE IF NOT EXISTS lis_cases (
      id TEXT PRIMARY KEY,
      -- case_no 不再全局 UNIQUE：不同医院各自编号体系会撞号；唯一性下移到复合索引 uq_lis_cases_partner_case(partner_id, case_no)。
      case_no TEXT NOT NULL,
      project_id TEXT,
      project_name TEXT,
      operator TEXT,
      operate_time TEXT,
      status TEXT NOT NULL DEFAULT 'normal',
      import_batch TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // LIS 抗体清单（每例每抗体一行）——来自「抗体清单」导出表（0702免组类），只存分析所需列，患者/医生 PII 不入。
  //   无送检医院列 → partner_id 靠病理号 join lis_cases 定位（认不出的行不落）。advice_type: 真抗体/白片/HE深切重切。
  //   幂等：按 (partner_id, case_no) 整例删插（补传=该例抗体全量刷新）。
  database.exec(`
    CREATE TABLE IF NOT EXISTS lis_case_markers (
      id TEXT PRIMARY KEY,
      case_no TEXT NOT NULL,
      partner_id TEXT,
      marker_name TEXT NOT NULL,
      advice_type TEXT,
      wax_no TEXT,
      section_no TEXT,
      import_batch TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_lis_case_markers_case ON lis_case_markers(partner_id, case_no)`)

  // 收入侧（按医院成本/盈利）：收费目录 charge_codes —— 收费引擎的计价规则源。
  // ⛔ 红线：与成本侧 fee_standards / cost-calculator 完全独立，互不读写。rule_json 持久化 ChargeRule。
  database.exec(`
    CREATE TABLE IF NOT EXISTS charge_codes (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT,
      category TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 收入侧：财务收费单据 → 逐 case 实收（W4，code-agnostic）。net_amount=开单金额(折后实收)；gross=计费金额(折前)。
  database.exec(`
    CREATE TABLE IF NOT EXISTS case_revenue (
      id TEXT PRIMARY KEY,
      case_no TEXT NOT NULL,
      partner_id TEXT,
      partner_name TEXT,
      doc_no TEXT,
      gross_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
      net_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
      discount_rate DECIMAL(10, 6) NOT NULL DEFAULT 0,
      service_month TEXT,
      line_count INTEGER NOT NULL DEFAULT 0,
      import_batch TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(partner_id, case_no, service_month)
    )
  `)
  // 原始收费明细行（code-agnostic 原样存，备 v2 编码标准化后逐码交叉核对，不依赖其语义）
  database.exec(`
    CREATE TABLE IF NOT EXISTS case_revenue_lines (
      id TEXT PRIMARY KEY,
      case_no TEXT NOT NULL,
      partner_name TEXT,
      seq INTEGER,
      specimen_name TEXT,
      charge_item TEXT,
      charge_code TEXT,
      unit_price DECIMAL(18, 4) DEFAULT 0,
      qty DECIMAL(18, 4) DEFAULT 0,
      unit TEXT,
      gross_amount DECIMAL(18, 4) DEFAULT 0,
      discount_rate DECIMAL(10, 6) DEFAULT 0,
      net_amount DECIMAL(18, 4) DEFAULT 0,
      charge_time TEXT,
      service_month TEXT,
      import_batch TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_case_revenue_partner_month ON case_revenue(partner_id, service_month)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_case_revenue_lines_case ON case_revenue_lines(case_no)`)

  // 收入侧：NGS 基因检测【外购转销】产品目录（参考价）+ 逐单（独立渠道，非 LIS/非对账单）。
  // ⛔ 红线：外包成本(协议价)=外购直接成本，独立于 ABC 内部成本引擎；与院内 charge_codes 占比估算互不读写。
  database.exec(`
    CREATE TABLE IF NOT EXISTS ngs_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL UNIQUE,
      category TEXT,
      gene_count TEXT,
      sample_type TEXT,
      clinical_meaning TEXT,
      turnaround_days INTEGER,
      guide_price DECIMAL(18, 4),
      agreement_price DECIMAL(18, 4),
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS ngs_orders (
      id TEXT PRIMARY KEY,
      order_no TEXT,
      partner_id TEXT,
      partner_name TEXT,
      product_name TEXT,
      sell_price DECIMAL(18, 4) NOT NULL DEFAULT 0,
      outsource_cost DECIMAL(18, 4) NOT NULL DEFAULT 0,
      margin DECIMAL(18, 4) NOT NULL DEFAULT 0,
      order_month TEXT,
      import_batch TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_no, product_name, order_month)
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_ngs_orders_partner_month ON ngs_orders(partner_id, order_month)`)

  // 逐院配置（单一事实源，配置驱动导入器 P0）：每院一份【版本化】配置 JSON blob（仿 bom_versions）。
  // config_json = mockup 配置对象（basic/amount/parse/lines/discount/special）。is_current=当前版；
  // is_baseline=月度导入基线。版本不可变、可回滚、可按版本追溯重算。
  database.exec(`
    CREATE TABLE IF NOT EXISTS partner_configs (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      is_baseline INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      UNIQUE(partner_id, version)
    )
  `)
  // 逐院配置变更记录：每次保存/回滚记一条「调整前→调整后」(diffs_json) + 快照(snapshot_json，回滚源)。
  database.exec(`
    CREATE TABLE IF NOT EXISTS partner_config_changes (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'edit',
      tab TEXT,
      diffs_json TEXT,
      snapshot_json TEXT,
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      changed_by TEXT,
      UNIQUE(partner_id, version)
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_partner_configs_current ON partner_configs(partner_id, is_current)`)
  // codex F3 + verify-H3：建唯一索引前先归一历史脏数据（旧库若已有同院多 current/baseline 会让建索引失败）。
  // current = 该院最高版本那行；baseline 仅保留最高版本的一条。幂等（干净库为 no-op）。
  // codex LOW-1：归一 + 两个唯一索引放进一个事务，失败整体回滚——否则可能留下「已改 is_current/is_baseline 但唯一索引未建」的半状态。
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`UPDATE partner_configs SET is_current = 0 WHERE is_current = 1 AND version <> (SELECT MAX(version) FROM partner_configs p2 WHERE p2.partner_id = partner_configs.partner_id)`)
    database.exec(`UPDATE partner_configs SET is_baseline = 0 WHERE is_baseline = 1 AND version <> (SELECT MAX(version) FROM partner_configs p2 WHERE p2.partner_id = partner_configs.partner_id AND p2.is_baseline = 1)`)
    // codex F3：同院最多一行 current / 一行 baseline（部分唯一索引，DB 级兜底非原子写/并发种子导致的多 current）
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_configs_one_current ON partner_configs(partner_id) WHERE is_current = 1`)
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_configs_one_baseline ON partner_configs(partner_id) WHERE is_baseline = 1`)
    database.exec('COMMIT')
  } catch (e) { database.exec('ROLLBACK'); throw e }

  // 成本对账：修正日志
  database.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_logs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      reason TEXT NOT NULL,
      operator TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 默认账号种子（安全止血·fail-closed）：仅显式 dev/test 才种
  // 固定口令夹具账号并强制启用；**未声明环境=生产级=不种默认凭据、不强制启用**（见 seedDefaultUsers）。
  // 上面已完成唯一一次生产 bcrypt 预检；此处直接进入种子逻辑，避免重复扫描。
  seedDefaultUsersAfterCredentialCheck(
    database,
    allowFixtures,
    adminInitialPassword
  )

  // 插入默认角色（E2E 测试依赖）+ 数据驱动 RBAC 初始种子矩阵（RBAC §8.2）
  const defaultRoles = [
    { id: 'ROLE-ADMIN', code: 'admin', name: '管理员', description: '系统管理员，拥有全部权限' },
    { id: 'ROLE-DIR', code: 'lab_director', name: '实验室主任', description: '运营总览（含成本），跨线审批' },
    { id: 'ROLE-WHM', code: 'warehouse_manager', name: '仓库管理员', description: '负责库存、入库、出库、盘点管理' },
    { id: 'ROLE-TECH', code: 'technician', name: '技术员', description: '负责出库消耗、盘点、消耗对账录入、QC' },
    { id: 'ROLE-DOC', code: 'pathologist', name: '病理医师', description: '诊断线：检测项目、BOM 只读，无成本权限' },
    { id: 'ROLE-PRO', code: 'procurement', name: '采购员', description: '负责采购、供应商管理' },
    { id: 'ROLE-FIN', code: 'finance', name: '财务', description: '成本/盈利唯一 owner，对账核准' },
  ]
  // 种子权限：admin→'["*"]'；其余→SEED_MATRIX 对象（数据驱动单一事实源）
  const seedPermsFor = (code: string): string =>
    code === 'admin' ? '["*"]' : JSON.stringify(SEED_MATRIX[code] || {})
  const insertRole = database.prepare(
    'INSERT OR IGNORE INTO roles (id, code, name, description, permissions, status) VALUES (?, ?, ?, ?, ?, ?)'
  )
  // 旧库遗留 '[]' 空权限的种子角色一次性回填为矩阵（不覆盖管理员已编辑的非空值）
  const backfillRolePerms = database.prepare(
    "UPDATE roles SET permissions = ? WHERE code = ? AND (permissions = '[]' OR permissions = '' OR permissions IS NULL)"
  )
  for (const r of defaultRoles) {
    insertRole.run(r.id, r.code, r.name, r.description, seedPermsFor(r.code), 1)
    backfillRolePerms.run(seedPermsFor(r.code), r.code)
  }
  // 聚焦迁移：补齐 仓管/采购 的 supplier_returns（既有库新增模块缺口，详见函数注释）
  reconcileSupplierReturnsPerms(database)
  // 聚焦迁移：补齐 主任 的 退库/盘点 W（2026-07-06 PM 口径 R→W；既有库 lab_director 行 shadow 矩阵，详见函数注释）
  reconcileLabDirectorInventoryPerms(database)
  // 聚焦迁移：补齐 财务 的 account_reconcile W（PR #94 SoD 需第二签发人；既有库 finance 行 shadow 矩阵，详见函数注释）
  reconcileFinanceAccountReconcilePerms(database)

  // 成本可见性开关默认（可在「角色权限/设置」改）
  database.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('cost_visibility_roles', ?)")
    .run(JSON.stringify(['finance', 'lab_director', 'admin']))
  // 注：user_roles + primary_role 回填见 ensureColumn('users','primary_role') 之后（列须先存在）

  // 插入默认预警规则
  const countRules = database.prepare('SELECT COUNT(*) as count FROM alert_rules').get() as any
  if (!countRules || countRules.count === 0) {
    database.prepare(`
      INSERT INTO alert_rules (id, type, name, threshold, threshold_days, enabled)
      VALUES ('RULE-001', 'low-stock', '低库存预警', 5, NULL, 1),
             ('RULE-002', 'expiry', '有效期预警', NULL, 30, 1),
             ('RULE-003', 'stagnant', '呆滞库存预警', 90, NULL, 1)
    `).run()
  }

  // ===========================================================================
  // ABC 成本核算 schema（纯增量，从 codex/abc-productization-phase0-1 移植）
  // 仅 ADD：master 既有表/列不动。所有 CREATE TABLE 用 IF NOT EXISTS，列用 ensureColumn 幂等补齐。
  // ===========================================================================
  const ensureColumn = (table: string, column: string, definition: string): void => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  // ===========================================================================
  // Lane C「修流程」— 退库/报废/调拨（本波唯一动 schema 的线；纯增量，不改既有列）
  // ===========================================================================
  // 调拨（inbound_records type='transfer'）持久化来源库位：撤销时还原库位 + 列表展示"来源→目标"
  ensureColumn('inbound_records', 'from_location_id', 'TEXT')
  // 兜底 is_deleted：return_records/scrap_records 的 CREATE 不含该列，其"补列迁移"却排在 CREATE 之前
  // → 全新库（如 :memory: 测试）里迁移空跑、列缺失。ensureColumn 在建表之后跑，幂等补齐（生产已有则 no-op）。
  ensureColumn('return_records', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('scrap_records', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0')
  // 退库/报废列表默认按时间倒序、并支持时间排序 → 建 created_at 索引（幂等）
  database.exec(`CREATE INDEX IF NOT EXISTS idx_return_records_created ON return_records(created_at)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_scrap_records_created ON scrap_records(created_at)`)

  // P-3 拒绝写审计（SEC-3）：operation_logs 增一个可空 outcome 列区分成功/拒绝/聚合/告警行。
  //   NULL = 成功写（既有行 + 新成功行天然 NULL，现有 /logs 视图零回归）；
  //   'denied' = 被拒写逐条明细；'denied_agg' = 超阈聚合计数行；'security_alert' = 越权探测告警行。
  //   纯增量、不改既有列（符合「DatabaseManager 只追加」）。判别用 typed 列而非 operation 字符串前缀。
  ensureColumn('operation_logs', 'outcome', 'TEXT')

  // 多角色 RBAC：用户主身份角色（展示用；权限走 user_roles 并集）
  ensureColumn('users', 'primary_role', 'TEXT')

  // 回填 user_roles：存量单角色用户 → user_roles(单角色) + primary_role（幂等；须在 primary_role 列建好后）
  {
    const allUsers = database.prepare('SELECT id, role FROM users WHERE is_deleted = 0').all() as Array<{ id: string; role: string }>
    const insertUserRole = database.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
    const setPrimary = database.prepare("UPDATE users SET primary_role = ? WHERE id = ? AND (primary_role IS NULL OR primary_role = '')")
    for (const u of allUsers) {
      if (!u.role) continue
      insertUserRole.run(`UR-${u.id}-${u.role}`, u.id, u.role)
      setPrimary.run(u.role, u.id)
    }
  }

  // —— 对账 propose→approve 工作流列（reconciliation_logs 既有为事后审计，补待审/审核留痕）——
  // 提案信息（material_id/project_id/proposed_usage）须持久化，审批时才能重放写回 BOM
  ensureColumn('reconciliation_logs', 'status', "TEXT NOT NULL DEFAULT 'pending'") // pending|approved|rejected|applied
  ensureColumn('reconciliation_logs', 'reviewed_by', 'TEXT')
  ensureColumn('reconciliation_logs', 'reviewed_at', 'DATETIME')
  ensureColumn('reconciliation_logs', 'applied_bom_id', 'TEXT')
  ensureColumn('reconciliation_logs', 'proposed_usage', 'DECIMAL(18, 4)')
  ensureColumn('reconciliation_logs', 'material_id', 'TEXT')
  ensureColumn('reconciliation_logs', 'project_id', 'TEXT')

  // —— 设备 / 设备模板 / 设备用量 / 标准工时 ——
  database.exec(`
    CREATE TABLE IF NOT EXISTS equipment_types (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      default_purchase_price DECIMAL(18, 4) DEFAULT 0,
      default_depreciable_life_years INTEGER DEFAULT 5,
      default_residual_value DECIMAL(18, 4) DEFAULT 0,
      default_depreciation_method TEXT DEFAULT 'straight_line',
      default_total_capacity DECIMAL(18, 4) DEFAULT 0,
      default_capacity_unit TEXT DEFAULT 'minutes',
      default_activity_center_id TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS equipment (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      model TEXT,
      manufacturer TEXT,
      purchase_price DECIMAL(18, 4) DEFAULT 0,
      purchase_date TEXT,
      depreciable_life_years INTEGER DEFAULT 5,
      residual_value DECIMAL(18, 4) DEFAULT 0,
      depreciation_method TEXT DEFAULT 'straight_line',
      total_capacity DECIMAL(18, 4) DEFAULT 0,
      capacity_unit TEXT DEFAULT 'minutes',
      status INTEGER NOT NULL DEFAULT 1,
      location_id TEXT,
      type_id TEXT,
      activity_center_id TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS equipment_usage (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL,
      project_id TEXT,
      outbound_id TEXT,
      usage_minutes DECIMAL(18, 4) DEFAULT 0,
      usage_count DECIMAL(18, 4) DEFAULT 0,
      depreciation_cost DECIMAL(18, 4) DEFAULT 0,
      operator TEXT,
      usage_date TEXT,
      activity_center_id TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS standard_labor_times (
      id TEXT PRIMARY KEY,
      step_code TEXT NOT NULL,
      step_name TEXT NOT NULL,
      project_type TEXT NOT NULL DEFAULT 'all',
      standard_minutes DECIMAL(18, 4) NOT NULL DEFAULT 0,
      labor_rate_per_minute DECIMAL(18, 4) DEFAULT 0,
      is_equipment_step INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      reference_source TEXT DEFAULT 'system',
      activity_center_id TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(step_code, project_type)
    )
  `)
  ensureColumn('equipment_types', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('equipment', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('standard_labor_times', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0')
  // L2-1 成本来源 → 作业中心映射（动因优先的物理前提；NULL=未映射，引擎按继承/约定回退或登记异常）
  ensureColumn('equipment_types', 'default_activity_center_id', 'TEXT')
  ensureColumn('equipment', 'activity_center_id', 'TEXT')
  ensureColumn('equipment_usage', 'activity_center_id', 'TEXT')
  ensureColumn('standard_labor_times', 'activity_center_id', 'TEXT')

  // —— 间接成本中心 / 月度分摊 / 季度调整 / 单一披露基准 ——
  database.exec(`
    CREATE TABLE IF NOT EXISTS indirect_cost_centers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      cost_type TEXT NOT NULL DEFAULT 'other',
      monthly_amount DECIMAL(18, 4) DEFAULT 0,
      allocation_base TEXT DEFAULT 'sample_count',
      direct_activity_center_id TEXT,
      description TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS indirect_cost_allocations (
      id TEXT PRIMARY KEY,
      cost_center_id TEXT NOT NULL,
      year_month TEXT NOT NULL,
      total_amount DECIMAL(18, 4) DEFAULT 0,
      allocation_base_value DECIMAL(18, 4) DEFAULT 1,
      allocation_rate DECIMAL(18, 8) DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cost_center_id, year_month)
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS cost_adjustments (
      id TEXT PRIMARY KEY,
      cost_center_id TEXT NOT NULL,
      year_quarter TEXT NOT NULL,
      pre_provision_amount DECIMAL(18, 4) DEFAULT 0,
      actual_amount DECIMAL(18, 4) DEFAULT 0,
      adjustment_amount DECIMAL(18, 4) DEFAULT 0,
      adjustment_reason TEXT,
      submitted_by TEXT,
      submitted_at DATETIME,
      review_status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at DATETIME,
      review_reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  ensureColumn('indirect_cost_centers', 'direct_activity_center_id', 'TEXT')
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_indirect_disclosure (
      id TEXT PRIMARY KEY,
      year_month TEXT NOT NULL,
      basis TEXT NOT NULL DEFAULT 'by_direct_cost',
      total_indirect DECIMAL(18, 4) DEFAULT 0,
      note TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(year_month)
    )
  `)

  // —— BOM 扩展成本结构（标准成本快照 + 收费映射锚点）——
  ensureColumn('boms', 'fee_standard_id', 'TEXT')
  ensureColumn('boms', 'fee_category', 'TEXT')
  // @deprecated（项F 绿档2）：以下 7 个 standard_*_cost 列全仓无非零写入（恒 0 噪声），
  //   已从 bom_versions 快照 SELECT/对象移除，无任何消费者。保留列定义（不 drop，避免破坏性迁移），
  //   但**勿再读写**——是假数据入口。真实成本走 outbound_items.unit_cost / ABC 成本池 / 逐抗体成本，非这些列。
  ensureColumn('boms', 'standard_labor_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('boms', 'standard_equipment_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('boms', 'standard_indirect_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('boms', 'standard_total_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('boms', 'standard_slide_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('boms', 'standard_fee_per_slide', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('boms', 'standard_margin_rate', 'DECIMAL(18, 6) DEFAULT 0')
  // L2-5 标准作业成本：getDriverRate 末级回退读取 b.standard_activity_cost
  ensureColumn('boms', 'standard_activity_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('bom_items', 'group_name', 'TEXT')
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_general_reagents (
      id TEXT PRIMARY KEY,
      bom_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      usage_per_sample DECIMAL(18, 4) DEFAULT 0,
      unit TEXT,
      allocation_type TEXT DEFAULT 'per_sample',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_general_consumables (
      id TEXT PRIMARY KEY,
      bom_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      usage_per_sample DECIMAL(18, 4) DEFAULT 0,
      unit TEXT,
      allocation_type TEXT DEFAULT 'per_sample',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_quality_controls (
      id TEXT PRIMARY KEY,
      bom_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      usage_per_batch DECIMAL(18, 4) DEFAULT 0,
      unit TEXT,
      covers_samples INTEGER DEFAULT 1,
      allocation_type TEXT DEFAULT 'per_batch',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_equipment_templates (
      id TEXT PRIMARY KEY,
      bom_id TEXT NOT NULL,
      equipment_id TEXT,
      equipment_type_id TEXT,
      usage_minutes DECIMAL(18, 4) DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // —— ABC 出库快照列（纯增量，挂在 master outbound_records 上）——
  ensureColumn('outbound_records', 'sample_count', 'INTEGER DEFAULT 1')
  ensureColumn('outbound_records', 'abc_total_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('outbound_records', 'abc_activity_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('outbound_records', 'fee_amount', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('outbound_records', 'profit', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('outbound_records', 'cost_status', "TEXT NOT NULL DEFAULT 'pending_cost'")
  ensureColumn('outbound_records', 'case_no', 'TEXT')

  // —— ABC 作业中心 / 动因 / 成本池 / BOM 作业关联 ——
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_activity_centers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      cost_driver_type TEXT DEFAULT 'slide_count',
      parent_id TEXT,
      sort_order INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_cost_drivers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      unit TEXT,
      calculation_method TEXT DEFAULT 'linear',
      tier_rules TEXT,
      description TEXT,
      driver_source_column TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_cost_pools (
      id TEXT PRIMARY KEY,
      activity_center_id TEXT,
      year_month TEXT NOT NULL,
      direct_cost DECIMAL(18, 4) DEFAULT 0,
      indirect_cost DECIMAL(18, 4) DEFAULT 0,
      total_cost DECIMAL(18, 4) DEFAULT 0,
      driver_quantity DECIMAL(18, 4) DEFAULT 0,
      driver_rate DECIMAL(18, 4) DEFAULT 0,
      amount DECIMAL(18, 4) DEFAULT 0,
      source TEXT DEFAULT 'manual',
      description TEXT,
      adjustment_reason TEXT,
      source_document_no TEXT,
      attachment_url TEXT,
      linked_adjustment_id TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_activity_links (
      id TEXT PRIMARY KEY,
      bom_id TEXT NOT NULL,
      activity_center_id TEXT NOT NULL,
      quantity DECIMAL(18, 4) DEFAULT 0,
      unit TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS fee_standards (
      id TEXT PRIMARY KEY,
      code TEXT,
      name TEXT NOT NULL,
      category TEXT,
      project_type TEXT,
      fee_per_slide DECIMAL(18, 4) DEFAULT 0,
      base_price DECIMAL(18, 4) DEFAULT 0,
      tier_rules TEXT,
      cap_amount DECIMAL(18, 4),
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_fee_mappings (
      id TEXT PRIMARY KEY,
      bom_id TEXT NOT NULL,
      fee_standard_id TEXT NOT NULL,
      quantity_multiplier DECIMAL(18, 4) DEFAULT 1,
      aggregation_scope TEXT NOT NULL DEFAULT 'outbound',
      sort_order INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bom_id, fee_standard_id, aggregation_scope)
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS case_charge_groups (
      id TEXT PRIMARY KEY,
      case_no TEXT NOT NULL,
      year_month TEXT NOT NULL,
      fee_standard_id TEXT NOT NULL,
      total_quantity DECIMAL(18, 4) DEFAULT 0,
      total_fee DECIMAL(18, 4) DEFAULT 0,
      outbound_count INTEGER DEFAULT 0,
      rule_snapshot TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(case_no, year_month, fee_standard_id)
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbound_abc_details (
      id TEXT PRIMARY KEY,
      outbound_id TEXT NOT NULL,
      bom_id TEXT,
      project_id TEXT,
      sample_count INTEGER DEFAULT 0,
      slide_count INTEGER DEFAULT 0,
      block_count INTEGER DEFAULT 0,
      material_cost DECIMAL(18, 4) DEFAULT 0,
      activity_cost DECIMAL(18, 4) DEFAULT 0,
      total_cost DECIMAL(18, 4) DEFAULT 0,
      cost_per_slide DECIMAL(18, 4) DEFAULT 0,
      fee_category TEXT,
      fee_standard_id TEXT,
      fee_amount DECIMAL(18, 4) DEFAULT 0,
      profit DECIMAL(18, 4) DEFAULT 0,
      profit_rate DECIMAL(18, 6) DEFAULT 0,
      activity_details TEXT,
      cost_month TEXT,
      cost_status TEXT NOT NULL DEFAULT 'costed',
      cost_run_id TEXT,
      case_no TEXT,
      charge_group_id TEXT,
      calculation_version TEXT NOT NULL DEFAULT 'v1',
      source_snapshot TEXT,
      case_count INTEGER DEFAULT 0,
      bom_version_id TEXT,
      activity_detail_version INTEGER NOT NULL DEFAULT 2,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS cost_exceptions (
      id TEXT PRIMARY KEY,
      exception_no TEXT NOT NULL UNIQUE,
      source_module TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      project_id TEXT,
      bom_id TEXT,
      outbound_id TEXT,
      year_month TEXT,
      exception_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      status TEXT NOT NULL DEFAULT 'open',
      message TEXT NOT NULL,
      details TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      resolved_by TEXT,
      resolved_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_cost_exceptions_status ON cost_exceptions(status)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_cost_exceptions_source ON cost_exceptions(source_module, source_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_cost_exceptions_period ON cost_exceptions(year_month)`)
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_periods (
      id TEXT PRIMARY KEY,
      year_month TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open',
      started_at DATETIME,
      calculated_at DATETIME,
      reviewed_at DATETIME,
      closed_at DATETIME,
      closed_by TEXT,
      remark TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS cost_runs (
      id TEXT PRIMARY KEY,
      year_month TEXT NOT NULL,
      run_type TEXT NOT NULL DEFAULT 'recalculate',
      status TEXT NOT NULL DEFAULT 'pending',
      started_by TEXT,
      started_at DATETIME,
      finished_at DATETIME,
      summary TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_cost_runs_period ON cost_runs(year_month)`)
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_cost_adjustments (
      id TEXT PRIMARY KEY,
      adjustment_no TEXT NOT NULL UNIQUE,
      year_month TEXT NOT NULL,
      adjustment_type TEXT NOT NULL DEFAULT 'manual',
      amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      source_module TEXT,
      source_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_by TEXT,
      submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by TEXT,
      reviewed_at DATETIME,
      review_remark TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_abc_cost_adjustments_period ON abc_cost_adjustments(year_month, status)`)
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_budgets (
      id TEXT PRIMARY KEY,
      year_month TEXT NOT NULL,
      category TEXT,
      budget_amount DECIMAL(18, 4) DEFAULT 0,
      actual_amount DECIMAL(18, 4) DEFAULT 0,
      description TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS quality_costs (
      id TEXT PRIMARY KEY,
      year_month TEXT NOT NULL,
      category TEXT,
      cost_type TEXT,
      sub_type TEXT,
      amount DECIMAL(18, 4) DEFAULT 0,
      description TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  ensureColumn('quality_costs', 'cost_type', 'TEXT')
  ensureColumn('quality_costs', 'sub_type', 'TEXT')
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_audit_logs (
      id TEXT PRIMARY KEY,
      module TEXT,
      action TEXT NOT NULL,
      target_id TEXT,
      detail TEXT,
      operator TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  // 统一旁路台账（项⑦）：E/A/B/D 各道闸的人工旁路/软兜底汇入此表，供「旁路使用频率」体检。
  //   gate_type=import_confirm(B)/ledger_drift_fallback(A)/supplement_approve(D)；reason 应用层强制非空。
  database.exec(`
    CREATE TABLE IF NOT EXISTS override_log (
      id TEXT PRIMARY KEY,
      gate_type TEXT NOT NULL,
      module TEXT NOT NULL,
      target_id TEXT,
      operator TEXT NOT NULL,
      reason TEXT NOT NULL,
      before_snapshot TEXT,
      after_snapshot TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_override_log_gate ON override_log(gate_type, created_at)`)
  database.exec(`
    CREATE TABLE IF NOT EXISTS abc_alert_rules (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      threshold DECIMAL(18, 4) DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  // ── Phase 0 逐抗体成本地基（账实复核+逐抗体成本，设计基线 §1.3）──
  //   antibodies: 抗体库主数据 + 每片一抗成本（per_test_price = 台账已换算每人份价，勿再除换算率）；UNIQUE(name,form) 区分原液/即用。
  //   detection_systems: 二抗/显色/辅料 单独共享项（上机二抗测试条 ~¥15/片）。
  //   ihc_cost_params: 「算全」的二抗/工时/设备参数（工时/设备=G2 估·弱锚·待校准 B4，可配）。
  //   special_stain_kits: 特染盒（盒价÷标称次数）。
  database.exec(`
    CREATE TABLE IF NOT EXISTS antibodies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      clone_no TEXT,
      supplier TEXT,
      category TEXT NOT NULL DEFAULT '一抗',
      form TEXT,
      spec TEXT,
      bottle_price DECIMAL(18, 4) DEFAULT 0,
      bottle_price_taxed DECIMAL(18, 4),
      conv_rate DECIMAL(18, 4),
      per_test_price DECIMAL(18, 6),
      dilution TEXT,
      usage_per_slide DECIMAL(18, 4),
      price_status TEXT NOT NULL DEFAULT 'has_price',
      source_ledger TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      updated_by TEXT,
      UNIQUE(name, form)
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS detection_systems (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'secondary',
      form TEXT,
      spec TEXT,
      bottle_price DECIMAL(18, 4),
      conv_rate DECIMAL(18, 4),
      per_slide_cost DECIMAL(18, 6),
      is_default INTEGER NOT NULL DEFAULT 0,
      source_ledger TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS ihc_cost_params (
      id TEXT PRIMARY KEY,
      param_key TEXT NOT NULL UNIQUE,
      value DECIMAL(18, 4) NOT NULL DEFAULT 0,
      source TEXT,
      confidence TEXT,
      remark TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS special_stain_kits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kit_price DECIMAL(18, 4) NOT NULL DEFAULT 0,
      nominal_tests INTEGER NOT NULL DEFAULT 0,
      actual_yield INTEGER,
      labor_per_test DECIMAL(18, 4) DEFAULT 0,
      remark TEXT,
      source_ledger TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  // antibody_aliases: LIS 抗体名 → 台账规范名 别名表（A1+A3 名称映射）。
  //   代码规范化(去连字符/空格/大小写)自动对上大多数写法差异；此表存**规范化也撞不到的生物学同义词**（Ecad→E-cadherin 等），
  //   ops 可继续加新别名（无需改代码发版）。lis_name UNIQUE，幂等 INSERT OR IGNORE。
  database.exec(`
    CREATE TABLE IF NOT EXISTS antibody_aliases (
      id TEXT PRIMARY KEY,
      lis_name TEXT NOT NULL UNIQUE,
      canonical_name TEXT NOT NULL,
      note TEXT,
      source TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_antibodies_name ON antibodies(name)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_antibodies_category ON antibodies(category)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_antibody_aliases_lis ON antibody_aliases(lis_name)`)
  // ── Phase 1 账实核对引擎（设计基线 §1.4/§1.5）──
  //   reconcile_hospital_months: 院·月复核状态机（待复核→复核完成→已关账；匹配率/院名对齐/关账留痕）。
  //   reconcile_diffs: 逐差异（账单片数 vs LIS 物理片数·¥影响·系统初判·6 认定原因·经手人）。
  //   supplement_orders: 补收单（待补收→已补收/已放弃；仅「漏收，需补收」驱动；已补收计入本月实收）。
  database.exec(`
    CREATE TABLE IF NOT EXISTS reconcile_hospital_months (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      partner_name TEXT,
      service_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '待复核',
      name_aligned INTEGER NOT NULL DEFAULT 0,
      match_rate DECIMAL(10, 6) DEFAULT 0,
      match_status TEXT,
      statement_ready INTEGER NOT NULL DEFAULT 0,
      lis_ready INTEGER NOT NULL DEFAULT 0,
      diff_count INTEGER NOT NULL DEFAULT 0,
      pending_count INTEGER NOT NULL DEFAULT 0,
      unmatched_count INTEGER NOT NULL DEFAULT 0,
      confirmed_lab_revenue DECIMAL(18, 4),
      computed_at DATETIME,
      completed_at DATETIME,
      completed_by TEXT,
      closed_at DATETIME,
      closed_by TEXT,
      reopened_at DATETIME,
      reopen_reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(partner_id, service_month)
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS reconcile_diffs (
      id TEXT PRIMARY KEY,
      hospital_month_id TEXT NOT NULL,
      partner_id TEXT NOT NULL,
      service_month TEXT NOT NULL,
      case_no TEXT NOT NULL,
      line_type TEXT NOT NULL,
      bill_count DECIMAL(18, 4) NOT NULL DEFAULT 0,
      lis_count DECIMAL(18, 4) NOT NULL DEFAULT 0,
      delta DECIMAL(18, 4) NOT NULL DEFAULT 0,
      amount_impact DECIMAL(18, 4) NOT NULL DEFAULT 0,
      system_hint TEXT,
      low_confidence INTEGER NOT NULL DEFAULT 0,
      verdict TEXT,
      verdict_reason TEXT,
      verdict_by TEXT,
      verdict_at DATETIME,
      follow_up TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS supplement_orders (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      service_month TEXT NOT NULL,
      source_diff_id TEXT,
      case_no TEXT,
      amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
      case_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT '待补收',
      collected_at DATETIME,
      collected_month TEXT,
      collected_revenue DECIMAL(18, 4),
      give_up_reason TEXT,
      operator TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_recon_hm_partner_month ON reconcile_hospital_months(partner_id, service_month)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_recon_diffs_hm ON reconcile_diffs(hospital_month_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_recon_diffs_partner_month ON reconcile_diffs(partner_id, service_month)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_supplement_partner_month ON supplement_orders(partner_id, service_month)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_supplement_status ON supplement_orders(status)`)
  // ③ 逐抗体细粒度初判线索（返工/多病灶）——与 reconcile_diffs 平行的附加线索表，读 lis_case_markers 派生；不改差异计数口径。
  database.exec(`
    CREATE TABLE IF NOT EXISTS reconcile_case_hints (
      id TEXT PRIMARY KEY,
      hospital_month_id TEXT NOT NULL,
      partner_id TEXT NOT NULL,
      service_month TEXT NOT NULL,
      case_no TEXT NOT NULL,
      hint_type TEXT NOT NULL,
      marker_name TEXT,
      wax_no TEXT,
      occurrences INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_recon_hints_hm ON reconcile_case_hints(hospital_month_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_recon_hints_case ON reconcile_case_hints(hospital_month_id, case_no)`)
  // 幂等补列（旧库迁移 + :memory: 新库统一）
  ensureColumn('supplement_orders', 'collected_revenue', 'DECIMAL(18, 4)')
  // 账实核对补收单 maker-checker（非-P0 审计项 D 止血）：认定人只能提交「待复核」补收单，须独立签发人 approve 后才可收款。
  // 旧库既有补收单 ALTER 后默认 pending_review（连历史单也须过人闸再收，符合止血意图）。
  ensureColumn('supplement_orders', 'review_status', "TEXT NOT NULL DEFAULT 'pending_review'") // pending_review|approved
  ensureColumn('supplement_orders', 'submitted_by', 'TEXT')
  ensureColumn('supplement_orders', 'reviewed_by', 'TEXT')
  ensureColumn('supplement_orders', 'reviewed_at', 'DATETIME')
  ensureColumn('fee_standards', 'project_type', 'TEXT')
  ensureColumn('fee_standards', 'fee_per_slide', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('fee_standards', 'base_price', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('fee_standards', 'tier_rules', 'TEXT')
  ensureColumn('fee_standards', 'cap_amount', 'DECIMAL(18, 4)')
  ensureColumn('bom_fee_mappings', 'quantity_multiplier', 'DECIMAL(18, 4) DEFAULT 1')
  ensureColumn('bom_fee_mappings', 'aggregation_scope', "TEXT NOT NULL DEFAULT 'outbound'")
  ensureColumn('case_charge_groups', 'rule_snapshot', 'TEXT')
  ensureColumn('abc_cost_pools', 'direct_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('abc_cost_pools', 'indirect_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('abc_cost_pools', 'total_cost', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('abc_cost_pools', 'driver_quantity', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('abc_cost_pools', 'driver_rate', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('abc_cost_pools', 'amount', 'DECIMAL(18, 4) DEFAULT 0')
  ensureColumn('abc_cost_pools', 'source', "TEXT DEFAULT 'manual'")
  ensureColumn('abc_cost_pools', 'description', 'TEXT')
  ensureColumn('abc_cost_pools', 'adjustment_reason', 'TEXT')
  ensureColumn('abc_cost_pools', 'source_document_no', 'TEXT')
  ensureColumn('abc_cost_pools', 'attachment_url', 'TEXT')
  ensureColumn('abc_cost_pools', 'linked_adjustment_id', 'TEXT')
  ensureColumn('abc_cost_pools', 'updated_at', 'DATETIME')
  // L2-2 动因量数据驱动：动因 code → outbound_abc_details 计量列
  ensureColumn('abc_cost_drivers', 'driver_source_column', 'TEXT')
  ensureColumn('outbound_abc_details', 'case_count', 'INTEGER DEFAULT 0')
  ensureColumn('outbound_abc_details', 'bom_version_id', 'TEXT')
  ensureColumn('outbound_abc_details', 'activity_detail_version', 'INTEGER NOT NULL DEFAULT 2')
  ensureColumn('outbound_abc_details', 'cost_status', "TEXT NOT NULL DEFAULT 'costed'")
  ensureColumn('outbound_abc_details', 'cost_run_id', 'TEXT')
  ensureColumn('outbound_abc_details', 'case_no', 'TEXT')
  ensureColumn('outbound_abc_details', 'charge_group_id', 'TEXT')
  ensureColumn('outbound_abc_details', 'calculation_version', "TEXT NOT NULL DEFAULT 'v1'")
  // C1 batch manifest 以 import_batch 建版本化证据与复合索引；历史库可能早于该列，
  // 必须先补列再执行 case_revenue/lis_cases 重建和周期证据索引初始化。
  ensureColumn('case_revenue', 'import_batch', 'TEXT')
  ensureColumn('lis_cases', 'import_batch', 'TEXT')
  ensureColumn('lis_case_markers', 'import_batch', 'TEXT')
  // 配置驱动导入器 P0：每期导入记下所用逐院配置版本 → 改规则后判影响面 + 追溯重算锚。
  ensureColumn('case_revenue', 'config_version', 'INTEGER')
  // P5 收入侧：配置驱动导入(/commit)落库时写【实验室收入=Σ(IN结算)】+移出额+来源。
  //   lab_revenue NULL = 非配置驱动(走估算 实收×占比)；非 NULL = 已对账(statement 权威)。revenue_source: statement/estimated/corrected。
  ensureColumn('case_revenue', 'lab_revenue', 'DECIMAL(18, 4)')
  ensureColumn('case_revenue', 'out_revenue', 'DECIMAL(18, 4) NOT NULL DEFAULT 0')
  // Phase 2 纯实验室拆分：诊断桶（报告/现场/split 诊断份额）——我们的钱但非实验室工序，既不进 lab 也不进 out。
  //   逐病例守恒：net_amount = lab_revenue + diagnosis_revenue + out_revenue。默认 0（旧配置全 in/out → 恒 0，零回归）。
  ensureColumn('case_revenue', 'diagnosis_revenue', 'DECIMAL(18, 4) NOT NULL DEFAULT 0')
  ensureColumn('case_revenue', 'revenue_source', 'TEXT')
  // confirm 强制落库时，带病理号的 未匹配/歧义 行 settle 计入 net 却不进任何桶 → 无桶孤儿额。
  //   显式承接，维持逐病例守恒：net_amount = lab_revenue + diagnosis_revenue + out_revenue + unallocated_amount。默认 0（识别率 100% 时恒 0，零回归）。
  ensureColumn('case_revenue', 'unallocated_amount', 'DECIMAL(18, 4) NOT NULL DEFAULT 0')
  // PRD-0 T3：NGS 缺外包成本时落库但标记未核（cost_confirmed=0）→ 院级 P&L 不计入正常毛利、单列「未核 NGS 毛利」，不按 0 成本污染。默认 1（既有数据视为已核，向后兼容）。
  ensureColumn('ngs_orders', 'cost_confirmed', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('case_revenue_lines', 'scope', 'TEXT') // in/out/unmatched/ambiguous（逐行分类留痕）
  // codex CRITICAL：收入归属于医院，明细行也需 partner_id（删插与查询都按院隔离，防跨院同号串账）。
  ensureColumn('case_revenue_lines', 'partner_id', 'TEXT')
  // codex CRITICAL：case_revenue 旧唯一键 (case_no, service_month) 缺 partner_id → 不同医院同月同本地病理号会串账覆盖。
  //   迁移唯一键为 (partner_id, case_no, service_month)；SQLite 表级 UNIQUE 不能 ALTER，须整表重建（事务内，幂等）。
  {
    const cr = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='case_revenue'").get() as { sql?: string } | undefined
    if (cr?.sql && /UNIQUE\s*\(\s*case_no\s*,\s*service_month\s*\)/i.test(cr.sql)) {
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec(`
          CREATE TABLE case_revenue__new (
            id TEXT PRIMARY KEY,
            case_no TEXT NOT NULL,
            partner_id TEXT,
            partner_name TEXT,
            doc_no TEXT,
            gross_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
            net_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
            discount_rate DECIMAL(10, 6) NOT NULL DEFAULT 0,
            service_month TEXT,
            line_count INTEGER NOT NULL DEFAULT 0,
            import_batch TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            config_version INTEGER,
            lab_revenue DECIMAL(18, 4),
            out_revenue DECIMAL(18, 4) NOT NULL DEFAULT 0,
            revenue_source TEXT,
            UNIQUE(partner_id, case_no, service_month)
          )
        `)
        database.exec(`
          INSERT INTO case_revenue__new (id, case_no, partner_id, partner_name, doc_no, gross_amount, net_amount, discount_rate, service_month, line_count, import_batch, created_at, updated_at, config_version, lab_revenue, out_revenue, revenue_source)
          SELECT id, case_no, partner_id, partner_name, doc_no, gross_amount, net_amount, discount_rate, service_month, line_count, import_batch, created_at, updated_at, config_version, lab_revenue, out_revenue, revenue_source FROM case_revenue
        `)
        database.exec('DROP TABLE case_revenue')
        database.exec('ALTER TABLE case_revenue__new RENAME TO case_revenue')
        database.exec(`CREATE INDEX IF NOT EXISTS idx_case_revenue_partner_month ON case_revenue(partner_id, service_month)`)
        database.exec('COMMIT')
      } catch (e) { database.exec('ROLLBACK'); throw e }
    }
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_case_revenue_lines_partner_case_month ON case_revenue_lines(partner_id, case_no, service_month)`)
  // 按医院(客户)成本/盈利：partner 维度（LIS 给"哪家医院送检" → lis_cases；冗余到 abc 明细供按客户上卷）
  ensureColumn('outbound_abc_details', 'partner_id', 'TEXT')
  ensureColumn('lis_cases', 'partner_id', 'TEXT')
  ensureColumn('outbound_abc_details', 'source_snapshot', 'TEXT')
  // 收入侧推断层：样本类型(tissue/tissue_complex/cytology)推断结果 + 来源(auto 关键词判 / manual 人工覆盖永远赢)。
  // 增量纠错架构：派生推断落字段、可逐 case 覆盖、留痕；改判断逻辑只需重跑（原始数量不动）。
  ensureColumn('lis_cases', 'specimen_type', 'TEXT')
  ensureColumn('lis_cases', 'specimen_type_source', "TEXT NOT NULL DEFAULT 'auto'")
  // LIS 基础数量列（W3 导入写入；charge mapping 的输入；与原始事实层一致，可重传覆盖）
  ;['he_slide_count', 'block_count', 'ihc_count', 'special_stain_count', 'eber_count', 'pdl1_count'].forEach((c) =>
    ensureColumn('lis_cases', c, 'INTEGER NOT NULL DEFAULT 0'),
  )
  // —— 收入归属「两层模型」预埋（2026-06-27，待对账单学习后完善逻辑；当前全可空、无任何计算读取它们，零回归）——
  //   business_line：检测业务线（组织学/细胞/宫颈液基/冰冻/外院会诊/分子院内/FISH/外送… 见 revenue-attribution.ts）。
  //     决定该 case 走哪种「归属方法」(A 账单占比 / B 单项整笔 / C 外送转销)。
  //   service_step_scope：方法 A 的 case 上「我们实际做了哪几步」的 JSON（病例级覆盖；默认取医院协议，可人工改、留痕）。
  //   _source：取值来源（auto 推断 / contract 协议默认 / manual 人工 / bill 账单码反推）——增量纠错留痕，对齐 specimen_type_source。
  ensureColumn('lis_cases', 'business_line', 'TEXT')
  ensureColumn('lis_cases', 'business_line_source', "TEXT NOT NULL DEFAULT 'auto'")
  ensureColumn('lis_cases', 'service_step_scope', 'TEXT')
  ensureColumn('lis_cases', 'service_step_scope_source', "TEXT NOT NULL DEFAULT 'auto'")

  // ── PRD-0 T1.1 跨院串账止血：lis_cases 唯一键 (case_no) → (partner_id, case_no) ──
  // 不同医院各自编号体系会撞号；旧 UNIQUE(case_no) 让第二家医院同号被拒/覆盖（codex 04 CRITICAL：跨院串账半闭环）。
  // SQLite 列级 UNIQUE 不能 ALTER 删除 → 整表重建（仿 case_revenue 重建；动态读 PRAGMA 列保留全部 ensureColumn 增列，事务内幂等）。
  // 迁移前不并入 partner_id IS NULL 的历史行（§7.3：保持待修复，不自动归入任意医院）。
  {
    const lc = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lis_cases'").get() as { sql?: string } | undefined
    if (lc?.sql && /case_no\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(lc.sql)) {
      const cols = database.prepare(`PRAGMA table_info(lis_cases)`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>
      const colDefs = cols.map((c) => {
        let def = `"${c.name}" ${c.type || 'TEXT'}`
        if (c.pk) def += ' PRIMARY KEY'
        else if (c.notnull) def += ' NOT NULL'
        if (c.dflt_value != null) def += ` DEFAULT ${c.dflt_value}`
        return def
      }).join(', ')
      const colList = cols.map((c) => `"${c.name}"`).join(', ')
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec(`CREATE TABLE lis_cases__new (${colDefs})`)
        database.exec(`INSERT INTO lis_cases__new (${colList}) SELECT ${colList} FROM lis_cases`)
        database.exec('DROP TABLE lis_cases')
        database.exec('ALTER TABLE lis_cases__new RENAME TO lis_cases')
        database.exec('COMMIT')
      } catch (e) { database.exec('ROLLBACK'); throw e }
    }
  }
  // 复合唯一：同院同号唯一；跨院同号并存。partner_id IS NULL 的历史行在 SQLite UNIQUE 中视为相异 → 不互相冲突、不自动并入任意医院（待人工补院）。
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_lis_cases_partner_case ON lis_cases(partner_id, case_no)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_lis_cases_case_no ON lis_cases(case_no)`)

  // —— ABC 索引（L2 成本来源→中心映射热路径 + 期间动因聚合）——
  database.exec(`CREATE INDEX IF NOT EXISTS idx_labor_center ON standard_labor_times(activity_center_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_equipment_center ON equipment(activity_center_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_equipment_type ON equipment(type_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_eqtype_default_center ON equipment_types(default_activity_center_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_equsage_center ON equipment_usage(activity_center_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_equsage_equipment ON equipment_usage(equipment_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_indirect_direct_center ON indirect_cost_centers(direct_activity_center_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_oad_month_status ON outbound_abc_details(cost_month, cost_status)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_oad_outbound ON outbound_abc_details(outbound_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_oad_bomversion ON outbound_abc_details(bom_version_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_oad_case_month ON outbound_abc_details(case_no, cost_month)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_pool_center_month ON abc_cost_pools(activity_center_id, year_month)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_bal_bom ON bom_activity_links(bom_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_bal_center ON bom_activity_links(activity_center_id)`)

  // ===========================================================================
  // ABC 默认 seed（开箱即用：默认作业中心/动因/费率/标准工时映射，使引擎在默认库即按动因归集）
  // ===========================================================================
  // 末列 activity_center_id = 人工步骤默认归属作业中心（L2-1/L5-1）
  const laborDefaults: Array<[string, string, string, string, number, number, number, string]> = [
    ['LAB-ALL-001', 'sample_receive', '样本接收', 'all', 1.5, 1, 10, 'ABC-AC-001'],
    ['LAB-ALL-002', 'embedding', '包埋', 'all', 6, 1, 20, 'ABC-AC-002'],
    ['LAB-ALL-003', 'labeling', '标签核对', 'all', 1.5, 1, 30, 'ABC-AC-001'],
    ['LAB-ALL-004', 'report_review', '报告复核', 'all', 40, 1, 40, 'ABC-AC-007'],
    ['LAB-IHC-001', 'ihc_stain_review', '免疫组化染色复核', 'ihc', 7.5, 1, 50, 'ABC-AC-004'],
  ]
  const insertLabor = database.prepare(`
    INSERT OR IGNORE INTO standard_labor_times
      (id, step_code, step_name, project_type, standard_minutes, labor_rate_per_minute, is_equipment_step, sort_order, reference_source, activity_center_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'system', ?)
  `)
  laborDefaults.forEach((row) => insertLabor.run(...row))
  // 既有库回填：INSERT OR IGNORE 不覆盖已存在行，按 step_code 约定补默认归属中心（仅当为空）
  const backfillLaborCenter = database.prepare(
    `UPDATE standard_labor_times SET activity_center_id = ? WHERE step_code = ? AND activity_center_id IS NULL`
  )
  for (const r of laborDefaults) backfillLaborCenter.run(r[7], r[1])

  const activityDefaults = [
    ['ABC-AC-001', 'SPECIMEN', '标本接收', 'block_count', 10],
    ['ABC-AC-002', 'SECTION', '切片', 'block_count', 20],
    ['ABC-AC-003', 'HE_STAIN', 'HE染色', 'slide_count', 30],
    ['ABC-AC-004', 'IHC', '免疫组化', 'slide_count', 40],
    ['ABC-AC-005', 'SS', '特殊染色', 'slide_count', 50],
    ['ABC-AC-006', 'MP', '分子病理', 'case_count', 60],
    ['ABC-AC-007', 'DIAGNOSIS', '诊断', 'case_count', 70],
    ['ABC-AC-008', 'CYTOLOGY', '细胞学', 'slide_count', 80],
  ] as const
  const insertActivity = database.prepare(`
    INSERT OR IGNORE INTO abc_activity_centers
      (id, code, name, cost_driver_type, sort_order, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `)
  const updateActivity = database.prepare(`
    UPDATE abc_activity_centers
    SET code = ?, name = ?, cost_driver_type = ?, sort_order = ?, status = 'active'
    WHERE id = ?
  `)
  activityDefaults.forEach((row) => {
    insertActivity.run(...row)
    updateActivity.run(row[1], row[2], row[3], row[4], row[0])
  })

  // 第 5 列 driver_source_column = 该动因在 outbound_abc_details 上的计量列（L2-2 数据驱动聚合）
  const driverDefaults: Array<[string, string, string, string, string | null]> = [
    ['ABC-CD-001', 'block_count', '蜡块数', '块', 'block_count'],
    ['ABC-CD-002', 'slide_count', '切片数', '张', 'slide_count'],
    ['ABC-CD-003', 'case_count', '病例数', '例', 'case_count'],
    ['ABC-CD-004', 'stain_count', '染色次数', '次', null],
    ['ABC-CD-005', 'probe_count', '探针数', '个', null],
    ['ABC-CD-006', 'test_count', '检测次数', '次', null],
    ['ABC-CD-007', 'report_count', '报告数', '份', null],
  ]
  const insertDriver = database.prepare(`
    INSERT OR IGNORE INTO abc_cost_drivers
      (id, code, name, unit, driver_source_column, calculation_method, status)
    VALUES (?, ?, ?, ?, ?, 'linear', 'active')
  `)
  driverDefaults.forEach((row) => insertDriver.run(...row))
  database.exec(`UPDATE abc_cost_drivers SET driver_source_column = code
                 WHERE code IN ('block_count', 'slide_count', 'case_count') AND driver_source_column IS NULL`)

  const feeDefaults = [
    ['FEE-001', '012100000010000', '病理诊断费', 'diagnosis', 'diagnosis', 105],
    ['FEE-002', '012100000030000', '标本处理费（常规）', 'specimen', 'all', 45],
    ['FEE-003', '012100000120000', 'IHC染色检查费', 'ihc', 'ihc', 205],
    ['FEE-004', '012100000150000', 'FISH检测费', 'fish', 'fish', 1200],
    ['FEE-005', '012100000170000', '实时荧光PCR', 'pcr', 'molecular', 350],
    ['FEE-006', '012100000200000', 'NGS', 'ngs', 'molecular', 2500],
  ] as const
  const insertFee = database.prepare(`
    INSERT OR IGNORE INTO fee_standards
      (id, code, name, category, project_type, fee_per_slide, base_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `)
  feeDefaults.forEach((row) => insertFee.run(...row, row[5]))

  // 收入侧收费目录种子（v1 常见档；INSERT OR IGNORE 幂等，已存在不覆盖以保留运营修改）
  const insertChargeCode = database.prepare(`
    INSERT OR IGNORE INTO charge_codes (code, name, unit, category, rule_type, rule_json, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `)
  CHARGE_CODE_SEED.forEach((def) => {
    const row = chargeDefToRow(def)
    insertChargeCode.run(row.code, row.name, row.unit, row.category, row.rule_type, row.rule_json)
  })

  // NGS 外购转销产品参考目录种子（截图可见子集；INSERT OR IGNORE 幂等，已存在不覆盖以保留运营修改）
  const insertNgsProduct = database.prepare(`
    INSERT OR IGNORE INTO ngs_products (product_name, category, gene_count, sample_type, clinical_meaning, turnaround_days, guide_price, agreement_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `)
  NGS_PRODUCT_SEED.forEach((def) => {
    const r = ngsProductToRow(def)
    insertNgsProduct.run(r.product_name, r.category, r.gene_count, r.sample_type, r.clinical_meaning, r.turnaround_days, r.guide_price, r.agreement_price)
  })

  // —— Phase 0 逐抗体成本地基 seed（真台账 192 种 + 二抗/显色 + G2 估参数 + 特染盒；INSERT OR IGNORE 幂等，不覆盖运营修改）——
  const insertAntibody = database.prepare(`
    INSERT OR IGNORE INTO antibodies
      (id, name, clone_no, supplier, category, form, spec, bottle_price, bottle_price_taxed, conv_rate, per_test_price, price_status, source_ledger, status)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `)
  ANTIBODY_LEDGER_SEED.forEach((a, i) => {
    const hasPrice = typeof a.perTestPrice === 'number' && (a.perTestPrice as number) > 0
    insertAntibody.run(
      `AB-S${String(i).padStart(3, '0')}`, a.name, a.supplier, a.category, a.form, a.spec,
      a.bottlePrice ?? 0, a.bottlePriceTaxed, a.convRate, a.perTestPrice,
      hasPrice ? 'has_price' : 'missing', ANTIBODY_LEDGER_SOURCE,
    )
  })
  // 台账真缺 5 种（LIS 用到、台账无价，A1）：入库标 price_status='missing'，成本走降级 + 行级「毛利待定」。
  //   待 PM 补采购价后经 PUT /antibodies/:id 回填（form=NULL 未知剂型，与台账无 UNIQUE 冲突）。
  ANTIBODY_MISSING_PRICE_SEED.forEach((m, i) => {
    insertAntibody.run(
      `AB-MISS${String(i).padStart(2, '0')}`, m.name, null, m.category, null, null,
      0, null, null, null, 'missing', `LIS用到·台账缺价·待PM补采购价(A1)｜${m.note}`,
    )
  })
  // 抗体别名种子（生物学同义词，规范化撞不到的）→ antibody_aliases。
  const insertAlias = database.prepare(`
    INSERT OR IGNORE INTO antibody_aliases (id, lis_name, canonical_name, note, source, status)
    VALUES (?, ?, ?, ?, ?, 1)
  `)
  ANTIBODY_SYNONYM_SEED.forEach((s, i) => {
    insertAlias.run(`AB-ALIAS${String(i).padStart(2, '0')}`, s.lisName, s.canonicalName, s.note, '种子(A1同义词)')
  })
  const insertDetection = database.prepare(`
    INSERT OR IGNORE INTO detection_systems
      (id, name, type, form, spec, bottle_price, conv_rate, per_slide_cost, is_default, source_ledger, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `)
  DETECTION_LEDGER_SEED.forEach((d, i) => {
    const isDefault = d.type === 'secondary' && d.name.includes('上机') ? 1 : 0
    insertDetection.run(
      `DET-S${String(i).padStart(3, '0')}`, d.name, d.type, d.form, d.spec,
      d.bottlePrice, d.convRate, d.perSlideCost, isDefault, ANTIBODY_LEDGER_SOURCE,
    )
  })
  const insertIhcParam = database.prepare(`
    INSERT OR IGNORE INTO ihc_cost_params (id, param_key, value, source, confidence, remark)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const ihcParamSeed: Array<[string, string, number, string, string, string]> = [
    // 二抗/显色是台账真价（上机二抗测试条 ¥15，台账 14~16）——非弱锚，如实标「台账真价」，别混进 G2 估。
    ['IHC-PARAM-SEC', 'secondary_per_slide', DEFAULT_IHC_COST_PARAMS.secondaryPerSlide, '台账', '台账真价', '上机二抗测试条~¥15/片（台账真价 14~16）'],
    // 工时/设备是弱锚（B4）——诚实标 G2 估·粗估·待校准；用真实工资/折旧走 POST /cost-params/calibrate 摊算写回后翻牌「已校准」。
    ['IHC-PARAM-LAB', 'labor_per_slide', DEFAULT_IHC_COST_PARAMS.laborPerSlide, 'G2估', '粗估', '工时占位·弱锚·待康湾真实工资校准(B4)：POST /cost-params/calibrate'],
    ['IHC-PARAM-EQP', 'equipment_per_slide', DEFAULT_IHC_COST_PARAMS.equipmentPerSlide, 'G2估', '粗估', '设备折旧占位·弱锚·待校准(B4)：POST /cost-params/calibrate'],
  ]
  ihcParamSeed.forEach((r) => insertIhcParam.run(r[0], r[1], r[2], r[3], r[4], r[5]))
  const insertStain = database.prepare(`
    INSERT OR IGNORE INTO special_stain_kits (id, name, kit_price, nominal_tests, labor_per_test, remark, source_ledger, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `)
  const stainSeed: Array<[string, string, number, number, number, string, string]> = [
    ['SS-MASSON', 'Masson三色', 318, 50, 14, '标称次数=50 占位·待补真实盒装次数', 'G2真实盒价'],
    ['SS-RETIC', '网状纤维', 549, 50, 14, '标称次数=50 占位·待补真实盒装次数', 'G2真实盒价'],
    ['SS-AFB', '抗酸(AFB)', 195, 50, 14, '标称次数=50 占位·待补真实盒装次数', 'G2真实盒价'],
  ]
  stainSeed.forEach((r) => insertStain.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6]))

  // 院级贡献毛利 readiness 控制面（A+B）：owner/due、追加式真实探针证据、空的月度固定池版本/认账表。
  // 不 seed 任何 passed/ready，不 seed 金额/RATIFIED，不写历史周期或首周期验证事实。
  ensureHospitalCmReadinessSchema(database)

  // hospital-cm #182 D2 B0：只建空的候选来源名册控制面。
  // 不 seed 账户、不认定来源权威、不接 readiness/FULL/PARTIAL/NONE，也不自动生成 C1 scope。
  ensureHospitalCmAccountRosterSchema(database)

  // C1 周期证据底座（#183 增量 C）：batch manifest / 月度范围快照 / close-reopen revision 镜像 /
  // 周期验证 run-check 存储与读侧失效判定。只建 append-only 存储与触发器,不 seed 任何 manifest、
  // 周期通过或首期验证;legacy 已关账行保持无事件 = 永远只是待验证 candidate(状态机归 C3）。
  // 依赖 reconcile_hospital_months 已在上文建表（close 镜像触发器挂其上）。
  ensureHospitalCmPeriodEvidenceSchema(database)

  // ===========================================================================
  // D2 统一检测项目目录（project_catalog / code_mappings）—— 地基线 D
  //   只读对照层：把四套/五套叫法（projects.code / 国标码 / 老物价码 / LIS 名 / 对账单名）
  //   对到同一个标准项(PC-*)。建表+幂等种子全在 utils/project-catalog.ts。
  //   ⛔ 不改任何现有分类逻辑（先并存）；守黄金 ¥13,152 / ¥27,870 零回归。
  // ===========================================================================
  seedProjectCatalog(database)

  console.log('Database initialized successfully')
}

export function closeDatabase(): void {
  if (db) {
    const current = db
    db = null
    current.close()
  }
}

/**
 * A failed rollback leaves the singleton connection's transaction state unknown.
 * Detach it before best-effort close so the next request cannot reuse that handle.
 */
export function invalidateDatabaseConnection(expected?: DatabaseSync): boolean {
  const current = db
  if (!current || (expected && current !== expected)) return false
  db = null
  try { current.close() } catch { /* detached handle is intentionally discarded */ }
  return true
}
