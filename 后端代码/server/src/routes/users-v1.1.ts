import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { closeDatabase, getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import {
  detectSoDConflicts,
  getUserRoleCodes,
  rejectUntrustedAuditActorFields,
  requestActorHasCurrentPermission,
  resolveCanonicalActiveRoleSelection,
  requirePermission,
  requireUserRoleMutationCeiling,
  userRoleMutationExceedsSecurityCeiling,
  wouldRemoveLastEffectiveAdmin,
} from '../middleware/permissions.js'
import { findUserLiveOwnership, recoverFailedDeleteTransaction } from '../utils/delete-reference-guards.js'
import { accountPasswordProblem, hashMatchesKnownLeakedDefaultPassword } from '../config/security.js'

const router = Router()

// 用户写入（改角色/改密码 = 提权入口）：挂载层只 requirePermission('users','R')，
// 写端点必须自带 W 守卫，否则持 users:R 者即可增删改用户、改他人角色给自己提权。仿 projects/outbound 模式。
const requireUsersWrite = requirePermission('users', 'W')

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key)
}

function passwordWriteProblem(password: unknown): string | null {
  if (typeof password !== 'string') return '必须是字符串'
  return accountPasswordProblem(password)
}

// 同步用户多角色 → user_roles + primary_role + users.role(主角色,兼容旧链路)
function syncUserRoles(db: DatabaseSync, userId: string, roles: string[], primaryRole: string): void {
  if (roles.length === 0 || !roles.includes(primaryRole)) throw new TypeError('Resolved user roles required')
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
  const ins = db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
  for (const rc of roles) ins.run(`UR-${userId}-${rc}`, userId, rc)
  db.prepare('UPDATE users SET role = ?, primary_role = ? WHERE id = ?').run(primaryRole, primaryRole, userId)
}

function getUserRoles(db: any, userId: string): string[] {
  const rows = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ?').all(userId) as Array<{ role_code: string }>
  return rows.map((r) => r.role_code)
}

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (keyword) { where += ' AND (username LIKE ? OR real_name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM users WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)
    const list = db.prepare(`SELECT id, username, real_name, role, primary_role, department, phone, email, status, created_at FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset) as any[]

    successList(res, list.map((r: any) => {
      const roles = getUserRoles(db, r.id)
      return {
        id: r.id, username: r.username, realName: r.real_name,
        role: r.role, primaryRole: r.primary_role || r.role,
        roles: roles.length ? roles : (r.role ? [r.role] : []),
        department: r.department, phone: r.phone,
        email: r.email, status: r.status === 1 ? 'active' : 'inactive',
        createdAt: r.created_at,
      }
    }), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', requireUsersWrite, rejectUntrustedAuditActorFields, (req, res) => {
  try {
    const { username, password, realName, role, roles, primaryRole, department, phone } = req.body
    if (!username || !password || !realName) { error(res, 'Username, password and realName required', 'INVALID_PARAMETER', 400); return }
    const passwordProblem = passwordWriteProblem(password)
    if (passwordProblem) { error(res, `Password ${passwordProblem}`, 'INVALID_PARAMETER', 400); return }
    const id = uuidv4()
    const hashedPassword = bcrypt.hashSync(password, 12)
    const db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    if (!requestActorHasCurrentPermission(db, req, 'users', 'W')) {
      db.exec('ROLLBACK')
      error(res, 'Forbidden: security administration requires admin', 'FORBIDDEN', 403)
      return
    }
    const requestedRoleCodes = hasOwn(req.body, 'roles')
      ? roles
      : hasOwn(req.body, 'role') ? [role] : ['operator']
    const resolvedRoles = resolveCanonicalActiveRoleSelection(db, requestedRoleCodes, primaryRole)
    if (!resolvedRoles) {
      db.exec('ROLLBACK')
      error(res, 'Role codes must reference active canonical roles', 'INVALID_PARAMETER', 400)
      return
    }
    if (userRoleMutationExceedsSecurityCeiling(db, req, resolvedRoles.roles)) {
      db.exec('ROLLBACK')
      error(res, 'Forbidden: security administration requires admin', 'FORBIDDEN', 403)
      return
    }
    db.prepare('INSERT INTO users (id, username, password, real_name, role, primary_role, department, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, username, hashedPassword, realName, resolvedRoles.primaryRole, resolvedRoles.primaryRole, department || null, phone || null)
    syncUserRoles(db, id, resolvedRoles.roles, resolvedRoles.primaryRole)
    const sodWarning = detectSoDConflicts(resolvedRoles.roles)
    db.exec('COMMIT')
    success(res, {
      id,
      roles: resolvedRoles.roles,
      primaryRole: resolvedRoles.primaryRole,
      sodWarning,
    }, 'Created', 201)
  } catch (err: any) {
    try { getDatabase().exec('ROLLBACK') } catch { /* no active transaction */ }
    if (err.message.includes('UNIQUE')) { error(res, 'Username exists', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', requireUsersWrite, rejectUntrustedAuditActorFields, (req, res) => {
  try {
    const { id } = req.params
    const data = req.body
    const db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    if (!requestActorHasCurrentPermission(db, req, 'users', 'W')) {
      db.exec('ROLLBACK')
      error(res, 'Forbidden: security administration requires admin', 'FORBIDDEN', 403)
      return
    }
    const existing = db.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!existing) {
      db.exec('ROLLBACK')
      error(res, 'Not found', 'NOT_FOUND', 404)
      return
    }
    const roleSelectionWasRequested = hasOwn(data, 'roles') || hasOwn(data, 'role')
    const primaryRoleWasRequested = hasOwn(data, 'primaryRole')
    const requestedRoleCodes = hasOwn(data, 'roles')
      ? data.roles
      : hasOwn(data, 'role') ? [data.role] : getUserRoleCodes(db, id)
    const requestedPrimaryRole = primaryRoleWasRequested ? data.primaryRole : undefined
    const preservesRolelessAccount = !roleSelectionWasRequested
      && !primaryRoleWasRequested
      && Array.isArray(requestedRoleCodes)
      && requestedRoleCodes.length === 0
    const resolvedRoles = preservesRolelessAccount
      ? null
      : resolveCanonicalActiveRoleSelection(db, requestedRoleCodes, requestedPrimaryRole)
    if (!preservesRolelessAccount && !resolvedRoles) {
      db.exec('ROLLBACK')
      error(res, 'Role codes must reference active canonical roles', 'INVALID_PARAMETER', 400)
      return
    }
    if (userRoleMutationExceedsSecurityCeiling(
      db,
      req,
      roleSelectionWasRequested ? resolvedRoles!.roles : undefined,
    )) {
      db.exec('ROLLBACK')
      error(res, 'Forbidden: security administration requires admin', 'FORBIDDEN', 403)
      return
    }
    if ((existing.username === 'admin' || existing.id === 'USER-001') && data.status !== undefined && data.status !== 'active') {
      db.exec('ROLLBACK')
      error(res, 'Cannot disable admin account', 'BUSINESS_CONFLICT', 409)
      return
    }
    if (hasOwn(data, 'password')) {
      const passwordProblem = passwordWriteProblem(data.password)
      if (passwordProblem) {
        db.exec('ROLLBACK')
        error(res, `Password ${passwordProblem}`, 'INVALID_PARAMETER', 400)
        return
      }
    }
    const isReactivating = data.status === 'active' && existing.status !== 1
    if (
      isReactivating
      && hashMatchesKnownLeakedDefaultPassword(existing.password)
      && !hasOwn(data, 'password')
    ) {
      db.exec('ROLLBACK')
      error(res, 'Password must be replaced before reactivating this account', 'INVALID_PARAMETER', 400)
      return
    }
    const replacementRoles = roleSelectionWasRequested ? resolvedRoles!.roles : undefined
    if (wouldRemoveLastEffectiveAdmin(db, id, { status: data.status, roles: replacementRoles })) {
      db.exec('ROLLBACK')
      error(res, 'Cannot remove the last effective admin', 'BUSINESS_CONFLICT', 409)
      return
    }
    const fields: string[] = []; const params: any[] = []
    if (data.realName !== undefined) { fields.push('real_name = ?'); params.push(data.realName) }
    if (data.department !== undefined) { fields.push('department = ?'); params.push(data.department) }
    if (data.phone !== undefined) { fields.push('phone = ?'); params.push(data.phone) }
    if (data.email !== undefined) { fields.push('email = ?'); params.push(data.email) }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status === 'active' ? 1 : 0) }
    if (data.password !== undefined) { fields.push('password = ?'); params.push(bcrypt.hashSync(data.password, 12)) }
    if (fields.length > 0) {
      params.push(id)
      db.prepare(`UPDATE users SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params)
    }
    let sodWarning: string[] = []
    if (roleSelectionWasRequested || primaryRoleWasRequested) {
      syncUserRoles(db, id, resolvedRoles!.roles, resolvedRoles!.primaryRole)
      sodWarning = detectSoDConflicts(resolvedRoles!.roles)
    }
    const effectiveRoles = getUserRoles(db, id)
    db.exec('COMMIT')
    success(res, { id, roles: effectiveRoles, sodWarning }, 'Updated')
  } catch (err: any) {
    try { getDatabase().exec('ROLLBACK') } catch { /* no active transaction */ }
    error(res, err.message)
  }
})

router.delete('/:id',
  requireUsersWrite,
  rejectUntrustedAuditActorFields,
  requireUserRoleMutationCeiling,
  (req, res) => {
  let db: ReturnType<typeof getDatabase> | undefined
  let transactionOpen = false
  try {
    const { id } = req.params
    db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    if (
      !requestActorHasCurrentPermission(db, req, 'users', 'W')
      || userRoleMutationExceedsSecurityCeiling(db, req)
    ) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Forbidden: security administration requires admin', 'FORBIDDEN', 403)
      return
    }
    const existing = db.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!existing) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Not found', 'NOT_FOUND', 404)
      return
    }
    // 禁止删除 admin 账户
    if (existing.username === 'admin' || existing.id === 'USER-001') {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Cannot delete admin account', 'BUSINESS_CONFLICT', 409)
      return
    }
    if (wouldRemoveLastEffectiveAdmin(db, id, { deleting: true })) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Cannot remove the last effective admin', 'BUSINESS_CONFLICT', 409)
      return
    }
    if (findUserLiveOwnership(db, existing.username).length > 0) {
      db.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'User still owns live assignments', 'ENTITY_IN_USE', 409)
      return
    }
    db.prepare('UPDATE users SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    db.exec('COMMIT')
    transactionOpen = false
    success(res, null, 'Deleted')
  } catch (err: any) {
    if (db && transactionOpen && !recoverFailedDeleteTransaction(db, closeDatabase)) {
      error(res, 'Delete transaction recovery failed', 'INTERNAL_ERROR', 500)
      return
    }
    error(res, err.message)
  }
})

export default router
