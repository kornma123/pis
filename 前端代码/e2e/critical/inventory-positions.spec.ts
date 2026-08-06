import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiLogin, loginThroughUi } from './fixtures'

type CreatedMaterial = {
  id: string
  code: string
  name: string
  unit: string
}

type CreatedPosition = {
  locationId: string
  locationName: string
  quantity: number
}

function apiBaseUrl(): string {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

async function expectCreatedId(
  response: Awaited<ReturnType<APIRequestContext['post']>>,
  label: string,
): Promise<string> {
  const body = await response.json() as { success?: boolean, data?: { id?: unknown } }
  expect(response.status(), `${label}: ${JSON.stringify(body)}`).toBe(201)
  expect(body).toMatchObject({ success: true })
  expect(body.data?.id).toEqual(expect.any(String))
  return body.data!.id as string
}

test('inventory detail renders the exact position truth created by real inbound APIs', async ({ page, request }) => {
  const token = await apiLogin(request, 'admin')
  const suffix = randomUUID().replaceAll('-', '')
  const categoryResponse = await request.post(`${apiBaseUrl()}/categories`, {
    headers: authorization(token),
    data: {
      code: `E2EIP${suffix.slice(0, 12)}`,
      name: `E2E inventory-position category ${suffix}`,
      level: 1,
    },
  })
  const categoryId = await expectCreatedId(categoryResponse, 'create category')

  const material: CreatedMaterial = {
    id: '',
    code: `E2E-IP-${suffix}`,
    name: `库存位置关键链路-${suffix}`,
    unit: '盒',
  }
  const materialResponse = await request.post(`${apiBaseUrl()}/materials`, {
    headers: authorization(token),
    data: {
      code: material.code,
      name: material.name,
      unit: material.unit,
      categoryId,
      batchManaged: true,
      price: 1,
      unitsPerPackage: 1,
      slotsPerPackage: 1,
    },
  })
  material.id = await expectCreatedId(materialResponse, 'create material')

  const positions: CreatedPosition[] = []
  for (const [index, quantity] of [0.1, 0.2, 0.3].entries()) {
    const locationName = `库存位置关键库位-${index + 1}-${suffix}`
    const locationResponse = await request.post(`${apiBaseUrl()}/locations`, {
      headers: authorization(token),
      data: {
        name: locationName,
        zone: `E2E-IP-${index + 1}`,
        capacity: 100,
      },
    })
    const locationId = await expectCreatedId(locationResponse, `create location ${index + 1}`)
    positions.push({ locationId, locationName, quantity })

    const inboundResponse = await request.post(`${apiBaseUrl()}/inbound`, {
      headers: {
        ...authorization(token),
        'Idempotency-Key': `e2e-inventory-position-${suffix}-${index + 1}`,
      },
      data: {
        type: 'direct',
        materialId: material.id,
        batchNo: `E2E-IP-BATCH-${suffix}`,
        quantity,
        unit: material.unit,
        price: 1,
        locationId,
        expiryDate: '2028-12-31',
        operator: 'critical-e2e',
      },
    })
    await expectCreatedId(inboundResponse, `create inbound ${index + 1}`)
  }

  const inventoryResponse = await request.get(
    `${apiBaseUrl()}/inventory?keyword=${encodeURIComponent(material.code)}&page=1&pageSize=20`,
    { headers: authorization(token) },
  )
  const inventoryBody = await inventoryResponse.json() as {
    data?: { list?: Array<{
      materialId?: string
      stock?: number
      positions?: Array<{ locationId?: string, quantity?: number }>
    }> }
  }
  expect(inventoryResponse.status(), JSON.stringify(inventoryBody)).toBe(200)
  const inventoryItem = inventoryBody.data?.list?.find((item) => item.materialId === material.id)
  expect(inventoryItem).toBeTruthy()
  expect(Math.round(Number(inventoryItem?.stock) * 10000)).toBe(6000)
  expect(inventoryItem?.positions).toHaveLength(3)
  expect(inventoryItem?.positions?.reduce(
    (sum, position) => sum + Math.round(Number(position.quantity) * 10000),
    0,
  )).toBe(6000)
  expect(new Set(inventoryItem?.positions?.map((position) => position.locationId)))
    .toEqual(new Set(positions.map((position) => position.locationId)))

  await loginThroughUi(page, 'admin')
  const uiInventoryResponse = page.waitForResponse((response) => {
    if (response.request().method() !== 'GET') return false
    const url = new URL(response.url())
    return url.pathname.endsWith('/api/v1/inventory') && url.searchParams.get('keyword') === material.code
  })
  await page.goto(`/inventory?keyword=${encodeURIComponent(material.code)}`)
  expect((await uiInventoryResponse).status()).toBe(200)
  await expect(page.getByRole('heading', { name: '库存列表', exact: true })).toBeVisible()

  const materialRow = page.locator('tbody tr').filter({ hasText: material.name }).first()
  await expect(materialRow).toBeVisible()
  await materialRow.getByRole('button', { name: '详情', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '库存详情' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(`3 个位置，共 0.6 ${material.unit}`, { exact: true })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)

  const table = dialog.getByRole('table', { name: '库存位置明细' })
  await expect(table.getByRole('row')).toHaveCount(4)
  for (const position of positions) {
    const row = table.getByRole('row').filter({ hasText: position.locationName })
    await expect(row).toBeVisible()
    await expect(row.getByText(String(position.quantity), { exact: true })).toBeVisible()
  }
})
