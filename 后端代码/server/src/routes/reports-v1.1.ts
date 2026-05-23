import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'

const router = Router()

router.get('/cost-by-project', (req, res) => {
  try {
    const { startDate, endDate } = req.query
    const db = getDatabase()
    let where = "r.status = 'completed' AND r.is_deleted = 0 AND (p.is_deleted = 0 OR p.id IS NULL)"
    const params: any[] = []
    if (startDate) { where += ' AND r.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND r.created_at <= ?'; params.push(`${endDate}T23:59:59`) }

    const rows = db.prepare(`
      SELECT r.project_id, p.name, p.type, SUM(r.total_cost) as total_cost, COUNT(r.id) as sample_count
      FROM outbound_records r
      LEFT JOIN projects p ON r.project_id = p.id
      WHERE ${where}
      GROUP BY r.project_id
      ORDER BY total_cost DESC
    `).all(...params) as any[]

    const totalCost = rows.reduce((sum: number, r: any) => sum + (r.total_cost || 0), 0)
    const totalSamples = rows.reduce((sum: number, r: any) => sum + r.sample_count, 0)

    success(res, {
      summary: { totalCost, projectCost: totalCost, publicCost: 0, totalSamples },
      projects: rows.map((r: any) => ({
        id: r.project_id, name: r.name || 'Unknown', category: r.type || 'other',
        sampleCount: r.sample_count,
        unitCost: r.sample_count > 0 ? r.total_cost / r.sample_count : 0,
        totalCost: r.total_cost || 0,
        ratio: totalCost > 0 ? ((r.total_cost || 0) / totalCost * 100).toFixed(1) : 0,
        changeRate: 0, changeDirection: 'down' as const,
      })),
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/cost-by-material', (req, res) => {
  try {
    const { startDate, endDate, categoryId } = req.query
    const db = getDatabase()
    let where = "o.status = 'completed' AND o.is_deleted = 0 AND m.is_deleted = 0"
    const params: any[] = []
    if (startDate) { where += ' AND o.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND o.created_at <= ?'; params.push(`${endDate}T23:59:59`) }
    if (categoryId) { where += ' AND m.category_id = ?'; params.push(categoryId) }

    const rows = db.prepare(`
      SELECT oi.material_id, m.name, m.spec, SUM(oi.quantity) as consumption, m.unit as consumption_unit, SUM(oi.total_cost) as total_cost
      FROM outbound_items oi
      JOIN outbound_records o ON oi.outbound_id = o.id
      JOIN materials m ON oi.material_id = m.id
      WHERE ${where}
      GROUP BY oi.material_id
      ORDER BY total_cost DESC
    `).all(...params) as any[]

    const totalCost = rows.reduce((sum: number, r: any) => sum + r.total_cost, 0)

    success(res, {
      materials: rows.map((r: any) => ({
        id: r.material_id, name: r.name, spec: r.spec,
        consumption: r.consumption, consumptionUnit: r.consumption_unit,
        totalCost: r.total_cost,
        ratio: totalCost > 0 ? (r.total_cost / totalCost * 100).toFixed(1) : 0,
        changeRate: 0, changeDirection: 'down' as const,
      })),
      trend: [],
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/cost-by-supplier', (req, res) => {
  try {
    const { startDate, endDate } = req.query
    const db = getDatabase()
    let where = "r.status = 'completed' AND r.is_deleted = 0 AND (s.is_deleted = 0 OR s.id IS NULL)"
    const params: any[] = []
    if (startDate) { where += ' AND r.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND r.created_at <= ?'; params.push(`${endDate}T23:59:59`) }

    const rows = db.prepare(`
      SELECT r.supplier_id, s.name, SUM(r.amount) as amount, COUNT(r.id) as order_count
      FROM inbound_records r
      LEFT JOIN suppliers s ON r.supplier_id = s.id
      WHERE ${where} AND r.supplier_id IS NOT NULL
      GROUP BY r.supplier_id
      ORDER BY amount DESC
    `).all(...params) as any[]

    const totalAmount = rows.reduce((sum: number, r: any) => sum + (r.amount || 0), 0)

    success(res, {
      suppliers: rows.map((r: any) => ({
        id: r.supplier_id, name: r.name || 'Unknown',
        amount: r.amount, ratio: totalAmount > 0 ? (r.amount / totalAmount * 100).toFixed(1) : 0,
        orderCount: r.order_count, status: 'long-term',
      })),
    })
  } catch (err: any) { error(res, err.message) }
})

router.get('/cost-trend', (req, res) => {
  try {
    const { startDate, endDate } = req.query
    const db = getDatabase()
    let where = "status = 'completed' AND is_deleted = 0"
    const params: any[] = []
    if (startDate) { where += ' AND created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND created_at <= ?'; params.push(`${endDate}T23:59:59`) }

    const rows = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(total_cost) as cost
      FROM outbound_records
      WHERE ${where}
      GROUP BY month
      ORDER BY month
    `).all(...params) as any[]

    success(res, { trend: rows.map((r: any) => ({ month: r.month, cost: r.cost || 0 })) })
  } catch (err: any) { error(res, err.message) }
})

export default router
