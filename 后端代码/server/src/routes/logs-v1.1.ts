import { Router, type Request, type Response } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { getOverrideFrequency } from '../utils/override-log.js'

const router = Router()

const EXPORT_MAX_ROWS = 10_000

type LogActionType = 'login' | 'logout' | 'create' | 'update' | 'delete' | 'export' | 'import' | 'denied' | 'unknown'

type LogFilters = {
  page: number
  pageSize: number
  startDate?: string
  endDate?: string
  userId?: string
  username?: string
  type?: LogActionType
  module?: string
}

type OperationLogRow = {
  id: string
  user_id: string | null
  username: string | null
  operation: string
  description: string
  request_data: string | null
  ip: string | null
  user_agent: string | null
  created_at: string
  outcome: string | null
  action_type: LogActionType
}

type CountRow = { total?: number }

const ACTION_TYPES = new Set<LogActionType>([
  'login', 'logout', 'create', 'update', 'delete', 'export', 'import', 'denied', 'unknown',
])

const ACTION_TYPE_SQL = `
  CASE
    WHEN lower(coalesce(outcome, '')) IN ('denied', 'denied_agg', 'security_alert')
      OR lower(trim(operation)) LIKE 'denied%'
      OR lower(trim(operation)) LIKE 'security_alert%'
      THEN 'denied'
    WHEN lower(trim(operation)) = 'login' OR lower(trim(operation)) LIKE 'login %' THEN 'login'
    WHEN lower(trim(operation)) = 'logout' OR lower(trim(operation)) LIKE 'logout %' THEN 'logout'
    WHEN lower(trim(operation)) LIKE 'post %'
      OR lower(trim(operation)) LIKE 'create%'
      OR lower(trim(operation)) LIKE 'add %'
      THEN 'create'
    WHEN lower(trim(operation)) LIKE 'put %'
      OR lower(trim(operation)) LIKE 'patch %'
      OR lower(trim(operation)) LIKE 'update%'
      OR lower(trim(operation)) LIKE 'edit %'
      THEN 'update'
    WHEN lower(trim(operation)) LIKE 'delete %'
      OR lower(trim(operation)) LIKE 'remove %'
      THEN 'delete'
    WHEN lower(trim(operation)) LIKE 'export%' THEN 'export'
    WHEN lower(trim(operation)) LIKE 'import%' THEN 'import'
    ELSE 'unknown'
  END
`

class InvalidQueryError extends Error {}

function getQueryString(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new InvalidQueryError(`${name} must be a string`)
  const normalized = value.trim()
  return normalized || undefined
}

function getPositiveInteger(value: unknown, fallback: number, name: string, max: number) {
  if (value === undefined) return fallback
  const normalized = getQueryString(value, name)
  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new InvalidQueryError(`${name} must be an integer between 1 and ${max}`)
  }
  return parsed
}

function getDate(value: unknown, name: string) {
  const normalized = getQueryString(value, name)
  if (!normalized) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new InvalidQueryError(`${name} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new InvalidQueryError(`${name} is not a valid date`)
  }
  return normalized
}

function getFilters(query: Record<string, unknown>): LogFilters {
  const startDate = getDate(query.startDate, 'startDate')
  const endDate = getDate(query.endDate, 'endDate')
  if (startDate && endDate && startDate > endDate) {
    throw new InvalidQueryError('startDate must not be after endDate')
  }

  const type = getQueryString(query.type, 'type')
  if (type && !ACTION_TYPES.has(type as LogActionType)) {
    throw new InvalidQueryError('type is not supported')
  }

  const module = getQueryString(query.module, 'module')?.toLowerCase()
  if (module && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(module)) {
    throw new InvalidQueryError('module contains unsupported characters')
  }

  const username = getQueryString(query.username, 'username')
  if (username && username.length > 128) throw new InvalidQueryError('username is too long')

  return {
    page: getPositiveInteger(query.page, 1, 'page', 1_000_000),
    pageSize: getPositiveInteger(query.pageSize, 20, 'pageSize', 100),
    startDate,
    endDate,
    userId: getQueryString(query.userId, 'userId'),
    username,
    type: type as LogActionType | undefined,
    module,
  }
}

function buildWhere(filters: LogFilters) {
  const clauses: string[] = []
  const params: unknown[] = []

  if (filters.startDate) { clauses.push('created_at >= ?'); params.push(filters.startDate) }
  if (filters.endDate) { clauses.push("created_at < datetime(?, '+1 day')"); params.push(filters.endDate) }
  if (filters.userId) { clauses.push('user_id = ?'); params.push(filters.userId) }
  if (filters.username) { clauses.push("lower(coalesce(username, '')) = lower(?)"); params.push(filters.username) }
  if (filters.type) { clauses.push(`(${ACTION_TYPE_SQL}) = ?`); params.push(filters.type) }

  if (filters.module) {
    const moduleClauses = [
      `lower(coalesce(CASE WHEN json_valid(request_data) THEN CAST(json_extract(request_data, '$.module') AS TEXT) END, '')) = ?`,
      'lower(trim(operation)) LIKE ?',
      'lower(trim(operation)) LIKE ?',
      'lower(trim(operation)) LIKE ?',
      'lower(trim(operation)) LIKE ?',
    ]
    params.push(
      filters.module,
      `% ${filters.module}`,
      `% /${filters.module}`,
      `% /${filters.module}/%`,
      `% ${filters.module}/%`,
    )
    if (filters.module === 'system') moduleClauses.push(`(${ACTION_TYPE_SQL}) IN ('login', 'logout')`)
    clauses.push(`(${moduleClauses.join(' OR ')})`)
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

function safeModule(row: OperationLogRow) {
  if (typeof row.request_data === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.request_data)
      const module = typeof parsed === 'object' && parsed !== null && 'module' in parsed && typeof parsed.module === 'string'
        ? parsed.module.trim().toLowerCase()
        : ''
      if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(module)) return module
    } catch { /* Malformed historical request data is not evidence for a module label. */ }
  }

  const operation = String(row.operation || '').trim().toLowerCase()
  const pathModule = operation.match(/\/api\/v\d+\/([a-z0-9_-]+)/)?.[1]
  if (pathModule) return pathModule
  if ((row.action_type === 'login' || row.action_type === 'logout')) return 'system'

  const tokens = operation.split(/\s+/)
  if (tokens.length > 1) {
    const candidate = tokens.at(-1)?.replace(/^\/+|\/+$/g, '').split('/')[0] || ''
    if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate)) return candidate
  }
  return ''
}

function mapLog(row: OperationLogRow) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username || '',
    operation: row.operation,
    description: row.description,
    ip: row.ip || '',
    userAgent: row.user_agent,
    createdAt: row.created_at,
    actionType: row.action_type as LogActionType,
    module: safeModule(row),
    outcome: row.outcome ?? null,
  }
}

function getErrorMessage(err: unknown) {
  return err instanceof Error && err.message ? err.message : 'Logs request failed'
}

function sendLogsError(res: Response, err: unknown) {
  if (err instanceof InvalidQueryError) {
    error(res, err.message, 'INVALID_QUERY', 400)
    return
  }
  error(res, getErrorMessage(err))
}

function getOperationLogs(req: Request, res: Response) {
  try {
    const filters = getFilters(req.query as Record<string, unknown>)
    const db = getDatabase()
    const { where, params } = buildWhere(filters)
    const count = (db.prepare(`SELECT COUNT(*) as total FROM operation_logs ${where}`).get(...params) as CountRow | undefined)?.total || 0
    const offset = (filters.page - 1) * filters.pageSize
    const list = db.prepare(`
      SELECT *, (${ACTION_TYPE_SQL}) AS action_type
      FROM operation_logs
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, filters.pageSize, offset) as OperationLogRow[]

    successList(res, list.map(mapLog), filters.page, filters.pageSize, count)
  } catch (err: unknown) {
    sendLogsError(res, err)
  }
}

function exportOperationLogs(req: Request, res: Response) {
  try {
    const filters = getFilters(req.query as Record<string, unknown>)
    const db = getDatabase()
    const { where, params } = buildWhere(filters)
    const total = (db.prepare(`SELECT COUNT(*) as total FROM operation_logs ${where}`).get(...params) as CountRow | undefined)?.total || 0

    if (total > EXPORT_MAX_ROWS) {
      error(
        res,
        `Export matches ${total} logs; narrow the filters to ${EXPORT_MAX_ROWS} rows or fewer`,
        'EXPORT_LIMIT_EXCEEDED',
        413,
      )
      return
    }

    const rows = db.prepare(`
      SELECT *, (${ACTION_TYPE_SQL}) AS action_type
      FROM operation_logs
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, EXPORT_MAX_ROWS) as OperationLogRow[]

    success(res, {
      rows: rows.map(mapLog),
      total,
      maxRows: EXPORT_MAX_ROWS,
    })
  } catch (err: unknown) {
    sendLogsError(res, err)
  }
}

router.get('/', getOperationLogs)
router.get('/export', exportOperationLogs)
router.get('/operation', getOperationLogs)

// 项⑦ 统一旁路台账体检：按 gate_type 聚合旁路使用频率（第 1 层体检指标——高频=闸阈值错或有人在绕）。
// 挂在 logs 域（logs:R），复用现有审计查看权限。?sinceMonth=YYYY-MM 限窗。
router.get('/override-frequency', (req: Request, res: Response) => {
  try {
    const sinceMonth = getQueryString(req.query.sinceMonth, 'sinceMonth')
    const freq = getOverrideFrequency(getDatabase(), { sinceMonth })
    success(res, freq)
  } catch (err: unknown) { sendLogsError(res, err) }
})

export default router
