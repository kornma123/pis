import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: any
let findMaterialInventoryConflicts: typeof import('../src/utils/material-delete-reference-guards.js').findMaterialInventoryConflicts

beforeAll(async () => {
  const manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
  ;({ findMaterialInventoryConflicts } = await import('../src/utils/material-delete-reference-guards.js'))
})

beforeEach(() => {
  db.exec(`
    DELETE FROM inventory_positions;
    DELETE FROM inventory_position_tombstones;
    DELETE FROM batches;
    DELETE FROM inventory;
    DELETE FROM materials;
    DELETE FROM material_categories;
    DELETE FROM locations;
  `)
  db.exec(`
    INSERT INTO material_categories (id, code, name, level)
      VALUES ('DEL-CAT', 'DEL-CAT', 'delete guard', 1);
    INSERT INTO locations (id, code, name, type, zone, status)
      VALUES ('DEL-LOC', 'DEL-LOC', 'delete guard', 'shelf', 'D', 1);
    INSERT INTO materials (id, code, name, unit, category_id, batch_managed)
      VALUES ('DEL-MAT', 'DEL-MAT', 'delete guard', 'pcs', 'DEL-CAT', 0);
    INSERT INTO inventory (id, material_id, stock, locked_stock)
      VALUES ('DEL-INV', 'DEL-MAT', 0, 0);
  `)
})

describe('PIS-INV-G01 material delete position guard', () => {
  it('fails closed when a non-zero position exists even if the legacy cache says zero', () => {
    db.prepare(`
      INSERT INTO inventory_positions (id, material_id, batch_id, location_id, quantity)
      VALUES ('DEL-POS', 'DEL-MAT', NULL, 'DEL-LOC', 1)
    `).run()

    expect(findMaterialInventoryConflicts(db, 'DEL-MAT')).toContainEqual({
      kind: 'inventory_position',
      id: 'DEL-POS',
    })
  })

  it('does not invent a conflict after the position has been removed', () => {
    expect(findMaterialInventoryConflicts(db, 'DEL-MAT')).toEqual([])
  })
})
