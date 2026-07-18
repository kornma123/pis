import { randomUUID } from 'node:crypto'
import { test, expect, type Page, type Response } from '@playwright/test'

const FE_BASE = `http://127.0.0.1:${process.env.E2E_FRONTEND_PORT || '8080'}`
const API_BASE = `http://127.0.0.1:${process.env.E2E_BACKEND_PORT || '3001'}/api/v1`

const ROLES = {
  admin: { username: 'admin', password: 'admin123' },
  warehouse_manager: { username: 'cangguan', password: 'CoreOne2026!' },
  technician: { username: 'jishuyuan1', password: 'CoreOne2026!' },
  pathologist: { username: 'yishi1', password: 'CoreOne2026!' },
  procurement: { username: 'caigou', password: 'CoreOne2026!' },
  finance: { username: 'caiwu', password: 'CoreOne2026!' },
} as const

type RoleKey = keyof typeof ROLES
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface ApiResult {
  status: number
  data: any
}

interface LoginData {
  token: string
  user: {
    username: string
    role: string
    roles: string[]
    capabilities: Record<string, 'R' | 'W'>
  }
}

interface CreatedUser {
  id: string
  username: string
  password: string
  role: string
}

interface CreatedRole {
  id: string
  code: string
  name: string
}

const NON_ADMIN_ROLES: RoleKey[] = [
  'warehouse_manager',
  'technician',
  'pathologist',
  'procurement',
  'finance',
]
const STRONG_TEST_PASSWORD = 'Users-E2E-Strong-2026!'
const ROTATED_TEST_PASSWORD = 'Users-E2E-Rotated-2026!'

let adminToken = ''
let adminSession: LoginData
let createdUserIds = new Set<string>()
let createdRoleIds = new Set<string>()

function uniqueSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

function responseData(result: ApiResult): any {
  return result.data?.data ?? result.data
}

function listFromPayload(payload: any, label: string): any[] {
  const data = payload?.data ?? payload
  expect(Array.isArray(data?.list), `${label} must contain data.list`).toBe(true)
  if (!Array.isArray(data?.list)) throw new Error(`${label} did not contain a list`)
  return data.list
}

function requiredString(value: unknown, label: string): string {
  expect(value, label).toEqual(expect.any(String))
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`)
  return value
}

function requiredItem<T>(items: T[], predicate: (item: T) => boolean, label: string): T {
  const item = items.find(predicate)
  expect(item, label).toBeDefined()
  if (item === undefined) throw new Error(`${label} is missing`)
  return item
}

async function apiFetch(
  token: string | undefined,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const options: RequestInit = { method, headers }
  if (body !== undefined && method !== 'GET') options.body = JSON.stringify(body)

  const response = await fetch(`${API_BASE}${path}`, options)
  expect(response.headers.get('content-type') || '', `${method} ${path} must return JSON`).toContain('application/json')
  return { status: response.status, data: await response.json() }
}

async function apiLoginCredentials(username: string, password: string): Promise<LoginData> {
  const result = await apiFetch(undefined, 'POST', '/auth/login', { username, password })
  expect(result.status, `login initialization failed for ${username}`).toBe(200)
  const data = responseData(result)
  const token = requiredString(data?.token, `login token for ${username}`)
  expect(data?.user, `login user for ${username}`).toEqual(expect.objectContaining({
    username,
    role: expect.any(String),
    roles: expect.any(Array),
    capabilities: expect.any(Object),
  }))
  return { token, user: data.user }
}

async function apiLogin(role: RoleKey): Promise<LoginData> {
  const credentials = ROLES[role]
  return apiLoginCredentials(credentials.username, credentials.password)
}

async function apiLoginStatus(username: string, password: string): Promise<number> {
  const result = await apiFetch(undefined, 'POST', '/auth/login', { username, password })
  return result.status
}

async function createRole(
  permissions: Record<string, unknown>,
  options: { code?: string; name?: string } = {},
): Promise<CreatedRole> {
  const code = options.code || `e2e_role_${uniqueSuffix()}`
  const name = options.name || `E2E 角色 ${uniqueSuffix()}`
  const result = await apiFetch(adminToken, 'POST', '/roles', {
    code,
    name,
    description: 'users.spec.ts isolated role',
    permissions,
    status: 'active',
  })
  expect(result.status, `create role ${code}`).toBe(201)
  const id = requiredString(responseData(result)?.id, `created role id for ${code}`)
  createdRoleIds.add(id)
  return { id, code, name }
}

async function createUser(options: {
  username?: string
  password?: string
  realName?: string
  role?: string
  roles?: string[]
  primaryRole?: string
} = {}): Promise<CreatedUser> {
  const username = options.username || `testuser-${uniqueSuffix()}`
  const password = options.password || STRONG_TEST_PASSWORD
  const role = options.role || 'technician'
  const roles = options.roles || [role]
  const primaryRole = options.primaryRole || role
  const result = await apiFetch(adminToken, 'POST', '/users', {
    username,
    password,
    realName: options.realName || `E2E 用户 ${uniqueSuffix()}`,
    role,
    roles,
    primaryRole,
    status: 'active',
  })
  expect(result.status, `create user ${username}`).toBe(201)
  const data = responseData(result)
  const id = requiredString(data?.id, `created user id for ${username}`)
  expect(data?.roles, `created roles for ${username}`).toEqual(roles)
  expect(data?.primaryRole, `created primary role for ${username}`).toBe(primaryRole)
  createdUserIds.add(id)
  return { id, username, password, role: primaryRole }
}

function matchesApiResponse(response: Response, method: HttpMethod, path: string): boolean {
  const url = new URL(response.url())
  return response.request().method() === method && url.pathname === `/api/v1${path}`
}

function userRow(page: Page, username: string) {
  return page.getByText(username, { exact: true }).locator('xpath=ancestor::tr')
}

function roleCard(page: Page, roleName: string) {
  return page
    .getByText(roleName, { exact: true })
    .locator('xpath=ancestor::div[.//button[normalize-space()="查看详情"]][1]')
}

async function loginWithCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${FE_BASE}/login`)
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
  await page.getByPlaceholder('请输入用户名').fill(username)
  await page.getByPlaceholder('请输入密码').fill(password)

  const loginResponsePromise = page.waitForResponse(response => matchesApiResponse(response, 'POST', '/auth/login'))
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const loginResponse = await loginResponsePromise
  expect(loginResponse.status(), `browser login for ${username}`).toBe(200)
  await expect(page).toHaveURL(`${FE_BASE}/`)
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('token')))).toBe(true)
}

async function loginAs(page: Page, role: RoleKey): Promise<void> {
  const credentials = ROLES[role]
  await loginWithCredentials(page, credentials.username, credentials.password)
}

async function openUsersPage(page: Page): Promise<{ users: any[]; roles: any[] }> {
  await loginAs(page, 'admin')
  const usersLink = page.getByRole('link', { name: '用户管理', exact: true })
  const rolesLink = page.getByRole('link', { name: '角色权限', exact: true })
  await expect(usersLink, 'admin users menu must exist').toBeVisible()
  await expect(rolesLink, 'admin roles menu must exist').toBeVisible()

  const usersResponsePromise = page.waitForResponse(response => matchesApiResponse(response, 'GET', '/users'))
  const rolesResponsePromise = page.waitForResponse(response => matchesApiResponse(response, 'GET', '/roles'))
  await usersLink.click()
  const [usersResponse, rolesResponse] = await Promise.all([usersResponsePromise, rolesResponsePromise])
  expect(usersResponse.status(), 'users page initialization').toBe(200)
  expect(rolesResponse.status(), 'role panel initialization').toBe(200)

  const users = listFromPayload(await usersResponse.json(), 'users response')
  const roles = listFromPayload(await rolesResponse.json(), 'roles response')
  const adminUser = requiredItem(users, user => user.username === 'admin', 'seeded admin user')
  const adminRole = requiredItem(roles, role => role.code === 'admin', 'seeded admin role')
  expect(adminUser.status, 'seeded admin must be active').toBe('active')
  expect(adminRole.permissions, 'admin role must preserve its all-permissions marker').toEqual(['*'])
  expect(adminSession.user.capabilities, 'admin effective permissions must include users and roles write').toEqual(expect.objectContaining({
    users: 'W',
    roles: 'W',
  }))

  await expect(page).toHaveURL(`${FE_BASE}/users`)
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible()
  await expect(page.getByText('用户列表', { exact: true })).toBeVisible()
  await expect(page.getByText('角色列表', { exact: true })).toBeVisible()
  await expect(userRow(page, 'admin'), 'seeded admin row must render').toBeVisible()
  return { users, roles }
}

async function openRolesPage(page: Page): Promise<any[]> {
  await loginAs(page, 'admin')
  const rolesLink = page.getByRole('link', { name: '角色权限', exact: true })
  await expect(rolesLink, 'admin roles menu must exist').toBeVisible()
  const responsePromise = page.waitForResponse(response => matchesApiResponse(response, 'GET', '/roles'))
  await rolesLink.click()
  const response = await responsePromise
  expect(response.status(), 'roles page initialization').toBe(200)
  const roles = listFromPayload(await response.json(), 'roles page response')

  await expect(page).toHaveURL(`${FE_BASE}/roles`)
  await expect(page.getByRole('heading', { name: '角色管理', exact: true })).toBeVisible()
  await expect(page.getByText('角色列表', { exact: true })).toBeVisible()
  const adminCard = roleCard(page, '管理员')
  await expect(adminCard, 'seeded admin role card must render').toBeVisible()
  await expect(adminCard.getByText('全部权限', { exact: true }), 'admin permission initialization must render').toBeVisible()
  return roles
}

async function searchForUser(page: Page, username: string) {
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url())
    return matchesApiResponse(response, 'GET', '/users') && url.searchParams.get('keyword') === username
  })
  await page.getByPlaceholder('搜索用户名、姓名...').fill(username)
  const response = await responsePromise
  expect(response.status(), `search response for ${username}`).toBe(200)
  const list = listFromPayload(await response.json(), `search response for ${username}`)
  requiredItem(list, user => user.username === username, `searched user ${username}`)
  const row = userRow(page, username)
  await expect(row, `visible row for ${username}`).toBeVisible()
  return row
}

test.beforeEach(async () => {
  createdUserIds = new Set<string>()
  createdRoleIds = new Set<string>()
  adminSession = await apiLogin('admin')
  adminToken = adminSession.token
})

test.afterEach(async () => {
  for (const id of [...createdUserIds].reverse()) {
    const result = await apiFetch(adminToken, 'DELETE', `/users/${id}`)
    expect([200, 404], `cleanup user ${id}`).toContain(result.status)
  }
  for (const id of [...createdRoleIds].reverse()) {
    const result = await apiFetch(adminToken, 'DELETE', `/roles/${id}`)
    expect([200, 404], `cleanup role ${id}`).toContain(result.status)
  }
})

test.describe('用户、角色与权限发布真实性', () => {
  test('初始化必须同时提供菜单、admin 用户、角色和权限矩阵', async ({ page }) => {
    const { roles } = await openUsersPage(page)
    expect(roles.map(role => role.code)).toEqual(expect.arrayContaining([
      'admin',
      'warehouse_manager',
      'technician',
      'pathologist',
      'procurement',
      'finance',
    ]))

    const rolesResponsePromise = page.waitForResponse(response => matchesApiResponse(response, 'GET', '/roles'))
    await page.getByRole('link', { name: '角色权限', exact: true }).click()
    const rolesResponse = await rolesResponsePromise
    expect(rolesResponse.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '角色管理', exact: true })).toBeVisible()
    const adminCard = roleCard(page, '管理员')
    await expect(adminCard).toBeVisible()
    await expect(adminCard.getByText('全部权限', { exact: true })).toBeVisible()
  })

  test('admin 通过真实 UI 创建技术员用户并看到准确角色与启用状态', async ({ page }) => {
    await openUsersPage(page)
    const username = `testuser-ui-${uniqueSuffix()}`
    const realName = `UI 创建 ${uniqueSuffix()}`
    await page.getByRole('button', { name: '新建用户', exact: true }).click()
    const modal = page.locator('.fixed.inset-0.z-50').filter({
      has: page.getByRole('heading', { name: '新建用户', exact: true }),
    })
    await expect(modal).toBeVisible()
    const textboxes = modal.getByRole('textbox')
    await textboxes.nth(0).fill(username)
    await textboxes.nth(1).fill(realName)
    const technicianRole = modal.getByRole('button', { name: '技术员', exact: true })
    await technicianRole.click()
    await expect(technicianRole).toHaveClass(/bg-blue-500/)
    const passwordInput = modal.locator('input[autocomplete="new-password"]')
    await expect(passwordInput).toHaveAttribute('type', 'password')
    const generatedPassword = await passwordInput.inputValue()
    expect(generatedPassword.length).toBeGreaterThanOrEqual(12)

    const createResponsePromise = page.waitForResponse(response => matchesApiResponse(response, 'POST', '/users'))
    await modal.getByRole('button', { name: '创建用户', exact: true }).click()
    const createResponse = await createResponsePromise
    expect(createResponse.status(), 'UI user create response').toBe(201)
    const requestBody = createResponse.request().postDataJSON()
    expect(requestBody).toEqual(expect.objectContaining({
      username,
      realName,
      role: 'technician',
      roles: ['technician'],
      primaryRole: 'technician',
    }))
    const createdId = requiredString((await createResponse.json())?.data?.id, 'UI-created user id')
    createdUserIds.add(createdId)
    await expect(modal).toBeHidden()

    const row = await searchForUser(page, username)
    await expect(row.getByText('technician', { exact: true }), 'created user role').toBeVisible()
    await expect(row.getByText('正常', { exact: true }), 'created user active state').toBeVisible()

    const lookup = await apiFetch(adminToken, 'GET', `/users?keyword=${encodeURIComponent(username)}`)
    expect(lookup.status).toBe(200)
    const created = requiredItem(
      listFromPayload(responseData(lookup), 'created user lookup'),
      user => user.username === username,
      'created user record',
    )
    expect(created).toEqual(expect.objectContaining({
      username,
      realName,
      role: 'technician',
      primaryRole: 'technician',
      roles: ['technician'],
      status: 'active',
    }))

    const login = await apiLoginCredentials(username, generatedPassword)
    expect(login.user.role, 'new user login role').toBe('technician')
    expect(login.user.roles, 'new user login roles').toEqual(['technician'])
    expect(Object.keys(login.user.capabilities), 'technician must not gain users permission').not.toContain('users')
  })

  test('admin 通过真实 UI 创建角色并保存准确的 R/W 权限', async ({ page }) => {
    await openRolesPage(page)
    const roleName = `E2E 权限角色 ${uniqueSuffix()}`
    await page.getByRole('button', { name: '新建角色', exact: true }).click()
    const modal = page.locator('.fixed.inset-0.z-50').filter({
      has: page.getByRole('heading', { name: '新建角色', exact: true }),
    })
    await expect(modal).toBeVisible()
    await modal.getByPlaceholder('请输入角色名称').fill(roleName)

    const usersPermissionRow = modal.getByRole('row').filter({
      has: modal.getByText('用户管理', { exact: true }),
    })
    const rolesPermissionRow = modal.getByRole('row').filter({
      has: modal.getByText('角色权限', { exact: true }),
    })
    await usersPermissionRow.getByRole('button', { name: '只读', exact: true }).click()
    await rolesPermissionRow.getByRole('button', { name: '读写', exact: true }).click()
    await expect(usersPermissionRow.getByRole('button', { name: '只读', exact: true })).toHaveClass(/bg-blue-500/)
    await expect(rolesPermissionRow.getByRole('button', { name: '读写', exact: true })).toHaveClass(/bg-blue-500/)

    const createResponsePromise = page.waitForResponse(response => matchesApiResponse(response, 'POST', '/roles'))
    await modal.getByRole('button', { name: '创建角色', exact: true }).click()
    const createResponse = await createResponsePromise
    expect(createResponse.status(), 'UI role create response').toBe(201)
    expect(createResponse.request().postDataJSON()).toEqual(expect.objectContaining({
      name: roleName,
      permissions: { users: 'R', roles: 'W' },
    }))
    const roleId = requiredString((await createResponse.json())?.data?.id, 'UI-created role id')
    createdRoleIds.add(roleId)
    await expect(modal).toBeHidden()

    const card = roleCard(page, roleName)
    await expect(card, 'created role card').toBeVisible()
    await expect(card.getByText('用户管理', { exact: true }), 'users permission chip').toBeVisible()
    await expect(card.getByText('角色权限', { exact: true }), 'roles permission chip').toBeVisible()

    const rolesResult = await apiFetch(adminToken, 'GET', '/roles?page=1&pageSize=100')
    expect(rolesResult.status).toBe(200)
    const storedRole = requiredItem(
      listFromPayload(responseData(rolesResult), 'roles lookup'),
      role => role.id === roleId,
      'stored UI-created role',
    )
    expect(storedRole.permissions).toEqual({ users: 'R', roles: 'W' })
  })

  test('用户创建校验、重复用户名和不存在资源都返回准确拒绝状态', async () => {
    const missingFields = await apiFetch(adminToken, 'POST', '/users', {})
    expect(missingFields.status).toBe(400)
    expect(missingFields.data?.error?.code).toBe('INVALID_PARAMETER')

    const existing = await createUser()
    const duplicate = await apiFetch(adminToken, 'POST', '/users', {
      username: existing.username,
      password: STRONG_TEST_PASSWORD,
      realName: '重复用户名',
      role: 'technician',
      roles: ['technician'],
      primaryRole: 'technician',
    })
    expect(duplicate.status).toBe(409)
    expect(duplicate.data?.error?.code).toBe('RESOURCE_CONFLICT')

    const missingUser = await apiFetch(adminToken, 'PUT', '/users/non-existent-id', { realName: '不存在' })
    expect(missingUser.status).toBe(404)
    expect(missingUser.data?.error?.code).toBe('NOT_FOUND')
  })

  test('编辑用户同时保存姓名与新密码，旧密码失效且新密码可登录', async ({ page }) => {
    const user = await createUser({ realName: '编辑前姓名' })
    expect(await apiLoginStatus(user.username, user.password)).toBe(200)
    await openUsersPage(page)
    const row = await searchForUser(page, user.username)
    await row.getByRole('button', { name: '编辑', exact: true }).click()

    const modal = page.locator('.fixed.inset-0.z-50').filter({
      has: page.getByRole('heading', { name: '编辑用户', exact: true }),
    })
    await expect(modal).toBeVisible()
    const usernameInput = modal.locator('input').nth(0)
    await expect(usernameInput).toHaveValue(user.username)
    await expect(usernameInput).toHaveAttribute('readonly', '')
    const realNameInput = modal.locator('input').nth(1)
    const changedName = `编辑后姓名 ${uniqueSuffix()}`
    await realNameInput.fill(changedName)
    const passwordInput = modal.locator('input[autocomplete="new-password"]')
    await expect(passwordInput).toHaveValue('')
    await passwordInput.fill(ROTATED_TEST_PASSWORD)

    const updateResponsePromise = page.waitForResponse(response => (
      matchesApiResponse(response, 'PUT', `/users/${user.id}`)
    ))
    await modal.getByRole('button', { name: '保存', exact: true }).click()
    const updateResponse = await updateResponsePromise
    expect(updateResponse.status(), 'edit user response').toBe(200)
    await expect(modal).toBeHidden()
    await expect(row.getByText(changedName, { exact: true }), 'updated user name in table').toBeVisible()

    const lookup = await apiFetch(adminToken, 'GET', `/users?keyword=${encodeURIComponent(user.username)}`)
    const updated = requiredItem(
      listFromPayload(responseData(lookup), 'updated user lookup'),
      item => item.username === user.username,
      'updated user record',
    )
    expect(updated.realName).toBe(changedName)
    expect(await apiLoginStatus(user.username, user.password), 'old password must be rejected').toBe(401)
    expect(await apiLoginStatus(user.username, ROTATED_TEST_PASSWORD), 'new password must work').toBe(200)
  })

  test('停用与启用都必须改变可见状态和真实登录结果', async ({ page }) => {
    const user = await createUser({ realName: '停启用状态测试' })
    await openUsersPage(page)
    const row = await searchForUser(page, user.username)
    await expect(row.getByText('正常', { exact: true }), 'initial active state').toBeVisible()

    const disableResponsePromise = page.waitForResponse(response => (
      matchesApiResponse(response, 'PUT', `/users/${user.id}`)
    ))
    await row.getByRole('button', { name: '停用', exact: true }).click()
    const disableResponse = await disableResponsePromise
    expect(disableResponse.status(), 'disable response').toBe(200)
    await expect(row.getByText('禁用', { exact: true }), 'disabled user state').toBeVisible()
    expect(await apiLoginStatus(user.username, user.password), 'disabled user login').toBe(401)

    const enableResponsePromise = page.waitForResponse(response => (
      matchesApiResponse(response, 'PUT', `/users/${user.id}`)
    ))
    await row.getByRole('button', { name: '启用', exact: true }).click()
    const enableResponse = await enableResponsePromise
    expect(enableResponse.status(), 'enable response').toBe(200)
    await expect(row.getByText('正常', { exact: true }), 're-enabled user state').toBeVisible()
    expect(await apiLoginStatus(user.username, user.password), 're-enabled user login').toBe(200)
  })

  test('删除用户必须经过确认并从 UI 与 API 同时消失', async ({ page }) => {
    const user = await createUser({ realName: '删除用户测试' })
    await openUsersPage(page)
    const row = await searchForUser(page, user.username)
    await row.getByRole('button', { name: '删除', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '确认删除' })
    await expect(dialog).toBeVisible()

    const deleteResponsePromise = page.waitForResponse(response => (
      matchesApiResponse(response, 'DELETE', `/users/${user.id}`)
    ))
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    const deleteResponse = await deleteResponsePromise
    expect(deleteResponse.status(), 'delete response').toBe(200)
    await expect(dialog).toBeHidden()
    await expect(row, 'deleted user row').toBeHidden()

    const lookup = await apiFetch(adminToken, 'GET', `/users?keyword=${encodeURIComponent(user.username)}`)
    expect(listFromPayload(responseData(lookup), 'deleted user lookup').some(item => item.username === user.username)).toBe(false)
    expect(await apiLoginStatus(user.username, user.password), 'deleted user login').toBe(401)
    createdUserIds.delete(user.id)
  })

  test('admin 账号不可被停用或删除，且拒绝后仍可登录', async () => {
    const usersResult = await apiFetch(adminToken, 'GET', '/users?page=1&pageSize=100')
    expect(usersResult.status).toBe(200)
    const adminUser = requiredItem(
      listFromPayload(responseData(usersResult), 'admin lookup'),
      user => user.username === 'admin',
      'admin user',
    )
    const adminId = requiredString(adminUser.id, 'admin user id')

    const disable = await apiFetch(adminToken, 'PUT', `/users/${adminId}`, { status: 'inactive' })
    expect(disable.status).toBe(409)
    expect(disable.data?.error?.code).toBe('BUSINESS_CONFLICT')
    const remove = await apiFetch(adminToken, 'DELETE', `/users/${adminId}`)
    expect(remove.status).toBe(409)
    expect(remove.data?.error?.code).toBe('BUSINESS_CONFLICT')
    expect(await apiLoginStatus(ROLES.admin.username, ROLES.admin.password)).toBe(200)
  })

  for (const role of NON_ADMIN_ROLES) {
    test(`${role} 的菜单、页面和用户/角色写接口都必须拒绝`, async ({ page }) => {
      const login = await apiLogin(role)
      const deniedRequests: Array<[HttpMethod, string, unknown?]> = [
        ['GET', '/users'],
        ['POST', '/users', { username: `denied-${uniqueSuffix()}`, password: STRONG_TEST_PASSWORD, realName: '拒绝' }],
        ['PUT', '/users/non-existent-id', { realName: '拒绝' }],
        ['DELETE', '/users/non-existent-id'],
        ['GET', '/roles'],
        ['POST', '/roles', { code: `denied_${uniqueSuffix()}`, name: '拒绝角色', permissions: { users: 'W' }, status: 'active' }],
      ]
      for (const [method, path, body] of deniedRequests) {
        const result = await apiFetch(login.token, method, path, body)
        expect(result.status, `${role} ${method} ${path}`).toBe(403)
        expect(result.data?.error?.code, `${role} ${method} ${path} code`).toBe('FORBIDDEN')
      }

      await loginWithCredentials(page, ROLES[role].username, ROLES[role].password)
      await expect(page.getByRole('link', { name: '用户管理', exact: true })).toHaveCount(0)
      await expect(page.getByRole('link', { name: '角色权限', exact: true })).toHaveCount(0)
      await page.goto(`${FE_BASE}/users`)
      await expect(page).toHaveURL(`${FE_BASE}/`)
      await page.goto(`${FE_BASE}/roles`)
      await expect(page).toHaveURL(`${FE_BASE}/`)
    })
  }

  test('角色权限 R/W 修改必须对同一用户立即生效且不能靠旧 token 扩权', async () => {
    const role = await createRole({ users: 'R' })
    const user = await createUser({ role: role.code, roles: [role.code], primaryRole: role.code })
    const login = await apiLoginCredentials(user.username, user.password)
    expect(login.user.role).toBe(role.code)
    expect(login.user.capabilities).toEqual({ users: 'R' })

    const readable = await apiFetch(login.token, 'GET', '/users?page=1&pageSize=1')
    expect(readable.status).toBe(200)
    const denied = await apiFetch(login.token, 'POST', '/users', {
      username: `denied-${uniqueSuffix()}`,
      password: STRONG_TEST_PASSWORD,
      realName: '只读角色不可创建',
      role: 'technician',
    })
    expect(denied.status).toBe(403)

    const grant = await apiFetch(adminToken, 'PUT', `/roles/${role.id}`, { permissions: { users: 'W' } })
    expect(grant.status).toBe(200)
    const allowedUsername = `testuser-granted-${uniqueSuffix()}`
    const allowed = await apiFetch(login.token, 'POST', '/users', {
      username: allowedUsername,
      password: STRONG_TEST_PASSWORD,
      realName: '即时授权创建',
      role: 'technician',
      roles: ['technician'],
      primaryRole: 'technician',
    })
    expect(allowed.status).toBe(201)
    createdUserIds.add(requiredString(responseData(allowed)?.id, 'permission-granted user id'))

    const revoke = await apiFetch(adminToken, 'PUT', `/roles/${role.id}`, { permissions: { users: 'R' } })
    expect(revoke.status).toBe(200)
    const deniedAgain = await apiFetch(login.token, 'POST', '/users', {
      username: `denied-again-${uniqueSuffix()}`,
      password: STRONG_TEST_PASSWORD,
      realName: '撤权后不可创建',
      role: 'technician',
    })
    expect(deniedAgain.status).toBe(403)
  })

  test('unknown、__proto__、constructor 和 prototype 权限键不得扩张能力', async () => {
    const permissions = JSON.parse(
      '{"inventory":"R","unknown_module":"W","__proto__":"W","constructor":"W","prototype":"W"}',
    ) as Record<string, unknown>
    const role = await createRole(permissions)

    const rolesResult = await apiFetch(adminToken, 'GET', '/roles?page=1&pageSize=100')
    expect(rolesResult.status).toBe(200)
    const storedRole = requiredItem(
      listFromPayload(responseData(rolesResult), 'prototype role lookup'),
      item => item.id === role.id,
      'prototype test role',
    )
    expect(storedRole.permissions).toEqual({ inventory: 'R' })
    expect(Object.keys(storedRole.permissions)).toEqual(['inventory'])

    const user = await createUser({ role: role.code, roles: [role.code], primaryRole: role.code })
    const login = await apiLoginCredentials(user.username, user.password)
    expect(login.user.capabilities).toEqual({ inventory: 'R' })
    expect(Object.keys(login.user.capabilities)).toEqual(['inventory'])

    const inventory = await apiFetch(login.token, 'GET', '/inventory?page=1&pageSize=1')
    expect(inventory.status).toBe(200)
    const users = await apiFetch(login.token, 'GET', '/users')
    expect(users.status).toBe(403)
    const roles = await apiFetch(login.token, 'GET', '/roles')
    expect(roles.status).toBe(403)
    const createDenied = await apiFetch(login.token, 'POST', '/users', {
      username: `prototype-denied-${uniqueSuffix()}`,
      password: STRONG_TEST_PASSWORD,
      realName: '原型键不得扩权',
      role: 'technician',
    })
    expect(createDenied.status).toBe(403)
  })
})
