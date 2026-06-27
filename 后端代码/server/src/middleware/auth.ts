import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getDatabase } from '../database/DatabaseManager.js'
import { getUserRoleCodes } from './permissions.js'

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) {
  throw new Error('JWT_SECRET environment variable is required')
}
export const JWT_SECRET = jwtSecret

// 角色权限映射
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  warehouse_manager: [
    'dashboard', 'inventory', 'inbound', 'outbound', 'stocktaking',
    'categories', 'materials', 'suppliers', 'locations', 'alerts',
    'purchase_orders', 'returns', 'scraps', 'transfers'
  ],
  technician: [
    'dashboard', 'inventory', 'outbound', 'projects', 'bom', 'materials', 'alerts'
  ],
  pathologist: [
    'dashboard', 'inventory', 'outbound', 'projects', 'bom', 'materials',
    'cost_analysis', 'alerts'
  ],
  procurement: [
    'dashboard', 'inventory', 'inbound', 'categories', 'materials',
    'suppliers', 'purchase_orders', 'alerts'
  ],
  finance: [
    'dashboard', 'cost_analysis', 'logs', 'alerts'
  ],
}

// 接口路径到权限的映射
function pathToPermission(req: AuthRequest): string {
  const path = req.baseUrl?.replace('/api/v1', '') || req.path
  if (path.startsWith('/users')) return 'users'
  if (path.startsWith('/roles')) return 'roles'
  if (path.startsWith('/inventory')) return 'inventory'
  if (path.startsWith('/inbound')) return 'inbound'
  if (path.startsWith('/outbound')) return 'outbound'
  if (path.startsWith('/stocktaking')) return 'stocktaking'
  if (path.startsWith('/categories')) return 'categories'
  if (path.startsWith('/materials')) return 'materials'
  if (path.startsWith('/suppliers')) return 'suppliers'
  if (path.startsWith('/locations')) return 'locations'
  if (path.startsWith('/projects')) return 'projects'
  if (path.startsWith('/boms')) return 'bom'
  if (path.startsWith('/reports') || path.startsWith('/depletion')) return 'cost_analysis'
  if (path.startsWith('/alerts')) return 'alerts'
  if (path.startsWith('/logs')) return 'logs'
  if (path.startsWith('/purchase-orders')) return 'purchase_orders'
  if (path.startsWith('/returns')) return 'returns'
  if (path.startsWith('/scraps')) return 'scraps'
  if (path.startsWith('/transfers')) return 'transfers'
  return ''
}

interface AuthRequest extends Request {
  user?: { userId: string; username: string; role: string; roles?: string[] }
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  const token = authHeader?.split(' ')[1]

  if (!token) {
    res.status(401).json({ success: false, error: { message: 'Access token required', code: 'UNAUTHORIZED' } })
    return
  }

  let decoded: { userId: string; username: string; role: string }
  try {
    decoded = jwt.verify(token, JWT_SECRET) as { userId: string; username: string; role: string }
  } catch {
    res.status(401).json({ success: false, error: { message: 'Invalid token', code: 'UNAUTHORIZED' } })
    return
  }

  // 即时失效校验：回查 users，确保停用/软删除后 token 立即失效（不必等 8h 过期）。
  // 数据驱动多角色 RBAC：不再因 role 变更强制 401（ROLE_CHANGED 已移除）——
  //   改为每请求解析用户全部角色（user_roles ∪ users.role）并挂 req.user.roles，
  //   鉴权按角色权限并集即时生效（改角色/改矩阵无需重登）。
  // DB 异常时退回仅签名校验（不因 DB 抖动锁死全部请求）。
  const enriched: { userId: string; username: string; role: string; roles?: string[] } = { ...decoded }
  try {
    const db = getDatabase()
    const u = db.prepare('SELECT status, is_deleted, role FROM users WHERE id = ?').get(decoded.userId) as
      | { status: number; is_deleted: number; role: string }
      | undefined

    if (!u || u.is_deleted === 1 || u.status !== 1) {
      res.status(401).json({ success: false, error: { message: '账号已停用或不存在，请重新登录', code: 'ACCOUNT_DISABLED' } })
      return
    }
    enriched.role = u.role || decoded.role // DB 主角色为准（用于 requireRole 兼容 shim）
    enriched.roles = getUserRoleCodes(db, decoded.userId)
  } catch {
    // DB 不可用：降级为仅签名校验，避免数据库抖动导致全站 401
  }

  req.user = enriched
  next()
}

export function requireRole(...allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.user
    if (!user) {
      res.status(401).json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
      return
    }

    // admin 拥有所有权限
    if (user.role === 'admin') {
      next()
      return
    }

    // 检查角色是否在允许列表中
    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
      res.status(403).json({ success: false, error: { message: 'Forbidden: insufficient permissions', code: 'FORBIDDEN' } })
      return
    }

    // 检查接口权限
    const permission = pathToPermission(req)
    const userPerms = ROLE_PERMISSIONS[user.role] || []
    if (permission && !userPerms.includes(permission) && !userPerms.includes('*')) {
      res.status(403).json({ success: false, error: { message: 'Forbidden: insufficient permissions', code: 'FORBIDDEN' } })
      return
    }

    next()
  }
}

// 成本工作台访问控制（ABC 成本核算）
// admin/finance 直接放行；自定义角色（非系统内置角色）需具备 '*' 或 'cost_analysis' 权限
export function requireCostWorkbenchAccess(req: AuthRequest, res: Response, next: NextFunction): void {
  const user = req.user
  if (!user) {
    res.status(401).json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
    return
  }

  if (user.role === 'admin' || user.role === 'finance') {
    next()
    return
  }

  const userPerms = ROLE_PERMISSIONS[user.role] || []
  const isCustomRole = !Object.keys(ROLE_PERMISSIONS).includes(user.role)
  if (isCustomRole && (userPerms.includes('*') || userPerms.includes('cost_analysis'))) {
    next()
    return
  }

  res.status(403).json({ success: false, error: { message: 'Forbidden: insufficient permissions', code: 'FORBIDDEN' } })
}
