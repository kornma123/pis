import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

router.get('/operation', (req, res) => {
  try {
    const { page = 1, pageSize = 20, startDate, endDate, userId } = req.query
    const db = getDatabase()
    let where = '1=1'
    const params: any[] = []
    if (startDate) { where += ' AND created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND created_at <= ?'; params.push(`${endDate}T23:59:59`) }
    if (userId) { where += ' AND user_id = ?'; params.push(userId) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM operation_logs WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT * FROM operation_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, userId: r.user_id, username: r.username, operation: r.operation,
      description: r.description, ip: r.ip, userAgent: r.user_agent, createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

export default router
