import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'
import { JWT_SECRET, authenticateToken } from '../middleware/auth.js'
import { getEffectivePermissions, getUserRoleCodes, canSeeCost, getCostVisibilityRoles, requireAnyRole } from '../middleware/permissions.js'

const router = Router()
const JWT_EXPIRES = '8h'

/** 当前用户能力载荷（数据驱动 RBAC：角色并集权限 + 成本可见性，前端 nav/守卫/仪表盘单一来源） */
function buildCapabilityPayload(db: any, userId: string, fallbackRole?: string) {
  const roles = getUserRoleCodes(db, userId)
  return {
    roles: roles.length ? roles : (fallbackRole ? [fallbackRole] : []),
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

    // 兜底修复：仅在「开发/测试」环境恢复被软删除的夹具用户（E2E 软删后无法恢复的副作用）。
    // 安全止血：生产环境「绝不」在登录时自动恢复软删除账号——否则禁用一个被攻破/默认账号
    //   会被任何一次登录探测悄悄撤销（原逻辑对任意用户名、且在校验口令前就恢复，是账号封禁失效缺陷）。
    if (!user && process.env.NODE_ENV !== 'production') {
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

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    )

    const refreshToken = jwt.sign(
      { userId: user.id, type: 'refresh' },
      JWT_SECRET,
      { expiresIn: '7d' }
    )

    const cap = buildCapabilityPayload(db, user.id, user.role)
    success(res, {
      token,
      refreshToken,
      expiresIn: 28800,
      user: {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        role: user.role,
        primaryRole: user.primary_role || user.role,
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

    const decoded = jwt.verify(refreshToken, JWT_SECRET) as { userId: string; type: string }
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

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    )

    success(res, { token, expiresIn: 28800 }, 'Refresh success')
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
    const cap = buildCapabilityPayload(db, userId, u?.role)
    success(res, { primaryRole: u?.primary_role || u?.role || null, ...cap })
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
  try {
    const { roles } = req.body
    if (!Array.isArray(roles)) { error(res, 'roles must be an array', 'INVALID_PARAMETER', 400); return }
    const clean = [...new Set(roles.filter((r) => typeof r === 'string'))]
    if (!clean.includes('admin')) clean.push('admin') // admin 始终可见，防误锁
    const db = getDatabase()
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('cost_visibility_roles', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
      .run(JSON.stringify(clean))
    success(res, { roles: clean }, 'Updated')
  } catch (err: any) {
    error(res, err.message, 'INTERNAL_ERROR', 500)
  }
})

router.post('/logout', (_req, res) => {
  success(res, null, 'Logout success')
})

export default router
