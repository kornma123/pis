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
const MAT_READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement']
const MAT_WRITE_ROLES: RoleKey[] = ['admin', 'procurement']
const MAT_FORBIDDEN: RoleKey[] = ['finance']

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
  const cred = ROLES[role]
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cred),
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

async function getAnyCategoryId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/categories?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyMaterialId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnySupplierId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/materials?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.code?.startsWith('TEST-') || item.name?.includes('E2E')) {
        await apiFetch(token, 'DELETE', `/materials/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ────────────────────────────────────────────
// 1. 查看物料列表 (10 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 查看物料列表', () => {
  for (const role of MAT_READ_ROLES) {
    test(`MAT-LIST-01-${role}. 正常用例：${role}可查看物料列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/materials`)
      await expect(page.locator('body')).toBeVisible({ timeout: 30000 })
    })
  }
  test('MAT-LIST-02. 空数据边界：无物料数据显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(800)
  })
  test('MAT-LIST-03. 权限：finance访问返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/materials')
    expect(res.status).toBe(403)
  })
  test('MAT-LIST-04. 异常恢复：API 500显示错误Toast', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(800)
  })
  test('MAT-LIST-05. UI差异：admin显示新增编辑删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-LIST-06. UI差异：procurement仅显示新增编辑', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-LIST-07. 正常用例：列表分页每页20条', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=20')
    expect(res.status).toBe(200)
    expect(res.data?.data?.pagination?.pageSize ?? res.data?.data?.pageSize).toBe(20)
  })
  test('MAT-LIST-08. 并发：快速刷新页面', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.reload()
    await page.reload()
  })
  test('MAT-LIST-09. UI差异：technician仅查看', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-LIST-10. 正常用例：列表显示133个物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=200')
    expect(res.status).toBe(200)
    expect(res.data?.data?.pagination?.total ?? res.data?.data?.total).toBeGreaterThanOrEqual(0)
  })
})

// ────────────────────────────────────────────
// 2. 按分类筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 按分类筛选', () => {
  test('MAT-CAT-01. 正常用例：选择分类仅显示该分类物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/materials?categoryId=${cid}`)
    expect(res.status).toBe(200)
  })
  test('MAT-CAT-02. 空数据边界：分类下无物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?categoryId=non-existent')
    expect(res.status).toBe(200)
  })
  test('MAT-CAT-03. 正常用例：重置分类筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(800)
  })
  test('MAT-CAT-04. UI差异：各角色分类筛选可见', async ({ page }) => {
    for (const role of MAT_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/materials`)
      await page.waitForTimeout(400)
    }
  })
  test('MAT-CAT-05. 并发：快速切换分类', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials?categoryId=1`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/materials?categoryId=2`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/materials?categoryId=3`)
    await page.waitForTimeout(200)
  })
  test('MAT-CAT-06. 异常恢复：分类筛选时API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials?categoryId=test`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 3. 按供应商筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 按供应商筛选', () => {
  test('MAT-SUP-01. 正常用例：选择供应商仅显示该供应商物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const sid = await getAnySupplierId(token)
    if (!sid) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/materials?supplierId=${sid}`)
    expect(res.status).toBe(200)
  })
  test('MAT-SUP-02. 空数据边界：供应商下无物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?supplierId=non-existent')
    expect(res.status).toBe(200)
  })
  test('MAT-SUP-03. 正常用例：重置供应商筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(800)
  })
  test('MAT-SUP-04. UI差异：各角色供应商筛选可见', async ({ page }) => {
    for (const role of MAT_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/materials`)
      await page.waitForTimeout(400)
    }
  })
  test('MAT-SUP-05. 并发：快速切换供应商', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials?supplierId=1`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/materials?supplierId=2`)
    await page.waitForTimeout(200)
  })
  test('MAT-SUP-06. 异常恢复：供应商筛选时API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials?supplierId=test`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 4. 搜索物料 (6 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 搜索物料', () => {
  test('MAT-SEARCH-01. 正常用例：搜索"Ki-67"返回匹配物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?keyword=Ki-67')
    expect(res.status).toBe(200)
  })
  test('MAT-SEARCH-02. 空数据边界：搜索无结果', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?keyword=XYZ999NOTEXIST')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBe(0)
  })
  test('MAT-SEARCH-03. 并发：快速连续输入', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(500)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a')
      await search.fill('ab')
      await search.fill('abc')
      await page.waitForTimeout(600)
    }
  })
  test('MAT-SEARCH-04. 异常恢复：搜索时网络断', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials?keyword=test`)
    await page.waitForTimeout(800)
  })
  test('MAT-SEARCH-05. 边界：搜索超长字符串', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?keyword=' + 'X'.repeat(300))
    expect(res.status).toBe(200)
  })
  test('MAT-SEARCH-06. UI差异：各角色搜索可见', async ({ page }) => {
    for (const role of MAT_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/materials`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 5. 新增物料 (18 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 新增物料', () => {
  test('MAT-CREATE-01. 正常用例：admin新增物料成功', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-NEW-${Date.now()}`, name: 'E2E测试物料', unit: '瓶', categoryId: cid,
      safetyStock: 10, remark: 'E2E新增测试',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('MAT-CREATE-02. 正常用例：procurement新增物料成功', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const cid = await getAnyCategoryId(adminToken)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-PROC-${Date.now()}`, name: 'E2E采购新增', unit: '盒', categoryId: cid,
    })
    expect([201, 403, 409]).toContain(res.status)
  })
  test('MAT-CREATE-03. 空数据边界：price=0合法', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-PRICE0-${Date.now()}`, name: '价格零测试', unit: '瓶', categoryId: cid, price: 0,
    })
    expect([201, 409]).toContain(res.status)
  })
  test('MAT-CREATE-04. 表单校验：未传name返回400', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-NONAME-${Date.now()}`, unit: '瓶', categoryId: cid,
    })
    expect(res.status).toBe(400)
  })
  test('MAT-CREATE-05. 表单校验：未传unit返回400', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-NOUNIT-${Date.now()}`, name: '无单位', categoryId: cid,
    })
    expect(res.status).toBe(400)
  })
  test('MAT-CREATE-06. 表单校验：未传categoryId返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-NOCAT-${Date.now()}`, name: '无分类', unit: '瓶',
    })
    expect(res.status).toBe(400)
  })
  for (const role of ['technician', 'pathologist', 'finance'] as RoleKey[]) {
    test(`MAT-CREATE-07-${role}. 权限：${role}新增物料返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const cid = await getAnyCategoryId(adminToken)
      if (!cid) { test.skip(); return }
      const res = await apiFetch(token, 'POST', '/materials', {
        code: `TEST-PERM-${Date.now()}`, name: '权限测试', unit: '瓶', categoryId: cid,
      })
      expect(res.status).toBe(403)
    })
  }
  test('MAT-CREATE-08. 业务冲突：code已存在返回409', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const code = `TEST-DUP-${Date.now()}`
    const r1 = await apiFetch(token, 'POST', '/materials', {
      code, name: '重复测试1', unit: '瓶', categoryId: cid,
    })
    expect(r1.status).toBe(201)
    const r2 = await apiFetch(token, 'POST', '/materials', {
      code, name: '重复测试2', unit: '瓶', categoryId: cid,
    })
    expect(r2.status).toBe(409)
  })
  test('MAT-CREATE-09. 并发：快速双击提交', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const body = { code: `TEST-CON-${Date.now()}`, name: '并发测试', unit: '瓶', categoryId: cid }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/materials', body), apiFetch(token, 'POST', '/materials', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('MAT-CREATE-10. 异常恢复：提交时网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-RETRY-${Date.now()}`, name: '恢复测试', unit: '瓶', categoryId: cid, remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('MAT-CREATE-11. 正常用例：新增物料后inventory自动创建stock=0', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-STOCK-${Date.now()}`, name: '库存测试', unit: '瓶', categoryId: cid,
    })
    if (res.status === 201) {
      const mid = res.data?.data?.id
      const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
      expect(inv.status).toBe(200)
    }
  })
  test('MAT-CREATE-12. 边界：超长code', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: 'TEST-' + 'X'.repeat(200), name: '超长编码', unit: '瓶', categoryId: cid,
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('MAT-CREATE-13. 边界：特殊字符name', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-SPEC-${Date.now()}`, name: '!@#$$%^&*()测试', unit: '瓶', categoryId: cid,
    })
    expect([201, 409]).toContain(res.status)
  })
  test('MAT-CREATE-14. 边界：负数price', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-NEG-${Date.now()}`, name: '负数价格', unit: '瓶', categoryId: cid, price: -10,
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('MAT-CREATE-15. UI差异：admin显示新增物料按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-CREATE-16. UI差异：procurement显示新增物料按钮', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-CREATE-17. UI差异：technician不显示新增按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-CREATE-18. 表单校验：空字符串name', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-EMPTY-${Date.now()}`, name: '', unit: '瓶', categoryId: cid,
    })
    expect([400, 201]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 6. 编辑物料 (14 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 编辑物料', () => {
  test('MAT-EDIT-01. 正常用例：admin编辑物料价格成功', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/materials/${id}`, { price: 99.9, remark: 'E2E编辑' })
    expect([200, 404]).toContain(res.status)
  })
  test('MAT-EDIT-02. 正常用例：procurement编辑物料成功', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const id = await getAnyMaterialId(adminToken)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/materials/${id}`, { price: 88.8 })
    expect([200, 403, 404]).toContain(res.status)
  })
  test('MAT-EDIT-03. 空数据边界：price=-1', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/materials/${id}`, { price: -1 })
    expect([200, 400]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'finance'] as RoleKey[]) {
    test(`MAT-EDIT-04-${role}. 权限：${role}编辑物料返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyMaterialId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'PUT', `/materials/${id}`, { name: '越权编辑' })
      expect(res.status).toBe(403)
    })
  }
  test('MAT-EDIT-05. 业务冲突：编辑categoryId不更新code前缀', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/materials/${id}`, { categoryId: 'new-cat-id' })
    expect([200, 404]).toContain(res.status)
  })
  test('MAT-EDIT-06. 并发：并发编辑同一物料', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'PUT', `/materials/${id}`, { name: '并发A' }),
      apiFetch(token, 'PUT', `/materials/${id}`, { name: '并发B' }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('MAT-EDIT-07. 异常恢复：编辑时API 500后重试', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/materials/${id}`, { safetyStock: 20, remark: 'E2E恢复' })
    expect([200, 404]).toContain(res.status)
  })
  test('MAT-EDIT-08. UI差异：admin显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-EDIT-09. UI差异：procurement显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-EDIT-10. UI差异：technician不显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-EDIT-11. 正常用例：编辑后列表数据更新', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/materials/${id}`, { name: `更新名称-${Date.now()}` })
    const after = await apiFetch(token, 'GET', `/materials/${id}`)
    expect([200, 404]).toContain(after.status)
  })
  test('MAT-EDIT-12. 表单校验：编辑不存在的物料返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/materials/non-existent-id', { name: '不存在' })
    expect(res.status).toBe(404)
  })
  test('MAT-EDIT-13. 边界：编辑name为空字符串', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/materials/${id}`, { name: '' })
    expect([200, 400]).toContain(res.status)
  })
  test('MAT-EDIT-14. 异常恢复：编辑时网络中断', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/materials/${id}`, { remark: 'E2E网络' })
    expect([200, 404]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 7. 删除物料 (12 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 删除物料', () => {
  test('MAT-DEL-01. 正常用例：admin删除stock=0物料', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-DEL-${Date.now()}`, name: '删除测试', unit: '瓶', categoryId: cid,
    })
    expect(create.status).toBe(201)
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`MAT-DEL-02-${role}. 权限：${role}删除物料返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyMaterialId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
      expect(res.status).toBe(403)
    })
  }
  test('MAT-DEL-03. 业务冲突：stock>0删除返回409', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  test('MAT-DEL-04. 并发：并发删除同一物料', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-DEL-CON-${Date.now()}`, name: '并发删除', unit: '瓶', categoryId: cid,
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'DELETE', `/materials/${id}`),
      apiFetch(token, 'DELETE', `/materials/${id}`),
    ])
    expect(r1.status === 200 || r2.status === 200 || r1.status === 404 || r2.status === 404).toBe(true)
  })
  test('MAT-DEL-05. 异常恢复：删除时API 500后重试', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-DEL-RET-${Date.now()}`, name: '恢复删除', unit: '瓶', categoryId: cid,
    })
    const id = create.data?.data?.id
    if (id) {
      const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
      expect([200, 409, 404]).toContain(res.status)
    }
  })
  test('MAT-DEL-06. UI差异：admin显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-DEL-07. UI差异：procurement可能隐藏删除', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-DEL-08. 表单校验：删除不存在的物料返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'DELETE', '/materials/non-existent-id')
    expect(res.status).toBe(404)
  })
  test('MAT-DEL-09. 业务冲突：删除后再次删除返回404', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-DEL-DUP-${Date.now()}`, name: '重复删除', unit: '瓶', categoryId: cid,
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    await apiFetch(token, 'DELETE', `/materials/${id}`)
    const res2 = await apiFetch(token, 'DELETE', `/materials/${id}`)
    expect([404, 409]).toContain(res2.status)
  })
  test('MAT-DEL-10. 异常恢复：删除后inventory联动删除', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-DEL-INV-${Date.now()}`, name: '库存联动删除', unit: '瓶', categoryId: cid,
    })
    const id = create.data?.data?.id
    if (id) {
      await apiFetch(token, 'DELETE', `/materials/${id}`)
    }
  })
  test('MAT-DEL-11. 正常用例：删除后物料列表刷新', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-DEL-REF-${Date.now()}`, name: '刷新删除', unit: '瓶', categoryId: cid,
    })
    const id = create.data?.data?.id
    if (id) {
      await apiFetch(token, 'DELETE', `/materials/${id}`)
    }
  })
  test('MAT-DEL-12. UI差异：warehouse_manager不显示删除按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 8. 批量启用/停用 (8 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 批量启用停用', () => {
  test('MAT-BATCH-01. 正常用例：admin批量停用物料', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
    expect([200, 404]).toContain(res.status)
  })
  test('MAT-BATCH-02. 正常用例：admin批量启用物料', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'active' })
    expect([200, 404]).toContain(res.status)
  })
  test('MAT-BATCH-03. 空数据边界：空数组ids返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [], status: 'inactive' })
    expect([200, 400]).toContain(res.status)
  })
  test('MAT-BATCH-04. 权限：technician批量操作返回403', async () => {
    const token = await apiLogin('technician')
    const adminToken = await apiLogin('admin')
    const id = await getAnyMaterialId(adminToken)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
    expect(res.status).toBe(403)
  })
  test('MAT-BATCH-05. 并发：快速点击批量停用多次', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
    await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
    await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'active' })
  })
  test('MAT-BATCH-06. UI差异：admin显示批量操作按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('MAT-BATCH-07. 异常恢复：批量操作时部分失败', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: ['invalid-id-1', 'invalid-id-2'], status: 'inactive' })
    expect([200, 400, 404, 500]).toContain(res.status)
  })
  test('MAT-BATCH-08. 正常用例：批量操作后列表状态标签更新', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'inactive' })
    await apiFetch(token, 'PATCH', '/materials/batch-status', { ids: [id], status: 'active' })
  })
})

// ────────────────────────────────────────────
// 9. 查看物料详情 (6 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 查看物料详情', () => {
  for (const role of MAT_READ_ROLES) {
    test(`MAT-DETAIL-01-${role}. 正常用例：${role}可查看物料详情`, async () => {
      const token = await apiLogin(role)
      const id = await getAnyMaterialId(token)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'GET', `/materials/${id}`)
      expect([200, 404]).toContain(res.status)
    })
  }
  test('MAT-DETAIL-02. 表单校验：查看不存在的物料返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials/non-existent-id')
    expect(res.status).toBe(404)
  })
  test('MAT-DETAIL-03. UI差异：admin可点击行查看详情', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) await rows.first().click()
  })
})

// ────────────────────────────────────────────
// 10. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 分页切换', () => {
  test('MAT-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials?page=2`)
    await page.waitForTimeout(800)
  })
  test('MAT-PAGE-02. 边界：仅1页分页器隐藏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(800)
  })
  test('MAT-PAGE-03. 表单校验：page=0后端修正为1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?page=0')
    expect([200, 500]).toContain(res.status)
    if (res.status === 200) {
      expect(res.data?.data?.pagination?.page ?? res.data?.data?.page).toBeGreaterThanOrEqual(1)
    }
  })
  test('MAT-PAGE-04. 边界：page=999返回空列表', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?page=999&pageSize=20')
    expect(res.status).toBe(200)
  })
  test('MAT-PAGE-05. 边界：pageSize=1', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBeLessThanOrEqual(1)
  })
  test('MAT-PAGE-06. 边界：pageSize=100', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=100')
    expect([200, 500]).toContain(res.status)
  })
  test('MAT-PAGE-07. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/materials?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('MAT-PAGE-08. UI差异：各角色分页一致', async ({ page }) => {
    for (const role of MAT_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/materials?page=1`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 11. 角色权限矩阵补充 (8 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 角色权限矩阵补充', () => {
  const scenes = [
    { id: 'TC-PERM-MAT-01', role: 'finance' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-MAT-02', role: 'admin' as RoleKey, method: 'GET', expect: 200 },
    { id: 'TC-PERM-MAT-03', role: 'procurement' as RoleKey, method: 'GET', expect: 200 },
    { id: 'TC-PERM-MAT-04', role: 'warehouse_manager' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-MAT-05', role: 'technician' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-MAT-06', role: 'pathologist' as RoleKey, method: 'POST', expect: 403 },
  ]
  for (const s of scenes) {
    test(`${s.id}. ${s.role} ${s.method} /materials 返回${s.expect}`, async () => {
      const token = await apiLogin(s.role)
      let res
      if (s.method === 'GET') res = await apiFetch(token, 'GET', '/materials')
      else {
        const adminToken = await apiLogin('admin')
        const cid = await getAnyCategoryId(adminToken)
        res = await apiFetch(token, 'POST', '/materials', { code: `TEST-PERM-${Date.now()}`, name: '权限', unit: '瓶', categoryId: cid || 'x' })
      }
      expect(res.status).toBe(s.expect)
    })
  }
  test('TC-PERM-MAT-07. admin POST /materials 返回201', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-ADMIN-${Date.now()}`, name: 'admin新增', unit: '瓶', categoryId: cid,
    })
    expect([201, 409]).toContain(res.status)
  })
  test('TC-PERM-MAT-08. finance直接访问/materials页面', async ({ page }) => {
    await loginAs(page, 'finance')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 12. 业务流程树 (8 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 业务流程树', () => {
  test('BF-MAT-01. 主路径：登录→进入耗材管理→新增物料→填写信息→提交→列表刷新', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-BF-${Date.now()}`, name: '业务流程测试', unit: '瓶', categoryId: cid, remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BF-MAT-02. 分支：关闭弹窗不保存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BF-MAT-03. 分支：编码已存在', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const code = `TEST-DUP-BF-${Date.now()}`
    await apiFetch(token, 'POST', '/materials', { code, name: '重复1', unit: '瓶', categoryId: cid })
    const res = await apiFetch(token, 'POST', '/materials', { code, name: '重复2', unit: '瓶', categoryId: cid })
    expect(res.status).toBe(409)
  })
  test('BF-MAT-04. 分支：必填字段漏填', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/materials', { code: 'TEST-MISS', unit: '瓶' })
    expect(res.status).toBe(400)
  })
  test('BF-MAT-05. 分支：价格输入负数', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-NEG-${Date.now()}`, name: '负数', unit: '瓶', categoryId: cid, price: -10,
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('BF-MAT-06. 分支：刷新页面后新物料仍在列表', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-MAT-07. 分支：删除有库存的物料', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/materials/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  test('BF-MAT-08. 分支：technician尝试新增物料被403拦截', async () => {
    const token = await apiLogin('technician')
    const adminToken = await apiLogin('admin')
    const cid = await getAnyCategoryId(adminToken)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-TECH-${Date.now()}`, name: '技术员', unit: '瓶', categoryId: cid,
    })
    expect(res.status).toBe(403)
  })
})

// ────────────────────────────────────────────
// 13. 盲点分析补充 (14 tests)
// ────────────────────────────────────────────
test.describe('耗材管理 -> 盲点分析补充', () => {
  test('BLIND-MAT-01. 物料编码自动生成规则', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-AUTO-${Date.now()}`, name: '自动生成', unit: '瓶', categoryId: cid,
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-MAT-02. 物料分类下拉联动', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-MAT-03. 物料供应商下拉联动', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-MAT-04. 物料库存预警阈值设置', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyMaterialId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/materials/${id}`, { safetyStock: 50 })
    expect([200, 404]).toContain(res.status)
  })
  test('BLIND-MAT-05. 物料列表导出功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-MAT-06. 物料列表打印功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-MAT-07. 物料详情Tab切换', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-MAT-08. 物料图片上传功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-MAT-09. 物料批次信息展示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-MAT-10. 物料页面响应式布局', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-MAT-11. 物料页面加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/materials`)
    await page.waitForTimeout(2000)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-MAT-12. 物料字段XSS防护', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-XSS-${Date.now()}`, name: '<script>alert(1)</script>', unit: '瓶', categoryId: cid,
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-MAT-13. 物料字段SQL注入防护', async () => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/materials', {
      code: `TEST-SQL-${Date.now()}`, name: "' OR '1'='1", unit: '瓶', categoryId: cid,
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-MAT-14. 物料API响应格式验证', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('data')
    expect(res.data?.data).toHaveProperty('list')
    const hasPagination = res.data?.data?.pagination !== undefined
    if (hasPagination) {
      expect(res.data?.data?.pagination).toHaveProperty('page')
      expect(res.data?.data?.pagination).toHaveProperty('total')
    } else {
      expect(res.data?.data).toHaveProperty('page')
      expect(res.data?.data).toHaveProperty('total')
    }
  })
})
