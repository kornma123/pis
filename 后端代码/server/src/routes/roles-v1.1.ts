import { Router } from 'express'
import { closeDatabase, getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { v4 as uuidv4 } from 'uuid'
import { parsePermissions } from '../middleware/rbac-matrix.js'
import {
  rejectInvalidRoleCodeFields,
  rejectInvalidRolePermissionFields,
  rejectUntrustedAuditActorFields,
  requestActorHasCurrentPermission,
  resolveCanonicalRoleCode,
  requirePermission,
  requireRoleMutationCeiling,
  roleMutationExceedsSecurityCeiling,
} from '../middleware/permissions.js'
import { findRoleLiveAssignments, recoverFailedDeleteTransaction } from '../utils/delete-reference-guards.js'

const router = Router()

// 角色写入（改权限矩阵 = 提权面最大）：挂载层只 requirePermission('roles','R')，
// 写端点必须自带 W 守卫，否则持 roles:R 者即可改矩阵给自己提权。仿 projects/outbound 模式。
const requireRolesWrite = requirePermission('roles', 'W')
const requireRoleCreateCeiling = requireRoleMutationCeiling('create')
const requireRoleUpdateCeiling = requireRoleMutationCeiling('update')
const requireRoleDeleteCeiling = requireRoleMutationCeiling('delete')

// 规范化权限为对象矩阵 {module:'R'|'W'}（兼容旧数组/含 '*'），落库 + 返回统一形态
function normalizePerms(raw: any): string {
  return JSON.stringify(parsePermissions(raw))
}

router.get('/', (req, res) => {
  const database = getDatabase()
  const page = Number(req.query.page) || 1
  const pageSize = Number(req.query.pageSize) || 20
  const offset = (page - 1) * pageSize

  const stmt = database.prepare('SELECT * FROM roles WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?')
  const list = (stmt.all(pageSize, offset) as any[]).map((r: any) => ({
    ...r,
    permissions: (() => {
      try { return JSON.parse(r.permissions || '[]') } catch { return [] }
    })()
  }))

  const countStmt = database.prepare('SELECT COUNT(*) as total FROM roles WHERE is_deleted = 0')
  const { total } = countStmt.get() as any

  successList(res, list, page, pageSize, total)
})

router.post(
  '/',
  rejectInvalidRoleCodeFields,
  requireRolesWrite,
  rejectUntrustedAuditActorFields,
  rejectInvalidRolePermissionFields,
  requireRoleCreateCeiling,
  (req, res) => {
  try {
    const database = getDatabase()
    const { code, name, description, permissions, status } = req.body
    const canonicalCode = resolveCanonicalRoleCode(code)
    if (canonicalCode === null || !name) {
      error(res, 'Code and name required', 'INVALID_PARAMETER', 400)
      return
    }
    database.exec('BEGIN IMMEDIATE')
    if (
      !requestActorHasCurrentPermission(database, req, 'roles', 'W')
      || roleMutationExceedsSecurityCeiling(database, req, 'create')
    ) {
      database.exec('ROLLBACK')
      error(res, 'Forbidden: security administration requires admin', 'FORBIDDEN', 403)
      return
    }
    const exists = database.prepare('SELECT 1 FROM roles WHERE code = ? AND is_deleted = 0').get(canonicalCode)
    if (exists) {
      database.exec('ROLLBACK')
      error(res, 'Role code already exists', 'RESOURCE_CONFLICT', 409)
      return
    }
    const id = uuidv4()
    database.prepare('INSERT INTO roles (id, code, name, description, permissions, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, canonicalCode, name, description || '', normalizePerms(permissions), status === 'active' ? 1 : 0)
    database.exec('COMMIT')
    success(res, { id }, 'Created', 201)
  } catch (err: any) {
    try { getDatabase().exec('ROLLBACK') } catch { /* no active transaction */ }
    error(res, err.message)
  }
})

router.put(
  '/:id',
  rejectInvalidRoleCodeFields,
  requireRolesWrite,
  rejectUntrustedAuditActorFields,
  rejectInvalidRolePermissionFields,
  requireRoleUpdateCeiling,
  (req, res) => {
  let database: ReturnType<typeof getDatabase> | undefined
  let transactionStarted = false
  try {
    database = getDatabase()
    const { id } = req.params
    const { code, name, description, permissions, status } = req.body
    let canonicalCode: string | undefined
    if (code !== undefined) {
      const resolvedCode = resolveCanonicalRoleCode(code)
      if (resolvedCode === null) {
        error(res, 'Role code must be canonical', 'INVALID_PARAMETER', 400)
        return
      }
      canonicalCode = resolvedCode
    }
    database.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    if (
      !requestActorHasCurrentPermission(database, req, 'roles', 'W')
      || roleMutationExceedsSecurityCeiling(database, req, 'update')
    ) {
      database.exec('ROLLBACK')
      transactionStarted = false
      error(res, 'Forbidden: security administration requires admin', 'FORBIDDEN', 403)
      return
    }
    const role = database.prepare('SELECT * FROM roles WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!role) {
      database.exec('ROLLBACK')
      transactionStarted = false
      error(res, 'Role not found', 'NOT_FOUND', 404); return
    }
    if (role.code === 'admin') {
      database.exec('ROLLBACK')
      transactionStarted = false
      error(res, 'Cannot modify system admin role', 'FORBIDDEN', 403); return
    }
    const fields: string[] = []; const params: any[] = []
    if (canonicalCode !== undefined) {
      if (canonicalCode !== role.code) {
        const codeExists = database.prepare('SELECT 1 FROM roles WHERE code = ? AND id != ? AND is_deleted = 0').get(canonicalCode, id)
        if (codeExists) {
          database.exec('ROLLBACK')
          transactionStarted = false
          error(res, 'Role code already exists', 'RESOURCE_CONFLICT', 409); return
        }
      }
      fields.push('code = ?'); params.push(canonicalCode)
    }
    if (name !== undefined) { fields.push('name = ?'); params.push(name) }
    if (description !== undefined) { fields.push('description = ?'); params.push(description || '') }
    if (permissions !== undefined) { fields.push('permissions = ?'); params.push(normalizePerms(permissions)) }
    if (status !== undefined) { fields.push('status = ?'); params.push(status === 'active' ? 1 : 0) }
    if (fields.length > 0) {
      params.push(id)
      database.prepare(`UPDATE roles SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params)
    }
    database.exec('COMMIT')
    transactionStarted = false
    success(res, { id }, 'Updated')
  } catch (err: any) {
    if (database && transactionStarted) database.exec('ROLLBACK')
    error(res, err.message)
  }
})

router.delete(
  '/:id',
  requireRolesWrite,
  rejectUntrustedAuditActorFields,
  requireRoleDeleteCeiling,
  (req, res) => {
  let database: ReturnType<typeof getDatabase> | undefined
  let transactionOpen = false
  try {
    database = getDatabase()
    const { id } = req.params
    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    if (
      !requestActorHasCurrentPermission(database, req, 'roles', 'W')
      || roleMutationExceedsSecurityCeiling(database, req, 'delete')
    ) {
      database.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Forbidden: security administration requires admin', 'FORBIDDEN', 403)
      return
    }
    const existing = database.prepare('SELECT * FROM roles WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!existing) {
      database.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Not found', 'NOT_FOUND', 404)
      return
    }
    if (existing.code === 'admin') {
      database.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Cannot delete system admin role', 'FORBIDDEN', 403)
      return
    }
    if (findRoleLiveAssignments(database, existing.code).length > 0) {
      database.exec('ROLLBACK')
      transactionOpen = false
      error(res, 'Role is still assigned to active users', 'ENTITY_IN_USE', 409)
      return
    }
    database.prepare('UPDATE roles SET is_deleted = 1 WHERE id = ?').run(id)
    database.exec('COMMIT')
    transactionOpen = false
    success(res, { id }, 'Deleted')
  } catch (err: any) {
    if (database && transactionOpen && !recoverFailedDeleteTransaction(database, closeDatabase)) {
      error(res, 'Delete transaction recovery failed', 'INTERNAL_ERROR', 500)
      return
    }
    error(res, err.message)
  }
})

export default router
