import { beforeAll, describe, expect, it } from 'vitest'

let db: any
let seedAcceptanceData: (options?: { quiet?: boolean }) => Promise<void>

beforeAll(async () => {
  const manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
  ;({ seedAcceptanceData } = await import('../scripts/seed-acceptance-data.js'))
})

describe('LOC-001 development seed inventory contract', () => {
  it('seeds the current schema without creating a second inventory truth', async () => {
    await seedAcceptanceData({ quiet: true })

    const rows = db.prepare(`
      WITH batch_totals AS (
        SELECT material_id, COALESCE(SUM(CASE WHEN status = 1 AND remaining > 0 THEN remaining ELSE 0 END), 0) AS batch_stock
        FROM batches
        GROUP BY material_id
      ), position_totals AS (
        SELECT material_id, SUM(quantity) AS position_stock
        FROM inventory_positions
        GROUP BY material_id
      )
      SELECT
        i.material_id,
        i.stock,
        COALESCE(b.batch_stock, 0) AS batch_stock,
        COALESCE(p.position_stock, 0) AS position_stock
      FROM inventory i
      LEFT JOIN batch_totals b ON b.material_id = i.material_id
      LEFT JOIN position_totals p ON p.material_id = i.material_id
    `).all() as Array<{ material_id: string; stock: number; batch_stock: number; position_stock: number }>

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.stock === row.batch_stock && row.stock === row.position_stock)).toBe(true)
    expect((db.prepare(`
      SELECT COUNT(*) AS count
      FROM outbound_items oi
      LEFT JOIN inventory_transaction_allocations a
        ON a.operation_kind = 'outbound'
       AND a.owner_id = oi.outbound_id
       AND a.owner_line_id = oi.id
       AND a.batch_id = oi.batch_id
      WHERE a.id IS NULL OR a.location_id IS NULL
    `).get() as { count: number }).count).toBe(0)
  })

  it('is idempotent and preserves the same derived cache on retry', async () => {
    const before = db.prepare(`
      SELECT material_id, stock
      FROM inventory
      ORDER BY material_id
    `).all()

    await seedAcceptanceData({ quiet: true })

    expect(db.prepare(`
      SELECT material_id, stock
      FROM inventory
      ORDER BY material_id
    `).all()).toEqual(before)
  })
})
