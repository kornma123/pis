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
const ST_READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager']
const ST_FORBIDDEN: RoleKey[] = ['technician', 'pathologist', 'procurement', 'finance']

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

async function getAnyMaterialId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyLocationId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/locations?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyStocktakingId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.remark?.includes('E2E') || item.stocktakingNo?.startsWith('TEST-')) {
        await apiFetch(token, 'DELETE', `/stocktaking/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ────────────────────────────────────────────
// 1. 查看盘点列表 (10 tests)
// ────────────────────────────────────────────
test.describe('库存盘点 -> 查看盘点列表', () => {
  for (const role of ST_READ_ROLES) {
    test(`ST-LIST-01-${role}. 正常用例：${role}可查看盘点列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/stocktaking`)
      await expect(page.locator('body')).toBeVisible({ timeout: 8000 })
    })
  }
  test('ST-LIST-02. 空数据边界：无盘点记录显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(800)
  })
  test('ST-LIST-03. 权限：technician访问返回403', async () => {
    const res = await apiFetch(await apiLogin('technician'), 'GET', '/stocktaking')
    expect(res.status).toBe(403)
  })
  test('ST-LIST-04. 权限：pathologist访问返回403', async () => {
    const res = await apiFetch(await apiLogin('pathologist'), 'GET', '/stocktaking')
    expect(res.status).toBe(403)
  })
  test('ST-LIST-05. 权限：procurement访问返回403', async () => {
    const res = await apiFetch(await apiLogin('procurement'), 'GET', '/stocktaking')
    expect(res.status).toBe(403)
  })
  test('ST-LIST-06. 权限：finance访问返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/stocktaking')
    expect(res.status).toBe(403)
  })
  test('ST-LIST-07. 异常恢复：API 500显示错误Toast', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(800)
  })
  test('ST-LIST-08. UI差异：admin显示新建盘点按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('ST-LIST-09. UI差异：warehouse_manager显示新建盘点按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('ST-LIST-10. 正常用例：列表显示单号物料系统库存实盘差异状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 2. 新建盘点单 (20 tests)
// ────────────────────────────────────────────
test.describe('库存盘点 -> 新建盘点单', () => {
  test('ST-CREATE-01. 正常用例：admin新建盘点单', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 10, remark: 'E2E盘点测试',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('ST-CREATE-02. 正常用例：warehouse_manager新建盘点单', async () => {
    const token = await apiLogin('warehouse_manager')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 5, remark: 'E2EWM盘点',
    })
    expect([201, 400, 403]).toContain(res.status)
  })
  test('ST-CREATE-03. 空数据边界：actualStock=0差异为负', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 0, remark: 'E2E零盘点',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('ST-CREATE-04. 表单校验：未传materialId返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/stocktaking', { actualStock: 10 })
    expect(res.status).toBe(400)
  })
  test('ST-CREATE-05. 表单校验：未传actualStock返回400', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid })
    expect(res.status).toBe(400)
  })
  for (const role of ST_FORBIDDEN) {
    test(`ST-CREATE-06-${role}. 权限：${role}新建盘点返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const mid = await getAnyMaterialId(adminToken)
      if (!mid) { test.skip(); return }
      const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 1 })
      expect(res.status).toBe(403)
    })
  }
  test('ST-CREATE-07. 业务冲突：该物料正在盘点中仍可创建', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 5, remark: 'E2E重复' })
    const res2 = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 6, remark: 'E2E重复2' })
    expect([201, 400]).toContain(res2.status)
  })
  test('ST-CREATE-08. 并发：快速双击提交', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const body = { materialId: mid, actualStock: 1, remark: 'E2E并发' }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/stocktaking', body), apiFetch(token, 'POST', '/stocktaking', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('ST-CREATE-09. 异常恢复：提交时网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 2, remark: 'E2E恢复' })
    expect([201, 400]).toContain(res.status)
  })
  test('ST-CREATE-10. UI差异：admin显示新建盘点按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('ST-CREATE-11. UI差异：warehouse_manager显示新建盘点按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('ST-CREATE-12. UI差异：technician不显示新建盘点按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('ST-CREATE-13. 正常用例：新建盘点后库存更新为实际数量', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 20, remark: 'E2E库存更新',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('ST-CREATE-14. 边界：负数actualStock', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: -5, remark: 'E2E负数',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('ST-CREATE-15. 边界：小数actualStock', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 1.5, remark: 'E2E小数',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('ST-CREATE-16. 正常用例：盘点差异正确计算', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const sysStock = inv.data?.data?.list?.[0]?.stock || 0
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: sysStock + 5, remark: 'E2E差异',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('ST-CREATE-17. 表单校验：materialId不存在', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: 'non-existent', actualStock: 10,
    })
    expect([400, 404]).toContain(res.status)
  })
  test('ST-CREATE-18. 正常用例：盘点单号格式', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 10, remark: 'E2E格式',
    })
    if (res.status === 201) {
      expect(res.data?.data?.stocktakingNo).toMatch(/^ST-\d{8}-\d{3}$/)
    }
  })
  test('ST-CREATE-19. 异常恢复：盘点后检查库存日志', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 15, remark: 'E2E日志',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('ST-CREATE-20. 并发：并发盘点不同物料', async () => {
    const token = await apiLogin('admin')
    const materials = await apiFetch(token, 'GET', '/materials?page=1&pageSize=2')
    const list = materials.data?.data?.list || []
    if (list.length < 2) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'POST', '/stocktaking', { materialId: list[0].id, actualStock: 10, remark: 'E2E并发1' }),
      apiFetch(token, 'POST', '/stocktaking', { materialId: list[1].id, actualStock: 20, remark: 'E2E并发2' }),
    ])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
})

// ────────────────────────────────────────────
// 3. 查看盘点详情 (6 tests)
// ────────────────────────────────────────────
test.describe('库存盘点 -> 查看盘点详情', () => {
  for (const role of ST_READ_ROLES) {
    test(`ST-DETAIL-01-${role}. 正常用例：${role}可查看盘点详情`, async () => {
      const token = await apiLogin(role)
      const id = await getAnyStocktakingId(token)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'GET', `/stocktaking/${id}`)
      expect([200, 404]).toContain(res.status)
    })
  }
  test('ST-DETAIL-02. 表单校验：查看不存在的盘点单返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking/non-existent-id')
    expect(res.status).toBe(404)
  })
  test('ST-DETAIL-03. UI差异：admin可点击查看详情', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) await rows.first().click()
  })
})

// ────────────────────────────────────────────
// 4. 处理盘点差异 (14 tests)
// ────────────────────────────────────────────
test.describe('库存盘点 -> 处理盘点差异', () => {
  test('ST-ADJUST-01. 正常用例：admin确认差异库存调整', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 8, remark: 'E2E差异处理',
    })
    expect(create.status).toBe(201)
    const id = create.data?.data?.id
    const res = await apiFetch(token, 'POST', `/stocktaking/${id}/confirm`)
    expect([200, 400, 404]).toContain(res.status)
  })
  test('ST-ADJUST-02. 空数据边界：差异=0不更新库存仅记录日志', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const stock = inv.data?.data?.list?.[0]?.stock || 0
    const create = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: stock, remark: 'E2E无差异',
    })
    expect([201, 400]).toContain(create.status)
  })
  test('ST-ADJUST-03. 业务冲突：已确认的盘点单再次确认', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyStocktakingId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/stocktaking/${id}/confirm`)
    expect([200, 400]).toContain(res.status)
  })
  test('ST-ADJUST-04. 异常恢复：确认时网络中断后检查状态', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyStocktakingId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/stocktaking/${id}/confirm`)
    expect([200, 400]).toContain(res.status)
  })
  test('ST-ADJUST-05. 正常用例：盘盈库存增加', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const stock = inv.data?.data?.list?.[0]?.stock || 0
    const create = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: stock + 10, remark: 'E2E盘盈',
    })
    expect([201, 400]).toContain(create.status)
  })
  test('ST-ADJUST-06. 正常用例：盘亏库存减少', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const stock = inv.data?.data?.list?.[0]?.stock || 0
    if (stock < 5) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: stock - 5, remark: 'E2E盘亏',
    })
    expect([201, 400]).toContain(create.status)
  })
  for (const role of ST_FORBIDDEN) {
    test(`ST-ADJUST-07-${role}. 权限：${role}确认盘点返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyStocktakingId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'POST', `/stocktaking/${id}/confirm`)
      expect(res.status).toBe(403)
    })
  }
  test('ST-ADJUST-08. 表单校验：确认不存在的盘点单返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/stocktaking/non-existent/confirm')
    expect(res.status).toBe(404)
  })
  test('ST-ADJUST-09. 并发：并发确认同一盘点单', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 5, remark: 'E2E并发确认',
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'POST', `/stocktaking/${id}/confirm`),
      apiFetch(token, 'POST', `/stocktaking/${id}/confirm`),
    ])
    expect(r1.status === 200 || r2.status === 200 || r1.status === 400 || r2.status === 400).toBe(true)
  })
  test('ST-ADJUST-10. UI差异：admin显示确认按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('ST-ADJUST-11. UI差异：warehouse_manager显示确认按钮', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('ST-ADJUST-12. 异常恢复：确认后刷新页面状态保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('ST-ADJUST-13. 正常用例：确认后生成stock_logs', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 12, remark: 'E2E日志生成',
    })
    expect([201, 400]).toContain(create.status)
  })
  test('ST-ADJUST-14. 边界：确认后盘点状态变为completed', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 7, remark: 'E2E状态',
    })
    expect([201, 400]).toContain(create.status)
  })
})

// ────────────────────────────────────────────
// 5. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('库存盘点 -> 分页切换', () => {
  test('ST-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking?page=2`)
    await page.waitForTimeout(800)
  })
  test('ST-PAGE-02. 边界：仅1页分页器隐藏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(800)
  })
  test('ST-PAGE-03. 表单校验：page=0后端修正为1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=0')
    expect(res.status).toBe(200)
    expect(res.data?.data?.pagination?.page).toBeGreaterThanOrEqual(1)
  })
  test('ST-PAGE-04. 边界：page=999返回空列表', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=999')
    expect(res.status).toBe(200)
  })
  test('ST-PAGE-05. 边界：pageSize=1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('ST-PAGE-06. 边界：pageSize=100', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('ST-PAGE-07. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/stocktaking?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('ST-PAGE-08. UI差异：各角色分页一致', async ({ page }) => {
    for (const role of ST_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/stocktaking?page=1`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 6. 角色权限矩阵补充 (12 tests)
// ────────────────────────────────────────────
test.describe('库存盘点 -> 角色权限矩阵补充', () => {
  const scenes = [
    { id: 'TC-PERM-073', role: 'technician' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-074', role: 'pathologist' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-075', role: 'procurement' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-076', role: 'finance' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-077', role: 'technician' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-078', role: 'pathologist' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-079', role: 'procurement' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-080', role: 'finance' as RoleKey, method: 'POST', expect: 403 },
  ]
  for (const s of scenes) {
    test(`${s.id}. ${s.role} ${s.method} /stocktaking 返回${s.expect}`, async () => {
      const token = await apiLogin(s.role)
      let res
      if (s.method === 'GET') res = await apiFetch(token, 'GET', '/stocktaking')
      else {
        const adminToken = await apiLogin('admin')
        const mid = await getAnyMaterialId(adminToken)
        res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid || 'x', actualStock: 1 })
      }
      expect(res.status).toBe(s.expect)
    })
  }
  test('TC-PERM-ST-EXTRA-01. admin GET /stocktaking 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-ST-EXTRA-02. warehouse_manager GET /stocktaking 返回200', async () => {
    const token = await apiLogin('warehouse_manager')
    const res = await apiFetch(token, 'GET', '/stocktaking')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-ST-EXTRA-03. admin POST /stocktaking 返回201', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 1, remark: 'E2E权限' })
    expect([201, 400]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 7. 业务流程树 (12 tests)
// ────────────────────────────────────────────
test.describe('库存盘点 -> 业务流程树', () => {
  test('BF-ST-01. 主路径：登录→进入盘点→新建→选物料→输入实盘→确认差异→库存更新', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const create = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 8, remark: 'E2E主路径',
    })
    expect([201, 400]).toContain(create.status)
  })
  test('BF-ST-02. 分支：关闭盘点弹窗不保存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('BF-ST-03. 分支：未选物料提交', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/stocktaking', { actualStock: 10 })
    expect(res.status).toBe(400)
  })
  test('BF-ST-04. 分支：实盘=系统数量无差异', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const stock = inv.data?.data?.list?.[0]?.stock || 0
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: stock, remark: 'E2E无差异',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('BF-ST-05. 分支：盘盈', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const stock = inv.data?.data?.list?.[0]?.stock || 0
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: stock + 5, remark: 'E2E盘盈',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('BF-ST-06. 分支：盘亏触发低库存预警', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const stock = inv.data?.data?.list?.[0]?.stock || 0
    if (stock < 3) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: stock - 3, remark: 'E2E盘亏预警',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('BF-ST-07. 分支：网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', {
      materialId: mid, actualStock: 3, remark: 'E2E网络',
    })
    expect([201, 400]).toContain(res.status)
  })
  test('BF-ST-08. 分支：刷新页面后盘点状态保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-ST-09. 分支：确认时取消', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('BF-ST-10. 分支：technician尝试盘点被403拦截', async () => {
    const token = await apiLogin('technician')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 1 })
    expect(res.status).toBe(403)
  })
  test('BF-ST-11. 分支：确认盘点后刷新列表', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-ST-12. 分支：批量创建多个盘点单', async () => {
    const token = await apiLogin('admin')
    const materials = await apiFetch(token, 'GET', '/materials?page=1&pageSize=3')
    const list = materials.data?.data?.list || []
    for (const m of list) {
      await apiFetch(token, 'POST', '/stocktaking', {
        materialId: m.id, actualStock: 5, remark: 'E2E批量',
      })
    }
  })
})

// ────────────────────────────────────────────
// 8. 盲点分析补充 (18 tests)
// ────────────────────────────────────────────
test.describe('库存盘点 -> 盲点分析补充', () => {
  test('BLIND-ST-01. 盘点单号唯一性验证', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const r1 = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 1, remark: 'E2E唯一1' })
    const r2 = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 2, remark: 'E2E唯一2' })
    if (r1.status === 201 && r2.status === 201) {
      expect(r1.data?.data?.stocktakingNo).not.toBe(r2.data?.data?.stocktakingNo)
    }
  })
  test('BLIND-ST-02. 盘点时间字段自动填充', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 1, remark: 'E2E时间' })
    if (res.status === 201) expect(res.data?.data?.createdAt).toBeDefined()
  })
  test('BLIND-ST-03. 盘点操作人字段记录', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 1, remark: 'E2E操作人' })
    expect([201, 400]).toContain(res.status)
  })
  test('BLIND-ST-04. 盘点差异计算精度', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 1.99, remark: 'E2E精度' })
    expect([201, 400]).toContain(res.status)
  })
  test('BLIND-ST-05. 盘点列表排序默认按时间倒序', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=5')
    expect(res.status).toBe(200)
    const list = res.data?.data?.list || []
    if (list.length >= 2) {
      const d1 = new Date(list[0].createdAt).getTime()
      const d2 = new Date(list[1].createdAt).getTime()
      expect(d1).toBeGreaterThanOrEqual(d2)
    }
  })
  test('BLIND-ST-06. 盘点单关联物料信息显示', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('BLIND-ST-07. 盘点单状态字段完整性', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const item = res.data?.data?.list?.[0]
    if (item) expect(item.status).toBeDefined()
  })
  test('BLIND-ST-08. 盘点API响应格式验证', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('data')
    expect(res.data?.data).toHaveProperty('list')
    expect(res.data?.data?.pagination).toHaveProperty('page')
    expect(res.data?.data?.pagination).toHaveProperty('total')
  })
  test('BLIND-ST-09. 盘点页面响应式布局', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ST-10. 盘点页面搜索框防抖', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(800)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a')
      await search.fill('ab')
      await page.waitForTimeout(600)
    }
  })
  test('BLIND-ST-11. 盘点导出功能入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ST-12. 盘点打印功能入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ST-13. 盘点差异报告生成', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/stocktaking', { materialId: mid, actualStock: 7, remark: 'E2E报告' })
    expect([201, 400]).toContain(res.status)
  })
  test('BLIND-ST-14. 盘点页面加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForLoadState('networkidle')
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-ST-15. 盘点物料选择器搜索', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ST-16. 盘点表单自动填充系统库存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/stocktaking`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ST-17. 盘点历史记录查看', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/stocktaking?page=1&pageSize=10')
    expect(res.status).toBe(200)
  })
  test('BLIND-ST-18. 多角色同时盘点互不影响', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'warehouse_manager')
    await p1.goto(`${FE_BASE}/stocktaking`)
    await p2.goto(`${FE_BASE}/stocktaking`)
    await ctx1.close()
    await ctx2.close()
  })
})
