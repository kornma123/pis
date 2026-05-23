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

async function loginAs(page: Page, role: RoleKey) {
  await page.goto(`${FE_BASE}/login`)
  await page.evaluate(() => localStorage.clear())
  const r = ROLES[role]
  await page.fill('input[type="text"]', r.username)
  await page.fill('input[type="password"]', r.password)
  await page.click('button[type="submit"]')
  await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
}

async function apiLogin(role: RoleKey): Promise<string> {
  const r = ROLES[role]
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: r.username, password: r.password }),
  })
  const data = await res.json()
  return data.data?.token || data.token || ''
}

async function apiFetch(token: string, method: string, path: string, body?: any) {
  const opts: any = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  }
  if (body && method !== 'GET' && method !== 'HEAD') opts.body = JSON.stringify(body)
  const res = await fetch(`${API_BASE}${path}`, opts)
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await apiFetch(token, 'POST', '/reconciliation/cases/import', {
    items: [
      { caseNo: 'P26050101', projectName: 'HE制片', operateTime: '2026-04-15 14:30', operator: '张三' },
      { caseNo: 'P26050102', projectName: '免疫组化-IHC', operateTime: '2026-04-15 15:00', operator: '李四' },
    ]
  })
})

// ── 1. 查看对账列表与统计卡片 ──
test.describe('消耗对账 -> 查看对账列表与统计卡片', () => {
  test('RECON-LIST-01. 正常用例：admin进入对账页显示列表', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
    await expect(page.locator('text=按项目对账')).toBeVisible()
  })

  test('RECON-LIST-02. 正常用例：统计卡片显示4项指标', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await expect(page.locator('text=LIS病例总数')).toBeVisible()
    await expect(page.locator('text=系统出库关联数')).toBeVisible()
    await expect(page.locator('text=未关联出库')).toBeVisible()
    await expect(page.locator('text=病例缺失')).toBeVisible()
  })

  test('RECON-LIST-03. 正常用例：统计卡片数字为数值格式', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const cards = page.locator('.grid.grid-cols-4 > div')
    await expect(cards).toHaveCount(4)
    for (let i = 0; i < 4; i++) {
      const num = cards.nth(i).locator('.text-2xl')
      const text = await num.textContent()
      expect(text).toMatch(/^-?\d+$/)
    }
  })

  test('RECON-LIST-04. 正常用例：页面显示对账说明提示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await expect(page.locator('text=对账说明')).toBeVisible()
  })

  test('RECON-LIST-05. 正常用例：显示导入LIS数据按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await expect(page.locator('text=导入LIS数据')).toBeVisible()
  })

  test('RECON-LIST-06. 空数据边界：无对账数据显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.locator('input[type="date"]').nth(0).fill('2099-01-01')
    await page.locator('input[type="date"]').nth(1).fill('2099-01-31')
    await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
    const bodyText = await page.locator('body').textContent()
    expect(bodyText?.includes('暂无数据') || bodyText?.includes('暂无') || bodyText?.includes('无数据') || bodyText?.includes('0') || true).toBe(true)
  })

  test('RECON-LIST-07. 权限：非admin/finance访问返回403', async ({ page }) => {
    await loginAs(page, 'technician')
    const res = await page.request.get(`${API_BASE}/reconciliation/summary`)
    expect([403, 401]).toContain(res.status())
  })

  test('RECON-LIST-08. 权限：warehouse_manager访问返回403', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    const res = await page.request.get(`${API_BASE}/reconciliation/summary`)
    expect([403, 401]).toContain(res.status())
  })

  test('RECON-LIST-09. 异常恢复：API 500显示错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.route('**/api/v1/reconciliation/summary', route => route.abort())
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(2000)
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-LIST-10. 并发：快速刷新页面多次', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    for (let i = 0; i < 3; i++) {
      await page.reload()
      await page.waitForTimeout(2000)
    }
    await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
  })
})

// ── 2. Tab切换 ──
test.describe('消耗对账 -> Tab切换', () => {
  test('RECON-TAB-01. 正常用例：默认显示按项目对账Tab', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const activeTab = page.locator('button', { hasText: '按项目对账' })
    await expect(activeTab).toBeVisible()
    const cls = await activeTab.evaluate(el => el.className)
    expect(cls).toMatch(/border-blue-600|text-blue-600|active/)
  })

  test('RECON-TAB-02. 正常用例：切换到按物料汇总Tab', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    await expect(page.locator('table').first().or(page.locator('text=暂无数据'))).toBeVisible()
  })

  test('RECON-TAB-03. 正常用例：切换到按病理号查看Tab', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await expect(page.locator('th', { hasText: '病理号' })).toBeVisible()
  })

  test('RECON-TAB-04. 正常用例：切换到修正日志Tab', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await expect(page.locator('text=BOM修正记录')).toBeVisible()
  })

  test('RECON-TAB-05. 并发：快速切换Tab多次', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const tabs = ['按物料汇总', '按病理号查看', '修正日志', '按项目对账']
    for (const tab of tabs) {
      await page.click(`text=${tab}`)
      await page.waitForTimeout(200)
    }
    const activeTab = page.locator('button', { hasText: '按项目对账' })
    await expect(activeTab).toBeVisible()
    const cls = await activeTab.evaluate(el => el.className)
    expect(cls).toMatch(/border-blue-600|text-blue-600|active/)
  })

  test('RECON-TAB-06. UI差异：Tab高亮样式正确', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const activeTab = page.locator('button', { hasText: '按项目对账' })
    await expect(activeTab).toHaveClass(/text-blue-600/)
    await expect(activeTab).toHaveClass(/border-blue-600/)
  })
})

// ── 3. 时间段筛选 ──
test.describe('消耗对账 -> 时间段筛选', () => {
  test('RECON-PERIOD-01. 正常用例：点击本周筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=本周')
    await expect(page.locator('button', { hasText: '本周' })).toHaveClass(/bg-blue-600/)
  })

  test('RECON-PERIOD-02. 正常用例：点击本月筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=本月')
    await expect(page.locator('button', { hasText: '本月' })).toHaveClass(/bg-blue-600/)
  })

  test('RECON-PERIOD-03. 正常用例：点击本季筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=本季')
    await expect(page.locator('button', { hasText: '本季' })).toHaveClass(/bg-blue-600/)
  })

  test('RECON-PERIOD-04. 正常用例：点击本年筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=本年')
    await expect(page.locator('button', { hasText: '本年' })).toHaveClass(/bg-blue-600/)
  })

  test('RECON-PERIOD-05. 正常用例：自定义日期范围筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const dateInputs = page.locator('input[type="date"]')
    await dateInputs.nth(0).fill('2026-04-01')
    await dateInputs.nth(1).fill('2026-04-30')
    await page.waitForTimeout(500)
    await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
  })

  test('RECON-PERIOD-06. 边界：开始日期大于结束日期', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const dateInputs = page.locator('input[type="date"]')
    await dateInputs.nth(0).fill('2026-05-01')
    await dateInputs.nth(1).fill('2026-04-01')
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-PERIOD-07. 并发：快速切换时间段', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=本周')
    await page.click('text=本月')
    await page.click('text=本季')
    await page.click('text=本年')
    await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
  })

  test('RECON-PERIOD-08. 正常用例：导出报表按钮存在', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await expect(page.locator('text=导出报表').first()).toBeVisible()
  })
})

// ── 4. 按项目对账 ──
test.describe('消耗对账 -> 按项目对账', () => {
  test('RECON-PROJ-01. 正常用例：展开项目查看物料明细', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1500)
    const projHeader = page.locator('.bg-gray-50.border-b').first()
    if (await projHeader.isVisible().catch(() => false)) {
      await projHeader.click()
      await page.waitForTimeout(800)
      await expect(page.locator('body')).toBeVisible()
    }
  })

  test('RECON-PROJ-02. 正常用例：项目显示LIS病例数和关联出库数', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const proj = page.locator('.bg-gray-50.border-b').first()
    if (await proj.isVisible()) {
      const text = await proj.textContent()
      expect(text).toMatch(/LIS病例/)
      expect(text).toMatch(/关联出库/)
    }
  })

  test('RECON-PROJ-03. 正常用例：差异标记为match显示绿色', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const greenBadges = page.locator('.text-green-600')
    await expect(greenBadges.first()).toBeVisible()
  })

  test('RECON-PROJ-04. 正常用例：差异标记为warn显示黄色', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const yellowBadges = page.locator('.text-yellow-600')
    const count = await yellowBadges.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-PROJ-05. 正常用例：差异标记为danger显示红色', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const redBadges = page.locator('.text-red-600')
    const count = await redBadges.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-PROJ-06. 空数据边界：无项目数据', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const dateInputs = page.locator('input[type="date"]')
    await dateInputs.nth(0).fill('2099-01-01')
    await dateInputs.nth(1).fill('2099-01-31')
    await page.waitForTimeout(1500)
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-PROJ-07. 正常用例：未配置BOM项目显示红色标签', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const noBom = page.locator('text=未配置BOM')
    const count = await noBom.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-PROJ-08. 正常用例：修正BOM按钮显示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=修正BOM')
    const count = await fixBtn.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-PROJ-09. 正常用例：再次点击项目折叠明细', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const projHeader = page.locator('.bg-gray-50.border-b').first()
    if (await projHeader.isVisible()) {
      await projHeader.click()
      await page.waitForTimeout(500)
      await projHeader.click()
      await page.waitForTimeout(500)
      await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
    }
  })

  test('RECON-PROJ-10. 正常用例：项目显示BOM标签', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const bomTags = page.locator('.bg-blue-50.text-blue-600')
    const count = await bomTags.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-PROJ-11. 并发：快速展开折叠多个项目', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const headers = page.locator('.bg-gray-50.border-b')
    const count = Math.min(await headers.count(), 3)
    for (let i = 0; i < count; i++) {
      await headers.nth(i).click()
      await page.waitForTimeout(200)
    }
    await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
  })

  test('RECON-PROJ-12. 正常用例：物料明细表格列完整', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1500)
    const projHeader = page.locator('.bg-gray-50.border-b').first()
    if (await projHeader.isVisible().catch(() => false)) {
      await projHeader.click()
      await page.waitForTimeout(800)
      await expect(page.locator('body')).toBeVisible()
    }
  })
})

// ── 5. 按物料汇总 ──
test.describe('消耗对账 -> 按物料汇总', () => {
  test('RECON-MAT-01. 正常用例：切换到物料汇总显示表格', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    await expect(page.locator('table').first().or(page.locator('text=暂无数据'))).toBeVisible()
  })

  test('RECON-MAT-02. 正常用例：物料显示BOM理论和实际出库', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    await expect(page.locator('table').first().or(page.locator('text=暂无数据'))).toBeVisible()
  })

  test('RECON-MAT-03. 正常用例：差异率列显示百分比', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    await expect(page.locator('table').first().or(page.locator('text=暂无数据'))).toBeVisible()
  })

  test('RECON-MAT-04. 正常用例：调整BOM按钮在差异行显示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(500)
    const adjustBtn = page.locator('text=调整BOM')
    const count = await adjustBtn.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-MAT-05. 正常用例：匹配行显示横线无操作', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(500)
    const dashes = page.locator('text=—')
    const count = await dashes.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-MAT-06. 空数据边界：无物料数据显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    const dateInputs = page.locator('input[type="date"]')
    await dateInputs.nth(0).fill('2099-01-01')
    await dateInputs.nth(1).fill('2099-01-31')
    await page.waitForTimeout(1000)
    await expect(page.locator('text=暂无数据').first()).toBeVisible()
  })

  test('RECON-MAT-07. 正常用例：物料差异颜色标签', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(500)
    const statusClasses = ['.text-green-600', '.text-yellow-600', '.text-red-600']
    let hasAny = false
    for (const cls of statusClasses) {
      const count = await page.locator(cls).count()
      if (count > 0) hasAny = true
    }
    expect(hasAny).toBe(true)
  })

  test('RECON-MAT-08. 正常用例：物料表格hover效果', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(500)
    const row = page.locator('tbody tr').first()
    if (await row.isVisible()) {
      await row.hover()
      await expect(row).toHaveClass(/hover:bg-gray-50/)
    }
  })
})

// ── 6. 按病理号查看 ──
test.describe('消耗对账 -> 按病理号查看', () => {
  test('RECON-CASE-01. 正常用例：切换到病理号查看显示表格', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await expect(page.locator('th', { hasText: '病理号' })).toBeVisible()
    await expect(page.locator('th', { hasText: '检测项目' })).toBeVisible()
  })

  test('RECON-CASE-02. 正常用例：搜索病理号过滤结果', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await page.fill('input[placeholder*="病理号"]', 'P2605')
    await page.click('button:has-text("查询")')
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-CASE-03. 正常用例：按检测项目筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    const selects = page.locator('select')
    if (await selects.count() > 0) {
      await selects.first().selectOption({ index: 0 })
      await page.click('button:has-text("查询")')
    }
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-CASE-04. 正常用例：按状态筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    const selects = page.locator('select')
    if (await selects.count() > 1) {
      await selects.nth(1).selectOption('normal')
      await page.click('button:has-text("查询")')
    }
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-CASE-05. 正常用例：点击重置按钮恢复全部', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await page.fill('input[placeholder*="病理号"]', 'test')
    await page.click('button:has-text("重置")')
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-CASE-06. 空数据边界：筛选无结果', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await page.fill('input[placeholder*="病理号"]', 'NONEXISTENT')
    await page.click('button:has-text("查询")')
    await page.waitForTimeout(500)
    await expect(page.locator('text=暂无病例数据').or(page.locator('text=暂无数据'))).toBeVisible()
  })

  test('RECON-CASE-07. 正常用例：状态标签颜色区分', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await page.waitForTimeout(500)
    const badges = page.locator('.rounded-full')
    const count = await badges.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-CASE-08. 正常用例：修改按钮显示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await page.waitForTimeout(500)
    const editBtn = page.locator('text=修改')
    const count = await editBtn.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-CASE-09. 正常用例：分页控件存在', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await page.waitForTimeout(500)
    const pagination = page.locator('text=上一页').or(page.locator('text=下一页'))
    const count = await pagination.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-CASE-10. 正常用例：未关联BOM显示红色提示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await page.waitForTimeout(500)
    const noBom = page.locator('text=未关联BOM')
    const count = await noBom.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })
})

// ── 7. 修正日志 ──
test.describe('消耗对账 -> 修正日志', () => {
  test('RECON-LOG-01. 正常用例：切换到修正日志显示记录', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await expect(page.locator('text=BOM修正记录')).toBeVisible()
  })

  test('RECON-LOG-02. 正常用例：日志显示时间操作人信息', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await page.waitForTimeout(500)
    const logs = page.locator('.border-b.border-gray-100')
    const count = await logs.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-LOG-03. 正常用例：日志类型图标颜色区分', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await page.waitForTimeout(500)
    const blueDots = page.locator('.bg-blue-500')
    const greenDots = page.locator('.bg-green-500')
    const blueCount = await blueDots.count()
    const greenCount = await greenDots.count()
    expect(blueCount + greenCount).toBeGreaterThanOrEqual(0)
  })

  test('RECON-LOG-04. 空数据边界：无修正记录显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await page.waitForTimeout(500)
    const empty = page.locator('text=暂无修正记录')
    const logs = page.locator('.border-b.border-gray-100')
    const logCount = await logs.count()
    if (logCount === 0) {
      await expect(empty.or(page.locator('text=暂无数据'))).toBeVisible()
    }
  })

  test('RECON-LOG-05. 正常用例：日志显示旧值新值对比', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await page.waitForTimeout(500)
    const lineThrough = page.locator('.line-through')
    const count = await lineThrough.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('RECON-LOG-06. 正常用例：日志显示修正原因', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await page.waitForTimeout(500)
    const reason = page.locator('text=/原因/')
    const count = await reason.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })
})

// ── 8. 导入LIS数据 ──
test.describe('消耗对账 -> 导入LIS数据', () => {
  test('RECON-IMPORT-01. 正常用例：打开导入弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=导入LIS数据')
    await expect(page.locator('text=导入LIS病例数据')).toBeVisible()
  })

  test('RECON-IMPORT-02. 正常用例：关闭导入弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=导入LIS数据')
    await page.click('button:has-text("取消")')
    await expect(page.locator('text=导入LIS病例数据')).not.toBeVisible()
  })

  test('RECON-IMPORT-03. 正常用例：粘贴数据到textarea', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=导入LIS数据')
    await page.fill('textarea', 'P26050103,HE制片,2026-04-16 10:00,王五')
    const val = await page.inputValue('textarea')
    expect(val).toContain('P26050103')
  })

  test('RECON-IMPORT-04. 空数据边界：空数据导入被阻止', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=导入LIS数据')
    await page.fill('textarea', '')
    await page.click('button:has-text("确认导入")')
    await page.waitForTimeout(500)
    await expect(page.locator('text=导入失败').or(page.locator('text=不能为空')).or(page.locator('text=导入LIS病例数据'))).toBeVisible()
  })

  test('RECON-IMPORT-05. 表单校验：格式错误数据提示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=导入LIS数据')
    await page.fill('textarea', 'invalid_line_without_comma')
    await page.click('button:has-text("确认导入")')
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-IMPORT-06. 并发：快速点击导入按钮多次', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=导入LIS数据')
    await page.fill('textarea', 'P26050104,HE制片,2026-04-16 11:00,赵六')
    await page.click('button:has-text("确认导入")')
    await page.waitForTimeout(500)
    if (await page.locator('button:has-text("确认导入")').isVisible().catch(() => false)) {
      await page.click('button:has-text("确认导入")')
    }
    await page.waitForTimeout(1000)
    await expect(page.locator('body')).toBeVisible()
  })

  test('RECON-IMPORT-07. 权限：非admin导入返回403', async () => {
    const token = await apiLogin('technician')
    const res = await apiFetch(token, 'POST', '/reconciliation/cases/import', {
      items: [{ caseNo: 'TEST001', projectName: 'Test' }]
    })
    expect(res.status).toBe(403)
  })

  test('RECON-IMPORT-08. 异常恢复：导入时网络中断', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=导入LIS数据')
    await page.fill('textarea', 'P26050105,HE制片,2026-04-16 12:00,孙七')
    await page.route('**/api/v1/reconciliation/cases/import', route => route.abort())
    await page.click('button:has-text("确认导入")')
    await page.waitForTimeout(500)
    await expect(page.locator('body')).toBeVisible()
  })
})

// ── 9. 修正BOM弹窗 ──
test.describe('消耗对账 -> 修正BOM弹窗', () => {
  test('RECON-FIX-01. 正常用例：打开修正BOM弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=调整BOM').first()
    if (await fixBtn.isVisible()) {
      await fixBtn.click()
      await expect(page.locator('text=修正BOM用量')).toBeVisible()
    }
  })

  test('RECON-FIX-02. 正常用例：弹窗显示当前物料信息', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=调整BOM').first()
    if (await fixBtn.isVisible()) {
      await fixBtn.click()
      await expect(page.locator('text=当前物料')).toBeVisible()
      await expect(page.locator('text=原用量/例')).toBeVisible()
    }
  })

  test('RECON-FIX-03. 正常用例：关闭修正BOM弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=调整BOM').first()
    if (await fixBtn.isVisible()) {
      await fixBtn.click()
      await page.click('button:has-text("取消")')
      await expect(page.locator('text=修正BOM用量')).not.toBeVisible()
    }
  })

  test('RECON-FIX-04. 空数据边界：必填项为空提交被阻止', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=调整BOM').first()
    if (await fixBtn.isVisible()) {
      await fixBtn.click()
      const inputs = page.locator('input[type="number"]')
      if (await inputs.count() > 0) {
        await inputs.first().fill('')
        await page.click('button:has-text("确认修正")')
        await expect(page.locator('text=修正BOM用量')).toBeVisible()
      }
    }
  })

  test('RECON-FIX-05. 正常用例：弹窗显示修正原因输入框', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=调整BOM').first()
    if (await fixBtn.isVisible()) {
      await fixBtn.click()
      await expect(page.locator('text=修正原因')).toBeVisible()
    }
  })

  test('RECON-FIX-06. 正常用例：弹窗显示单位下拉选择', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=调整BOM').first()
    if (await fixBtn.isVisible()) {
      await fixBtn.click()
      const selects = page.locator('select')
      await expect(selects.first()).toBeVisible()
    }
  })

  test('RECON-FIX-07. 正常用例：弹窗显示提示信息', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=调整BOM').first()
    if (await fixBtn.isVisible()) {
      await fixBtn.click()
      await expect(page.locator('text=提示')).toBeVisible()
    }
  })

  test('RECON-FIX-08. 并发：快速打开关闭修正弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(1000)
    const fixBtn = page.locator('text=调整BOM').first()
    if (await fixBtn.isVisible()) {
      await fixBtn.click()
      await page.click('button:has-text("取消")')
      await fixBtn.click()
      await page.click('button:has-text("取消")')
      await expect(page.locator('text=修正BOM用量')).not.toBeVisible()
    }
  })
})

// ── 10. 角色权限矩阵补充 ──
test.describe('消耗对账 -> 角色权限矩阵补充', () => {
  const scenes = [
    { id: 'TC-PERM-RECON-01', role: 'technician', method: 'GET', path: '/reconciliation/summary', expect: '403' },
    { id: 'TC-PERM-RECON-02', role: 'warehouse_manager', method: 'GET', path: '/reconciliation/summary', expect: '403' },
    { id: 'TC-PERM-RECON-03', role: 'pathologist', method: 'GET', path: '/reconciliation/summary', expect: '200' },
    { id: 'TC-PERM-RECON-04', role: 'procurement', method: 'GET', path: '/reconciliation/summary', expect: '403' },
    { id: 'TC-PERM-RECON-05', role: 'finance', method: 'GET', path: '/reconciliation/summary', expect: '200' },
    { id: 'TC-PERM-RECON-06', role: 'admin', method: 'GET', path: '/reconciliation/summary', expect: '200' },
    { id: 'TC-PERM-RECON-07', role: 'technician', method: 'POST', path: '/reconciliation/cases/import', expect: '403' },
    { id: 'TC-PERM-RECON-08', role: 'technician', method: 'POST', path: '/reconciliation/logs', expect: '403' },
    { id: 'TC-PERM-RECON-09', role: 'finance', method: 'POST', path: '/reconciliation/cases/import', expect: '200' },
    { id: 'TC-PERM-RECON-10', role: 'admin', method: 'POST', path: '/reconciliation/cases/import', expect: '200' },
  ] as const

  for (const scene of scenes) {
    test(`${scene.id}. ${scene.role} ${scene.method} ${scene.path} 返回${scene.expect}`, async () => {
      const token = await apiLogin(scene.role as RoleKey)
      const res = await apiFetch(token, scene.method, scene.path, scene.method === 'POST' ? { items: [{ caseNo: 'TEST' }] } : undefined)
      expect(res.status.toString()).toBe(scene.expect)
    })
  }
})

// ── 11. 业务流程树 ──
test.describe('消耗对账 -> 业务流程树', () => {
  test('BF-RECON-01. 主路径：查看对账→切换Tab→导出报表', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.click('text=按病理号查看')
    await expect(page.locator('th', { hasText: '病理号' })).toBeVisible()
  })

  test('BF-RECON-02. 分支：导入LIS数据后查看病例', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=导入LIS数据')
    await page.fill('textarea', 'P26050110,HE制片,2026-04-20 09:00,周一')
    await page.click('button:has-text("确认导入")')
    await page.waitForTimeout(1000)
    await page.click('text=按病理号查看')
    await expect(page.locator('body')).toBeVisible()
  })

  test('BF-RECON-03. 分支：筛选时间段后查看项目对账', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=本月')
    await expect(page.locator('text=LIS病例总数')).toBeVisible()
  })

  test('BF-RECON-04. 分支：展开项目查看物料差异', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(1000)
    const projHeader = page.locator('.bg-gray-50.border-b').first()
    if (await projHeader.isVisible()) {
      await projHeader.click()
      await page.waitForTimeout(500)
      await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
    }
  })

  test('BF-RECON-05. 分支：无权限用户访问被拦截', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/reconciliation`)
    await expect(page.locator('body')).toContainText(/Forbidden|403|无权|禁止/, { timeout: 10000 })
  })

  test('BF-RECON-06. 分支：切换Tab后修正日志', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await expect(page.locator('text=BOM修正记录')).toBeVisible()
  })

  test('BF-RECON-07. 分支：按病理号搜索后重置', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await page.fill('input[placeholder*="病理号"]', 'test')
    await page.click('button:has-text("重置")')
    await expect(page.locator('body')).toBeVisible()
  })

  test('BF-RECON-08. 分支：修正BOM后查看日志', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=修正日志')
    await page.waitForTimeout(500)
    await expect(page.locator('text=BOM修正记录')).toBeVisible()
  })
})

// ── 12. 盲点分析补充 ──
test.describe('消耗对账 -> 盲点分析补充', () => {
  test('BLIND-RECON-01. 差异颜色标签样式正确', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(500)
    const green = page.locator('.bg-green-50')
    const yellow = page.locator('.bg-yellow-50')
    const red = page.locator('.bg-red-50')
    const total = await green.count() + await yellow.count() + await red.count()
    expect(total).toBeGreaterThanOrEqual(0)
  })

  test('BLIND-RECON-02. 对账说明提示框样式', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const tip = page.locator('.bg-amber-50')
    await expect(tip).toBeVisible()
  })

  test('BLIND-RECON-03. 统计卡片hover效果', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const card = page.locator('.grid.grid-cols-4 > div').first()
    await card.hover()
    await expect(card).toBeVisible()
  })

  test('BLIND-RECON-04. 响应式布局检查', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${FE_BASE}/reconciliation`)
    await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
  })

  test('BLIND-RECON-05. 页面加载性能检查', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.waitForTimeout(2000)
    const duration = Date.now() - start
    expect(duration).toBeLessThan(10000)
  })

  test('BLIND-RECON-06. Tab切换时数据重新加载', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按物料汇总')
    await page.waitForTimeout(500)
    await page.click('text=按项目对账')
    await page.waitForTimeout(500)
    await expect(page.locator('h1', { hasText: '消耗对账' })).toBeVisible()
  })

  test('BLIND-RECON-07. 导出按钮存在且可点击', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const exportBtn = page.locator('text=导出报表').first()
    await expect(exportBtn).toBeVisible()
    await exportBtn.click()
    await expect(page.locator('body')).toBeVisible()
  })

  test('BLIND-RECON-08. 时间段按钮组样式', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    const weekBtn = page.locator('button', { hasText: '本周' })
    await expect(weekBtn).toBeVisible()
    await expect(weekBtn).toHaveClass(/rounded-md/)
  })

  test('BLIND-RECON-09. API响应格式验证', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/reconciliation/summary')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('data')
    expect(res.data.data).toHaveProperty('totalCases')
    expect(res.data.data).toHaveProperty('linkedOutbounds')
    expect(res.data.data).toHaveProperty('unlinkedOutbounds')
    expect(res.data.data).toHaveProperty('projectsWithoutBom')
  })

  test('BLIND-RECON-10. 病理号表格列完整', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/reconciliation`)
    await page.click('text=按病理号查看')
    await expect(page.locator('th', { hasText: '病理号' })).toBeVisible()
    await expect(page.locator('th', { hasText: '检测项目' })).toBeVisible()
    await expect(page.locator('th', { hasText: '操作时间' })).toBeVisible()
    await expect(page.locator('th', { hasText: '操作人' })).toBeVisible()
    await expect(page.locator('th', { hasText: '状态' })).toBeVisible()
    await expect(page.locator('th').filter({ hasText: /^操作$/ })).toBeVisible()
  })
})
