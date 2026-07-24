/**
 * 五类软删除关联校验（LOC-025A）—— live operational reference 发现。
 *
 * 冻结口径（任务合同 K3-LOC-025A-DELETE-GUARDS-V1）：
 * - 历史/审计引用（已完成/已取消/已退款/已软删单据、日志与审计留痕）不拦截软删除；
 * - 活引用（在途单据、有效分配、未决义务）拦截，稳定拒绝 = HTTP 409 ENTITY_IN_USE；
 * - 未知/畸形状态不等于合法零：状态不在已知终态集合内一律按活引用处理（fail-closed）；
 * - 发现函数只读、全参数化 SQL；权威判定必须在调用方的 BEGIN IMMEDIATE 事务内执行
 *   （锁内重读）。锁前调用只能作顾问性快速拒绝，不得作为放行依据。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface LiveReference {
  kind: string
  id: string
}

type Db = DatabaseSync

/**
 * Recover a failed delete transaction without leaving the shared singleton
 * connection in an unknown transaction state. Closing the singleton is the
 * fail-closed fallback when SQLite itself refuses the rollback command.
 */
export function recoverFailedDeleteTransaction(db: Db, closeConnection: () => void): boolean {
  try {
    db.exec('ROLLBACK')
    return true
  } catch {
    try {
      closeConnection()
      return true
    } catch {
      return false
    }
  }
}

/** 供应商活引用：在途采购订单、有效入库记录、未结退货义务 */
export function findSupplierLiveReferences(db: Db, supplierId: string): LiveReference[] {
  const refs: LiveReference[] = []
  const purchaseOrders = db.prepare(`
    SELECT id FROM purchase_orders
    WHERE supplier_id = ? AND is_deleted = 0 AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(supplierId) as Array<{ id: string }>
  for (const r of purchaseOrders) refs.push({ kind: 'purchase_order', id: r.id })
  const inbounds = db.prepare(`
    SELECT id FROM inbound_records
    WHERE supplier_id = ? AND is_deleted = 0 AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(supplierId) as Array<{ id: string }>
  for (const r of inbounds) refs.push({ kind: 'inbound_record', id: r.id })
  const supplierReturns = db.prepare(`
    SELECT id FROM supplier_returns
    WHERE supplier_id = ? AND is_deleted = 0 AND COALESCE(status, '') NOT IN ('refunded', 'cancelled')
  `).all(supplierId) as Array<{ id: string }>
  for (const r of supplierReturns) refs.push({ kind: 'supplier_return', id: r.id })
  return refs
}

/**
 * 物料库存事实冲突：只有规范的零库存、零锁定库存和已耗尽停用批次才允许删除。
 * legacy/畸形数字、状态或关系不是合法零，必须 fail closed。
 */
export function findMaterialInventoryConflicts(db: Db, materialId: string): LiveReference[] {
  const refs: LiveReference[] = []
  const inventoryRows = db.prepare(`
    SELECT id FROM inventory
    WHERE material_id = ? AND (
      typeof(stock) NOT IN ('integer', 'real')
      OR stock <> 0
      OR typeof(locked_stock) NOT IN ('integer', 'real')
      OR locked_stock <> 0
    )
  `).all(materialId) as Array<{ id: string }>
  for (const r of inventoryRows) refs.push({ kind: 'inventory', id: r.id })

  const batches = db.prepare(`
    SELECT id FROM batches
    WHERE material_id = ? AND (
      typeof(quantity) NOT IN ('integer', 'real')
      OR quantity < 0
      OR quantity > 900719925474.0991
      OR abs(quantity * 10000 - round(quantity * 10000)) >= 0.000001
      OR typeof(remaining) NOT IN ('integer', 'real')
      OR remaining <> 0
      OR remaining > quantity
      OR typeof(status) <> 'integer'
      OR status <> 0
    )
  `).all(materialId) as Array<{ id: string }>
  for (const r of batches) refs.push({ kind: 'batch', id: r.id })
  return refs
}

/**
 * 物料活引用：在途库存单据、活跃 BOM、待处理盘点/批次占用及待审对账。
 *
 * 历史库存流水、分批 allocation、已完成/取消/退款/软删业务单不阻断；
 * 未知状态、孤儿出库明细及畸形删除标记按活引用处理。
 */
export function findMaterialLiveReferences(db: Db, materialId: string): LiveReference[] {
  const refs: LiveReference[] = []
  const append = (kind: string, rows: Array<{ id: string }>) => {
    for (const row of rows) refs.push({ kind, id: row.id })
  }

  append('purchase_order', db.prepare(`
    SELECT id FROM purchase_orders
    WHERE material_id = ?
      AND COALESCE(is_deleted, 0) <> 1
      AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(materialId) as Array<{ id: string }>)

  // transfer 与普通入库共用 inbound_records；终态 completed/cancelled 都是历史事实。
  append('inbound_record', db.prepare(`
    SELECT id FROM inbound_records
    WHERE material_id = ?
      AND COALESCE(is_deleted, 0) <> 1
      AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(materialId) as Array<{ id: string }>)

  append('outbound_item', db.prepare(`
    SELECT oi.id
    FROM outbound_items oi
    LEFT JOIN outbound_records o ON o.id = oi.outbound_id
    WHERE oi.material_id = ? AND (
      o.id IS NULL
      OR typeof(o.is_deleted) <> 'integer'
      OR o.is_deleted NOT IN (0, 1)
      OR (
        o.is_deleted = 0
        AND COALESCE(o.status, '') NOT IN ('completed', 'cancelled')
      )
    )
  `).all(materialId) as Array<{ id: string }>)

  append('return_record', db.prepare(`
    SELECT id FROM return_records
    WHERE material_id = ?
      AND COALESCE(is_deleted, 0) <> 1
      AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(materialId) as Array<{ id: string }>)

  append('supplier_return', db.prepare(`
    SELECT id FROM supplier_returns
    WHERE material_id = ?
      AND COALESCE(is_deleted, 0) <> 1
      AND COALESCE(status, '') NOT IN ('refunded', 'cancelled')
  `).all(materialId) as Array<{ id: string }>)

  append('scrap_record', db.prepare(`
    SELECT id FROM scrap_records
    WHERE material_id = ?
      AND COALESCE(is_deleted, 0) <> 1
      AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(materialId) as Array<{ id: string }>)

  append('stocktaking_record', db.prepare(`
    SELECT id FROM stocktaking_records
    WHERE material_id = ?
      AND COALESCE(is_deleted, 0) <> 1
      AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(materialId) as Array<{ id: string }>)

  append('batch_usage', db.prepare(`
    SELECT id FROM batch_usage_tracking
    WHERE material_id = ?
      AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(materialId) as Array<{ id: string }>)

  append('bom_item', db.prepare(`
    SELECT ref.id
    FROM (
      SELECT id, bom_id, material_id FROM bom_items
      UNION ALL
      SELECT id, bom_id, material_id FROM bom_general_reagents
      UNION ALL
      SELECT id, bom_id, material_id FROM bom_general_consumables
      UNION ALL
      SELECT id, bom_id, material_id FROM bom_quality_controls
    ) ref
    LEFT JOIN boms b ON b.id = ref.bom_id
    WHERE ref.material_id = ? AND (
      b.id IS NULL
      OR typeof(b.is_deleted) <> 'integer'
      OR b.is_deleted NOT IN (0, 1)
      OR (
        b.is_deleted = 0
        AND (typeof(b.status) <> 'integer' OR b.status <> 0)
      )
    )
  `).all(materialId) as Array<{ id: string }>)

  append('reconciliation_proposal', db.prepare(`
    SELECT id FROM reconciliation_logs
    WHERE material_id = ?
      AND COALESCE(status, '') NOT IN ('applied', 'rejected')
  `).all(materialId) as Array<{ id: string }>)

  return refs
}

/** 角色活引用：活跃用户（is_deleted = 0）经 user_roles 或 users.role/primary_role 兜底持有该角色 */
export function findRoleLiveAssignments(db: Db, roleCode: string): LiveReference[] {
  const rows = db.prepare(`
    SELECT u.id FROM users u
    WHERE u.is_deleted = 0 AND u.status = 1 AND (
      u.role = ? OR u.primary_role = ?
      OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_code = ?)
    )
  `).all(roleCode, roleCode, roleCode) as Array<{ id: string }>
  return rows.map((r) => ({ kind: 'user_assignment', id: r.id }))
}

/**
 * 库位在途运营引用：生效物料主数据 / 生效设备仍指派该库位。
 * 库存存量与批次余量口径由路由既有守卫覆盖（P1-06，不动），这里只补主数据/设备指派。
 */
export function findLocationLiveReferences(db: Db, locationId: string): LiveReference[] {
  const refs: LiveReference[] = []
  const materials = db.prepare(
    'SELECT id FROM materials WHERE location_id = ? AND is_deleted = 0',
  ).all(locationId) as Array<{ id: string }>
  for (const r of materials) refs.push({ kind: 'material', id: r.id })
  const equipment = db.prepare(
    'SELECT id FROM equipment WHERE location_id = ? AND is_deleted = 0',
  ).all(locationId) as Array<{ id: string }>
  for (const r of equipment) refs.push({ kind: 'equipment', id: r.id })
  return refs
}

/** 用户活持有/在途分配：生效项目负责人；在途（非 completed/cancelled）出库单经办。历史单据与日志不拦截 */
export function findUserLiveOwnership(db: Db, username: string): LiveReference[] {
  const refs: LiveReference[] = []
  const managedProjects = db.prepare(
    'SELECT id FROM projects WHERE manager = ? AND status = 1 AND is_deleted = 0',
  ).all(username) as Array<{ id: string }>
  for (const r of managedProjects) refs.push({ kind: 'managed_project', id: r.id })
  const pendingOutbounds = db.prepare(`
    SELECT id FROM outbound_records
    WHERE operator = ? AND is_deleted = 0 AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(username) as Array<{ id: string }>
  for (const r of pendingOutbounds) refs.push({ kind: 'pending_outbound', id: r.id })
  return refs
}

/**
 * 项目活引用：在途出库与未决成本异常。
 * project_code 目录映射只是 alias/catalog 归一化，LIS 病例是历史业务记录；二者都不是项目 FK，
 * 不阻断 typed 项目软删除，也不在删除时级联改写。
 */
export function findProjectLiveReferences(db: Db, projectId: string): LiveReference[] {
  const refs: LiveReference[] = []
  const outbounds = db.prepare(`
    SELECT id FROM outbound_records
    WHERE project_id = ? AND is_deleted = 0 AND COALESCE(status, '') NOT IN ('completed', 'cancelled')
  `).all(projectId) as Array<{ id: string }>
  for (const r of outbounds) refs.push({ kind: 'outbound_record', id: r.id })
  const costExceptions = db.prepare(`
    SELECT id FROM cost_exceptions
    WHERE project_id = ? AND COALESCE(status, '') NOT IN ('resolved', 'closed', 'ignored')
  `).all(projectId) as Array<{ id: string }>
  for (const r of costExceptions) refs.push({ kind: 'cost_exception', id: r.id })
  return refs
}
