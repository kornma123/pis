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
      SELECT
        i.material_id,
        i.stock,
        COALESCE(SUM(CASE WHEN b.status = 1 AND b.remaining > 0 THEN b.remaining ELSE 0 END), 0) AS batch_stock
      FROM inventory i
      LEFT JOIN batches b ON b.material_id = i.material_id
      GROUP BY i.material_id, i.stock
    `).all() as Array<{ material_id: string; stock: number; batch_stock: number }>

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.stock === row.batch_stock)).toBe(true)
    expect((db.prepare(`
      SELECT COUNT(*) AS count
      FROM outbound_items oi
      LEFT JOIN inventory_transaction_allocations a
        ON a.operation_kind = 'outbound'
       AND a.owner_id = oi.outbound_id
       AND a.owner_line_id = oi.id
       AND a.batch_id = oi.batch_id
       AND a.is_reversed = 0
      WHERE a.id IS NULL
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
