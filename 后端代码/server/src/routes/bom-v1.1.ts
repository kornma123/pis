import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20, type } = req.query
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (type) { where += ' AND type = ?'; params.push(type) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM boms WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT * FROM boms WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, code: r.code, name: r.name, version: r.version, type: r.type,
      serviceId: r.service_id, materialCount: 0, supportableSamples: r.supportable_samples,
      unitCost: r.unit_cost, status: r.status === 1 ? 'active' : 'inactive',
      createdAt: r.created_at, updatedAt: r.updated_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const bom = db.prepare('SELECT * FROM boms WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!bom) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    const items = db.prepare(`
      SELECT bi.*, m.name, m.spec, m.price, COALESCE(i.stock, 0) as stock
      FROM bom_items bi
      LEFT JOIN materials m ON bi.material_id = m.id
      LEFT JOIN inventory i ON m.id = i.material_id
      WHERE bi.bom_id = ?
    `).all(id) as any[]

    const materials = items.map((i: any) => ({
      id: i.material_id, name: i.name, spec: i.spec,
      usagePerSample: i.usage_per_sample, unit: i.unit,
      price: i.price, stock: i.stock, costRatio: 0,
    }))

    const totalCost = materials.reduce((sum: number, m: any) => sum + (m.price || 0) * m.usagePerSample, 0)
    materials.forEach((m: any) => { m.costRatio = totalCost > 0 ? (m.price || 0) * m.usagePerSample / totalCost : 0 })

    success(res, {
      id: bom.id, code: bom.code, name: bom.name, version: bom.version,
      type: bom.type, serviceId: bom.service_id, supportableSamples: bom.supportable_samples,
      unitCost: bom.unit_cost, status: bom.status === 1 ? 'active' : 'inactive',
      materials,
      versionHistory: [{ version: bom.version, updatedAt: bom.updated_at, changeLog: 'Current' }],
    })
  } catch (err: any) { error(res, err.message) }
})

router.post('/', (req, res) => {
  try {
    const { code, name, type, serviceId, description, supportableSamples, materials } = req.body
    if (!code || !name || !type || !Array.isArray(materials) || materials.length === 0) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const id = uuidv4()
    const version = 'v1.0'

    db.prepare('INSERT INTO boms (id, code, name, version, type, service_id, description, supportable_samples, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, code, name, version, type, serviceId || null, description || null, supportableSamples || null)

    for (const m of materials) {
      const itemId = uuidv4()
      db.prepare('INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit) VALUES (?, ?, ?, ?, ?)')
        .run(itemId, id, m.materialId, m.usagePerSample, m.unit)
    }

    success(res, { id }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Code version exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', (req, res) => {
  try {
    const { id } = req.params
    const { name, description, supportableSamples, materials } = req.body
    const db = getDatabase()

    const existing = db.prepare('SELECT * FROM boms WHERE id = ?').get(id) as any
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    const versionParts = existing.version.replace('v', '').split('.').map(Number)
    versionParts[1] = (versionParts[1] || 0) + 1
    const newVersion = `v${versionParts[0]}.${versionParts[1]}`

    db.prepare('UPDATE boms SET name = ?, version = ?, description = ?, supportable_samples = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(name || existing.name, newVersion, description || existing.description, supportableSamples || existing.supportable_samples, id)

    if (Array.isArray(materials)) {
      db.prepare('DELETE FROM bom_items WHERE bom_id = ?').run(id)
      for (const m of materials) {
        const itemId = uuidv4()
        db.prepare('INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit) VALUES (?, ?, ?, ?, ?)')
          .run(itemId, id, m.materialId, m.usagePerSample, m.unit)
      }
    }

    success(res, { id, version: newVersion }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    db.prepare('UPDATE boms SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

export default router
