import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiLogin, loginThroughUi } from './fixtures'

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
  expect(body.data?.id).toEqual(expect.any(String))
  return body.data!.id as string
}

async function createPosition(request: APIRequestContext, token: string, label: string) {
  const suffix = randomUUID().replaceAll('-', '')
  const categoryId = await expectCreatedId(await request.post(`${apiBaseUrl()}/categories`, {
    headers: authorization(token),
    data: { code: `ST${suffix.slice(0, 12)}`, name: `盘点验收分类-${suffix}`, level: 1 },
  }), 'create category')
  const locationName = `盘点验收库位-${label}-${suffix.slice(0, 6)}`
  const locationId = await expectCreatedId(await request.post(`${apiBaseUrl()}/locations`, {
    headers: authorization(token),
    data: { name: locationName, zone: '盘点验收区', capacity: 100 },
  }), 'create location')
  const materialName = `盘点验收物料-${label}-${suffix.slice(0, 6)}`
  const materialCode = `E2E-ST-${suffix}`
  const materialId = await expectCreatedId(await request.post(`${apiBaseUrl()}/materials`, {
    headers: authorization(token),
    data: {
      code: materialCode,
      name: materialName,
      unit: '盒',
      categoryId,
      batchManaged: true,
      price: 1,
      unitsPerPackage: 1,
      slotsPerPackage: 1,
    },
  }), 'create material')
  const batchNo = `E2E-ST-BATCH-${suffix}`
  await expectCreatedId(await request.post(`${apiBaseUrl()}/inbound`, {
    headers: { ...authorization(token), 'Idempotency-Key': `stocktaking-seed-${suffix}` },
    data: {
      type: 'direct', materialId, batchNo, quantity: 10, unit: '盒', price: 1,
      locationId, expiryDate: '2028-12-31', operator: 'critical-e2e',
    },
  }), 'create inbound')

  const inventoryResponse = await request.get(
    `${apiBaseUrl()}/inventory?keyword=${encodeURIComponent(materialCode)}&page=1&pageSize=20`,
    { headers: authorization(token) },
  )
  const inventoryBody = await inventoryResponse.json() as {
    data?: { list?: Array<{ materialId?: string, positions?: Array<{ id?: string, batchId?: string | null }> }> }
  }
  expect(inventoryResponse.status(), JSON.stringify(inventoryBody)).toBe(200)
  const savedPosition = inventoryBody.data?.list
    ?.find(item => item.materialId === materialId)?.positions?.[0]
  expect(savedPosition?.id).toEqual(expect.any(String))
  expect(savedPosition?.batchId).toEqual(expect.any(String))
  return {
    suffix, materialId, materialName, materialCode, locationId, locationName, batchNo,
    positionId: savedPosition!.id as string,
    batchId: savedPosition!.batchId as string,
  }
}

async function inventoryStock(request: APIRequestContext, token: string, materialCode: string) {
  const response = await request.get(
    `${apiBaseUrl()}/inventory?keyword=${encodeURIComponent(materialCode)}&page=1&pageSize=20`,
    { headers: authorization(token) },
  )
  expect(response.status()).toBe(200)
  const body = await response.json() as { data?: { list?: Array<{ stock?: number }> } }
  return Number(body.data?.list?.[0]?.stock)
}

test('records, adjusts, explains, reverses, and restores one exact inventory position', async ({ page, request }) => {
  const token = await apiLogin(request, 'admin')
  const position = await createPosition(request, token, 'lifecycle')
  await loginThroughUi(page, 'admin')
  await page.goto('/stocktaking')

  await page.getByRole('button', { name: '新建盘点', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '新建盘点' })
  await createDialog.getByRole('radio', { name: new RegExp(position.materialName) }).click()
  await createDialog.getByRole('button', { name: '下一步' }).click()
  await createDialog.getByLabel('实盘数量 *', { exact: true }).fill('12')
  await createDialog.getByRole('button', { name: '下一步' }).click()
  await expect(createDialog.getByText('10 → 12 盒', { exact: true })).toBeVisible()
  await expect(createDialog.getByText('+2 盒', { exact: true })).toBeVisible()

  const createResponse = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/stocktaking'),
  )
  await createDialog.getByRole('button', { name: '保存盘点结果' }).click()
  expect((await createResponse).status()).toBe(200)
  const detail = page.getByRole('dialog', { name: /盘点详情/ })
  await expect(detail.getByText('这条记录还没有修改库存。')).toBeVisible()
  expect(await inventoryStock(request, token, position.materialCode)).toBe(10)

  await detail.getByRole('button', { name: '按盘点结果调整库存' }).click()
  const adjustDialog = page.getByRole('dialog', { name: '确认库存调整' })
  await expect(adjustDialog.getByText(/10 盒调整为 12 盒/)).toBeVisible()
  const adjustResponse = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().includes('/stocktaking/') && response.url().endsWith('/adjust'),
  )
  await adjustDialog.getByRole('button', { name: '确认调整' }).click()
  expect((await adjustResponse).status()).toBe(200)
  await expect(detail.getByText('10 → 12 盒；原因：待核实', { exact: true })).toBeVisible()
  expect(await inventoryStock(request, token, position.materialCode)).toBe(12)

  await detail.getByLabel('补充说明').fill('后续确认：此前漏记一笔入库')
  await detail.getByRole('button', { name: '追加说明' }).click()
  await expect(detail.getByText('后续确认：此前漏记一笔入库')).toBeVisible()

  await detail.getByRole('button', { name: '撤销本次调整' }).click()
  const reverseDialog = page.getByRole('dialog', { name: '撤销库存调整' })
  await reverseDialog.getByLabel('撤销原因 *', { exact: true }).fill('选错批次，先撤销后重盘')
  await reverseDialog.getByRole('button', { name: '确认撤销' }).click()
  await expect(detail.getByText('12 → 10 盒；原因：选错批次，先撤销后重盘', { exact: true })).toBeVisible()
  expect(await inventoryStock(request, token, position.materialCode)).toBe(10)

  await detail.getByRole('button', { name: '恢复原调整' }).click()
  const restoreDialog = page.getByRole('dialog', { name: '恢复原库存调整' })
  await restoreDialog.getByLabel('恢复原因 *', { exact: true }).fill('复核后确认原盘点结果正确')
  await restoreDialog.getByRole('button', { name: '确认恢复' }).click()
  await expect(detail.getByText('恢复原调整', { exact: true })).toBeVisible()
  await expect(detail.getByText('10 → 12 盒；原因：复核后确认原盘点结果正确', { exact: true })).toBeVisible()
  expect(await inventoryStock(request, token, position.materialCode)).toBe(12)
})

test('refuses a stale adjustment and sends the operator back to recount', async ({ page, request }) => {
  const token = await apiLogin(request, 'admin')
  const position = await createPosition(request, token, 'conflict')
  const createResponse = await request.post(`${apiBaseUrl()}/stocktaking`, {
    headers: authorization(token),
    data: {
      materialId: position.materialId,
      positionId: position.positionId,
      batchId: position.batchId,
      locationId: position.locationId,
      actualStock: 12,
      remark: '并发冲突验收',
    },
  })
  expect(createResponse.status()).toBe(200)

  await loginThroughUi(page, 'admin')
  await page.goto(`/stocktaking?keyword=${encodeURIComponent(position.materialCode)}`)
  const row = page.locator('tbody tr').filter({ hasText: position.materialName })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '调整库存' }).click()
  const adjustDialog = page.getByRole('dialog', { name: '确认库存调整' })
  await expect(adjustDialog.getByText(/10 盒调整为 12 盒/)).toBeVisible()

  await expectCreatedId(await request.post(`${apiBaseUrl()}/inbound`, {
    headers: { ...authorization(token), 'Idempotency-Key': `stocktaking-conflict-${position.suffix}` },
    data: {
      type: 'direct', materialId: position.materialId, batchNo: position.batchNo,
      quantity: 1, unit: '盒', price: 1, locationId: position.locationId,
      expiryDate: '2028-12-31', operator: 'critical-e2e-conflict',
    },
  }), 'create concurrent inbound')

  const staleResponse = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().endsWith('/adjust'),
  )
  await adjustDialog.getByRole('button', { name: '确认调整' }).click()
  expect((await staleResponse).status()).toBe(409)
  const conflict = page.getByRole('alert').filter({ hasText: '盘点之后' })
  await expect(conflict).toContainText('系统已拒绝直接覆盖')
  await conflict.getByRole('button', { name: '刷新当前库存' }).click()
  await expect(conflict).toContainText('当前库存：11')
  await conflict.getByRole('button', { name: '重新盘点' }).click()
  await expect(page.getByRole('dialog', { name: '新建盘点' })).toBeVisible()
})
