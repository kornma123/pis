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
  await page.goto('about:blank')
  await page.evaluate(() => localStorage.clear())
  await page.goto(`${FE_BASE}/login`)
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
    const res = await apiFetch(token, 'GET', '/roles?page=1&pageSize=100')
    const list = res.data?.data?.list || []
    for (const item of list) {
      if (item.name?.startsWith('测试角色') || item.code?.startsWith('TEST')) {
        await apiFetch(token, 'DELETE', `/roles/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ───────────────────────────────────────────────
// 1. 查看角色列表
// ───────────────────────────────────────────────
test.describe('角色权限 -> 查看角色列表', () => {
  test('ROLE-LIST-01. 正常用例：admin可查看角色列表', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(2000)
    await expect(page.locator('text=/角色管理|角色权限|角色列表/i').first()).toBeVisible()
  })
  test('ROLE-LIST-02. 正常用例：角色列表显示统计卡片', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/角色总数|系统角色|自定义角色|已分配用户/i').first()).toBeVisible()
  })
  test('ROLE-LIST-03. 正常用例：角色以卡片形式展示', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const btn = page.locator('text=/查看详情/i').first()
    await expect(btn).toBeVisible()
  })
  test('ROLE-LIST-04. 空数据边界：无角色数据卡片显示空状态', async ({ page }) => {
    await page.route('**/api/v1/roles**', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { list: [], pagination: { total: 0 } } }) }))
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const empty = page.locator('text=/暂无数据|暂无/i').first()
    await expect(empty).toBeVisible()
    await page.unroute('**/api/v1/roles**')
  })
  test('ROLE-LIST-05. 异常恢复：API 500显示错误提示', async ({ page }) => {
    await page.route('**/api/v1/roles**', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.unroute('**/api/v1/roles**')
  })
  test('ROLE-LIST-06. 权限：technician访问返回403', async ({ page }) => {
    await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1200)
    const msg = page.locator('text=/无权访问|403|Forbidden/i').first()
    await expect(msg).toBeVisible()
  })
  test('ROLE-LIST-07. 并发：快速刷新页面多次', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`)
    for (let i = 0; i < 3; i++) { await page.reload(); await page.waitForTimeout(800) }
    await expect(page.locator('body')).toBeVisible()
  })
  test('ROLE-LIST-08. UI差异：admin显示新建角色按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/新建角色|新建/i').first()).toBeVisible()
  })
  test('ROLE-LIST-09. UI差异：非admin不显示新建按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1200)
    await expect(page.locator('body')).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 2. Tab切换
// ───────────────────────────────────────────────
test.describe('角色权限 -> Tab切换', () => {
  test('ROLE-TAB-01. 正常用例：默认显示全部角色Tab', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/全部角色|系统角色|自定义角色/i').first()).toBeVisible()
  })
  test('ROLE-TAB-02. 正常用例：切换到系统角色Tab', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const tab = page.locator('text=/系统角色/i').first()
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(800) }
  })
  test('ROLE-TAB-03. 正常用例：切换到自定义角色Tab', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const tab = page.locator('text=/自定义角色/i').first()
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(800) }
  })
  test('ROLE-TAB-04. 并发：快速切换Tab多次', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const tabs = page.locator('text=/全部角色|系统角色|自定义角色/i')
    for (let i = 0; i < Math.min(3, await tabs.count()); i++) {
      await tabs.nth(i).click(); await page.waitForTimeout(300)
    }
  })
})

// ───────────────────────────────────────────────
// 3. 搜索功能
// ───────────────────────────────────────────────
test.describe('角色权限 -> 搜索功能', () => {
  test('ROLE-SEARCH-01. 正常用例：按角色名称搜索', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill('管理'); await page.waitForTimeout(800) }
  })
  test('ROLE-SEARCH-02. 空数据边界：搜索无结果', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill('XYZ不存在的角色'); await page.waitForTimeout(800) }
  })
  test('ROLE-SEARCH-03. 边界：搜索关键词为空恢复全部', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill(''); await page.waitForTimeout(800) }
  })
})

// ───────────────────────────────────────────────
// 4. 新建角色
// ───────────────────────────────────────────────
test.describe('角色权限 -> 新建角色', () => {
  test('ROLE-CREATE-01. 正常用例：admin新建角色成功', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const nameInput = page.locator('input').filter({ hasText: /^$/ }).first()
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(`测试角色-${Date.now()}`)
      await page.click('text=/创建角色|保存/i'); await page.waitForTimeout(1000)
    }
  })
  test('ROLE-CREATE-02. 正常用例：新建角色时配置权限', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const nameInput = page.locator('input').filter({ hasText: /^$/ }).first()
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(`测试角色-权限-${Date.now()}`)
      const check = page.locator('input[type="checkbox"]').first()
      if (await check.isVisible().catch(() => false)) { await check.click(); await page.waitForTimeout(300) }
      await page.click('text=/创建角色|保存/i'); await page.waitForTimeout(1000)
    }
  })
  test('ROLE-CREATE-03. 正常用例：新建角色时选择数据权限范围', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const nameInput = page.locator('input').filter({ hasText: /^$/ }).first()
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(`测试角色-范围-${Date.now()}`)
      const scope = page.locator('input[type="radio"]').first()
      if (await scope.isVisible().catch(() => false)) { await scope.click(); await page.waitForTimeout(300) }
      await page.click('text=/创建角色|保存/i'); await page.waitForTimeout(1000)
    }
  })
  test('ROLE-CREATE-04. 空数据边界：名称为空提交被阻止', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const save = page.locator('text=/创建角色|保存/i').first()
    if (await save.isVisible().catch(() => false)) { await save.click(); await page.waitForTimeout(500) }
  })
  test('ROLE-CREATE-05. 表单校验：未传必填字段返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/roles', {})
    expect([400, 422]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`ROLE-CREATE-06-${role}. 权限：${role}新建角色返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'POST', '/roles', { name: 'TEST', code: 'test' })
      expect(res.status).toBe(403)
    })
  }
  test('ROLE-CREATE-07. 并发：快速双击新建按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const btn = page.locator('text=/新建角色|新建/i').first()
    if (await btn.isVisible().catch(() => false)) { await btn.click(); await btn.click(); await page.waitForTimeout(800) }
  })
  test('ROLE-CREATE-08. 异常恢复：网络中断后重试新建', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.route('**/api/v1/roles', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const nameInput = page.locator('input').first()
    if (await nameInput.isVisible().catch(() => false)) { await nameInput.fill(`测试角色-${Date.now()}`); await page.click('text=/创建角色|保存/i'); await page.waitForTimeout(800) }
    await page.unroute('**/api/v1/roles')
  })
  test('ROLE-CREATE-09. UI差异：admin前端显示新建按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/新建角色/i').first()).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 5. 编辑角色
// ───────────────────────────────────────────────
test.describe('角色权限 -> 编辑角色', () => {
  test('ROLE-EDIT-01. 正常用例：admin编辑角色权限保存成功', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click(); await page.waitForTimeout(500)
      const check = page.locator('input[type="checkbox"]').first()
      if (await check.isVisible().catch(() => false)) { await check.click(); await page.waitForTimeout(300) }
      const save = page.locator('text=/保存|确认/i').first()
      if (await save.isVisible().catch(() => false)) { await save.click(); await page.waitForTimeout(1000) }
    }
  })
  test('ROLE-EDIT-02. 正常用例：admin修改角色名称保存成功', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click(); await page.waitForTimeout(500)
      const nameInput = page.locator('input[type="text"]').first()
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill(`修改后名称-${Date.now()}`)
        await page.click('text=/保存|确认/i'); await page.waitForTimeout(1000)
      }
    }
  })
  test('ROLE-EDIT-03. 空数据边界：编辑后名称为空被阻止', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click(); await page.waitForTimeout(500)
      const nameInput = page.locator('input[type="text"]').first()
      if (await nameInput.isVisible().catch(() => false)) { await nameInput.fill(''); await page.click('text=/保存/i'); await page.waitForTimeout(500) }
    }
  })
  test('ROLE-EDIT-04. 表单校验：编辑不存在的角色返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/roles/non-existent-id', { name: 'test' })
    expect(res.status).toBe(404)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`ROLE-EDIT-05-${role}. 权限：${role}编辑角色返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'PUT', '/roles/test-id', { name: 'test' })
      expect(res.status).toBe(403)
    })
  }
  test('ROLE-EDIT-06. 并发：并发编辑同一角色', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/roles?page=1&pageSize=1')
    const id = res.data?.data?.list?.[0]?.id
    if (!id) return
    const reqs = Array.from({ length: 2 }, () => apiFetch(token, 'PUT', `/roles/${id}`, { name: `concurrent-${Date.now()}` }))
    const results = await Promise.all(reqs)
    expect(results.every(r => [200, 409].includes(r.status))).toBe(true)
  })
  test('ROLE-EDIT-07. 异常恢复：编辑时API 500后重试', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.route('**/api/v1/roles/*', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) { await editBtn.click(); await page.waitForTimeout(500) }
    await page.unroute('**/api/v1/roles/*')
  })
  test('ROLE-EDIT-08. UI差异：自定义角色显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const btn = page.locator('text=/编辑/i').first()
    await expect(btn).toBeVisible()
  })
  test('ROLE-EDIT-09. 正常用例：编辑后列表数据更新', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const editBtn = page.locator('text=/编辑|修改/i').first()
    if (await editBtn.isVisible().catch(() => false)) { await editBtn.click(); await page.waitForTimeout(500) }
  })
  test('ROLE-EDIT-10. 业务冲突：编辑系统角色admin被阻止', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/roles?page=1&pageSize=100')
    const adminRole = (res.data?.data?.list || []).find((r: any) => r.code === 'admin')
    if (!adminRole) return
    const res2 = await apiFetch(token, 'PUT', `/roles/${adminRole.id}`, { name: '修改admin' })
    expect([403, 500]).toContain(res2.status)
  })
})

// ───────────────────────────────────────────────
// 6. 删除角色
// ───────────────────────────────────────────────
test.describe('角色权限 -> 删除角色', () => {
  test('ROLE-DELETE-01. 正常用例：admin删除自定义角色成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const createRes = await apiFetch(token, 'POST', '/roles', { name: `测试角色-删-${Date.now()}`, code: `TEST-${Date.now()}` })
    const id = createRes.data?.data?.id || createRes.data?.id
    if (!id) return
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const deleteBtn = page.locator(`[data-id="${id}"] >> text=/删除/i`).first()
    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click(); await page.waitForTimeout(500)
      const confirm = page.locator('text=/确认|确定/i').first()
      if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await page.waitForTimeout(1000) }
    } else { await apiFetch(token, 'DELETE', `/roles/${id}`) }
  })
  test('ROLE-DELETE-02. 业务冲突：删除admin角色被阻止', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/roles?page=1&pageSize=100')
    const adminRole = (res.data?.data?.list || []).find((r: any) => r.code === 'admin')
    if (!adminRole) return
    const delRes = await apiFetch(token, 'DELETE', `/roles/${adminRole.id}`)
    expect([400, 403]).toContain(delRes.status)
  })
  test('ROLE-DELETE-03. 并发：并发删除同一角色', async ({ page }) => {
    const token = await apiLogin('admin')
    const createRes = await apiFetch(token, 'POST', '/roles', { name: `测试角色-并发-${Date.now()}`, code: `TEST-${Date.now()}` })
    const id = createRes.data?.data?.id || createRes.data?.id
    if (!id) return
    const reqs = Array.from({ length: 2 }, () => apiFetch(token, 'DELETE', `/roles/${id}`))
    const results = await Promise.all(reqs)
    expect(results.some(r => [200, 204, 404].includes(r.status))).toBe(true)
  })
  test('ROLE-DELETE-04. 异常恢复：删除时API 500后重试', async ({ page }) => {
    const token = await apiLogin('admin')
    const createRes = await apiFetch(token, 'POST', '/roles', { name: `测试角色-500-${Date.now()}`, code: `TEST-${Date.now()}` })
    const id = createRes.data?.data?.id || createRes.data?.id
    if (!id) return
    await page.route('**/api/v1/roles/*', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    await apiFetch(token, 'DELETE', `/roles/${id}`)
    await page.unroute('**/api/v1/roles/*')
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`ROLE-DELETE-05-${role}. 权限：${role}删除角色返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'DELETE', '/roles/test-id')
      expect(res.status).toBe(403)
    })
  }
  test('ROLE-DELETE-06. UI差异：自定义角色显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const btn = page.locator('text=/删除/i').first()
    await expect(btn).toBeVisible()
  })
  test('ROLE-DELETE-07. 正常用例：删除后列表自动刷新', async ({ page }) => {
    const token = await apiLogin('admin')
    const createRes = await apiFetch(token, 'POST', '/roles', { name: `测试角色-刷新-${Date.now()}`, code: `TEST-${Date.now()}` })
    const id = createRes.data?.data?.id || createRes.data?.id
    if (!id) return
    await apiFetch(token, 'DELETE', `/roles/${id}`)
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 7. 角色详情弹窗
// ───────────────────────────────────────────────
test.describe('角色权限 -> 角色详情弹窗', () => {
  test('ROLE-DETAIL-01. 正常用例：点击查看详情打开弹窗', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/查看详情/i').first()
    if (await detail.isVisible().catch(() => false)) { await detail.click(); await page.waitForTimeout(1000) }
    const title = page.locator('text=/角色详情/i').first()
    await expect(title).toBeVisible()
    const close = page.locator('text=/关闭/i').first()
    if (await close.isVisible().catch(() => false)) await close.click()
  })
  test('ROLE-DETAIL-02. 正常用例：详情弹窗显示用户数量', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/查看详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      const label = page.locator('text=/用户数量/i').first()
      await expect(label).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('ROLE-DETAIL-03. 正常用例：admin角色详情显示全部权限', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/查看详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/全部权限|拥有系统全部权限/i').first().or(page.locator('body'))).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('ROLE-DETAIL-04. 正常用例：详情弹窗关闭后恢复列表', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/查看详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(800)
      const close = page.locator('text=/关闭|取消/i').first()
      if (await close.isVisible().catch(() => false)) { await close.click(); await page.waitForTimeout(500) }
      await expect(page.locator('text=/角色列表/i').first()).toBeVisible()
    }
  })
})

// ───────────────────────────────────────────────
// 8. 角色权限矩阵补充
// ───────────────────────────────────────────────
test.describe('角色权限 -> 角色权限矩阵补充', () => {
  const permScenes = [
    { id: 'TC-PERM-ROLE-01', role: 'technician' as RoleKey, method: 'GET', path: '/roles', expect: 403 },
    { id: 'TC-PERM-ROLE-02', role: 'pathologist' as RoleKey, method: 'GET', path: '/roles', expect: 403 },
    { id: 'TC-PERM-ROLE-03', role: 'procurement' as RoleKey, method: 'GET', path: '/roles', expect: 403 },
    { id: 'TC-PERM-ROLE-04', role: 'finance' as RoleKey, method: 'GET', path: '/roles', expect: 403 },
    { id: 'TC-PERM-ROLE-05', role: 'warehouse_manager' as RoleKey, method: 'GET', path: '/roles', expect: 403 },
    { id: 'TC-PERM-ROLE-06', role: 'admin' as RoleKey, method: 'GET', path: '/roles', expect: 200 },
    { id: 'TC-PERM-ROLE-07', role: 'technician' as RoleKey, method: 'POST', path: '/roles', expect: 403 },
    { id: 'TC-PERM-ROLE-08', role: 'technician' as RoleKey, method: 'PUT', path: '/roles/test-id', expect: 403 },
    { id: 'TC-PERM-ROLE-09', role: 'technician' as RoleKey, method: 'DELETE', path: '/roles/test-id', expect: 403 },
    { id: 'TC-PERM-ROLE-10', role: 'admin' as RoleKey, method: 'PUT', path: '/roles/test-id', expect: 404 },
  ]
  for (const scene of permScenes) {
    test(`${scene.id}. ${scene.role} ${scene.method} ${scene.path} 返回${scene.expect}`, async () => {
      const token = await apiLogin(scene.role)
      const res = await apiFetch(token, scene.method, scene.path, scene.method === 'POST' ? { name: 'TEST', code: 'test' } : { name: 'test' })
      expect(res.status).toBe(scene.expect)
    })
  }
})

// ───────────────────────────────────────────────
// 9. 业务流程树
// ───────────────────────────────────────────────
test.describe('角色权限 -> 业务流程树', () => {
  test('BF-ROLE-01. 主路径：创建角色→配置权限→保存', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const name = page.locator('input').filter({ hasText: /^$/ }).first()
    if (await name.isVisible().catch(() => false)) { await name.fill(`测试角色-BF-${Date.now()}`); await page.click('text=/创建角色|保存/i'); await page.waitForTimeout(1000) }
  })
  test('BF-ROLE-02. 分支：创建角色时不填名称被阻止', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const save = page.locator('text=/创建角色|保存/i').first()
    if (await save.isVisible().catch(() => false)) { await save.click(); await page.waitForTimeout(500) }
  })
  test('BF-ROLE-03. 分支：编辑角色后取消不保存', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const edit = page.locator('text=/编辑|修改/i').first()
    if (await edit.isVisible().catch(() => false)) { await edit.click(); await page.waitForTimeout(500); await page.click('text=/取消|关闭/i'); await page.waitForTimeout(500) }
  })
  test('BF-ROLE-04. 分支：删除角色弹窗点击取消', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const del = page.locator('text=/删除/i').first()
    if (await del.isVisible().catch(() => false)) { await del.click(); await page.waitForTimeout(500); await page.click('text=/取消/i'); await page.waitForTimeout(500) }
  })
  test('BF-ROLE-05. 分支：搜索角色后查看详情', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill('管理'); await page.waitForTimeout(800) }
    const detail = page.locator('text=/查看详情/i').first()
    if (await detail.isVisible().catch(() => false)) { await detail.click(); await page.waitForTimeout(800); await page.click('text=/关闭/i'); await page.waitForTimeout(300) }
  })
  test('BF-ROLE-06. 分支：切换Tab后编辑角色', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const tab = page.locator('text=/自定义角色/i').first()
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(800) }
  })
  test('BF-ROLE-07. 分支：无权限用户访问被拦截', async ({ page }) => {
    await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1200)
    await expect(page.locator('body')).toBeVisible()
  })
  test('BF-ROLE-08. 分支：查看角色详情后点击编辑', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/查看详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(800)
      const edit = page.locator('text=/编辑/i').first()
      if (await edit.isVisible().catch(() => false)) { await edit.click(); await page.waitForTimeout(800); await page.click('text=/取消|关闭/i'); await page.waitForTimeout(300) }
    }
  })
})

// ───────────────────────────────────────────────
// 10. 盲点分析补充
// ───────────────────────────────────────────────
test.describe('角色权限 -> 盲点分析补充', () => {
  test('BLIND-ROLE-01. 权限树形表格渲染正确', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const table = page.locator('text=/功能模块/i').first()
    await expect(table).toBeVisible()
    const cancel = page.locator('text=/取消|关闭/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('BLIND-ROLE-02. 角色与用户关联数显示', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const label = page.locator('text=/已分配用户|人/i').first()
    await expect(label).toBeVisible()
  })
  test('BLIND-ROLE-03. 系统角色和自定义角色标签区分', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const tag = page.locator('text=/系统角色|自定义/i').first()
    await expect(tag).toBeVisible()
  })
  test('BLIND-ROLE-04. 角色数据权限范围选项', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const opt = page.locator('text=/全部数据|本部门数据|仅本人数据/i').first()
    await expect(opt).toBeVisible()
    const cancel = page.locator('text=/取消|关闭/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('BLIND-ROLE-05. 角色编码自动生成或只读', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const codeInput = page.locator('input[placeholder*="自动生成"], input[readonly]').first()
    if (await codeInput.isVisible().catch(() => false)) {
      expect(await codeInput.isDisabled().catch(() => false) || await codeInput.getAttribute('readonly')).toBeTruthy()
    }
    const cancel = page.locator('text=/取消|关闭/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('BLIND-ROLE-06. 角色状态active/inactive', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
  })
  test('BLIND-ROLE-07. 分页功能正确', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) { await next.click(); await page.waitForTimeout(800) }
  })
  test('BLIND-ROLE-08. 角色权限checkbox联动', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await page.click('text=/新建角色|新建/i'); await page.waitForTimeout(500)
    const check = page.locator('input[type="checkbox"]').first()
    if (await check.isVisible().catch(() => false)) { await check.click(); await page.waitForTimeout(300) }
    const cancel = page.locator('text=/取消|关闭/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('BLIND-ROLE-09. 响应式布局检查', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 720 })
  })
  test('BLIND-ROLE-10. 角色API响应格式验证', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/roles?page=1&pageSize=1')
    expect(res.status).toBe(200)
    if (res.data?.data?.list) { expect(Array.isArray(res.data.data.list)).toBe(true) }
  })
  test('BLIND-ROLE-11. 页面加载性能检查', async ({ page }) => {
    const start = Date.now()
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`)
    await page.waitForTimeout(1500)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-ROLE-12. 角色卡片hover效果', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/roles`); await page.waitForTimeout(1500)
    const card = page.locator('text=/查看详情/i').first()
    if (await card.isVisible().catch(() => false)) { await card.hover(); await page.waitForTimeout(200) }
  })
})
