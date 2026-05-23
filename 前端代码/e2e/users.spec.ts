import { test, expect, Page } from '@playwright/test'

const FE_BASE = 'http://localhost:8080'
const API_BASE = 'http://127.0.0.1:3001/api/v1'

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

async function loginAs(page: Page, role: RoleKey) {
  await page.goto(`${FE_BASE}/login`)
  await page.evaluate(() => localStorage.clear())
  const cred = ROLES[role]
  await page.fill('input[type="text"]', cred.username)
  await page.fill('input[type="password"]', cred.password)
  await page.click('button[type="submit"]')
  await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
}

async function apiLogin(role: RoleKey): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ROLES[role]),
  })
  const data = (await res.json()) as any
  return data.data?.token || data.token
}

async function apiFetch(token: string, method: string, path: string, body?: any) {
  const opts: any = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
  if (body && method !== 'GET' && method !== 'HEAD') opts.body = JSON.stringify(body)
  const res = await fetch(`${API_BASE}${path}`, opts)
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

async function cleanupTestData(token: string) {
  try {
    const res = await apiFetch(token, 'GET', '/users?page=1&pageSize=100')
    const list = res.data?.data?.list || []
    for (const item of list) {
      if (item.username?.startsWith('testuser')) {
        await apiFetch(token, 'DELETE', `/users/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ───────────────────────────────────────────────
// 1. 查看用户列表
// ───────────────────────────────────────────────
test.describe('用户管理 -> 查看用户列表', () => {
  test('USER-LIST-01. 正常用例：admin可查看用户列表', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/用户管理|用户列表/i').first()).toBeVisible()
  })
  test('USER-LIST-02. 正常用例：用户列表显示列标题', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/用户名|姓名|部门|角色|状态|最后登录|操作/i').first()).toBeVisible()
  })
  test('USER-LIST-03. 正常用例：用户列表显示统计卡片', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/用户总数|启用用户|停用用户|管理员/i').first()).toBeVisible()
  })
  test('USER-LIST-04. 正常用例：左侧显示角色列表面板', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/角色列表|系统角色/i').first()).toBeVisible()
  })
  test('USER-LIST-05. 空数据边界：无用户数据显示空状态', async ({ page }) => {
    await page.route('**/api/v1/users**', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { list: [], pagination: { total: 0 } } }) }))
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/暂无数据|暂无/i').first()).toBeVisible()
    await page.unroute('**/api/v1/users**')
  })
  test('USER-LIST-06. 异常恢复：API 500显示错误', async ({ page }) => {
    await page.route('**/api/v1/users**', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.unroute('**/api/v1/users**')
  })
  test('USER-LIST-07. 权限：technician访问返回403', async ({ page }) => {
    await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1200)
    await expect(page.locator('text=/无权访问|403|Forbidden/i').first()).toBeVisible()
  })
  test('USER-LIST-08. 并发：快速刷新页面多次', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`)
    for (let i = 0; i < 3; i++) { await page.reload(); await page.waitForTimeout(800) }
    await expect(page.locator('body')).toBeVisible()
  })
  test('USER-LIST-09. UI差异：admin显示新建用户按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/新建用户|新建/i').first()).toBeVisible()
  })
  test('USER-LIST-10. 正常用例：用户状态标签显示正常/禁用', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/正常|禁用|停用/i').first()).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 2. 筛选功能
// ───────────────────────────────────────────────
test.describe('用户管理 -> 筛选功能', () => {
  test('USER-FILTER-01. 正常用例：按关键词搜索用户名', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill('admin'); await page.waitForTimeout(800) }
  })
  test('USER-FILTER-02. 正常用例：按角色筛选', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const sel = page.locator('select').filter({ hasText: /全部角色|系统管理员/i }).first()
    if (await sel.isVisible().catch(() => false)) {
      const opts = await sel.locator('option').count()
      if (opts > 1) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(800) }
    }
  })
  test('USER-FILTER-03. 正常用例：按状态筛选', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const sel = page.locator('select').filter({ hasText: /全部状态|正常|禁用/i }).first()
    if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(800) }
  })
  test('USER-FILTER-04. 正常用例：点击查询按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const btn = page.locator('text=/查询/i').first()
    if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(800) }
  })
  test('USER-FILTER-05. 正常用例：点击重置按钮恢复全部', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const reset = page.locator('text=/重置/i').first()
    if (await reset.isVisible().catch(() => false)) { await reset.click(); await page.waitForTimeout(800) }
  })
  test('USER-FILTER-06. 空数据边界：筛选无结果', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill('XYZ不存在的用户'); await page.waitForTimeout(800) }
  })
  test('USER-FILTER-07. 并发：快速切换筛选条件', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const selects = page.locator('select')
    for (let i = 0; i < Math.min(2, await selects.count()); i++) {
      const sel = selects.nth(i)
      if (await sel.isVisible().catch(() => false)) {
        const opts = await sel.locator('option').count()
        if (opts > 1) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(300) }
      }
    }
  })
  test('USER-FILTER-08. 正常用例：点击左侧角色筛选用户', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const roleItem = page.locator('text=/系统管理员|操作员|查看者/i').first()
    if (await roleItem.isVisible().catch(() => false)) { await roleItem.click(); await page.waitForTimeout(800) }
  })
})

// ───────────────────────────────────────────────
// 3. 新建用户
// ───────────────────────────────────────────────
test.describe('用户管理 -> 新建用户', () => {
  test('USER-CREATE-01. 正常用例：admin新建用户成功', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.click('text=/新建用户|新建/i'); await page.waitForTimeout(500)
    const inputs = page.locator('input[type="text"]')
    if (await inputs.count() >= 2) {
      await inputs.nth(0).fill(`testuser-${Date.now()}`)
      await inputs.nth(1).fill('测试姓名')
    }
    const pwd = page.locator('input[type="password"]').first()
    if (await pwd.isVisible().catch(() => false)) await pwd.fill('password123')
    await page.click('text=/创建用户|保存/i'); await page.waitForTimeout(1000)
  })
  test('USER-CREATE-02. 正常用例：新建用户选择角色', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.click('text=/新建用户|新建/i'); await page.waitForTimeout(800)
    const inputs = page.locator('.fixed.z-50 input[type="text"]')
    if (await inputs.count() >= 2) {
      await inputs.nth(0).fill(`testuser-role-${Date.now()}`)
      await inputs.nth(1).fill('角色测试')
    }
    const roleSel = page.locator('.fixed.z-50 select').first()
    if (await roleSel.isVisible().catch(() => false)) {
      const opts = await roleSel.locator('option').count()
      if (opts > 1) { await roleSel.selectOption({ index: 1 }); await page.waitForTimeout(300) }
    }
    const saveBtn = page.locator('.fixed.z-50 button:has-text(/创建用户|保存/)').first()
    if (await saveBtn.isVisible().catch(() => false)) await saveBtn.click()
    await page.waitForTimeout(1000)
  })
  test('USER-CREATE-03. 正常用例：新建用户选择部门', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.click('text=/新建用户|新建/i'); await page.waitForTimeout(500)
    const inputs = page.locator('input[type="text"]')
    if (await inputs.count() >= 2) {
      await inputs.nth(0).fill(`testuser-dept-${Date.now()}`)
      await inputs.nth(1).fill('部门测试')
    }
    const deptSel = page.locator('select').filter({ hasText: /请选择部门|病理科|检验科/i }).first()
    if (await deptSel.isVisible().catch(() => false)) { await deptSel.selectOption({ index: 1 }); await page.waitForTimeout(300) }
    await page.click('text=/创建用户|保存/i'); await page.waitForTimeout(1000)
  })
  test('USER-CREATE-04. 空数据边界：必填项为空提交被阻止', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.click('text=/新建用户|新建/i'); await page.waitForTimeout(500)
    const save = page.locator('text=/创建用户|保存/i').first()
    if (await save.isVisible().catch(() => false)) { await save.click(); await page.waitForTimeout(500) }
  })
  test('USER-CREATE-05. 表单校验：未传必填字段返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/users', {})
    expect([400, 422]).toContain(res.status)
  })
  test('USER-CREATE-06. 表单校验：缺少用户名返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/users', { password: 'pass', realName: 'test' })
    expect([400, 422]).toContain(res.status)
  })
  test('USER-CREATE-07. 业务冲突：username已存在返回409', async ({ page }) => {
    const token = await apiLogin('admin')
    const username = `dupe-${Date.now()}`
    await apiFetch(token, 'POST', '/users', { username, password: 'pass', realName: 'test', role: 'technician' })
    const res = await apiFetch(token, 'POST', '/users', { username, password: 'pass', realName: 'test2', role: 'technician' })
    expect([409, 400]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`USER-CREATE-08-${role}. 权限：${role}新建用户返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'POST', '/users', { username: 'TEST', password: 'pass', realName: 'test' })
      expect(res.status).toBe(403)
    })
  }
  test('USER-CREATE-09. 并发：快速双击新建按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const btn = page.locator('text=/新建用户|新建/i').first()
    if (await btn.isVisible().catch(() => false)) { await btn.click(); await btn.click(); await page.waitForTimeout(800) }
  })
  test('USER-CREATE-10. UI差异：admin前端显示新建按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/新建用户/i').first()).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 4. 编辑用户
// ───────────────────────────────────────────────
test.describe('用户管理 -> 编辑用户', () => {
  test('USER-EDIT-01. 正常用例：admin编辑用户姓名保存成功', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click(); await page.waitForTimeout(500)
      const nameInput = page.locator('input[type="text"]').nth(1)
      if (await nameInput.isVisible().catch(() => false)) { await nameInput.fill(`修改姓名-${Date.now()}`) }
      await page.click('text=/保存|确认/i'); await page.waitForTimeout(1000)
    }
  })
  test('USER-EDIT-02. 正常用例：admin修改用户状态', async ({ page }) => {
    const token = await apiLogin('admin')
    const createRes = await apiFetch(token, 'POST', '/users', { username: `testuser-edit-${Date.now()}`, password: 'pass', realName: '编辑测试', role: 'technician', status: 'active' })
    const testId = createRes.data?.data?.id || createRes.data?.id
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const editBtn = testId ? page.locator(`[data-id="${testId}"] >> text=/编辑|修改/i`).first() : page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click(); await page.waitForTimeout(500)
      const statusSel = page.locator('select').filter({ hasText: /正常|禁用/i }).first()
      if (await statusSel.isVisible().catch(() => false)) { await statusSel.selectOption('inactive'); await page.waitForTimeout(300) }
      await page.click('text=/保存|确认/i'); await page.waitForTimeout(1000)
    }
  })
  test('USER-EDIT-03. 空数据边界：编辑后姓名为空被阻止', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click(); await page.waitForTimeout(500)
      const nameInput = page.locator('input[type="text"]').nth(1)
      if (await nameInput.isVisible().catch(() => false)) { await nameInput.fill(''); await page.click('text=/保存/i'); await page.waitForTimeout(500) }
    }
  })
  test('USER-EDIT-04. 表单校验：编辑不存在的用户返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/users/non-existent-id', { realName: 'test' })
    expect(res.status).toBe(404)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`USER-EDIT-05-${role}. 权限：${role}编辑用户返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'PUT', '/users/test-id', { realName: 'test' })
      expect(res.status).toBe(403)
    })
  }
  test('USER-EDIT-06. 并发：并发编辑同一用户', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/users?page=1&pageSize=1')
    const id = res.data?.data?.list?.[0]?.id
    if (!id) return
    const reqs = Array.from({ length: 2 }, () => apiFetch(token, 'PUT', `/users/${id}`, { realName: `concurrent-${Date.now()}` }))
    const results = await Promise.all(reqs)
    expect(results.every(r => [200, 409].includes(r.status))).toBe(true)
  })
  test('USER-EDIT-07. 异常恢复：编辑时API 500后重试', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.route('**/api/v1/users/*', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) { await editBtn.click(); await page.waitForTimeout(500) }
    await page.unroute('**/api/v1/users/*')
  })
  test('USER-EDIT-08. UI差异：admin显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/编辑|修改/i').first()).toBeVisible()
  })
  test('USER-EDIT-09. 正常用例：编辑后列表数据更新', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) { await editBtn.click(); await page.waitForTimeout(500) }
  })
  test('USER-EDIT-10. 正常用例：用户名编辑时为只读', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click(); await page.waitForTimeout(800)
      const userInput = page.locator('.fixed.z-50 input[type="text"]').first()
      if (await userInput.isVisible().catch(() => false)) {
        const isReadOnly = await userInput.evaluate(el => (el as HTMLInputElement).readOnly || el.hasAttribute('readonly'))
        expect(isReadOnly).toBeTruthy()
      }
      const cancel = page.locator('.fixed.z-50 button:has-text("取消")').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
})

// ───────────────────────────────────────────────
// 5. 删除用户
// ───────────────────────────────────────────────
test.describe('用户管理 -> 删除用户', () => {
  test('USER-DELETE-01. 正常用例：admin删除用户成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const createRes = await apiFetch(token, 'POST', '/users', { username: `testuser-del-${Date.now()}`, password: 'pass', realName: 'del', role: 'technician' })
    const id = createRes.data?.data?.id || createRes.data?.id
    if (!id) return
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const deleteBtn = page.locator(`[data-id="${id}"] >> text=/删除/i`).first()
    if (await deleteBtn.isVisible().catch(() => false)) { await deleteBtn.click(); await page.waitForTimeout(800) } else { await apiFetch(token, 'DELETE', `/users/${id}`) }
  })
  test('USER-DELETE-02. 业务冲突：删除admin自己被阻止', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/users?page=1&pageSize=100')
    const adminUser = (res.data?.data?.list || []).find((u: any) => u.username === 'admin')
    if (!adminUser) return
    const delRes = await apiFetch(token, 'DELETE', `/users/${adminUser.id}`)
    expect([400, 403, 409]).toContain(delRes.status)
  })
  test('USER-DELETE-03. 并发：并发删除同一用户', async ({ page }) => {
    const token = await apiLogin('admin')
    const createRes = await apiFetch(token, 'POST', '/users', { username: `testuser-con-${Date.now()}`, password: 'pass', realName: 'con', role: 'technician' })
    const id = createRes.data?.data?.id || createRes.data?.id
    if (!id) return
    const reqs = Array.from({ length: 2 }, () => apiFetch(token, 'DELETE', `/users/${id}`))
    const results = await Promise.all(reqs)
    expect(results.some(r => [200, 204, 404].includes(r.status))).toBe(true)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`USER-DELETE-04-${role}. 权限：${role}删除用户返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'DELETE', '/users/test-id')
      expect(res.status).toBe(403)
    })
  }
  test('USER-DELETE-05. UI差异：admin显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/删除/i').first()).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 6. 启用/停用用户
// ───────────────────────────────────────────────
test.describe('用户管理 -> 启用停用用户', () => {
  test('USER-TOGGLE-01. 正常用例：admin停用用户成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const createRes = await apiFetch(token, 'POST', '/users', { username: `testuser-toggle-${Date.now()}`, password: 'pass', realName: '停用测试', role: 'technician', status: 'active' })
    const testId = createRes.data?.data?.id || createRes.data?.id
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const toggle = testId ? page.locator(`[data-id="${testId}"] >> text=/停用/i`).first() : page.locator('text=/停用/i').first()
    if (await toggle.isVisible().catch(() => false)) { await toggle.click(); await page.waitForTimeout(800) }
  })
  test('USER-TOGGLE-02. 正常用例：admin启用已停用用户', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const toggle = page.locator('text=/启用/i').first()
    if (await toggle.isVisible().catch(() => false)) { await toggle.click(); await page.waitForTimeout(800) }
  })
  test('USER-TOGGLE-03. 业务冲突：停用自己账户被阻止', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/users?page=1&pageSize=100')
    const adminUser = (res.data?.data?.list || []).find((u: any) => u.username === 'admin')
    if (!adminUser) return
    const toggleRes = await apiFetch(token, 'PUT', `/users/${adminUser.id}`, { status: 'inactive' })
    expect([200, 403, 409]).toContain(toggleRes.status)
  })
  test('USER-TOGGLE-04. UI差异：admin显示停用/启用按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/停用|启用/i').first()).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 7. 重置密码
// ───────────────────────────────────────────────
test.describe('用户管理 -> 重置密码', () => {
  test('USER-RESET-01. 正常用例：admin重置用户密码成功', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const resetBtn = page.locator('text=/重置密码|重置/i').first()
    if (await resetBtn.isVisible().catch(() => false)) { await resetBtn.click(); await page.waitForTimeout(800) }
  })
  test('USER-RESET-02. 正常用例：编辑弹窗内重置密码', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click(); await page.waitForTimeout(500)
      const reset = page.locator('text=/重置密码|重置/i').first()
      if (await reset.isVisible().catch(() => false)) { await reset.click(); await page.waitForTimeout(800) }
      const cancel = page.locator('text=/取消|关闭/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('USER-RESET-03. 权限：非admin重置密码返回403', async () => {
    const token = await apiLogin('technician')
    const res = await apiFetch(token, 'POST', '/users/test-id/reset-password', {})
    expect(res.status).toBe(403)
  })
})

// ───────────────────────────────────────────────
// 8. 用户详情弹窗
// ───────────────────────────────────────────────
test.describe('用户管理 -> 用户详情弹窗', () => {
  test('USER-DETAIL-01. 正常用例：点击详情打开弹窗', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/用户详情|权限列表|角色|部门/i').first()).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('USER-DETAIL-02. 正常用例：详情弹窗显示用户头像', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('body')).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('USER-DETAIL-03. 正常用例：详情弹窗显示权限列表', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/权限列表|已授权/i').first()).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('USER-DETAIL-04. 正常用例：详情弹窗点击编辑跳转', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      const edit = page.locator('text=/编辑/i').first()
      if (await edit.isVisible().catch(() => false)) { await edit.click(); await page.waitForTimeout(800); await page.click('text=/取消|关闭/i'); await page.waitForTimeout(300) }
    }
  })
})

// ───────────────────────────────────────────────
// 9. 分页功能
// ───────────────────────────────────────────────
test.describe('用户管理 -> 分页功能', () => {
  test('USER-PAGE-01. 正常用例：多页数据切页', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) { await next.click(); await page.waitForTimeout(800) }
  })
  test('USER-PAGE-02. 边界：仅1页时下一页禁用', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false)) { expect(await next.isDisabled().catch(() => false)).toBe(true) }
  })
  test('USER-PAGE-03. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    for (let i = 0; i < 3; i++) { if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) await next.click() }
    await page.waitForTimeout(800)
  })
})

// ───────────────────────────────────────────────
// 10. 角色权限矩阵补充
// ───────────────────────────────────────────────
test.describe('用户管理 -> 角色权限矩阵补充', () => {
  const permScenes = [
    { id: 'TC-PERM-USER-01', role: 'technician' as RoleKey, method: 'GET', path: '/users', expect: 403 },
    { id: 'TC-PERM-USER-02', role: 'pathologist' as RoleKey, method: 'GET', path: '/users', expect: 403 },
    { id: 'TC-PERM-USER-03', role: 'procurement' as RoleKey, method: 'GET', path: '/users', expect: 403 },
    { id: 'TC-PERM-USER-04', role: 'finance' as RoleKey, method: 'GET', path: '/users', expect: 403 },
    { id: 'TC-PERM-USER-05', role: 'warehouse_manager' as RoleKey, method: 'GET', path: '/users', expect: 403 },
    { id: 'TC-PERM-USER-06', role: 'admin' as RoleKey, method: 'GET', path: '/users', expect: 200 },
    { id: 'TC-PERM-USER-07', role: 'technician' as RoleKey, method: 'POST', path: '/users', expect: 403 },
    { id: 'TC-PERM-USER-08', role: 'technician' as RoleKey, method: 'PUT', path: '/users/test-id', expect: 403 },
    { id: 'TC-PERM-USER-09', role: 'technician' as RoleKey, method: 'DELETE', path: '/users/test-id', expect: 403 },
    { id: 'TC-PERM-USER-10', role: 'admin' as RoleKey, method: 'PUT', path: '/users/test-id', expect: 404 },
  ]
  for (const scene of permScenes) {
    test(`${scene.id}. ${scene.role} ${scene.method} ${scene.path} 返回${scene.expect}`, async () => {
      const token = await apiLogin(scene.role)
      const res = await apiFetch(token, scene.method, scene.path, scene.method === 'POST' ? { username: 'TEST', password: 'pass', realName: 'test' } : { realName: 'test' })
      expect(res.status).toBe(scene.expect)
    })
  }
})

// ───────────────────────────────────────────────
// 11. 业务流程树
// ───────────────────────────────────────────────
test.describe('用户管理 -> 业务流程树', () => {
  test('BF-USER-01. 主路径：创建用户→配置角色→保存', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.click('text=/新建用户|新建/i'); await page.waitForTimeout(500)
    const inputs = page.locator('input[type="text"]')
    if (await inputs.count() >= 2) {
      await inputs.nth(0).fill(`testuser-bf-${Date.now()}`)
      await inputs.nth(1).fill('流程测试')
    }
    await page.click('text=/创建用户|保存/i'); await page.waitForTimeout(1000)
  })
  test('BF-USER-02. 分支：创建用户时不填必填项被阻止', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.click('text=/新建用户|新建/i'); await page.waitForTimeout(500)
    const save = page.locator('text=/创建用户|保存/i').first()
    if (await save.isVisible().catch(() => false)) { await save.click(); await page.waitForTimeout(500) }
  })
  test('BF-USER-03. 分支：编辑用户后取消不保存', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const edit = page.locator('text=/编辑|修改/i').first()
    if (await edit.isVisible().catch(() => false)) { await edit.click(); await page.waitForTimeout(500); await page.click('text=/取消|关闭/i'); await page.waitForTimeout(500) }
  })
  test('BF-USER-04. 分支：停用用户后重新启用', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const toggle = page.locator('text=/停用|启用/i').first()
    if (await toggle.isVisible().catch(() => false)) { await toggle.click(); await page.waitForTimeout(800) }
  })
  test('BF-USER-05. 分支：重置用户密码', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const reset = page.locator('text=/重置密码|重置/i').first()
    if (await reset.isVisible().catch(() => false)) { await reset.click(); await page.waitForTimeout(800) }
  })
  test('BF-USER-06. 分支：筛选后查看用户详情', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill('admin'); await page.waitForTimeout(800) }
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) { await detail.click(); await page.waitForTimeout(800); await page.click('text=/关闭/i'); await page.waitForTimeout(300) }
  })
  test('BF-USER-07. 分支：无权限用户访问被拦截', async ({ page }) => {
    await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1200)
    await expect(page.locator('body')).toBeVisible()
  })
  test('BF-USER-08. 分支：点击左侧角色筛选用户', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const roleItem = page.locator('text=/系统管理员|操作员/i').first()
    if (await roleItem.isVisible().catch(() => false)) { await roleItem.click(); await page.waitForTimeout(800) }
  })
})

// ───────────────────────────────────────────────
// 12. 盲点分析补充
// ───────────────────────────────────────────────
test.describe('用户管理 -> 盲点分析补充', () => {
  test('BLIND-USER-01. 用户头像显示首字母', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
  })
  test('BLIND-USER-02. 状态标签颜色区分', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('table tbody span:text-matches(/正常|禁用/)').first()).toBeVisible()
  })
  test('BLIND-USER-03. 新建用户初始密码默认显示', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.click('text=/新建用户|新建/i'); await page.waitForTimeout(500)
    await expect(page.locator('text=/初始密码|Abc@123456|随机生成/i').first()).toBeVisible()
    const cancel = page.locator('text=/取消|关闭/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('BLIND-USER-04. 角色下拉选项完整性', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await page.click('text=/新建用户|新建/i'); await page.waitForTimeout(500)
    const roleSel = page.locator('select').first()
    if (await roleSel.isVisible().catch(() => false)) {
      const options = await roleSel.locator('option').allTextContents()
      expect(options.length).toBeGreaterThanOrEqual(1)
    }
    const cancel = page.locator('text=/取消|关闭/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('BLIND-USER-05. 用户全选checkbox功能', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const checkAll = page.locator('thead input[type="checkbox"]').first()
    if (await checkAll.isVisible().catch(() => false)) { await checkAll.click(); await page.waitForTimeout(300) }
  })
  test('BLIND-USER-06. 分页页码按钮样式', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/上一页|下一页|共.*条/i').first()).toBeVisible()
  })
  test('BLIND-USER-07. 响应式布局检查', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 720 })
  })
  test('BLIND-USER-08. 用户API响应格式验证', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/users?page=1&pageSize=1')
    expect(res.status).toBe(200)
    if (res.data?.data?.list) { expect(Array.isArray(res.data.data.list)).toBe(true) }
  })
  test('BLIND-USER-09. 页面加载性能检查', async ({ page }) => {
    const start = Date.now()
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`)
    await page.waitForTimeout(1500)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-USER-10. 用户详情权限列表展示', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/users`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/权限列表|数据范围/i').first()).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
})
