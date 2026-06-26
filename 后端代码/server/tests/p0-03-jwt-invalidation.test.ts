/**
 * P0-03 JWT 即时失效
 *
 * Bug: authenticateToken 仅 jwt.verify，不回查 users → 停用/改角色/改密后
 *      token 在 8h 内仍有效。
 *
 * 红测试（修复前失败）：真实登录拿 token → 直接改库停用该用户 / 改其 role →
 *   同 token 再请求受保护接口应 401（修复前 200）。正常用户不受影响。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let db: any

// 为每个子场景创建独立用户，避免互相干扰
async function seedUser(id: string, username: string, role: string) {
  const pw = bcrypt.hashSync('pw123456', 10)
  db.prepare(`INSERT INTO users (id, username, password, real_name, role, status, is_deleted)
    VALUES (?, ?, ?, ?, ?, 1, 0)`).run(id, username, pw, username, role)
}

async function loginAs(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!res.body?.data?.token) throw new Error('login failed: ' + JSON.stringify(res.body))
  return res.body.data.token
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const materialRoutes = (await import('../src/routes/materials.js')).default
  const { authenticateToken, requireRole } = await import('../src/middleware/auth.js')

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/materials',
      router: materialRoutes,
      middleware: [
        authenticateToken,
        requireRole('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement'),
      ],
    },
  ])

  await seedUser('U-DISABLE', 'p03disable', 'warehouse_manager')
  await seedUser('U-DELETE', 'p03delete', 'warehouse_manager')
  await seedUser('U-ROLE', 'p03role', 'warehouse_manager')
})

describe('P0-03 JWT 即时失效', () => {
  it('停用用户后，旧 token 访问受保护接口应 401', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('p03disable', 'pw123456')
    // baseline: 有效
    const ok = await request(app).get('/api/v1/materials?page=1').set('Authorization', `Bearer ${token}`)
    expect(ok.status).toBe(200)
    // 停用
    db.prepare('UPDATE users SET status = 0 WHERE id = ?').run('U-DISABLE')
    const res = await request(app).get('/api/v1/materials?page=1').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED')
  })

  it('软删除用户后，旧 token 访问受保护接口应 401', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('p03delete', 'pw123456')
    const ok = await request(app).get('/api/v1/materials?page=1').set('Authorization', `Bearer ${token}`)
    expect(ok.status).toBe(200)
    db.prepare('UPDATE users SET is_deleted = 1 WHERE id = ?').run('U-DELETE')
    const res = await request(app).get('/api/v1/materials?page=1').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED')
  })

  it('改角色后，旧 token(role不符) 访问应 401 ROLE_CHANGED', async () => {
    const request = (await import('supertest')).default
    const token = await loginAs('p03role', 'pw123456')
    const ok = await request(app).get('/api/v1/materials?page=1').set('Authorization', `Bearer ${token}`)
    expect(ok.status).toBe(200)
    // 改成 finance（DB 内 role 与 token 内 role 不一致）
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('finance', 'U-ROLE')
    const res = await request(app).get('/api/v1/materials?page=1').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('ROLE_CHANGED')
  })

  it('正常 admin 用户不受影响', async () => {
    const request = (await import('supertest')).default
    const token = await loginAdmin(app)
    const res = await request(app).get('/api/v1/materials?page=1').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})
