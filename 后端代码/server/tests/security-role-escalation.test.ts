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

type RouteLayer = {
  name?: string
  regexp?: { toString(): string }
  handle?: express.RequestHandler & { stack?: RouteLayer[] }
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: express.RequestHandler }>
  }
}

function productionRouteHandlerLayer(
  mountPattern: string,
  routePath: string,
  method: string,
): { handle: express.RequestHandler } {
  const mountedRouter = (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack
    .find((layer) => layer.name === 'router' && layer.regexp?.toString().includes(mountPattern))
  const routeLayer = mountedRouter?.handle?.stack
    ?.find((layer) => layer.route?.path === routePath && layer.route.methods[method])
  const handlerLayer = routeLayer?.route?.stack.at(-1)
  if (!handlerLayer) throw new Error(`production ${method.toUpperCase()} ${routePath} handler not found`)
  return handlerLayer
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
  it('admin can update non-role fields for a user with zero active roles', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const userId = `USER-LOC007-NO-ACTIVE-ROLE-${suffix}`
    const username = `loc007_no_active_role_${suffix}`
    db.prepare(`
      INSERT INTO users
        (id, username, password, real_name, role, primary_role, status, is_deleted)
      VALUES (?, ?, ?, 'zero active role', ?, ?, 1, 0)
    `).run(
      userId,
      username,
      bcrypt.hashSync(password, 12),
      `loc007_missing_${suffix}`,
      `loc007_missing_${suffix}`,
    )

    try {
      const response = await (await import('supertest')).default(app).put(`/api/v1/users/${userId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ realName: 'zero active role updated' })

      expect(response.status).toBe(200)
      expect(db.prepare('SELECT real_name FROM users WHERE id = ?').get(userId))
        .toEqual({ real_name: 'zero active role updated' })
      expect(db.prepare('SELECT role_code FROM user_roles WHERE user_id = ?').all(userId)).toEqual([])
    } finally {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    }
  })

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

describe('LOC-007 non-admin delegation subsets and affected-user simulation', () => {
  it('non-admin role create allows an actor subset and rejects an actor superset', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const subsetCode = `loc007_create_subset_${suffix}`
    const aboveCode = `loc007_create_above_${suffix}`
    const request = (await import('supertest')).default
    try {
      const subset = await request(app).post('/api/v1/roles')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({
          code: subsetCode,
          name: 'director subset',
          permissions: { inventory: 'R' },
          status: 'active',
        })
      expect(subset.status).toBe(201)
      expect(db.prepare('SELECT status FROM roles WHERE code = ?').get(subsetCode)).toEqual({ status: 1 })

      const above = await request(app).post('/api/v1/roles')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({
          code: aboveCode,
          name: 'director superset',
          permissions: { inventory: 'W' },
          status: 'active',
        })
      expect(above.status).toBe(403)
      expect(db.prepare('SELECT 1 FROM roles WHERE code = ?').get(aboveCode)).toBeUndefined()
    } finally {
      db.prepare('DELETE FROM roles WHERE code IN (?, ?)').run(subsetCode, aboveCode)
    }
  })

  it('non-admin role update allows an actor subset and rejects an actor superset', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const id = `ROLE-LOC007-UPDATE-${suffix}`
    const code = `loc007_update_${suffix}`
    db.prepare(`
      INSERT INTO roles (id, code, name, description, permissions, status, is_deleted)
      VALUES (?, ?, 'director update target', '', '{}', 1, 0)
    `).run(id, code)
    const request = (await import('supertest')).default
    try {
      const subset = await request(app).put(`/api/v1/roles/${id}`)
        .set('Authorization', `Bearer ${directorToken}`)
        .send({ permissions: { inventory: 'R' } })
      expect(subset.status).toBe(200)

      const above = await request(app).put(`/api/v1/roles/${id}`)
        .set('Authorization', `Bearer ${directorToken}`)
        .send({ permissions: { inventory: 'W' } })
      expect(above.status).toBe(403)
      expect(JSON.parse((db.prepare('SELECT permissions FROM roles WHERE id = ?').get(id) as {
        permissions: string
      }).permissions)).toEqual({ inventory: 'R' })
    } finally {
      db.prepare('DELETE FROM roles WHERE id = ?').run(id)
    }
  })

  it('non-admin user create allows a role equal to the actor delegation boundary', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const username = `loc007_director_delegate_${suffix}`
    try {
      const response = await (await import('supertest')).default(app).post('/api/v1/users')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({
          username,
          password,
          realName: 'director delegate',
          roles: ['lab_director'],
          primaryRole: 'lab_director',
        })

      expect(response.status).toBe(201)
      const created = db.prepare('SELECT id, role, primary_role FROM users WHERE username = ?')
        .get(username) as { id: string; role: string; primary_role: string }
      expect(created).toMatchObject({ role: 'lab_director', primary_role: 'lab_director' })
      expect(db.prepare('SELECT role_code FROM user_roles WHERE user_id = ?').all(created.id))
        .toEqual([{ role_code: 'lab_director' }])
    } finally {
      const created = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as
        | { id: string }
        | undefined
      if (created) {
        db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(created.id)
        db.prepare('DELETE FROM users WHERE id = ?').run(created.id)
      }
    }
  })

  it('affected-user simulation blocks a fallback gain beyond the actor', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const assignedId = `ROLE-LOC007-ASSIGNED-${suffix}`
    const assignedCode = `loc007_assigned_${suffix}`
    const fallbackId = `ROLE-LOC007-FALLBACK-${suffix}`
    const fallbackCode = `loc007_fallback_${suffix}`
    const userId = `USER-LOC007-FALLBACK-${suffix}`
    db.prepare(`
      INSERT INTO roles (id, code, name, description, permissions, status, is_deleted)
      VALUES (?, ?, 'assigned role', '', '{}', 1, 0)
    `).run(assignedId, assignedCode)
    db.prepare(`
      INSERT INTO roles (id, code, name, description, permissions, status, is_deleted)
      VALUES (?, ?, 'fallback role', '', '{"inventory":"W"}', 1, 0)
    `).run(fallbackId, fallbackCode)
    db.prepare(`
      INSERT INTO users
        (id, username, password, real_name, role, primary_role, status, is_deleted)
      VALUES (?, ?, ?, 'fallback gain user', ?, ?, 1, 0)
    `).run(userId, `loc007_fallback_gain_${suffix}`, bcrypt.hashSync(password, 12), fallbackCode, assignedCode)
    db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run(`UR-${userId}-${assignedCode}`, userId, assignedCode)

    try {
      const response = await (await import('supertest')).default(app).put(`/api/v1/roles/${assignedId}`)
        .set('Authorization', `Bearer ${directorToken}`)
        .send({ status: 'inactive' })

      expect(response.status).toBe(403)
      expect(db.prepare('SELECT status FROM roles WHERE id = ?').get(assignedId)).toEqual({ status: 1 })
    } finally {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM users WHERE id = ?').run(userId)
      db.prepare('DELETE FROM roles WHERE id IN (?, ?)').run(assignedId, fallbackId)
    }
  })

  it('affected-user simulation allows a pure fallback downgrade', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const assignedId = `ROLE-LOC007-DOWNGRADE-${suffix}`
    const assignedCode = `loc007_downgrade_${suffix}`
    const fallbackId = `ROLE-LOC007-WEAK-${suffix}`
    const fallbackCode = `loc007_weak_${suffix}`
    const userId = `USER-LOC007-DOWNGRADE-${suffix}`
    db.prepare(`
      INSERT INTO roles (id, code, name, description, permissions, status, is_deleted)
      VALUES (?, ?, 'assigned role', '', '{"inventory":"R"}', 1, 0)
    `).run(assignedId, assignedCode)
    db.prepare(`
      INSERT INTO roles (id, code, name, description, permissions, status, is_deleted)
      VALUES (?, ?, 'weak fallback role', '', '{}', 1, 0)
    `).run(fallbackId, fallbackCode)
    db.prepare(`
      INSERT INTO users
        (id, username, password, real_name, role, primary_role, status, is_deleted)
      VALUES (?, ?, ?, 'fallback downgrade user', ?, ?, 1, 0)
    `).run(userId, `loc007_fallback_down_${suffix}`, bcrypt.hashSync(password, 12), fallbackCode, assignedCode)
    db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run(`UR-${userId}-${assignedCode}`, userId, assignedCode)

    try {
      const response = await (await import('supertest')).default(app).put(`/api/v1/roles/${assignedId}`)
        .set('Authorization', `Bearer ${directorToken}`)
        .send({ status: 'inactive' })

      expect(response.status).toBe(200)
      expect(db.prepare('SELECT status FROM roles WHERE id = ?').get(assignedId)).toEqual({ status: 0 })
    } finally {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM users WHERE id = ?').run(userId)
      db.prepare('DELETE FROM roles WHERE id IN (?, ?)').run(assignedId, fallbackId)
    }
  })
})

describe('LOC-007 route writes re-read actor authorization inside their transaction', () => {
  it('role create denies an actor disabled after route guards and writes zero roles', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const code = `loc007_race_role_${suffix}`
    const actorBefore = db.prepare('SELECT status FROM users WHERE id = ?')
      .get('USER-LOC007-DIRECTOR') as { status: number }
    const handlerLayer = productionRouteHandlerLayer('api\\/v1\\/roles', '/', 'post')
    const originalHandler = handlerLayer.handle
    let mutationHits = 0
    handlerLayer.handle = ((req, res, next) => {
      mutationHits += 1
      db.prepare('UPDATE users SET status = 0 WHERE id = ?').run('USER-LOC007-DIRECTOR')
      return originalHandler(req, res, next)
    }) as express.RequestHandler

    try {
      const response = await (await import('supertest')).default(app).post('/api/v1/roles')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({
          code,
          name: 'route race role',
          permissions: { inventory: 'R' },
          status: 'active',
        })

      expect(response.status).toBe(403)
      expect(mutationHits).toBe(1)
      expect(db.prepare('SELECT 1 FROM roles WHERE code = ?').get(code)).toBeUndefined()
    } finally {
      handlerLayer.handle = originalHandler
      db.prepare('UPDATE users SET status = ? WHERE id = ?')
        .run(actorBefore.status, 'USER-LOC007-DIRECTOR')
      db.prepare('DELETE FROM roles WHERE code = ?').run(code)
    }
  })

  it('user create denies an actor revoked after route guards and writes zero users', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const username = `loc007_race_user_${suffix}`
    const roleBefore = db.prepare('SELECT permissions FROM roles WHERE code = ?')
      .get('lab_director') as { permissions: string }
    const handlerLayer = productionRouteHandlerLayer('api\\/v1\\/users', '/', 'post')
    const originalHandler = handlerLayer.handle
    let mutationHits = 0
    handlerLayer.handle = ((req, res, next) => {
      mutationHits += 1
      db.prepare('UPDATE roles SET permissions = ? WHERE code = ?')
        .run(JSON.stringify({ inventory: 'R', roles: 'W' }), 'lab_director')
      return originalHandler(req, res, next)
    }) as express.RequestHandler

    try {
      const response = await (await import('supertest')).default(app).post('/api/v1/users')
        .set('Authorization', `Bearer ${directorToken}`)
        .send({
          username,
          password,
          realName: 'route race user',
          roles: ['lab_director'],
        })

      expect(response.status).toBe(403)
      expect(mutationHits).toBe(1)
      expect(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)).toBeUndefined()
    } finally {
      handlerLayer.handle = originalHandler
      db.prepare('UPDATE roles SET permissions = ? WHERE code = ?')
        .run(roleBefore.permissions, 'lab_director')
      const created = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as
        | { id: string }
        | undefined
      if (created) {
        db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(created.id)
        db.prepare('DELETE FROM users WHERE id = ?').run(created.id)
      }
    }
  })
})

describe('LOC-007 last effective admin DELETE protection', () => {
  it('rejects deleting the only active effective admin through the DELETE route', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const userId = `USER-LOC007-LAST-ADMIN-${suffix}`
    const username = `loc007_last_admin_${suffix}`
    const rootBefore = db.prepare('SELECT status FROM users WHERE id = ?').get('USER-001') as {
      status: number
    }
    db.prepare(`
      INSERT INTO users
        (id, username, password, real_name, role, primary_role, status, is_deleted)
      VALUES (?, ?, ?, 'last admin delete target', 'admin', 'admin', 1, 0)
    `).run(userId, username, bcrypt.hashSync(password, 12))
    db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run(`UR-${userId}-admin`, userId, 'admin')
    const token = await login(username, password)
    db.prepare('UPDATE users SET status = 0 WHERE id = ?').run('USER-001')

    try {
      const response = await (await import('supertest')).default(app).delete(`/api/v1/users/${userId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('BUSINESS_CONFLICT')
      expect(db.prepare('SELECT is_deleted FROM users WHERE id = ?').get(userId))
        .toEqual({ is_deleted: 0 })
    } finally {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(rootBefore.status, 'USER-001')
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
      db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    }
  })
})
