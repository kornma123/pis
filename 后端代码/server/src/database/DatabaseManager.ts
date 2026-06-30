import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { SEED_MATRIX } from '../middleware/rbac-matrix.js'
import { CHARGE_CODE_SEED, chargeDefToRow } from '../utils/charge-catalog.js'
import { NGS_PRODUCT_SEED, ngsProductToRow } from '../utils/ngs-catalog.js'
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
 * 两个角色的 supplier_returns 一项，不做「全角色 × 全矩阵」对齐。原因：SEED_MATRIX 同时
 * 还给 finance supplier_returns 'R'、technician outbound/stocktaking 等，而既有 e2e
 *（如 finance 访问退货期望 403、BF-PERM technician 访问出库被拦 等）是按「旧权限模型」断言、
 * 且当前全部为绿；全量对齐会改动这些「现为绿」的用例 —— 那属于另一个独立的 RBAC 对齐决策。
 * 因此这里只修复触发了 e2e 失败的两角色一项，保证零回归。库与矩阵在 finance 等处仍存在
 * 有意的不一致，详见 PR 说明 / session-log / 记忆 coreone-pr8-e2e-rbac-migration-gap。
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
  // 配置驱动导入器 P0：每期导入记下所用逐院配置版本 → 改规则后判影响面 + 追溯重算锚。
  ensureColumn('case_revenue', 'config_version', 'INTEGER')
  // P5 收入侧：配置驱动导入(/commit)落库时写【实验室收入=Σ(IN结算)】+移出额+来源。
  //   lab_revenue NULL = 非配置驱动(走估算 实收×占比)；非 NULL = 已对账(statement 权威)。revenue_source: statement/estimated/corrected。
  ensureColumn('case_revenue', 'lab_revenue', 'DECIMAL(18, 4)')
  ensureColumn('case_revenue', 'out_revenue', 'DECIMAL(18, 4) NOT NULL DEFAULT 0')
  ensureColumn('case_revenue', 'revenue_source', 'TEXT')
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

  console.log('Database initialized successfully')
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
