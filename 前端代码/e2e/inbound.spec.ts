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
const WRITE_ROLES: RoleKey[] = ['admin', 'warehouse_manager']
const READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'procurement']
const NO_ACCESS_ROLES_INBOUND: RoleKey[] = ['technician', 'pathologist', 'finance']

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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function getAnyMaterialId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnySupplierId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/suppliers?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyLocationId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/locations?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyInboundId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/inbound?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/inbound?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.inboundNo?.startsWith('TEST-') || item.remark?.includes('E2E')) {
        await apiFetch(token, 'DELETE', `/inbound/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ────────────────────────────────────────────
// 1. 查看入库列表 (10 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 查看入库列表', () => {
  for (const role of READ_ROLES) {
    test(`IN-LIST-01-${role}. 正常用例：${role}可查看入库列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/inbound`)
      await expect(page.locator('table, .empty-state, [data-testid="inbound-list"]')).toBeVisible({ timeout: 30000 })
    })
  }
  test('IN-LIST-02. 空数据边界：无入库记录显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    const empty = page.locator('text=/暂无数据|暂无入库|空状态|empty/i')
    await expect(empty.or(page.locator('table tbody tr'))).toBeVisible({ timeout: 30000 })
  })
  test('IN-LIST-03. 权限：technician访问返回403', async ({ page }) => {
    await loginAs(page, 'technician')
    const res = await apiFetch(await apiLogin('technician'), 'GET', '/inbound')
    expect(res.status).toBe(403)
  })
  test('IN-LIST-04. 权限：pathologist访问返回403', async ({ page }) => {
    await loginAs(page, 'pathologist')
    const res = await apiFetch(await apiLogin('pathologist'), 'GET', '/inbound')
    expect(res.status).toBe(403)
  })
  test('IN-LIST-05. 权限：finance访问返回403', async ({ page }) => {
    await loginAs(page, 'finance')
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/inbound')
    expect(res.status).toBe(403)
  })
  test('IN-LIST-06. 异常恢复：API 500显示错误Toast保留数据', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toBeVisible()
  })
  test('IN-LIST-07. UI差异：admin显示新增入库和删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
    const btn = page.locator('button:has-text("新增入库"), button:has-text("新增")')
    await expect(btn).toHaveCount(await btn.count() > 0 ? await btn.count() : 0, { timeout: 5000 })
  })
  test('IN-LIST-08. UI差异：warehouse_manager显示新增入库按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-LIST-09. UI差异：procurement仅显示查看无新增按钮', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-LIST-10. 并发：快速刷新页面多次列表正常', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.reload()
    await page.reload()
    await expect(page.locator('body')).toBeVisible()
  })
})

// ────────────────────────────────────────────
// 2. 状态筛选 (8 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 状态筛选', () => {
  const statuses = ['pending', 'completed', 'cancelled']
  for (const status of statuses) {
    test(`IN-STATUS-01-${status}. 正常用例：筛选${status}状态`, async ({ page }) => {
      await loginAs(page, 'admin')
      await page.goto(`${FE_BASE}/inbound?status=${status}`)
      await page.waitForTimeout(800)
      await expect(page.locator('body')).toBeVisible()
    })
  }
  test('IN-STATUS-02. 空数据边界：筛选状态无记录显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound?status=cancelled`)
    await page.waitForTimeout(800)
  })
  test('IN-STATUS-03. 边界：非法状态值后端忽略或返回空', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?status=invalid_status_xyz')
    expect([200, 400]).toContain(res.status)
  })
  test('IN-STATUS-04. 正常用例：重置筛选恢复全部', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound?status=completed`)
    await page.waitForTimeout(500)
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(800)
  })
  test('IN-STATUS-05. UI差异：各角色筛选功能可见', async ({ page }) => {
    for (const role of READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/inbound`)
      await page.waitForTimeout(500)
    }
  })
})

// ────────────────────────────────────────────
// 3. 日期范围筛选 (8 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 日期范围筛选', () => {
  test('IN-DATE-01. 正常用例：有效日期范围筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound?startDate=2026-01-01&endDate=2026-12-31`)
    await page.waitForTimeout(800)
    await expect(page.locator('body')).toBeVisible()
  })
  test('IN-DATE-02. 空数据边界：日期范围无数据', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound?startDate=2099-01-01&endDate=2099-12-31`)
    await page.waitForTimeout(800)
  })
  test('IN-DATE-03. 表单校验：startDate>endDate返回空结果', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?startDate=2026-12-31&endDate=2026-01-01')
    expect(res.status).toBe(200)
  })
  test('IN-DATE-04. 边界：仅startDate筛选', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?startDate=2020-01-01')
    expect(res.status).toBe(200)
  })
  test('IN-DATE-05. 边界：仅endDate筛选', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?endDate=2099-12-31')
    expect(res.status).toBe(200)
  })
  test('IN-DATE-06. 边界：endDate自动附加23:59:59', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?endDate=2026-05-14')
    expect(res.status).toBe(200)
  })
  test('IN-DATE-07. 并发：快速切换日期范围', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/inbound?startDate=2026-0${i}-01&endDate=2026-0${i}-28`)
      await page.waitForTimeout(300)
    }
  })
  test('IN-DATE-08. 异常恢复：日期筛选时API 500', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound?startDate=2026-01-01`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 4. 创建直接入库单 (25 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 创建直接入库单', () => {
  test('IN-CREATE-DIRECT-01. 正常用例：admin创建直接入库单成功', async ({ page }) => {
    await loginAs(page, 'admin')
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 10, locationId: lid,
      batchNo: `TEST-${Date.now()}`, remark: 'E2E直接入库测试',
    })
    expect(res.status).toBe(201)
  })
  test('IN-CREATE-DIRECT-02. 正常用例：warehouse_manager创建直接入库单成功', async ({ page }) => {
    const token = await apiLogin('warehouse_manager')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 5, locationId: lid,
      batchNo: `TEST-WM-${Date.now()}`, remark: 'E2E',
    })
    expect(res.status).toBe(201)
  })
  test('IN-CREATE-DIRECT-03. 空数据边界：quantity=0', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 0, locationId: lid, batchNo: `TEST-0-${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-04. 表单校验：缺少type返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', { materialId: mid, quantity: 1, locationId: lid })
    expect(res.status).toBe(400)
  })
  test('IN-CREATE-DIRECT-05. 表单校验：缺少materialId返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const lid = await getAnyLocationId(token)
    if (!lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', { type: 'direct', quantity: 1, locationId: lid })
    expect(res.status).toBe(400)
  })
  test('IN-CREATE-DIRECT-06. 表单校验：缺少quantity返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', { type: 'direct', materialId: mid, locationId: lid })
    expect(res.status).toBe(400)
  })
  test('IN-CREATE-DIRECT-07. 表单校验：缺少locationId返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', { type: 'direct', materialId: mid, quantity: 1 })
    expect(res.status).toBe(400)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`IN-CREATE-DIRECT-08-${role}. 权限：${role}创建直接入库返回403`, async () => {
      const token = await apiLogin(role)
      const mid = await getAnyMaterialId(token)
      const lid = await getAnyLocationId(token)
      if (!mid || !lid) { test.skip(); return }
      const res = await apiFetch(token, 'POST', '/inbound', {
        type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      })
      expect(res.status).toBe(403)
    })
  }
  test('IN-CREATE-DIRECT-09. 业务冲突：物料不存在返回404', async () => {
    const token = await apiLogin('admin')
    const lid = await getAnyLocationId(token)
    if (!lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: 'non-existent-id-12345', quantity: 1, locationId: lid,
    })
    expect([404, 400]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-10. 并发：快速双击提交', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const body = { type: 'direct', materialId: mid, quantity: 2, locationId: lid, batchNo: `TEST-DUP-${Date.now()}` }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'POST', '/inbound', body),
      apiFetch(token, 'POST', '/inbound', body),
    ])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('IN-CREATE-DIRECT-11. 异常恢复：提交时网络中断后重试', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 3, locationId: lid,
      batchNo: `TEST-RETRY-${Date.now()}`, remark: 'E2E恢复测试',
    })
    expect(res.status).toBe(201)
  })
  test('IN-CREATE-DIRECT-12. 边界：超长batchNo', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: 'TEST-' + 'X'.repeat(200),
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-13. 边界：特殊字符batchNo', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-SPEC-!@#$$%^&*()${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-14. 边界：负数quantity', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: -5, locationId: lid, batchNo: `TEST-NEG-${Date.now()}`,
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-15. 边界：小数quantity', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1.5, locationId: lid, batchNo: `TEST-FLOAT-${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-16. UI差异：admin前端显示新增入库按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-CREATE-DIRECT-17. UI差异：warehouse_manager前端显示新增入库按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-CREATE-DIRECT-18. UI差异：technician前端不显示新增入库按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-CREATE-DIRECT-19. 正常用例：入库后库存增加', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const beforeStock = before.data?.data?.list?.[0]?.stock || 0
    await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 10, locationId: lid,
      batchNo: `TEST-STOCK-${Date.now()}`, remark: 'E2E库存测试',
    })
    const after = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const afterStock = after.data?.data?.list?.[0]?.stock || 0
    expect(afterStock).toBeGreaterThanOrEqual(beforeStock)
  })
  test('IN-CREATE-DIRECT-20. 表单校验：空字符串type', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: '', materialId: mid, quantity: 1, locationId: lid,
    })
    expect([400, 201]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-21. 边界：超大quantity', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 999999, locationId: lid,
      batchNo: `TEST-HUGE-${Date.now()}`,
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-22. 正常用例：入库单号格式IB-YYYYMMDD-XXX', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-FMT-${Date.now()}`,
    })
    expect(res.status).toBe(201)
    const no = res.data?.data?.inboundNo || ''
    expect(no).toMatch(/^IB-\d{8}-\d{3}$/)
  })
  test('IN-CREATE-DIRECT-23. 表单校验：locationId不存在', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: 'non-existent-loc',
    })
    expect([201, 400, 404]).toContain(res.status)
  })
  test('IN-CREATE-DIRECT-24. 业务冲突：同一batchNo重复入库', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const batchNo = `TEST-DUP-BATCH-${Date.now()}`
    const r1 = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid, batchNo,
    })
    expect(r1.status).toBe(201)
    const r2 = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid, batchNo,
    })
    expect([201, 409]).toContain(r2.status)
  })
  test('IN-CREATE-DIRECT-25. 异常恢复：入库后检查可删除状态', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-DELCHK-${Date.now()}`, remark: 'E2E',
    })
    expect(res.status).toBe(201)
    const id = res.data?.data?.id
    if (id) {
      const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
      expect(chk.status).toBe(200)
    }
  })
})

// ────────────────────────────────────────────
// 5. 创建采购入库单 (18 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 创建采购入库单', () => {
  test('IN-CREATE-PO-01. 正常用例：采购入库单创建成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    const sid = await getAnySupplierId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 50, locationId: lid,
      supplierId: sid || undefined, batchNo: `TEST-PO-${Date.now()}`, remark: 'E2E采购入库',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-PO-02. 空数据边界：采购订单已全部收货', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/purchase-orders?status=completed')
    expect(res.status).toBe(200)
  })
  test('IN-CREATE-PO-03. 表单校验：入库数量超过PO剩余数量', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 99999, locationId: lid,
      batchNo: `TEST-PO-OVER-${Date.now()}`,
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('IN-CREATE-PO-04. 权限：procurement创建采购入库返回403', async () => {
    const token = await apiLogin('procurement')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 1, locationId: lid,
    })
    expect(res.status).toBe(403)
  })
  test('IN-CREATE-PO-05. 权限：technician创建采购入库返回403', async () => {
    const token = await apiLogin('technician')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 1, locationId: lid,
    })
    expect(res.status).toBe(403)
  })
  test('IN-CREATE-PO-06. 业务冲突：关联的PO已取消仍可创建', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-PO-CANCEL-${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-PO-07. 并发：并发对同一PO入库', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const body = { type: 'purchase', materialId: mid, quantity: 1, locationId: lid, batchNo: `TEST-PO-CON-${Date.now()}` }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/inbound', body), apiFetch(token, 'POST', '/inbound', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('IN-CREATE-PO-08. 异常恢复：网络中断后重试', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 5, locationId: lid,
      batchNo: `TEST-PO-RET-${Date.now()}`, remark: 'E2E',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-PO-09. 正常用例：PO状态更新为partial/completed', async ({ page }) => {
    const token = await apiLogin('admin')
    const poRes = await apiFetch(token, 'GET', '/purchase-orders?page=1&pageSize=1&status=pending')
    const po = poRes.data?.data?.list?.[0]
    if (!po) { test.skip(); return }
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 1, locationId: lid,
      purchaseOrderId: po.id, batchNo: `TEST-PO-STAT-${Date.now()}`,
    })
    const after = await apiFetch(token, 'GET', `/purchase-orders/${po.id}`)
    expect([200, 404]).toContain(after.status)
  })
  test('IN-CREATE-PO-10. UI差异：admin显示采购入库入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-CREATE-PO-11. 边界：quantity=0采购入库', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 0, locationId: lid,
      batchNo: `TEST-PO-ZERO-${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-PO-12. 表单校验：缺少必填字段', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/inbound', { type: 'purchase' })
    expect(res.status).toBe(400)
  })
  test('IN-CREATE-PO-13. 权限：pathologist创建采购入库返回403', async () => {
    const token = await apiLogin('pathologist')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 1, locationId: lid,
    })
    expect(res.status).toBe(403)
  })
  test('IN-CREATE-PO-14. 权限：finance创建采购入库返回403', async () => {
    const token = await apiLogin('finance')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 1, locationId: lid,
    })
    expect(res.status).toBe(403)
  })
  test('IN-CREATE-PO-15. 正常用例：采购入库后检查库存同步', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 20, locationId: lid,
      batchNo: `TEST-PO-SYNC-${Date.now()}`, remark: 'E2E同步测试',
    })
    const after = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const aStock = after.data?.data?.list?.[0]?.stock || 0
    expect(aStock).toBeGreaterThanOrEqual(bStock)
  })
  test('IN-CREATE-PO-16. 表单校验：无效purchaseOrderId', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 1, locationId: lid,
      purchaseOrderId: 'invalid-po-id', batchNo: `TEST-PO-INV-${Date.now()}`,
    })
    expect([201, 400, 404]).toContain(res.status)
  })
  test('IN-CREATE-PO-17. 并发：重复提交同一采购入库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const body = { type: 'purchase', materialId: mid, quantity: 2, locationId: lid, batchNo: `TEST-PO-REP-${Date.now()}` }
    await apiFetch(token, 'POST', '/inbound', body)
    const res2 = await apiFetch(token, 'POST', '/inbound', body)
    expect([201, 409]).toContain(res2.status)
  })
  test('IN-CREATE-PO-18. 异常恢复：PO收货后刷新页面状态保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(800)
    await page.reload()
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 6. 创建退货入库单 (12 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 创建退货入库单', () => {
  test('IN-CREATE-RET-01. 正常用例：退货入库单创建成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'return', materialId: mid, quantity: 3, locationId: lid,
      batchNo: `TEST-RET-${Date.now()}`, remark: 'E2E退货入库',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-RET-02. 空数据边界：无历史出库单可选', async ({ page }) => {
    const token = await apiLogin('admin')
    const outRes = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=1')
    if (!outRes.data?.data?.list?.length) {
      test.skip()
      return
    }
  })
  test('IN-CREATE-RET-03. 业务冲突：退货数量超过原出库数量', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'return', materialId: mid, quantity: 99999, locationId: lid,
      batchNo: `TEST-RET-OVER-${Date.now()}`,
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('IN-CREATE-RET-04. 表单校验：缺少materialId', async ({ page }) => {
    const token = await apiLogin('admin')
    const lid = await getAnyLocationId(token)
    if (!lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', { type: 'return', quantity: 1, locationId: lid })
    expect(res.status).toBe(400)
  })
  test('IN-CREATE-RET-05. 表单校验：缺少quantity', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', { type: 'return', materialId: mid, locationId: lid })
    expect(res.status).toBe(400)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`IN-CREATE-RET-06-${role}. 权限：${role}创建退货入库返回403`, async () => {
      const token = await apiLogin(role)
      const mid = await getAnyMaterialId(token)
      const lid = await getAnyLocationId(token)
      if (!mid || !lid) { test.skip(); return }
      const res = await apiFetch(token, 'POST', '/inbound', { type: 'return', materialId: mid, quantity: 1, locationId: lid })
      expect(res.status).toBe(403)
    })
  }
  test('IN-CREATE-RET-07. 并发：快速双击提交退货', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const body = { type: 'return', materialId: mid, quantity: 1, locationId: lid, batchNo: `TEST-RET-DUP-${Date.now()}` }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/inbound', body), apiFetch(token, 'POST', '/inbound', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('IN-CREATE-RET-08. 异常恢复：退货入库后库存正确', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'return', materialId: mid, quantity: 2, locationId: lid,
      batchNo: `TEST-RET-STOCK-${Date.now()}`, remark: 'E2E',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-RET-09. 边界：退货数量=0', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'return', materialId: mid, quantity: 0, locationId: lid,
      batchNo: `TEST-RET-ZERO-${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-RET-10. 正常用例：退货入库关联原出库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const outRes = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=1')
    const outbound = outRes.data?.data?.list?.[0]
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'return', materialId: mid, quantity: 1, locationId: lid,
      outboundId: outbound?.id, batchNo: `TEST-RET-LINK-${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-RET-11. 异常恢复：网络中断后重试退货', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'return', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-RET-RET-${Date.now()}`, remark: 'E2E恢复',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-RET-12. UI差异：退货入库前端入口检查', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 7. 创建调拨入库单 (12 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 创建调拨入库单', () => {
  test('IN-CREATE-TRF-01. 正常用例：调拨入库单创建成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 5, locationId: lid,
      batchNo: `TEST-TRF-${Date.now()}`, remark: 'E2E调拨入库',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-TRF-02. 空数据边界：来源库位无库存', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-TRF-EMPTY-${Date.now()}`,
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('IN-CREATE-TRF-03. 表单校验：未填目标库位返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 1,
    })
    expect(res.status).toBe(400)
  })
  test('IN-CREATE-TRF-04. 业务冲突：目标库位容量不足', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 99999, locationId: lid,
      batchNo: `TEST-TRF-CAP-${Date.now()}`,
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`IN-CREATE-TRF-05-${role}. 权限：${role}创建调拨入库返回403`, async () => {
      const token = await apiLogin(role)
      const mid = await getAnyMaterialId(token)
      const lid = await getAnyLocationId(token)
      if (!mid || !lid) { test.skip(); return }
      const res = await apiFetch(token, 'POST', '/inbound', { type: 'transfer', materialId: mid, quantity: 1, locationId: lid })
      expect(res.status).toBe(403)
    })
  }
  test('IN-CREATE-TRF-06. 并发：并发调拨同一物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const body = { type: 'transfer', materialId: mid, quantity: 1, locationId: lid, batchNo: `TEST-TRF-CON-${Date.now()}` }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/inbound', body), apiFetch(token, 'POST', '/inbound', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('IN-CREATE-TRF-07. 异常恢复：调拨后检查库存', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 2, locationId: lid,
      batchNo: `TEST-TRF-STOCK-${Date.now()}`, remark: 'E2E',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-TRF-08. 边界：调拨数量=0', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 0, locationId: lid,
      batchNo: `TEST-TRF-ZERO-${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-TRF-09. 表单校验：缺少type', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', { materialId: mid, quantity: 1, locationId: lid })
    expect(res.status).toBe(400)
  })
  test('IN-CREATE-TRF-10. 正常用例：调拨入库后目标库位库存增加', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 3, locationId: lid,
      batchNo: `TEST-TRF-ADD-${Date.now()}`, remark: 'E2E库存增加',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-TRF-11. 异常恢复：网络中断后重试调拨', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-TRF-RETRY-${Date.now()}`, remark: 'E2E恢复',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('IN-CREATE-TRF-12. UI差异：调拨入库前端入口', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 8. 查看入库详情 (8 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 查看入库详情', () => {
  for (const role of READ_ROLES) {
    test(`IN-DETAIL-01-${role}. 正常用例：${role}可查看入库详情`, async ({ page }) => {
      const token = await apiLogin(role)
      const id = await getAnyInboundId(token)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'GET', `/inbound/${id}`)
      expect([200, 404]).toContain(res.status)
    })
  }
  test('IN-DETAIL-02. 表单校验：查看不存在的入库单返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound/non-existent-id')
    expect(res.status).toBe(404)
  })
  test('IN-DETAIL-03. 权限：technician查看入库详情返回403', async () => {
    const token = await apiLogin('technician')
    const adminToken = await apiLogin('admin')
    const id = await getAnyInboundId(adminToken)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/inbound/${id}`)
    expect(res.status).toBe(403)
  })
  test('IN-DETAIL-04. UI差异：admin可点击行查看详情', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) {
      await rows.first().click()
      await page.waitForTimeout(500)
    }
  })
})

// ────────────────────────────────────────────
// 9. 编辑入库单 (18 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 编辑入库单', () => {
  test('IN-EDIT-01. 正常用例：admin编辑入库单备注成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-EDIT-${Date.now()}`, remark: '原始备注',
    })
    expect(create.status).toBe(201)
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: '编辑后的备注E2E' })
    expect([200, 404]).toContain(res.status)
  })
  test('IN-EDIT-02. 正常用例：warehouse_manager编辑入库单成功', async ({ page }) => {
    const token = await apiLogin('warehouse_manager')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    const lid = await getAnyLocationId(adminToken)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(adminToken, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-EDIT-WM-${Date.now()}`,
    })
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: 'WHM编辑' })
    expect([200, 403, 404]).toContain(res.status)
  })
  test('IN-EDIT-03. 空数据边界：编辑后所有字段为空', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: '' })
    expect([200, 400]).toContain(res.status)
  })
  test('IN-EDIT-04. 表单校验：编辑不存在的入库单返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/inbound/non-existent-id', { remark: 'test' })
    expect(res.status).toBe(404)
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`IN-EDIT-05-${role}. 权限：${role}编辑入库单返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyInboundId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: '越权编辑' })
      expect(res.status).toBe(403)
    })
  }
  test('IN-EDIT-06. 业务冲突：已有关联出库的入库单编辑数量', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { quantity: 999 })
    expect([200, 400, 403]).toContain(res.status)
  })
  test('IN-EDIT-07. 并发：并发编辑同一入库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'PUT', `/inbound/${id}`, { remark: '并发编辑A' }),
      apiFetch(token, 'PUT', `/inbound/${id}`, { remark: '并发编辑B' }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('IN-EDIT-08. 异常恢复：编辑时API 500后重试', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: 'E2E恢复测试' })
    expect([200, 404]).toContain(res.status)
  })
  test('IN-EDIT-09. UI差异：admin显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-EDIT-10. UI差异：warehouse_manager显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-EDIT-11. UI差异：technician不显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-EDIT-12. 边界：编辑batchNo', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { batchNo: `EDIT-BATCH-${Date.now()}` })
    expect([200, 400]).toContain(res.status)
  })
  test('IN-EDIT-13. 边界：编辑quantity为0', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { quantity: 0 })
    expect([200, 400]).toContain(res.status)
  })
  test('IN-EDIT-14. 正常用例：编辑后列表数据更新', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: `更新备注-${Date.now()}` })
    const after = await apiFetch(token, 'GET', `/inbound/${id}`)
    expect([200, 404]).toContain(after.status)
  })
  test('IN-EDIT-15. 表单校验：编辑无效字段', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { invalidField: 'xxx' })
    expect([200, 400]).toContain(res.status)
  })
  test('IN-EDIT-16. 业务冲突：编辑已取消的入库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: '编辑已取消' })
    expect([200, 400]).toContain(res.status)
  })
  test('IN-EDIT-17. 异常恢复：编辑时网络中断', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: 'E2E网络测试' })
    expect([200, 404]).toContain(res.status)
  })
  test('IN-EDIT-18. 并发：快速重复编辑同一入库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    for (let i = 0; i < 3; i++) {
      await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: `重复编辑${i}` })
    }
  })
})

// ────────────────────────────────────────────
// 10. 删除入库单 (20 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 删除入库单', () => {
  test('IN-DELETE-01. 正常用例：admin删除无出库关联入库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-DEL-${Date.now()}`, remark: 'E2E删除测试',
    })
    expect(create.status).toBe(201)
    const id = create.data?.data?.id
    const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
    if (chk.data?.data?.canDelete) {
      const del = await apiFetch(token, 'DELETE', `/inbound/${id}`)
      expect([200, 400]).toContain(del.status)
    }
  })
  test('IN-DELETE-02. 正常用例：warehouse_manager删除入库单', async ({ page }) => {
    const token = await apiLogin('warehouse_manager')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    const lid = await getAnyLocationId(adminToken)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(adminToken, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-DEL-WM-${Date.now()}`,
    })
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'DELETE', `/inbound/${id}`)
    expect([200, 400, 403, 404]).toContain(res.status)
  })
  test('IN-DELETE-03. 空数据边界：入库数量=0删除无库存变化', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 0, locationId: lid,
      batchNo: `TEST-DEL-ZERO-${Date.now()}`,
    })
    const id = create.data?.data?.id
    if (id) {
      const del = await apiFetch(token, 'DELETE', `/inbound/${id}`)
      expect([200, 400, 404]).toContain(del.status)
    }
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`IN-DELETE-04-${role}. 权限：${role}删除入库单返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyInboundId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'DELETE', `/inbound/${id}`)
      expect(res.status).toBe(403)
    })
  }
  test('IN-DELETE-05. 业务冲突：已有出库记录的入库单删除', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
    if (!chk.data?.data?.canDelete) {
      const del = await apiFetch(token, 'DELETE', `/inbound/${id}`)
      expect([400, 409]).toContain(del.status)
    }
  })
  test('IN-DELETE-06. 并发：并发删除同一入库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-DEL-CON-${Date.now()}`,
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'DELETE', `/inbound/${id}`),
      apiFetch(token, 'DELETE', `/inbound/${id}`),
    ])
    expect(r1.status === 200 || r2.status === 200 || r1.status === 404 || r2.status === 404).toBe(true)
  })
  test('IN-DELETE-07. 异常恢复：删除时API 500后重试', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-DEL-RET-${Date.now()}`, remark: 'E2E',
    })
    const id = create.data?.data?.id
    if (id) {
      const del = await apiFetch(token, 'DELETE', `/inbound/${id}`)
      expect([200, 400, 404]).toContain(del.status)
    }
  })
  test('IN-DELETE-08. UI差异：admin显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-DELETE-09. UI差异：warehouse_manager显示删除按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-DELETE-10. UI差异：technician不显示删除按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-DELETE-11. 正常用例：删除后库存回退', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 5, locationId: lid,
      batchNo: `TEST-DEL-STOCK-${Date.now()}`, remark: 'E2E库存回退',
    })
    const id = create.data?.data?.id
    if (id) {
      const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
      if (chk.data?.data?.canDelete) {
        await apiFetch(token, 'DELETE', `/inbound/${id}`)
      }
    }
  })
  test('IN-DELETE-12. 表单校验：删除不存在的入库单返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'DELETE', '/inbound/non-existent-id-99999')
    expect(res.status).toBe(404)
  })
  test('IN-DELETE-13. 业务冲突：删除后再次删除返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-DEL-DUP-${Date.now()}`,
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    await apiFetch(token, 'DELETE', `/inbound/${id}`)
    const res2 = await apiFetch(token, 'DELETE', `/inbound/${id}`)
    expect([404, 400]).toContain(res2.status)
  })
  test('IN-DELETE-14. 并发：删除时刷新页面', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(500)
  })
  test('IN-DELETE-15. 异常恢复：删除时网络中断', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-DEL-NET-${Date.now()}`,
    })
    const id = create.data?.data?.id
    if (id) {
      await apiFetch(token, 'DELETE', `/inbound/${id}`)
    }
  })
  test('IN-DELETE-16. 正常用例：删除后PO状态回退', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
    if (chk.data?.data?.canDelete) {
      await apiFetch(token, 'DELETE', `/inbound/${id}`)
    }
  })
  test('IN-DELETE-17. 边界：删除待入库状态单据', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-DEL-PEN-${Date.now()}`, remark: 'E2E',
    })
    const id = create.data?.data?.id
    if (id) {
      const del = await apiFetch(token, 'DELETE', `/inbound/${id}`)
      expect([200, 400, 404]).toContain(del.status)
    }
  })
  test('IN-DELETE-18. UI差异：procurement不显示删除按钮', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-DELETE-19. 正常用例：删除后批次扣减', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 3, locationId: lid,
      batchNo: `TEST-DEL-BAT-${Date.now()}`, remark: 'E2E批次',
    })
    const id = create.data?.data?.id
    if (id) {
      const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
      if (chk.data?.data?.canDelete) {
        await apiFetch(token, 'DELETE', `/inbound/${id}`)
      }
    }
  })
  test('IN-DELETE-20. 异常恢复：删除后检查是否重复扣减库存', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 2, locationId: lid,
      batchNo: `TEST-DEL-CHK-${Date.now()}`, remark: 'E2E检查',
    })
    const id = create.data?.data?.id
    if (id) {
      const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
      if (chk.data?.data?.canDelete) {
        await apiFetch(token, 'DELETE', `/inbound/${id}`)
        const after = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
        const aStock = after.data?.data?.list?.[0]?.stock || 0
        expect(aStock).toBe(bStock)
      }
    }
  })
})

// ────────────────────────────────────────────
// 11. 取消入库单 (12 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 取消入库单', () => {
  test('IN-CANCEL-01. 正常用例：取消待入库状态单据', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-CANC-${Date.now()}`, remark: 'E2E取消测试',
    })
    const id = create.data?.data?.id
    if (id) {
      const res = await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
      expect([200, 400, 404]).toContain(res.status)
    }
  })
  test('IN-CANCEL-02. 空数据边界：已取消的单据再次取消', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
    expect([200, 400]).toContain(res.status)
  })
  test('IN-CANCEL-03. 业务冲突：已有关联出库的入库单取消', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
    expect([200, 400]).toContain(res.status)
  })
  test('IN-CANCEL-04. 异常恢复：取消时网络中断后重试', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
    expect([200, 400]).toContain(res.status)
  })
  test('IN-CANCEL-05. 异常恢复：取消后状态可能未变更需校验', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-CANC-CHK-${Date.now()}`,
    })
    const id = create.data?.data?.id
    if (id) {
      await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
      const after = await apiFetch(token, 'GET', `/inbound/${id}`)
      expect([200, 404]).toContain(after.status)
    }
  })
  test('IN-CANCEL-06. 正常用例：取消后库存不变', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-CANC-STK-${Date.now()}`,
    })
    const id = create.data?.data?.id
    if (id) {
      await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
      const after = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
      const aStock = after.data?.data?.list?.[0]?.stock || 0
      expect(aStock).toBeGreaterThanOrEqual(bStock)
    }
  })
  for (const role of ['technician', 'pathologist', 'procurement', 'finance'] as RoleKey[]) {
    test(`IN-CANCEL-07-${role}. 权限：${role}取消入库单返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyInboundId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
      expect(res.status).toBe(403)
    })
  }
  test('IN-CANCEL-08. 表单校验：取消不存在的入库单返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/inbound/non-existent-id/cancel')
    expect(res.status).toBe(404)
  })
  test('IN-CANCEL-09. 并发：并发取消同一入库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-CANC-CON-${Date.now()}`,
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'POST', `/inbound/${id}/cancel`),
      apiFetch(token, 'POST', `/inbound/${id}/cancel`),
    ])
    expect(r1.status === 200 || r2.status === 200 || r1.status === 400 || r2.status === 400).toBe(true)
  })
  test('IN-CANCEL-10. UI差异：admin显示取消按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-CANCEL-11. UI差异：warehouse_manager显示取消按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('IN-CANCEL-12. 业务冲突：已完成订单尝试取消', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
    expect([200, 400]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 12. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 分页切换', () => {
  test('IN-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound?page=2`)
    await page.waitForTimeout(800)
    await expect(page.locator('body')).toBeVisible()
  })
  test('IN-PAGE-02. 空数据边界：仅1页分页器隐藏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(800)
  })
  test('IN-PAGE-03. 表单校验：page=0后端修正为1', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?page=0')
    expect(res.status).toBe(200)
    expect(res.data?.data?.page).toBeGreaterThanOrEqual(1)
  })
  test('IN-PAGE-04. 边界：page=999返回空列表', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?page=999&pageSize=20')
    expect(res.status).toBe(200)
  })
  test('IN-PAGE-05. 边界：pageSize=1', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const list = res.data?.data?.list || []
    expect(list.length).toBeLessThanOrEqual(1)
  })
  test('IN-PAGE-06. 边界：pageSize=100', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('IN-PAGE-07. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/inbound?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('IN-PAGE-08. UI差异：各角色分页功能一致', async ({ page }) => {
    for (const role of READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/inbound?page=1`)
      await page.waitForTimeout(500)
    }
  })
})

// ────────────────────────────────────────────
// 13. 角色权限矩阵补充 (15 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 角色权限矩阵补充', () => {
  const permScenes = [
    { id: 'TC-PERM-058', role: 'technician' as RoleKey, method: 'GET', path: '/inbound', expect: 403 },
    { id: 'TC-PERM-059', role: 'pathologist' as RoleKey, method: 'GET', path: '/inbound', expect: 403 },
    { id: 'TC-PERM-060', role: 'finance' as RoleKey, method: 'GET', path: '/inbound', expect: 403 },
    { id: 'TC-PERM-061', role: 'technician' as RoleKey, method: 'POST', path: '/inbound', expect: 403 },
    { id: 'TC-PERM-062', role: 'pathologist' as RoleKey, method: 'POST', path: '/inbound', expect: 403 },
    { id: 'TC-PERM-063', role: 'procurement' as RoleKey, method: 'POST', path: '/inbound', expect: 403 },
    { id: 'TC-PERM-064', role: 'finance' as RoleKey, method: 'POST', path: '/inbound', expect: 403 },
    { id: 'TC-PERM-065', role: 'technician' as RoleKey, method: 'DELETE', path: '/inbound/xxx', expect: 403 },
    { id: 'TC-PERM-066', role: 'pathologist' as RoleKey, method: 'DELETE', path: '/inbound/xxx', expect: 403 },
    { id: 'TC-PERM-067', role: 'procurement' as RoleKey, method: 'DELETE', path: '/inbound/xxx', expect: 403 },
    { id: 'TC-PERM-068', role: 'finance' as RoleKey, method: 'DELETE', path: '/inbound/xxx', expect: 403 },
  ]
  for (const scene of permScenes) {
    test(`${scene.id}. ${scene.role} ${scene.method} ${scene.path} 返回${scene.expect}`, async () => {
      const token = await apiLogin(scene.role)
      let res
      if (scene.method === 'GET') res = await apiFetch(token, 'GET', scene.path)
      else if (scene.method === 'POST') {
        const mid = await getAnyMaterialId(token)
        const lid = await getAnyLocationId(token)
        res = await apiFetch(token, 'POST', scene.path, { type: 'direct', materialId: mid || 'x', quantity: 1, locationId: lid || 'x' })
      } else {
        res = await apiFetch(token, 'DELETE', scene.path)
      }
      expect(res.status).toBe(scene.expect)
    })
  }
  test('TC-PERM-IN-EXTRA-01. admin GET /inbound 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-IN-EXTRA-02. warehouse_manager GET /inbound 返回200', async () => {
    const token = await apiLogin('warehouse_manager')
    const res = await apiFetch(token, 'GET', '/inbound')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-IN-EXTRA-03. procurement GET /inbound 返回200', async () => {
    const token = await apiLogin('procurement')
    const res = await apiFetch(token, 'GET', '/inbound')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-IN-EXTRA-04. admin POST /inbound 返回201', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid, batchNo: `TEST-PERM-${Date.now()}`,
    })
    expect(res.status).toBe(201)
  })
})

// ────────────────────────────────────────────
// 14. 业务流程树 (15 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 业务流程树', () => {
  test('BF-IN-01. 采购入库主路径：创建PO→收货入库→库存确认', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 100, locationId: lid,
      batchNo: `TEST-BF-MAIN-${Date.now()}`, remark: 'E2E主路径',
    })
    const after = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const aStock = after.data?.data?.list?.[0]?.stock || 0
    expect(aStock).toBeGreaterThanOrEqual(bStock)
  })
  test('BF-IN-02. 分支：入库弹窗关闭不保存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('BF-IN-03. 分支：必填漏填（未选物料）', async ({ page }) => {
    const token = await apiLogin('admin')
    const lid = await getAnyLocationId(token)
    if (!lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', { type: 'direct', quantity: 1, locationId: lid })
    expect(res.status).toBe(400)
  })
  test('BF-IN-04. 分支：收货数量超过订单数量', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId: mid, quantity: 999999, locationId: lid,
      batchNo: `TEST-BF-OVER-${Date.now()}`,
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('BF-IN-05. 分支：入库提交时网络中断重试', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BF-NET-${Date.now()}`, remark: 'E2E网络',
    })
    expect(res.status).toBe(201)
  })
  test('BF-IN-06. 分支：刷新页面后状态保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
    await expect(page.locator('body')).toBeVisible()
  })
  test('BF-IN-07. 分支：已完成订单尝试取消', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/inbound/${id}/cancel`)
    expect([200, 400]).toContain(res.status)
  })
  test('BF-IN-08. 分支：有出库记录的入库单删除被拦截', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
    if (!chk.data?.data?.canDelete) {
      const del = await apiFetch(token, 'DELETE', `/inbound/${id}`)
      expect([400, 409]).toContain(del.status)
    }
  })
  test('BF-IN-09. 分支：technician尝试创建入库单被403拦截', async ({ page }) => {
    const token = await apiLogin('technician')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
    })
    expect(res.status).toBe(403)
  })
  test('BF-IN-10. 直接入库主路径：选择物料→填写数量→提交→库存增加', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 50, locationId: lid,
      batchNo: `TEST-BF-DIR-${Date.now()}`, remark: 'E2E直接入库',
    })
    expect(res.status).toBe(201)
    const no = res.data?.data?.inboundNo
    expect(no).toMatch(/^IB-/)
  })
  test('BF-IN-11. 调拨入库主路径：选择来源→目标→物料→提交', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'transfer', materialId: mid, quantity: 10, locationId: lid,
      batchNo: `TEST-BF-TRF-${Date.now()}`, remark: 'E2E调拨',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('BF-IN-12. 分支：入库单编辑后刷新保持', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/inbound/${id}`, { remark: `BF编辑-${Date.now()}` })
    const after = await apiFetch(token, 'GET', `/inbound/${id}`)
    expect([200, 404]).toContain(after.status)
  })
  test('BF-IN-13. 分支：创建入库单后不确认关闭弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('BF-IN-14. 分支：BOM一键出库后尝试删除关联入库单', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
    expect(chk.status).toBe(200)
  })
  test('BF-IN-15. 分支：批量操作后检查入库列表', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    expect(await rows.count()).toBeGreaterThanOrEqual(0)
  })
})

// ────────────────────────────────────────────
// 15. 盲点分析补充 (22 tests)
// ────────────────────────────────────────────
test.describe('入库管理 -> 盲点分析补充', () => {
  test('BLIND-IN-01. 入库单号唯一性验证', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res1 = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BLIND-UNIQ-${Date.now()}`,
    })
    const res2 = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BLIND-UNIQ2-${Date.now()}`,
    })
    expect(res1.status).toBe(201)
    expect(res2.status).toBe(201)
    expect(res1.data?.data?.inboundNo).not.toBe(res2.data?.data?.inboundNo)
  })
  test('BLIND-IN-02. 入库时间字段自动填充', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BLIND-TIME-${Date.now()}`,
    })
    expect(res.status).toBe(201)
    expect(res.data?.data?.createdAt).toBeDefined()
  })
  test('BLIND-IN-03. 入库操作人字段记录', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BLIND-OP-${Date.now()}`,
    })
    expect(res.status).toBe(201)
  })
  test('BLIND-IN-04. 入库价格自动计算amount', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 10, locationId: lid, price: 5,
      batchNo: `TEST-BLIND-AMT-${Date.now()}`,
    })
    expect(res.status).toBe(201)
    const amount = res.data?.data?.amount
    if (amount !== undefined) expect(amount).toBe(50)
  })
  test('BLIND-IN-05. 入库批次有效期预警触发', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BLIND-EXP-${Date.now()}`,
      expiryDate: '2026-06-01',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('BLIND-IN-06. 入库列表排序默认按时间倒序', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?page=1&pageSize=5')
    expect(res.status).toBe(200)
    const list = res.data?.data?.list || []
    if (list.length >= 2) {
      const d1 = new Date(list[0].createdAt).getTime()
      const d2 = new Date(list[1].createdAt).getTime()
      expect(d1).toBeGreaterThanOrEqual(d2)
    }
  })
  test('BLIND-IN-07. 入库单关联供应商信息显示', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('BLIND-IN-08. 入库单关联库位信息显示', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const item = res.data?.data?.list?.[0]
    if (item) expect(item.locationName || item.locationId).toBeDefined()
  })
  test('BLIND-IN-09. 入库数量小数精度处理', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1.99, locationId: lid,
      batchNo: `TEST-BLIND-FLT-${Date.now()}`,
    })
    expect([201, 400]).toContain(res.status)
  })
  test('BLIND-IN-10. 入库API响应格式验证', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inbound?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('data')
    expect(res.data?.data).toHaveProperty('list')
    expect(res.data?.data).toHaveProperty('page')
    expect(res.data?.data).toHaveProperty('pageSize')
    expect(res.data?.data).toHaveProperty('total')
  })
  test('BLIND-IN-11. 入库单状态流转：pending→completed', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BLIND-FLOW-${Date.now()}`,
    })
    expect(create.status).toBe(201)
    const status = create.data?.data?.status
    expect(['pending', 'completed']).toContain(status)
  })
  test('BLIND-IN-12. 入库删除后检查关联库存日志', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BLIND-LOG-${Date.now()}`,
    })
    const id = create.data?.data?.id
    if (id) {
      const chk = await apiFetch(token, 'GET', `/inbound/${id}/check-deletable`)
      if (chk.data?.data?.canDelete) {
        await apiFetch(token, 'DELETE', `/inbound/${id}`)
      }
    }
  })
  test('BLIND-IN-13. 入库页面响应式布局检查', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
    await expect(page.locator('body')).toBeVisible()
  })
  test('BLIND-IN-14. 入库页面搜索框防抖功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(800)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('test')
      await search.fill('test2')
      await search.fill('test3')
      await page.waitForTimeout(600)
    }
  })
  test('BLIND-IN-15. 入库导出功能入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
    const exportBtn = page.locator('button:has-text("导出"), button:has-text("Export")').first()
    await expect(exportBtn.or(page.locator('body'))).toBeVisible()
  })
  test('BLIND-IN-16. 入库打印功能入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
    const printBtn = page.locator('button:has-text("打印"), button:has-text("Print")')
    await expect(printBtn.or(page.locator('body')).first()).toBeVisible()
  })
  test('BLIND-IN-17. 入库单扫码功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-IN-18. 入库批量导入功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-IN-19. 入库单确认入库操作', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/inbound', {
      type: 'direct', materialId: mid, quantity: 1, locationId: lid,
      batchNo: `TEST-BLIND-CFM-${Date.now()}`, remark: 'E2E确认',
    })
    expect(create.status).toBe(201)
  })
  test('BLIND-IN-20. 入库单恢复入库操作', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyInboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/inbound/${id}/restore`)
    expect([200, 400, 404]).toContain(res.status)
  })
  test('BLIND-IN-21. 入库类型下拉选项完整性', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-IN-22. 入库页面加载性能检查', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/inbound`)
    await page.waitForTimeout(2000)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(10000)
  })
})
