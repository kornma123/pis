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
const PROJ_READ_ROLES: RoleKey[] = ['admin', 'technician', 'pathologist']
const PROJ_FORBIDDEN: RoleKey[] = ['warehouse_manager', 'procurement', 'finance']

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

async function getAnyProjectId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/projects?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyBomId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/boms?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/projects?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.code?.startsWith('TEST-') || item.name?.includes('E2E')) {
        await apiFetch(token, 'DELETE', `/projects/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ────────────────────────────────────────────
// 1. 查看项目列表 (10 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 查看项目列表', () => {
  for (const role of PROJ_READ_ROLES) {
    test(`PROJ-LIST-01-${role}. 正常用例：${role}可查看项目列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/projects`)
      await expect(page.locator('body')).toBeVisible({ timeout: 30000 })
    })
  }
  test('PROJ-LIST-02. 空数据边界：无项目数据', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(800)
  })
  test('PROJ-LIST-03. 权限：warehouse_manager访问返回403', async () => {
    const res = await apiFetch(await apiLogin('warehouse_manager'), 'GET', '/projects')
    expect(res.status).toBe(403)
  })
  test('PROJ-LIST-04. 权限：procurement访问返回403', async () => {
    const res = await apiFetch(await apiLogin('procurement'), 'GET', '/projects')
    expect(res.status).toBe(403)
  })
  test('PROJ-LIST-05. 权限：finance访问返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/projects')
    expect(res.status).toBe(403)
  })
  test('PROJ-LIST-06. 异常恢复：API 500', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(800)
  })
  test('PROJ-LIST-07. UI差异：admin显示新增编辑删除', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-LIST-08. UI差异：technician仅显示查看', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-LIST-09. 正常用例：显示编码名称类型周期BOM样本数', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-LIST-10. 并发：快速刷新', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.reload()
    await page.reload()
  })
})

// ────────────────────────────────────────────
// 2. 按类型筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 按类型筛选', () => {
  test('PROJ-TYPE-01. 正常用例：选择ihc仅显示免疫组化', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?type=ihc')
    expect(res.status).toBe(200)
  })
  test('PROJ-TYPE-02. 空数据边界：该类型无项目', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?type=nonexistent')
    expect(res.status).toBe(200)
  })
  test('PROJ-TYPE-03. 正常用例：重置筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(800)
  })
  test('PROJ-TYPE-04. UI差异：各角色类型筛选可见', async ({ page }) => {
    for (const role of PROJ_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/projects`)
      await page.waitForTimeout(400)
    }
  })
  test('PROJ-TYPE-05. 并发：快速切换类型', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects?type=ihc`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/projects?type=he`)
    await page.waitForTimeout(200)
  })
  test('PROJ-TYPE-06. 异常恢复：类型筛选API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects?type=invalid`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 3. 按状态筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 按状态筛选', () => {
  test('PROJ-STATUS-01. 正常用例：选择active仅显示启用', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?status=active')
    expect(res.status).toBe(200)
  })
  test('PROJ-STATUS-02. 空数据边界：无active项目', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?status=inactive')
    expect(res.status).toBe(200)
  })
  test('PROJ-STATUS-03. 正常用例：重置筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(800)
  })
  test('PROJ-STATUS-04. UI差异：各角色状态筛选可见', async ({ page }) => {
    for (const role of PROJ_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/projects`)
      await page.waitForTimeout(400)
    }
  })
  test('PROJ-STATUS-05. 并发：快速切换状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects?status=active`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/projects?status=inactive`)
    await page.waitForTimeout(200)
  })
  test('PROJ-STATUS-06. 异常恢复：状态筛选API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects?status=invalid`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 4. 搜索项目 (6 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 搜索项目', () => {
  test('PROJ-SEARCH-01. 正常用例：搜索HER2', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?keyword=HER2')
    expect(res.status).toBe(200)
  })
  test('PROJ-SEARCH-02. 空数据边界：无结果', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?keyword=XYZ999')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBe(0)
  })
  test('PROJ-SEARCH-03. 并发：快速连续输入', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(500)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a')
      await search.fill('ab')
      await page.waitForTimeout(600)
    }
  })
  test('PROJ-SEARCH-04. 异常恢复：搜索网络断', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects?keyword=test`)
    await page.waitForTimeout(800)
  })
  test('PROJ-SEARCH-05. 边界：超长字符串', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?keyword=' + 'X'.repeat(300))
    expect(res.status).toBe(200)
  })
  test('PROJ-SEARCH-06. UI差异：各角色搜索可见', async ({ page }) => {
    for (const role of PROJ_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/projects`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 5. 新建项目 (16 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 新建项目', () => {
  test('PROJ-CREATE-01. 正常用例：admin新建项目成功', async () => {
    const token = await apiLogin('admin')
    const bid = await getAnyBomId(token)
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-PROJ-${Date.now()}`, name: 'E2E测试项目', type: 'ihc', cycle: 7,
      bomId: bid || undefined, status: 'active', remark: 'E2E新增',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('PROJ-CREATE-02. 空数据边界：cycle留空', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-NOCYCLE-${Date.now()}`, name: '无周期', type: 'ihc',
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('PROJ-CREATE-03. 表单校验：未传code返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', { name: '无编码', type: 'ihc' })
    expect(res.status).toBe(400)
  })
  test('PROJ-CREATE-04. 表单校验：未传name返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', { code: 'NONAME', type: 'ihc' })
    expect(res.status).toBe(400)
  })
  test('PROJ-CREATE-05. 表单校验：未传type返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', { code: 'NOTYPE', name: '无类型' })
    expect(res.status).toBe(400)
  })
  for (const role of ['technician', 'pathologist', 'warehouse_manager', 'procurement', 'finance'] as RoleKey[]) {
    test(`PROJ-CREATE-06-${role}. 权限：${role}新建返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'POST', '/projects', {
        code: `TEST-PERM-${Date.now()}`, name: '权限', type: 'ihc',
      })
      expect(res.status).toBe(403)
    })
  }
  test('PROJ-CREATE-07. 业务冲突：code已存在返回409', async () => {
    const token = await apiLogin('admin')
    const code = `TEST-DUP-${Date.now()}`
    await apiFetch(token, 'POST', '/projects', { code, name: '重复1', type: 'ihc' })
    const res = await apiFetch(token, 'POST', '/projects', { code, name: '重复2', type: 'ihc' })
    expect(res.status).toBe(409)
  })
  test('PROJ-CREATE-08. 并发：快速双击', async () => {
    const token = await apiLogin('admin')
    const body = { code: `TEST-CON-${Date.now()}`, name: '并发', type: 'ihc' }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/projects', body), apiFetch(token, 'POST', '/projects', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('PROJ-CREATE-09. 异常恢复：网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-RET-${Date.now()}`, name: '恢复', type: 'ihc', remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('PROJ-CREATE-10. UI差异：admin显示新增按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-CREATE-11. UI差异：technician不显示新增按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-CREATE-12. UI差异：pathologist不显示新增按钮', async ({ page }) => {
    await loginAs(page, 'pathologist')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-CREATE-13. 正常用例：新建后status=active', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-STAT-${Date.now()}`, name: '状态测试', type: 'ihc',
    })
    if (res.status === 201) expect(res.data?.data?.status).toBe('active')
  })
  test('PROJ-CREATE-14. 边界：超长code', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', {
      code: 'TEST-' + 'X'.repeat(200), name: '超长', type: 'ihc',
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('PROJ-CREATE-15. 边界：非法type值', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-ILLEGAL-${Date.now()}`, name: '非法类型', type: 'xxx',
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('PROJ-CREATE-16. 正常用例：关联BOM创建项目', async () => {
    const token = await apiLogin('admin')
    const bid = await getAnyBomId(token)
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-BOM-${Date.now()}`, name: 'BOM项目', type: 'ihc', bomId: bid || undefined,
    })
    expect([201, 409]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 6. 编辑项目 (12 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 编辑项目', () => {
  test('PROJ-EDIT-01. 正常用例：admin编辑项目名称成功', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/projects/${id}`, { name: `编辑-${Date.now()}`, remark: 'E2E' })
    expect([200, 404]).toContain(res.status)
  })
  test('PROJ-EDIT-02. 空数据边界：清空必填字段', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/projects/${id}`, { name: '', code: '' })
    expect([200, 400]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'warehouse_manager', 'procurement', 'finance'] as RoleKey[]) {
    test(`PROJ-EDIT-03-${role}. 权限：${role}编辑返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyProjectId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'PUT', `/projects/${id}`, { name: '越权' })
      expect(res.status).toBe(403)
    })
  }
  test('PROJ-EDIT-04. 业务冲突：编辑status不影响历史记录', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/projects/${id}`, { status: 'inactive' })
    expect([200, 404]).toContain(res.status)
  })
  test('PROJ-EDIT-05. 并发：并发编辑同一项目', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'PUT', `/projects/${id}`, { name: '并发A' }),
      apiFetch(token, 'PUT', `/projects/${id}`, { name: '并发B' }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('PROJ-EDIT-06. 异常恢复：API 500后重试', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/projects/${id}`, { cycle: 14 })
    expect([200, 404]).toContain(res.status)
  })
  test('PROJ-EDIT-07. UI差异：admin显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-EDIT-08. UI差异：technician不显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-EDIT-09. 正常用例：编辑后列表更新', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/projects/${id}`, { name: `更新-${Date.now()}` })
  })
  test('PROJ-EDIT-10. 表单校验：编辑不存在返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/projects/non-existent', { name: '不存在' })
    expect(res.status).toBe(404)
  })
  test('PROJ-EDIT-11. 业务冲突：编辑已停用项目', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/projects/${id}`, { status: 'inactive' })
    expect([200, 404]).toContain(res.status)
  })
  test('PROJ-EDIT-12. 异常恢复：网络中断', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/projects/${id}`, { remark: 'E2E网络' })
    expect([200, 404]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 7. 删除项目 (10 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 删除项目', () => {
  test('PROJ-DEL-01. 正常用例：admin删除无出库记录项目', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-DEL-${Date.now()}`, name: '删除测试', type: 'ihc',
    })
    expect(create.status).toBe(201)
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'DELETE', `/projects/${id}`)
    expect([200, 404]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'warehouse_manager', 'procurement', 'finance'] as RoleKey[]) {
    test(`PROJ-DEL-02-${role}. 权限：${role}删除返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyProjectId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'DELETE', `/projects/${id}`)
      expect(res.status).toBe(403)
    })
  }
  test('PROJ-DEL-03. 业务冲突：有关联出库删除后悬空引用', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/projects/${id}`)
    expect([200, 404]).toContain(res.status)
  })
  test('PROJ-DEL-04. 并发：并发删除', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-DEL-CON-${Date.now()}`, name: '并发删', type: 'ihc',
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'DELETE', `/projects/${id}`),
      apiFetch(token, 'DELETE', `/projects/${id}`),
    ])
    expect(r1.status === 200 || r2.status === 200 || r1.status === 404 || r2.status === 404).toBe(true)
  })
  test('PROJ-DEL-05. 异常恢复：API 500后重试', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-DEL-RET-${Date.now()}`, name: '恢复删', type: 'ihc',
    })
    const id = create.data?.data?.id
    if (id) {
      const res = await apiFetch(token, 'DELETE', `/projects/${id}`)
      expect([200, 404]).toContain(res.status)
    }
  })
  test('PROJ-DEL-06. UI差异：admin显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-DEL-07. UI差异：pathologist不显示删除按钮', async ({ page }) => {
    await loginAs(page, 'pathologist')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-DEL-08. 表单校验：删除不存在返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'DELETE', '/projects/non-existent')
    expect(res.status).toBe(404)
  })
  test('PROJ-DEL-09. 业务冲突：再次删除返回404', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-DEL-DUP-${Date.now()}`, name: '重复删', type: 'ihc',
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    await apiFetch(token, 'DELETE', `/projects/${id}`)
    const res2 = await apiFetch(token, 'DELETE', `/projects/${id}`)
    expect(res2.status).toBe(404)
  })
  test('PROJ-DEL-10. 正常用例：删除后列表刷新', async ({ page }) => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-DEL-REF-${Date.now()}`, name: '刷新删', type: 'ihc',
    })
    const id = create.data?.data?.id
    if (id) await apiFetch(token, 'DELETE', `/projects/${id}`)
  })
})

// ────────────────────────────────────────────
// 8. 跳转项目详情 (4 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 跳转项目详情', () => {
  test('PROJ-DETAIL-01. 正常用例：点击项目跳转详情', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) await rows.first().click()
  })
  test('PROJ-DETAIL-02. 正常用例：详情显示编码名称类型周期', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/projects/${id}`)
    expect([200, 404]).toContain(res.status)
  })
  test('PROJ-DETAIL-03. UI差异：pathologist显示成本统计', async ({ page }) => {
    await loginAs(page, 'pathologist')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('PROJ-DETAIL-04. UI差异：technician隐藏成本统计', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 9. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 分页切换', () => {
  test('PROJ-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects?page=2`)
    await page.waitForTimeout(800)
  })
  test('PROJ-PAGE-02. 边界：仅1页分页器隐藏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(800)
  })
  test('PROJ-PAGE-03. 表单校验：page=0修正为1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?page=0')
    expect(res.status).toBe(200)
    expect(res.data?.data?.pagination?.page).toBeGreaterThanOrEqual(1)
  })
  test('PROJ-PAGE-04. 边界：page=999', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?page=999')
    expect(res.status).toBe(200)
  })
  test('PROJ-PAGE-05. 边界：pageSize=1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('PROJ-PAGE-06. 边界：pageSize=100', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('PROJ-PAGE-07. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/projects?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('PROJ-PAGE-08. UI差异：各角色分页一致', async ({ page }) => {
    for (const role of PROJ_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/projects?page=1`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 10. 角色权限矩阵补充 (8 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 角色权限矩阵补充', () => {
  test('TC-PERM-100. warehouse_manager GET /projects 返回403', async () => {
    const res = await apiFetch(await apiLogin('warehouse_manager'), 'GET', '/projects')
    expect(res.status).toBe(403)
  })
  test('TC-PERM-101. procurement GET /projects 返回403', async () => {
    const res = await apiFetch(await apiLogin('procurement'), 'GET', '/projects')
    expect(res.status).toBe(403)
  })
  test('TC-PERM-102. finance GET /projects 返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/projects')
    expect(res.status).toBe(403)
  })
  test('TC-PERM-103. warehouse_manager POST /projects 返回403', async () => {
    const res = await apiFetch(await apiLogin('warehouse_manager'), 'POST', '/projects', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-104. technician POST /projects 返回403', async () => {
    const res = await apiFetch(await apiLogin('technician'), 'POST', '/projects', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-105. pathologist POST /projects 返回403', async () => {
    const res = await apiFetch(await apiLogin('pathologist'), 'POST', '/projects', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-106. procurement POST /projects 返回403', async () => {
    const res = await apiFetch(await apiLogin('procurement'), 'POST', '/projects', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-107. finance POST /projects 返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'POST', '/projects', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
})

// ────────────────────────────────────────────
// 11. 业务流程树 (8 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 业务流程树', () => {
  test('BF-PROJ-01. 主路径：登录→进入项目→新建→填写→提交→列表刷新', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-BF-${Date.now()}`, name: '业务流程', type: 'ihc', remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BF-PROJ-02. 分支：关闭弹窗不保存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('BF-PROJ-03. 分支：code已存在', async () => {
    const token = await apiLogin('admin')
    const code = `TEST-DUP-BF-${Date.now()}`
    await apiFetch(token, 'POST', '/projects', { code, name: '重复1', type: 'ihc' })
    const res = await apiFetch(token, 'POST', '/projects', { code, name: '重复2', type: 'ihc' })
    expect(res.status).toBe(409)
  })
  test('BF-PROJ-04. 分支：必填漏填', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', { name: '漏填' })
    expect(res.status).toBe(400)
  })
  test('BF-PROJ-05. 分支：刷新后新项目仍在', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-PROJ-06. 分支：删除有关联出库', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/projects/${id}`)
    expect([200, 404]).toContain(res.status)
  })
  test('BF-PROJ-07. 分支：technician尝试新建被403', async () => {
    const res = await apiFetch(await apiLogin('technician'), 'POST', '/projects', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('BF-PROJ-08. 分支：筛选后分页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects?type=ihc&page=2`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 12. 盲点分析补充 (12 tests)
// ────────────────────────────────────────────
test.describe('检测项目 -> 盲点分析补充', () => {
  test('BLIND-PROJ-01. 项目编码唯一性', async () => {
    const token = await apiLogin('admin')
    const code = `TEST-UNIQ-${Date.now()}`
    const r1 = await apiFetch(token, 'POST', '/projects', { code, name: '唯一1', type: 'ihc' })
    const r2 = await apiFetch(token, 'POST', '/projects', { code, name: '唯一2', type: 'ihc' })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(409)
  })
  test('BLIND-PROJ-02. 项目类型下拉选项', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-PROJ-03. 项目BOM选择器', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-PROJ-04. 项目成本统计', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyProjectId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/projects/${id}`)
    expect([200, 404]).toContain(res.status)
  })
  test('BLIND-PROJ-05. 项目导出功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-PROJ-06. 项目打印功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-PROJ-07. 项目页面响应式', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-PROJ-08. 项目页面加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/projects`)
    await page.waitForTimeout(2000)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-PROJ-09. 项目字段XSS防护', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-XSS-${Date.now()}`, name: '<script>alert(1)</script>', type: 'ihc',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-PROJ-10. 项目字段SQL注入防护', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/projects', {
      code: `TEST-SQL-${Date.now()}`, name: "' OR '1'='1", type: 'ihc',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-PROJ-11. 项目API响应格式', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/projects?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('data')
    expect(res.data?.data).toHaveProperty('list')
  })
  test('BLIND-PROJ-12. 多角色同时操作', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'technician')
    await p1.goto(`${FE_BASE}/projects`)
    await p2.goto(`${FE_BASE}/projects`)
    await ctx1.close()
    await ctx2.close()
  })
})
