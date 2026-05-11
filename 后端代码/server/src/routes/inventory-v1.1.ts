import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20, status, categoryId, locationId, keyword } = req.query
    const db = getDatabase()

    let where = "m.is_deleted = 0 AND ir.status = 'completed' AND ir.is_deleted = 0"
    const params: any[] = []

    if (keyword) { where += ' AND (m.name LIKE ? OR m.code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    if (categoryId) { where += ' AND m.category_id = ?'; params.push(categoryId) }
    if (locationId) { where += ' AND ir.location_id = ?'; params.push(locationId) }

    let having = ''
    if (status === 'low-stock') {
      having = ' HAVING SUM(ir.quantity) <= m.min_stock AND m.min_stock > 0'
    }

    const countSql = `
      SELECT COUNT(*) as total FROM (
        SELECT ir.material_id, COALESCE(ir.batch_no, '') as batch_no, ir.location_id
        FROM inbound_records ir
        JOIN materials m ON ir.material_id = m.id
        WHERE ${where}
        GROUP BY ir.material_id, COALESCE(ir.batch_no, ''), ir.location_id
        ${having}
      ) t
    `
    const count = (db.prepare(countSql).get(...params) as any)?.total || 0

    let sql = `
      SELECT
        m.id as material_id, m.code, m.name, m.spec, m.unit, m.min_stock, m.max_stock,
        COALESCE(ir.batch_no, '') as batch_no,
        SUM(ir.quantity) as stock,
        ir.location_id,
        l.name as location_name,
        MAX(ir.expiry_date) as expiry,
        m.supplier_id, s.name as supplier_name
      FROM inbound_records ir
      JOIN materials m ON ir.material_id = m.id
      LEFT JOIN locations l ON ir.location_id = l.id
      LEFT JOIN suppliers s ON m.supplier_id = s.id
      WHERE ${where}
      GROUP BY ir.material_id, COALESCE(ir.batch_no, ''), ir.location_id
      ${having}
      ORDER BY MAX(ir.created_at) DESC
      LIMIT ? OFFSET ?
    `
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(sql).all(...params, Number(pageSize), offset) as any[]

    const result = list.map((row: any) => {
      let status: string = 'normal'
      const stock = Number(row.stock) || 0
      const minStock = Number(row.min_stock) || 0
      const expiry = row.expiry

      if (stock <= 0) {
        status = 'out-of-stock'
      } else if (expiry && expiry !== '') {
        const today = new Date().toISOString().slice(0, 10)
        if (expiry <= today) {
          status = 'expired'
        } else if (expiry <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)) {
          status = 'warning'
        }
      }
      if (status === 'normal' && minStock > 0 && stock <= minStock) {
        status = 'low-stock'
      }

      return {
        id: `INV-${row.material_id}-${row.batch_no || 'default'}`,
        materialId: row.material_id,
        code: row.code,
        name: row.name,
        spec: row.spec,
        unit: row.unit,
        stock,
        minStock,
        maxStock: row.max_stock,
        availableStock: stock,
        locationId: row.location_id,
        locationName: row.location_name || '-',
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        status,
        batch: row.batch_no || '-',
        expiry: row.expiry || '-',
      }
    })

    successList(res, result, Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/stats', (_req, res) => {
  try {
    const db = getDatabase()

    // 按批次统计：有库存的批次
    const batchStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE
          WHEN batch_stock > min_stock AND (expiry IS NULL OR expiry = '' OR expiry > date('now', '+30 days'))
          THEN 1 ELSE 0
        END) as normal,
        SUM(CASE
          WHEN min_stock > 0 AND batch_stock <= min_stock
          THEN 1 ELSE 0
        END) as low_stock,
        SUM(CASE
          WHEN expiry IS NOT NULL AND expiry != '' AND expiry <= date('now', '+30 days') AND expiry > date('now')
          THEN 1 ELSE 0
        END) as expiring,
        SUM(CASE
          WHEN expiry IS NOT NULL AND expiry != '' AND expiry <= date('now')
          THEN 1 ELSE 0
        END) as expired
      FROM (
        SELECT
          m.min_stock,
          SUM(ir.quantity) as batch_stock,
          MAX(ir.expiry_date) as expiry
        FROM inbound_records ir
        JOIN materials m ON ir.material_id = m.id
        WHERE m.is_deleted = 0 AND ir.status = 'completed' AND ir.is_deleted = 0
        GROUP BY m.id, COALESCE(ir.batch_no, '')
        HAVING SUM(ir.quantity) > 0
      ) t
    `).get() as any

    const totalMaterials = (db.prepare('SELECT COUNT(*) as c FROM materials WHERE is_deleted = 0').get() as any)?.c || 0

    const totalStockValue = (db.prepare(`
      SELECT SUM(ir.quantity * COALESCE(m.price, 0)) as v
      FROM inbound_records ir
      JOIN materials m ON ir.material_id = m.id
      WHERE ir.status = 'completed' AND ir.is_deleted = 0 AND m.is_deleted = 0
    `).get() as any)?.v || 0

    const catDist = db.prepare(`
      SELECT c.id as category_id, c.name as category_name, COUNT(m.id) as count
      FROM material_categories c
      LEFT JOIN materials m ON c.id = m.category_id AND m.is_deleted = 0
      WHERE c.is_deleted = 0 AND c.level = 1
      GROUP BY c.id
    `).all() as any[]

    success(res, {
      totalMaterials,
      totalStockValue,
      totalStockCount: Number(batchStats?.total) || 0,
      normalCount: Number(batchStats?.normal) || 0,
      lowStockCount: Number(batchStats?.low_stock) || 0,
      expiringCount: Number(batchStats?.expiring) || 0,
      expiredCount: Number(batchStats?.expired) || 0,
      categoryDistribution: catDist.map((c: any) => ({ categoryId: c.category_id, categoryName: c.category_name, count: c.count })),
    })
  } catch (err: any) { error(res, err.message) }
})

export default router
