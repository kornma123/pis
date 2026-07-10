import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getDatabase } from '../database/DatabaseManager.js'
import { getUserRoleCodes } from './permissions.js'

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) {
  throw new Error('JWT_SECRET environment variable is required')
}
// 安全止血：拒绝「已泄露/占位」的默认密钥与过弱密钥。这些值曾提交进公开仓库，
// 用它们签发/校验 JWT 等于门户大开——任何人都能伪造任意角色（含 admin）的令牌。
// 生产环境硬拒启动；开发/测试仅告警（沿用占位默认值以保持本地与 CI 连续性，不阻断）。
const COMPROMISED_JWT_SECRETS = new Set<string>([
  'coreone-jwt-secret-key-2024', // secret-scan:allow 已泄露的历史签名密钥（此处为拒绝清单，非泄露）
  'coreone-secret-key-2024', // secret-scan:allow 更早的硬编码回退密钥（已移除，一并拒绝）
  'your-jwt-secret-key-change-in-production', // secret-scan:allow .env.example 占位默认值
])
if (COMPROMISED_JWT_SECRETS.has(jwtSecret) || jwtSecret.length < 32) {
  const reason = COMPROMISED_JWT_SECRETS.has(jwtSecret)
    ? 'JWT_SECRET 使用了已泄露/占位的默认值'
    : 'JWT_SECRET 过短（要求 ≥32 字符的高熵随机值）'
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${reason}；生产环境拒绝启动。请在部署环境注入强随机密钥，例如：openssl rand -base64 48`
    )
  }
  console.warn(`[SECURITY] ${reason}。仅开发/测试环境放行——切勿用于生产部署。`)
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
