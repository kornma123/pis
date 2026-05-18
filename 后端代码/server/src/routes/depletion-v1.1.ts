import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'

const router = Router()

// ===== 获取使用中批次列表 =====
router.get('/tracking', (req, res) => {
  try {
    const db = getDatabase()
    const { status = 'in-use' } = req.query
    const list = db.prepare(`
      SELECT * FROM batch_usage_tracking 
      WHERE status = ? 
      ORDER BY material_name, created_at DESC
    `).all(status) as any[]

    success(res, { list })
  } catch (err: any) { error(res, err.message) }
})

// ===== 创建使用中记录 =====
router.post('/tracking', (req, res) => {
  try {
    const db = getDatabase()
    const { material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, expected_days, usage, receiver } = req.body
    if (!material_id || !batch || total_qty === undefined || remaining === undefined) {
      error(res, 'material_id, batch, total_qty, remaining 必填', 'INVALID_PARAMETER', 400); return
    }
    if (isNaN(Number(total_qty)) || Number(total_qty) <= 0 || isNaN(Number(remaining)) || Number(remaining) < 0) {
      error(res, 'total_qty 和 remaining 必须为非负数且 total_qty > 0', 'INVALID_PARAMETER', 400); return
    }
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (start_date && !dateRegex.test(start_date)) {
      error(res, 'start_date 格式必须为 YYYY-MM-DD', 'INVALID_PARAMETER', 400); return
    }

    const id = `TRK-${Date.now()}`
    db.prepare(`
      INSERT INTO batch_usage_tracking
      (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, days_used, expected_days, progress, usage, receiver, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'in-use', datetime('now'), datetime('now'))
    `).run(id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, expected_days, usage, receiver)

    success(res, { id })
  } catch (err: any) { error(res, err.message) }
})

// ===== 更新剩余量 =====
router.put('/tracking/:id/remain', (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params
    const { remaining, reason } = req.body
    if (remaining === undefined || isNaN(Number(remaining)) || Number(remaining) < 0) {
      error(res, 'remaining 必填且必须为非负数', 'INVALID_PARAMETER', 400); return
    }

    const existing = db.prepare('SELECT * FROM batch_usage_tracking WHERE id = ?').get(id) as any
    if (!existing) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    db.prepare(`
      UPDATE batch_usage_tracking
      SET remaining = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(remaining, id)

    success(res, { id, remaining })
  } catch (err: any) { error(res, err.message) }
})

// ===== 确认耗尽 =====
router.post('/tracking/:id/deplete', (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params
    const { remain_qty, deplete_type, deplete_reason, operator } = req.body
    if (remain_qty === undefined || isNaN(Number(remain_qty)) || Number(remain_qty) < 0) {
      error(res, 'remain_qty 必填且必须为非负数', 'INVALID_PARAMETER', 400); return
    }

    // 获取当前跟踪记录
    const tracking = db.prepare(`SELECT * FROM batch_usage_tracking WHERE id = ?`).get(id) as any
    if (!tracking) {
      return error(res, '跟踪记录不存在', 'NOT_FOUND', 404)
    }
    if (tracking.status === 'depleted') {
      return error(res, '该跟踪记录已耗尽，不可重复操作', 'ALREADY_DEPLETED', 400)
    }

    // 计算使用天数
    const today = new Date().toISOString().split('T')[0]
    const startDate = new Date(tracking.start_date)
    const endDate = new Date(today)
    const daysUsed = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))

    // 创建耗尽记录
    const depletionId = `DPL-${Date.now()}`
    db.prepare(`
      INSERT INTO batch_depletion 
      (id, tracking_id, material_id, material_name, batch, spec, total_qty, remain_qty, unit, start_date, end_date, days_used, actual_days, deplete_type, deplete_reason, operator, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(depletionId, id, tracking.material_id, tracking.material_name, tracking.batch, tracking.spec,
      tracking.total_qty, remain_qty, tracking.unit, tracking.start_date, today, daysUsed, tracking.expected_days,
      deplete_type, deplete_reason, operator)

    // 更新跟踪记录状态为耗尽
    db.prepare(`
      UPDATE batch_usage_tracking 
      SET status = 'depleted', updated_at = datetime('now')
      WHERE id = ?
    `).run(id)

    // 更新批次库存
    if (tracking.batch && tracking.material_id) {
      db.prepare(`
        UPDATE batches
        SET remaining = ?, status = 2, updated_at = datetime('now')
        WHERE batch_no = ? AND material_id = ?
      `).run(remain_qty, tracking.batch, tracking.material_id)
    }

    success(res, { id: depletionId })
  } catch (err: any) { error(res, err.message) }
})

// ===== 获取耗尽记录列表 =====
router.get('/depletion', (req, res) => {
  try {
    const db = getDatabase()
    const list = db.prepare(`
      SELECT * FROM batch_depletion 
      ORDER BY created_at DESC
    `).all() as any[]

    success(res, { list })
  } catch (err: any) { error(res, err.message) }
})

// ===== 获取可用批次 =====
router.get('/batches/:materialId', (req, res) => {
  try {
    const db = getDatabase()
    const { materialId } = req.params
    const list = db.prepare(`
      SELECT b.*, m.name as material_name, m.spec, m.unit
      FROM batches b
      JOIN materials m ON b.material_id = m.id AND m.is_deleted = 0
      WHERE b.material_id = ? AND b.status = 1 AND b.remaining > 0
      ORDER BY b.expiry_date ASC
    `).all(materialId) as any[]

    success(res, { list })
  } catch (err: any) { error(res, err.message) }
})

export default router
