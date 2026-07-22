import { expect, test } from '@playwright/test'
import { apiGet, apiLogin, loginThroughUi } from './fixtures'

test.describe('critical alerts read contract', () => {
  test('admin can open the active alerts page', async ({ page }) => {
    await loginThroughUi(page, 'admin')
    await page.goto('/alerts')

    await expect(page.getByRole('heading', { name: '预警中心' })).toBeVisible()
    await expect(page.getByRole('button', { name: '刷新预警' })).toBeVisible()
  })

  test('admin can read the alerts API', async ({ request }) => {
    const token = await apiLogin(request, 'admin')
    const response = await apiGet(request, token, '/alerts?page=1&pageSize=1')

    expect(response.status()).toBe(200)
  })
})
