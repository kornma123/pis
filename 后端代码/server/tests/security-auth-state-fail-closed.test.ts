import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'
import { getDb } from './p0-harness.js'

let app: express.Express
let db: Awaited<ReturnType<typeof getDb>>
let token: string
let resolveRequestRoles: typeof import('../src/middleware/permissions.js').resolveRequestRoles

beforeAll(async () => {
  db = await getDb()
  const auth = await import('../src/middleware/auth.js')
  ;({ resolveRequestRoles } = await import('../src/middleware/permissions.js'))
  token = jwt.sign(
    { userId: 'USER-001', username: 'admin', role: 'admin', type: 'access' },
    auth.JWT_SECRET,
    { expiresIn: '5m' }
  )

  app = express()
  app.get('/probe', auth.authenticateToken, (_req, res) => {
    res.json({ success: true })
  })
})

describe('authentication state lookup fails closed', () => {
  it('rejects a refresh token when it is presented as a Bearer access token', async () => {
    const auth = await import('../src/middleware/auth.js')
    const refreshToken = jwt.sign(
      { userId: 'USER-001', type: 'refresh' },
      auth.JWT_SECRET,
      { expiresIn: '5m' }
    )

    const response = await request(app).get('/probe').set('Authorization', `Bearer ${refreshToken}`)
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('UNAUTHORIZED')
  })

  it('denies a valid signed token when current account state cannot be read', async () => {
    expect((await request(app).get('/probe').set('Authorization', `Bearer ${token}`)).status).toBe(200)

    db.exec('ALTER TABLE users RENAME TO users_unavailable')
    try {
      const response = await request(app).get('/probe').set('Authorization', `Bearer ${token}`)
      expect(response.status).toBe(503)
      expect(response.body.error.code).toBe('AUTH_STATE_UNAVAILABLE')
      expect(JSON.stringify(response.body)).not.toContain('users_unavailable')
    } finally {
      db.exec('ALTER TABLE users_unavailable RENAME TO users')
    }
  })

  it('does not recover an admin role from token claims when role state cannot be read', () => {
    db.exec('ALTER TABLE users RENAME TO users_unavailable')
    try {
      expect(resolveRequestRoles({ userId: 'missing-user', role: 'admin' })).toEqual([])
    } finally {
      db.exec('ALTER TABLE users_unavailable RENAME TO users')
    }
  })
})
