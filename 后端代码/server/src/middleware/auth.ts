import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'coreone-secret-key-2024'

// 角色权限映射
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  warehouse_manager: [
    'dashboard', 'inventory', 'inbound', 'outbound', 'stocktaking',
    'categories', 'materials', 'suppliers', 'locations', 'alerts',
    'purchase_orders', 'returns', 'scraps', 'transfers'
  ],
  technician: [
    'dashboard', 'inventory', 'outbound', 'projects', 'bom', 'alerts'
  ],
  pathologist: [
    'dashboard', 'inventory', 'outbound', 'projects', 'bom',
    'cost_analysis', 'alerts'
  ],
  procurement: [
    'dashboard', 'inventory', 'inbound', 'categories', 'materials',
    'suppliers', 'purchase_orders', 'alerts'
  ],
  finance: [
    'dashboard', 'cost_analysis', 'logs'
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
  user?: { userId: string; username: string; role: string }
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  const token = authHeader?.split(' ')[1]

  if (!token) {
    res.status(401).json({ success: false, error: { message: 'Access token required', code: 'UNAUTHORIZED' } })
    return
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; username: string; role: string }
    req.user = decoded
    next()
  } catch {
    res.status(401).json({ success: false, error: { message: 'Invalid token', code: 'UNAUTHORIZED' } })
  }
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
