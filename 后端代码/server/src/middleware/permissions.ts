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
  isAdminEquivalentPermissions, isSystemRoleCode,
} from './rbac-matrix.js'

// 透传纯矩阵 API，便于其它模块从单一入口引用
export {
  type Level, type PermMap,
  MODULES, COST_MODULES, NON_ADMIN_ROLES, SYSTEM_ROLE_CODES, SEED_MATRIX,
  SOD_INCOMPATIBLE, detectSoDConflicts,
  adminAllPermissions, parsePermissions, mergePermissions, hasLevel,
  isAdminEquivalentPermissions, isSystemRoleCode,
} from './rbac-matrix.js'

/** 取用户全部活跃角色码（user_roles ∪ users.role 兜底）；停用/软删除/缺失角色均不授权。 */
export function getUserRoleCodes(db: any, userId: string): string[] {
  const codes = new Set<string>()
  // user_roles 已是现行 schema。查询异常必须向上抛，让认证/授权拒绝；不能把故障伪装成“无关联行”后复活 users.role。
  const rows = db.prepare(`
    SELECT ur.role_code
    FROM user_roles ur
    INNER JOIN roles r ON r.code = ur.role_code
    WHERE ur.user_id = ? AND r.status = 1 AND r.is_deleted = 0
  `).all(userId) as Array<{ role_code: string }>
  for (const r of rows) if (r.role_code) codes.add(r.role_code)
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
 * 事务内授权复核：只信当前 DB 中的 actor 有效权限，不复用事务前认证快照。
 * DB/解析异常一律 false，供写路由在 BEGIN IMMEDIATE 后作为最终安全闸。
 */
export function requestActorHasCurrentPermission(
  db: any,
  req: Request,
  module: string,
  level: Level,
): boolean {
  const actor = (req as AuthRequest).user
  if (!actor?.userId) return false
  try {
    const activeActor = db.prepare(
      'SELECT 1 FROM users WHERE id = ? AND status = 1 AND is_deleted = 0',
    ).get(actor.userId)
    if (!activeActor) return false
    return hasLevel(getEffectivePermissions(db, actor.userId), module, level)
  } catch {
    return false
  }
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

const AUDIT_ACTOR_FIELDS = new Set(['actor', 'operator', 'createdBy', 'updatedBy', 'created_by', 'updated_by'])
const ADMIN_ACCOUNT_FIELDS = ['password', 'status', 'role', 'roles', 'primaryRole'] as const
const ROLE_CODE_FIELDS = ['role', 'code'] as const

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key)
}

function sendSecurityCeilingDenied(res: Response): void {
  res.status(403).json({
    success: false,
    error: { message: 'Forbidden: security administration requires admin', code: 'FORBIDDEN' },
  })
}

/** 拒绝把第二套 actor/operator 混入通用审计 request_data；权威 actor 只能来自认证上下文。 */
export function rejectUntrustedAuditActorFields(req: Request, res: Response, next: NextFunction): void {
  const body = req.body
  if (typeof body === 'object' && body !== null && Object.keys(body).some((key) => AUDIT_ACTOR_FIELDS.has(key))) {
    res.status(400).json({
      success: false,
      error: { message: 'Audit actor fields are server-managed', code: 'INVALID_PARAMETER' },
    })
    return
  }
  next()
}

function isNonEmptyRoleCode(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 禁止 SQLite TEXT affinity 把 number 等非字符串角色码归一成可授权文本。 */
export function rejectInvalidRoleCodeFields(req: Request, res: Response, next: NextFunction): void {
  const body = req.body
  if (typeof body !== 'object' || body === null) { next(); return }
  const record = body as Record<string, unknown>
  const invalidRoles = hasOwn(record, 'roles') && (
    !Array.isArray(record.roles) || record.roles.some((role) => !isNonEmptyRoleCode(role))
  )
  const invalidSingle = ROLE_CODE_FIELDS.some((field) => hasOwn(record, field) && !isNonEmptyRoleCode(record[field]))
  if (invalidRoles || invalidSingle) {
    res.status(400).json({
      success: false,
      error: { message: 'Role codes must be non-empty strings', code: 'INVALID_PARAMETER' },
    })
    return
  }
  next()
}

function requestedUserRoleCodes(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null
  const candidate = body as { role?: unknown; roles?: unknown }
  if (Array.isArray(candidate.roles) && candidate.roles.length > 0) {
    if (candidate.roles.some((role) => !isNonEmptyRoleCode(role))) throw new TypeError('Invalid role code')
    return candidate.roles
  }
  if (hasOwn(candidate, 'role')) {
    if (!isNonEmptyRoleCode(candidate.role)) throw new TypeError('Invalid role code')
    return [candidate.role]
  }
  return null
}

function requestedRolesGrantAdminEquivalent(db: any, roleCodes: string[]): boolean {
  const uniqueCodes = [...new Set(roleCodes)]
  const findActiveRole = db.prepare('SELECT 1 FROM roles WHERE code = ? AND status = 1 AND is_deleted = 0')
  // 未知/停用角色不能由非 admin 预埋后再激活；角色解析故障或缺口一律按不安全处理。
  if (uniqueCodes.some((code) => !findActiveRole.get(code))) return true
  return isAdminEquivalentPermissions(getEffectivePermissionsForRoles(db, uniqueCodes))
}

/** 活跃账号是否通过现行多角色解析持有活跃 admin 角色。 */
export function isEffectiveSecurityAdminUser(db: any, userId: string): boolean {
  const user = db.prepare('SELECT status, is_deleted FROM users WHERE id = ?').get(userId) as
    | { status: number; is_deleted: number }
    | undefined
  return !!user && user.status === 1 && user.is_deleted === 0 && getUserRoleCodes(db, userId).includes('admin')
}

/** literal admin 或权限并集全 W 的账号即使暂时停用，也不能由非 admin 接管后再激活。 */
function isSecurityAdminAccount(db: any, userId: string): boolean {
  const user = db.prepare('SELECT role, is_deleted FROM users WHERE id = ?').get(userId) as
    | { role?: string; is_deleted: number }
    | undefined
  if (!user || user.is_deleted !== 0) return false
  if (user.role === 'admin') return true
  if (db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = 'admin'").get(userId)) return true
  return isAdminEquivalentPermissions(getEffectivePermissionsForRoles(db, getUserRoleCodes(db, userId)))
}

/** 当前有效 admin 人数；复用 getUserRoleCodes，不能只数 primary_role/users.role。 */
export function countEffectiveSecurityAdmins(db: any): number {
  const users = db.prepare('SELECT id FROM users WHERE status = 1 AND is_deleted = 0').all() as Array<{ id: string }>
  return users.reduce((count, user) => count + (getUserRoleCodes(db, user.id).includes('admin') ? 1 : 0), 0)
}

export interface SecurityAdminRemovalIntent {
  deleting?: boolean
  status?: unknown
  roles?: string[]
}

/** 该变更是否会移除最后一个有效 admin；调用方须在同一 BEGIN IMMEDIATE 事务内检查并写入。 */
export function wouldRemoveLastEffectiveAdmin(
  db: any,
  userId: string,
  intent: SecurityAdminRemovalIntent,
): boolean {
  if (!isEffectiveSecurityAdminUser(db, userId)) return false
  const disables = intent.status !== undefined && intent.status !== 'active'
  const demotes = intent.roles !== undefined && !intent.roles.includes('admin')
  if (!intent.deleting && !disables && !demotes) return false
  return countEffectiveSecurityAdmins(db) <= 1
}

/**
 * 用户管理权限天花板：普通 users:W 仍可管理普通账号，但非 admin 不得授予 admin/全写角色，
 * 也不得接管、停用、降权或删除任何仍持 admin 身份的账号（含暂时停用者）。DB 异常时拒绝。
 */
export function requireUserRoleMutationCeiling(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
    return
  }
  try {
    if (userRoleMutationExceedsSecurityCeiling(getDatabase(), req)) {
      sendSecurityCeilingDenied(res)
      return
    }
    next()
  } catch {
    sendSecurityCeilingDenied(res)
  }
}

/**
 * 当前 DB 真值下，用户写是否越过安全管理员天花板。返回 true 即拒绝；异常 fail-closed。
 * 写路由必须在 BEGIN IMMEDIATE 后再次调用，middleware 仅作快拒。
 */
export function userRoleMutationExceedsSecurityCeiling(db: any, req: Request): boolean {
  const authReq = req as AuthRequest
  if (!authReq.user?.userId) return true
  try {
    if (isEffectiveSecurityAdminUser(db, authReq.user.userId)) return false
    const requestedRoles = requestedUserRoleCodes(req.body)
    if (requestedRoles && requestedRolesGrantAdminEquivalent(db, requestedRoles)) return true
    const targetId = req.params?.id
    if (!targetId || !isSecurityAdminAccount(db, targetId)) return false
    return req.method === 'DELETE'
      || ADMIN_ACCOUNT_FIELDS.some((field) => hasOwn(req.body, field))
  } catch {
    return true
  }
}

export type RoleMutationKind = 'create' | 'update' | 'delete'

interface CandidateRoleState {
  previousCode?: string
  nextRole?: {
    code: string
    permissions: unknown
    active: boolean
  }
}

/**
 * 模拟角色写入前后的真实多角色解析，堵住拆分权限、预埋孤儿 role_code，以及角色移除后复活 users.role 的绕过。
 * 这里只判断是否制造等价 admin，不引入“不得授予超过操作者自身权限”的新委派模型。
 */
function candidateRoleWouldGrantAdminEquivalent(db: any, candidate: CandidateRoleState): boolean {
  const users = db.prepare('SELECT id, role FROM users WHERE is_deleted = 0').all() as
    Array<{ id: string; role?: string }>
  const rawAssignments = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ?')
  const activeRole = db.prepare('SELECT permissions FROM roles WHERE code = ? AND status = 1 AND is_deleted = 0')

  const roleAfterMutation = (code: string): { permissions: unknown } | undefined => {
    if (candidate.previousCode === code && candidate.nextRole?.code !== code) return undefined
    if (candidate.nextRole?.code === code) {
      return candidate.nextRole.active ? { permissions: candidate.nextRole.permissions } : undefined
    }
    return activeRole.get(code) as { permissions: unknown } | undefined
  }

  const permissionsAfterMutation = (codes: string[]): PermMap => {
    const effective: PermMap = {}
    for (const code of codes) {
      const role = roleAfterMutation(code)
      if (!role) continue
      if (code === 'admin') return adminAllPermissions()
      mergePermissions(effective, parsePermissions(role.permissions))
    }
    return effective
  }

  for (const user of users) {
    const beforeEquivalent = isAdminEquivalentPermissions(getEffectivePermissions(db, user.id))
    const rawCodes = (rawAssignments.all(user.id) as Array<{ role_code: string }>).map((row) => row.role_code)
    const effectiveCodes = new Set<string>()
    for (const code of rawCodes) {
      if (roleAfterMutation(code)) effectiveCodes.add(code)
    }
    if (effectiveCodes.size === 0 && user.role) {
      if (roleAfterMutation(user.role)) effectiveCodes.add(user.role)
    }
    if (!beforeEquivalent && isAdminEquivalentPermissions(permissionsAfterMutation([...effectiveCodes]))) return true
  }
  return false
}

function nonAdminRoleMutationIsPrivileged(db: any, req: AuthRequest, kind: RoleMutationKind): boolean {
  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
  if (kind === 'create') {
    if (isSystemRoleCode(body.code) || isAdminEquivalentPermissions(body.permissions)) return true
    // 省略 code 仍由路由的 required-field 校验返回 400；显式畸形 code 在 service 闸必须 fail-closed。
    if (!isNonEmptyRoleCode(body.code)) return hasOwn(body, 'code')
    return candidateRoleWouldGrantAdminEquivalent(db, {
      nextRole: {
        code: body.code,
        permissions: body.permissions,
        active: body.status === 'active',
      },
    })
  }
  const current = db.prepare('SELECT code, permissions, status FROM roles WHERE id = ? AND is_deleted = 0').get(req.params?.id) as
    | { code: string; permissions?: string; status: number }
    | undefined
  if (!current) return false
  if (isSystemRoleCode(current.code)) return true
  if (kind === 'delete') {
    return candidateRoleWouldGrantAdminEquivalent(db, { previousCode: current.code })
  }
  const candidateCode = hasOwn(body, 'code') ? body.code : current.code
  const candidatePermissions = hasOwn(body, 'permissions') ? body.permissions : current.permissions
  if (isSystemRoleCode(candidateCode) || isAdminEquivalentPermissions(candidatePermissions)) return true
  if (!isNonEmptyRoleCode(candidateCode)) return true
  return candidateRoleWouldGrantAdminEquivalent(db, {
    previousCode: current.code,
    nextRole: {
      code: candidateCode,
      permissions: candidatePermissions,
      active: hasOwn(body, 'status') ? body.status === 'active' : current.status === 1,
    },
  })
}

/** 角色管理权限天花板：非 admin 不能制造等价 admin，也不能修改/删除系统种子角色。 */
export function requireRoleMutationCeiling(kind: RoleMutationKind) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
      return
    }
    try {
      if (roleMutationExceedsSecurityCeiling(getDatabase(), req, kind)) {
        sendSecurityCeilingDenied(res)
        return
      }
      next()
    } catch {
      sendSecurityCeilingDenied(res)
    }
  }
}

/**
 * 当前 DB 真值下，角色写是否会制造/修改安全管理员等价能力。返回 true 即拒绝；异常 fail-closed。
 * 写路由必须在 BEGIN IMMEDIATE 后再次调用，middleware 仅作快拒。
 */
export function roleMutationExceedsSecurityCeiling(
  db: any,
  req: Request,
  kind: RoleMutationKind,
): boolean {
  const authReq = req as AuthRequest
  if (!authReq.user?.userId) return true
  try {
    if (isEffectiveSecurityAdminUser(db, authReq.user.userId)) return false
    return nonAdminRoleMutationIsPrivileged(db, authReq, kind)
  } catch {
    return true
  }
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
