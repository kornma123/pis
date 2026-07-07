import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { getOverrideFrequency } from '../utils/override-log.js'

const router = Router()

function getOperationLogs(req: any, res: any) {
  try {
    const { page = 1, pageSize = 20, startDate, endDate, userId } = req.query
    const db = getDatabase()
    let where = '1=1'
    const params: any[] = []
    if (startDate) { where += ' AND created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND created_at <= ?'; params.push(`${endDate}T23:59:59`) }
    if (userId) { where += ' AND user_id = ?'; params.push(userId) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM operation_logs WHERE ${where}`).get(...params) as any)?.total || 0
    const pageNum = Math.max(1, Number(page))
    const offset = (pageNum - 1) * Number(pageSize)
    const list = db.prepare(`SELECT * FROM operation_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => ({
      id: r.id, userId: r.user_id, username: r.username, operation: r.operation,
      description: r.description, ip: r.ip, userAgent: r.user_agent, createdAt: r.created_at,
    })), pageNum, Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
}

router.get('/', getOperationLogs)
router.get('/operation', getOperationLogs)

// 项⑦ 统一旁路台账体检：按 gate_type 聚合旁路使用频率（第 1 层体检指标——高频=闸阈值错或有人在绕）。
// 挂在 logs 域（logs:R），复用现有审计查看权限。?sinceMonth=YYYY-MM 限窗。
router.get('/override-frequency', (req: any, res: any) => {
  try {
    const freq = getOverrideFrequency(getDatabase(), { sinceMonth: req.query.sinceMonth })
    success(res, freq)
  } catch (err: any) { error(res, err.message) }
})

export default router
