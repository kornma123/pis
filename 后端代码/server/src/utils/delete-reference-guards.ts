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
    WHERE supplier_id = ? AND is_deleted = 0 AND COALESCE(status, '') != 'cancelled'
  `).all(supplierId) as Array<{ id: string }>
  for (const r of inbounds) refs.push({ kind: 'inbound_record', id: r.id })
  const supplierReturns = db.prepare(`
    SELECT id FROM supplier_returns
    WHERE supplier_id = ? AND is_deleted = 0 AND COALESCE(status, '') NOT IN ('refunded', 'cancelled')
  `).all(supplierId) as Array<{ id: string }>
  for (const r of supplierReturns) refs.push({ kind: 'supplier_return', id: r.id })
  return refs
}

/** 角色活引用：活跃用户（is_deleted = 0）经 user_roles 或 users.role/primary_role 兜底持有该角色 */
export function findRoleLiveAssignments(db: Db, roleCode: string): LiveReference[] {
  const rows = db.prepare(`
    SELECT u.id FROM users u
    WHERE u.is_deleted = 0 AND (
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

/** 项目活引用：统一目录登记（project_code 别名映射）、LIS 病例、在途出库、未决成本异常 */
export function findProjectLiveReferences(db: Db, projectId: string, projectCode: string): LiveReference[] {
  const refs: LiveReference[] = []
  const catalogMappings = db.prepare(
    `SELECT id FROM code_mappings WHERE system = 'project_code' AND alias_code = ?`,
  ).all(projectCode) as Array<{ id: string }>
  for (const r of catalogMappings) refs.push({ kind: 'catalog_mapping', id: r.id })
  const lisCases = db.prepare(
    'SELECT id FROM lis_cases WHERE project_id = ?',
  ).all(projectId) as Array<{ id: string }>
  for (const r of lisCases) refs.push({ kind: 'lis_case', id: r.id })
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
