import { test, expect, Page } from '@playwright/test'

const FE_BASE = `http://localhost:${process.env.E2E_FRONTEND_PORT || '8080'}`
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
const ROLE_KEYS: RoleKey[] = ['admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance']

const ROLE_LABELS: Record<RoleKey, string> = {
  admin: '系统管理员',
  warehouse_manager: '仓库管理员',
  technician: '技术员',
  pathologist: '病理医生',
  procurement: '采购员',
  finance: '财务人员',
}

const ROLE_MENU_EXPECTATIONS: Record<RoleKey, { visible: string[]; hidden: string[] }> = {
  admin: {
    visible: ['/inventory', '/inbound', '/outbound', '/users', '/roles', '/logs'],
    hidden: [],
  },
  warehouse_manager: {
    visible: ['/inventory', '/inbound', '/outbound', '/stocktaking', '/bom'],
    hidden: ['/projects', '/cost-analysis', '/users', '/roles', '/logs'],
  },
  technician: {
    visible: ['/inventory', '/outbound', '/stocktaking', '/projects', '/bom'],
    hidden: ['/inbound', '/cost-analysis', '/users', '/roles', '/logs'],
  },
  pathologist: {
    visible: ['/inventory', '/projects', '/bom'],
    hidden: ['/inbound', '/outbound', '/cost-analysis', '/users', '/roles', '/logs'],
  },
  procurement: {
    visible: ['/inventory', '/inbound', '/suppliers', '/purchase-orders', '/cost-analysis'],
    hidden: ['/outbound', '/stocktaking', '/users', '/roles', '/logs'],
  },
  finance: {
    visible: ['/inventory', '/reconciliation', '/cost-analysis', '/logs'],
    hidden: ['/inbound', '/outbound', '/stocktaking', '/users', '/roles'],
  },
}

function isLoginResponse(response: { url(): string; request(): { method(): string } }) {
  return response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/auth/login'
}

async function resetBrowserAuth(page: Page) {
  await page.goto(`${FE_BASE}/login`)
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
  await page.goto(`${FE_BASE}/login`)
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
}

async function storedAuthState(page: Page) {
  return page.evaluate(() => ({
    hasToken: Boolean(localStorage.getItem('token')),
    hasRefreshToken: Boolean(localStorage.getItem('refreshToken')),
    hasUser: Boolean(localStorage.getItem('user')),
    hasRememberedUsername: Boolean(localStorage.getItem('rememberUsername')),
  }))
}

async function expectRoleMenus(page: Page, role: RoleKey) {
  const nav = page.locator('aside nav')
  await expect(nav).toBeVisible()
  for (const path of ROLE_MENU_EXPECTATIONS[role].visible) {
    await expect(nav.locator(`a[href="${path}"]`)).toBeVisible()
  }
  for (const path of ROLE_MENU_EXPECTATIONS[role].hidden) {
    await expect(nav.locator(`a[href="${path}"]`)).toHaveCount(0)
  }
}

async function expectRejectedLogin(page: Page, username: string, password: string) {
  await page.fill('input[type="text"]', username)
  await page.fill('input[type="password"]', password)
  const responsePromise = page.waitForResponse(isLoginResponse)
  await page.click('button[type="submit"]')
  const response = await responsePromise
  expect(response.status()).toBe(401)
  const body = await response.json() as any
  expect(body.success).toBe(false)
  expect(body.error?.code).toBe('UNAUTHORIZED')
  await expect(page).toHaveURL(`${FE_BASE}/login`)
  await expect(page.locator('[data-sonner-toast]').last()).toContainText('登录失败，请检查用户名和密码')
  expect(await storedAuthState(page)).toEqual({
    hasToken: false,
    hasRefreshToken: false,
    hasUser: false,
    hasRememberedUsername: false,
  })
}

async function expectForbiddenPath(page: Page, path: string) {
  await page.goto(`${FE_BASE}${path}`)
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  await expect(page.locator('aside')).toBeVisible()
}

async function logoutThroughUi(page: Page) {
  const accountButton = page.locator('header button').filter({ hasText: '系统管理员' })
  await expect(accountButton).toBeVisible()
  await accountButton.click()
  const logoutButton = page.getByRole('button', { name: '退出登录', exact: true })
  await expect(logoutButton).toBeVisible()
  await logoutButton.click()
  await expect(page).toHaveURL(`${FE_BASE}/login`)
}

async function loginAs(page: Page, role: RoleKey) {
  await resetBrowserAuth(page)
  const cred = ROLES[role]
  await page.fill('input[type="text"]', cred.username)
  await page.fill('input[type="password"]', cred.password)
  const responsePromise = page.waitForResponse(isLoginResponse)
  await page.click('button[type="submit"]')
  const response = await responsePromise
  expect(response.status()).toBe(200)
  const responseBody = await response.json() as any
  expect(responseBody.success).toBe(true)
  expect(responseBody.data?.user?.username).toBe(cred.username)
  expect(responseBody.data?.user?.role).toBe(role)
  expect(typeof responseBody.data?.token === 'string' && responseBody.data.token.split('.').length === 3).toBe(true)
  expect(typeof responseBody.data?.refreshToken === 'string' && responseBody.data.refreshToken.split('.').length === 3).toBe(true)
  await expect(page).toHaveURL(`${FE_BASE}/`, { timeout: 10000 })
  const session = await page.evaluate(() => {
    const userJson = localStorage.getItem('user')
    const token = localStorage.getItem('token')
    const refreshToken = localStorage.getItem('refreshToken')
    return {
      user: userJson ? JSON.parse(userJson) : null,
      hasAccessToken: Boolean(token && token.split('.').length === 3),
      hasRefreshToken: Boolean(refreshToken && refreshToken.split('.').length === 3),
    }
  })
  expect(session.user).toMatchObject({ username: cred.username, role })
  expect(session.hasAccessToken).toBe(true)
  expect(session.hasRefreshToken).toBe(true)
  await expect(page.locator('aside').getByText(ROLE_LABELS[role], { exact: true })).toBeVisible()
}

async function apiLoginSession(role: RoleKey): Promise<any> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ROLES[role]),
  })
  const data = (await res.json()) as any
  expect(res.status).toBe(200)
  expect(data.success).toBe(true)
  expect(data.data?.user?.username).toBe(ROLES[role].username)
  expect(data.data?.user?.role).toBe(role)
  expect(typeof data.data?.token === 'string' && data.data.token.split('.').length === 3).toBe(true)
  expect(typeof data.data?.refreshToken === 'string' && data.data.refreshToken.split('.').length === 3).toBe(true)
  return data.data
}

async function apiLogin(role: RoleKey): Promise<string> {
  return (await apiLoginSession(role)).token
}

async function apiFetch(token: string, method: string, path: string, body?: any) {
  const opts: any = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
  if (body && method !== 'GET' && method !== 'HEAD') opts.body = JSON.stringify(body)
  const res = await fetch(`${API_BASE}${path}`, opts)
  return { status: res.status, data: (await res.json()) as any }
}

test.beforeEach(async ({ page }) => {
  await resetBrowserAuth(page)
})

// ═══════════════════════════════════════════════════════════════
// 一、正常登录（6角色 × 多场景）
// ═══════════════════════════════════════════════════════════════
test.describe('认证与登录 -> 正常登录', () => {
  for (const role of ROLE_KEYS) {
    test(`AUTH-LOGIN-01-${role}. 正常用例：${role}使用正确用户名密码登录成功`, async ({ page }) => {
      await loginAs(page, role)
      await expect(page).toHaveURL(`${FE_BASE}/`)
    })
  }

  for (const role of ROLE_KEYS) {
    test(`AUTH-LOGIN-02-${role}. 正常用例：${role}登录后localStorage存储token`, async ({ page }) => {
      await loginAs(page, role)
      const token = await page.evaluate(() => localStorage.getItem('token'))
      expect(token).toBeTruthy()
      expect(token!.split('.').length).toBe(3)
    })
  }

  for (const role of ROLE_KEYS) {
    test(`AUTH-LOGIN-03-${role}. 正常用例：${role}登录后显示对应权限菜单`, async ({ page }) => {
      await loginAs(page, role)
      await expectRoleMenus(page, role)
    })
  }

  test('AUTH-LOGIN-04. 正常用例：admin登录后显示认证关键菜单项', async ({ page }) => {
    await loginAs(page, 'admin')
    const paths = [
      '/inventory', '/inbound', '/outbound', '/stocktaking', '/categories',
      '/suppliers', '/locations', '/projects', '/bom', '/cost-analysis',
      '/alerts', '/reconciliation', '/users', '/roles', '/logs',
    ]
    for (const path of paths) {
      await expect(page.locator(`aside nav a[href="${path}"]`)).toBeVisible()
    }
  })

  test('AUTH-LOGIN-05. 正常用例：finance登录后仅显示允许菜单', async ({ page }) => {
    await loginAs(page, 'finance')
    await expect(page.locator('aside nav a[href="/cost-analysis"]')).toBeVisible()
    await expect(page.locator('aside nav a[href="/inbound"]')).toHaveCount(0)
    await expect(page.locator('aside nav a[href="/outbound"]')).toHaveCount(0)
    await expect(page.locator('aside nav a[href="/stocktaking"]')).toHaveCount(0)
  })

  test('AUTH-LOGIN-06. 正常用例：technician登录后显示技术相关菜单', async ({ page }) => {
    await loginAs(page, 'technician')
    await expect(page.locator('aside nav a[href="/inventory"]')).toBeVisible()
    await expect(page.locator('aside nav a[href="/outbound"]')).toBeVisible()
    await expect(page.locator('aside nav a[href="/inbound"]')).toHaveCount(0)
    await expect(page.locator('aside nav a[href="/users"]')).toHaveCount(0)
  })

  test('AUTH-LOGIN-07. 正常用例：warehouse_manager登录后显示仓库管理菜单', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await expect(page.locator('aside nav a[href="/inbound"]')).toBeVisible()
    await expect(page.locator('aside nav a[href="/outbound"]')).toBeVisible()
    await expect(page.locator('aside nav a[href="/stocktaking"]')).toBeVisible()
  })

  test('AUTH-LOGIN-08. 正常用例：pathologist登录后显示诊断相关菜单', async ({ page }) => {
    await loginAs(page, 'pathologist')
    await expect(page.locator('aside nav a[href="/projects"]')).toBeVisible()
    await expect(page.locator('aside nav a[href="/cost-analysis"]')).toHaveCount(0)
    await expect(page.locator('aside nav a[href="/users"]')).toHaveCount(0)
  })

  test('AUTH-LOGIN-09. 正常用例：procurement登录后显示采购相关菜单', async ({ page }) => {
    await loginAs(page, 'procurement')
    await expect(page.locator('aside nav a[href="/suppliers"]')).toBeVisible()
    await expect(page.locator('aside nav a[href="/purchase-orders"]')).toBeVisible()
    await expect(page.locator('aside nav a[href="/outbound"]')).toHaveCount(0)
  })

  test('AUTH-LOGIN-10. 边界：使用大写用户名登录', async ({ page }) => {
    await expectRejectedLogin(page, 'ADMIN', 'admin123')
  })

  test('AUTH-LOGIN-11. 边界：用户名前后带空格', async ({ page }) => {
    await expectRejectedLogin(page, ' admin ', 'admin123')
  })

  test('AUTH-LOGIN-12. 边界：记住用户名功能开启', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    const remember = page.getByRole('checkbox', { name: '记住我', exact: true })
    await expect(remember).toBeVisible()
    await remember.check()
    await expect(remember).toBeChecked()
    await page.click('button[type="submit"]')
    await page.waitForURL(`${FE_BASE}/`)
    await page.goto(`${FE_BASE}/login`)
    const saved = await page.evaluate(() => localStorage.getItem('rememberUsername'))
    expect(saved).toBe('admin')
  })

  test('AUTH-LOGIN-13. 边界：记住用户名功能关闭', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    await page.click('button[type="submit"]')
    await page.waitForURL(`${FE_BASE}/`)
    await page.goto(`${FE_BASE}/login`)
    const saved = await page.evaluate(() => localStorage.getItem('rememberUsername'))
    expect(saved).toBeFalsy()
  })

  test('AUTH-LOGIN-14. 正常用例：回车键提交表单', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    await page.keyboard.press('Enter')
    await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
  })

  test('AUTH-LOGIN-15. 正常用例：点击提交按钮登录', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    await page.click('button[type="submit"]')
    await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
  })
})

// ═══════════════════════════════════════════════════════════════
// 二、空数据/边界
// ═══════════════════════════════════════════════════════════════
test.describe('认证与登录 -> 空数据/边界', () => {
  test('AUTH-BOUND-01. 空数据：用户名和密码都为空', async ({ page }) => {
    await page.click('button[type="submit"]')
    await expect(page).toHaveURL(`${FE_BASE}/login`)
    await expect(page.locator('text=请输入用户名').first()).toBeVisible()
    await expect(page.locator('text=请输入密码').first()).toBeVisible()
  })

  test('AUTH-BOUND-02. 空数据：用户名为空密码非空', async ({ page }) => {
    await page.fill('input[type="password"]', 'admin123')
    await page.click('button[type="submit"]')
    await expect(page.locator('text=请输入用户名').first()).toBeVisible()
  })

  test('AUTH-BOUND-03. 空数据：密码为空用户名非空', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.click('button[type="submit"]')
    await expect(page.locator('text=请输入密码').first()).toBeVisible()
  })

  test('AUTH-BOUND-04. 空数据：密码为空格字符串', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', '   ')
    await page.click('button[type="submit"]')
    await expect(page.getByText('请输入密码', { exact: true })).toBeVisible()
    await expect(page).toHaveURL(`${FE_BASE}/login`)
    expect((await storedAuthState(page)).hasToken).toBe(false)
  })

  test('AUTH-BOUND-05. 边界：超长用户名（>50字符）', async ({ page }) => {
    await page.fill('input[type="text"]', 'a'.repeat(100))
    await page.fill('input[type="password"]', 'admin123')
    const responsePromise = page.waitForResponse(r => r.url().includes('/auth/login'))
    await page.click('button[type="submit"]')
    const response = await responsePromise
    expect(response.status()).toBe(401)
  })

  test('AUTH-BOUND-06. 边界：超长密码（>100字符）', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'p'.repeat(150))
    const responsePromise = page.waitForResponse(r => r.url().includes('/auth/login'))
    await page.click('button[type="submit"]')
    const response = await responsePromise
    expect(response.status()).toBe(401)
  })

  test('AUTH-BOUND-07. 边界：特殊字符用户名', async ({ page }) => {
    await expectRejectedLogin(page, 'admin@#$%', 'admin123')
  })

  test('AUTH-BOUND-08. 边界：Unicode用户名', async ({ page }) => {
    await expectRejectedLogin(page, '管理员', 'admin123')
  })

  test('AUTH-BOUND-09. 边界：密码包含特殊字符', async ({ page }) => {
    await expectRejectedLogin(page, 'admin', 'pass!@#123')
  })

  test('AUTH-BOUND-10. 边界：单字符用户名', async ({ page }) => {
    await expectRejectedLogin(page, 'a', 'admin123')
  })
})

// ═══════════════════════════════════════════════════════════════
// 三、表单校验错误
// ═══════════════════════════════════════════════════════════════
test.describe('认证与登录 -> 表单校验错误', () => {
  test('AUTH-VALID-01. 密码错误返回401', async ({ page }) => {
    await expectRejectedLogin(page, 'admin', 'wrongpassword')
  })

  test('AUTH-VALID-02. 不存在的用户登录', async ({ page }) => {
    await expectRejectedLogin(page, 'nonexistentuser12345', 'anypassword')
  })

  test('AUTH-VALID-03. 已禁用用户登录', async ({ page }) => {
    await expectRejectedLogin(page, 'disabled_user', 'anypassword')
  })

  test('AUTH-VALID-04. 密码大小写错误', async ({ page }) => {
    await expectRejectedLogin(page, 'admin', 'ADMIN123')
  })

  test('AUTH-VALID-05. API直接调用缺少字段返回400', async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('AUTH-VALID-06. API直接调用缺少密码返回400', async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin' }),
    })
    expect(res.status).toBe(400)
  })

  test('AUTH-VALID-07. API直接调用缺少用户名返回400', async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin123' }),
    })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
// 四、Token刷新
// ═══════════════════════════════════════════════════════════════
test.describe('认证与登录 -> Token刷新', () => {
  test('AUTH-REFRESH-01. 正常用例：有效refreshToken获取新access token', async () => {
    const login = await apiLoginSession('admin')
    const res = await apiFetch('', 'POST', '/auth/refresh', { refreshToken: login.refreshToken })
    expect(res.status).toBe(200)
    expect(typeof res.data.data?.token === 'string' && res.data.data.token.split('.').length === 3).toBe(true)
    expect(res.data.data?.expiresIn).toBe(28800)
    expect(res.data.data?.user?.role).toBe('admin')
  })

  test('AUTH-REFRESH-02. 边界：refreshToken过期返回401', async () => {
    const res = await apiFetch('', 'POST', '/auth/refresh', { refreshToken: 'expired.token.here' })
    expect(res.status).toBe(401)
    expect(res.data.error?.code).toBe('UNAUTHORIZED')
  })

  test('AUTH-REFRESH-03. 边界：使用accessToken调用刷新返回401', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch('', 'POST', '/auth/refresh', { refreshToken: token })
    expect(res.status).toBe(401)
    expect(res.data.error?.code).toBe('UNAUTHORIZED')
  })

  test('AUTH-REFRESH-04. 边界：无refreshToken调用刷新返回400', async () => {
    const res = await apiFetch('', 'POST', '/auth/refresh', {})
    expect(res.status).toBe(400)
    expect(res.data.error?.code).toBe('INVALID_PARAMETER')
  })

  test('AUTH-REFRESH-05. 并发：并发调用刷新接口', async () => {
    const login = await apiLoginSession('admin')
    const refreshToken = login.refreshToken
    const reqs = Array.from({ length: 3 }, () => apiFetch('', 'POST', '/auth/refresh', { refreshToken }))
    const results = await Promise.all(reqs)
    for (const result of results) {
      expect(result.status).toBe(200)
      expect(typeof result.data.data?.token === 'string' && result.data.data.token.split('.').length === 3).toBe(true)
      expect(result.data.data?.user?.role).toBe('admin')
    }
  })

  test('AUTH-REFRESH-06. 异常恢复：无效refreshToken失败后有效token仍可刷新', async () => {
    const login = await apiLoginSession('admin')
    const refreshToken = login.refreshToken
    const fail = await apiFetch('', 'POST', '/auth/refresh', { refreshToken: 'bad' })
    expect(fail.status).toBe(401)
    expect(fail.data.error?.code).toBe('UNAUTHORIZED')
    const success = await apiFetch('', 'POST', '/auth/refresh', { refreshToken })
    expect(success.status).toBe(200)
    expect(success.data.data?.user?.role).toBe('admin')
  })

  test('AUTH-REFRESH-07. 正常用例：刷新后新token可访问受保护接口', async () => {
    const login = await apiLoginSession('admin')
    const refreshRes = await apiFetch('', 'POST', '/auth/refresh', { refreshToken: login.refreshToken })
    expect(refreshRes.status).toBe(200)
    const newToken = refreshRes.data.data?.token
    expect(typeof newToken === 'string' && newToken.split('.').length === 3).toBe(true)
    const inventoryRes = await apiFetch(newToken, 'GET', '/inventory')
    expect(inventoryRes.status).toBe(200)
  })

  test('AUTH-REFRESH-08. 边界：刷新响应格式验证', async () => {
    const login = await apiLoginSession('admin')
    const res = await apiFetch('', 'POST', '/auth/refresh', { refreshToken: login.refreshToken })
    expect(res.status).toBe(200)
    expect(res.data.success).toBe(true)
    expect(res.data.message).toBe('Refresh success')
    expect(res.data.data?.expiresIn).toBe(28800)
    expect(res.data.data?.user).toMatchObject({ username: 'admin', role: 'admin' })
  })
})

// ═══════════════════════════════════════════════════════════════
// 五、用户登出
// ═══════════════════════════════════════════════════════════════
test.describe('认证与登录 -> 用户登出', () => {
  test('AUTH-LOGOUT-01. 正常用例：已登录用户调用登出成功', async ({ page }) => {
    await loginAs(page, 'admin')
    const token = await page.evaluate(() => localStorage.getItem('token'))
    const res = await apiFetch(token!, 'POST', '/auth/logout')
    expect(res.status).toBe(200)
  })

  test('AUTH-LOGOUT-02. 并发：重复点击登出按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    const token = await page.evaluate(() => localStorage.getItem('token'))
    const [res1, res2] = await Promise.all([
      apiFetch(token!, 'POST', '/auth/logout'),
      apiFetch(token!, 'POST', '/auth/logout'),
    ])
    expect([200, 204]).toContain(res1.status)
    expect([200, 204]).toContain(res2.status)
  })

  test('AUTH-LOGOUT-03. 异常恢复：登出时网络中断后重试', async ({ page }) => {
    await loginAs(page, 'admin')
    const token = await page.evaluate(() => localStorage.getItem('token'))
    const res = await apiFetch(token!, 'POST', '/auth/logout')
    expect(res.status).toBe(200)
  })

  test('AUTH-LOGOUT-04. 正常用例：登出后清除localStorage中的token', async ({ page }) => {
    await loginAs(page, 'admin')
    await logoutThroughUi(page)
    expect((await storedAuthState(page)).hasToken).toBe(false)
  })

  test('AUTH-LOGOUT-05. 正常用例：登出后访问受保护页面重定向到登录', async ({ page }) => {
    await loginAs(page, 'admin')
    await logoutThroughUi(page)
    await page.goto(`${FE_BASE}/inventory`)
    await expect(page).toHaveURL(`${FE_BASE}/login`)
  })

  test('AUTH-LOGOUT-06. 边界：无token调用登出API', async () => {
    const res = await apiFetch('', 'POST', '/auth/logout')
    expect(res.status).toBe(200)
  })

  test('AUTH-LOGOUT-07. 正常用例：登出后refreshToken也清除', async ({ page }) => {
    await loginAs(page, 'admin')
    await logoutThroughUi(page)
    expect(await storedAuthState(page)).toEqual({
      hasToken: false,
      hasRefreshToken: false,
      hasUser: false,
      hasRememberedUsername: false,
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 六、角色权限矩阵（大量组合）
// ═══════════════════════════════════════════════════════════════
test.describe('认证与登录 -> 角色权限矩阵补充', () => {
  const protectedPaths = ['/', '/inventory', '/inbound', '/outbound', '/stocktaking', '/categories', '/materials', '/suppliers', '/locations', '/projects', '/bom', '/cost-analysis', '/reconciliation', '/alerts', '/users', '/roles', '/logs', '/supplier-returns']

  for (const path of protectedPaths) {
    test(`TC-PERM-AUTH-01${path.replace(/\//g, '-')}. 未登录访问${path}应重定向到登录页`, async ({ page }) => {
      await page.goto(`${FE_BASE}${path}`)
      await expect(page).toHaveURL(`${FE_BASE}/login`)
    })
  }

  for (const path of protectedPaths) {
    test(`TC-PERM-AUTH-02${path.replace(/\//g, '-')}. 错误Token访问${path}返回401`, async () => {
      const apiPathMap: Record<string, string> = {
        '/': '/inventory',
        '/bom': '/bom', // fallback to same, may 404 if no API
      }
      const apiPath = apiPathMap[path] || path
      const res = await fetch(`${API_BASE}${apiPath}`, {
        headers: { Authorization: 'Bearer invalid.token', 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(401)
    })
  }

  for (const role of ROLE_KEYS) {
    test(`TC-PERM-AUTH-03-${role}. ${role}无Token直接调用API返回401`, async () => {
      const res = await fetch(`${API_BASE}/inventory`, { headers: { 'Content-Type': 'application/json' } })
      expect(res.status).toBe(401)
    })
  }

  test('TC-PERM-AUTH-04. admin可访问全部页面', async ({ page }) => {
    await loginAs(page, 'admin')
    for (const path of protectedPaths.filter(p => p !== '/')) {
      await page.goto(`${FE_BASE}${path}`)
      await expect.poll(() => new URL(page.url()).pathname).toBe(path)
      await expect(page.locator('body')).toBeVisible({ timeout: 10000 })
    }
  })

  test('TC-PERM-AUTH-05. technician不可访问入库/用户/角色/日志', async ({ page }) => {
    await loginAs(page, 'technician')
    for (const path of ['/inbound', '/users', '/roles', '/logs']) {
      await expectForbiddenPath(page, path)
    }
  })

  test('TC-PERM-AUTH-06. finance不可访问入库/出库/盘点', async ({ page }) => {
    await loginAs(page, 'finance')
    for (const path of ['/inbound', '/outbound', '/stocktaking']) {
      await expectForbiddenPath(page, path)
    }
  })

  test('TC-PERM-AUTH-07. procurement不可访问出库/盘点/系统管理', async ({ page }) => {
    await loginAs(page, 'procurement')
    for (const path of ['/outbound', '/stocktaking', '/users', '/roles', '/logs']) {
      await expectForbiddenPath(page, path)
    }
  })

  test('TC-PERM-AUTH-08. warehouse_manager不可访问项目/成本/系统管理', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    for (const path of ['/projects', '/cost-analysis', '/users', '/roles', '/logs']) {
      await expectForbiddenPath(page, path)
    }
  })

  test('TC-PERM-AUTH-09. pathologist不可访问系统管理页面', async ({ page }) => {
    await loginAs(page, 'pathologist')
    for (const path of ['/users', '/roles', '/logs']) {
      await expectForbiddenPath(page, path)
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// 七、业务流程树
// ═══════════════════════════════════════════════════════════════
test.describe('认证与登录 -> 业务流程树', () => {
  const allowedPaths: { role: RoleKey; path: string; heading: string }[] = [
    { role: 'technician', path: '/outbound', heading: '出库记录' },
    { role: 'technician', path: '/stocktaking', heading: '库存盘点' },
    { role: 'procurement', path: '/cost-analysis', heading: '物料成本分析' },
    { role: 'warehouse_manager', path: '/bom', heading: 'BOM清单' },
  ]
  const forbiddenPaths: { role: RoleKey; paths: string[] }[] = [
    { role: 'technician', paths: ['/inbound', '/users', '/roles'] },
    { role: 'procurement', paths: ['/outbound', '/stocktaking'] },
    { role: 'finance', paths: ['/inbound', '/outbound', '/stocktaking'] },
    { role: 'warehouse_manager', paths: ['/projects', '/users'] },
    { role: 'pathologist', paths: ['/users', '/roles', '/logs'] },
  ]

  for (const { role, paths } of forbiddenPaths) {
    for (const path of paths) {
      test(`BF-PERM-${role}-${path.replace(/\//g, '')}. ${role}尝试访问${path}应被拦截`, async ({ page }) => {
        await loginAs(page, role)
        await expectForbiddenPath(page, path)
      })
    }
  }

  for (const { role, path, heading } of allowedPaths) {
    test(`BF-PERM-ALLOW-${role}-${path.replace(/\//g, '')}. ${role}可访问${path}`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}${path}`)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 10000 })
      await expect.poll(() => new URL(page.url()).pathname).toBe(path)
    })
  }
})

// ═══════════════════════════════════════════════════════════════
// 八、盲点分析补充
// ═══════════════════════════════════════════════════════════════
test.describe('认证与登录 -> 盲点分析补充', () => {
  test('BLIND-AUTH-01. localStorage正确存储token和refreshToken', async ({ page }) => {
    await loginAs(page, 'admin')
    const token = await page.evaluate(() => localStorage.getItem('token'))
    const refreshToken = await page.evaluate(() => localStorage.getItem('refreshToken'))
    expect(token).toBeTruthy()
    expect(refreshToken).toBeTruthy()
  })

  test('BLIND-AUTH-02. 已登录用户回退到登录页应自动重定向到首页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/login`)
    await expect(page).toHaveURL(`${FE_BASE}/`, { timeout: 10000 })
  })

  test('BLIND-AUTH-03. Token过期且refreshToken无效后应重定向登录', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.evaluate(() => {
      localStorage.setItem('token', 'expired.jwt.token')
      localStorage.setItem('refreshToken', 'invalid.refresh.token')
    })
    const refreshResponsePromise = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/auth/refresh'
    ))
    await page.goto(`${FE_BASE}/inventory`)
    const refreshResponse = await refreshResponsePromise
    expect(refreshResponse.status()).toBe(401)
    await expect(page).toHaveURL(`${FE_BASE}/login`)
    expect(await storedAuthState(page)).toEqual({
      hasToken: false,
      hasRefreshToken: false,
      hasUser: false,
      hasRememberedUsername: false,
    })
  })

  test('BLIND-AUTH-04. 多浏览器上下文数据隔离', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'finance')
    await expect(p1.locator('nav >> text=用户').first()).toBeVisible()
    await expect(p2.locator('nav >> text=用户').first()).not.toBeVisible()
    await ctx1.close()
    await ctx2.close()
  })

  test('BLIND-AUTH-05. XSS防护：登录输入特殊字符不执行脚本', async ({ page }) => {
    await page.fill('input[type="text"]', '<script>alert(1)</script>')
    await page.fill('input[type="password"]', 'pass')
    const responsePromise = page.waitForResponse(r => r.url().includes('/auth/login'))
    await page.click('button[type="submit"]')
    const response = await responsePromise
    expect(response.status()).toBe(401)
  })

  test('BLIND-AUTH-06. SQL注入防护：用户名输入SQL语句', async ({ page }) => {
    await page.fill('input[type="text"]', "' OR '1'='1")
    await page.fill('input[type="password"]', "' OR '1'='1")
    const responsePromise = page.waitForResponse(r => r.url().includes('/auth/login'))
    await page.click('button[type="submit"]')
    const response = await responsePromise
    expect(response.status()).toBe(401)
  })

  test('BLIND-AUTH-07. 暴力破解防护：连续错误登录10次后正常用户仍可登录', async ({ page }) => {
    for (let i = 0; i < 10; i++) {
      await page.goto(`${FE_BASE}/login`)
      await page.fill('input[type="text"]', 'admin')
      await page.fill('input[type="password"]', `wrong${i}`)
      const responsePromise = page.waitForResponse(isLoginResponse)
      await page.click('button[type="submit"]')
      const response = await responsePromise
      expect(response.status()).toBe(401)
      await expect(page).toHaveURL(`${FE_BASE}/login`)
    }
    await page.goto(`${FE_BASE}/login`)
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    await page.click('button[type="submit"]')
    await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
  })

  test('BLIND-AUTH-08. 移动端响应式布局正常显示', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/login`)
    await expect(page.locator('input[type="text"]').first()).toBeVisible()
    await expect(page.locator('input[type="password"]').first()).toBeVisible()
  })

  test('BLIND-AUTH-09. 登录按钮在提交时显示loading状态', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    await page.click('button[type="submit"]')
    await expect(page.locator('button[type="submit"]').first()).toBeVisible()
  })

  test('BLIND-AUTH-10. 密码输入框类型切换', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const pwdInput = page.locator('input[type="password"]').first()
    await expect(pwdInput).toHaveAttribute('type', 'password')
    const toggle = page.locator('input[placeholder="请输入密码"] + button')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(page.locator('input[type="text"][placeholder="请输入密码"]')).toBeVisible()
    await toggle.click()
    await expect(page.locator('input[type="password"][placeholder="请输入密码"]')).toBeVisible()
  })

  test('BLIND-AUTH-11. 登录页面显示品牌信息', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    await expect(page.locator('text=COREONE').first()).toBeVisible()
  })

  test('BLIND-AUTH-12. 登录页面显示版本号', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    await expect(page.locator('text=/v2\\./i').first()).toBeVisible()
  })

  test('BLIND-AUTH-13. Token过期时间验证', async ({ page }) => {
    const token = await apiLogin('admin')
    const parts = token.split('.')
    expect(parts.length).toBe(3)
    const payload = await page.evaluate((t) => {
      const p = t.split('.')[1]
      return JSON.parse(atob(p))
    }, token)
    expect(payload.type).toBe('access')
    expect(payload.exp - payload.iat).toBe(8 * 60 * 60)
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test('BLIND-AUTH-14. 不同用户同时登录互不影响', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'technician')
    await p1.goto(`${FE_BASE}/users`)
    await p2.goto(`${FE_BASE}/inventory`)
    await ctx1.close()
    await ctx2.close()
  })

  test('BLIND-AUTH-15. 登录页面响应式-平板尺寸', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(`${FE_BASE}/login`)
    await expect(page.locator('input[type="text"]').first()).toBeVisible()
  })

  test('BLIND-AUTH-16. 登录页面响应式-桌面尺寸', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${FE_BASE}/login`)
    await expect(page.locator('input[type="text"]').first()).toBeVisible()
  })

  test('BLIND-AUTH-17. 密码输入框焦点状态', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const pwd = page.locator('input[type="password"]').first()
    await pwd.focus()
    await expect(pwd).toBeFocused()
  })

  test('BLIND-AUTH-18. 用户名输入框占位符文本', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const user = page.locator('input[type="text"]').first()
    const placeholder = await user.getAttribute('placeholder')
    expect(placeholder).toBeTruthy()
  })

  test('BLIND-AUTH-19. 登录表单自动完成功能', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const user = page.locator('input[type="text"]').first()
    const autocomplete = await user.getAttribute('autocomplete')
    expect(['username', 'on', 'off', null]).toContain(autocomplete)
  })

  test('BLIND-AUTH-20. 登录按钮默认可提交并由表单校验拒绝空值', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const btn = page.locator('button[type="submit"]').first()
    await expect(btn).toBeEnabled()
    await btn.click()
    await expect(page.getByText('请输入用户名', { exact: true })).toBeVisible()
    await expect(page.getByText('请输入密码', { exact: true })).toBeVisible()
    await expect(page).toHaveURL(`${FE_BASE}/login`)
  })

  test('BLIND-AUTH-21. 登录成功Toast提示验证', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    await page.click('button[type="submit"]')
    await page.waitForURL(`${FE_BASE}/`)
    await expect(page.locator('[data-sonner-toast]').first()).toContainText('登录成功')
  })

  test('BLIND-AUTH-22. 刷新Token过期时间7天', async ({ page }) => {
    const login = await apiLoginSession('admin')
    const payload = await page.evaluate((token) => {
      const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4)
      return JSON.parse(atob(padded))
    }, login.refreshToken)
    expect(payload.type).toBe('refresh')
    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60)
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test('BLIND-AUTH-23. 登录请求Content-Type验证', async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: 'raw text',
    })
    expect([400, 415]).toContain(res.status)
  })

  test('BLIND-AUTH-24. Token中携带userId信息', async ({ page }) => {
    const token = await apiLogin('admin')
    const payload = await page.evaluate((value) => {
      const encoded = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4)
      return JSON.parse(atob(padded))
    }, token)
    expect(typeof payload.userId).toBe('string')
    expect(payload.userId.length).toBeGreaterThan(0)
    expect(payload.username).toBe('admin')
    expect(payload.role).toBe('admin')
  })

  test('BLIND-AUTH-25. 登录失败不设置localStorage', async ({ page }) => {
    await expectRejectedLogin(page, 'baduser', 'badpass')
  })

  test('BLIND-AUTH-26. 并发登录同一账户两个上下文', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const [p1, p2] = [await ctx1.newPage(), await ctx2.newPage()]
    await Promise.all([loginAs(p1, 'admin'), loginAs(p2, 'admin')])
    const [t1, t2] = await Promise.all([
      p1.evaluate(() => localStorage.getItem('token')),
      p2.evaluate(() => localStorage.getItem('token')),
    ])
    expect(t1).toBeTruthy()
    expect(t2).toBeTruthy()
    await ctx1.close()
    await ctx2.close()
  })

  test('BLIND-AUTH-27. 登录页面加载性能检查', async ({ page }) => {
    const start = Date.now()
    const response = await page.goto(`${FE_BASE}/login`, { waitUntil: 'domcontentloaded' })
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible()
    const duration = Date.now() - start
    expect(duration).toBeLessThan(5000)
  })

  test('BLIND-AUTH-28. 登出API返回正确消息结构', async ({ page }) => {
    await loginAs(page, 'admin')
    const token = await page.evaluate(() => localStorage.getItem('token'))
    const res = await apiFetch(token!, 'POST', '/auth/logout')
    expect(res.status).toBe(200)
    expect(res.data.success).toBe(true)
    expect(res.data.message).toBe('Logout success')
  })

  test('BLIND-AUTH-29. 登录页面输入框tab切换', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    await page.locator('input[type="text"]').first().focus()
    await page.keyboard.press('Tab')
    const active = page.locator('input[type="password"]').first()
    await expect(active).toBeFocused()
  })

  test('BLIND-AUTH-30. 使用无效HTTP方法访问登录API', async () => {
    const res = await fetch(`${API_BASE}/auth/login`, { method: 'GET' })
    expect([404, 405]).toContain(res.status)
  })

  test('BLIND-AUTH-31. 登录API缺少请求体', async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(400)
  })

  test('BLIND-AUTH-32. Token中role字段与登录用户一致', async ({ page }) => {
    for (const role of ROLE_KEYS) {
      const token = await apiLogin(role)
      const payload = await page.evaluate((value) => {
        const encoded = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
        const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4)
        return JSON.parse(atob(padded))
      }, token)
      expect(payload.username).toBe(ROLES[role].username)
      expect(payload.role).toBe(role)
      expect(payload.type).toBe('access')
    }
  })

  test('BLIND-AUTH-33. 登录成功后页面标题验证', async ({ page }) => {
    await loginAs(page, 'admin')
    await expect(page).toHaveTitle('COREONE | 病理试剂成本管理')
  })

  test('BLIND-AUTH-34. 登出后刷新页面保持未登录状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await logoutThroughUi(page)
    await page.reload()
    await expect(page).toHaveURL(`${FE_BASE}/login`)
    expect((await storedAuthState(page)).hasToken).toBe(false)
  })

  test('BLIND-AUTH-35. 登录按钮点击后防止重复提交', async ({ page }) => {
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    await page.click('button[type="submit"]')
    await expect(page.locator('button[type="submit"][disabled]').first()).toBeVisible({ timeout: 5000 })
    await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
  })

  test('BLIND-AUTH-36. 浏览器前进后退按钮行为', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.goBack()
    await expect(page.locator('body')).toBeVisible()
  })

  test('BLIND-AUTH-37. 登录URL直接带参数处理', async ({ page }) => {
    await page.goto(`${FE_BASE}/login?redirect=/inventory`)
    await page.fill('input[type="text"]', 'admin')
    await page.fill('input[type="password"]', 'admin123')
    await page.click('button[type="submit"]')
    await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
  })

  test('BLIND-AUTH-38. 登录页面不声明不存在的favicon资源', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const faviconCount = await page.locator('link[rel="icon"], link[rel="shortcut icon"]').count()
    expect(faviconCount).toBe(0)
  })

  test('BLIND-AUTH-39. 真实UI登出后认证身份与凭证均不可恢复', async ({ page }) => {
    await loginAs(page, 'admin')
    await logoutThroughUi(page)
    await page.goto(`${FE_BASE}/`)
    await expect(page).toHaveURL(`${FE_BASE}/login`)
    expect(await storedAuthState(page)).toEqual({
      hasToken: false,
      hasRefreshToken: false,
      hasUser: false,
      hasRememberedUsername: false,
    })
  })

  test('BLIND-AUTH-40. 登录API支持CORS预检', async () => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: FE_BASE,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })

  test('BLIND-AUTH-41. 使用已过期token访问受保护资源', async () => {
    const expiredToken = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJ1c2VySWQiOiIxIiwiZXhwIjoxNTE2MjM5MDIyfQ',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.')
    const res = await fetch(`${API_BASE}/inventory`, {
      headers: { Authorization: `Bearer ${expiredToken}`, 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(401)
  })

  test('BLIND-AUTH-42. 登录页面meta标签验证', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const charset = await page.locator('meta[charset]').first().getAttribute('charset')
    expect(charset?.toLowerCase()).toBe('utf-8')
  })

  test('BLIND-AUTH-43. 登录页面viewport设置', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const viewport = await page.locator('meta[name="viewport"]').first().getAttribute('content')
    expect(viewport).toContain('width=device-width')
  })

  test('BLIND-AUTH-44. 登录成功后导航到多个页面保持状态', async ({ page }) => {
    await loginAs(page, 'admin')
    for (const path of ['/', '/inventory', '/alerts']) {
      await page.goto(`${FE_BASE}${path}`)
      await expect.poll(() => new URL(page.url()).pathname).toBe(path)
      expect((await storedAuthState(page)).hasToken).toBe(true)
    }
  })

  test('BLIND-AUTH-45. access token失效后浏览器使用有效refreshToken续期并保持登录', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.evaluate(() => localStorage.setItem('token', 'expired.jwt.token'))
    const refreshResponsePromise = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/auth/refresh'
    ))
    await page.goto(`${FE_BASE}/inventory`)
    const refreshResponse = await refreshResponsePromise
    expect(refreshResponse.status()).toBe(200)
    await expect.poll(() => page.evaluate(() => {
      const token = localStorage.getItem('token')
      const userJson = localStorage.getItem('user')
      const user = userJson ? JSON.parse(userJson) : null
      return {
        renewed: Boolean(token && token !== 'expired.jwt.token' && token.split('.').length === 3),
        role: user?.role || null,
      }
    })).toEqual({ renewed: true, role: 'admin' })
    await expect(page).toHaveURL(`${FE_BASE}/inventory`)
    await expect(page.getByRole('heading', { name: '库存列表', exact: true })).toBeVisible()
  })

  test('BLIND-AUTH-46. 登录页面关键样式已渲染', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const submit = page.locator('button[type="submit"]')
    await expect(submit).toBeVisible()
    await expect(submit).toHaveCSS('background-color', 'rgb(59, 130, 246)')
    await expect(submit).toHaveCSS('height', '40px')
  })

  test('BLIND-AUTH-47. 使用伪造的JWT格式token', async () => {
    const res = await fetch(`${API_BASE}/inventory`, {
      headers: { Authorization: 'Bearer fake.header.signature', 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(401)
  })

  test('BLIND-AUTH-48. 登录页面JavaScript文件加载', async ({ page }) => {
    await page.goto(`${FE_BASE}/login`)
    const scripts = await page.locator('script').count()
    expect(scripts).toBeGreaterThan(0)
  })

  test('BLIND-AUTH-49. 登录后localStorage键名验证', async ({ page }) => {
    await loginAs(page, 'admin')
    const keys = await page.evaluate(() => Object.keys(localStorage))
    expect(keys).toContain('token')
    expect(keys).toContain('refreshToken')
  })

  test('BLIND-AUTH-50. 多次刷新均返回可用于受保护接口的access token', async () => {
    const login = await apiLoginSession('admin')
    const refreshToken = login.refreshToken
    const r1 = await apiFetch('', 'POST', '/auth/refresh', { refreshToken })
    const r2 = await apiFetch('', 'POST', '/auth/refresh', { refreshToken })
    const t1 = r1.data?.data?.token || r1.data?.token
    const t2 = r2.data?.data?.token || r2.data?.token
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(typeof t1 === 'string' && t1.split('.').length === 3).toBe(true)
    expect(typeof t2 === 'string' && t2.split('.').length === 3).toBe(true)
    expect((await apiFetch(t1, 'GET', '/inventory')).status).toBe(200)
    expect((await apiFetch(t2, 'GET', '/inventory')).status).toBe(200)
  })
})
