import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

router.get('/rules', (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM alert_rules ORDER BY created_at').all() as any[]
    success(res, {
      rules: rows.map((r: any) => ({
        id: r.id, type: r.type, name: r.name,
        threshold: r.threshold, thresholdDays: r.threshold_days,
        enabled: r.enabled === 1,
      })),
    })
  } catch (err: any) { error(res, err.message) }
})

router.put('/rules/:id', requirePermission('alerts', 'W'), (req, res) => {
  try {
    const user = (req as any).user
    if (!user || user.role !== 'admin') {
      return error(res, 'Forbidden', 'FORBIDDEN', 403)
    }
    const { id } = req.params
    const { threshold, thresholdDays, enabled } = req.body
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id)
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    const fields: string[] = []; const params: any[] = []
    if (threshold !== undefined) {
      if (isNaN(Number(threshold)) || Number(threshold) < 0) {
        error(res, 'Invalid threshold', 'INVALID_PARAMETER', 400); return
      }
      fields.push('threshold = ?'); params.push(threshold)
    }
    if (thresholdDays !== undefined) {
      if (isNaN(Number(thresholdDays)) || Number(thresholdDays) < 0) {
        error(res, 'Invalid thresholdDays', 'INVALID_PARAMETER', 400); return
      }
      fields.push('threshold_days = ?'); params.push(thresholdDays)
    }
    if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0) }
    if (fields.length > 0) { params.push(id); db.prepare(`UPDATE alert_rules SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params) }
    success(res, { id }, 'Updated')
  } catch (err: any) { error(res, err.message) }
})

router.get('/', (req, res) => {
  try {
    const { status, type, keyword, startDate, endDate, page = 1, pageSize = 20 } = req.query
    const db = getDatabase()
    let where = '1=1'
    const params: any[] = []
    if (status) { where += ' AND status = ?'; params.push(status) }
    if (type) { where += ' AND type = ?'; params.push(type) }
    if (keyword) { where += ' AND (material_name LIKE ? OR message LIKE ? OR id LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) }
    if (startDate) { where += ' AND created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND created_at <= ?'; params.push(endDate + ' 23:59:59') }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM alerts WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT * FROM alerts WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, type: r.type, level: r.level, materialId: r.material_id,
      materialName: r.material_name, currentStock: r.current_stock,
      threshold: r.threshold, message: r.message, status: r.status,
      createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

// 处理/忽略预警的唯一写入端点。前端「处理」「忽略」「批量处理」均走这里，
// 用 action 区分终态：'processed'（已处理）| 'ignored'（已忽略）。缺省视为 'processed'。
const HANDLE_ACTIONS = ['processed', 'ignored'] as const

router.post('/:id/handle', (req, res) => {
  try {
    const { id } = req.params
    const { action, remark } = req.body
    const status = action == null || action === '' ? 'processed' : action
    if (!HANDLE_ACTIONS.includes(status)) {
      error(res, `无效的处理动作：${action}`, 'INVALID_PARAMETER', 400); return
    }
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as any
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    if (existing.status !== 'pending') { error(res, '预警已处理，不可重复操作', 'ALREADY_HANDLED', 400); return }
    // 记名留痕：谁处理的（handled_by = 当前登录用户名），配合全站 auditWrite 中间件双轨。
    const operator = (req as any).user?.username || 'system'
    db.prepare('UPDATE alerts SET status = ?, remark = ?, handled_by = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, remark || '', operator, id)
    success(res, null, 'Handled')
  } catch (err: any) { error(res, err.message) }
})

router.post('/generate', (_req, res) => {
  try {
    const db = getDatabase()
    let count = 0

    const lowStockRule = db.prepare("SELECT * FROM alert_rules WHERE type = 'low-stock' AND enabled = 1").get() as any
    if (lowStockRule) {
      // 有效阈值：优先 min_stock（表单/列表同源），为空时回退 safety_stock（兼容旧数据）。
      // 统一口径，避免“仓管在阈值栏填值进 min_stock、引擎只读 safety_stock(0)”导致静默漏报。
      const lowItems = db.prepare(`
        SELECT m.id, m.name, i.stock,
          COALESCE(NULLIF(m.min_stock, 0), m.safety_stock) AS effective_threshold
        FROM materials m
        JOIN inventory i ON m.id = i.material_id
        WHERE m.status = 1 AND m.is_deleted = 0
        AND i.stock <= COALESCE(NULLIF(m.min_stock, 0), m.safety_stock)
        AND COALESCE(NULLIF(m.min_stock, 0), m.safety_stock) > 0
      `).all() as any[]

      for (const item of lowItems) {
        const exists = db.prepare("SELECT COUNT(*) as c FROM alerts WHERE material_id = ? AND type = ? AND status = 'pending'").get(item.id, 'low-stock') as any
        if (exists.c === 0) {
          db.prepare("INSERT INTO alerts (id, type, level, material_id, material_name, current_stock, threshold, message, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')")
            .run(uuidv4(), 'low-stock', 'warning', item.id, item.name, item.stock, item.effective_threshold, `Low stock: current ${item.stock}, threshold ${item.effective_threshold}`)
          count++
        }
      }
    }

    const expiryRule = db.prepare("SELECT * FROM alert_rules WHERE type = 'expiry' AND enabled = 1").get() as any
    if (expiryRule && expiryRule.threshold_days != null) {
      // 计算预警截止日期，避免SQL字符串插值
      const thresholdDate = new Date()
      thresholdDate.setDate(thresholdDate.getDate() + Number(expiryRule.threshold_days))
      const thresholdStr = thresholdDate.toISOString().split('T')[0]

      const expItems = db.prepare(`
        SELECT b.id as batch_id, m.id, m.name, b.batch_no, b.expiry_date
        FROM batches b
        JOIN materials m ON b.material_id = m.id AND m.is_deleted = 0
        WHERE b.status = 1 AND b.expiry_date <= ?
      `).all(thresholdStr) as any[]

      for (const item of expItems) {
        const exists = db.prepare("SELECT COUNT(*) as c FROM alerts WHERE material_id = ? AND type = ? AND status = 'pending'").get(item.id, 'expiry') as any
        if (exists.c === 0) {
          db.prepare("INSERT INTO alerts (id, type, level, material_id, material_name, threshold, message, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')")
            .run(uuidv4(), 'expiry', 'danger', item.id, item.name, expiryRule.threshold_days, `Batch ${item.batch_no} expires at ${item.expiry_date}`)
          count++
        }
      }
    }

    success(res, { generatedCount: count }, `Generated ${count} alerts`)
  } catch (err: any) { error(res, err.message) }
})

export default router
