import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiLogin, loginThroughUi } from './fixtures'

const RETIRED_PERMISSION_LABELS = [
  'ABC 成本看板',
  '单片成本',
  '盈利分析',
  'ABC 配置',
  '设备管理',
  '标准工时',
] as const

const LEGACY_COST_PERMISSIONS = {
  abc_dashboard: 'W',
  slide_cost: 'W',
  profitability: 'W',
  abc_config: 'W',
  equipment: 'W',
  labor_times: 'W',
  antibody_cost: 'W',
} as const

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
    permissions?: Record<string, 'R' | 'W'>
  },
): Promise<string> {
  const response = await request.post(`${apiBaseUrl()}/roles`, {
    headers: authorization(token),
    data: {
      ...role,
      permissions: role.permissions ?? { inventory: 'R' },
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

async function cleanupRolesByCode(
  request: APIRequestContext,
  adminToken: string,
  roleCodes: ReadonlySet<string>,
): Promise<void> {
  const trackedCodes = [...roleCodes]
  const activeRoles = await listRoles(request, adminToken)
  for (const role of activeRoles.list.filter(({ code }) => roleCodes.has(code))) {
    const response = await request.delete(`${apiBaseUrl()}/roles/${role.id}`, {
      headers: authorization(adminToken),
    })
    expect(response.status(), `cleanup must delete ${role.code}`).toBe(200)
  }

  const after = await listRoles(request, adminToken)
  for (const code of trackedCodes) {
    expect(
      after.list.find((role) => role.code === code),
      `cleanup must leave no active role with code ${JSON.stringify(code)}`,
    ).toBeUndefined()
  }
}

test.describe('critical roles API contract', () => {
  test('admin creates and persists a canonical custom role', async ({ request }) => {
    const code = uniqueRoleCode('create')
    const cleanupCodes = new Set([code])
    const name = `E2E canonical role ${code}`
    const description = 'critical roles persistence proof'
    let adminToken: string | undefined

    try {
      adminToken = await apiLogin(request, 'admin')
      const before = await listRoles(request, adminToken)
      expect(before.list.find((role) => role.code === code)).toBeUndefined()

      const roleId = await createRole(request, adminToken, { code, name, description })

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
      if (adminToken) await cleanupRolesByCode(request, adminToken, cleanupCodes)
    }
  })

  test('admin UI keeps retired permissions out of grid, detail, edit, and create while antibody cost remains assignable', async ({ page, request }) => {
    const code = uniqueRoleCode('retired_ui')
    const cleanupCodes = new Set([code])
    const name = `E2E legacy cost role ${code}`
    const renamed = `${name} edited`
    let adminToken: string | undefined

    try {
      adminToken = await apiLogin(request, 'admin')
      const roleId = await createRole(request, adminToken, {
        code,
        name,
        description: 'legacy permissions must not become current UI assignments',
        permissions: LEGACY_COST_PERMISSIONS,
      })

      await loginThroughUi(page, 'admin')
      await page.goto('/roles')
      await expect(page.getByRole('heading', { name: '角色管理', exact: true })).toBeVisible()

      const roleName = page.getByText(name, { exact: true })
      await expect(roleName).toBeVisible()
      const roleCard = roleName.locator('..').locator('..').locator('..')
      await expect(roleCard.getByText('逐抗体成本', { exact: true })).toBeVisible()
      for (const label of RETIRED_PERMISSION_LABELS) {
        await expect(roleCard.getByText(label, { exact: true })).toHaveCount(0)
      }

      await roleCard.getByRole('button', { name: '查看详情', exact: true }).click()
      const detailHeading = page.getByRole('heading', { name: '角色详情', exact: true })
      await expect(detailHeading).toBeVisible()
      const detailModal = detailHeading.locator('..').locator('..')
      await expect(detailModal.getByText('逐抗体成本', { exact: true })).toBeVisible()
      for (const label of RETIRED_PERMISSION_LABELS) {
        await expect(detailModal.getByText(label, { exact: true })).toHaveCount(0)
      }
      await page.getByRole('button', { name: '关闭', exact: true }).click()

      await roleCard.getByRole('button', { name: '编辑', exact: true }).click()
      const editHeading = page.getByRole('heading', { name: '编辑角色', exact: true })
      await expect(editHeading).toBeVisible()
      const editModal = editHeading.locator('..').locator('..')
      const editAntibodyRow = editModal.getByRole('row').filter({ hasText: '逐抗体成本' })
      await expect(editAntibodyRow).toBeVisible()
      await expect(editAntibodyRow.getByRole('button', { name: '读写', exact: true })).toHaveClass(/bg-blue-500/)
      for (const label of RETIRED_PERMISSION_LABELS) {
        await expect(editModal.getByText(label, { exact: true })).toHaveCount(0)
      }

      await editModal.getByPlaceholder('请输入角色名称').fill(renamed)
      const updateResponse = page.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/roles/${roleId}`)
        && response.request().method() === 'PUT',
      )
      await editModal.getByRole('button', { name: '保存', exact: true }).click()
      expect((await updateResponse).status(), 'role edit must persist through the real UI/API chain').toBe(200)
      await expect(page.getByText(renamed, { exact: true })).toBeVisible()

      await page.getByRole('button', { name: '新建角色', exact: true }).click()
      const createHeading = page.getByRole('heading', { name: '新建角色', exact: true })
      await expect(createHeading).toBeVisible()
      const createModal = createHeading.locator('..').locator('..')
      const createAntibodyRow = createModal.getByRole('row').filter({ hasText: '逐抗体成本' })
      const createAntibodyWrite = createAntibodyRow.getByRole('button', { name: '读写', exact: true })
      await expect(createAntibodyRow).toBeVisible()
      for (const label of RETIRED_PERMISSION_LABELS) {
        await expect(createModal.getByText(label, { exact: true })).toHaveCount(0)
      }
      await createAntibodyWrite.click()
      await expect(createAntibodyWrite).toHaveClass(/bg-blue-500/)
      await createModal.getByRole('button', { name: '取消', exact: true }).click()
    } finally {
      if (adminToken) await cleanupRolesByCode(request, adminToken, cleanupCodes)
    }
  })

  test('admin receives stable 400 responses for non-canonical role codes with zero role writes', async ({ request }) => {
    const canonical = uniqueRoleCode('invalid')
    const invalidCodes = [
      ` ${canonical} `,
      canonical.toUpperCase(),
      `${canonical}\u200B`,
      'constructor',
    ]
    const cleanupCodes = new Set(invalidCodes)
    let adminToken: string | undefined

    try {
      adminToken = await apiLogin(request, 'admin')
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
    } finally {
      if (adminToken) await cleanupRolesByCode(request, adminToken, cleanupCodes)
    }
  })

  test('technician GET, POST, PUT, and DELETE remain 403 with zero role writes', async ({ request }) => {
    const targetCode = uniqueRoleCode('target')
    const deniedCreateCode = uniqueRoleCode('denied')
    const cleanupCodes = new Set([targetCode, deniedCreateCode])
    const originalName = `E2E protected role ${targetCode}`
    let adminToken: string | undefined

    try {
      adminToken = await apiLogin(request, 'admin')
      const technicianToken = await apiLogin(request, 'technician')
      const targetId = await createRole(request, adminToken, {
        code: targetCode,
        name: originalName,
        description: 'unauthorized mutation target',
      })
      const before = await listRoles(request, adminToken)

      const deniedGet = await request.get(`${apiBaseUrl()}/roles?page=1&pageSize=1000`, {
        headers: authorization(technicianToken),
      })
      expect(deniedGet.status()).toBe(403)
      expect(await deniedGet.json() as ErrorEnvelope).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      })

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
      if (adminToken) await cleanupRolesByCode(request, adminToken, cleanupCodes)
    }
  })

  test('technician direct navigation to roles redirects home without rendering role management', async ({ page }) => {
    await loginThroughUi(page, 'technician')
    await page.goto('/roles')

    await expect(page).toHaveURL((url) => url.pathname === '/')
    await expect(page.getByRole('heading', { name: '角色管理', exact: true })).toHaveCount(0)
  })
})
