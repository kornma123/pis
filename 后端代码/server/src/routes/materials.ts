import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

// 物料写入权限：仅 admin 可操作
const requireMaterialWrite = requirePermission('materials', 'W')

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, keyword, categoryId, supplierId, status } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(200, Number(pageSize) || 20))
    const db = getDatabase()

    let where = 'm.is_deleted = 0'
    const params: any[] = []

    if (keyword) { where += ' AND (m.name LIKE ? OR m.code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    if (categoryId) { where += ' AND m.category_id = ?'; params.push(categoryId) }
    if (supplierId) { where += ' AND m.supplier_id = ?'; params.push(supplierId) }
    if (status) { where += ' AND m.status = ?'; params.push(status === 'active' ? 1 : 0) }

    const countSql = `SELECT COUNT(*) as total FROM materials m WHERE ${where}`
    const count = (db.prepare(countSql).get(...params) as any)?.total || 0

    let sql = `
      SELECT m.*, c.name as category_name, s.name as supplier_name, l.name as location_name, COALESCE(i.stock, 0) as stock
      FROM materials m
      LEFT JOIN material_categories c ON m.category_id = c.id
      LEFT JOIN suppliers s ON m.supplier_id = s.id
      LEFT JOIN locations l ON m.location_id = l.id
      LEFT JOIN inventory i ON m.id = i.material_id
      WHERE ${where}
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(sql).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((row: any) => ({
      id: row.id, code: row.code, name: row.name, spec: row.spec, unit: row.unit,
      specQty: row.spec_qty, specUnit: row.spec_unit,
      price: row.price, stock: row.stock, minStock: row.min_stock, maxStock: row.max_stock,
      safetyStock: row.safety_stock, locationId: row.location_id, locationName: row.location_name,
      categoryId: row.category_id, categoryPath: row.category_name, supplierId: row.supplier_id,
      supplierName: row.supplier_name, status: row.status === 1 ? 'active' : 'inactive',
      remark: row.remark, createdAt: row.created_at, updatedAt: row.updated_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/next-code', (req, res) => {
  try {
    const { categoryId } = req.query
    if (!categoryId) { error(res, 'categoryId required', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const code = generateMaterialCode(db, categoryId as string)
    success(res, { code })
  } catch (err: any) { error(res, err.message) }
})

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()

    const row = db.prepare(`
      SELECT m.*, c.name as category_name, s.name as supplier_name, l.name as location_name, COALESCE(i.stock, 0) as stock
      FROM materials m
      LEFT JOIN material_categories c ON m.category_id = c.id AND c.is_deleted = 0
      LEFT JOIN suppliers s ON m.supplier_id = s.id AND s.is_deleted = 0
      LEFT JOIN locations l ON m.location_id = l.id AND l.is_deleted = 0
      LEFT JOIN inventory i ON m.id = i.material_id
      WHERE m.id = ? AND m.is_deleted = 0
    `).get(id) as any

    if (!row) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    const batches = db.prepare('SELECT * FROM batches WHERE material_id = ? AND status = 1 ORDER BY expiry_date').all(id) as any[]
    const stockLogs = db.prepare('SELECT * FROM stock_logs WHERE material_id = ? ORDER BY created_at DESC LIMIT 20').all(id) as any[]

    success(res, {
      id: row.id, code: row.code, name: row.name, spec: row.spec, unit: row.unit,
      price: row.price, stock: row.stock, minStock: row.min_stock, maxStock: row.max_stock,
      safetyStock: row.safety_stock, locationId: row.location_id, locationName: row.location_name,
      categoryId: row.category_id, categoryPath: row.category_name, supplierId: row.supplier_id,
      supplierName: row.supplier_name, status: row.status === 1 ? 'active' : 'inactive',
      remark: row.remark,
      batches: batches.map((b: any) => ({
        id: b.id, batchNo: b.batch_no, quantity: b.quantity,
        productionDate: b.production_date, expiryDate: b.expiry_date, inboundId: b.inbound_id,
      })),
      stockLogs: stockLogs.map((l: any) => ({
        id: l.id, type: l.type, quantity: l.quantity, beforeStock: l.before_stock,
        afterStock: l.after_stock, relatedId: l.related_id, operator: l.operator, createdAt: l.created_at,
      })),
      createdAt: row.created_at, updatedAt: row.updated_at,
    })
  } catch (err: any) { error(res, err.message) }
})

function generateMaterialCode(db: any, categoryId: string): string {
  const category = db.prepare('SELECT code FROM material_categories WHERE id = ? AND is_deleted = 0').get(categoryId) as any
  let prefix = 'MAT'
  if (category) {
    const c = Math.floor(Number(category.code) / 100)
    if (c === 1) prefix = 'REA'
    else if (c === 2) prefix = 'CON'
    else if (c === 3) prefix = 'DEV'
    else if (c === 4) prefix = 'HZP'
  }
  const max = db.prepare(`SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) as max FROM materials WHERE code LIKE ?`).get(`${prefix}-%`) as any
  const num = (Number(max?.max) || 0) + 1
  return `${prefix}-${String(num).padStart(5, '0')}`
}

router.get('/next-code', (req, res) => {
  try {
    const { categoryId } = req.query
    if (!categoryId) { error(res, 'categoryId required', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const code = generateMaterialCode(db, categoryId as string)
    success(res, { code })
  } catch (err: any) { error(res, err.message) }
})

router.post('/', requireMaterialWrite, (req, res) => {
  try {
    const { name, spec, unit, specQty, specUnit, categoryId, supplierId, price, minStock, maxStock, safetyStock, locationId, remark, code: userCode } = req.body
    if (!name || !unit || !categoryId) {
      error(res, 'Name, unit and category required', 'INVALID_PARAMETER', 400)
      return
    }

    const db = getDatabase()
    const id = uuidv4()
    let finalCode: string
    if (userCode) {
      const exists = db.prepare('SELECT 1 FROM materials WHERE code = ?').get(userCode)
      if (exists) { error(res, 'Code already exists', 'RESOURCE_CONFLICT', 409); return }
      finalCode = userCode
    } else {
      finalCode = generateMaterialCode(db, categoryId)
    }

    db.prepare(`
      INSERT INTO materials (id, code, name, spec, unit, spec_qty, spec_unit, category_id, supplier_id, price, min_stock, max_stock, safety_stock, location_id, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, finalCode, name, spec || null, unit, specQty || 0, specUnit || null, categoryId, supplierId || null, price || 0, minStock || 0, maxStock || 999999, safetyStock || 0, locationId || null, remark || null)

    const invId = uuidv4()
    db.prepare(`INSERT INTO inventory (id, material_id, stock, locked_stock, location_id) VALUES (?, ?, 0, 0, ?)`)
      .run(invId, id, locationId || null)

    success(res, { id, code: finalCode, name }, 'Created', 201)
  } catch (err: any) {
    if (err.message.includes('UNIQUE')) { error(res, 'Code already exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', requireMaterialWrite, (req, res) => {
  try {
    const { id } = req.params
    const data = req.body

    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    const fields: string[] = []
    const params: any[] = []

    if (data.code !== undefined) { fields.push('code = ?'); params.push(data.code) }
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
    if (data.spec !== undefined) { fields.push('spec = ?'); params.push(data.spec) }
    if (data.unit !== undefined) { fields.push('unit = ?'); params.push(data.unit) }
    if (data.specQty !== undefined) { fields.push('spec_qty = ?'); params.push(data.specQty) }
    if (data.specUnit !== undefined) { fields.push('spec_unit = ?'); params.push(data.specUnit) }
    if (data.categoryId !== undefined) { fields.push('category_id = ?'); params.push(data.categoryId) }
    if (data.supplierId !== undefined) { fields.push('supplier_id = ?'); params.push(data.supplierId) }
    if (data.price !== undefined) { fields.push('price = ?'); params.push(data.price) }
    if (data.minStock !== undefined) { fields.push('min_stock = ?'); params.push(data.minStock) }
    if (data.maxStock !== undefined) { fields.push('max_stock = ?'); params.push(data.maxStock) }
    if (data.safetyStock !== undefined) { fields.push('safety_stock = ?'); params.push(data.safetyStock) }
    if (data.locationId !== undefined) { fields.push('location_id = ?'); params.push(data.locationId) }
    if (data.remark !== undefined) { fields.push('remark = ?'); params.push(data.remark) }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status === 'active' ? 1 : 0) }

    if (fields.length > 0) {
      params.push(id)
      db.prepare(`UPDATE materials SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params)
    }

    success(res, { id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', requireMaterialWrite, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()

    const existing = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    const hasStock = (db.prepare('SELECT COALESCE(stock, 0) as stock FROM inventory WHERE material_id = ?').get(id) as any)?.stock || 0
    if (hasStock > 0) { error(res, 'Stock exists', 'CONFLICT', 409); return }

    db.prepare('UPDATE materials SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

router.patch('/batch-status', requireMaterialWrite, (req, res) => {
  try {
    const { ids, status } = req.body
    if (!Array.isArray(ids) || ids.length === 0 || !status) {
      error(res, 'Invalid params', 'INVALID_PARAMETER', 400)
      return
    }

    const db = getDatabase()
    const stmt = db.prepare('UPDATE materials SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0')
    const newStatus = status === 'active' ? 1 : 0
    let updatedCount = 0
    const transaction = db.transaction((idList: string[]) => {
      for (const id of idList) {
        const existing = db.prepare('SELECT * FROM materials WHERE id = ? AND is_deleted = 0').get(id)
        if (existing) {
          stmt.run(newStatus, id)
          updatedCount++
        }
      }
    })
    transaction(ids)

    if (updatedCount === 0) {
      error(res, 'No valid materials found', 'NOT_FOUND', 404); return
    }
    success(res, { updatedCount }, 'Status updated')
  } catch (err: any) { error(res, err.message) }
})

export default router
