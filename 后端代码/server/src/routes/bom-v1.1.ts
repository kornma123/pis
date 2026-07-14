import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { writeBomVersionSnapshot, getLatestBomVersionSnapshot, buildBomVersionSnapshot } from '../utils/bom-version.js'
import { parseFiniteNonNegativeNumber } from '../utils/numeric-input.js'

const router = Router()
const requireBomWrite = requirePermission('bom', 'W')

function normalizeBomMaterialUsage(materials: unknown[]): Record<string, unknown>[] | null {
  const normalized: Record<string, unknown>[] = []
  for (const material of materials) {
    if (material === null || typeof material !== 'object' || Array.isArray(material)) return null
    const item = material as Record<string, unknown>
    const usagePerSample = parseFiniteNonNegativeNumber(item.usagePerSample)
    // Keep the BOM write boundary fail-closed even if the shared parser's
    // contract regresses in a future change.
    if (usagePerSample === null || !Number.isFinite(usagePerSample) || usagePerSample < 0) return null
    normalized.push({ ...item, usagePerSample })
  }
  return normalized
}

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

    // 统计每个BOM的物料数量
    const counts = db.prepare('SELECT bom_id, COUNT(*) as cnt FROM bom_items GROUP BY bom_id').all() as any[]
    const countMap = new Map(counts.map((c: any) => [c.bom_id, c.cnt]))

    successList(res, list.map((r: any) => ({
      id: r.id, code: r.code, name: r.name, version: r.version, type: r.type,
      serviceId: r.service_id, materialCount: countMap.get(r.id) || 0, supportableSamples: r.supportable_samples,
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
      LEFT JOIN materials m ON bi.material_id = m.id AND m.is_deleted = 0
      LEFT JOIN inventory i ON m.id = i.material_id
      WHERE bi.bom_id = ?
    `).all(id) as any[]

    const materials = items.map((i: any) => ({
      id: i.material_id, name: i.name, spec: i.spec,
      usagePerSample: i.usage_per_sample, unit: i.unit,
      price: i.price, stock: i.stock, costRatio: 0,
    }))

    // 材料成本口径：主料与辅料用量一并累加（不按 is_alternative 过滤）。
    // 注意：字段名 is_alternative/main_item_id 易被误读为"主料—替代料=二选一"，实则本仓
    //   语义为 主料(0)/辅料(1)，辅料（通用试剂/耗材/质控）与主料**同时消耗**（"都要用"），
    //   故必须计入成本；勿据字段名加 `WHERE is_alternative=0` 而漏计辅料（会低估成本）。
    //   语义锚点：outbound-v1.1.ts（辅料缺货跳过、主料缺阻断）+ tests/p1-01-bom-auxiliary-skip、
    //   tests/bom-cost-auxiliary-included。
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

router.post('/', authenticateToken, requireBomWrite, (req, res) => {
  try {
    const { code, name, type, serviceId, description, supportableSamples, materials } = req.body
    if (!code || !name || !type) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }
    if (materials !== undefined && !Array.isArray(materials)) {
      error(res, 'Invalid materials', 'INVALID_PARAMETER', 400); return
    }
    const list = normalizeBomMaterialUsage(materials ?? [])
    if (list === null) {
      error(res, 'Invalid usage_per_sample', 'INVALID_PARAMETER', 400); return
    }

    const db = getDatabase()
    const id = uuidv4()
    const version = 'v1.0'
    const operator = (req as any).user?.username

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO boms (id, code, name, version, type, service_id, description, supportable_samples, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(id, code, name, version, type, serviceId || null, description || null, supportableSamples || null)

      for (const m of list) {
        db.prepare('INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit) VALUES (?, ?, ?, ?, ?)')
          .run(uuidv4(), id, m.materialId, m.usagePerSample, m.unit)
      }

      // 落初始版本快照
      writeBomVersionSnapshot(db, id, null, operator)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK'); throw e
    }

    success(res, { id }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Code version exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', authenticateToken, requireBomWrite, (req, res) => {
  try {
    const { id } = req.params
    const { name, description, supportableSamples, materials } = req.body
    const db = getDatabase()

    const existing = db.prepare('SELECT * FROM boms WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    if (materials !== undefined && !Array.isArray(materials)) {
      error(res, 'Invalid materials', 'INVALID_PARAMETER', 400); return
    }
    const normalizedMaterials = materials === undefined
      ? undefined
      : normalizeBomMaterialUsage(materials)
    if (normalizedMaterials === null) {
      error(res, 'Invalid usage_per_sample', 'INVALID_PARAMETER', 400); return
    }
    const hasMaterials = normalizedMaterials !== undefined

    const versionParts = existing.version.replace('v', '').split('.').map(Number)
    versionParts[1] = (versionParts[1] || 0) + 1
    const newVersion = `v${versionParts[0]}.${versionParts[1]}`
    const operator = (req as any).user?.username
    // 变更前快照（无历史版本则即时构建当前状态作为 before）
    const previousSnapshot = getLatestBomVersionSnapshot(db, id) || buildBomVersionSnapshot(db, id)

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE boms SET name = ?, version = ?, description = ?, supportable_samples = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(name || existing.name, newVersion, description || existing.description, supportableSamples || existing.supportable_samples, id)

      if (hasMaterials) {
        db.prepare('DELETE FROM bom_items WHERE bom_id = ?').run(id)
        for (const m of normalizedMaterials) {
          db.prepare('INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit) VALUES (?, ?, ?, ?, ?)')
            .run(uuidv4(), id, m.materialId, m.usagePerSample, m.unit)
        }
      }

      // 落新版本快照（BOM 直接编辑固定 future_only，不触发历史重算）
      writeBomVersionSnapshot(db, id, previousSnapshot, operator, { effectiveScope: 'future_only' })
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK'); throw e
    }

    success(res, { id, version: newVersion }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', authenticateToken, requireBomWrite, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM boms WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    db.prepare('UPDATE boms SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

export default router
