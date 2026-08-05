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

  await page.goto('/materials')
  await expect(page.getByRole('heading', { name: '物料管理', exact: true })).toBeVisible()

  await page.goto('/projects')
  await expect(page.getByRole('heading', { name: '检测服务', exact: true })).toBeVisible()
})
