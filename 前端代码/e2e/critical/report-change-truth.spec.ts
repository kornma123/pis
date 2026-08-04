import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiLogin, loginThroughUi } from './fixtures'

/**
 * critical report change-truth（Issue #31 / LOC-030）
 *
 * 覆盖拆分（诚实口径）：
 * - 第一个用例走**真实页面 + 真实后端 API**：真实建库（物料→入库→出库）后，
 *   当前真实后端对未计算同期变化返回 changeRate:null，页面必须 fail-closed 显示
 *   「不可计算」，且重复加载不得出现随机数。
 * - 其余用例覆盖真实后端当前无法产出的合同分支（changeRate 缺键 / 正 / 负，
 *   以及未来公式可能产出的合法 0）：变化率公式未冻结且属 Issue #31 严格排除域，只能在
 *   网络边界构造响应 payload。拦截发生在生产链路（页面/路由/axios/解析/渲染）
 *   之外的上游边界，不 mock 应用本身，也不以源码正则代替行为断言。
 */

const apiBaseUrl = () => {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

async function apiJson(
  request: APIRequestContext,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  data?: unknown,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const response = method === 'GET'
    ? await request.get(`${apiBaseUrl()}${path}`, { headers })
    : await request.post(`${apiBaseUrl()}${path}`, { headers, data })
  const body = await response.json()
  return { response, body }
}

async function expectCreated(result: Awaited<ReturnType<typeof apiJson>>, label: string) {
  expect(result.response.status(), `${label}: ${JSON.stringify(result.body)}`).toBe(201)
  expect(result.body?.data?.id, `${label} returned no id`).toEqual(expect.any(String))
  return result.body.data.id as string
}

/** 通过真实 API 建一行真实出库成本（物料→入库→直接出库），返回物料名。 */
async function seedRealCostRow(request: APIRequestContext, token: string, suffix: string): Promise<string> {
  const category = await apiJson(request, token, 'POST', '/categories', {
    code: `E2ECT${suffix.replace(/\D/g, '').slice(-8)}`,
    name: `报表真值分类-${suffix}`,
    level: 1,
  })
  const categoryId = await expectCreated(category, 'create category')

  const location = await apiJson(request, token, 'POST', '/locations', {
    name: `报表真值库位-${suffix}`,
    zone: `CT-${suffix}`,
    type: 'shelf',
  })
  const locationId = await expectCreated(location, 'create location')

  const materialName = `报表真值物料-${suffix}`
  const material = await apiJson(request, token, 'POST', '/materials', {
    code: `E2E-CT-${suffix}`,
    name: materialName,
    unit: '盒',
    categoryId,
    locationId,
    price: 10,
  })
  const materialId = await expectCreated(material, 'create material')

  const inbound = await apiJson(request, token, 'POST', '/inbound', {
    type: 'purchase',
    materialId,
    batchNo: `LOT-${suffix}`,
    quantity: 10,
    unit: '盒',
    price: 10,
    locationId,
    expiryDate: '2028-12-31',
    operator: 'critical-e2e',
  }, `e2e-ct-inbound-${suffix}`)
  await expectCreated(inbound, 'create inbound')

  const outbound = await apiJson(request, token, 'POST', '/outbound', {
    type: 'direct',
    items: [{ materialId, quantity: 3 }],
    operator: 'critical-e2e',
  }, `e2e-ct-outbound-${suffix}`)
  await expectCreated(outbound, 'create outbound')

  return materialName
}

/** 同比变化列在当前可见表格中的单元格；稳定标识不依赖列顺序。 */
function changeCells(
  page: Parameters<typeof loginThroughUi>[0],
  testId: 'project-change-rate' | 'material-change-rate',
) {
  const changeHeader = page.getByRole('columnheader', { name: '同比变化' })
  const table = page.locator('table', { has: changeHeader })
  return table.getByTestId(testId)
}

async function openMaterialTab(page: Parameters<typeof loginThroughUi>[0]) {
  await page.getByRole('button', { name: '物料消耗分析', exact: true }).click()
}

test.describe('critical report change-truth', () => {
  test('real API: uncomputed null renders as 不可计算 on both tables and stays deterministic across reloads', async ({ page, request }) => {
    const token = await apiLogin(request, 'admin')
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
    const materialName = await seedRealCostRow(request, token, suffix)

    await loginThroughUi(page, 'admin')
    await page.goto('/cost-analysis')
    await expect(page.getByRole('heading', { name: '物料成本分析' })).toBeVisible()

    const assertAllUncomputable = async (testId: 'project-change-rate' | 'material-change-rate') => {
      const cells = changeCells(page, testId)
      await expect(cells.first()).toBeVisible()
      const count = await cells.count()
      expect(count).toBeGreaterThan(0)
      for (let index = 0; index < count; index += 1) {
        await expect(cells.nth(index)).toHaveText('不可计算')
        await expect(cells.nth(index)).not.toContainText('%')
        await expect(cells.nth(index).locator('svg')).toHaveCount(0)
      }
      return count
    }

    // 检测项目成本 tab（默认）：真实出库（无项目）聚合为项目行
    const projectCount = await assertAllUncomputable('project-change-rate')
    expect(projectCount).toBeGreaterThan(0)

    // 物料消耗分析 tab：刚建的真实物料行必须出现且诚实显示不可计算
    await openMaterialTab(page)
    await assertAllUncomputable('material-change-rate')
    const materialRow = page.locator('table tbody tr', { hasText: materialName })
    await expect(materialRow).toHaveCount(1)
    await expect(materialRow.getByTestId('material-change-rate')).toHaveText('不可计算')

    // 重复加载不得随机：真实 API 下两张表前后两次渲染完全一致
    const before = await changeCells(page, 'material-change-rate').allTextContents()
    await page.reload()
    await openMaterialTab(page)
    await assertAllUncomputable('material-change-rate')
    const after = await changeCells(page, 'material-change-rate').allTextContents()
    expect(after).toEqual(before)
  })

  test('backend null / missing changeRate fails closed as 不可计算 with no % or trend svg, stable across reloads', async ({ page }) => {
    await page.route('**/api/v1/reports/cost-by-project**', (route) => route.fulfill({
      json: {
        success: true,
        data: {
          summary: { totalCost: 160, projectCost: 160, publicCost: 0, totalSamples: 3 },
          projects: [
            { id: 'e2e-p1', name: 'E2E空值项目甲', category: 'molecular', sampleCount: 2, unitCost: 50, totalCost: 100, ratio: 0.625, changeRate: null },
            // changeRate 键整体缺失
            { id: 'e2e-p2', name: 'E2E空值项目乙', category: 'molecular', sampleCount: 1, unitCost: 60, totalCost: 60, ratio: 0.375 },
          ],
        },
      },
    }))
    await page.route('**/api/v1/reports/cost-by-material**', (route) => route.fulfill({
      json: {
        success: true,
        data: {
          materials: [
            { id: 'e2e-m1', name: 'E2E空值物料甲', spec: 'SP-1', consumption: 2, consumptionUnit: '盒', totalCost: 20, ratio: 0.667, changeRate: null },
            // changeRate 键整体缺失
            { id: 'e2e-m2', name: 'E2E空值物料乙', spec: 'SP-2', consumption: 1, consumptionUnit: '盒', totalCost: 10, ratio: 0.333 },
          ],
          trend: [],
        },
      },
    }))

    await loginThroughUi(page, 'admin')
    await page.goto('/cost-analysis')
    await expect(page.getByRole('heading', { name: '物料成本分析' })).toBeVisible()

    const assertAllUncomputable = async (
      testId: 'project-change-rate' | 'material-change-rate',
      expectedRows: number,
    ) => {
      const cells = changeCells(page, testId)
      await expect(cells.first()).toBeVisible()
      const count = await cells.count()
      expect(count).toBe(expectedRows)
      for (let index = 0; index < count; index += 1) {
        await expect(cells.nth(index)).toHaveText('不可计算')
        await expect(cells.nth(index)).not.toContainText('%')
        // 不得渲染任何趋势 SVG（TrendingUp/TrendingDown/Minus 均不允许）
        await expect(cells.nth(index).locator('svg')).toHaveCount(0)
      }
    }

    await assertAllUncomputable('project-change-rate', 2)
    await openMaterialTab(page)
    await assertAllUncomputable('material-change-rate', 2)

    // 重复加载不得随机：null 分支两次加载渲染必须完全一致
    const before = await changeCells(page, 'material-change-rate').allTextContents()
    await page.reload()
    await openMaterialTab(page)
    await assertAllUncomputable('material-change-rate', 2)
    const after = await changeCells(page, 'material-change-rate').allTextContents()
    expect(after).toEqual(before)
  })

  test('legit 0 / positive / negative changeRate keep their exact badge semantics', async ({ page }) => {
    await page.route('**/api/v1/reports/cost-by-project**', (route) => route.fulfill({
      json: {
        success: true,
        data: {
          summary: { totalCost: 300, projectCost: 300, publicCost: 0, totalSamples: 6 },
          projects: [
            { id: 'e2e-p0', name: 'E2E合法零项目', category: 'molecular', sampleCount: 2, unitCost: 50, totalCost: 100, ratio: 0.333, changeRate: 0 },
            { id: 'e2e-pp', name: 'E2E合法正项目', category: 'molecular', sampleCount: 2, unitCost: 50, totalCost: 100, ratio: 0.333, changeRate: 12.5 },
            { id: 'e2e-pn', name: 'E2E合法负项目', category: 'molecular', sampleCount: 2, unitCost: 50, totalCost: 100, ratio: 0.333, changeRate: -7 },
          ],
        },
      },
    }))
    await page.route('**/api/v1/reports/cost-by-material**', (route) => route.fulfill({
      json: {
        success: true,
        data: {
          materials: [
            { id: 'e2e-m0', name: 'E2E合法零物料', spec: 'SP-0', consumption: 2, consumptionUnit: '盒', totalCost: 20, ratio: 0.333, changeRate: 0 },
            { id: 'e2e-mp', name: 'E2E合法正物料', spec: 'SP-P', consumption: 2, consumptionUnit: '盒', totalCost: 20, ratio: 0.333, changeRate: 3 },
            { id: 'e2e-mn', name: 'E2E合法负物料', spec: 'SP-N', consumption: 2, consumptionUnit: '盒', totalCost: 20, ratio: 0.333, changeRate: -2.5 },
          ],
          trend: [],
        },
      },
    }))

    await loginThroughUi(page, 'admin')
    await page.goto('/cost-analysis')
    await expect(page.getByRole('heading', { name: '物料成本分析' })).toBeVisible()

    const expectBadges = async (
      testId: 'project-change-rate' | 'material-change-rate',
      expected: string[],
    ) => {
      const cells = changeCells(page, testId)
      await expect(cells.first()).toBeVisible()
      const count = await cells.count()
      expect(count).toBe(expected.length)
      for (let index = 0; index < count; index += 1) {
        await expect(cells.nth(index)).toHaveText(expected[index])
        // 合法值走真实 ChangeBadge：趋势 SVG 必须存在
        await expect(cells.nth(index).locator('svg')).toHaveCount(1)
        await expect(cells.nth(index)).not.toContainText('不可计算')
      }
    }

    await expectBadges('project-change-rate', ['0%', '+12.5%', '-7%'])
    await openMaterialTab(page)
    await expectBadges('material-change-rate', ['0%', '+3%', '-2.5%'])
  })
})
