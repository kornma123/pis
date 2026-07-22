import { expect, test } from '@playwright/test'
import { apiGet, apiLogin, loginThroughUi } from './fixtures'

test.describe('critical supplier-return contract', () => {
  test('warehouse manager sees the writable supplier-return flow', async ({ page }) => {
    await loginThroughUi(page, 'warehouse_manager')
    await page.goto('/supplier-returns')

    await expect(page.getByRole('heading', { name: '退货给供应商' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建退货' })).toBeVisible()
  })

  test('finance sees the same records as read-only', async ({ page }) => {
    await loginThroughUi(page, 'finance')
    await page.goto('/supplier-returns')

    await expect(page.getByRole('heading', { name: '退货给供应商' })).toBeVisible()
    await expect(page.getByText('查看物料退回供应商的记录（只读）')).toBeVisible()
    await expect(page.getByRole('button', { name: '新建退货' })).toHaveCount(0)
  })

  test('technician cannot read supplier returns through the API', async ({ request }) => {
    const token = await apiLogin(request, 'technician')
    const response = await apiGet(request, token, '/supplier-returns?page=1&pageSize=1')

    expect(response.status()).toBe(403)
  })
})
