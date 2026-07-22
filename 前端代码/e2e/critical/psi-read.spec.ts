import { expect, test } from '@playwright/test'
import { loginThroughUi } from './fixtures'

const readFlows = [
  { path: '/inventory', heading: '库存列表' },
  { path: '/inbound', heading: '入库记录' },
  { path: '/outbound', heading: '出库记录' },
] as const

for (const flow of readFlows) {
  test(`admin can open the current ${flow.heading} flow`, async ({ page }) => {
    await loginThroughUi(page, 'admin')
    await page.goto(flow.path)

    await expect(page).toHaveURL((url) => url.pathname === flow.path)
    await expect(page.getByRole('heading', { name: flow.heading, exact: true })).toBeVisible()
  })
}
