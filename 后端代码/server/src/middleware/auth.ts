import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getDatabase } from '../database/DatabaseManager.js'
import { getUserRoleCodes } from './permissions.js'
import { assertJwtSecretUsable } from '../config/security.js'

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) {
  throw new Error('JWT_SECRET environment variable is required')
}
// 安全止血（fail-closed）：用已泄露/占位/过弱密钥签发/校验 JWT 等于门户大开——任何人都能
// 伪造任意角色（含 admin）令牌。**默认拒绝启动**；仅显式 dev/test 放行并告警（见 config/security.ts）。
// 判据 fail-closed：未声明 NODE_ENV（未设置/拼错/production/staging…）一律按生产级=拒绝。
const secretCheck = assertJwtSecretUsable(jwtSecret)
if (!secretCheck.ok) {
  console.warn(`[SECURITY] ${secretCheck.reason}。仅显式 dev/test 环境放行——切勿用于生产部署。`)
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
  if (path.startsWith('/reports')) return 'cost_analysis'
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

  let decoded: { userId: string; username: string; role: string; type: 'access' }
  try {
    const verified = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })
    if (
      typeof verified === 'string'
      || verified.type !== 'access'
      || typeof verified.userId !== 'string'
      || typeof verified.username !== 'string'
      || typeof verified.role !== 'string'
    ) throw new Error('invalid access token claims')
    decoded = verified as typeof decoded
  } catch {
    res.status(401).json({ success: false, error: { message: 'Invalid token', code: 'UNAUTHORIZED' } })
    return
  }

  // 即时失效校验：回查 users，确保停用/软删除后 token 立即失效（不必等 8h 过期）。
  // 数据驱动多角色 RBAC：不再因 role 变更强制 401（ROLE_CHANGED 已移除）——
  //   改为每请求解析用户全部角色（user_roles ∪ users.role）并挂 req.user.roles，
  //   鉴权按角色权限并集即时生效（改角色/改矩阵无需重登）。
  const enriched: { userId: string; username: string; role: string; roles?: string[] } = { ...decoded }
  try {
    const db = getDatabase()
    const u = db.prepare('SELECT status, is_deleted, role, primary_role FROM users WHERE id = ?').get(decoded.userId) as
      | { status: number; is_deleted: number; role: string; primary_role?: string }
      | undefined

    if (!u || u.is_deleted === 1 || u.status !== 1) {
      res.status(401).json({ success: false, error: { message: '账号已停用或不存在，请重新登录', code: 'ACCOUNT_DISABLED' } })
      return
    }
    const activeRoles = getUserRoleCodes(db, decoded.userId)
    const preferredRole = u.primary_role || u.role
    enriched.roles = activeRoles
    // 遗留单角色守卫也只能看到当前活跃角色；不得保留 token/用户行中的已停用角色码。
    enriched.role = activeRoles.includes(preferredRole) ? preferredRole : (activeRoles[0] || '')
  } catch {
    // 身份状态与角色均以 DB 为当前真值。DB 异常时继续信任旧 token 会复活已停用/降权账号，
    // 因此宁可返回临时不可用，也绝不降级为“只验签名”。
    res.status(503).json({
      success: false,
      error: { message: 'Authentication state temporarily unavailable', code: 'AUTH_STATE_UNAVAILABLE' },
    })
    return
  }

  req.user = enriched
  next()
}

// ⚠️ 遗留兼容 shim：生产路由已全部迁移到 requirePermission(module, level)（见 app.ts + permissions.ts，
// 数据驱动 RBAC P3）。requireRole 现仅被测试脚手架引用，不在任何生产请求路径上。
//
// 审计口径（勿在此层补审计）：requireRole/requirePermission 都是**鉴权守卫**，对 GET 读同样触发、且在
// 业务操作成功之前就跑，天然不是审计落点。敏感写的留痕在**操作层**完成——碰钱的写（关账/成本核算/
// 成本调整/对账/预算/质量成本）经 writeAuditLog 落 abc_audit_logs（含 operator=用户名，对 admin 一视同仁），
// 对账另有 SoD 自审拦截（reconciliation-v1.1.ts：不能审核自己提交的提案）。故 admin 放行处只放行、不写审计。
export function requireRole(...allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.user
    if (!user) {
      res.status(401).json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
      return
    }

    // admin 拥有所有权限（放行即可；审计在操作层，见函数头注释）
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
