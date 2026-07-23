import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'
import { JWT_SECRET, authenticateToken } from '../middleware/auth.js'
import { isFixtureEnv } from '../config/security.js'
import {
  getEffectivePermissions,
  getUserRoleCodes,
  canSeeCost,
  getCostVisibilityRoles,
  requestActorHasCurrentNamedRoleCapability,
  requireAnyRole,
  resolveCanonicalActiveRoleSelection,
} from '../middleware/permissions.js'

const router = Router()
const JWT_EXPIRES = '8h'

function isExactCostVisibilityPayload(value: unknown): value is { roles: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === 1 && ownKeys[0] === 'roles'
}

/** 当前用户能力载荷（数据驱动 RBAC：角色并集权限 + 成本可见性，前端 nav/守卫/仪表盘单一来源） */
function buildCapabilityPayload(db: any, userId: string, ...preferredRoles: Array<string | undefined>) {
  const roles = getUserRoleCodes(db, userId)
  const primaryRole = preferredRoles.find(role => role && roles.includes(role)) || roles[0] || null
  return {
    primaryRole,
    roles,
    capabilities: getEffectivePermissions(db, userId),
    canSeeCost: canSeeCost(db, userId),
  }
}

router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      error(res, 'Username and password required', 'INVALID_PARAMETER', 400)
      return
    }

    const db = getDatabase()
    let user = db.prepare('SELECT * FROM users WHERE username = ? AND status = 1 AND is_deleted = 0').get(username) as any

    // 兜底修复：仅在显式声明的 dev/test 环境恢复被软删除的夹具用户（E2E 软删后无法恢复的副作用）。
    // 安全止血（fail-closed）：未声明为 dev/test 的环境「绝不」在登录时自动恢复软删除账号——否则
    //   禁用一个被攻破/默认账号会被任何一次登录探测悄悄撤销（原逻辑对任意用户名、且在校验口令前就恢复）。
    if (!user && isFixtureEnv()) {
      const softDeletedUser = db.prepare('SELECT * FROM users WHERE username = ? AND is_deleted = 1').get(username) as any
      if (softDeletedUser) {
        // 自动恢复被软删除的用户（E2E 测试副作用，仅开发/测试）
        db.prepare('UPDATE users SET is_deleted = 0, status = 1 WHERE username = ?').run(username)
        // 重新查询
        user = db.prepare('SELECT * FROM users WHERE username = ? AND status = 1 AND is_deleted = 0').get(username) as any
      }
    }

    const validPassword = user && bcrypt.compareSync(password, user.password)
    if (!validPassword) {
      error(res, '用户名或密码错误', 'UNAUTHORIZED', 401)
      return
    }

    const cap = buildCapabilityPayload(db, user.id, user.primary_role, user.role)
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: cap.primaryRole || '', type: 'access' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES, algorithm: 'HS256' }
    )

    const refreshToken = jwt.sign(
      { userId: user.id, type: 'refresh' },
      JWT_SECRET,
      { expiresIn: '7d', algorithm: 'HS256' }
    )

    success(res, {
      token,
      refreshToken,
      expiresIn: 28800,
      user: {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        role: cap.primaryRole,
        primaryRole: cap.primaryRole,
        roles: cap.roles,
        capabilities: cap.capabilities,
        canSeeCost: cap.canSeeCost,
      },
    }, 'Login success')
  } catch (err: any) {
    error(res, err.message, 'INTERNAL_ERROR', 500)
  }
})

router.post('/refresh', (req, res) => {
  try {
    const { refreshToken } = req.body
    if (!refreshToken) {
      error(res, 'Refresh token required', 'INVALID_PARAMETER', 400)
      return
    }

    const decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; type: string }
    if (decoded.type !== 'refresh') {
      error(res, 'Invalid refresh token', 'UNAUTHORIZED', 401)
      return
    }

    const db = getDatabase()
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').get(decoded.userId) as any

    if (!user || user.status !== 1) {
      error(res, 'User not found or disabled', 'UNAUTHORIZED', 401)
      return
    }

    const cap = buildCapabilityPayload(db, user.id, user.primary_role, user.role)
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: cap.primaryRole || '', type: 'access' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES, algorithm: 'HS256' }
    )

    success(res, {
      token,
      expiresIn: 28800,
      user: {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        role: cap.primaryRole,
        primaryRole: cap.primaryRole,
        roles: cap.roles,
        capabilities: cap.capabilities,
        canSeeCost: cap.canSeeCost,
      },
    }, 'Refresh success')
  } catch (err: any) {
    error(res, err.message, 'UNAUTHORIZED', 401)
  }
})

// 当前用户能力（数据驱动 RBAC 单一来源；改矩阵/角色后前端刷新即生效）
router.get('/me/capabilities', authenticateToken, (req, res) => {
  try {
    const db = getDatabase()
    const userId = (req as any).user.userId as string
    const u = db.prepare('SELECT role, primary_role FROM users WHERE id = ?').get(userId) as any
    const cap = buildCapabilityPayload(db, userId, u?.primary_role, u?.role)
    success(res, cap)
  } catch (err: any) {
    error(res, err.message, 'INTERNAL_ERROR', 500)
  }
})

// 成本可见性开关（可配置默认）：读取当前允许看成本/利润的角色集合
router.get('/cost-visibility', authenticateToken, (_req, res) => {
  try {
    success(res, { roles: getCostVisibilityRoles(getDatabase()) })
  } catch (err: any) {
    error(res, err.message, 'INTERNAL_ERROR', 500)
  }
})

// 更新成本可见性角色集合（限运营管理者：admin/lab_director）
router.put('/cost-visibility', authenticateToken, requireAnyRole('admin', 'lab_director'), (req, res) => {
  let db: ReturnType<typeof getDatabase> | undefined
  let transactionStarted = false
  try {
    db = getDatabase()
    db.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    if (!requestActorHasCurrentNamedRoleCapability(db, req, ['admin', 'lab_director'])) {
      db.exec('ROLLBACK')
      transactionStarted = false
      error(res, 'Forbidden: current actor is no longer authorized', 'FORBIDDEN', 403)
      return
    }
    if (!isExactCostVisibilityPayload(req.body)) {
      db.exec('ROLLBACK')
      transactionStarted = false
      error(res, 'Cost visibility payload must contain only roles', 'INVALID_PARAMETER', 400)
      return
    }
    const { roles } = req.body
    if (!Array.isArray(roles) || roles.length === 0) {
      db.exec('ROLLBACK')
      transactionStarted = false
      error(res, 'Role codes must reference active canonical roles', 'INVALID_PARAMETER', 400)
      return
    }
    const candidateRoles = roles.includes('admin') ? roles : [...roles, 'admin']
    const resolvedRoles = resolveCanonicalActiveRoleSelection(db, candidateRoles)
    if (!resolvedRoles) {
      db.exec('ROLLBACK')
      transactionStarted = false
      error(res, 'Role codes must reference active canonical roles', 'INVALID_PARAMETER', 400)
      return
    }
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('cost_visibility_roles', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
      .run(JSON.stringify(resolvedRoles.roles))
    db.exec('COMMIT')
    transactionStarted = false
    success(res, { roles: resolvedRoles.roles }, 'Updated')
  } catch (err: any) {
    if (db && transactionStarted) db.exec('ROLLBACK')
    error(res, err.message, 'INTERNAL_ERROR', 500)
  }
})

router.post('/logout', (_req, res) => {
  success(res, null, 'Logout success')
})

export default router
