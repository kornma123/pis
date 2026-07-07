export type InventoryConsistencyIssue = {
  code: string
  severity: 'critical' | 'warning'
  entityType: string
  entityId: string
  entityCode?: string | null
  entityName?: string | null
  message: string
  impacts: Record<string, unknown>
}

/** 单物料的库存双账本漂移行（对账体检 / 向后取证用） */
export type LedgerDriftRow = {
  materialId: string
  code?: string | null
  name?: string | null
  stock: number
  batchRemaining: number
  /** stock - Σ(status=1 batches.remaining)；>0 = 正向漂移（会致出库缺批次静默算低成本，危险方向） */
  drift: number
}

/**
 * 库存台账对账体检（reconcileStockLedger）——按物料算 `stock - Σ(status=1 batches.remaining)`，
 * 只体检不改数。正向漂移（stock > Σremaining）是出库派生成本时会取不到批次、回退到均价/0 的危险方向。
 * 与既有 `INVENTORY_BATCH_MISMATCH`（buildInventoryConsistencyIssues）同口径，此处给出可直接消费的漂移明细。
 * onlyPositive=true 时只返回正向漂移（喂 P0 体检成本前重点看这批）。
 */
export function findLedgerDriftMaterials(db: any, onlyPositive = false): LedgerDriftRow[] {
  const rows = db.prepare(`
    SELECT i.material_id AS materialId, m.code, m.name, i.stock AS stock,
           COALESCE(SUM(CASE WHEN b.status = 1 THEN b.remaining ELSE 0 END), 0) AS batchRemaining
    FROM inventory i
    JOIN materials m ON m.id = i.material_id AND m.is_deleted = 0
    LEFT JOIN batches b ON b.material_id = i.material_id
    GROUP BY i.material_id, m.code, m.name, i.stock
    HAVING ABS(COALESCE(i.stock, 0) - batchRemaining) > 0.0001
  `).all() as any[]
  return rows
    .map((r) => ({
      materialId: r.materialId,
      code: r.code ?? null,
      name: r.name ?? null,
      stock: Number(r.stock) || 0,
      batchRemaining: Number(r.batchRemaining) || 0,
      drift: (Number(r.stock) || 0) - (Number(r.batchRemaining) || 0),
    }))
    .filter((r) => (onlyPositive ? r.drift > 0.0001 : true))
}

export function buildInventoryConsistencyIssues(db: any): InventoryConsistencyIssue[] {
  const issues: InventoryConsistencyIssue[] = []
  const addIssue = (issue: InventoryConsistencyIssue) => issues.push(issue)

  const inactiveMaterials = db.prepare(`
    SELECT m.id, m.code, m.name, COALESCE(i.stock, 0) as stock
    FROM materials m
    JOIN inventory i ON i.material_id = m.id AND i.stock > 0
    WHERE m.is_deleted = 0 AND m.status <> 1
  `).all() as any[]
  inactiveMaterials.forEach(row => addIssue({
    code: 'INACTIVE_MATERIAL_WITH_STOCK',
    severity: 'critical',
    entityType: 'material',
    entityId: row.id,
    entityCode: row.code,
    entityName: row.name,
    message: `停用物料仍有总库存 ${Number(row.stock) || 0}`,
    impacts: { stock: Number(row.stock) || 0 },
  }))

  const invalidBomMaterials = db.prepare(`
    WITH bom_materials AS (
      SELECT bom_id, material_id FROM bom_items
      UNION ALL SELECT bom_id, material_id FROM bom_general_reagents
      UNION ALL SELECT bom_id, material_id FROM bom_general_consumables
      UNION ALL SELECT bom_id, material_id FROM bom_quality_controls
    )
    SELECT b.id, b.code, b.name, COUNT(DISTINCT bm.material_id) as invalid_count
    FROM boms b
    JOIN bom_materials bm ON bm.bom_id = b.id
    LEFT JOIN materials m ON m.id = bm.material_id AND m.is_deleted = 0
    WHERE b.is_deleted = 0
      AND b.status = 1
      AND (m.id IS NULL OR m.status <> 1)
    GROUP BY b.id, b.code, b.name
  `).all() as any[]
  invalidBomMaterials.forEach(row => addIssue({
    code: 'ACTIVE_BOM_INVALID_MATERIAL',
    severity: 'critical',
    entityType: 'bom',
    entityId: row.id,
    entityCode: row.code,
    entityName: row.name,
    message: `启用BOM存在 ${Number(row.invalid_count) || 0} 个停用或已删除物料依赖`,
    impacts: { invalidMaterialCount: Number(row.invalid_count) || 0 },
  }))

  const invalidBomEquipment = db.prepare(`
    SELECT b.id, b.code, b.name,
      SUM(CASE WHEN bet.equipment_id IS NOT NULL AND (e.id IS NULL OR e.status <> 1) THEN 1 ELSE 0 END) as invalid_equipment_count,
      SUM(CASE WHEN bet.equipment_type_id IS NOT NULL AND (et.id IS NULL OR et.status <> 1) THEN 1 ELSE 0 END) as invalid_equipment_type_count
    FROM boms b
    JOIN bom_equipment_templates bet ON bet.bom_id = b.id
    LEFT JOIN equipment e ON e.id = bet.equipment_id
    LEFT JOIN equipment_types et ON et.id = bet.equipment_type_id
    WHERE b.is_deleted = 0 AND b.status = 1
    GROUP BY b.id, b.code, b.name
    HAVING invalid_equipment_count > 0 OR invalid_equipment_type_count > 0
  `).all() as any[]
  invalidBomEquipment.forEach(row => addIssue({
    code: 'ACTIVE_BOM_INVALID_EQUIPMENT',
    severity: 'critical',
    entityType: 'bom',
    entityId: row.id,
    entityCode: row.code,
    entityName: row.name,
    message: '启用BOM存在未启用或不存在的设备依赖',
    impacts: {
      invalidEquipmentCount: Number(row.invalid_equipment_count) || 0,
      invalidEquipmentTypeCount: Number(row.invalid_equipment_type_count) || 0,
    },
  }))

  const invalidProjects = db.prepare(`
    SELECT p.id, p.code, p.name, p.type, p.bom_id, b.code as bom_code, b.name as bom_name, b.type as bom_type, b.status as bom_status, b.is_deleted as bom_deleted
    FROM projects p
    LEFT JOIN boms b ON b.id = p.bom_id
    WHERE p.is_deleted = 0
      AND p.status = 1
      AND p.bom_id IS NOT NULL
      AND (
        b.id IS NULL
        OR b.is_deleted <> 0
        OR b.status <> 1
        OR (b.type <> p.type AND b.type <> 'project')
      )
  `).all() as any[]
  invalidProjects.forEach(row => addIssue({
    code: 'ACTIVE_PROJECT_INVALID_BOM',
    severity: 'critical',
    entityType: 'project',
    entityId: row.id,
    entityCode: row.code,
    entityName: row.name,
    message: '启用检测服务绑定了不可用或类型不匹配的BOM',
    impacts: {
      projectType: row.type,
      bomId: row.bom_id,
      bomCode: row.bom_code || null,
      bomName: row.bom_name || null,
      bomType: row.bom_type || null,
      bomStatus: row.bom_status === undefined || row.bom_status === null ? null : Number(row.bom_status),
      bomDeleted: row.bom_deleted === undefined || row.bom_deleted === null ? null : Number(row.bom_deleted),
    },
  }))

  const invalidLocations = db.prepare(`
    SELECT l.id, l.code, l.name, l.status, l.is_deleted, SUM(il.stock) as stock
    FROM locations l
    JOIN inventory_locations il ON il.location_id = l.id AND il.stock > 0
    WHERE l.status <> 1 OR l.is_deleted <> 0
    GROUP BY l.id, l.code, l.name, l.status, l.is_deleted
  `).all() as any[]
  invalidLocations.forEach(row => {
    const deleted = Number(row.is_deleted) !== 0
    addIssue({
      code: deleted ? 'DELETED_LOCATION_WITH_STOCK' : 'INACTIVE_LOCATION_WITH_STOCK',
      severity: 'critical',
      entityType: 'location',
      entityId: row.id,
      entityCode: row.code,
      entityName: row.name,
      message: deleted ? '已删除库位仍有库位库存明细' : '停用库位仍有库位库存明细',
      impacts: {
        stock: Number(row.stock) || 0,
        status: Number(row.status),
        isDeleted: Number(row.is_deleted),
      },
    })
  })

  const batchMismatches = db.prepare(`
    SELECT i.material_id, m.code, m.name, i.stock, COALESCE(SUM(CASE WHEN b.status = 1 THEN b.remaining ELSE 0 END), 0) as batch_remaining
    FROM inventory i
    JOIN materials m ON m.id = i.material_id AND m.is_deleted = 0
    LEFT JOIN batches b ON b.material_id = i.material_id
    GROUP BY i.material_id, m.code, m.name, i.stock
    HAVING ABS(COALESCE(i.stock, 0) - batch_remaining) > 0.0001
  `).all() as any[]
  batchMismatches.forEach(row => addIssue({
    code: 'INVENTORY_BATCH_MISMATCH',
    severity: 'critical',
    entityType: 'material',
    entityId: row.material_id,
    entityCode: row.code,
    entityName: row.name,
    message: '库存总账与启用批次剩余量汇总不一致',
    impacts: {
      inventoryStock: Number(row.stock) || 0,
      activeBatchRemaining: Number(row.batch_remaining) || 0,
    },
  }))

  const overRemainingBatches = db.prepare(`
    SELECT b.id, b.batch_no, b.quantity, b.remaining, m.code, m.name
    FROM batches b
    JOIN materials m ON m.id = b.material_id AND m.is_deleted = 0
    WHERE b.status = 1
      AND COALESCE(b.remaining, 0) - COALESCE(b.quantity, 0) > 0.0001
  `).all() as any[]
  overRemainingBatches.forEach(row => addIssue({
    code: 'BATCH_REMAINING_EXCEEDS_QUANTITY',
    severity: 'critical',
    entityType: 'batch',
    entityId: row.id,
    entityCode: row.batch_no,
    entityName: row.name,
    message: '批次剩余量超过批次数量',
    impacts: {
      materialCode: row.code,
      quantity: Number(row.quantity) || 0,
      remaining: Number(row.remaining) || 0,
    },
  }))

  const negativeBatches = db.prepare(`
    SELECT b.id, b.batch_no, b.quantity, b.remaining, m.code, m.name
    FROM batches b
    JOIN materials m ON m.id = b.material_id AND m.is_deleted = 0
    WHERE COALESCE(b.quantity, 0) < -0.0001
       OR COALESCE(b.remaining, 0) < -0.0001
  `).all() as any[]
  negativeBatches.forEach(row => addIssue({
    code: 'BATCH_NEGATIVE_QUANTITY_OR_REMAINING',
    severity: 'critical',
    entityType: 'batch',
    entityId: row.id,
    entityCode: row.batch_no,
    entityName: row.name,
    message: '批次数量或剩余量为负数',
    impacts: {
      materialCode: row.code,
      quantity: Number(row.quantity) || 0,
      remaining: Number(row.remaining) || 0,
    },
  }))

  const negativeLocationStocks = db.prepare(`
    SELECT il.id, il.material_id, il.location_id, il.stock, m.code as material_code, m.name as material_name, l.code as location_code, l.name as location_name
    FROM inventory_locations il
    JOIN materials m ON m.id = il.material_id AND m.is_deleted = 0
    LEFT JOIN locations l ON l.id = il.location_id
    WHERE COALESCE(il.stock, 0) < -0.0001
  `).all() as any[]
  negativeLocationStocks.forEach(row => addIssue({
    code: 'LOCATION_NEGATIVE_STOCK',
    severity: 'critical',
    entityType: 'inventory_location',
    entityId: row.id,
    entityCode: row.location_code || row.location_id,
    entityName: row.location_name || row.material_name,
    message: '库位库存为负数',
    impacts: {
      materialId: row.material_id,
      materialCode: row.material_code,
      locationId: row.location_id,
      stock: Number(row.stock) || 0,
    },
  }))

  const locationMismatches = db.prepare(`
    SELECT i.material_id, m.code, m.name, i.stock, COALESCE(SUM(il.stock), 0) as location_stock
    FROM inventory i
    JOIN materials m ON m.id = i.material_id AND m.is_deleted = 0
    LEFT JOIN inventory_locations il ON il.material_id = i.material_id
    GROUP BY i.material_id, m.code, m.name, i.stock
    HAVING ABS(COALESCE(i.stock, 0) - COALESCE(location_stock, 0)) > 0.0001
  `).all() as any[]
  locationMismatches.forEach(row => addIssue({
    code: 'INVENTORY_LOCATION_MISMATCH',
    severity: 'critical',
    entityType: 'material',
    entityId: row.material_id,
    entityCode: row.code,
    entityName: row.name,
    message: '库存总账与库位库存汇总不一致',
    impacts: {
      inventoryStock: Number(row.stock) || 0,
      locationStock: Number(row.location_stock) || 0,
    },
  }))

  const activeBatchesWithoutInventory = db.prepare(`
    SELECT b.id, b.batch_no, b.material_id, b.remaining, m.code as material_code, m.name as material_name
    FROM batches b
    JOIN materials m ON m.id = b.material_id AND m.is_deleted = 0
    LEFT JOIN inventory i ON i.material_id = b.material_id
    WHERE b.status = 1
      AND COALESCE(b.remaining, 0) > 0.0001
      AND i.material_id IS NULL
  `).all() as any[]
  activeBatchesWithoutInventory.forEach(row => addIssue({
    code: 'ACTIVE_BATCH_WITHOUT_INVENTORY',
    severity: 'critical',
    entityType: 'batch',
    entityId: row.id,
    entityCode: row.batch_no,
    entityName: row.material_name,
    message: '启用批次仍有剩余量但库存总账缺失',
    impacts: {
      materialId: row.material_id,
      materialCode: row.material_code,
      remaining: Number(row.remaining) || 0,
    },
  }))

  const locationStocksWithoutInventory = db.prepare(`
    SELECT il.id, il.material_id, il.location_id, il.stock, m.code as material_code, m.name as material_name, l.code as location_code, l.name as location_name
    FROM inventory_locations il
    JOIN materials m ON m.id = il.material_id AND m.is_deleted = 0
    LEFT JOIN inventory i ON i.material_id = il.material_id
    LEFT JOIN locations l ON l.id = il.location_id
    WHERE COALESCE(il.stock, 0) > 0.0001
      AND i.material_id IS NULL
  `).all() as any[]
  locationStocksWithoutInventory.forEach(row => addIssue({
    code: 'LOCATION_STOCK_WITHOUT_INVENTORY',
    severity: 'critical',
    entityType: 'inventory_location',
    entityId: row.id,
    entityCode: row.location_code || row.location_id,
    entityName: row.location_name || row.material_name,
    message: '库位库存仍有数量但库存总账缺失',
    impacts: {
      materialId: row.material_id,
      materialCode: row.material_code,
      locationId: row.location_id,
      stock: Number(row.stock) || 0,
    },
  }))

  return issues
}
