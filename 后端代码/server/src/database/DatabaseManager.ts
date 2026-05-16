import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DB_PATH = join(__dirname, '../../data/coreone.db')

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

  console.log('Database initialized successfully')
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
