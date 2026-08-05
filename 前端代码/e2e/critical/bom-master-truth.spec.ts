import { expect, test } from '@playwright/test'
import { loginThroughUi } from './fixtures'

/**
 * Issue71 — 非 ABC 的 BOM/master-data 响应真值关键路径。
 * 使用真实前端 + 真实后端（:memory: 种子），不 mock 响应：
 * - BOM 列表加载后要么渲染行、要么渲染受控空态（不把 malformed 当空成功）；
 * - 有行时打开详情走真实 detail 链路；
 * - material/project 主数据页可打开，验证共享 request/parser 链路不崩。
 */
test('admin can open the BOM master-data truth path', async ({ page }) => {
  await loginThroughUi(page, 'admin')

  await page.goto('/bom')
  await expect(page.getByRole('heading', { name: 'BOM清单', exact: true })).toBeVisible()

  const emptyState = page.getByText('暂无BOM数据', { exact: true })
  const detailButton = page.locator('tbody tr button', { hasText: '详情' }).first()
  await expect(detailButton.or(emptyState)).toBeVisible()
  if (await detailButton.isVisible()) {
    await detailButton.click()
    await expect(page.getByRole('heading', { name: 'BOM详情', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
  } else {
    await expect(emptyState).toBeVisible()
  }
})

test('admin can open the materials and projects master-data pages', async ({ page }) => {
  await loginThroughUi(page, 'admin')

  const materialsResponse = page.waitForResponse((response) =>
    /\/api\/v1\/materials(?:\?|$)/.test(response.url()) && response.request().method() === 'GET'
  )
  await page.goto('/materials')
  expect((await materialsResponse).ok()).toBeTruthy()
  await expect(page.getByRole('heading', { name: '物料管理', exact: true })).toBeVisible()
  await expect(page.getByText('加载中...', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/加载失败：/)).toHaveCount(0)
  const materialEmpty = page.getByText('暂无数据', { exact: true })
  if (await materialEmpty.isVisible()) {
    await expect(materialEmpty).toBeVisible()
  } else {
    await expect(page.locator('tbody tr').filter({ hasNot: page.locator('td[colspan]') }).first()).toBeVisible()
  }

  const projectsResponse = page.waitForResponse((response) =>
    /\/api\/v1\/projects(?:\?|$)/.test(response.url()) && response.request().method() === 'GET'
  )
  await page.goto('/projects')
  expect((await projectsResponse).ok()).toBeTruthy()
  await expect(page.getByRole('heading', { name: '检测服务', exact: true })).toBeVisible()
  await expect(page.getByText('加载中...', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/加载失败：/)).toHaveCount(0)
  const projectEmpty = page.getByText('暂无检测服务', { exact: true })
  if (await projectEmpty.isVisible()) {
    await expect(projectEmpty).toBeVisible()
  } else {
    await expect(page.locator('tbody tr').filter({ hasNot: page.locator('td[colspan]') }).first()).toBeVisible()
  }
})

test('malformed BOM list response shows explicit error, not empty success', async ({ page }) => {
  await loginThroughUi(page, 'admin')
  await page.route('**/api/v1/boms*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          list: 'malformed',
          pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
        },
      }),
    })
  )
  await page.goto('/bom')
  await expect(page.getByText(/数据格式异常/).first()).toBeVisible()
  await expect(page.getByText('暂无BOM数据', { exact: true })).toHaveCount(0)
})
