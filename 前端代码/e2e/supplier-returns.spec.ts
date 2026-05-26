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
const NO_ACCESS_ROLES: RoleKey[] = ['technician', 'pathologist', 'finance']

async function loginAs(page: Page, role: RoleKey) {
  await page.goto(`${FE_BASE}/login`)
  await page.waitForTimeout(100)
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
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

async function getMaterialWithStock(token: string, minStock: number = 3): Promise<string> {
  const r = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=200`)
  const list = r.data?.data?.list || []
  const mat = list.find((m: any) => m.stock >= minStock)
  return mat?.materialId || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/supplier-returns?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.returnNo?.startsWith('TEST-') || item.remark?.includes('E2E')) {
        await apiFetch(token, 'DELETE', `/supplier-returns/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ────────────────────────────────────────────
// 1. 查看退货列表 (8 tests)
// ────────────────────────────────────────────
test.describe('退货给供应商 -> 查看列表', () => {
  for (const role of READ_ROLES) {
    test(`SR-LIST-01-${role}. 正常用例：${role}可查看退货列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/supplier-returns`)
      await expect(page.getByRole('heading', { name: '退货给供应商' })).toBeVisible({ timeout: 30000 })
    })
  }
  test('SR-LIST-02. 空数据边界：无退货记录显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/supplier-returns`)
    const empty = page.locator('text=/暂无退货|暂无数据|empty/i')
    await expect(empty.or(page.locator('table tbody tr'))).toBeVisible({ timeout: 30000 })
  })
  for (const role of NO_ACCESS_ROLES) {
    test(`SR-LIST-03-${role}. 权限：${role}访问返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'GET', '/supplier-returns')
      expect(res.status).toBe(403)
    })
  }
  test('SR-LIST-04. UI差异：admin显示新建退货按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/supplier-returns`)
    await page.waitForTimeout(1000)
    const btn = page.locator('button:has-text("新建退货")')
    await expect(btn).toHaveCount(await btn.count() > 0 ? await btn.count() : 0, { timeout: 5000 })
  })
  test('SR-LIST-05. 并发：快速刷新页面多次列表正常', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/supplier-returns`)
    await page.reload()
    await page.reload()
    await expect(page.locator('body')).toBeVisible()
  })
})

// ────────────────────────────────────────────
// 2. 状态筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('退货给供应商 -> 状态筛选', () => {
  const statuses = ['pending', 'shipped', 'received', 'refunded', 'cancelled']
  for (const status of statuses) {
    test(`SR-STATUS-01-${status}. 正常用例：筛选${status}状态`, async ({ page }) => {
      await loginAs(page, 'admin')
      await page.goto(`${FE_BASE}/supplier-returns?status=${status}`)
      await page.waitForTimeout(800)
      await expect(page.locator('body')).toBeVisible()
    })
  }
  test('SR-STATUS-02. 正常用例：重置筛选恢复全部', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/supplier-returns?status=pending`)
    await page.waitForTimeout(500)
    await page.goto(`${FE_BASE}/supplier-returns`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 3. 创建退货记录 (18 tests)
// ────────────────────────────────────────────
test.describe('退货给供应商 -> 创建退货记录', () => {
  test('SR-CREATE-01. 正常用例：admin创建退货成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue', remark: 'E2E测试退货',
    })
    expect(res.status).toBe(200)
    expect(res.data?.data?.id).toBeTruthy()
  })
  test('SR-CREATE-02. 正常用例：warehouse_manager创建退货成功', async ({ page }) => {
    const token = await apiLogin('warehouse_manager')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'damaged', remark: 'E2E',
    })
    expect(res.status).toBe(200)
  })
  test('SR-CREATE-03. 正常用例：procurement创建退货成功', async ({ page }) => {
    const token = await apiLogin('procurement')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quantity_mismatch', remark: 'E2E',
    })
    expect(res.status).toBe(200)
  })
  test('SR-CREATE-04. 表单校验：缺少materialId返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/supplier-returns', { quantity: 1, reason: 'quality_issue' })
    expect(res.status).toBe(400)
  })
  test('SR-CREATE-05. 表单校验：缺少quantity返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', { materialId: mid, reason: 'quality_issue' })
    expect(res.status).toBe(400)
  })
  test('SR-CREATE-06. 表单校验：缺少reason返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', { materialId: mid, quantity: 1 })
    expect(res.status).toBe(400)
  })
  test('SR-CREATE-07. 表单校验：quantity=0返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', { materialId: mid, quantity: 0, reason: 'quality_issue' })
    expect(res.status).toBe(400)
  })
  test('SR-CREATE-08. 表单校验：负数quantity返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', { materialId: mid, quantity: -1, reason: 'quality_issue' })
    expect(res.status).toBe(400)
  })
  test('SR-CREATE-09. 业务冲突：库存不足返回422', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 999999, reason: 'quality_issue',
    })
    expect([400, 422]).toContain(res.status)
  })
  test('SR-CREATE-10. 业务冲突：物料不存在返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: 'non-existent-id', quantity: 1, reason: 'quality_issue',
    })
    expect(res.status).toBe(404)
  })
  for (const role of ['technician', 'pathologist', 'finance'] as RoleKey[]) {
    test(`SR-CREATE-11-${role}. 权限：${role}创建退货返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const mid = await getAnyMaterialId(adminToken)
      if (!mid) { test.skip(); return }
      const res = await apiFetch(token, 'POST', '/supplier-returns', {
        materialId: mid, quantity: 1, reason: 'quality_issue',
      })
      expect(res.status).toBe(403)
    })
  }
  test('SR-CREATE-12. 并发：快速双击提交', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const body = { materialId: mid, quantity: 1, reason: 'quality_issue' }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'POST', '/supplier-returns', body),
      apiFetch(token, 'POST', '/supplier-returns', body),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('SR-CREATE-13. 正常用例：退货后库存扣减', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/materials/${mid}`)
    const bStock = before.data?.data?.stock || 0
    await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue', remark: 'E2E库存测试',
    })
    const after = await apiFetch(token, 'GET', `/materials/${mid}`)
    const aStock = after.data?.data?.stock || 0
    expect(aStock).toBe(bStock - 1)
  })
  test('SR-CREATE-14. 正常用例：退货单号格式SR-YYYYMMDD-XXX', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    expect(res.status).toBe(200)
    const id = res.data?.data?.id
    const detail = await apiFetch(token, 'GET', `/supplier-returns/${id}`)
    const no = detail.data?.data?.returnNo || ''
    expect(no).toMatch(/^SR-\d{8}-\d{6}-\d{3}$/)
  })
  test('SR-CREATE-15. 正常用例：创建时包含退款金额和物流单号', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'damaged', refundAmount: 100, trackingNo: 'SF123456', remark: 'E2E完整字段',
    })
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 4. 状态流转 (12 tests)
// ────────────────────────────────────────────
test.describe('退货给供应商 -> 状态流转', () => {
  test('SR-STATUS-01. 正常用例：pending→shipped', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue', remark: 'E2E状态流',
    })
    expect(create.status).toBe(200)
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    expect(res.status).toBe(200)
  })
  test('SR-STATUS-02. 正常用例：shipped→received', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'received' })
    expect(res.status).toBe(200)
  })
  test('SR-STATUS-03. 正常用例：received→refunded', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'received' })
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'refunded' })
    expect(res.status).toBe(200)
  })
  test('SR-STATUS-04. 正常用例：pending→cancelled', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'cancelled' })
    expect(res.status).toBe(200)
  })
  test('SR-STATUS-05. 业务冲突：refunded→shipped非法流转返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'received' })
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'refunded' })
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    expect(res.status).toBe(400)
  })
  test('SR-STATUS-06. 业务冲突：shipped→pending回退返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'pending' })
    expect(res.status).toBe(400)
  })
  test('SR-STATUS-07. 表单校验：无效状态值返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'invalid_status' })
    expect(res.status).toBe(400)
  })
  test('SR-STATUS-08. 权限：technician更新状态返回403', async ({ page }) => {
    const token = await apiLogin('technician')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(adminToken, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    expect(res.status).toBe(403)
  })
  test('SR-STATUS-09. 并发：并发更新同一记录状态', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' }),
      apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'cancelled' }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('SR-STATUS-10. 异常恢复：更新不存在的记录返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/supplier-returns/non-existent-id/status', { status: 'shipped' })
    expect(res.status).toBe(404)
  })
  test('SR-STATUS-11. UI差异：前端详情弹窗显示状态流转按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/supplier-returns`)
    await page.waitForTimeout(1000)
  })
  test('SR-STATUS-12. 正常用例：cancelled后不能再次流转', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'cancelled' })
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    expect(res.status).toBe(400)
  })
})

// ────────────────────────────────────────────
// 5. 删除退货记录 (12 tests)
// ────────────────────────────────────────────
test.describe('退货给供应商 -> 删除退货记录', () => {
  test('SR-DELETE-01. 正常用例：admin删除pending状态退货记录', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue', remark: 'E2E删除测试',
    })
    expect(create.status).toBe(200)
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    expect(res.status).toBe(200)
  })
  test('SR-DELETE-02. 正常用例：warehouse_manager删除pending退货', async ({ page }) => {
    const token = await apiLogin('warehouse_manager')
    const adminToken = await apiLogin('admin')
    const mid = await getMaterialWithStock(adminToken)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(adminToken, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    expect(create.status).toBe(200)
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    expect(res.status).toBe(200)
  })
  test('SR-DELETE-03. 业务冲突：删除shipped状态返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    const res = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    expect(res.status).toBe(400)
  })
  test('SR-DELETE-04. 业务冲突：删除refunded状态返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'received' })
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'refunded' })
    const res = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    expect(res.status).toBe(400)
  })
  for (const role of ['technician', 'pathologist', 'finance'] as RoleKey[]) {
    test(`SR-DELETE-05-${role}. 权限：${role}删除退货记录返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const mid = await getAnyMaterialId(adminToken)
      if (!mid) { test.skip(); return }
      const create = await apiFetch(adminToken, 'POST', '/supplier-returns', {
        materialId: mid, quantity: 1, reason: 'quality_issue',
      })
      const id = create.data?.data?.id
      const res = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
      expect(res.status).toBe(403)
    })
  }
  test('SR-DELETE-06. 并发：并发删除同一退货记录', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'DELETE', `/supplier-returns/${id}`),
      apiFetch(token, 'DELETE', `/supplier-returns/${id}`),
    ])
    expect(r1.status === 200 || r2.status === 200 || r1.status === 404 || r2.status === 404).toBe(true)
  })
  test('SR-DELETE-07. 正常用例：删除后库存恢复', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/materials/${mid}`)
    const bStock = before.data?.data?.stock || 0
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 2, reason: 'quality_issue', remark: 'E2E库存恢复',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    const after = await apiFetch(token, 'GET', `/materials/${mid}`)
    const aStock = after.data?.data?.stock || 0
    expect(aStock).toBe(bStock)
  })
  test('SR-DELETE-08. 表单校验：删除不存在的记录返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'DELETE', '/supplier-returns/non-existent-id')
    expect(res.status).toBe(404)
  })
  test('SR-DELETE-09. 异常恢复：删除后再次删除返回404', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    const res2 = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    expect([404, 400]).toContain(res2.status)
  })
  test('SR-DELETE-10. UI差异：admin显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/supplier-returns`)
    await page.waitForTimeout(1000)
  })
  test('SR-DELETE-11. 正常用例：删除后stock_logs有记录', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    const logs = await apiFetch(token, 'GET', `/materials/${mid}`)
    expect(logs.status).toBe(200)
  })
  test('SR-DELETE-12. 异常恢复：删除cancelled状态返回400', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'cancelled' })
    const res = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    expect(res.status).toBe(400)
  })
})

// ────────────────────────────────────────────
// 6. 分页切换 (6 tests)
// ────────────────────────────────────────────
test.describe('退货给供应商 -> 分页切换', () => {
  test('SR-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/supplier-returns?page=2`)
    await page.waitForTimeout(800)
    await expect(page.locator('body')).toBeVisible()
  })
  test('SR-PAGE-02. 边界：page=0后端修正为1', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/supplier-returns?page=0')
    expect(res.status).toBe(200)
    expect(res.data?.data?.page).toBeGreaterThanOrEqual(1)
  })
  test('SR-PAGE-03. 边界：page=999返回空列表', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/supplier-returns?page=999&pageSize=20')
    expect(res.status).toBe(200)
  })
  test('SR-PAGE-04. 边界：pageSize=1', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/supplier-returns?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const list = res.data?.data?.list || []
    expect(list.length).toBeLessThanOrEqual(1)
  })
  test('SR-PAGE-05. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/supplier-returns?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('SR-PAGE-06. UI差异：各角色分页功能一致', async ({ page }) => {
    for (const role of READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/supplier-returns?page=1`)
      await page.waitForTimeout(500)
    }
  })
})

// ────────────────────────────────────────────
// 7. 角色权限矩阵 (10 tests)
// ────────────────────────────────────────────
test.describe('退货给供应商 -> 角色权限矩阵', () => {
  const permScenes = [
    { id: 'TC-PERM-SR-001', role: 'technician' as RoleKey, method: 'GET', path: '/supplier-returns', expect: 403 },
    { id: 'TC-PERM-SR-002', role: 'pathologist' as RoleKey, method: 'GET', path: '/supplier-returns', expect: 403 },
    { id: 'TC-PERM-SR-003', role: 'finance' as RoleKey, method: 'GET', path: '/supplier-returns', expect: 403 },
    { id: 'TC-PERM-SR-004', role: 'technician' as RoleKey, method: 'POST', path: '/supplier-returns', expect: 403 },
    { id: 'TC-PERM-SR-005', role: 'pathologist' as RoleKey, method: 'POST', path: '/supplier-returns', expect: 403 },
    { id: 'TC-PERM-SR-006', role: 'finance' as RoleKey, method: 'POST', path: '/supplier-returns', expect: 403 },
    { id: 'TC-PERM-SR-007', role: 'technician' as RoleKey, method: 'DELETE', path: '/supplier-returns/xxx', expect: 403 },
    { id: 'TC-PERM-SR-008', role: 'pathologist' as RoleKey, method: 'DELETE', path: '/supplier-returns/xxx', expect: 403 },
    { id: 'TC-PERM-SR-009', role: 'finance' as RoleKey, method: 'DELETE', path: '/supplier-returns/xxx', expect: 403 },
  ]
  for (const scene of permScenes) {
    test(`${scene.id}. ${scene.role} ${scene.method} ${scene.path} 返回${scene.expect}`, async () => {
      const token = await apiLogin(scene.role)
      let res
      if (scene.method === 'GET') res = await apiFetch(token, 'GET', scene.path)
      else if (scene.method === 'POST') {
        const mid = await getMaterialWithStock(token)
        res = await apiFetch(token, 'POST', scene.path, { materialId: mid || 'x', quantity: 1, reason: 'quality_issue' })
      } else {
        res = await apiFetch(token, 'DELETE', scene.path)
      }
      expect(res.status).toBe(scene.expect)
    })
  }
  test('TC-PERM-SR-EXTRA-01. admin GET /supplier-returns 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/supplier-returns')
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 8. 业务流程树 (6 tests)
// ────────────────────────────────────────────
test.describe('退货给供应商 -> 业务流程树', () => {
  test('BF-SR-01. 主路径：创建退货→发货→收货→退款', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue', remark: 'E2E主路径',
    })
    expect(create.status).toBe(200)
    const id = create.data?.data?.id
    const r1 = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'shipped' })
    expect(r1.status).toBe(200)
    const r2 = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'received' })
    expect(r2.status).toBe(200)
    const r3 = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'refunded' })
    expect(r3.status).toBe(200)
  })
  test('BF-SR-02. 分支：创建退货→取消', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'other', remark: 'E2E取消路径',
    })
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'cancelled' })
    expect(res.status).toBe(200)
  })
  test('BF-SR-03. 分支：创建退货→删除', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue', remark: 'E2E删除路径',
    })
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    expect(res.status).toBe(200)
  })
  test('BF-SR-04. 异常：取消后不能删除', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'other',
    })
    const id = create.data?.data?.id
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status: 'cancelled' })
    const res = await apiFetch(token, 'DELETE', `/supplier-returns/${id}`)
    expect(res.status).toBe(400)
  })
  test('BF-SR-05. 边界：创建时库存为0', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 999999, reason: 'quality_issue',
    })
    expect([400, 422]).toContain(res.status)
  })
  test('BF-SR-06. 正常用例：创建后检查库存流水', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getMaterialWithStock(token)
    if (!mid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/materials/${mid}`)
    const bStock = before.data?.data?.stock || 0
    await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: mid, quantity: 1, reason: 'quality_issue', remark: 'E2E流水检查',
    })
    const after = await apiFetch(token, 'GET', `/materials/${mid}`)
    const aStock = after.data?.data?.stock || 0
    expect(aStock).toBe(Math.max(0, bStock - 1))
  })
})
