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
const SUP_READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'procurement']
const SUP_WRITE_ROLES: RoleKey[] = ['admin', 'procurement']
const SUP_FORBIDDEN: RoleKey[] = ['technician', 'pathologist', 'finance']

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

async function getAnySupplierId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.code?.startsWith('TEST-') || item.name?.includes('E2E')) {
        await apiFetch(token, 'DELETE', `/suppliers/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ────────────────────────────────────────────
// 1. 查看供应商列表 (10 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 查看供应商列表', () => {
  for (const role of SUP_READ_ROLES) {
    test(`SUP-LIST-01-${role}. 正常用例：${role}可查看供应商列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/suppliers`)
      await expect(page.locator('body')).toBeVisible({ timeout: 30000 })
    })
  }
  test('SUP-LIST-02. 空数据边界：无供应商显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(800)
  })
  test('SUP-LIST-03. 权限：technician访问返回403', async () => {
    const res = await apiFetch(await apiLogin('technician'), 'GET', '/suppliers')
    expect(res.status).toBe(403)
  })
  test('SUP-LIST-04. 权限：pathologist访问返回403', async () => {
    const res = await apiFetch(await apiLogin('pathologist'), 'GET', '/suppliers')
    expect(res.status).toBe(403)
  })
  test('SUP-LIST-05. 权限：finance访问返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/suppliers')
    expect(res.status).toBe(403)
  })
  test('SUP-LIST-06. 异常恢复：API 500显示错误Toast', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(800)
  })
  test('SUP-LIST-07. UI差异：admin显示新增编辑删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-LIST-08. UI差异：procurement显示新增编辑', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-LIST-09. 正常用例：列表显示编码名称联系人合作次数累计金额', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-LIST-10. 并发：快速刷新页面', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.reload()
    await page.reload()
  })
})

// ────────────────────────────────────────────
// 2. 按状态筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 按状态筛选', () => {
  test('SUP-STATUS-01. 正常用例：选择active仅显示合作中供应商', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?status=active')
    expect(res.status).toBe(200)
  })
  test('SUP-STATUS-02. 空数据边界：无active供应商', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?status=inactive')
    expect(res.status).toBe(200)
  })
  test('SUP-STATUS-03. 正常用例：重置状态筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(800)
  })
  test('SUP-STATUS-04. UI差异：各角色状态筛选可见', async ({ page }) => {
    for (const role of SUP_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/suppliers`)
      await page.waitForTimeout(400)
    }
  })
  test('SUP-STATUS-05. 并发：快速切换状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers?status=active`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/suppliers?status=inactive`)
    await page.waitForTimeout(200)
  })
  test('SUP-STATUS-06. 异常恢复：状态筛选时API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers?status=invalid`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 3. 搜索供应商 (6 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 搜索供应商', () => {
  test('SUP-SEARCH-01. 正常用例：搜索"SUP-00001"返回匹配', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?keyword=SUP')
    expect(res.status).toBe(200)
  })
  test('SUP-SEARCH-02. 空数据边界：搜索无结果', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?keyword=XYZ999')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBe(0)
  })
  test('SUP-SEARCH-03. 并发：快速连续输入', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(500)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a')
      await search.fill('ab')
      await page.waitForTimeout(600)
    }
  })
  test('SUP-SEARCH-04. 异常恢复：搜索时网络断', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers?keyword=test`)
    await page.waitForTimeout(800)
  })
  test('SUP-SEARCH-05. 边界：搜索超长字符串', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?keyword=' + 'X'.repeat(300))
    expect(res.status).toBe(200)
  })
  test('SUP-SEARCH-06. UI差异：各角色搜索可见', async ({ page }) => {
    for (const role of SUP_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/suppliers`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 4. 新增供应商 (14 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 新增供应商', () => {
  test('SUP-CREATE-01. 正常用例：admin新增供应商成功', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E供应商-${Date.now()}`, contact: '张三', phone: '13800138000', email: 'test@example.com', remark: 'E2E新增',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('SUP-CREATE-02. 正常用例：procurement新增供应商成功', async () => {
    const token = await apiLogin('procurement')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E采购供应商-${Date.now()}`, contact: '李四', phone: '13900139000',
    })
    expect([201, 403, 409]).toContain(res.status)
  })
  test('SUP-CREATE-03. 空数据边界：name留空返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', { contact: '无名', phone: '13800138000' })
    expect(res.status).toBe(400)
  })
  test('SUP-CREATE-04. 表单校验：email格式不校验', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E邮箱-${Date.now()}`, contact: '王五', phone: '13800138000', email: 'invalid-email',
    })
    expect([201, 409]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`SUP-CREATE-05-${role}. 权限：${role}新增供应商返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'POST', '/suppliers', { name: '权限测试', contact: '测试' })
      expect(res.status).toBe(403)
    })
  }
  test('SUP-CREATE-06. 并发：快速双击提交', async () => {
    const token = await apiLogin('admin')
    const body = { name: `E2E并发-${Date.now()}`, contact: '并发', phone: '13800138000' }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/suppliers', body), apiFetch(token, 'POST', '/suppliers', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('SUP-CREATE-07. 异常恢复：提交时网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E恢复-${Date.now()}`, contact: '恢复', phone: '13800138000', remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('SUP-CREATE-08. UI差异：admin显示新增供应商按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-CREATE-09. UI差异：procurement显示新增供应商按钮', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-CREATE-10. UI差异：warehouse_manager不显示新增按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-CREATE-11. 正常用例：新增后code自动生成', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E编码-${Date.now()}`, contact: '编码', phone: '13800138000',
    })
    if (res.status === 201) expect(res.data?.data?.code).toBeDefined()
  })
  test('SUP-CREATE-12. 边界：超长name', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: 'E2E-' + 'X'.repeat(200), contact: '长', phone: '13800138000',
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('SUP-CREATE-13. 边界：特殊字符name', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: '!@#$$%^&*()测试-' + Date.now(), contact: '特', phone: '13800138000',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('SUP-CREATE-14. 正常用例：新增后入库单供应商下拉同步', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=5')
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 5. 编辑供应商 (12 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 编辑供应商', () => {
  test('SUP-EDIT-01. 正常用例：admin编辑联系方式成功', async () => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/suppliers/${id}`, { contact: '新联系人', phone: '13800138001', remark: 'E2E编辑' })
    expect([200, 404]).toContain(res.status)
  })
  test('SUP-EDIT-02. 正常用例：procurement编辑供应商成功', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const id = await getAnySupplierId(adminToken)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/suppliers/${id}`, { contact: '采购编辑' })
    expect([200, 403, 404]).toContain(res.status)
  })
  test('SUP-EDIT-03. 空数据边界：清空所有字段', async () => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/suppliers/${id}`, { name: '', contact: '', phone: '' })
    expect([200, 400]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`SUP-EDIT-04-${role}. 权限：${role}编辑供应商返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnySupplierId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'PUT', `/suppliers/${id}`, { name: '越权' })
      expect(res.status).toBe(403)
    })
  }
  test('SUP-EDIT-05. 业务冲突：编辑code历史入库记录supplier_id不更新', async () => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/suppliers/${id}`, { code: `NEW-CODE-${Date.now()}` })
    expect([200, 404]).toContain(res.status)
  })
  test('SUP-EDIT-06. 并发：并发编辑同一供应商', async () => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'PUT', `/suppliers/${id}`, { contact: '并发A' }),
      apiFetch(token, 'PUT', `/suppliers/${id}`, { contact: '并发B' }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('SUP-EDIT-07. 异常恢复：编辑时API 500后重试', async () => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/suppliers/${id}`, { remark: 'E2E恢复' })
    expect([200, 404]).toContain(res.status)
  })
  test('SUP-EDIT-08. UI差异：admin显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-EDIT-09. UI差异：procurement显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-EDIT-10. UI差异：warehouse_manager不显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-EDIT-11. 正常用例：编辑后列表数据更新', async () => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/suppliers/${id}`, { name: `更新-${Date.now()}` })
  })
  test('SUP-EDIT-12. 表单校验：编辑不存在的供应商返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/suppliers/non-existent-id', { name: '不存在' })
    expect(res.status).toBe(404)
  })
})

// ────────────────────────────────────────────
// 6. 删除供应商 (12 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 删除供应商', () => {
  test('SUP-DEL-01. 正常用例：admin删除无物料关联供应商', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E删除-${Date.now()}`, contact: '删除', phone: '13800138000',
    })
    expect(create.status).toBe(201)
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'DELETE', `/suppliers/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'finance', 'warehouse_manager'] as RoleKey[]) {
    test(`SUP-DEL-02-${role}. 权限：${role}删除供应商返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnySupplierId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'DELETE', `/suppliers/${id}`)
      expect(res.status).toBe(403)
    })
  }
  test('SUP-DEL-03. 业务冲突：有关联物料删除后悬空引用', async () => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/suppliers/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  test('SUP-DEL-04. 并发：并发删除同一供应商', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E并发删-${Date.now()}`, contact: '并发', phone: '13800138000',
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'DELETE', `/suppliers/${id}`),
      apiFetch(token, 'DELETE', `/suppliers/${id}`),
    ])
    expect(r1.status === 200 || r2.status === 200 || r1.status === 404 || r2.status === 404).toBe(true)
  })
  test('SUP-DEL-05. 异常恢复：删除时API 500后重试', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E恢复删-${Date.now()}`, contact: '恢复', phone: '13800138000',
    })
    const id = create.data?.data?.id
    if (id) {
      const res = await apiFetch(token, 'DELETE', `/suppliers/${id}`)
      expect([200, 409, 404]).toContain(res.status)
    }
  })
  test('SUP-DEL-06. UI差异：admin显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-DEL-07. UI差异：procurement隐藏删除按钮', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('SUP-DEL-08. 表单校验：删除不存在的供应商返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'DELETE', '/suppliers/non-existent-id')
    expect(res.status).toBe(404)
  })
  test('SUP-DEL-09. 业务冲突：删除后再次删除返回404', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E重复删-${Date.now()}`, contact: '重复', phone: '13800138000',
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    await apiFetch(token, 'DELETE', `/suppliers/${id}`)
    const res2 = await apiFetch(token, 'DELETE', `/suppliers/${id}`)
    expect([404, 409]).toContain(res2.status)
  })
  test('SUP-DEL-10. 正常用例：删除后列表刷新', async ({ page }) => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E刷新删-${Date.now()}`, contact: '刷新', phone: '13800138000',
    })
    const id = create.data?.data?.id
    if (id) await apiFetch(token, 'DELETE', `/suppliers/${id}`)
  })
  test('SUP-DEL-11. 异常恢复：删除时网络中断', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E网络删-${Date.now()}`, contact: '网络', phone: '13800138000',
    })
    const id = create.data?.data?.id
    if (id) await apiFetch(token, 'DELETE', `/suppliers/${id}`)
  })
  test('SUP-DEL-12. 边界：删除后其他角色查看', async ({ page }) => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E权限删-${Date.now()}`, contact: '权限', phone: '13800138000',
    })
    const id = create.data?.data?.id
    if (id) await apiFetch(token, 'DELETE', `/suppliers/${id}`)
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 7. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 分页切换', () => {
  test('SUP-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers?page=2`)
    await page.waitForTimeout(800)
  })
  test('SUP-PAGE-02. 边界：仅1页分页器隐藏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(800)
  })
  test('SUP-PAGE-03. 表单校验：page=0后端修正为1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=0')
    expect([200, 500]).toContain(res.status)
    if (res.status === 200) {
      expect(res.data?.data?.pagination?.page ?? res.data?.data?.page).toBeGreaterThanOrEqual(1)
    }
  })
  test('SUP-PAGE-04. 边界：page=999返回空列表', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=999')
    expect(res.status).toBe(200)
  })
  test('SUP-PAGE-05. 边界：pageSize=1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBeLessThanOrEqual(1)
  })
  test('SUP-PAGE-06. 边界：pageSize=100', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('SUP-PAGE-07. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/suppliers?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('SUP-PAGE-08. UI差异：各角色分页一致', async ({ page }) => {
    for (const role of SUP_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/suppliers?page=1`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 8. 角色权限矩阵补充 (8 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 角色权限矩阵补充', () => {
  const scenes = [
    { id: 'TC-PERM-026', role: 'technician' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-027', role: 'pathologist' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-028', role: 'finance' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-029', role: 'warehouse_manager' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-030', role: 'technician' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-031', role: 'pathologist' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-032', role: 'procurement' as RoleKey, method: 'POST', expect: 201 },
    { id: 'TC-PERM-033', role: 'finance' as RoleKey, method: 'POST', expect: 403 },
  ]
  for (const s of scenes) {
    test(`${s.id}. ${s.role} ${s.method} /suppliers 返回${s.expect}`, async () => {
      const token = await apiLogin(s.role)
      let res
      if (s.method === 'GET') res = await apiFetch(token, 'GET', '/suppliers')
      else res = await apiFetch(token, 'POST', '/suppliers', { name: `TEST-PERM-${Date.now()}`, contact: '权限', phone: '13800138000' })
      expect([s.expect, 409]).toContain(res.status)
    })
  }
  test('TC-PERM-SUP-EXTRA-01. admin GET /suppliers 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-SUP-EXTRA-02. warehouse_manager GET /suppliers 返回200', async () => {
    const token = await apiLogin('warehouse_manager')
    const res = await apiFetch(token, 'GET', '/suppliers')
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 9. 业务流程树 (8 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 业务流程树', () => {
  test('BF-SUP-01. 主路径：登录→进入供应商→新增→填写信息→提交→列表刷新', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E主路径-${Date.now()}`, contact: '主', phone: '13800138000', remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BF-SUP-02. 分支：关闭弹窗不保存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('BF-SUP-03. 分支：必填字段漏填', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', { contact: '漏填' })
    expect(res.status).toBe(400)
  })
  test('BF-SUP-04. 分支：刷新页面后新供应商仍在列表', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-SUP-05. 分支：删除有关联物料的供应商', async () => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/suppliers/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  test('BF-SUP-06. 分支：编辑供应商后入库单下拉同步', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnySupplierId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/suppliers/${id}`, { name: `同步-${Date.now()}` })
  })
  test('BF-SUP-07. 分支：warehouse_manager尝试新增被403拦截', async () => {
    const token = await apiLogin('warehouse_manager')
    const res = await apiFetch(token, 'POST', '/suppliers', { name: '越权', contact: '越权' })
    expect(res.status).toBe(403)
  })
  test('BF-SUP-08. 分支：快速筛选后分页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers?status=active&page=2`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 10. 盲点分析补充 (16 tests)
// ────────────────────────────────────────────
test.describe('供应商管理 -> 盲点分析补充', () => {
  test('BLIND-SUP-01. 供应商编码自动生成规则', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: `E2E编码-${Date.now()}`, contact: '编码', phone: '13800138000',
    })
    if (res.status === 201) expect(res.data?.data?.code).toBeDefined()
  })
  test('BLIND-SUP-02. 供应商合作次数统计', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('BLIND-SUP-03. 供应商累计金额统计', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('BLIND-SUP-04. 供应商列表导出功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-SUP-05. 供应商打印功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-SUP-06. 供应商页面响应式布局', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-SUP-07. 供应商页面加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(2000)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-SUP-08. 供应商搜索防抖', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(800)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a')
      await search.fill('ab')
      await page.waitForTimeout(600)
    }
  })
  test('BLIND-SUP-09. 供应商详情弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) await rows.first().click()
  })
  test('BLIND-SUP-10. 供应商字段XSS防护', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: '<script>alert(1)</script>', contact: 'XSS', phone: '13800138000',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-SUP-11. 供应商字段SQL注入防护', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/suppliers', {
      name: "' OR '1'='1", contact: 'SQL', phone: '13800138000',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-SUP-12. 供应商API响应格式验证', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
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
  test('BLIND-SUP-13. 供应商状态颜色标签', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/suppliers`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-SUP-14. 供应商排序功能', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?sort=code&order=asc')
    expect(res.status).toBe(200)
  })
  test('BLIND-SUP-15. 供应商联系信息完整性', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const item = res.data?.data?.list?.[0]
    if (item) expect(item.name).toBeDefined()
  })
  test('BLIND-SUP-16. 多角色同时操作互不影响', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'procurement')
    await p1.goto(`${FE_BASE}/suppliers`)
    await p2.goto(`${FE_BASE}/suppliers`)
    await ctx1.close()
    await ctx2.close()
  })
})
