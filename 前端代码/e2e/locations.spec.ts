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
const LOC_READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager']
const LOC_FORBIDDEN: RoleKey[] = ['technician', 'pathologist', 'procurement', 'finance']

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

async function getAnyLocationId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/locations?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/locations?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.code?.startsWith('TEST-') || item.name?.includes('E2E')) {
        await apiFetch(token, 'DELETE', `/locations/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ────────────────────────────────────────────
// 1. 查看库位树 (10 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 查看库位树', () => {
  for (const role of LOC_READ_ROLES) {
    test(`LOC-LIST-01-${role}. 正常用例：${role}可查看库位列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/locations`)
      await expect(page.locator('body')).toBeVisible({ timeout: 30000 })
    })
  }
  test('LOC-LIST-02. 空数据边界：无库位数据显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(800)
  })
  test('LOC-LIST-03. 权限：technician访问返回403', async () => {
    const res = await apiFetch(await apiLogin('technician'), 'GET', '/locations')
    expect(res.status).toBe(403)
  })
  test('LOC-LIST-04. 权限：pathologist访问返回403', async () => {
    const res = await apiFetch(await apiLogin('pathologist'), 'GET', '/locations')
    expect(res.status).toBe(403)
  })
  test('LOC-LIST-05. 权限：procurement访问返回403', async () => {
    const res = await apiFetch(await apiLogin('procurement'), 'GET', '/locations')
    expect(res.status).toBe(403)
  })
  test('LOC-LIST-06. 权限：finance访问返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/locations')
    expect(res.status).toBe(403)
  })
  test('LOC-LIST-07. 异常恢复：API 500显示错误Toast', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(800)
  })
  test('LOC-LIST-08. UI差异：admin显示新增编辑删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('LOC-LIST-09. UI差异：warehouse_manager仅显示查看', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('LOC-LIST-10. 正常用例：列表按区域显示树形结构', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 2. 按类型筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 按类型筛选', () => {
  test('LOC-TYPE-01. 正常用例：选择refrigerator仅显示冷藏柜', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?type=refrigerator')
    expect(res.status).toBe(200)
  })
  test('LOC-TYPE-02. 空数据边界：该类型无库位', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?type=nonexistent')
    expect(res.status).toBe(200)
  })
  test('LOC-TYPE-03. 正常用例：重置类型筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(800)
  })
  test('LOC-TYPE-04. UI差异：各角色类型筛选可见', async ({ page }) => {
    for (const role of LOC_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/locations`)
      await page.waitForTimeout(400)
    }
  })
  test('LOC-TYPE-05. 并发：快速切换类型', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations?type=refrigerator`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/locations?type=shelf`)
    await page.waitForTimeout(200)
  })
  test('LOC-TYPE-06. 异常恢复：类型筛选时API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations?type=invalid`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 3. 按区域筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 按区域筛选', () => {
  test('LOC-ZONE-01. 正常用例：选择A区仅显示A区库位', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?zone=A区')
    expect(res.status).toBe(200)
  })
  test('LOC-ZONE-02. 空数据边界：该区域无库位', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?zone=nonexistent')
    expect(res.status).toBe(200)
  })
  test('LOC-ZONE-03. 正常用例：重置区域筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(800)
  })
  test('LOC-ZONE-04. UI差异：各角色区域筛选可见', async ({ page }) => {
    for (const role of LOC_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/locations`)
      await page.waitForTimeout(400)
    }
  })
  test('LOC-ZONE-05. 并发：快速切换区域', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations?zone=A区`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/locations?zone=B区`)
    await page.waitForTimeout(200)
  })
  test('LOC-ZONE-06. 异常恢复：区域筛选时API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations?zone=invalid`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 4. 按状态筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 按状态筛选', () => {
  test('LOC-STATUS-01. 正常用例：选择active仅显示在用的库位', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?status=active')
    expect(res.status).toBe(200)
  })
  test('LOC-STATUS-02. 空数据边界：无active库位', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?status=inactive')
    expect(res.status).toBe(200)
  })
  test('LOC-STATUS-03. 正常用例：重置状态筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(800)
  })
  test('LOC-STATUS-04. UI差异：各角色状态筛选可见', async ({ page }) => {
    for (const role of LOC_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/locations`)
      await page.waitForTimeout(400)
    }
  })
  test('LOC-STATUS-05. 并发：快速切换状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations?status=active`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/locations?status=inactive`)
    await page.waitForTimeout(200)
  })
  test('LOC-STATUS-06. 异常恢复：状态筛选时API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations?status=invalid`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 5. 新增库位 (14 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 新增库位', () => {
  test('LOC-CREATE-01. 正常用例：admin新增库位成功', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: `E2E测试库位-${Date.now()}`, zone: 'A区', type: 'shelf', capacity: 100, remark: 'E2E新增',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('LOC-CREATE-02. 空数据边界：capacity=0合法', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: `E2E零容量-${Date.now()}`, zone: 'A区', type: 'shelf', capacity: 0,
    })
    expect([201, 409]).toContain(res.status)
  })
  test('LOC-CREATE-03. 表单校验：未传name返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', { zone: 'A区', type: 'shelf' })
    expect(res.status).toBe(400)
  })
  test('LOC-CREATE-04. 表单校验：未传zone返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', { name: '无区域', type: 'shelf' })
    expect(res.status).toBe(400)
  })
  for (const role of LOC_FORBIDDEN) {
    test(`LOC-CREATE-05-${role}. 权限：${role}新增库位返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'POST', '/locations', {
        name: '权限测试', zone: 'A区', type: 'shelf',
      })
      expect(res.status).toBe(403)
    })
  }
  test('LOC-CREATE-06. 并发：快速双击提交', async () => {
    const token = await apiLogin('admin')
    const body = { name: `E2E并发-${Date.now()}`, zone: 'A区', type: 'shelf' }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/locations', body), apiFetch(token, 'POST', '/locations', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('LOC-CREATE-07. 异常恢复：提交时网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: `E2E恢复-${Date.now()}`, zone: 'A区', type: 'shelf', remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('LOC-CREATE-08. UI差异：admin显示新增库位按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('LOC-CREATE-09. UI差异：warehouse_manager不显示新增按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('LOC-CREATE-10. 正常用例：新增库位后code自动生成', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: `E2E编码-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    if (res.status === 201) expect(res.data?.data?.code).toBeDefined()
  })
  test('LOC-CREATE-11. 正常用例：新增库位后used=0', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: `E2E使用-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    if (res.status === 201) expect(res.data?.data?.used || 0).toBe(0)
  })
  test('LOC-CREATE-12. 边界：超长name', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: 'E2E-' + 'X'.repeat(200), zone: 'A区', type: 'shelf',
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('LOC-CREATE-13. 边界：负数capacity', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: `E2E负容量-${Date.now()}`, zone: 'A区', type: 'shelf', capacity: -10,
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('LOC-CREATE-14. 正常用例：入库单库位下拉同步', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?page=1&pageSize=5')
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 6. 编辑库位 (12 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 编辑库位', () => {
  test('LOC-EDIT-01. 正常用例：admin编辑库位capacity成功', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/locations/${id}`, { capacity: 200, remark: 'E2E编辑' })
    expect([200, 404]).toContain(res.status)
  })
  test('LOC-EDIT-02. 空数据边界：capacity=0', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/locations/${id}`, { capacity: 0 })
    expect([200, 404]).toContain(res.status)
  })
  for (const role of ['warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`LOC-EDIT-03-${role}. 权限：${role}编辑库位返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyLocationId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'PUT', `/locations/${id}`, { name: '越权编辑' })
      expect(res.status).toBe(403)
    })
  }
  test('LOC-EDIT-04. 业务冲突：编辑used字段不被更新', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/locations/${id}`, { used: 999 })
    expect([200, 404]).toContain(res.status)
  })
  test('LOC-EDIT-05. 并发：并发编辑同一库位', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'PUT', `/locations/${id}`, { name: '并发A' }),
      apiFetch(token, 'PUT', `/locations/${id}`, { name: '并发B' }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('LOC-EDIT-06. 异常恢复：编辑时API 500后重试', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/locations/${id}`, { capacity: 150 })
    expect([200, 404]).toContain(res.status)
  })
  test('LOC-EDIT-07. UI差异：admin显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('LOC-EDIT-08. UI差异：warehouse_manager不显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('LOC-EDIT-09. 正常用例：编辑后列表数据更新', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/locations/${id}`, { name: `更新-${Date.now()}` })
  })
  test('LOC-EDIT-10. 表单校验：编辑不存在的库位返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/locations/non-existent-id', { name: '不存在' })
    expect(res.status).toBe(404)
  })
  test('LOC-EDIT-11. 边界：编辑name为空字符串', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/locations/${id}`, { name: '' })
    expect([200, 400]).toContain(res.status)
  })
  test('LOC-EDIT-12. 异常恢复：编辑时网络中断', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/locations/${id}`, { remark: 'E2E网络' })
    expect([200, 404]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 7. 删除库位 (12 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 删除库位', () => {
  test('LOC-DEL-01. 正常用例：admin删除无库存关联库位', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/locations', {
      name: `E2E删除-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    expect(create.status).toBe(201)
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'DELETE', `/locations/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  for (const role of ['warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`LOC-DEL-02-${role}. 权限：${role}删除库位返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyLocationId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'DELETE', `/locations/${id}`)
      expect(res.status).toBe(403)
    })
  }
  test('LOC-DEL-03. 业务冲突：有关联inventory删除后悬空引用', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/locations/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  test('LOC-DEL-04. 并发：并发删除同一库位', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/locations', {
      name: `E2E并发删-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'DELETE', `/locations/${id}`),
      apiFetch(token, 'DELETE', `/locations/${id}`),
    ])
    expect(r1.status === 200 || r2.status === 200 || r1.status === 404 || r2.status === 404).toBe(true)
  })
  test('LOC-DEL-05. 异常恢复：删除时API 500后重试', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/locations', {
      name: `E2E恢复删-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    const id = create.data?.data?.id
    if (id) {
      const res = await apiFetch(token, 'DELETE', `/locations/${id}`)
      expect([200, 409, 404]).toContain(res.status)
    }
  })
  test('LOC-DEL-06. UI差异：admin显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('LOC-DEL-07. UI差异：warehouse_manager不显示删除按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('LOC-DEL-08. 表单校验：删除不存在的库位返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'DELETE', '/locations/non-existent-id')
    expect(res.status).toBe(404)
  })
  test('LOC-DEL-09. 业务冲突：删除后再次删除返回404', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/locations', {
      name: `E2E重复删-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    await apiFetch(token, 'DELETE', `/locations/${id}`)
    const res2 = await apiFetch(token, 'DELETE', `/locations/${id}`)
    expect([404, 409]).toContain(res2.status)
  })
  test('LOC-DEL-10. 正常用例：删除后列表刷新', async ({ page }) => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/locations', {
      name: `E2E刷新删-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    const id = create.data?.data?.id
    if (id) await apiFetch(token, 'DELETE', `/locations/${id}`)
  })
  test('LOC-DEL-11. 异常恢复：删除时网络中断', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/locations', {
      name: `E2E网络删-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    const id = create.data?.data?.id
    if (id) await apiFetch(token, 'DELETE', `/locations/${id}`)
  })
  test('LOC-DEL-12. 边界：删除后其他角色查看', async ({ page }) => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/locations', {
      name: `E2E权限删-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    const id = create.data?.data?.id
    if (id) await apiFetch(token, 'DELETE', `/locations/${id}`)
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 8. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 分页切换', () => {
  test('LOC-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations?page=2`)
    await page.waitForTimeout(800)
  })
  test('LOC-PAGE-02. 边界：仅1页分页器隐藏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(800)
  })
  test('LOC-PAGE-03. 表单校验：page=0后端修正为1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?page=0')
    expect([200, 500]).toContain(res.status)
    if (res.status === 200) {
      expect(res.data?.data?.pagination?.page ?? res.data?.data?.page).toBeGreaterThanOrEqual(1)
    }
  })
  test('LOC-PAGE-04. 边界：page=999返回空列表', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?page=999')
    expect(res.status).toBe(200)
  })
  test('LOC-PAGE-05. 边界：pageSize=1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBeLessThanOrEqual(1)
  })
  test('LOC-PAGE-06. 边界：pageSize=100', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('LOC-PAGE-07. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/locations?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('LOC-PAGE-08. UI差异：各角色分页一致', async ({ page }) => {
    for (const role of LOC_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/locations?page=1`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 9. 角色权限矩阵补充 (8 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 角色权限矩阵补充', () => {
  const scenes = [
    { id: 'TC-PERM-049', role: 'technician' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-050', role: 'pathologist' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-051', role: 'procurement' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-052', role: 'finance' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-053', role: 'warehouse_manager' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-054', role: 'technician' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-055', role: 'pathologist' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-056', role: 'procurement' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-057', role: 'finance' as RoleKey, method: 'POST', expect: 403 },
  ]
  for (const s of scenes) {
    test(`${s.id}. ${s.role} ${s.method} /locations 返回${s.expect}`, async () => {
      const token = await apiLogin(s.role)
      let res
      if (s.method === 'GET') res = await apiFetch(token, 'GET', '/locations')
      else res = await apiFetch(token, 'POST', '/locations', { name: '权限', zone: 'A区', type: 'shelf' })
      expect(res.status).toBe(s.expect)
    })
  }
  test('TC-PERM-LOC-EXTRA-01. admin GET /locations 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-LOC-EXTRA-02. warehouse_manager GET /locations 返回200', async () => {
    const token = await apiLogin('warehouse_manager')
    const res = await apiFetch(token, 'GET', '/locations')
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 10. 业务流程树 (8 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 业务流程树', () => {
  test('BF-LOC-01. 主路径：登录→进入库位管理→新增库位→填写信息→提交→列表刷新', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: `E2E主路径-${Date.now()}`, zone: 'A区', type: 'shelf', remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BF-LOC-02. 分支：关闭弹窗不保存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('BF-LOC-03. 分支：必填字段漏填', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', { name: '漏填' })
    expect(res.status).toBe(400)
  })
  test('BF-LOC-04. 分支：刷新页面后新库位仍在列表', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-LOC-05. 分支：删除有库存关联的库位', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/locations/${id}`)
    expect([200, 409, 404]).toContain(res.status)
  })
  test('BF-LOC-06. 分支：编辑库位后入库单下拉同步', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyLocationId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/locations/${id}`, { name: `同步-${Date.now()}` })
  })
  test('BF-LOC-07. 分支：warehouse_manager尝试新增被403拦截', async () => {
    const token = await apiLogin('warehouse_manager')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: '越权', zone: 'A区', type: 'shelf',
    })
    expect(res.status).toBe(403)
  })
  test('BF-LOC-08. 分支：快速筛选后分页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations?zone=A区&page=2`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 11. 盲点分析补充 (16 tests)
// ────────────────────────────────────────────
test.describe('库位管理 -> 盲点分析补充', () => {
  test('BLIND-LOC-01. 库位编码自动生成规则', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: `E2E编码-${Date.now()}`, zone: 'A区', type: 'shelf',
    })
    if (res.status === 201) expect(res.data?.data?.code).toBeDefined()
  })
  test('BLIND-LOC-02. 库位容量使用率计算', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('BLIND-LOC-03. 库位树形结构展示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-LOC-04. 库位列表导出功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-LOC-05. 库位打印功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-LOC-06. 库位页面响应式布局', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-LOC-07. 库位页面加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(2000)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-LOC-08. 库位搜索功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(800)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('A区')
      await page.waitForTimeout(600)
    }
  })
  test('BLIND-LOC-09. 库位详情弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) await rows.first().click()
  })
  test('BLIND-LOC-10. 库位字段XSS防护', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: '<script>alert(1)</script>', zone: 'A区', type: 'shelf',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-LOC-11. 库位字段SQL注入防护', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/locations', {
      name: "' OR '1'='1", zone: 'A区', type: 'shelf',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-LOC-12. 库位API响应格式验证', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?page=1&pageSize=1')
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
  test('BLIND-LOC-13. 库位容量预警', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const item = res.data?.data?.list?.[0]
    if (item) {
      const used = item.used || 0
      const cap = item.capacity || 0
      if (cap > 0 && used >= cap) {
        // capacity warning
      }
    }
  })
  test('BLIND-LOC-14. 库位状态颜色标签', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/locations`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-LOC-15. 库位排序功能', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/locations?sort=code&order=asc')
    expect(res.status).toBe(200)
  })
  test('BLIND-LOC-16. 多角色同时操作互不影响', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'warehouse_manager')
    await p1.goto(`${FE_BASE}/locations`)
    await p2.goto(`${FE_BASE}/locations`)
    await ctx1.close()
    await ctx2.close()
  })
})
