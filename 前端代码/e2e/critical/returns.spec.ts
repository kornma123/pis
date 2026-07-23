import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { apiLogin, loginThroughUi } from './fixtures'

type ReturnSource = {
  allocationId: string
  outboundId: string
  outboundNo: string
  batchId: string
  batchNo: string
  availableQuantity: number
}

type SeededMaterial = {
  id: string
  name: string
}

const apiBaseUrl = () => {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

async function apiJson(
  request: APIRequestContext,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  data?: unknown,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const response = method === 'GET'
    ? await request.get(`${apiBaseUrl()}${path}`, { headers })
    : await request.post(`${apiBaseUrl()}${path}`, { headers, data })
  const body = await response.json()
  return { response, body }
}

async function expectCreated(result: Awaited<ReturnType<typeof apiJson>>, label: string) {
  expect(result.response.status(), `${label}: ${JSON.stringify(result.body)}`).toBe(201)
  expect(result.body?.data?.id, `${label} returned no id`).toEqual(expect.any(String))
  return result.body.data.id as string
}

async function createMaterial(
  request: APIRequestContext,
  token: string,
  categoryId: string,
  locationId: string,
  suffix: string,
): Promise<SeededMaterial> {
  const name = `退库关键链路-${suffix}`
  const result = await apiJson(request, token, 'POST', '/materials', {
    code: `E2E-RT-${suffix}`,
    name,
    unit: '盒',
    categoryId,
    locationId,
    price: 10,
  })
  return { id: await expectCreated(result, `create material ${suffix}`), name }
}

async function createOutboundSource(
  request: APIRequestContext,
  token: string,
  material: SeededMaterial,
  locationId: string,
  suffix: string,
  quantity: number,
): Promise<ReturnSource> {
  const inbound = await apiJson(request, token, 'POST', '/inbound', {
    type: 'purchase',
    materialId: material.id,
    batchNo: `LOT-${suffix}`,
    quantity: 10,
    unit: '盒',
    price: 10,
    locationId,
    expiryDate: '2028-12-31',
    operator: 'critical-e2e',
  }, `e2e-inbound-${suffix}`)
  await expectCreated(inbound, `create inbound ${suffix}`)

  const outbound = await apiJson(request, token, 'POST', '/outbound', {
    type: 'direct',
    items: [{ materialId: material.id, quantity }],
    operator: 'critical-e2e',
  }, `e2e-outbound-${suffix}`)
  const outboundId = await expectCreated(outbound, `create outbound ${suffix}`)

  const sources = await listSources(request, token, material.id)
  const source = sources.find((row) => row.outboundId === outboundId)
  expect(source, `outbound ${outboundId} returned no source allocation`).toBeTruthy()
  return source!
}

async function createAdditionalOutboundSource(
  request: APIRequestContext,
  token: string,
  material: SeededMaterial,
  suffix: string,
  quantity: number,
): Promise<ReturnSource> {
  const outbound = await apiJson(request, token, 'POST', '/outbound', {
    type: 'direct',
    items: [{ materialId: material.id, quantity }],
    operator: 'critical-e2e',
  }, `e2e-outbound-${suffix}`)
  const outboundId = await expectCreated(outbound, `create outbound ${suffix}`)
  const sources = await listSources(request, token, material.id)
  const source = sources.find((row) => row.outboundId === outboundId)
  expect(source, `outbound ${outboundId} returned no source allocation`).toBeTruthy()
  return source!
}

async function listSources(request: APIRequestContext, token: string, materialId: string): Promise<ReturnSource[]> {
  const result = await apiJson(request, token, 'GET', `/returns?sourceMaterialId=${encodeURIComponent(materialId)}`)
  expect(result.response.status()).toBe(200)
  return result.body.data as ReturnSource[]
}

async function returnCount(request: APIRequestContext, token: string, materialId: string): Promise<number> {
  const result = await apiJson(request, token, 'GET', `/returns?materialId=${encodeURIComponent(materialId)}&page=1&pageSize=1`)
  expect(result.response.status()).toBe(200)
  return Number(result.body.data?.pagination?.total ?? result.body.data?.total ?? 0)
}

async function materialStock(request: APIRequestContext, token: string, materialId: string): Promise<number> {
  const result = await apiJson(request, token, 'GET', `/materials/${encodeURIComponent(materialId)}`)
  expect(result.response.status()).toBe(200)
  return Number(result.body.data.stock)
}

async function openReturnModal(page: Page, materialId: string) {
  await loginThroughUi(page, 'admin')
  await page.goto('/returns')
  await expect(page.getByRole('heading', { name: '退库管理', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '退库登记', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '退库登记' })
  await expect(dialog).toBeVisible()
  const sourceResponse = page.waitForResponse((response) =>
    response.request().method() === 'GET'
      && response.url().includes('/api/v1/returns')
      && response.url().includes('sourceMaterialId='),
  )
  await dialog.locator('select').nth(0).selectOption(materialId)
  expect((await sourceResponse).status()).toBe(200)
  return dialog
}

test.describe.serial('critical return source-allocation contract', () => {
  let token: string
  let locationId: string
  let successMaterial: SeededMaterial
  let successSource: ReturnSource
  let missingMaterial: SeededMaterial
  let crossMaterial: SeededMaterial
  let crossSource: ReturnSource
  let otherMaterial: SeededMaterial
  let otherSource: ReturnSource
  let exhaustedMaterial: SeededMaterial
  let exhaustedSource: ReturnSource
  let availableSource: ReturnSource

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request, 'admin')
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

    const category = await apiJson(request, token, 'POST', '/categories', {
      code: `E2ERT${suffix.replace(/\D/g, '').slice(-8)}`,
      name: `退库关键链路分类-${suffix}`,
      level: 1,
    })
    const categoryId = await expectCreated(category, 'create category')

    const location = await apiJson(request, token, 'POST', '/locations', {
      name: `退库关键链路库位-${suffix}`,
      zone: `RT-${suffix}`,
      type: 'shelf',
    })
    locationId = await expectCreated(location, 'create location')

    successMaterial = await createMaterial(request, token, categoryId, locationId, `${suffix}-success`)
    successSource = await createOutboundSource(request, token, successMaterial, locationId, `${suffix}-success`, 4)

    missingMaterial = await createMaterial(request, token, categoryId, locationId, `${suffix}-missing`)

    crossMaterial = await createMaterial(request, token, categoryId, locationId, `${suffix}-cross-a`)
    crossSource = await createOutboundSource(request, token, crossMaterial, locationId, `${suffix}-cross-a`, 3)
    otherMaterial = await createMaterial(request, token, categoryId, locationId, `${suffix}-cross-b`)
    otherSource = await createOutboundSource(request, token, otherMaterial, locationId, `${suffix}-cross-b`, 3)

    exhaustedMaterial = await createMaterial(request, token, categoryId, locationId, `${suffix}-exhausted`)
    exhaustedSource = await createOutboundSource(request, token, exhaustedMaterial, locationId, `${suffix}-exhausted-1`, 1)
    availableSource = await createAdditionalOutboundSource(request, token, exhaustedMaterial, `${suffix}-exhausted-2`, 2)
    const exhaust = await apiJson(request, token, 'POST', '/returns', {
      materialId: exhaustedMaterial.id,
      sourceAllocationId: exhaustedSource.allocationId,
      quantity: 1,
      reason: 'excess',
      operator: 'critical-e2e',
    }, `e2e-return-exhaust-${suffix}`)
    await expectCreated(exhaust, 'exhaust source allocation')
  })

  test('候选来源可见，选择原 outbound allocation 后由 UI 提交成功', async ({ page, request }) => {
    const before = await returnCount(request, token, successMaterial.id)
    const dialog = await openReturnModal(page, successMaterial.id)
    const sourceSelect = dialog.locator('select').nth(1)
    await expect(sourceSelect.locator(`option[value="${successSource.allocationId}"]`))
      .toHaveText(new RegExp(`${successSource.outboundNo}.*批次 ${successSource.batchNo}.*可退 ${successSource.availableQuantity}`))
    await sourceSelect.selectOption(successSource.allocationId)
    await dialog.locator('input[type="number"]').fill('2')
    await dialog.locator('select').nth(2).selectOption('excess')

    const submitted = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/v1/returns'),
    )
    await dialog.getByRole('button', { name: '确认退库', exact: true }).click()
    expect((await submitted).status()).toBe(201)
    await expect(page.getByText('退库登记成功', { exact: true })).toBeVisible()
    await expect(dialog).toHaveCount(0)
    expect(await returnCount(request, token, successMaterial.id)).toBe(before + 1)
  })

  test('缺来源不能提交，UI 不发 POST 且后端零写', async ({ page, request }) => {
    const before = await returnCount(request, token, missingMaterial.id)
    let postCount = 0
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/v1/returns')) postCount += 1
    })
    const dialog = await openReturnModal(page, missingMaterial.id)
    await expect(dialog.locator('select').nth(1).locator('option').first()).toHaveText('没有可退的原出库来源')
    await dialog.locator('select').nth(2).selectOption('excess')
    await dialog.getByRole('button', { name: '确认退库', exact: true }).click()
    await expect(page.getByText('请选择原出库批次来源', { exact: true })).toBeVisible()
    expect(postCount).toBe(0)
    expect(await returnCount(request, token, missingMaterial.id)).toBe(before)
  })

  test('UI 提交被篡改为跨 material source 时后端 422 且零 partial', async ({ page, request }) => {
    const beforeCount = await returnCount(request, token, crossMaterial.id)
    const beforeStock = await materialStock(request, token, crossMaterial.id)
    const dialog = await openReturnModal(page, crossMaterial.id)
    await dialog.locator('select').nth(1).selectOption(crossSource.allocationId)
    await dialog.locator('input[type="number"]').fill('1')
    await dialog.locator('select').nth(2).selectOption('wrong_item')

    await page.route('**/api/v1/returns', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const body = route.request().postDataJSON()
      await route.continue({ postData: JSON.stringify({ ...body, sourceAllocationId: otherSource.allocationId }) })
    })
    const submitted = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/v1/returns'),
    )
    await dialog.getByRole('button', { name: '确认退库', exact: true }).click()
    const response = await submitted
    expect(response.status()).toBe(422)
    expect((await response.json()).error.code).toBe('RETURN_SOURCE_INVALID')
    await page.unroute('**/api/v1/returns')
    await expect(dialog).toBeVisible()
    expect(await returnCount(request, token, crossMaterial.id)).toBe(beforeCount)
    expect(await materialStock(request, token, crossMaterial.id)).toBe(beforeStock)
  })

  test('已耗尽 source 不再候选，stale UI 提交仍 422 且零 partial', async ({ page, request }) => {
    const beforeCount = await returnCount(request, token, exhaustedMaterial.id)
    const beforeStock = await materialStock(request, token, exhaustedMaterial.id)
    const dialog = await openReturnModal(page, exhaustedMaterial.id)
    const sourceSelect = dialog.locator('select').nth(1)
    await expect(sourceSelect.locator(`option[value="${exhaustedSource.allocationId}"]`)).toHaveCount(0)
    await expect(sourceSelect.locator(`option[value="${availableSource.allocationId}"]`)).toHaveCount(1)
    await sourceSelect.selectOption(availableSource.allocationId)
    await dialog.locator('input[type="number"]').fill('1')
    await dialog.locator('select').nth(2).selectOption('near_expiry')

    await page.route('**/api/v1/returns', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const body = route.request().postDataJSON()
      await route.continue({ postData: JSON.stringify({ ...body, sourceAllocationId: exhaustedSource.allocationId }) })
    })
    const submitted = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/v1/returns'),
    )
    await dialog.getByRole('button', { name: '确认退库', exact: true }).click()
    const response = await submitted
    expect(response.status()).toBe(422)
    expect((await response.json()).error.code).toBe('RETURN_SOURCE_EXHAUSTED')
    await page.unroute('**/api/v1/returns')
    await expect(dialog).toBeVisible()
    expect(await returnCount(request, token, exhaustedMaterial.id)).toBe(beforeCount)
    expect(await materialStock(request, token, exhaustedMaterial.id)).toBe(beforeStock)
  })
})
