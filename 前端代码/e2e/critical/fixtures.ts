import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const credentials = {
  admin: { username: 'admin', password: 'admin123' },
  warehouse_manager: { username: 'cangguan', password: 'CoreOne2026!' },
  technician: { username: 'jishuyuan1', password: 'CoreOne2026!' },
  finance: { username: 'caiwu', password: 'CoreOne2026!' },
} as const

export type FixtureRole = keyof typeof credentials

function apiBaseUrl(): string {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

export async function loginThroughUi(page: Page, role: FixtureRole): Promise<void> {
  await page.goto('/login')
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload()

  const credential = credentials[role]
  await page.getByPlaceholder('请输入用户名').fill(credential.username)
  await page.getByPlaceholder('请输入密码').fill(credential.password)

  const loginResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '登录', exact: true }).click()
  expect((await loginResponse).status(), `UI fixture login failed for ${role}`).toBe(200)
  await expect(page).toHaveURL((url) => url.pathname === '/')
}

export async function apiLogin(request: APIRequestContext, role: FixtureRole): Promise<string> {
  const response = await request.post(`${apiBaseUrl()}/auth/login`, { data: credentials[role] })
  expect(response.status(), `fixture login failed for ${role}`).toBe(200)
  const body = await response.json()
  const token = body?.data?.token ?? body?.token
  expect(token, `fixture login returned no token for ${role}`).toEqual(expect.any(String))
  return token
}

export async function apiGet(
  request: APIRequestContext,
  token: string,
  path: string,
) {
  return request.get(`${apiBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}
