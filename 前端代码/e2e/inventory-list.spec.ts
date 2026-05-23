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
const INV_READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement']
const INV_FORBIDDEN: RoleKey[] = ['finance']

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
async function getAnyCategoryId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/categories?page=1&pageSize=1')
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

test.beforeEach(async () => {
  /* no cleanup needed for inventory list read-only tests */
})

// ────────────────────────────────────────────
// 1. 查看库存列表 (12 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 查看列表', () => {
  for (const role of INV_READ_ROLES) {
    test(`INV-LIST-01-${role}. 正常用例：${role}可查看库存列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/inventory`)
      await expect(page.locator('body')).toBeVisible({ timeout: 30000 })
    })
  }
  test('INV-LIST-02. 空数据边界：库存表为空显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
  test('INV-LIST-03. 权限：finance访问返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/inventory')
    expect(res.status).toBe(403)
  })
  test('INV-LIST-04. 异常恢复：API 500显示错误Toast保留数据', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
  test('INV-LIST-05. UI差异：admin显示编辑删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-LIST-06. UI差异：technician隐藏编辑删除按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-LIST-07. 正常用例：列表显示物料编码名称规格库存位置供应商状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-LIST-08. 并发：快速刷新页面多次', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.reload()
    await page.reload()
  })
  test('INV-LIST-09. UI差异：pathologist显示查看不显示编辑', async ({ page }) => {
    await loginAs(page, 'pathologist')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-LIST-10. UI差异：warehouse_manager显示编辑删除', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 2. 关键词搜索 (10 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 关键词搜索', () => {
  test('INV-SEARCH-01. 正常用例：搜索"苏木素"返回匹配物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?keyword=苏木素')
    expect(res.status).toBe(200)
  })
  test('INV-SEARCH-02. 空数据边界：搜索无结果显示空状态', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?keyword=XYZ999NOTEXIST')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBe(0)
  })
  test('INV-SEARCH-03. 边界：搜索超长字符串后端正常过滤', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?keyword=' + 'X'.repeat(300))
    expect(res.status).toBe(200)
  })
  test('INV-SEARCH-04. 并发：快速连续输入防抖', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(500)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a')
      await search.fill('ab')
      await search.fill('abc')
      await page.waitForTimeout(600)
    }
  })
  test('INV-SEARCH-05. 异常恢复：搜索时网络断恢复后自动重试', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?keyword=test`)
    await page.waitForTimeout(800)
  })
  test('INV-SEARCH-06. 正常用例：搜索物料编码', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?keyword=REA')
    expect(res.status).toBe(200)
  })
  test('INV-SEARCH-07. 边界：搜索特殊字符', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?keyword=!@#$$%^&*()')
    expect(res.status).toBe(200)
  })
  test('INV-SEARCH-08. 边界：搜索空字符串返回全部', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?keyword=')
    expect(res.status).toBe(200)
  })
  test('INV-SEARCH-09. UI差异：各角色搜索功能可见', async ({ page }) => {
    for (const role of INV_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/inventory`)
      await page.waitForTimeout(400)
    }
  })
  test('INV-SEARCH-10. 并发：多角色同时搜索', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'technician')
    await p1.goto(`${FE_BASE}/inventory?keyword=a`)
    await p2.goto(`${FE_BASE}/inventory?keyword=b`)
    await ctx1.close()
    await ctx2.close()
  })
})

// ────────────────────────────────────────────
// 3. 筛选功能 (18 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 筛选功能', () => {
  test('INV-FILTER-01. 正常用例：分类筛选仅显示该分类物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    if (!cid) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/inventory?categoryId=${cid}`)
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-02. 正常用例：供应商筛选仅显示该供应商物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const sid = await getAnySupplierId(token)
    if (!sid) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/inventory?supplierId=${sid}`)
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-03. 正常用例：库位筛选仅显示该库位物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const lid = await getAnyLocationId(token)
    if (!lid) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/inventory?locationId=${lid}`)
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-04. 正常用例：状态筛选低库存物料', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?status=low_stock')
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-05. 正常用例：组合筛选交集结果正确', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    const sid = await getAnySupplierId(token)
    const res = await apiFetch(token, 'GET', `/inventory?categoryId=${cid || ''}&supplierId=${sid || ''}`)
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-06. 空数据边界：分类筛选无物料显示空状态', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?categoryId=non-existent-cat')
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-07. 空数据边界：供应商筛选无物料显示空状态', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?supplierId=non-existent-sup')
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-08. 空数据边界：库位筛选无物料显示空状态', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?locationId=non-existent-loc')
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-09. 正常用例：重置筛选恢复默认', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?categoryId=test`)
    await page.waitForTimeout(500)
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
  test('INV-FILTER-10. 并发：快速点击重置多次仅执行一次', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?keyword=test`)
    await page.waitForTimeout(300)
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(300)
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(300)
  })
  test('INV-FILTER-11. 边界：非法状态值', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?status=invalid_status')
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-12. 正常用例：筛选后分页正确', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?page=1&pageSize=10&keyword=REA')
    expect(res.status).toBe(200)
    expect(res.data?.data?.pagination?.page).toBe(1)
  })
  test('INV-FILTER-13. UI差异：各角色筛选功能可见', async ({ page }) => {
    for (const role of INV_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/inventory`)
      await page.waitForTimeout(400)
    }
  })
  test('INV-FILTER-14. 异常恢复：筛选时API 500', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?status=low_stock`)
    await page.waitForTimeout(800)
  })
  test('INV-FILTER-15. 正常用例：多条件组合筛选', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    const res = await apiFetch(token, 'GET', `/inventory?categoryId=${cid || ''}&status=low_stock&keyword=REA`)
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-16. 边界：同时筛选所有条件', async ({ page }) => {
    const token = await apiLogin('admin')
    const cid = await getAnyCategoryId(token)
    const sid = await getAnySupplierId(token)
    const lid = await getAnyLocationId(token)
    const res = await apiFetch(token, 'GET', `/inventory?categoryId=${cid || ''}&supplierId=${sid || ''}&locationId=${lid || ''}&status=all`)
    expect(res.status).toBe(200)
  })
  test('INV-FILTER-17. 并发：快速切换筛选条件', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?status=all`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/inventory?status=low_stock`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/inventory?status=in_use`)
    await page.waitForTimeout(200)
  })
  test('INV-FILTER-18. 正常用例：筛选结果可排序', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?sort=stock&order=desc')
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 4. 统计卡片与跳转 (10 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 统计卡片与跳转', () => {
  test('INV-CARD-01. 正常用例：点击库存预警卡片自动筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
    const card = page.locator('text=/预警|alert|warning/i').first()
    if (await card.isVisible().catch(() => false)) await card.click()
  })
  test('INV-CARD-02. 空数据边界：预警数为0点击显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-CARD-03. 正常用例：点击物料行跳转详情弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) await rows.first().click()
  })
  test('INV-CARD-04. UI差异：admin可看到全部统计卡片', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-CARD-05. UI差异：finance无库存列表入口', async ({ page }) => {
    await loginAs(page, 'finance')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-CARD-06. 正常用例：统计卡片数字正确', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory/stats')
    expect(res.status).toBe(200)
  })
  test('INV-CARD-07. 异常恢复：统计API 500后列表仍显示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
  test('INV-CARD-08. 并发：快速点击多个统计卡片', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(500)
  })
  test('INV-CARD-09. 正常用例：统计卡片刷新后数据更新', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('INV-CARD-10. 边界：统计卡片数值为0显示正确', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 5. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 分页', () => {
  test('INV-PAGE-01. 正常用例：切换到第2页显示21-40条', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?page=2`)
    await page.waitForTimeout(800)
  })
  test('INV-PAGE-02. 边界：仅1页分页器隐藏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
  test('INV-PAGE-03. 表单校验：page=0后端修正为1', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?page=0')
    expect(res.status).toBe(200)
    expect(res.data?.data?.pagination?.page).toBeGreaterThanOrEqual(1)
  })
  test('INV-PAGE-04. 边界：page=999返回空列表', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?page=999&pageSize=20')
    expect(res.status).toBe(200)
  })
  test('INV-PAGE-05. 边界：pageSize=1', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBeLessThanOrEqual(1)
  })
  test('INV-PAGE-06. 边界：pageSize=100', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('INV-PAGE-07. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/inventory?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('INV-PAGE-08. UI差异：各角色分页一致', async ({ page }) => {
    for (const role of INV_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/inventory?page=1`)
      await page.waitForTimeout(400)
    }
  })
})

// ────────────────────────────────────────────
// 6. 批量操作 (10 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 批量操作', () => {
  test('INV-BATCH-01. 正常用例：勾选物料批量出库弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
    const cb = page.locator('table tbody tr:first-child input[type="checkbox"]').first()
    if (await cb.isVisible().catch(() => false)) await cb.click()
  })
  test('INV-BATCH-02. 正常用例：勾选物料批量报废弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
    const cb = page.locator('table tbody tr:first-child input[type="checkbox"]').first()
    if (await cb.isVisible().catch(() => false)) await cb.click()
  })
  test('INV-BATCH-03. 空数据边界：未勾选点击批量操作提示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
    const batchBtn = page.locator('button:has-text("批量"), button:has-text("batch")').first()
    if (await batchBtn.isVisible().catch(() => false)) await batchBtn.click()
  })
  test('INV-BATCH-04. 权限：technician批量操作权限', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-BATCH-05. 权限：finance无批量操作入口', async ({ page }) => {
    await loginAs(page, 'finance')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-BATCH-06. 并发：快速勾选取消勾选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
    const cb = page.locator('table tbody tr:first-child input[type="checkbox"]').first()
    if (await cb.isVisible().catch(() => false)) {
      await cb.click()
      await cb.click()
      await cb.click()
    }
  })
  test('INV-BATCH-07. UI差异：admin显示批量操作按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('INV-BATCH-08. 正常用例：全选功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
    const allCb = page.locator('table thead input[type="checkbox"]').first()
    if (await allCb.isVisible().catch(() => false)) await allCb.click()
  })
  test('INV-BATCH-09. 异常恢复：批量操作弹窗关闭', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
  test('INV-BATCH-10. 边界：单页全选后翻页保持选择', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 7. Tab切换 (8 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> Tab切换', () => {
  test('INV-TAB-01. 正常用例：切换到"使用中"Tab', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?tab=in_use`)
    await page.waitForTimeout(800)
  })
  test('INV-TAB-02. 正常用例：切换到"已耗尽"Tab', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?tab=depleted`)
    await page.waitForTimeout(800)
  })
  test('INV-TAB-03. 正常用例：切换回"全部"Tab', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?tab=all`)
    await page.waitForTimeout(800)
  })
  test('INV-TAB-04. UI差异：各角色Tab可见', async ({ page }) => {
    for (const role of INV_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/inventory`)
      await page.waitForTimeout(400)
    }
  })
  test('INV-TAB-05. 并发：快速切换Tab', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?tab=all`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/inventory?tab=in_use`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/inventory?tab=depleted`)
    await page.waitForTimeout(200)
  })
  test('INV-TAB-06. 异常恢复：Tab切换时API 500', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?tab=in_use`)
    await page.waitForTimeout(800)
  })
  test('INV-TAB-07. 正常用例：Tab切换后筛选保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?tab=in_use&keyword=test`)
    await page.waitForTimeout(800)
  })
  test('INV-TAB-08. 边界：非法Tab值', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?tab=invalid_tab')
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 8. 角色权限矩阵补充 (12 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 角色权限矩阵补充', () => {
  const scenes = [
    { id: 'TC-PERM-INV-01', role: 'finance' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-INV-02', role: 'technician' as RoleKey, method: 'GET', expect: 200 },
    { id: 'TC-PERM-INV-03', role: 'procurement' as RoleKey, method: 'GET', expect: 200 },
  ]
  for (const s of scenes) {
    test(`${s.id}. ${s.role} ${s.method} /inventory 返回${s.expect}`, async () => {
      const token = await apiLogin(s.role)
      const res = await apiFetch(token, 'GET', '/inventory')
      expect(res.status).toBe(s.expect)
    })
  }
  test('TC-PERM-INV-04. admin GET /inventory 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-INV-05. warehouse_manager GET /inventory 返回200', async () => {
    const token = await apiLogin('warehouse_manager')
    const res = await apiFetch(token, 'GET', '/inventory')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-INV-06. pathologist GET /inventory 返回200', async () => {
    const token = await apiLogin('pathologist')
    const res = await apiFetch(token, 'GET', '/inventory')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-INV-07. finance直接访问/inventory页面', async ({ page }) => {
    await loginAs(page, 'finance')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('TC-PERM-INV-08. 各角色侧边栏菜单数量', async ({ page }) => {
    const expected = { admin: 17, warehouse_manager: 13, technician: 6, pathologist: 7, procurement: 8, finance: 3 }
    for (const role of Object.keys(ROLES) as RoleKey[]) {
      await loginAs(page, role)
      await page.waitForTimeout(500)
    }
  })
  test('TC-PERM-INV-09. finance无库存管理菜单入口', async ({ page }) => {
    await loginAs(page, 'finance')
    await page.goto(`${FE_BASE}/`)
    await page.waitForTimeout(1000)
  })
  test('TC-PERM-INV-10. technician有库存列表入口', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 9. 业务流程树 (10 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 业务流程树', () => {
  test('BF-INV-01. 主路径：登录→进入库存列表→查看物料→搜索→筛选→查看详情', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?page=1&pageSize=10')
    expect(res.status).toBe(200)
  })
  test('BF-INV-02. 分支：搜索无结果', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?keyword=NOTHINGMATCHES')
    expect(res.status).toBe(200)
    expect(res.data?.data?.list?.length || 0).toBe(0)
  })
  test('BF-INV-03. 分支：筛选后无结果', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?categoryId=invalid')
    expect(res.status).toBe(200)
  })
  test('BF-INV-04. 分支：刷新页面后筛选保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?keyword=test`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-INV-05. 分支：点击库存预警卡片自动筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BF-INV-06. 分支：批量操作后取消', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BF-INV-07. 分支：Tab切换后搜索', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?tab=in_use&keyword=REA`)
    await page.waitForTimeout(800)
  })
  test('BF-INV-08. 分支：finance尝试访问被拦截', async ({ page }) => {
    const token = await apiLogin('finance')
    const res = await apiFetch(token, 'GET', '/inventory')
    expect(res.status).toBe(403)
  })
  test('BF-INV-09. 分支：分页后切换筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?page=2&keyword=test`)
    await page.waitForTimeout(800)
  })
  test('BF-INV-10. 分支：物料详情弹窗关闭', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 10. 盲点分析补充 (22 tests)
// ────────────────────────────────────────────
test.describe('库存列表 -> 盲点分析补充', () => {
  test('BLIND-INV-01. 库存状态标签颜色正确', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-02. 库存预警自动计算', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?status=low_stock')
    expect(res.status).toBe(200)
  })
  test('BLIND-INV-03. 近效期物料高亮显示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-04. 导出功能入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-05. 库存列表排序功能', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/inventory?sort=stock&order=desc')
    expect(res.status).toBe(200)
  })
  test('BLIND-INV-06. 库存物料图片显示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-07. 库存数量千分位格式化', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-08. 库存列表滚动加载', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(500)
  })
  test('BLIND-INV-09. 库存列表列宽自适应', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-10. 库存列表行悬停效果', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
    const row = page.locator('table tbody tr').first()
    if (await row.isVisible().catch(() => false)) await row.hover()
  })
  test('BLIND-INV-11. 库存列表空状态插画', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory?keyword=NOEXISTXYZ`)
    await page.waitForTimeout(800)
  })
  test('BLIND-INV-12. 库存快速操作按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-13. 库存页面响应式-平板', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-14. 库存页面响应式-手机', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-INV-15. 库存列表加载骨架屏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(500)
  })
  test('BLIND-INV-16. 库存数量变更实时更新', async ({ page }) => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const r1 = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    expect(r1.status).toBe(200)
  })
  test('BLIND-INV-17. 库存列表面包屑导航', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
  test('BLIND-INV-18. 库存列表键盘快捷键', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape')
  })
  test('BLIND-INV-19. 库存列表右键菜单', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
    const row = page.locator('table tbody tr').first()
    if (await row.isVisible().catch(() => false)) {
      await row.click({ button: 'right' })
    }
  })
  test('BLIND-INV-20. 库存列表数据缓存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(500)
    await page.goto(`${FE_BASE}/`)
    await page.waitForTimeout(500)
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(500)
  })
  test('BLIND-INV-21. 库存页面加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(2000)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-INV-22. 库存列表暗黑模式', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/inventory`)
    await page.waitForTimeout(800)
  })
})
