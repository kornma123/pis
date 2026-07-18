import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: Awaited<ReturnType<typeof buildTestApp>>
let db: Awaited<ReturnType<typeof getDb>>
let adminToken: string

function seedLocation(id: string) {
  db.prepare(`
    INSERT INTO locations (id, code, name, type, zone, status, is_deleted)
    VALUES (?, ?, ?, 'shelf', '测试区', 1, 0)
  `).run(id, `LOC-${id}`, `库位-${id}`)
}

function seedMaterial(id: string) {
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, status, is_deleted)
    VALUES (?, ?, ?, '盒', 'CAT-LOCATION-GUARD', 1, 0)
  `).run(id, `MAT-${id}`, `物料-${id}`)
}

function row(table: string, id: string) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
}

async function deleteLocation(id: string) {
  const request = (await import('supertest')).default
  return request(app)
    .delete(`/api/v1/locations/${id}`)
    .set('Authorization', `Bearer ${adminToken}`)
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const locationRoutes = (await import('../src/routes/locations-v1.1.js')).default

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/locations', router: locationRoutes },
  ])
  adminToken = await loginAdmin(app)
})

describe('DELETE /api/v1/locations/:id inventory reference guard', () => {
  it('rejects a location with positive inventory and leaves business rows unchanged', async () => {
    const locationId = 'LOC-GUARD-STOCK'
    const materialId = 'MAT-GUARD-STOCK'
    const inventoryId = 'INV-GUARD-STOCK'
    seedLocation(locationId)
    seedMaterial(materialId)
    db.prepare(`
      INSERT INTO inventory (id, material_id, stock, locked_stock, location_id)
      VALUES (?, ?, 3, 0, ?)
    `).run(inventoryId, materialId, locationId)
    const before = {
      location: row('locations', locationId),
      inventory: row('inventory', inventoryId),
    }

    const response = await deleteLocation(locationId)

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ success: false, error: { code: 'CONFLICT' } })
    expect({
      location: row('locations', locationId),
      inventory: row('inventory', inventoryId),
    }).toEqual(before)
  })

  it('rejects a location referenced by a remaining batch and leaves all rows unchanged', async () => {
    const locationId = 'LOC-GUARD-BATCH'
    const materialId = 'MAT-GUARD-BATCH'
    const inboundId = 'IN-GUARD-BATCH'
    const batchId = 'BAT-GUARD-BATCH'
    seedLocation(locationId)
    seedMaterial(materialId)
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_no, quantity, unit, location_id, operator, status, is_deleted)
      VALUES (?, 'IB-GUARD-BATCH', 'purchase', ?, 'B-GUARD-BATCH', 7, '盒', ?, 'admin', 'completed', 0)
    `).run(inboundId, materialId, locationId)
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, inbound_id, status)
      VALUES (?, ?, 'B-GUARD-BATCH', 7, 7, ?, 1)
    `).run(batchId, materialId, inboundId)
    const before = {
      location: row('locations', locationId),
      inbound: row('inbound_records', inboundId),
      batch: row('batches', batchId),
    }

    const response = await deleteLocation(locationId)

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ success: false, error: { code: 'CONFLICT' } })
    expect({
      location: row('locations', locationId),
      inbound: row('inbound_records', inboundId),
      batch: row('batches', batchId),
    }).toEqual(before)
  })

  it('allows deletion when the only referenced batch has no remaining quantity', async () => {
    const locationId = 'LOC-GUARD-SPENT'
    const materialId = 'MAT-GUARD-SPENT'
    const inboundId = 'IN-GUARD-SPENT'
    const batchId = 'BAT-GUARD-SPENT'
    seedLocation(locationId)
    seedMaterial(materialId)
    db.prepare(`
      INSERT INTO inbound_records
        (id, inbound_no, type, material_id, batch_no, quantity, unit, location_id, operator, status, is_deleted)
      VALUES (?, 'IB-GUARD-SPENT', 'purchase', ?, 'B-GUARD-SPENT', 5, '盒', ?, 'admin', 'completed', 0)
    `).run(inboundId, materialId, locationId)
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, inbound_id, status)
      VALUES (?, ?, 'B-GUARD-SPENT', 5, 0, ?, 0)
    `).run(batchId, materialId, inboundId)
    const beforeInbound = row('inbound_records', inboundId)
    const beforeBatch = row('batches', batchId)

    const response = await deleteLocation(locationId)

    expect(response.status).toBe(200)
    expect(row('locations', locationId)).toMatchObject({ id: locationId, is_deleted: 1 })
    expect(row('inbound_records', inboundId)).toEqual(beforeInbound)
    expect(row('batches', batchId)).toEqual(beforeBatch)
  })

  it('allows deletion when the only inventory row has zero stock', async () => {
    const locationId = 'LOC-GUARD-ZERO-STOCK'
    const materialId = 'MAT-GUARD-ZERO-STOCK'
    const inventoryId = 'INV-GUARD-ZERO-STOCK'
    seedLocation(locationId)
    seedMaterial(materialId)
    db.prepare(`
      INSERT INTO inventory (id, material_id, stock, locked_stock, location_id)
      VALUES (?, ?, 0, 0, ?)
    `).run(inventoryId, materialId, locationId)
    const beforeInventory = row('inventory', inventoryId)

    const response = await deleteLocation(locationId)

    expect(response.status).toBe(200)
    expect(row('locations', locationId)).toMatchObject({ id: locationId, is_deleted: 1 })
    expect(row('inventory', inventoryId)).toEqual(beforeInventory)
  })

  it('soft-deletes a truly empty location', async () => {
    const locationId = 'LOC-GUARD-EMPTY'
    seedLocation(locationId)
    const before = row('locations', locationId)

    const response = await deleteLocation(locationId)
    const after = row('locations', locationId)

    expect(response.status).toBe(200)
    expect(after).toMatchObject({ id: locationId, is_deleted: 1 })
    expect({ ...after, is_deleted: before.is_deleted, updated_at: before.updated_at }).toEqual(before)
  })

  it('returns 404 for an unknown location without changing unrelated rows', async () => {
    const controlLocationId = 'LOC-GUARD-UNKNOWN-CONTROL'
    seedLocation(controlLocationId)
    const before = row('locations', controlLocationId)

    const response = await deleteLocation('LOC-GUARD-UNKNOWN')

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
    expect(row('locations', controlLocationId)).toEqual(before)
    expect((await deleteLocation(controlLocationId)).status).toBe(200)
  })

  it('serializes concurrent deletion attempts for the same empty location', async () => {
    const locationId = 'LOC-GUARD-CONCURRENT'
    seedLocation(locationId)

    const responses = await Promise.all([
      deleteLocation(locationId),
      deleteLocation(locationId),
    ])

    expect(responses.map(response => response.status).sort()).toEqual([200, 404])
    expect(row('locations', locationId)).toMatchObject({ id: locationId, is_deleted: 1 })
  })

  it('opens an immediate write transaction before deleting an empty location', async () => {
    const locationId = 'LOC-GUARD-IMMEDIATE'
    seedLocation(locationId)
    const execSpy = vi.spyOn(db, 'exec')

    try {
      const response = await deleteLocation(locationId)

      expect(response.status).toBe(200)
      expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    } finally {
      execSpy.mockRestore()
    }
  })

  it('rolls back an unexpected database error and remains retryable', async () => {
    const locationId = 'LOC-GUARD-ERROR'
    const triggerName = 'location_guard_forced_error'
    const probeTableName = 'location_delete_rollback_probe'
    seedLocation(locationId)
    const before = row('locations', locationId)
    db.exec(`CREATE TABLE ${probeTableName} (location_id TEXT NOT NULL)`)
    db.exec(`
      CREATE TRIGGER ${triggerName}
      AFTER UPDATE OF is_deleted ON locations
      WHEN OLD.id = '${locationId}'
      BEGIN
        INSERT INTO ${probeTableName} (location_id) VALUES (OLD.id);
        SELECT RAISE(FAIL, 'forced location delete failure');
      END
    `)

    try {
      const response = await deleteLocation(locationId)

      expect(response.status).toBe(500)
      expect(response.body).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } })
      expect(response.body.error.message).not.toContain('forced location delete failure')
      expect(row('locations', locationId)).toEqual(before)
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${probeTableName}`).get()).toMatchObject({ count: 0 })

      db.exec(`DROP TRIGGER ${triggerName}`)
      const retry = await deleteLocation(locationId)
      expect(retry.status).toBe(200)
      expect(row('locations', locationId)).toMatchObject({ id: locationId, is_deleted: 1 })
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`)
      db.exec(`DROP TABLE IF EXISTS ${probeTableName}`)
    }
  })
})
