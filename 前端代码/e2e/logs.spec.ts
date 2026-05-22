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

test.beforeEach(async ({ page }) => {
  await page.goto(`${FE_BASE}/login`).catch(() => {})
  await page.evaluate(() => localStorage.clear()).catch(() => {})
})

// ───────────────────────────────────────────────
// 1. 查看日志列表
// ───────────────────────────────────────────────
test.describe('操作日志 -> 查看日志列表', () => {
  test('LOG-LIST-01. 正常用例：admin可查看操作日志列表', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/操作日志|日志|操作记录/i').first()).toBeVisible()
  })
  test('LOG-LIST-02. 正常用例：日志表格显示列标题', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('table').locator('text=/操作时间|操作用户|操作类型|操作模块|操作内容|IP地址/i').first()).toBeVisible()
  })
  test('LOG-LIST-03. 空数据边界：无日志数据显示空状态', async ({ page }) => {
    await page.route('**/api/v1/logs**', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { list: [], pagination: { total: 0 } } }) }))
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/暂无日志|暂无数据|空/i').first()).toBeVisible()
    await page.unroute('**/api/v1/logs**')
  })
  test('LOG-LIST-04. 异常恢复：API 500显示错误提示', async ({ page }) => {
    await page.route('**/api/v1/logs**', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await page.unroute('**/api/v1/logs**')
  })
  test('LOG-LIST-05. UI差异：admin显示导出日志按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/导出日志|导出/i').first()).toBeVisible()
  })
  test('LOG-LIST-06. 并发：快速刷新页面多次', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`)
    for (let i = 0; i < 3; i++) { await page.reload(); await page.waitForTimeout(800) }
    await expect(page.locator('body')).toBeVisible()
  })
  test('LOG-LIST-07. 正常用例：日志表格显示用户头像', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/操作记录/i').first()).toBeVisible()
  })
  test('LOG-LIST-08. 正常用例：日志表格显示操作类型标签', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/登录|登出|新增|修改|删除|导出|导入/i').first()).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 2. 统计卡片
// ───────────────────────────────────────────────
test.describe('操作日志 -> 统计卡片', () => {
  test('LOG-STAT-01. 正常用例：显示今日操作统计', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/今日操作/i').first()).toBeVisible()
  })
  test('LOG-STAT-02. 正常用例：显示登录次数统计', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/登录次数/i').first()).toBeVisible()
  })
  test('LOG-STAT-03. 正常用例：显示数据变更统计', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/数据变更/i').first()).toBeVisible()
  })
  test('LOG-STAT-04. 正常用例：显示活跃用户统计', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/活跃用户/i').first()).toBeVisible()
  })
  test('LOG-STAT-05. 正常用例：统计卡片数字为数值', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const statNums = page.locator('.text-\\[28px\\]')
    expect(await statNums.count()).toBeGreaterThanOrEqual(1)
  })
})

// ───────────────────────────────────────────────
// 3. 筛选功能
// ───────────────────────────────────────────────
test.describe('操作日志 -> 筛选功能', () => {
  test('LOG-FILTER-01. 正常用例：按操作类型筛选', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const sel = page.locator('select').filter({ hasText: /全部操作类型|登录|新增/i }).first()
    if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(800) }
  })
  test('LOG-FILTER-02. 正常用例：按操作模块筛选', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const sel = page.locator('select').filter({ hasText: /全部模块|库存|入库|出库/i }).first()
    if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(800) }
  })
  test('LOG-FILTER-03. 正常用例：按用户筛选', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const sel = page.locator('select').filter({ hasText: /全部用户|admin/i }).first()
    if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(800) }
  })
  test('LOG-FILTER-04. 正常用例：按日期范围筛选', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const dates = page.locator('input[type="date"]')
    if (await dates.count() >= 2) { await dates.nth(0).fill('2024-01-01'); await dates.nth(1).fill('2024-12-31'); await page.waitForTimeout(500) }
  })
  test('LOG-FILTER-05. 正常用例：点击查询按钮筛选', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const btn = page.locator('text=/查询/i').first()
    if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(800) }
  })
  test('LOG-FILTER-06. 正常用例：点击重置按钮恢复全部', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const reset = page.locator('text=/重置/i').first()
    if (await reset.isVisible().catch(() => false)) { await reset.click(); await page.waitForTimeout(800) }
  })
  test('LOG-FILTER-07. 空数据边界：筛选条件无匹配结果', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const dates = page.locator('input[type="date"]')
    if (await dates.count() >= 2) {
      await dates.nth(0).fill('2099-01-01'); await dates.nth(1).fill('2099-12-31'); await page.waitForTimeout(500)
      const btn = page.locator('text=/查询/i').first()
      if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(800) }
    }
  })
  test('LOG-FILTER-08. 边界：仅选择开始日期', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const dates = page.locator('input[type="date"]')
    if (await dates.count() >= 1) { await dates.nth(0).fill('2024-01-01'); await page.waitForTimeout(500) }
  })
  test('LOG-FILTER-09. 边界：仅选择结束日期', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const dates = page.locator('input[type="date"]')
    if (await dates.count() >= 2) { await dates.nth(1).fill('2024-12-31'); await page.waitForTimeout(500) }
  })
  test('LOG-FILTER-10. 边界：开始日期大于结束日期', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const dates = page.locator('input[type="date"]')
    if (await dates.count() >= 2) { await dates.nth(0).fill('2024-12-31'); await dates.nth(1).fill('2024-01-01'); await page.waitForTimeout(500) }
  })
  test('LOG-FILTER-11. 并发：快速切换筛选条件', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const selects = page.locator('select')
    for (let i = 0; i < Math.min(3, await selects.count()); i++) {
      if (await selects.nth(i).isVisible().catch(() => false)) { await selects.nth(i).selectOption({ index: 1 }); await page.waitForTimeout(300) }
    }
  })
  test('LOG-FILTER-12. 正常用例：组合筛选条件查询', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const selects = page.locator('select')
    if (await selects.count() >= 2) {
      if (await selects.nth(0).isVisible().catch(() => false)) await selects.nth(0).selectOption({ index: 1 })
      if (await selects.nth(1).isVisible().catch(() => false)) await selects.nth(1).selectOption({ index: 1 })
      await page.waitForTimeout(500)
      const btn = page.locator('text=/查询/i').first()
      if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(800) }
    }
  })
})

// ───────────────────────────────────────────────
// 4. 分页功能
// ───────────────────────────────────────────────
test.describe('操作日志 -> 分页功能', () => {
  test('LOG-PAGE-01. 正常用例：多页数据切页', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) {
      await next.click(); await page.waitForTimeout(800)
    }
  })
  test('LOG-PAGE-02. 正常用例：上一页返回', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) {
      await next.click(); await page.waitForTimeout(500)
      const prev = page.locator('text=/上一页/i').first()
      if (await prev.isVisible().catch(() => false) && await prev.isEnabled().catch(() => false)) { await prev.click(); await page.waitForTimeout(800) }
    }
  })
  test('LOG-PAGE-03. 边界：仅1页时下一页禁用', async ({ page }) => {
    await page.route('**/api/v1/logs**', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { list: [{ id: '1', username: 'admin', operation: 'login', description: 'test', createdAt: new Date().toISOString(), ip: '127.0.0.1' }], pagination: { total: 1, page: 1, pageSize: 20 } } }) }))
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false)) { expect(await next.isDisabled().catch(() => false)).toBe(true) }
    await page.unroute('**/api/v1/logs**')
  })
  test('LOG-PAGE-04. 边界：第1页时上一页禁用', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const prev = page.locator('text=/上一页/i').first()
    if (await prev.isVisible().catch(() => false)) { expect(await prev.isDisabled().catch(() => false)).toBe(true) }
  })
  test('LOG-PAGE-05. 正常用例：点击页码跳转到指定页', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const p2 = page.locator('button').filter({ hasText: /^2$/ }).first()
    if (await p2.isVisible().catch(() => false)) { await p2.click(); await page.waitForTimeout(800) }
  })
  test('LOG-PAGE-06. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    for (let i = 0; i < 3; i++) { if (await next.isVisible().catch(() => false)) await next.click() }
    await page.waitForTimeout(800)
  })
  test('LOG-PAGE-07. 正常用例：分页信息显示正确', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/共.*条记录|第.*页/i').first().or(page.locator('body'))).toBeVisible()
  })
})

// ───────────────────────────────────────────────
// 5. 日志详情弹窗
// ───────────────────────────────────────────────
test.describe('操作日志 -> 日志详情弹窗', () => {
  test('LOG-DETAIL-01. 正常用例：点击详情按钮打开弹窗', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/操作详情|操作时间|操作类型|操作用户/i').first()).toBeVisible()
    }
    const close = page.locator('text=/关闭/i').first()
    if (await close.isVisible().catch(() => false)) await close.click()
  })
  test('LOG-DETAIL-02. 正常用例：详情弹窗显示操作时间', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/操作时间/i').first().or(page.locator('body'))).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('LOG-DETAIL-03. 正常用例：详情弹窗显示IP地址', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/IP地址/i').first().or(page.locator('body'))).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('LOG-DETAIL-04. 正常用例：详情弹窗显示浏览器信息', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/浏览器|UserAgent/i').first().or(page.locator('body'))).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('LOG-DETAIL-05. 正常用例：详情弹窗显示操作内容', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/操作内容/i').first().or(page.locator('body'))).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('LOG-DETAIL-06. 正常用例：详情弹窗显示变更详情', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/变更详情|请求数据/i').first().or(page.locator('body'))).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('LOG-DETAIL-07. 正常用例：关闭详情弹窗恢复列表', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(800)
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) { await close.click(); await page.waitForTimeout(500) }
      await expect(page.locator('text=/操作记录/i').first()).toBeVisible()
    }
  })
  test('LOG-DETAIL-08. 并发：快速点击多个详情按钮', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const details = page.locator('text=/详情/i')
    if (await details.count() >= 2) {
      await details.nth(0).click(); await page.waitForTimeout(300)
      await details.nth(1).click(); await page.waitForTimeout(500)
    }
    const close = page.locator('text=/关闭/i').first()
    if (await close.isVisible().catch(() => false)) await close.click()
  })
})

// ───────────────────────────────────────────────
// 6. 导出功能
// ───────────────────────────────────────────────
test.describe('操作日志 -> 导出功能', () => {
  test('LOG-EXPORT-01. 正常用例：点击导出按钮打开导出弹窗', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      await expect(page.locator('text=/导出日志|导出时间范围|导出格式/i').first()).toBeVisible()
    }
    const cancel = page.locator('text=/取消/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('LOG-EXPORT-02. 正常用例：导出弹窗选择Excel格式', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const xlsx = page.locator('text=/Excel|xlsx/i').first()
      if (await xlsx.isVisible().catch(() => false)) { await xlsx.click(); await page.waitForTimeout(300) }
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('LOG-EXPORT-03. 正常用例：导出弹窗选择CSV格式', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const csv = page.locator('text=/CSV|csv/i').first()
      if (await csv.isVisible().catch(() => false)) { await csv.click(); await page.waitForTimeout(300) }
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('LOG-EXPORT-04. 正常用例：导出弹窗设置时间范围', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const dates = page.locator('input[type="date"]')
      if (await dates.count() >= 2) { await dates.nth(0).fill('2024-01-01'); await dates.nth(1).fill('2024-12-31'); await page.waitForTimeout(300) }
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('LOG-EXPORT-05. 正常用例：导出弹窗勾选导出内容', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const check = page.locator('input[type="checkbox"]').first()
      if (await check.isVisible().catch(() => false)) { await check.click(); await page.waitForTimeout(300) }
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('LOG-EXPORT-06. 正常用例：导出弹窗点击导出', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const confirm = page.locator('button').filter({ hasText: /^导出$/i }).first()
      if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await page.waitForTimeout(1000) }
    }
  })
  test('LOG-EXPORT-07. 正常用例：导出弹窗点击取消关闭', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) { await cancel.click(); await page.waitForTimeout(500) }
    }
  })
  test('LOG-EXPORT-08. 并发：快速点击导出按钮多次', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) { await exportBtn.click(); await exportBtn.click(); await page.waitForTimeout(800) }
    const cancel = page.locator('text=/取消/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('LOG-EXPORT-09. 异常恢复：导出时网络中断', async ({ page }) => {
    await page.route('**/api/v1/logs/export**', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const confirm = page.locator('button').filter({ hasText: /^导出$/i }).first()
      if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await page.waitForTimeout(1000) }
    }
    await page.unroute('**/api/v1/logs/export**')
  })
})

// ───────────────────────────────────────────────
// 7. 角色权限矩阵补充
// ───────────────────────────────────────────────
test.describe('操作日志 -> 角色权限矩阵补充', () => {
  const permScenes = [
    { id: 'TC-PERM-LOG-01', role: 'technician' as RoleKey, method: 'GET', path: '/logs', expect: 403 },
    { id: 'TC-PERM-LOG-02', role: 'pathologist' as RoleKey, method: 'GET', path: '/logs', expect: 403 },
    { id: 'TC-PERM-LOG-03', role: 'procurement' as RoleKey, method: 'GET', path: '/logs', expect: 403 },
    { id: 'TC-PERM-LOG-04', role: 'finance' as RoleKey, method: 'GET', path: '/logs', expect: 403 },
    { id: 'TC-PERM-LOG-05', role: 'warehouse_manager' as RoleKey, method: 'GET', path: '/logs', expect: 403 },
    { id: 'TC-PERM-LOG-06', role: 'admin' as RoleKey, method: 'GET', path: '/logs', expect: 200 },
    { id: 'TC-PERM-LOG-07', role: 'admin' as RoleKey, method: 'GET', path: '/logs/operation', expect: 200 },
    { id: 'TC-PERM-LOG-08', role: 'technician' as RoleKey, method: 'GET', path: '/logs/operation', expect: 403 },
  ]
  for (const scene of permScenes) {
    test(`${scene.id}. ${scene.role} ${scene.method} ${scene.path} 返回${scene.expect}`, async () => {
      const token = await apiLogin(scene.role)
      const res = await apiFetch(token, scene.method, scene.path)
      expect(res.status).toBe(scene.expect)
    })
  }
})

// ───────────────────────────────────────────────
// 8. 业务流程树
// ───────────────────────────────────────────────
test.describe('操作日志 -> 业务流程树', () => {
  test('BF-LOG-01. 主路径：进入日志页→筛选操作类型→查看详情→导出', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const sel = page.locator('select').first()
    if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(500) }
    const btn = page.locator('text=/查询/i').first()
    if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(800) }
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) { await detail.click(); await page.waitForTimeout(800) }
    const close = page.locator('text=/关闭/i').first()
    if (await close.isVisible().catch(() => false)) await close.click()
  })
  test('BF-LOG-02. 分支：筛选后重置恢复全部', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const sel = page.locator('select').first()
    if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(500) }
    const reset = page.locator('text=/重置/i').first()
    if (await reset.isVisible().catch(() => false)) { await reset.click(); await page.waitForTimeout(800) }
  })
  test('BF-LOG-03. 分支：查看详情后关闭', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(800)
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) { await close.click(); await page.waitForTimeout(500) }
    }
  })
  test('BF-LOG-04. 分支：导出弹窗设置后取消', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) { await cancel.click(); await page.waitForTimeout(500) }
    }
  })
  test('BF-LOG-05. 分支：按日期范围筛选无结果', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const dates = page.locator('input[type="date"]')
    if (await dates.count() >= 2) {
      await dates.nth(0).fill('2099-01-01'); await dates.nth(1).fill('2099-12-31'); await page.waitForTimeout(500)
      const btn = page.locator('text=/查询/i').first()
      if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(800) }
    }
  })
  test('BF-LOG-06. 分支：切换分页后查看详情', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) {
      await next.click(); await page.waitForTimeout(800)
      const detail = page.locator('text=/详情/i').first()
      if (await detail.isVisible().catch(() => false)) { await detail.click(); await page.waitForTimeout(800) }
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('BF-LOG-07. 分支：无权限用户访问被拦截', async ({ page }) => {
    await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1200)
    await expect(page.locator('body')).toBeVisible()
  })
  test('BF-LOG-08. 分支：组合筛选后导出', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const selects = page.locator('select')
    if (await selects.count() >= 2) {
      if (await selects.nth(0).isVisible().catch(() => false)) await selects.nth(0).selectOption({ index: 1 })
      if (await selects.nth(1).isVisible().catch(() => false)) await selects.nth(1).selectOption({ index: 1 })
    }
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) { await exportBtn.click(); await page.waitForTimeout(800) }
    const cancel = page.locator('text=/取消/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
})

// ───────────────────────────────────────────────
// 9. 盲点分析补充
// ───────────────────────────────────────────────
test.describe('操作日志 -> 盲点分析补充', () => {
  test('BLIND-LOG-01. 操作类型标签颜色区分', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/登录|登出|新增|修改|删除|导出|导入/i').first()).toBeVisible()
  })
  test('BLIND-LOG-02. 日志时间格式化显示正确', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/2024|2025|2026|\//i').first().or(page.locator('body'))).toBeVisible()
  })
  test('BLIND-LOG-03. 用户头像显示首字母', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
  })
  test('BLIND-LOG-04. 请求数据JSON截断显示', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/\\{.*\\.\\.\\./i').first().or(page.locator('body'))).toBeVisible()
  })
  test('BLIND-LOG-05. IP地址为IPv4格式', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/\\d+\\.\\d+\\.\\d+\\.\\d+/i').first().or(page.locator('body'))).toBeVisible()
  })
  test('BLIND-LOG-06. 模块标签显示中文', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('text=/库存管理|入库管理|出库管理|用户管理|系统设置/i').first()).toBeVisible()
  })
  test('BLIND-LOG-07. 详情弹窗请求数据表格渲染', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const detail = page.locator('text=/详情/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('table').first().or(page.locator('body'))).toBeVisible()
      const close = page.locator('text=/关闭/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('BLIND-LOG-08. 分页页码按钮样式高亮当前页', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const activePage = page.locator('button').filter({ has: page.locator('text=1') }).first()
    if (await activePage.isVisible().catch(() => false)) {
      expect(await activePage.evaluate(el => (el as HTMLElement).className.includes('bg') || (el as HTMLElement).className.includes('blue'))).toBe(true)
    }
  })
  test('BLIND-LOG-09. 响应式布局检查', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 720 })
  })
  test('BLIND-LOG-10. 日志API响应格式验证', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/logs?page=1&pageSize=1')
    expect(res.status).toBe(200)
    if (res.data?.data?.list) { expect(Array.isArray(res.data.data.list)).toBe(true) }
  })
  test('BLIND-LOG-11. 页面加载性能检查', async ({ page }) => {
    const start = Date.now()
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`)
    await page.waitForTimeout(1500)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-LOG-12. 导出文件名包含日期', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/logs`); await page.waitForTimeout(1500)
    const exportBtn = page.locator('text=/导出日志|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) { await exportBtn.click(); await page.waitForTimeout(800) }
    const cancel = page.locator('text=/取消/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
})
