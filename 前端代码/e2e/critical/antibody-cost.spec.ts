import { expect, test } from '@playwright/test'
import { apiGet, apiLogin } from './fixtures'

test.describe('critical antibody cost contract', () => {
  test('admin can preview the active full-slide cost breakdown', async ({ request }) => {
    const token = await apiLogin(request, 'admin')
    const response = await apiGet(request, token, '/antibody-cost/cost-preview?perTestPrice=10')

    expect(response.status()).toBe(200)
    expect((await response.json())?.data).toMatchObject({
      primary: 10,
      secondary: 15,
      labor: 8,
      equipment: 3,
      total: 36,
      completeness: '精算',
      laborEquipmentSource: 'G2估',
    })
  })
})
