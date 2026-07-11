/**
 * 数据驱动多角色 RBAC —— DB 依赖的能力解析与守卫。
 *
 * 单一事实源 = DB `roles.permissions`（对象 {module:'R'|'W'}）。
 * 鉴权 = 用户全部角色（user_roles ∪ users.role 兜底）权限的并集（W 优先）；admin → 全 W。
 * 改矩阵 / 改角色 即时生效（per-request 解析，不进 JWT）。
 *
 * 纯矩阵逻辑见 ./rbac-matrix.ts（无 DB 依赖，避免与 DatabaseManager 成环）。
 */
import type { Request, Response, NextFunction } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import {
  type Level, type PermMap,
  adminAllPermissions, parsePermissions, mergePermissions, hasLevel,
} from './rbac-matrix.js'

// 透传纯矩阵 API，便于其它模块从单一入口引用
export {
  type Level, type PermMap,
  MODULES, COST_MODULES, NON_ADMIN_ROLES, SEED_MATRIX,
  SOD_INCOMPATIBLE, detectSoDConflicts,
  adminAllPermissions, parsePermissions, mergePermissions, hasLevel,
} from './rbac-matrix.js'

/** 取用户全部活跃角色码（user_roles ∪ users.role 兜底）；停用/软删除/缺失角色均不授权。 */
export function getUserRoleCodes(db: any, userId: string): string[] {
  const codes = new Set<string>()
  try {
    const rows = db.prepare(`
      SELECT ur.role_code
      FROM user_roles ur
      INNER JOIN roles r ON r.code = ur.role_code
      WHERE ur.user_id = ? AND r.status = 1 AND r.is_deleted = 0
    `).all(userId) as Array<{ role_code: string }>
    for (const r of rows) if (r.role_code) codes.add(r.role_code)
  } catch {
    /* user_roles 表尚未建（P1 前）→ 走兜底 */
  }
  if (codes.size === 0) {
    const u = db.prepare(`
      SELECT u.role
      FROM users u
      INNER JOIN roles r ON r.code = u.role
      WHERE u.id = ? AND r.status = 1 AND r.is_deleted = 0
    `).get(userId) as { role?: string } | undefined
    if (u?.role) codes.add(u.role)
  }
  return [...codes]
}

/** 角色集合 → 活跃 DB 角色权限并集；停用、软删除或缺失角色一律不回退静态种子。 */
export function getEffectivePermissionsForRoles(db: any, roleCodes: string[]): PermMap {
  const effective: PermMap = {}
  for (const code of roleCodes) {
    const row = db.prepare('SELECT permissions, status, is_deleted FROM roles WHERE code = ?').get(code) as
      | { permissions?: string; status: number; is_deleted: number }
      | undefined
    if (!row || row.status !== 1 || row.is_deleted !== 0) continue
    if (code === 'admin') return adminAllPermissions()
    mergePermissions(effective, parsePermissions(row.permissions))
  }
  return effective
}

/** 用户有效权限 = 全部角色权限的并集（DB 真值；admin → 全 W） */
export function getEffectivePermissions(db: any, userId: string): PermMap {
  return getEffectivePermissionsForRoles(db, getUserRoleCodes(db, userId))
}

interface AuthRequest extends Request {
  user?: { userId: string; username: string; role: string; roles?: string[] }
}

/**
 * 解析请求用户的角色集合（多角色感知 + 健壮）：
 *   优先 req.user.roles（authenticateToken 已挂）→ 否则按 userId 查 DB。
 * 带 userId 时 DB 异常/空结果绝不退回 token.role；仅无 userId 的显式测试 shim 可用单 role。
 */
export function resolveRequestRoles(user: { userId?: string; role?: string; roles?: string[] }): string[] {
  if (user.roles && user.roles.length) return user.roles
  if (user.userId) {
    try {
      const codes = getUserRoleCodes(getDatabase(), user.userId)
      if (codes.length) return codes
    } catch {
      return []
    }
    return []
  }
  return user.role ? [user.role] : []
}

/**
 * 路由守卫：要求当前用户对 module 具备 level 权限（读 DB 真值，即时生效）。
 *
 * 审计口径：这是**鉴权**守卫，不是审计落点——它对 GET 读也会触发、且在业务操作成功前就跑。admin（→ 全 W）
 * 直接放行且不写审计是有意为之。敏感写的留痕在**操作层**完成（writeAuditLog → abc_audit_logs，含 operator，
 * 对 admin 一视同仁）；勿在此层补 writeAuditLog（否则会记录读操作、并在操作成功前误记）。
 */
export function requirePermission(module: string, level: Level = 'R') {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.user
    if (!user) {
      res.status(401).json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
      return
    }
    try {
      const db = getDatabase()
      const effective = getEffectivePermissionsForRoles(db, resolveRequestRoles(user))
      if (hasLevel(effective, module, level)) {
        next()
        return
      }
    } catch {
      // DB 异常时拒绝（鉴权失败安全默认）
    }
    res.status(403).json({ success: false, error: { message: 'Forbidden: insufficient permissions', code: 'FORBIDDEN' } })
  }
}

/**
 * 多角色感知的角色守卫：当前用户「任一角色」命中即放行（用于无法用 module R/W 表达的细粒度卡口，
 * 如对账「审批」= 核准角色 admin/finance/lab_director，区别于技术员「提案」=reconciliation W）。
 * admin 始终放行。
 */
export function requireAnyRole(...roleCodes: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.user
    if (!user) {
      res.status(401).json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
      return
    }
    const roles = resolveRequestRoles(user)
    if (roles.includes('admin') || roleCodes.some((c) => roles.includes(c))) {
      next()
      return
    }
    res.status(403).json({ success: false, error: { message: 'Forbidden: insufficient permissions', code: 'FORBIDDEN' } })
  }
}

/** 成本可见性：默认仅 finance/lab_director/admin；由 app_settings.cost_visibility_roles 可配 */
export function getCostVisibilityRoles(db: any): string[] {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'cost_visibility_roles'").get() as { value?: string } | undefined
    if (row?.value) {
      const arr = JSON.parse(row.value)
      if (Array.isArray(arr)) return arr
    }
  } catch {
    /* 表未建或解析失败 → 默认 */
  }
  return ['finance', 'lab_director', 'admin']
}

export function canSeeCost(db: any, userId: string): boolean {
  const allowed = new Set(getCostVisibilityRoles(db))
  return getUserRoleCodes(db, userId).some((r) => allowed.has(r))
}
