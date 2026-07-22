import { expect, test } from '@playwright/test'
import { apiGet, apiLogin, loginThroughUi } from './fixtures'

test.describe('critical hospital contribution-margin truth', () => {
  test('unready data stays in calibration mode and cannot mount full-health UI', async ({ page }) => {
    await loginThroughUi(page, 'admin')
    await page.goto('/hospital-cm?mode=full')

    await expect(page.getByRole('heading', { name: '院级贡献毛利看板' })).toBeVisible()
    await expect(page.getByTestId('calibration-view')).toBeVisible()
    await expect(page.getByTestId('full-physical-exam')).toHaveCount(0)
  })

  test('unready full-health endpoint fails closed', async ({ request }) => {
    const token = await apiLogin(request, 'admin')
    const readiness = await apiGet(request, token, '/hospital-pnl/readiness')
    const fullHealth = await apiGet(request, token, '/hospital-pnl/full-health')

    expect(readiness.status()).toBe(200)
    expect((await readiness.json())?.data?.ready).toBe(false)
    expect(fullHealth.status()).toBe(403)
  })

  test('retired deep link redirects to the current contribution-margin page', async ({ page }) => {
    await loginThroughUi(page, 'admin')
    await page.goto('/hospital-pnl')

    await expect(page).toHaveURL((url) => url.pathname === '/hospital-cm')
    await expect(page.getByRole('heading', { name: '院级贡献毛利看板' })).toBeVisible()
  })
})
