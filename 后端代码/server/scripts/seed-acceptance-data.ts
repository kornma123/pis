/**
 * Synthetic acceptance seed for the current COREONE schema.
 *
 * The seed deliberately uses the same inventory transaction primitives as the
 * HTTP writers. It never writes inventory.stock as a second source of truth.
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { initializeDatabase, getDatabase } from '../src/database/DatabaseManager.js'
import {
  applyInventoryPlan,
  assertInventoryConserved,
  planBatchDeltas,
  planInventoryDeductions,
  replaceAllocationFacts,
} from '../src/services/inventory-transactions.js'

const IDS = {
  category: 'ACCEPT-CAT-001',
  supplier: 'ACCEPT-SUP-001',
  location: 'ACCEPT-LOC-001',
  material: 'ACCEPT-MAT-001',
  inventory: 'ACCEPT-INV-001',
  inbound1: 'ACCEPT-IN-001',
  inbound2: 'ACCEPT-IN-002',
  batch1: 'ACCEPT-BATCH-001',
  batch2: 'ACCEPT-BATCH-002',
  outbound: 'ACCEPT-OUT-001',
} as const

export async function seedAcceptanceData(options: { quiet?: boolean } = {}): Promise<void> {
  initializeDatabase()
  const db = getDatabase()
  const log = (...values: unknown[]) => {
    if (!options.quiet) console.log(...values)
  }

  const existing = db.prepare('SELECT 1 AS ok FROM materials WHERE id = ?').get(IDS.material) as { ok: number } | undefined
  if (existing?.ok) {
    assertInventoryConserved(db, IDS.material)
    log('Acceptance inventory seed already exists and is conserved.')
    return
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      INSERT INTO material_categories (id, code, name, level, status)
      VALUES (?, 'ACCEPT-CAT', '验收测试分类', 1, 1)
    `).run(IDS.category)
    db.prepare(`
      INSERT INTO suppliers (id, code, name, status)
      VALUES (?, 'ACCEPT-SUP', '验收测试供应商', 1)
    `).run(IDS.supplier)
    db.prepare(`
      INSERT INTO locations (id, code, name, zone, status)
      VALUES (?, 'ACCEPT-LOC', '验收测试库位', 'ACCEPT', 1)
    `).run(IDS.location)
    db.prepare(`
      INSERT INTO materials
        (id, code, name, spec, unit, category_id, supplier_id, price, location_id, status)
      VALUES (?, 'MAT-ACCEPT-001', '验收测试试剂盒', '50次/盒', '盒', ?, ?, 50, ?, 1)
    `).run(IDS.material, IDS.category, IDS.supplier, IDS.location)
    db.prepare(`
      INSERT INTO inventory (id, material_id, stock, locked_stock, location_id)
      VALUES (?, ?, 0, 0, ?)
    `).run(IDS.inventory, IDS.material, IDS.location)

    const receipts = [
      {
        inboundId: IDS.inbound1,
        inboundNo: 'IB-ACCEPT-001',
        batchId: IDS.batch1,
        batchNo: 'ACCEPT-LOT-001',
        quantity: 20,
        expiryDate: '2027-01-01',
      },
      {
        inboundId: IDS.inbound2,
        inboundNo: 'IB-ACCEPT-002',
        batchId: IDS.batch2,
        batchNo: 'ACCEPT-LOT-002',
        quantity: 10,
        expiryDate: '2027-06-01',
      },
    ]

    for (const receipt of receipts) {
      db.prepare(`
        INSERT INTO inbound_records
          (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount,
           supplier_id, location_id, expiry_date, operator, status, remark)
        VALUES (?, ?, 'purchase', ?, ?, ?, ?, '盒', 50, ?, ?, ?, ?, 'acceptance-seed', 'completed', ?)
      `).run(
        receipt.inboundId,
        receipt.inboundNo,
        IDS.material,
        receipt.batchId,
        receipt.batchNo,
        receipt.quantity,
        receipt.quantity * 50,
        IDS.supplier,
        IDS.location,
        receipt.expiryDate,
        'LOC-001 synthetic acceptance seed',
      )

      const plan = planBatchDeltas(db, [{
        materialId: IDS.material,
        batchId: receipt.batchId,
        quantityDelta: receipt.quantity,
        remainingDelta: receipt.quantity,
        ownerLineId: receipt.inboundId,
        create: {
          id: receipt.batchId,
          materialId: IDS.material,
          batchNo: receipt.batchNo,
          quantity: receipt.quantity,
          remaining: receipt.quantity,
          expiryDate: receipt.expiryDate,
          inboundId: receipt.inboundId,
          inboundPrice: 50,
          supplierId: IDS.supplier,
        },
      }])
      applyInventoryPlan(db, plan)
      replaceAllocationFacts(db, {
        operationKind: 'inbound',
        ownerId: receipt.inboundId,
        direction: 'in',
        allocations: plan.allocations,
      })
      const allocation = plan.allocations[0]
      db.prepare(`
        INSERT INTO stock_logs
          (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'inbound', ?, ?, ?, ?, ?, 'inbound', 'acceptance-seed')
      `).run(
        `ACCEPT-LOG-${receipt.inboundId}`,
        IDS.material,
        receipt.quantity,
        allocation.inventoryBefore,
        allocation.inventoryAfter,
        receipt.inboundId,
      )
    }

    db.prepare(`
      INSERT INTO outbound_records
        (id, outbound_no, type, total_cost, operator, status, remark)
      VALUES (?, 'OB-ACCEPT-001', 'direct', 750, 'acceptance-seed', 'completed', ?)
    `).run(IDS.outbound, 'LOC-001 synthetic acceptance seed')

    const outboundPlan = planInventoryDeductions(db, [{
      materialId: IDS.material,
      quantity: 15,
      ownerLineId: null,
    }])
    applyInventoryPlan(db, outboundPlan)

    for (let index = 0; index < outboundPlan.allocations.length; index++) {
      const allocation = outboundPlan.allocations[index]
      const itemId = `ACCEPT-OUT-ITEM-${index + 1}`
      allocation.ownerLineId = itemId
      db.prepare(`
        INSERT INTO outbound_items
          (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage)
        VALUES (?, ?, ?, ?, ?, ?, '盒', 50, ?, 'self')
      `).run(
        itemId,
        IDS.outbound,
        IDS.material,
        allocation.batchId,
        allocation.batchNo,
        allocation.quantity,
        allocation.quantity * 50,
      )
      db.prepare(`
        INSERT INTO stock_logs
          (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
        VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', 'acceptance-seed')
      `).run(
        `ACCEPT-OUT-LOG-${index + 1}`,
        IDS.material,
        -allocation.quantity,
        allocation.inventoryBefore,
        allocation.inventoryAfter,
        IDS.outbound,
      )
    }
    replaceAllocationFacts(db, {
      operationKind: 'outbound',
      ownerId: IDS.outbound,
      direction: 'out',
      allocations: outboundPlan.allocations,
    })
    assertInventoryConserved(db, IDS.material)
    db.exec('COMMIT')
    log('Acceptance seed created: 30 received, 15 FEFO outbound, 15 remaining.')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  seedAcceptanceData()
    .then(() => {
      console.log('Acceptance seed completed.')
    })
    .catch((error) => {
      console.error('Acceptance seed failed:', error)
      process.exitCode = 1
    })
}
