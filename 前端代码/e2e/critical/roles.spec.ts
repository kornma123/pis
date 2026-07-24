import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiLogin } from './fixtures'

interface RoleRecord {
  id: string
  code: string
  name: string
  description: string
  permissions: Record<string, 'R' | 'W'>
  status: number
  is_deleted: number
}

interface RoleListEnvelope {
  success: boolean
  data: {
    list: RoleRecord[]
    total: number
  }
}

interface ErrorEnvelope {
  success: boolean
  error: {
    code: string
  }
}

function apiBaseUrl(): string {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

function uniqueRoleCode(label: string): string {
  return `e2e_roles_${label}_${randomUUID().replaceAll('-', '')}`
}

async function listRoles(
  request: APIRequestContext,
  token: string,
): Promise<RoleListEnvelope['data']> {
  const response = await request.get(`${apiBaseUrl()}/roles?page=1&pageSize=1000`, {
    headers: authorization(token),
  })
  expect(response.status(), 'admin role-list request must succeed').toBe(200)
  const body = await response.json() as RoleListEnvelope
  expect(body.success).toBe(true)
  expect(Array.isArray(body.data?.list)).toBe(true)
  expect(body.data?.total).toEqual(expect.any(Number))
  return body.data
}

async function createRole(
  request: APIRequestContext,
  token: string,
  role: {
    code: string
    name: string
    description: string
  },
): Promise<string> {
  const response = await request.post(`${apiBaseUrl()}/roles`, {
    headers: authorization(token),
    data: {
      ...role,
      permissions: { inventory: 'R' },
      status: 'active',
    },
  })
  expect(response.status(), 'canonical role creation must return Created').toBe(201)
  const body = await response.json() as {
    success: boolean
    data: { id: string }
  }
  expect(body).toMatchObject({
    success: true,
    data: { id: expect.any(String) },
  })
  return body.data.id
}

async function cleanupRole(
  request: APIRequestContext,
  adminToken: string,
  roleId: string,
  roleCode: string,
): Promise<void> {
  const response = await request.delete(`${apiBaseUrl()}/roles/${roleId}`, {
    headers: authorization(adminToken),
  })
  expect(response.status(), `cleanup must delete ${roleCode}`).toBe(200)
  const after = await listRoles(request, adminToken)
  expect(after.list.find((role) => role.code === roleCode)).toBeUndefined()
}

test.describe('critical roles API contract', () => {
  test('admin creates and persists a canonical custom role', async ({ request }) => {
    const adminToken = await apiLogin(request, 'admin')
    const code = uniqueRoleCode('create')
    const name = `E2E canonical role ${code}`
    const description = 'critical roles persistence proof'
    let roleId: string | undefined

    try {
      const before = await listRoles(request, adminToken)
      expect(before.list.find((role) => role.code === code)).toBeUndefined()

      roleId = await createRole(request, adminToken, { code, name, description })

      const persisted = (await listRoles(request, adminToken)).list
        .find((role) => role.code === code)
      expect(persisted).toMatchObject({
        id: roleId,
        code,
        name,
        description,
        permissions: { inventory: 'R' },
        status: 1,
        is_deleted: 0,
      })
    } finally {
      if (roleId) await cleanupRole(request, adminToken, roleId, code)
    }
  })

  test('admin receives stable 400 responses for non-canonical role codes with zero role writes', async ({ request }) => {
    const adminToken = await apiLogin(request, 'admin')
    const canonical = uniqueRoleCode('invalid')
    const invalidCodes = [
      ` ${canonical} `,
      canonical.toUpperCase(),
      `${canonical}\u200B`,
      'constructor',
    ]
    const before = await listRoles(request, adminToken)

    for (const [index, code] of invalidCodes.entries()) {
      const response = await request.post(`${apiBaseUrl()}/roles`, {
        headers: authorization(adminToken),
        data: {
          code,
          name: `E2E rejected role ${index}`,
          description: 'must not persist',
          permissions: { inventory: 'R' },
          status: 'active',
        },
      })
      expect(response.status(), `non-canonical role code ${index} must be rejected`).toBe(400)
      const body = await response.json() as ErrorEnvelope
      expect(body).toMatchObject({
        success: false,
        error: { code: 'INVALID_PARAMETER' },
      })
    }

    const after = await listRoles(request, adminToken)
    expect(after.total).toBe(before.total)
    for (const code of invalidCodes) {
      expect(after.list.find((role) => role.code === code)).toBeUndefined()
    }
  })

  test('technician POST, PUT, and DELETE remain 403 with zero role writes', async ({ request }) => {
    const adminToken = await apiLogin(request, 'admin')
    const technicianToken = await apiLogin(request, 'technician')
    const targetCode = uniqueRoleCode('target')
    const deniedCreateCode = uniqueRoleCode('denied')
    const originalName = `E2E protected role ${targetCode}`
    let targetId: string | undefined

    try {
      targetId = await createRole(request, adminToken, {
        code: targetCode,
        name: originalName,
        description: 'unauthorized mutation target',
      })
      const before = await listRoles(request, adminToken)

      const deniedPost = await request.post(`${apiBaseUrl()}/roles`, {
        headers: authorization(technicianToken),
        data: {
          code: deniedCreateCode,
          name: 'E2E denied create',
          permissions: { inventory: 'R' },
          status: 'active',
        },
      })
      expect(deniedPost.status()).toBe(403)
      expect(await deniedPost.json() as ErrorEnvelope).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      })

      const deniedPut = await request.put(`${apiBaseUrl()}/roles/${targetId}`, {
        headers: authorization(technicianToken),
        data: { name: 'E2E unauthorized rename' },
      })
      expect(deniedPut.status()).toBe(403)
      expect(await deniedPut.json() as ErrorEnvelope).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      })

      const deniedDelete = await request.delete(`${apiBaseUrl()}/roles/${targetId}`, {
        headers: authorization(technicianToken),
      })
      expect(deniedDelete.status()).toBe(403)
      expect(await deniedDelete.json() as ErrorEnvelope).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      })

      const after = await listRoles(request, adminToken)
      expect(after.total).toBe(before.total)
      expect(after.list.find((role) => role.code === deniedCreateCode)).toBeUndefined()
      expect(after.list.find((role) => role.id === targetId)).toMatchObject({
        code: targetCode,
        name: originalName,
        is_deleted: 0,
      })
    } finally {
      if (targetId) await cleanupRole(request, adminToken, targetId, targetCode)
    }
  })
})
