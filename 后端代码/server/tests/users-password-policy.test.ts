import { beforeAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any
let adminToken: string

const STRONG_CREATE_PASSWORD = 'Http-N7v!Q2m@R8x#T4k%'
const STRONG_UPDATE_PASSWORD = 'Update-Z9p&L3d^B6y*C1w('
const TOO_LONG_PASSWORD = 'N7v!Q2m@R8x#T4k%Z9p&L3d^B6y*C1w(H5s)J0f-U8e_G2a+' + '🚀'.repeat(7)

beforeAll(async () => {
  db = await getDb()
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const userRoutes = (await import('../src/routes/users-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/users', router: userRoutes, middleware: [authenticateToken, requirePermission('users', 'R')] },
  ])
  adminToken = await loginAdmin(app)
})

describe('users-v1.1 password policy', () => {
  it('POST rejects weak, over-72-byte and non-string passwords with INVALID_PARAMETER', async () => {
    const request = (await import('supertest')).default
    const invalidPasswords: unknown[] = ['password1234', TOO_LONG_PASSWORD, 123456789012]

    for (const [index, password] of invalidPasswords.entries()) {
      const username = `policy-post-${index}`
      const response = await request(app)
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ username, password, realName: `策略用户${index}`, role: 'technician' })

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('INVALID_PARAMETER')
      expect(JSON.stringify(response.body)).not.toContain(String(password))
      expect(db.prepare('SELECT id FROM users WHERE username = ?').get(username)).toBeFalsy()
    }
  })

  it('PUT rejects every supplied invalid password without changing the stored hash', async () => {
    const request = (await import('supertest')).default
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'policy-put', password: STRONG_CREATE_PASSWORD, realName: '策略更新用户', role: 'technician' })
    expect(created.status).toBe(201)
    const userId = created.body.data.id as string
    const before = db.prepare('SELECT password FROM users WHERE id = ?').get(userId) as { password: string }

    for (const password of ['ab'.repeat(8), '', TOO_LONG_PASSWORD, 123456789012]) {
      const response = await request(app)
        .put(`/api/v1/users/${userId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ password })

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('INVALID_PARAMETER')
      const after = db.prepare('SELECT password FROM users WHERE id = ?').get(userId) as { password: string }
      expect(after.password).toBe(before.password)
    }
  })

  it('POST and PUT accept distinct strong passwords and store their bcrypt hashes', async () => {
    const request = (await import('supertest')).default
    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'policy-strong', password: STRONG_CREATE_PASSWORD, realName: '强口令用户', role: 'technician' })

    expect(created.status).toBe(201)
    const userId = created.body.data.id as string
    const createdRow = db.prepare('SELECT password FROM users WHERE id = ?').get(userId) as { password: string }
    expect(bcrypt.compareSync(STRONG_CREATE_PASSWORD, createdRow.password)).toBe(true)

    const updated = await request(app)
      .put(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: STRONG_UPDATE_PASSWORD })
    expect(updated.status).toBe(200)
    const updatedRow = db.prepare('SELECT password FROM users WHERE id = ?').get(userId) as { password: string }
    expect(bcrypt.compareSync(STRONG_UPDATE_PASSWORD, updatedRow.password)).toBe(true)
    expect(bcrypt.compareSync(STRONG_CREATE_PASSWORD, updatedRow.password)).toBe(false)
  })

  it('requires an atomic strong-password replacement when reactivating an account with a leaked default hash', async () => {
    const request = (await import('supertest')).default
    db.prepare("UPDATE users SET status = 0 WHERE username = 'caiwu'").run()
    const financeUser = db.prepare("SELECT id, password FROM users WHERE username = 'caiwu'").get() as {
      id: string
      password: string
    }

    const rejected = await request(app)
      .put(`/api/v1/users/${financeUser.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'active' })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.code).toBe('INVALID_PARAMETER')
    expect((db.prepare('SELECT status FROM users WHERE id = ?').get(financeUser.id) as { status: number }).status).toBe(0)

    const reactivated = await request(app)
      .put(`/api/v1/users/${financeUser.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'active', password: STRONG_UPDATE_PASSWORD })
    expect(reactivated.status).toBe(200)
    const updated = db.prepare('SELECT status, password FROM users WHERE id = ?').get(financeUser.id) as {
      status: number
      password: string
    }
    expect(updated.status).toBe(1)
    expect(bcrypt.compareSync(STRONG_UPDATE_PASSWORD, updated.password)).toBe(true)
    expect(bcrypt.compareSync('CoreOne2026!', updated.password)).toBe(false)
  })
})
