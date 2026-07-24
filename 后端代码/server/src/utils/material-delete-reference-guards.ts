import type { DatabaseSync } from 'node:sqlite'
import type { LiveReference } from './delete-reference-guards.js'

/**
 * Material inventory conflicts. Deletion is safe only when cached stock and
 * locked stock are canonical zeroes and every batch is exhausted and inactive.
 * Corrupt or unknown numeric/status facts fail closed.
 */
export function findMaterialInventoryConflicts(
  db: DatabaseSync,
  materialId: string,
): LiveReference[] {
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
  for (const row of inventoryRows) refs.push({ kind: 'inventory', id: row.id })

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
  for (const row of batches) refs.push({ kind: 'batch', id: row.id })
  return refs
}

/**
 * Live material references. Historical stock logs, immutable allocations and
 * completed/cancelled/refunded/deleted business records do not block deletion.
 * Unknown states, orphan outbound items and malformed ownership flags do.
 */
export function findMaterialLiveReferences(
  db: DatabaseSync,
  materialId: string,
): LiveReference[] {
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

  // Transfer and ordinary inbound share inbound_records.
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
