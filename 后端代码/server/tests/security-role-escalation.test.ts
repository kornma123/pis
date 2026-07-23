/**
 * LOC-007 — canonical role codes, delegation ceilings, and trusted audit actor.
 *
 * These tests intentionally exercise the real Express routers and SQLite state. They are the RED
 * contract for the fixed master line; the historical candidate is not imported or replayed.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { getDb } from './p0-harness.js'
import { MODULES } from '../src/middleware/rbac-matrix.js'

let app: express.Express
let db: Awaited<ReturnType<typeof getDb>>
let adminToken: string
let directorToken: string
let permissionsModule: typeof import('../src/middleware/permissions.js')

const password = 'Loc007-Director-Q7n@D4w%J9p!'

async function login(username: string, candidatePassword: string): Promise<string> {
  const request = (await import('supertest')).default
  const response = await request(app).post('/api/v1/auth/login')
    .send({ username, password: candidatePassword })
  if (!response.body?.data?.token) throw new Error(`login failed: ${JSON.stringify(response.body)}`)
  return response.body.data.token
}

function seedRoleUser(
  userId: string,
  username: string,
  roleCode: string,
  rolePermissions: Record<string, 'R' | 'W'>,
): void {
  db.prepare(`
    UPDATE roles
    SET permissions = ?, status = 1, is_deleted = 0
    WHERE code = ?
  `).run(JSON.stringify(rolePermissions), roleCode)
  db.prepare(`
    INSERT OR REPLACE INTO users
      (id, username, password, real_name, role, primary_role, status, is_deleted)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0)
  `).run(
    userId,
    username,
    bcrypt.hashSync(password, 12),
    username,
    roleCode,
    roleCode,
  )
  db.prepare('INSERT OR REPLACE INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
    .run(`UR-${userId}-${roleCode}`, userId, roleCode)
}

function allWritePermissions(): Record<string, 'W'> {
  return Object.fromEntries(
    MODULES.map((module) => [module, 'W']),
  ) as Record<string, 'W'>
}

beforeAll(async () => {
  db = await getDb()
  permissionsModule = await import('../src/middleware/permissions.js')
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const roleRoutes = (await import('../src/routes/roles-v1.1.js')).default
  const userRoutes = (await import('../src/routes/users-v1.1.js')).default
  const { requirePermission } = permissionsModule
  const { auditWrite } = await import('../src/middleware/audit-log.js')
  const { errorHandler } = await import('../src/middleware/errorHandler.js')

  seedRoleUser(
    'USER-LOC007-DIRECTOR',
    'loc007_director',
    'lab_director',
    {
      inventory: 'R',
      users: 'W',
      roles: 'W',
    },
  )

  app = express()
  app.use(express.json())
  app.use(auditWrite)
  app.use('/api/v1/auth', authRoutes)
  app.use(
    '/api/v1/roles',
    authenticateToken,
    requirePermission('roles', 'R'),
    roleRoutes,
  )
  app.use(
    '/api/v1/users',
    authenticateToken,
    requirePermission('users', 'R'),
    userRoutes,
  )
  app.use(errorHandler)

  adminToken = await login('admin', 'admin123')
  directorToken = await login('loc007_director', password)
})

const invalidRoleCodes: Array<[string, unknown]> = [
  ['trim', ' loc007_role'],
  ['case', 'Loc007_role'],
  ['NFKC compatibility', 'loc007_\u212A'],
  ['Unicode confusable', 'loc007_r\u043ele'],
  ['zero width', 'loc007_\u200brole'],
  ['bidi control', 'loc007_\u202erole'],
  ['prototype __proto__', '__proto__'],
  ['prototype constructor', 'constructor'],
  ['unknown object shape', { code: 'loc007_role' }],
]

const canonicalMatrix = (['admin', 'director'] as const).flatMap((actor) => (
  (['POST', 'PUT'] as const).flatMap((operation) => (
    invalidRoleCodes.map(([label, code]) => [actor, operation, label, code] as const)
  ))
))

describe('LOC-007 canonical role-code validator runs before every shortcut and write', () => {
  it.each(canonicalMatrix)(
    '%s %s rejects %s as stable 400 with zero role write',
    async (actor, operation, _label, invalidCode) => {
      const token = actor === 'admin' ? adminToken : directorToken
      const suffix = `${actor}-${operation.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const beforeCount = (db.prepare('SELECT COUNT(*) AS total FROM roles').get() as { total: number }).total
      const request = (await import('supertest')).default

      if (operation === 'POST') {
        const response = await request(app).post('/api/v1/roles')
          .set('Authorization', `Bearer ${token}`)
          .send({
            code: invalidCode,
            name: 'invalid canonical role',
            permissions: allWritePermissions(),
            status: 'active',
          })
        expect(response.status).toBe(400)
        expect(response.body.error.code).toBe('INVALID_PARAMETER')
      } else {
        const id = `ROLE-LOC007-MATRIX-${suffix}`
        const originalCode = `loc007_matrix_${suffix}`
        db.prepare(`
          INSERT INTO roles (id, code, name, description, permissions, status, is_deleted)
          VALUES (?, ?, 'matrix target', '', '{}', 1, 0)
        `).run(id, originalCode)
        const before = db.prepare(
          'SELECT code, permissions, status, is_deleted FROM roles WHERE id = ?',
        ).get(id)
        try {
          const response = await request(app).put(`/api/v1/roles/${id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({
              code: invalidCode,
              permissions: allWritePermissions(),
              status: 'active',
            })
          expect(response.status).toBe(400)
          expect(response.body.error.code).toBe('INVALID_PARAMETER')
          expect(db.prepare(
            'SELECT code, permissions, status, is_deleted FROM roles WHERE id = ?',
          ).get(id)).toEqual(before)
        } finally {
          db.prepare('DELETE FROM roles WHERE id = ?').run(id)
        }
      }

      expect((db.prepare('SELECT COUNT(*) AS total FROM roles').get() as { total: number }).total)
        .toBe(beforeCount)
    },
  )
})

describe('LOC-007 exported full-capability comparison validates runtime actor shape first', () => {
  const emptyCandidate = {
    permissions: {},
    namedRoleCapabilities: new Set<string>(),
    canSeeCost: false,
    literalAdmin: false,
  }

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
    ['permissions array', {
      ...emptyCandidate,
      permissions: [],
    }],
    ['named capability array', {
      ...emptyCandidate,
      namedRoleCapabilities: [],
    }],
    ['missing literalAdmin', {
      permissions: {},
      namedRoleCapabilities: new Set<string>(),
      canSeeCost: false,
    }],
    ['unknown extra key', {
      ...emptyCandidate,
      extra: true,
    }],
  ])('malformed actorCapabilities %s fails closed even for empty candidate', (_label, malformedActor) => {
    expect(permissionsModule.fullCapabilitiesAreSubsetOfActor(emptyCandidate, malformedActor)).toBe(false)
  })

  it.each([
    ['{}', {}, {}],
    ['[]', [], {}],
    ['module array', ['inventory'], { inventory: 'W' }],
    ["['*']", ['*'], allWritePermissions()],
  ])('legal permissions shape %s remains compatible', (_label, raw, candidatePermissions) => {
    const actor = {
      permissions: permissionsModule.parsePermissions(raw),
      namedRoleCapabilities: new Set<string>(),
      canSeeCost: false,
      literalAdmin: false,
    }
    const candidate = {
      ...emptyCandidate,
      permissions: candidatePermissions,
    }
    expect(permissionsModule.fullCapabilitiesAreSubsetOfActor(candidate, actor)).toBe(true)
  })
})

describe('LOC-007 literal admin, delegation, takeover, and system protections', () => {
  it('non-admin cannot create a user with literal admin', async () => {
    const username = `loc007_admin_grant_${Date.now()}`
    const response = await (await import('supertest')).default(app).post('/api/v1/users')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({
        username,
        password,
        realName: 'grant admin',
        roles: ['admin'],
      })
    expect(response.status).toBe(403)
    expect(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)).toBeUndefined()
  })

  it('non-admin cannot reset the admin password or take over the account', async () => {
    const before = db.prepare('SELECT password, status, role, primary_role FROM users WHERE id = ?')
      .get('USER-001') as { password: string; status: number; role: string; primary_role: string }
    try {
      const response = await (await import('supertest')).default(app).put('/api/v1/users/USER-001')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({ password: 'Loc007-Takeover-R8x#M2q!V7n@' })
      expect(response.status).toBe(403)
      expect(db.prepare('SELECT password, status, role, primary_role FROM users WHERE id = ?')
        .get('USER-001')).toEqual(before)
    } finally {
      db.prepare('UPDATE users SET password = ?, status = ?, role = ?, primary_role = ? WHERE id = ?')
        .run(before.password, before.status, before.role, before.primary_role, 'USER-001')
    }
  })

  it('non-admin cannot mutate a system role', async () => {
    const before = db.prepare('SELECT permissions, status, is_deleted FROM roles WHERE id = ?')
      .get('ROLE-DIR')
    const response = await (await import('supertest')).default(app).put('/api/v1/roles/ROLE-DIR')
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ permissions: { inventory: 'W', roles: 'W', users: 'W' } })
    expect(response.status).toBe(403)
    expect(db.prepare('SELECT permissions, status, is_deleted FROM roles WHERE id = ?')
      .get('ROLE-DIR')).toEqual(before)
  })

  it('the last effective admin cannot demote itself', async () => {
    const userBefore = db.prepare('SELECT role, primary_role FROM users WHERE id = ?').get('USER-001') as {
      role: string
      primary_role: string
    }
    const assignmentsBefore = db.prepare(
      'SELECT id, role_code FROM user_roles WHERE user_id = ? ORDER BY id',
    ).all('USER-001') as Array<{ id: string; role_code: string }>
    try {
      const response = await (await import('supertest')).default(app).put('/api/v1/users/USER-001')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ roles: ['finance'], primaryRole: 'finance' })
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('BUSINESS_CONFLICT')
    } finally {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run('USER-001')
      const restore = db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      for (const row of assignmentsBefore) restore.run(row.id, 'USER-001', row.role_code)
      db.prepare('UPDATE users SET role = ?, primary_role = ? WHERE id = ?')
        .run(userBefore.role, userBefore.primary_role, 'USER-001')
    }
  })

  it('requireAnyRole accepts only the production named-role registry', () => {
    expect(() => permissionsModule.requireAnyRole('finance')).not.toThrow()
    expect(() => permissionsModule.requireAnyRole('unregistered_named_gate')).toThrow(
      /Unknown named role capability/,
    )
  })

  it('admin can create an all-write custom role and audit actor is authentication context', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const code = `loc007_admin_all_write_${suffix}`
    const beforeAudit = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS id FROM operation_logs')
      .get() as { id: number }).id
    const response = await (await import('supertest')).default(app).post('/api/v1/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code,
        name: 'admin all-write custom role',
        permissions: allWritePermissions(),
        status: 'active',
      })
    expect(response.status).toBe(201)
    const audit = db.prepare(`
      SELECT username, user_id, request_data, outcome
      FROM operation_logs
      WHERE rowid > ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(beforeAudit) as {
      username: string
      user_id: string
      request_data: string
      outcome: string | null
    }
    expect(audit).toMatchObject({ username: 'admin', user_id: 'USER-001', outcome: null })
    expect(audit.request_data).not.toContain('"actor"')
    expect(audit.request_data).not.toContain('"operator"')
    db.prepare('DELETE FROM roles WHERE code = ?').run(code)
  })
})
