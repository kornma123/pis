import { expect, test } from '@playwright/test'
import { apiGet, apiLogin, loginThroughUi } from './fixtures'

test.describe('critical users contract', () => {
  test('admin can open user management', async ({ page }) => {
    await loginThroughUi(page, 'admin')
    await page.goto('/users')

    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建用户' })).toBeVisible()
    await expect(page.getByText('用户总数', { exact: true })).toBeVisible()
  })

  test('technician is redirected away from user management', async ({ page }) => {
    await loginThroughUi(page, 'technician')
    await page.goto('/users')

    await expect(page).toHaveURL((url) => url.pathname === '/')
    await expect(page.getByRole('heading', { name: '用户管理' })).toHaveCount(0)
  })

  test('technician cannot read users through the API', async ({ request }) => {
    const token = await apiLogin(request, 'technician')
    const response = await apiGet(request, token, '/users?page=1&pageSize=1')

    expect(response.status()).toBe(403)
  })
})
