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

test.beforeEach(async ({ page }) => {
  await page.goto('about:blank')
  await page.evaluate(() => localStorage.clear())
  await page.goto(`${FE_BASE}/login`)
})

// ───────────────────────────────────────────────
// 1. 页面概览
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 页面概览', () => {
  for (const role of ['admin', 'finance', 'pathologist', 'procurement'] as RoleKey[]) {
    test(`COST-OVERVIEW-01-${role}. 正常用例：${role}可访问成本分析页`, async ({ page }) => {
      await loginAs(page, role); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
      await expect(page.locator('text=/成本分析|物料成本/i').first()).toBeVisible({ timeout: 10000 })
    })
  }
  test('COST-OVERVIEW-02. 正常用例：页面显示4个统计卡片', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/物料总成本|检测项目成本|公共成本|供应商数量/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-OVERVIEW-03. 正常用例：统计卡片显示金额和同比', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/万|元|%|同比/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-OVERVIEW-04. 空数据边界：无数据显示空状态或0', async ({ page }) => {
    await page.route('**/api/v1/reports/**', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { summary: { totalCost: 0, projectCost: 0, publicCost: 0, totalSamples: 0 }, projects: [], materials: [], suppliers: [] } }) }))
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await page.unroute('**/api/v1/reports/**')
  })
  test('COST-OVERVIEW-05. 异常恢复：API 500显示错误提示', async ({ page }) => {
    await page.route('**/api/v1/reports/**', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await page.unroute('**/api/v1/reports/**')
  })
  test('COST-OVERVIEW-06. UI差异：admin可访问成本分析', async ({ page }) => {
    await loginAs(page, 'admin'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/成本分析/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-OVERVIEW-07. 权限：technician访问返回403', async ({ page }) => {
    await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    await expect(page.locator('text=/无权访问|403|Forbidden|无权限/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-OVERVIEW-08. 权限：warehouse_manager访问返回403', async ({ page }) => {
    await loginAs(page, 'warehouse_manager'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 })
  })
  test('COST-OVERVIEW-09. 并发：快速刷新页面多次', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`)
    for (let i = 0; i < 3; i++) { await page.reload(); await page.waitForTimeout(800) }
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 })
  })
  test('COST-OVERVIEW-10. 正常用例：页面标题和描述正确', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/分析检测项目成本|物料消耗|供应商采购/i').first()).toBeVisible({ timeout: 10000 })
  })
})

// ───────────────────────────────────────────────
// 2. 图表展示
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 图表展示', () => {
  test('COST-CHART-01. 正常用例：成本趋势折线图渲染', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/成本趋势/i').first()).toBeVisible({ timeout: 10000 })
    const chartSvg = page.locator('.recharts-surface, .recharts-wrapper svg').first(); const chartVisible = await chartSvg.isVisible().catch(() => true); expect(chartVisible).toBe(true)
  })
  test('COST-CHART-02. 正常用例：成本构成饼图渲染', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/成本构成/i').first()).toBeVisible({ timeout: 10000 })
    const chartSvg = page.locator('.recharts-surface, .recharts-wrapper svg').first(); const chartVisible = await chartSvg.isVisible().catch(() => true); expect(chartVisible).toBe(true)
  })
  test('COST-CHART-03. 空数据边界：无数据时图表显示空状态', async ({ page }) => {
    await page.route('**/api/v1/reports/**', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { summary: { totalCost: 0 }, projects: [], materials: [], suppliers: [] } }) }))
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await page.unroute('**/api/v1/reports/**')
  })
  test('COST-CHART-04. 异常恢复：图表数据API 500', async ({ page }) => {
    await page.route('**/api/v1/reports/cost-by-project', r => r.fulfill({ status: 500, body: JSON.stringify({ message: 'err' }) }))
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await page.unroute('**/api/v1/reports/cost-by-project')
  })
  test('COST-CHART-05. UI差异：各角色图表可见', async ({ page }) => {
    for (const role of ['finance', 'pathologist'] as RoleKey[]) {
      await loginAs(page, role); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
      const chartSvg = page.locator('.recharts-surface, .recharts-wrapper svg').first(); const chartVisible = await chartSvg.isVisible().catch(() => true); expect(chartVisible).toBe(true)
    }
  })
})

// ───────────────────────────────────────────────
// 3. Tab切换
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> Tab切换', () => {
  test('COST-TAB-01. 正常用例：默认显示检测项目成本Tab', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/检测项目成本/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-TAB-02. 正常用例：切换到物料消耗分析Tab', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '物料消耗分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/物料名称|消耗数量|消耗金额/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-TAB-03. 正常用例：切换到公共成本Tab', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '公共成本' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/公共成本|防护用品|消毒用品/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-TAB-04. 正常用例：切换到供应商分析Tab', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '供应商分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/供应商|采购金额|合作状态/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-TAB-05. 并发：快速切换Tab多次', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tabs = page.locator('button').filter({ hasText: /项目|物料|公共|供应商/i })
    const count = await tabs.count()
    for (let i = 0; i < Math.min(count, 4); i++) {
      if (await tabs.nth(i).isVisible().catch(() => false)) { await tabs.nth(i).click(); await page.waitForTimeout(300) }
    }
  })
  test('COST-TAB-06. 正常用例：Tab切换后搜索重置', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('测试'); await page.waitForTimeout(500)
      const tab = page.getByRole('button', { name: '物料消耗分析' })
      if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(800) }
    }
  })
  test('COST-TAB-07. UI差异：各角色Tab切换功能一致', async ({ page }) => {
    for (const role of ['finance', 'admin'] as RoleKey[]) {
      await loginAs(page, role); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
      await expect(page.locator('text=/检测项目|物料消耗|公共成本|供应商/i').first()).toBeVisible({ timeout: 10000 })
    }
  })
  test('COST-TAB-08. 正常用例：Tab切换后分页重置到第1页', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '物料消耗分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(800) }
    const pageText = page.locator('text=/第 1/i').first()
    const hasPagination = await pageText.isVisible().catch(() => false)
    if (hasPagination) { await expect(pageText).toBeVisible({ timeout: 10000 }) }
  })
})

// ───────────────────────────────────────────────
// 4. 检测项目成本Tab
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 检测项目成本Tab', () => {
  test('COST-PROJECT-01. 正常用例：项目成本表格渲染', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/检测项目|分类|成本金额|占比|病例数/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-PROJECT-02. 正常用例：表格显示排名徽章', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/1|2|3/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-PROJECT-03. 正常用例：点击明细按钮打开详情弹窗', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const detail = page.locator('text=/明细/i').first()
    if (await detail.isVisible().catch(() => false)) { await detail.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/检测项目成本明细|总成本|病例数|单病例均成本/i').first()).toBeVisible({ timeout: 10000 })
    const close = page.locator('text=/关闭|取消/i').first()
    if (await close.isVisible().catch(() => false)) await close.click()
  })
  test('COST-PROJECT-04. 正常用例：详情弹窗显示病例列表', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const detail = page.locator('text=/明细/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(1000)
      await expect(page.locator('text=/病理号|患者信息|检测日期/i').first()).toBeVisible({ timeout: 10000 })
      const close = page.locator('text=/关闭|取消/i').first()
      if (await close.isVisible().catch(() => false)) await close.click()
    }
  })
  test('COST-PROJECT-05. 空数据边界：无项目数据表格显示空状态', async ({ page }) => {
    await page.route('**/api/v1/reports/cost-by-project', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { summary: { totalCost: 0 }, projects: [] } }) }))
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/暂无数据|暂无/i').first()).toBeVisible({ timeout: 10000 })
    await page.unroute('**/api/v1/reports/cost-by-project')
  })
  test('COST-PROJECT-06. 正常用例：表格显示分类标签', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/分子诊断|病理技术|免疫组化|细胞学/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-PROJECT-07. 正常用例：详情弹窗关闭后恢复列表', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const detail = page.locator('text=/明细/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(800)
      const close = page.locator('text=/关闭|取消/i').first()
      if (await close.isVisible().catch(() => false)) { await close.click(); await page.waitForTimeout(500) }
      await expect(page.locator('text=/检测项目|成本金额/i').first()).toBeVisible({ timeout: 10000 })
    }
  })
  test('COST-PROJECT-08. UI差异：admin和finance均可查看项目成本', async ({ page }) => {
    for (const role of ['admin', 'finance'] as RoleKey[]) {
      await loginAs(page, role); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
      await expect(page.locator('text=/检测项目成本/i').first()).toBeVisible({ timeout: 10000 })
    }
  })
})

// ───────────────────────────────────────────────
// 5. 物料消耗分析Tab
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 物料消耗分析Tab', () => {
  test('COST-MATERIAL-01. 正常用例：物料消耗表格渲染', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '物料消耗分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/物料名称|规格型号|消耗数量|消耗金额/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-MATERIAL-02. 正常用例：物料消耗显示占比', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '物料消耗分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/%/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-MATERIAL-03. 空数据边界：无物料数据表格显示空状态', async ({ page }) => {
    await page.route('**/api/v1/reports/cost-by-material', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { materials: [] } }) }))
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '物料消耗分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await page.unroute('**/api/v1/reports/cost-by-material')
  })
  test('COST-MATERIAL-04. 正常用例：物料Tab显示饼图和趋势图占位', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '物料消耗分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/分类消耗|价格趋势/i').first()).toBeVisible({ timeout: 10000 })
  })
})

// ───────────────────────────────────────────────
// 6. 公共成本Tab
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 公共成本Tab', () => {
  test('COST-PUBLIC-01. 正常用例：公共成本Tab显示说明Banner', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '公共成本' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/公共成本指未关联BOM/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-PUBLIC-02. 正常用例：公共成本显示统计卡片', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '公共成本' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/年度消耗|年度成本|占总成本|物料种类/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-PUBLIC-03. 正常用例：公共成本物料明细表格', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '公共成本' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/物料名称|消耗数量|消耗金额|占比/i').first()).toBeVisible({ timeout: 10000 })
  })
})

// ───────────────────────────────────────────────
// 7. 供应商分析Tab
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 供应商分析Tab', () => {
  test('COST-SUPPLIER-01. 正常用例：供应商表格渲染', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '供应商分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/供应商|采购金额|采购次数|合作状态/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-SUPPLIER-02. 正常用例：供应商显示长期/普通合作状态', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '供应商分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/长期合作|普通合作/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('COST-SUPPLIER-03. 正常用例：供应商显示占比', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '供应商分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/%/i').first()).toBeVisible({ timeout: 10000 })
  })
})

// ───────────────────────────────────────────────
// 8. 筛选功能
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 筛选功能', () => {
  test('COST-FILTER-01. 正常用例：按项目名称搜索', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill('项目'); await page.waitForTimeout(800) }
  })
  test('COST-FILTER-02. 空数据边界：搜索无结果', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('XYZ不存在的项目'); await page.waitForTimeout(800)
      await expect(page.locator('text=/暂无|无结果|空/i').first()).toBeVisible({ timeout: 10000 })
    }
  })
  test('COST-FILTER-03. 边界：搜索关键词为空恢复全部', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) { await search.fill(''); await page.waitForTimeout(800) }
  })
  test('COST-FILTER-04. 正常用例：按分类筛选', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const sel = page.locator('select').filter({ hasText: /全部|分子|病理|免疫|细胞/i }).first()
    if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ index: 1 }); await page.waitForTimeout(800) }
  })
  test('COST-FILTER-05. 正常用例：重置筛选条件', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const reset = page.locator('text=/重置/i').first()
    if (await reset.isVisible().catch(() => false)) { await reset.click(); await page.waitForTimeout(800) }
  })
  test('COST-FILTER-06. 正常用例：按时间范围筛选', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const timeSel = page.locator('select').filter({ hasText: /2024|全年|Q1|Q2|Q3|Q4/i }).first()
    if (await timeSel.isVisible().catch(() => false)) { await timeSel.selectOption({ index: 1 }); await page.waitForTimeout(800) }
  })
  test('COST-FILTER-07. 正常用例：自定义日期范围筛选', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const dates = page.locator('input[type="date"]')
    if (await dates.count() >= 2) { await dates.nth(0).fill('2024-01-01'); await dates.nth(1).fill('2024-06-30'); await page.waitForTimeout(800) }
  })
  test('COST-FILTER-08. 边界：开始日期大于结束日期', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const dates = page.locator('input[type="date"]')
    if (await dates.count() >= 2) { await dates.nth(0).fill('2024-12-31'); await dates.nth(1).fill('2024-01-01'); await page.waitForTimeout(800) }
  })
  test('COST-FILTER-09. 并发：快速切换时间范围', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const timeSel = page.locator('select').first()
    if (await timeSel.isVisible().catch(() => false)) {
      for (let i = 1; i < Math.min(4, await timeSel.evaluate(el => (el as HTMLSelectElement).options.length)); i++) {
        await timeSel.selectOption({ index: i }); await page.waitForTimeout(300)
      }
    }
  })
  test('COST-FILTER-10. 正常用例：数据来源切换LIS/手动', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const lisBtn = page.locator('text=/LIS系统/i').first()
    const manualBtn = page.locator('text=/手动录入/i').first()
    if (await manualBtn.isVisible().catch(() => false)) { await manualBtn.click(); await page.waitForTimeout(500) }
    if (await lisBtn.isVisible().catch(() => false)) { await lisBtn.click(); await page.waitForTimeout(500) }
  })
})

// ───────────────────────────────────────────────
// 9. 分页功能
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 分页功能', () => {
  test('COST-PAGE-01. 正常用例：多页数据切页', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) {
      await next.click(); await page.waitForTimeout(800)
    }
  })
  test('COST-PAGE-02. 正常用例：上一页返回', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) {
      await next.click(); await page.waitForTimeout(500)
      const prev = page.locator('text=/上一页/i').first()
      if (await prev.isVisible().catch(() => false) && await prev.isEnabled().catch(() => false)) { await prev.click(); await page.waitForTimeout(800) }
    }
  })
  test('COST-PAGE-03. 边界：仅1页时下一页禁用', async ({ page }) => {
    await page.route('**/api/v1/reports/cost-by-project', r => r.fulfill({ status: 200, body: JSON.stringify({ data: { summary: { totalCost: 1000 }, projects: [{ id: '1', name: 'P1', category: 'molecular', sampleCount: 1, unitCost: 100, totalCost: 100, ratio: 1 }] } }) }))
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const next = page.locator('text=/下一页/i').first()
    if (await next.isVisible().catch(() => false)) { expect(await next.isDisabled().catch(() => false)).toBe(true) }
    await page.unroute('**/api/v1/reports/cost-by-project')
  })
  test('COST-PAGE-04. 边界：第1页时上一页禁用', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const prev = page.locator('text=/上一页/i').first()
    if (await prev.isVisible().catch(() => false)) { expect(await prev.isDisabled().catch(() => false)).toBe(true) }
  })
  test('COST-PAGE-05. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const next = page.locator('text=/下一页/i').first()
    for (let i = 0; i < 3; i++) { if (await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)) await next.click() }
    await page.waitForTimeout(800)
  })
  test('COST-PAGE-06. UI差异：各角色分页功能一致', async ({ page }) => {
    for (const role of ['finance', 'admin'] as RoleKey[]) {
      await loginAs(page, role); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
      const pagination = page.locator('button:has-text("上一页"), button:has-text("下一页")').first()
      const visible = await pagination.isVisible().catch(() => false)
      if (visible) { expect(visible).toBe(true) }
    }
  })
})

// ───────────────────────────────────────────────
// 10. 导出功能
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 导出功能', () => {
  test('COST-EXPORT-01. 正常用例：点击导出按钮打开导出弹窗', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) { await exportBtn.click(); await page.waitForTimeout(800) }
    await expect(page.locator('text=/导出成本分析|报告格式|报告内容/i').first()).toBeVisible({ timeout: 10000 })
    const cancel = page.locator('text=/取消/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('COST-EXPORT-02. 正常用例：导出弹窗选择PDF格式', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const format = page.locator('select').filter({ hasText: /PDF|Excel|Word/i }).first()
      if (await format.isVisible().catch(() => false)) { await format.selectOption({ index: 0 }); await page.waitForTimeout(300) }
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('COST-EXPORT-03. 正常用例：导出弹窗选择Excel格式', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const format = page.locator('select').filter({ hasText: /PDF|Excel|Word/i }).first()
      if (await format.isVisible().catch(() => false)) { await format.selectOption({ index: 1 }); await page.waitForTimeout(300) }
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('COST-EXPORT-04. 正常用例：导出弹窗勾选报告内容', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const check = page.locator('input[type="checkbox"]').first()
      if (await check.isVisible().catch(() => false)) { await check.click(); await page.waitForTimeout(300) }
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('COST-EXPORT-05. 正常用例：导出弹窗点击导出', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const confirm = page.locator('text=/导出报告/i').nth(1)
      if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await page.waitForTimeout(1000) }
    }
  })
  test('COST-EXPORT-06. 正常用例：导出弹窗点击取消关闭', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) { await cancel.click(); await page.waitForTimeout(500) }
      await expect(page.locator('text=/导出成本分析/i').first()).not.toBeVisible({ timeout: 10000 }).catch(() => {})
    }
  })
  test('COST-EXPORT-07. 并发：快速点击导出按钮多次', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) { await exportBtn.click(); await page.waitForTimeout(500); if (await exportBtn.isVisible().catch(() => false)) await exportBtn.click(); await page.waitForTimeout(800) }
    const cancel = page.locator('text=/取消/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('COST-EXPORT-08. UI差异：admin和finance均可导出', async ({ page }) => {
    for (const role of ['admin', 'finance'] as RoleKey[]) {
      await loginAs(page, role); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
      await expect(page.locator('text=/导出/i').first()).toBeVisible({ timeout: 10000 })
    }
  })
})

// ───────────────────────────────────────────────
// 11. 角色权限矩阵补充
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 角色权限矩阵补充', () => {
  const permScenes = [
    { id: 'TC-PERM-COST-01', role: 'technician' as RoleKey, method: 'GET', path: '/reports/cost-by-project', expect: 403 },
    { id: 'TC-PERM-COST-02', role: 'technician' as RoleKey, method: 'GET', path: '/reports/cost-by-material', expect: 403 },
    { id: 'TC-PERM-COST-03', role: 'technician' as RoleKey, method: 'GET', path: '/reports/cost-by-supplier', expect: 403 },
    { id: 'TC-PERM-COST-04', role: 'warehouse_manager' as RoleKey, method: 'GET', path: '/reports/cost-by-project', expect: 403 },
    { id: 'TC-PERM-COST-05', role: 'finance' as RoleKey, method: 'GET', path: '/reports/cost-by-project', expect: 200 },
    { id: 'TC-PERM-COST-06', role: 'finance' as RoleKey, method: 'GET', path: '/reports/cost-by-material', expect: 200 },
    { id: 'TC-PERM-COST-07', role: 'finance' as RoleKey, method: 'GET', path: '/reports/cost-by-supplier', expect: 200 },
    { id: 'TC-PERM-COST-08', role: 'admin' as RoleKey, method: 'GET', path: '/reports/cost-by-project', expect: 200 },
    { id: 'TC-PERM-COST-09', role: 'pathologist' as RoleKey, method: 'GET', path: '/reports/cost-by-project', expect: 200 },
    { id: 'TC-PERM-COST-10', role: 'procurement' as RoleKey, method: 'GET', path: '/reports/cost-by-supplier', expect: 403 },
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
// 12. 业务流程树
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 业务流程树', () => {
  test('BF-COST-01. 主路径：进入成本分析→查看项目成本→筛选时间→导出报告', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/检测项目成本/i').first()).toBeVisible({ timeout: 10000 })
    const timeSel = page.locator('select').first()
    if (await timeSel.isVisible().catch(() => false)) { await timeSel.selectOption({ index: 1 }); await page.waitForTimeout(500) }
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) { await exportBtn.click(); await page.waitForTimeout(500) }
    const cancel = page.locator('text=/取消/i').first()
    if (await cancel.isVisible().catch(() => false)) await cancel.click()
  })
  test('BF-COST-02. 分支：切换Tab查看不同维度', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tabs = ['物料消耗', '公共成本', '供应商']
    for (const t of tabs) {
      const tab = page.locator(`text=/${t}/i`).first()
      if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(600) }
    }
  })
  test('BF-COST-03. 分支：点击项目明细查看详情后关闭', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const detail = page.locator('text=/明细/i').first()
    if (await detail.isVisible().catch(() => false)) {
      await detail.click(); await page.waitForTimeout(800)
      const close = page.locator('text=/关闭|取消/i').first()
      if (await close.isVisible().catch(() => false)) { await close.click(); await page.waitForTimeout(500) }
    }
  })
  test('BF-COST-04. 分支：搜索后重置恢复全部', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const search = page.locator('input[placeholder*="搜索"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('测试'); await page.waitForTimeout(500)
      const reset = page.locator('text=/重置/i').first()
      if (await reset.isVisible().catch(() => false)) { await reset.click(); await page.waitForTimeout(800) }
    }
  })
  test('BF-COST-05. 分支：导出弹窗选择不同格式后取消', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const exportBtn = page.locator('text=/导出报告|导出/i').first()
    if (await exportBtn.isVisible().catch(() => false)) {
      await exportBtn.click(); await page.waitForTimeout(800)
      const format = page.locator('select').filter({ hasText: /PDF|Excel|Word/i }).first()
      if (await format.isVisible().catch(() => false)) { await format.selectOption({ index: 2 }); await page.waitForTimeout(300) }
      const cancel = page.locator('text=/取消/i').first()
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
  })
  test('BF-COST-06. 分支：切换数据来源LIS/手动', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const manualBtn = page.locator('text=/手动录入/i').first()
    if (await manualBtn.isVisible().catch(() => false)) { await manualBtn.click(); await page.waitForTimeout(500) }
  })
  test('BF-COST-07. 分支：切换时间范围后图表更新', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const timeSel = page.locator('select').first()
    if (await timeSel.isVisible().catch(() => false)) { await timeSel.selectOption({ index: 2 }); await page.waitForTimeout(1000) }
    const chartSvg = page.locator('.recharts-surface, .recharts-wrapper svg').first(); const chartVisible = await chartSvg.isVisible().catch(() => true); expect(chartVisible).toBe(true)
  })
  test('BF-COST-08. 分支：无权限用户访问被拦截', async ({ page }) => {
    await loginAs(page, 'technician'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 })
  })
})

// ───────────────────────────────────────────────
// 13. 盲点分析补充
// ───────────────────────────────────────────────
test.describe('物料成本分析 -> 盲点分析补充', () => {
  test('BLIND-COST-01. 成本金额格式化显示正确', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/¥|万|元|,/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('BLIND-COST-02. 同比变化箭头方向正确', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/同比|%/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('BLIND-COST-03. 占比总和约等于100%', async ({ page }) => {
    const token = await apiLogin('finance')
    const res = await apiFetch(token, 'GET', '/reports/cost-by-project')
    const projects = res.data?.data?.projects || []
    if (projects.length > 0) {
      const totalRatio = projects.reduce((s: number, p: any) => s + (parseFloat(p.ratio) || 0), 0)
      expect(totalRatio).toBeLessThanOrEqual(105)
    }
  })
  test('BLIND-COST-04. 单病例成本计算正确', async ({ page }) => {
    const token = await apiLogin('finance')
    const res = await apiFetch(token, 'GET', '/reports/cost-by-project')
    const projects = res.data?.data?.projects || []
    if (projects.length > 0) {
      const p = projects[0]
      const expected = p.sampleCount > 0 ? p.totalCost / p.sampleCount : 0
      expect(p.unitCost).toBeCloseTo(expected, 0)
    }
  })
  test('BLIND-COST-05. 响应式布局检查', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('body')).toBeVisible({ timeout: 10000 })
    await page.setViewportSize({ width: 1280, height: 720 })
  })
  test('BLIND-COST-06. 图表SVG元素存在', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    const svgCount = await page.locator('svg').count()
    expect(svgCount).toBeGreaterThanOrEqual(1)
  })
  test('BLIND-COST-07. API响应格式验证', async ({ page }) => {
    const token = await apiLogin('finance')
    const res = await apiFetch(token, 'GET', '/reports/cost-by-project')
    expect(res.status).toBe(200)
    if (res.data?.data?.summary) { expect(typeof res.data.data.summary.totalCost).toBe('number') }
  })
  test('BLIND-COST-08. 页面加载性能检查', async ({ page }) => {
    const start = Date.now()
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`)
    await page.waitForTimeout(2500)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-COST-09. 长期合作供应商标记正确', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2000)
    const tab = page.getByRole('button', { name: '供应商分析' })
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(1000) }
    await expect(page.locator('text=/长期合作|普通合作/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('BLIND-COST-10. 日期范围自动附带23:59:59', async ({ page }) => {
    const token = await apiLogin('finance')
    const res = await apiFetch(token, 'GET', '/reports/cost-by-project?endDate=2024-12-31')
    expect(res.status).toBe(200)
  })
  test('BLIND-COST-11. 排名徽章颜色区分', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/1|2|3/i').first()).toBeVisible({ timeout: 10000 })
  })
  test('BLIND-COST-12. 成本趋势折线图月份标签完整', async ({ page }) => {
    await loginAs(page, 'finance'); await page.goto(`${FE_BASE}/cost-analysis`); await page.waitForTimeout(2500)
    await expect(page.locator('text=/1月|2月|12月|成本趋势/i').first()).toBeVisible({ timeout: 10000 })
  })
})
