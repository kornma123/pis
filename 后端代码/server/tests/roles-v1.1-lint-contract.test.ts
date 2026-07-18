import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MODULES, parsePermissions } from '../src/middleware/rbac-matrix.js'
import { getEffectivePermissionsForRoles } from '../src/middleware/permissions.js'
import rolesRouter from '../src/routes/roles-v1.1.js'

const { getDatabaseMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
}))

vi.mock('../src/database/DatabaseManager.js', () => ({
  getDatabase: getDatabaseMock,
}))

describe('roles v1.1 lint repair contract', () => {
  beforeEach(() => {
    getDatabaseMock.mockReset()
  })

  it('keeps compatible permission shapes while invalid role literals fail closed', () => {
    expect(parsePermissions({ inventory: 'R', roles: 'W' })).toEqual({ inventory: 'R', roles: 'W' })
    expect(parsePermissions('["inventory"]')).toEqual({ inventory: 'W' })
    expect(parsePermissions(['*'])).toEqual(
      Object.fromEntries(MODULES.map((module) => [module, 'W'])),
    )

    expect(parsePermissions('not-json')).toEqual({})
    expect(parsePermissions('"admin"')).toEqual({})
    expect(parsePermissions(['admin'])).toEqual({})
  })

  it('grants literal admin only for an active, undeleted database role', () => {
    const missingAdminDb = {
      prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })),
    }
    expect(getEffectivePermissionsForRoles(missingAdminDb, ['admin'])).toEqual({})

    const inactiveAdminDb = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ permissions: '["*"]', status: 0, is_deleted: 0 })),
      })),
    }
    expect(getEffectivePermissionsForRoles(inactiveAdminDb, ['admin'])).toEqual({})

    const activeAdminDb = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ permissions: '["*"]', status: 1, is_deleted: 0 })),
      })),
    }
    expect(getEffectivePermissionsForRoles(activeAdminDb, ['admin'])).toEqual(
      Object.fromEntries(MODULES.map((module) => [module, 'W'])),
    )
  })

  it('does not issue a rollback when database acquisition fails before a transaction begins', async () => {
    const exec = vi.fn()
    const database = {
      exec,
      prepare: vi.fn((sql: string) => {
        if (sql.includes('FROM roles WHERE code = ?')) {
          return {
            get: vi.fn(() => ({ permissions: '["*"]', status: 1, is_deleted: 0 })),
          }
        }
        throw new Error(`Unexpected SQL in narrow role test: ${sql}`)
      }),
    }
    getDatabaseMock
      .mockReturnValueOnce(database)
      .mockImplementationOnce(() => {
        throw new Error('database unavailable before role transaction')
      })
      .mockReturnValue(database)

    const app = express()
    app.use(express.json())
    app.use((_req, _res, next) => {
      Object.defineProperty(_req, 'user', {
        configurable: true,
        value: { userId: 'USER-ADMIN', username: 'admin', role: 'admin', roles: ['admin'] },
      })
      next()
    })
    app.use('/roles', rolesRouter)

    const response = await request(app).put('/roles/ROLE-MISSING').send({ name: 'unchanged' })

    expect(response.status).toBe(500)
    expect(exec).not.toHaveBeenCalled()
  })
})
