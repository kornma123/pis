import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET || 'coreone-secret-key-2024'
const JWT_EXPIRES = '8h'

router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      error(res, 'Username and password required', 'INVALID_PARAMETER', 400)
      return
    }

    const db = getDatabase()
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND status = 1 AND is_deleted = 0').get(username) as any

    if (!user) {
      error(res, 'User not found or disabled', 'UNAUTHORIZED', 401)
      return
    }

    const validPassword = bcrypt.compareSync(password, user.password)
    if (!validPassword) {
      error(res, 'Invalid password', 'UNAUTHORIZED', 401)
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

    success(res, {
      token,
      refreshToken,
      expiresIn: 28800,
      user: {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        role: user.role,
        permissions: ['inventory:view', 'inventory:edit', 'report:view', 'system:view'],
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
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId) as any

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

router.post('/logout', (_req, res) => {
  success(res, null, 'Logout success')
})

export default router
