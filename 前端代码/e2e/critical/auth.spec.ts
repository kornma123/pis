import { expect, test } from '@playwright/test'
import { loginThroughUi } from './fixtures'

test.describe('critical auth contract', () => {
  test('empty credentials stay on login and show both required errors', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    await expect(page).toHaveURL((url) => url.pathname === '/login')
    await expect(page.getByText('请输入用户名', { exact: true })).toBeVisible()
    await expect(page.getByText('请输入密码', { exact: true })).toBeVisible()
  })

  test('invalid password is rejected without creating an authenticated session', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('请输入用户名').fill('admin')
    await page.getByPlaceholder('请输入密码').fill('definitely-wrong')

    const loginResponse = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: '登录', exact: true }).click()

    expect((await loginResponse).status()).toBe(401)
    await expect(page).toHaveURL((url) => url.pathname === '/login')
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull()
  })

  test('admin reaches the authenticated shell and navigation', async ({ page }) => {
    await loginThroughUi(page, 'admin')

    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible()
    await expect(page.getByRole('link', { name: '库存列表' })).toBeVisible()
    await expect(page.getByRole('link', { name: '用户管理' })).toBeVisible()
  })
})
