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
import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '../database/DatabaseManager.js'
import {
  type Level, type PermMap,
  MODULES, NON_ADMIN_ROLES,
  adminAllPermissions, parsePermissions, mergePermissions, hasLevel,
} from './rbac-matrix.js'

export const NAMED_ROLE_CAPABILITY_CODES = ['admin', 'finance', 'lab_director'] as const
const NAMED_ROLE_CAPABILITY_CODE_SET = new Set<string>(NAMED_ROLE_CAPABILITY_CODES)
export const SYSTEM_ROLE_CODES = ['admin', ...NON_ADMIN_ROLES] as const
const SYSTEM_ROLE_CODE_SET = new Set<string>(SYSTEM_ROLE_CODES)

export function isSystemRoleCode(code: string): boolean {
  return SYSTEM_ROLE_CODE_SET.has(code)
}

export function isAdminEquivalentPermissions(raw: unknown): boolean {
  const permissions = parsePermissions(raw)
  return MODULES.every((module) => permissions[module] === 'W')
}

function assertKnownNamedRoleCapabilities(roleCodes: readonly string[]): void {
  if (roleCodes.length === 0) throw new Error('Named role capability gate requires at least one role code')
  for (const code of roleCodes) {
    if (!NAMED_ROLE_CAPABILITY_CODE_SET.has(code)) {
      throw new Error(`Unknown named role capability: ${String(code)}`)
    }
  }
}

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

export interface FullCapabilityProjection {
  permissions: PermMap
  namedRoleCapabilities: Set<string>
  canSeeCost: boolean
  literalAdmin: boolean
}

type RoleCapabilityResolver = (code: string) => { permissions: unknown } | undefined

function projectFullCapabilitiesForRoleCodes(
  db: any,
  roleCodes: string[],
  injectedResolver?: RoleCapabilityResolver,
): FullCapabilityProjection {
  const statement = injectedResolver
    ? undefined
    : db.prepare('SELECT permissions FROM roles WHERE code = ? AND status = 1 AND is_deleted = 0')
  const resolveRole: RoleCapabilityResolver = injectedResolver
    ?? ((code) => statement?.get(code) as { permissions: unknown } | undefined)
  const permissions: PermMap = {}
  const effectiveCodes = new Set<string>()
  for (const code of new Set(roleCodes)) {
    const role = resolveRole(code)
    if (!role) continue
    effectiveCodes.add(code)
    mergePermissions(permissions, code === 'admin' ? adminAllPermissions() : parsePermissions(role.permissions))
  }
  const literalAdmin = effectiveCodes.has('admin')
  const namedRoleCapabilities = new Set<string>()
  for (const code of NAMED_ROLE_CAPABILITY_CODES) {
    if (literalAdmin || effectiveCodes.has(code)) namedRoleCapabilities.add(code)
  }
  const costVisibilityRoles = new Set(getCostVisibilityRoles(db))
  return {
    permissions,
    namedRoleCapabilities,
    canSeeCost: [...effectiveCodes].some((code) => costVisibilityRoles.has(code)),
    literalAdmin,
  }
}

function currentRequestActorCapabilities(db: any, req: Request): FullCapabilityProjection | null {
  const actor = (req as AuthRequest).user
  if (!actor?.userId) return null
  const activeActor = db.prepare(
    'SELECT status, is_deleted FROM users WHERE id = ?',
  ).get(actor.userId) as { status: number; is_deleted: number } | undefined
  if (!activeActor || activeActor.status !== 1 || activeActor.is_deleted !== 0) return null
  return projectFullCapabilitiesForRoleCodes(db, getUserRoleCodes(db, actor.userId))
}

export function requestActorHasCurrentPermission(
  db: any,
  req: Request,
  module: string,
  level: Level,
): boolean {
  try {
    const effective = currentRequestActorCapabilities(db, req)
    return effective !== null && hasLevel(effective.permissions, module, level)
  } catch {
    return false
  }
}

export function requestActorHasCurrentNamedRoleCapability(
  db: DatabaseSync,
  req: Request,
  roleCodes: readonly string[],
): boolean {
  try {
    assertKnownNamedRoleCapabilities(roleCodes)
    const effective = currentRequestActorCapabilities(db, req)
    return effective !== null && roleCodes.some((code) => effective.namedRoleCapabilities.has(code))
  } catch {
    return false
  }
}

const AUDIT_ACTOR_FIELDS = new Set([
  'actor', 'operator',
  'createdBy', 'updatedBy', 'created_by', 'updated_by',
])
const ADMIN_ACCOUNT_FIELDS = ['password', 'status', 'role', 'roles', 'primaryRole'] as const
const ROLE_CODE_FIELDS = ['role', 'code'] as const
const CANONICAL_ROLE_CODE_PATTERN = /^[a-z][a-z0-9_-]*$/u
const PROTOTYPE_LIKE_ROLE_CODES = new Set([
  '__proto__', 'prototype', 'constructor',
  'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
])
const KNOWN_PERMISSION_CODES = new Set<string>(MODULES)

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key)
}

function sendSecurityCeilingDenied(res: Response): void {
  res.status(403).json({
    success: false,
    error: { message: 'Forbidden: security administration requires admin', code: 'FORBIDDEN' },
  })
}

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

export function resolveCanonicalRoleCode(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && value.normalize('NFKC') === value
    && CANONICAL_ROLE_CODE_PATTERN.test(value)
    && !PROTOTYPE_LIKE_ROLE_CODES.has(value)
    ? value
    : null
}

export interface CanonicalActiveRoleSelection {
  roles: string[]
  primaryRole: string
}

export function resolveCanonicalActiveRoleSelection(
  db: DatabaseSync,
  rawRoleCodes: unknown,
  rawPrimaryRole?: unknown,
): CanonicalActiveRoleSelection | null {
  if (!Array.isArray(rawRoleCodes) || rawRoleCodes.length === 0) return null
  const roles: string[] = []
  const seen = new Set<string>()
  for (const rawCode of rawRoleCodes) {
    const code = resolveCanonicalRoleCode(rawCode)
    if (code === null || seen.has(code)) return null
    seen.add(code)
    roles.push(code)
  }
  const findActiveRole = db.prepare(
    'SELECT 1 FROM roles WHERE code = ? AND status = 1 AND is_deleted = 0',
  )
  if (roles.some((code) => !findActiveRole.get(code))) return null
  const primaryRole = rawPrimaryRole === undefined ? roles[0] : resolveCanonicalRoleCode(rawPrimaryRole)
  if (primaryRole === null || !roles.includes(primaryRole)) return null
  return { roles, primaryRole }
}

export function rejectInvalidRoleCodeFields(req: Request, res: Response, next: NextFunction): void {
  const body = req.body
  if (typeof body !== 'object' || body === null) { next(); return }
  const record = body as Record<string, unknown>
  const invalidRoles = hasOwn(record, 'roles') && (
    !Array.isArray(record.roles)
    || record.roles.length === 0
    || record.roles.some((role) => resolveCanonicalRoleCode(role) === null)
    || new Set(record.roles).size !== record.roles.length
  )
  const invalidSingle = ROLE_CODE_FIELDS.some((field) => (
    hasOwn(record, field) && resolveCanonicalRoleCode(record[field]) === null
  ))
  if (invalidRoles || invalidSingle) {
    res.status(400).json({
      success: false,
      error: { message: 'Role codes must be canonical non-empty strings', code: 'INVALID_PARAMETER' },
    })
    return
  }
  next()
}

function isValidRolePermissionsInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every((code) => typeof code === 'string' && (code === '*' || KNOWN_PERMISSION_CODES.has(code)))
  }
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).every(([module, level]) => (
    KNOWN_PERMISSION_CODES.has(module) && (level === 'R' || level === 'W')
  ))
}

export function rejectInvalidRolePermissionFields(req: Request, res: Response, next: NextFunction): void {
  const body = req.body
  if (typeof body !== 'object' || body === null || !hasOwn(body, 'permissions')) { next(); return }
  if (!isValidRolePermissionsInput((body as Record<string, unknown>).permissions)) {
    res.status(400).json({
      success: false,
      error: { message: 'Permissions must contain only known modules with R/W levels', code: 'INVALID_PARAMETER' },
    })
    return
  }
  next()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExactPermissionProjection(value: unknown): value is PermMap {
  if (!isPlainRecord(value)) return false
  return Reflect.ownKeys(value).every((key) => (
    typeof key === 'string'
    && KNOWN_PERMISSION_CODES.has(key)
    && (value[key] === 'R' || value[key] === 'W')
  ))
}

function isExactFullCapabilityProjection(value: unknown): value is FullCapabilityProjection {
  if (!isPlainRecord(value)) return false
  const expectedKeys = ['permissions', 'namedRoleCapabilities', 'canSeeCost', 'literalAdmin'] as const
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key as typeof expectedKeys[number]))
  ) return false
  if (!isExactPermissionProjection(value.permissions)) return false
  const namedCapabilities = value.namedRoleCapabilities
  if (
    !(namedCapabilities instanceof Set)
    || Object.getPrototypeOf(namedCapabilities) !== Set.prototype
    || Reflect.ownKeys(namedCapabilities).length !== 0
  ) return false
  for (const code of namedCapabilities as Set<unknown>) {
    if (typeof code !== 'string' || !NAMED_ROLE_CAPABILITY_CODE_SET.has(code)) return false
  }
  return typeof value.canSeeCost === 'boolean' && typeof value.literalAdmin === 'boolean'
}

export function fullCapabilitiesAreSubsetOfActor(
  candidate: FullCapabilityProjection,
  actorCapabilities: unknown,
): boolean {
  try {
    if (!isExactFullCapabilityProjection(actorCapabilities)) return false
    const actor = actorCapabilities
    if (candidate.literalAdmin && !actor.literalAdmin) return false
    if (candidate.canSeeCost && !actor.canSeeCost) return false
    if ([...candidate.namedRoleCapabilities].some((code) => !actor.namedRoleCapabilities.has(code))) return false
    return Object.entries(candidate.permissions).every(
      ([module, level]) => hasLevel(actor.permissions, module, level),
    )
  } catch {
    return false
  }
}

function activeFullCapabilitiesForRoleCodes(db: DatabaseSync, roleCodes: string[]): FullCapabilityProjection | null {
  const resolved = resolveCanonicalActiveRoleSelection(db, roleCodes)
  return resolved ? projectFullCapabilitiesForRoleCodes(db, resolved.roles) : null
}

export function isEffectiveSecurityAdminUser(db: any, userId: string): boolean {
  const user = db.prepare('SELECT status, is_deleted FROM users WHERE id = ?').get(userId) as
    | { status: number; is_deleted: number }
    | undefined
  return !!user && user.status === 1 && user.is_deleted === 0 && getUserRoleCodes(db, userId).includes('admin')
}

function isSecurityAdminAccount(db: any, userId: string): boolean {
  const user = db.prepare('SELECT role, is_deleted FROM users WHERE id = ?').get(userId) as
    | { role?: string; is_deleted: number }
    | undefined
  if (!user || user.is_deleted !== 0) return false
  if (user.role === 'admin') return true
  if (db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = 'admin'").get(userId)) return true
  return isAdminEquivalentPermissions(getEffectivePermissionsForRoles(db, getUserRoleCodes(db, userId)))
}

export function countEffectiveSecurityAdmins(db: any): number {
  const users = db.prepare('SELECT id FROM users WHERE status = 1 AND is_deleted = 0').all() as Array<{ id: string }>
  return users.reduce(
    (count, user) => count + (getUserRoleCodes(db, user.id).includes('admin') ? 1 : 0),
    0,
  )
}

export interface SecurityAdminRemovalIntent {
  deleting?: boolean
  status?: unknown
  roles?: string[]
}

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

function requestedUserRoleCodes(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null
  const candidate = body as { role?: unknown; roles?: unknown }
  if (Array.isArray(candidate.roles)) {
    if (candidate.roles.length === 0) throw new TypeError('Invalid role code')
    const roles: string[] = []
    const seen = new Set<string>()
    for (const rawRole of candidate.roles) {
      const role = resolveCanonicalRoleCode(rawRole)
      if (role === null || seen.has(role)) throw new TypeError('Invalid role code')
      seen.add(role)
      roles.push(role)
    }
    return roles
  }
  if (hasOwn(candidate, 'role')) {
    const role = resolveCanonicalRoleCode(candidate.role)
    if (role === null) throw new TypeError('Invalid role code')
    return [role]
  }
  return null
}

export function userRoleMutationExceedsSecurityCeiling(
  db: DatabaseSync,
  req: Request,
  resolvedRoleCodes?: string[],
): boolean {
  const authReq = req as AuthRequest
  if (!authReq.user?.userId) return true
  try {
    const actorCapabilities = currentRequestActorCapabilities(db, req)
    if (!actorCapabilities) return true
    if (isEffectiveSecurityAdminUser(db, authReq.user.userId)) return false
    const requestedRoles = resolvedRoleCodes ?? requestedUserRoleCodes(req.body)
    let candidateCapabilities: FullCapabilityProjection | null = null
    if (requestedRoles) {
      candidateCapabilities = activeFullCapabilitiesForRoleCodes(db, requestedRoles)
      if (
        !candidateCapabilities
        || isAdminEquivalentPermissions(candidateCapabilities.permissions)
        || !fullCapabilitiesAreSubsetOfActor(candidateCapabilities, actorCapabilities)
      ) return true
    }
    const targetId = req.params?.id
    if (!targetId) return false
    if (isSecurityAdminAccount(db, targetId)) {
      return req.method === 'DELETE'
        || ADMIN_ACCOUNT_FIELDS.some((field) => hasOwn(req.body, field))
    }
    const target = db.prepare('SELECT status, is_deleted FROM users WHERE id = ?').get(targetId) as
      | { status: number; is_deleted: number }
      | undefined
    if (!target || target.is_deleted !== 0 || req.method !== 'PUT') return false
    const transfersControl = hasOwn(req.body, 'password')
      || ((req.body as Record<string, unknown>).status === 'active' && target.status !== 1)
    if (!transfersControl) return false
    const targetCapabilities = candidateCapabilities
      ?? projectFullCapabilitiesForRoleCodes(db, getUserRoleCodes(db, targetId))
    return !fullCapabilitiesAreSubsetOfActor(targetCapabilities, actorCapabilities)
  } catch {
    return true
  }
}

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

export type RoleMutationKind = 'create' | 'update' | 'delete'

function fullCapabilityGainsAreDelegable(
  before: FullCapabilityProjection,
  after: FullCapabilityProjection,
  actor: FullCapabilityProjection,
): boolean {
  if (!before.literalAdmin && after.literalAdmin && !actor.literalAdmin) return false
  if (!before.canSeeCost && after.canSeeCost && !actor.canSeeCost) return false
  if ([...after.namedRoleCapabilities].some((code) => (
    !before.namedRoleCapabilities.has(code) && !actor.namedRoleCapabilities.has(code)
  ))) return false
  return Object.entries(after.permissions).every(([module, level]) => (
    hasLevel(before.permissions, module, level) || hasLevel(actor.permissions, module, level)
  ))
}

function permissionsBecomeAdminEquivalent(before: unknown, after: unknown): boolean {
  return !isAdminEquivalentPermissions(before) && isAdminEquivalentPermissions(after)
}

interface CandidateRoleState {
  previousCode?: string
  nextRole?: { code: string; permissions: unknown; active: boolean }
}

function candidateRoleWouldEscalateCapabilities(
  db: DatabaseSync,
  candidate: CandidateRoleState,
  actor: FullCapabilityProjection,
): boolean {
  const users = db.prepare('SELECT id, role FROM users WHERE is_deleted = 0').all() as
    Array<{ id: string; role?: string }>
  const rawAssignments = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ?')
  const activeRole = db.prepare(
    'SELECT permissions FROM roles WHERE code = ? AND status = 1 AND is_deleted = 0',
  )
  const roleAfterMutation: RoleCapabilityResolver = (code) => {
    if (candidate.previousCode === code && candidate.nextRole?.code !== code) return undefined
    if (candidate.nextRole?.code === code) {
      return candidate.nextRole.active ? { permissions: candidate.nextRole.permissions } : undefined
    }
    return activeRole.get(code) as { permissions: unknown } | undefined
  }

  for (const user of users) {
    const beforeCodes = getUserRoleCodes(db, user.id)
    const rawCodes = (rawAssignments.all(user.id) as Array<{ role_code: string }>).map((row) => row.role_code)
    const afterCodes = new Set<string>()
    for (const code of rawCodes) {
      if (roleAfterMutation(code)) afterCodes.add(code)
    }
    if (afterCodes.size === 0 && user.role && roleAfterMutation(user.role)) afterCodes.add(user.role)
    const before = projectFullCapabilitiesForRoleCodes(db, beforeCodes)
    const after = projectFullCapabilitiesForRoleCodes(db, [...afterCodes], roleAfterMutation)
    if (
      (!before.literalAdmin && after.literalAdmin)
      || permissionsBecomeAdminEquivalent(before.permissions, after.permissions)
      || !fullCapabilityGainsAreDelegable(before, after, actor)
    ) return true
  }
  return false
}

function candidateRoleCapabilities(
  db: DatabaseSync,
  code: string,
  permissions: unknown,
  active: boolean,
): FullCapabilityProjection {
  return projectFullCapabilitiesForRoleCodes(
    db,
    [code],
    (candidateCode) => active && candidateCode === code ? { permissions } : undefined,
  )
}

function nonAdminRoleMutationIsPrivileged(
  db: DatabaseSync,
  req: AuthRequest,
  kind: RoleMutationKind,
  actor: FullCapabilityProjection,
): boolean {
  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
  if (kind === 'create') {
    const code = resolveCanonicalRoleCode(body.code)
    if (code === null) return hasOwn(body, 'code')
    if (isSystemRoleCode(code) || isAdminEquivalentPermissions(body.permissions)) return true
    const candidate = candidateRoleCapabilities(db, code, body.permissions, body.status === 'active')
    if (body.status === 'active' && !fullCapabilitiesAreSubsetOfActor(candidate, actor)) return true
    return candidateRoleWouldEscalateCapabilities(
      db,
      { nextRole: { code, permissions: body.permissions, active: body.status === 'active' } },
      actor,
    )
  }
  const current = db.prepare(
    'SELECT code, permissions, status FROM roles WHERE id = ? AND is_deleted = 0',
  ).get(req.params?.id) as { code: string; permissions?: string; status: number } | undefined
  if (!current) return false
  if (isSystemRoleCode(current.code)) return true
  if (kind === 'delete') {
    return candidateRoleWouldEscalateCapabilities(db, { previousCode: current.code }, actor)
  }
  const code = resolveCanonicalRoleCode(hasOwn(body, 'code') ? body.code : current.code)
  if (code === null || isSystemRoleCode(code)) return true
  const permissions = hasOwn(body, 'permissions') ? body.permissions : current.permissions
  if (!isAdminEquivalentPermissions(current.permissions) && isAdminEquivalentPermissions(permissions)) return true
  const active = hasOwn(body, 'status') ? body.status === 'active' : current.status === 1
  if (active && !fullCapabilitiesAreSubsetOfActor(
    candidateRoleCapabilities(db, code, permissions, active),
    actor,
  )) return true
  return candidateRoleWouldEscalateCapabilities(
    db,
    {
      previousCode: current.code,
      nextRole: { code, permissions, active },
    },
    actor,
  )
}

export function roleMutationExceedsSecurityCeiling(
  db: DatabaseSync,
  req: Request,
  kind: RoleMutationKind,
): boolean {
  const authReq = req as AuthRequest
  if (!authReq.user?.userId) return true
  try {
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
    if (kind !== 'delete' && hasOwn(body, 'code') && resolveCanonicalRoleCode(body.code) === null) return true
    const actor = currentRequestActorCapabilities(db, req)
    if (!actor) return true
    if (isEffectiveSecurityAdminUser(db, authReq.user.userId)) return false
    return nonAdminRoleMutationIsPrivileged(db, authReq, kind, actor)
  } catch {
    return true
  }
}

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
  assertKnownNamedRoleCapabilities(roleCodes)
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
