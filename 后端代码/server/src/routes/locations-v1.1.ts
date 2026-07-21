import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { closeDatabase, getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { findLocationLiveReferences, recoverFailedDeleteTransaction } from '../utils/delete-reference-guards.js'
import {
  assertLocationCapacityFits,
  locationCapacityError,
  parseLocationCapacityInput,
} from '../utils/location-capacity.js'

const router = Router()

const requireLocationRead = requirePermission('locations', 'R')
// 写权限读 DB 矩阵（locations W = admin/warehouse_manager，可在角色权限页改）
const requireLocationWrite = requirePermission('locations', 'W')

router.get('/', authenticateToken, requireLocationRead, (req, res) => {
  try {
    let { page = 1, pageSize = 20, zone, status, type } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (zone) { where += ' AND zone = ?'; params.push(zone) }
    if (type) { where += ' AND type = ?'; params.push(type) }
    if (status) { where += ' AND status = ?'; params.push(status === 'active' ? 1 : 0) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM locations WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT * FROM locations WHERE ${where} ORDER BY zone, name LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    // P1-06: used 派生自该库位下库存合计（inventory.location_id 关联），不再读从不被写的 locations.used 装饰列
    const usedStmt = db.prepare('SELECT COALESCE(SUM(stock), 0) as used FROM inventory WHERE location_id = ?')
    successList(res, list.map((r: any) => {
      const used = Number((usedStmt.get(r.id) as any)?.used || 0)
      return {
        id: r.id, code: r.code, name: r.name, type: r.type, parentId: r.parent_id, zone: r.zone, shelf: r.shelf, position: r.position,
        capacity: r.capacity, used, status: r.status === 1 ? 'active' : 'inactive',
      }
    }), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/tree', authenticateToken, requireLocationRead, (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT id, code, name, type, parent_id as parentId, zone, shelf, position FROM locations WHERE is_deleted = 0 ORDER BY zone, name').all() as any[]

    const buildTree = (parentId: string | null): any[] => {
      return rows
        .filter((r: any) => (r.parentId || null) === parentId)
        .map((r: any) => ({
          id: r.id, code: r.code, name: r.name, type: r.type, zone: r.zone,
          children: buildTree(r.id),
          isLeaf: !rows.some((child: any) => child.parentId === r.id),
        }))
    }

    success(res, buildTree(null))
  } catch (err: any) { error(res, err.message) }
})

function generateLocationCode(db: any): string {
  const max = db.prepare("SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) as max FROM locations WHERE code LIKE 'LOC-%'").get() as any
  const num = (Number(max?.max) || 0) + 1
  return `LOC-${String(num).padStart(5, '0')}`
}

router.post('/', authenticateToken, requireLocationWrite, (req, res) => {
  try {
    const { name, type, parentId, zone, shelf, position, capacity } = req.body
    if (!name || !zone) { error(res, 'Name and zone required', 'INVALID_PARAMETER', 400); return }
    // 容量是 canonical 有限非负安全整数；0 是合法零容量（不能用 || 默认值吞掉）；缺省 999999（有限硬上限，非无限哨兵）
    let normalizedCapacity = 999999
    if (capacity !== undefined && capacity !== null) {
      const parsed = parseLocationCapacityInput(capacity)
      if (parsed === null) { error(res, 'Capacity must be a finite non-negative safe integer', 'INVALID_PARAMETER', 400); return }
      normalizedCapacity = parsed
    }
    const db = getDatabase()
    const id = uuidv4()
    const finalCode = generateLocationCode(db)
    db.prepare('INSERT INTO locations (id, code, name, type, parent_id, zone, shelf, position, capacity, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, finalCode, name, type || 'shelf', parentId || null, zone, shelf || null, position || null, normalizedCapacity)
    success(res, { id, code: finalCode }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Code exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', authenticateToken, requireLocationWrite, (req, res) => {
  try {
    const { id } = req.params
    const data = req.body
    const db = getDatabase()
    // 容量修改走 fail-closed 容量门：输入须为 canonical 有限非负安全整数（400），
    // 并在 BEGIN IMMEDIATE 锁内按严格占用判定「不得低于当前占用」（409，零部分态）。
    let normalizedCapacity: number | undefined
    if (data.capacity !== undefined) {
      const parsed = parseLocationCapacityInput(data.capacity)
      if (parsed === null) { error(res, 'Capacity must be a finite non-negative safe integer', 'INVALID_PARAMETER', 400); return }
      normalizedCapacity = parsed
    }
    const capacityChanged = normalizedCapacity !== undefined
    const existing = db.prepare('SELECT * FROM locations WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    const fields: string[] = []; const params: any[] = []
    if (data.code !== undefined) { fields.push('code = ?'); params.push(data.code) }
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type) }
    if (data.parentId !== undefined) { fields.push('parent_id = ?'); params.push(data.parentId || null) }
    if (data.zone !== undefined) { fields.push('zone = ?'); params.push(data.zone) }
    if (data.shelf !== undefined) { fields.push('shelf = ?'); params.push(data.shelf) }
    if (data.position !== undefined) { fields.push('position = ?'); params.push(data.position) }
    if (capacityChanged) { fields.push('capacity = ?'); params.push(normalizedCapacity) }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status === 'active' ? 1 : 0) }

    if (capacityChanged) {
      // 此处 normalizedCapacity 必为 number（capacityChanged 即由其 !== undefined 推出）
      const newCapacity = normalizedCapacity as number
      db.exec('BEGIN IMMEDIATE')
      try {
        const locked = db.prepare('SELECT * FROM locations WHERE id = ? AND is_deleted = 0').get(id)
        if (!locked) {
          db.exec('ROLLBACK')
          error(res, 'Not found', 'NOT_FOUND', 404)
          return
        }
        if (fields.length > 0) {
          params.push(id)
          db.prepare(`UPDATE locations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params)
        }
        // 锁内严格占用重读：used > 新容量 → 拒绝并回滚（精确等于放行）
        assertLocationCapacityFits(db, id, newCapacity)
        db.exec('COMMIT')
      } catch (txErr) {
        db.exec('ROLLBACK')
        throw txErr
      }
      success(res, { id }, 'Updated')
      return
    }

    if (fields.length > 0) { params.push(id); db.prepare(`UPDATE locations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params) }
    success(res, { id }, 'Updated')
  } catch (err: any) {
    const capacityError = locationCapacityError(err)
    if (capacityError) { error(res, capacityError.message, capacityError.code, capacityError.statusCode); return }
    error(res, err.message)
  }
})

router.delete('/:id', authenticateToken, requireLocationWrite, (req, res) => {
  let db: ReturnType<typeof getDatabase> | undefined
  let transactionOpen = false
  try {
    const { id } = req.params
    db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true

    const existing = db.prepare('SELECT * FROM locations WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Not found', 'NOT_FOUND', 404)
      return
    }

    const references = db.prepare(`
      SELECT
        EXISTS(
          SELECT 1
          FROM inventory
          WHERE location_id = ? AND COALESCE(stock, 0) > 0
        ) AS has_stock,
        EXISTS(
          SELECT 1
          FROM batches b
          INNER JOIN inbound_records ir ON ir.id = b.inbound_id
          WHERE ir.location_id = ? AND COALESCE(b.remaining, 0) > 0
        ) AS has_remaining_batch
    `).get(id, id) as { has_stock: number; has_remaining_batch: number }

    if (references.has_stock || references.has_remaining_batch) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Location still has inventory or remaining batches', 'CONFLICT', 409)
      return
    }

    // 锁内重读在途运营引用：committed-race 防线
    if (findLocationLiveReferences(db, id).length > 0) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Location has live material or equipment assignments', 'ENTITY_IN_USE', 409)
      return
    }

    db.prepare('UPDATE locations SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    db.exec('COMMIT')
    transactionOpen = false
    success(res, null, 'Deleted')
  } catch (err: any) {
    if (transactionOpen && db) {
      if (!recoverFailedDeleteTransaction(db, closeDatabase)) {
        error(res, 'Delete transaction recovery failed', 'INTERNAL_ERROR', 500)
        return
      }
    }
    error(res, err.message)
  }
})

export default router
