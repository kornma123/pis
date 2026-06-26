import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/coreone.db')

fs.mkdirSync(dirname(DB_PATH), { recursive: true })

let db: DatabaseSync | null = null

export function getDatabase(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH)
  }
  return db
}

export function resetDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH)
    console.log('Old database removed:', DB_PATH)
  }
}

export function initializeDatabase(): void {
  const database = getDatabase()

  database.exec(`
    CREATE TABLE IF NOT EXISTS material_categories (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, parent_id TEXT, level INTEGER NOT NULL, sort_order INTEGER DEFAULT 0, status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, spec TEXT, unit TEXT NOT NULL, spec_qty DECIMAL(18, 4) DEFAULT 0, spec_unit TEXT, category_id TEXT NOT NULL, supplier_id TEXT, price DECIMAL(18, 4) DEFAULT 0, min_stock INTEGER DEFAULT 0, max_stock INTEGER DEFAULT 999999, safety_stock INTEGER DEFAULT 0, location_id TEXT, status INTEGER NOT NULL DEFAULT 1, remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, address TEXT, tax_no TEXT, bank_name TEXT, bank_account TEXT, status INTEGER NOT NULL DEFAULT 1, cooperation_count INTEGER DEFAULT 0, total_amount DECIMAL(18, 4) DEFAULT 0, rating INTEGER DEFAULT 5, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
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

  // 兼容旧数据库：添加 stocktaking_records.is_deleted 字段
  try {
    const stCols = database.prepare("PRAGMA table_info(stocktaking_records)").all() as any[]
    if (!stCols.find(c => c.name === 'is_deleted')) {
      database.exec("ALTER TABLE stocktaking_records ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
      console.log('Migrated stocktaking_records table: added is_deleted column')
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
  database.exec(`
    CREATE TABLE IF NOT EXISTS bom_items (id TEXT PRIMARY KEY, bom_id TEXT NOT NULL, material_id TEXT NOT NULL, usage_per_sample DECIMAL(18, 4) NOT NULL, unit TEXT NOT NULL, is_alternative INTEGER NOT NULL DEFAULT 0, main_item_id TEXT, sort_order INTEGER DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(bom_id, material_id))
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS stock_logs (id TEXT PRIMARY KEY, type TEXT NOT NULL, material_id TEXT NOT NULL, quantity DECIMAL(18, 4) NOT NULL, before_stock DECIMAL(18, 4) NOT NULL, after_stock DECIMAL(18, 4) NOT NULL, related_id TEXT, related_type TEXT, operator TEXT NOT NULL, remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, threshold INTEGER, threshold_days INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, type TEXT NOT NULL, level TEXT NOT NULL, material_id TEXT NOT NULL, material_name TEXT, current_stock INTEGER, threshold INTEGER, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', handled_by TEXT, handled_at TEXT, remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, real_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'operator', department TEXT, phone TEXT, email TEXT, status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT, updated_by TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, permissions TEXT NOT NULL DEFAULT '[]', status INTEGER NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, is_deleted INTEGER NOT NULL DEFAULT 0)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (id TEXT PRIMARY KEY, user_id TEXT, username TEXT, operation TEXT NOT NULL, description TEXT NOT NULL, request_data TEXT, response_data TEXT, ip TEXT, user_agent TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS stocktaking_records (id TEXT PRIMARY KEY, stocktaking_no TEXT NOT NULL UNIQUE, material_id TEXT NOT NULL, system_stock DECIMAL(18, 4) NOT NULL, actual_stock DECIMAL(18, 4) NOT NULL, difference DECIMAL(18, 4) NOT NULL, operator TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', remark TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)
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
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
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
  database.exec(`
    CREATE TABLE IF NOT EXISTS batch_depletion (
      id TEXT PRIMARY KEY,
      tracking_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      material_name TEXT,
      batch TEXT NOT NULL,
      spec TEXT,
      total_qty DECIMAL(18, 4) NOT NULL DEFAULT 0,
      remain_qty DECIMAL(18, 4) NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'ml',
      start_date TEXT,
      end_date TEXT,
      days_used INTEGER DEFAULT 0,
      actual_days INTEGER DEFAULT 0,
      deplete_type TEXT DEFAULT 'normal',
      deplete_reason TEXT,
      operator TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 成本对账：LIS病例数据
  database.exec(`
    CREATE TABLE IF NOT EXISTS lis_cases (
      id TEXT PRIMARY KEY,
      case_no TEXT NOT NULL UNIQUE,
      project_id TEXT,
      project_name TEXT,
      operator TEXT,
      operate_time TEXT,
      status TEXT NOT NULL DEFAULT 'normal',
      import_batch TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

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

  // 插入默认用户 (密码: admin123)
  const stmt = database.prepare('SELECT * FROM users WHERE username = ?')
  const defaultUser = stmt.get('admin') as any
  if (!defaultUser) {
    const hashedPassword = bcrypt.hashSync('admin123', 12)
    database.prepare('INSERT INTO users (id, username, password, real_name, role, department, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
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
  database.prepare("UPDATE users SET is_deleted = 0, status = 1 WHERE username IN ('cangguan','jishuyuan1','yishi1','caigou','caiwu')").run()

  // 插入默认角色（E2E 测试依赖）
  const defaultRoles = [
    { id: 'ROLE-ADMIN', code: 'admin', name: '管理员', description: '系统管理员，拥有全部权限' },
    { id: 'ROLE-WHM', code: 'warehouse_manager', name: '仓库管理员', description: '负责库存、入库、出库、盘点管理' },
    { id: 'ROLE-TECH', code: 'technician', name: '技术员', description: '负责检测项目、BOM、成本分析' },
    { id: 'ROLE-DOC', code: 'pathologist', name: '病理医师', description: '负责项目审核、成本查看' },
    { id: 'ROLE-PRO', code: 'procurement', name: '采购员', description: '负责采购、供应商管理' },
    { id: 'ROLE-FIN', code: 'finance', name: '财务', description: '负责对账、成本分析' },
  ]
  const insertRole = database.prepare(
    'INSERT OR IGNORE INTO roles (id, code, name, description, permissions, status) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const r of defaultRoles) {
    insertRole.run(r.id, r.code, r.name, r.description, '[]', 1)
  }

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
  // 幂等补列（旧库迁移 + :memory: 新库统一）
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
  ensureColumn('outbound_abc_details', 'source_snapshot', 'TEXT')

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

  console.log('Database initialized successfully')
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
