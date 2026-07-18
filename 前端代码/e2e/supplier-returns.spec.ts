import { randomUUID } from 'node:crypto'
import { expect, Page, Response, test } from '@playwright/test'

const FE_BASE = `http://127.0.0.1:${process.env.E2E_FRONTEND_PORT || '8080'}`
const API_BASE = `http://127.0.0.1:${process.env.E2E_BACKEND_PORT || '3001'}/api/v1`
const INITIAL_STOCK = 10_000
const UNIT_PRICE = 25
const UI_RETURN_QUANTITY = 2

const ROLES = {
  admin: { username: 'admin', password: 'admin123' },
  warehouse_manager: { username: 'cangguan', password: 'CoreOne2026!' },
  technician: { username: 'jishuyuan1', password: 'CoreOne2026!' },
  pathologist: { username: 'yishi1', password: 'CoreOne2026!' },
  procurement: { username: 'caigou', password: 'CoreOne2026!' },
  finance: { username: 'caiwu', password: 'CoreOne2026!' },
} as const

type RoleKey = keyof typeof ROLES
type ReturnStatus = 'pending' | 'shipped' | 'received' | 'refunded' | 'cancelled'
type ApiResult = { status: number; data: any }
type MaterialSnapshot = { stock: number; stockLogs: any[] }

type SupplierReturnRecord = {
  id: string
  returnNo: string
  materialId: string
  quantity: number
  supplierId: string | null
  reason: string
  refundAmount: number
  trackingNo: string | null
  status: ReturnStatus
  remark: string | null
}

type TestFixture = {
  categoryId: string
  supplierId: string
  supplierName: string
  locationId: string
  materialId: string
  materialName: string
  inboundId: string
}

const READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'procurement', 'finance']
const NO_ACCESS_ROLES: RoleKey[] = ['technician', 'pathologist']
const STATUS_LABELS: Record<ReturnStatus, string> = {
  pending: '待发货',
  shipped: '已发货',
  received: '已收货',
  refunded: '已退款',
  cancelled: '已取消',
}

let fixture: TestFixture

function apiPath(path: string): string {
  return `${API_BASE}${path}`
}

function isApiResponse(response: Response, method: string, path: string): boolean {
  const url = new URL(response.url())
  return response.request().method() === method && url.pathname === `/api/v1${path}`
}

async function apiFetch(token: string, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
  const options: RequestInit = { method, headers }
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    options.body = JSON.stringify(body)
  }

  const response = await fetch(apiPath(path), options)
  const rawBody = await response.text()
  let data: any = null
  try {
    data = rawBody.length > 0 ? JSON.parse(rawBody) : null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${method} ${path} returned invalid JSON: ${message}`)
  }
  return { status: response.status, data }
}

function expectData(result: ApiResult, expectedStatus: number, label: string): any {
  expect(result.status, `${label}: HTTP status`).toBe(expectedStatus)
  expect(result.data?.success, `${label}: success envelope`).toBe(true)
  expect(result.data, `${label}: response envelope`).toHaveProperty('data')
  return result.data.data
}

function expectId(data: any, label: string): string {
  expect(data?.id, `${label}: id`).toEqual(expect.any(String))
  expect(data.id.length, `${label}: non-empty id`).toBeGreaterThan(0)
  return data.id as string
}

async function apiLogin(role: RoleKey): Promise<string> {
  const result = await fetch(apiPath('/auth/login'), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(ROLES[role]),
  })
  const rawBody = await result.text()
  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`login for ${role} returned invalid JSON: ${message}`)
  }
  expect(result.status, `login for ${role}: HTTP status`).toBe(200)
  const token = payload?.data?.token ?? payload?.token
  expect(token, `login for ${role}: token`).toEqual(expect.any(String))
  expect(token.length, `login for ${role}: non-empty token`).toBeGreaterThan(0)
  return token as string
}

async function loginAs(page: Page, role: RoleKey): Promise<void> {
  await page.goto(`${FE_BASE}/login`)
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload()
  await page.locator('input[type="text"]').fill(ROLES[role].username)
  await page.locator('input[type="password"]').fill(ROLES[role].password)

  const loginResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'POST', '/auth/login'))
  await page.locator('button[type="submit"]').click()
  const loginResponse = await loginResponsePromise
  expect(loginResponse.status(), `UI login for ${role}`).toBe(200)
  await page.waitForURL(`${FE_BASE}/`)
  await expect(page).toHaveURL(`${FE_BASE}/`)

  const supplierReturnsMenu = page.getByRole('link', { name: '退货给供应商', exact: true })
  if (READ_ROLES.includes(role)) {
    await expect(supplierReturnsMenu, `${role} supplier-returns menu`).toBeVisible()
  } else {
    await expect(supplierReturnsMenu, `${role} must not see supplier-returns menu`).toHaveCount(0)
  }
}

async function expectSupplierReturnsPage(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/supplier-returns(?:\?|$)/)
  await expect(page.getByRole('heading', { name: '退货给供应商', exact: true })).toBeVisible()
  await expect(page.getByText('加载中...', { exact: true })).toHaveCount(0)
  await expect(page.locator('table')).toBeVisible()
}

async function openSupplierReturnsFromMenu(page: Page): Promise<void> {
  const listResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'GET', '/supplier-returns'))
  await page.getByRole('link', { name: '退货给供应商', exact: true }).click()
  const listResponse = await listResponsePromise
  expect(listResponse.status(), 'supplier-returns list from menu').toBe(200)
  await expectSupplierReturnsPage(page)
}

async function gotoSupplierReturns(page: Page, query = ''): Promise<Response> {
  const listResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'GET', '/supplier-returns'))
  await page.goto(`${FE_BASE}/supplier-returns${query}`)
  const listResponse = await listResponsePromise
  expect(listResponse.status(), `supplier-returns list ${query}`).toBe(200)
  await expectSupplierReturnsPage(page)
  return listResponse
}

async function reloadSupplierReturns(page: Page): Promise<void> {
  const listResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'GET', '/supplier-returns'))
  await page.reload()
  const listResponse = await listResponsePromise
  expect(listResponse.status(), 'supplier-returns reload').toBe(200)
  await expectSupplierReturnsPage(page)
}

async function createFixture(): Promise<TestFixture> {
  const token = await apiLogin('admin')
  const runId = randomUUID().slice(0, 8)

  const category = expectData(
    await apiFetch(token, 'POST', '/categories', { name: `E2E退货分类-${runId}`, level: 1 }),
    201,
    'create E2E category',
  )
  const categoryId = expectId(category, 'create E2E category')

  const supplierName = `E2E退货供应商-${runId}`
  const supplier = expectData(
    await apiFetch(token, 'POST', '/suppliers', { name: supplierName }),
    201,
    'create E2E supplier',
  )
  const supplierId = expectId(supplier, 'create E2E supplier')

  const location = expectData(
    await apiFetch(token, 'POST', '/locations', { name: `E2E退货库位-${runId}`, zone: 'E2E' }),
    201,
    'create E2E location',
  )
  const locationId = expectId(location, 'create E2E location')

  const materialName = `E2E退货物料-${runId}`
  const material = expectData(
    await apiFetch(token, 'POST', '/materials', {
      name: materialName,
      unit: '盒',
      categoryId,
      supplierId,
      locationId,
      price: UNIT_PRICE,
      remark: 'supplier-returns E2E isolated fixture',
    }),
    201,
    'create E2E material',
  )
  const materialId = expectId(material, 'create E2E material')

  const inbound = expectData(
    await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase',
      materialId,
      batchNo: `E2E-${runId}`,
      quantity: INITIAL_STOCK,
      price: UNIT_PRICE,
      supplierId,
      locationId,
      remark: 'supplier-returns E2E isolated fixture',
    }),
    201,
    'inbound E2E stock',
  )
  const inboundId = expectId(inbound, 'inbound E2E stock')

  const snapshot = await getMaterialSnapshot(token, materialId)
  expect(snapshot.stock, 'fixture stock after inbound').toBe(INITIAL_STOCK)
  expect(
    snapshot.stockLogs.some((log) => log.type === 'inbound' && log.relatedId === inboundId && log.quantity === INITIAL_STOCK),
    'fixture inbound stock log',
  ).toBe(true)

  return { categoryId, supplierId, supplierName, locationId, materialId, materialName, inboundId }
}

async function getMaterialSnapshot(token: string, materialId = fixture.materialId): Promise<MaterialSnapshot> {
  const data = expectData(await apiFetch(token, 'GET', `/materials/${materialId}`), 200, 'read material snapshot')
  expect(data.stock, 'material stock').toEqual(expect.any(Number))
  expect(Number.isFinite(data.stock), 'material stock must be finite').toBe(true)
  expect(Array.isArray(data.stockLogs), 'material stock logs').toBe(true)
  return { stock: data.stock as number, stockLogs: data.stockLogs as any[] }
}

function fixtureMaterialId(): string {
  expect(fixture?.materialId, 'fixture material id').toEqual(expect.any(String))
  return fixture.materialId
}

async function requireFixtureStock(token: string, minimum: number): Promise<number> {
  const snapshot = await getMaterialSnapshot(token)
  expect(snapshot.stock, `fixture stock must be at least ${minimum}`).toBeGreaterThanOrEqual(minimum)
  return snapshot.stock
}

async function getReturnDetail(token: string, id: string): Promise<SupplierReturnRecord> {
  const data = expectData(await apiFetch(token, 'GET', `/supplier-returns/${id}`), 200, `read supplier return ${id}`)
  expect(data.id, 'supplier return detail id').toBe(id)
  return data as SupplierReturnRecord
}

async function createReturn(
  token: string,
  options: Partial<{
    quantity: number
    reason: string
    refundAmount: number
    trackingNo: string
    remark: string
  }> = {},
): Promise<SupplierReturnRecord> {
  const quantity = options.quantity ?? 1
  const reason = options.reason ?? 'quality_issue'
  await requireFixtureStock(token, quantity)
  const body = {
    materialId: fixtureMaterialId(),
    quantity,
    supplierId: fixture.supplierId,
    reason,
    refundAmount: options.refundAmount ?? 0,
    trackingNo: options.trackingNo,
    remark: options.remark ?? 'supplier-returns E2E',
  }
  const created = expectData(await apiFetch(token, 'POST', '/supplier-returns', body), 200, 'create supplier return')
  const id = expectId(created, 'create supplier return')
  expect(created.returnNo, 'created return number').toMatch(/^SR-\d{8}-\d{6}-\d{3}$/)

  const detail = await getReturnDetail(token, id)
  expect(detail.returnNo, 'persisted return number').toBe(created.returnNo)
  expect(detail.materialId, 'persisted material').toBe(fixture.materialId)
  expect(detail.quantity, 'persisted return quantity').toBe(quantity)
  expect(detail.supplierId, 'persisted supplier').toBe(fixture.supplierId)
  expect(detail.reason, 'persisted reason').toBe(reason)
  expect(detail.refundAmount, 'persisted refund amount').toBe(options.refundAmount ?? 0)
  expect(detail.trackingNo, 'persisted tracking number').toBe(options.trackingNo ?? null)
  expect(detail.status, 'new return status').toBe('pending')
  return detail
}

async function transitionReturn(token: string, id: string, status: ReturnStatus): Promise<SupplierReturnRecord> {
  const data = expectData(
    await apiFetch(token, 'PUT', `/supplier-returns/${id}/status`, { status }),
    200,
    `transition ${id} to ${status}`,
  )
  expect(data.id, 'transition response id').toBe(id)
  expect(data.status, 'transition response status').toBe(status)
  const detail = await getReturnDetail(token, id)
  expect(detail.status, 'persisted transition status').toBe(status)
  return detail
}

async function createReturnAtStatus(token: string, status: ReturnStatus): Promise<SupplierReturnRecord> {
  const created = await createReturn(token, { remark: `E2E status filter ${status}` })
  let current = created
  if (status === 'shipped' || status === 'received' || status === 'refunded') {
    current = await transitionReturn(token, created.id, 'shipped')
  }
  if (status === 'received' || status === 'refunded') {
    current = await transitionReturn(token, created.id, 'received')
  }
  if (status === 'refunded') {
    current = await transitionReturn(token, created.id, 'refunded')
  }
  if (status === 'cancelled') {
    current = await transitionReturn(token, created.id, 'cancelled')
  }
  expect(current.status, `fixture return at ${status}`).toBe(status)
  return current
}

async function deleteReturn(token: string, id: string): Promise<void> {
  expectData(await apiFetch(token, 'DELETE', `/supplier-returns/${id}`), 200, `delete supplier return ${id}`)
  const missing = await apiFetch(token, 'GET', `/supplier-returns/${id}`)
  expect(missing.status, 'deleted return must be absent').toBe(404)
}

async function ensureReturnCount(token: string, target: number): Promise<void> {
  const list = expectData(
    await apiFetch(token, 'GET', '/supplier-returns?page=1&pageSize=1'),
    200,
    'count supplier returns',
  )
  expect(list.total, 'supplier return total').toEqual(expect.any(Number))
  const missing = Math.max(0, target - list.total)
  for (let index = 0; index < missing; index += 1) {
    await createReturn(token, { remark: `E2E pagination fixture ${index + 1}` })
  }
  const verified = expectData(
    await apiFetch(token, 'GET', '/supplier-returns?page=1&pageSize=1'),
    200,
    'verify supplier return count',
  )
  expect(verified.total, 'verified supplier return total').toBeGreaterThanOrEqual(target)
}

async function createZeroStockMaterial(token: string): Promise<string> {
  const runId = randomUUID().slice(0, 8)
  const material = expectData(
    await apiFetch(token, 'POST', '/materials', {
      name: `E2E零库存物料-${runId}`,
      unit: '盒',
      categoryId: fixture.categoryId,
      supplierId: fixture.supplierId,
      locationId: fixture.locationId,
      price: UNIT_PRICE,
    }),
    201,
    'create zero-stock material',
  )
  const materialId = expectId(material, 'create zero-stock material')
  const snapshot = await getMaterialSnapshot(token, materialId)
  expect(snapshot.stock, 'zero-stock material starts empty').toBe(0)
  return materialId
}

async function openReturnDetail(page: Page, returnNo: string): Promise<ReturnType<Page['locator']>> {
  const row = page.getByRole('row').filter({ hasText: returnNo })
  await expect(row, `row for ${returnNo}`).toHaveCount(1)
  await row.getByRole('button', { name: '详情', exact: true }).click()
  const modal = page.getByRole('heading', { name: '退货详情', exact: true }).locator('xpath=ancestor::div[contains(@class,"max-w-lg")]')
  await expect(modal).toBeVisible()
  await expect(modal.getByText(returnNo, { exact: true })).toBeVisible()
  return modal
}

async function transitionReturnViaUi(
  page: Page,
  modal: ReturnType<Page['locator']>,
  id: string,
  buttonName: string,
  status: ReturnStatus,
): Promise<void> {
  const responsePromise = page.waitForResponse((response) => isApiResponse(response, 'PUT', `/supplier-returns/${id}/status`))
  await modal.getByRole('button', { name: buttonName, exact: true }).click()
  const response = await responsePromise
  expect(response.status(), `UI transition ${id} to ${status}`).toBe(200)
  const payload = await response.json()
  expect(payload?.data?.status, `UI transition response ${status}`).toBe(status)
  await expect(modal.getByText(STATUS_LABELS[status], { exact: true })).toBeVisible()
}

test.beforeAll(async () => {
  fixture = await createFixture()
})

test.describe('退货给供应商 -> 查看列表', () => {
  for (const role of READ_ROLES) {
    test(`SR-LIST-01-${role}. 正常用例：${role}可查看退货列表`, async ({ page }) => {
      await loginAs(page, role)
      await openSupplierReturnsFromMenu(page)
      await expect(page.getByText(/^共 \d+ 条记录$/)).toBeVisible()
    })
  }

  test('SR-LIST-02. 空数据边界：无退货记录显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    const keyword = `NO-SUPPLIER-RETURN-${randomUUID()}`
    await gotoSupplierReturns(page, `?keyword=${encodeURIComponent(keyword)}`)
    await expect(page.getByText('暂无退货记录', { exact: true })).toBeVisible()
    await expect(page.locator('table tbody tr')).toHaveCount(1)
  })

  for (const role of NO_ACCESS_ROLES) {
    test(`SR-LIST-03-${role}. 权限：${role}访问返回403`, async () => {
      const token = await apiLogin(role)
      const result = await apiFetch(token, 'GET', '/supplier-returns')
      expect(result.status).toBe(403)
      expect(result.data?.success).toBe(false)
    })
  }

  test('SR-LIST-04. UI差异：admin显示新建退货按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await openSupplierReturnsFromMenu(page)
    await expect(page.getByRole('button', { name: '新建退货', exact: true })).toBeVisible()
  })

  test('SR-LIST-05. 并发：快速刷新页面多次列表正常', async ({ page }) => {
    await loginAs(page, 'admin')
    await openSupplierReturnsFromMenu(page)
    await reloadSupplierReturns(page)
    await reloadSupplierReturns(page)
    await expect(page.getByRole('columnheader', { name: '退货单号', exact: true })).toBeVisible()
  })
})

test.describe('退货给供应商 -> 状态筛选', () => {
  const statuses: ReturnStatus[] = ['pending', 'shipped', 'received', 'refunded', 'cancelled']
  for (const status of statuses) {
    test(`SR-FILTER-01-${status}. 正常用例：筛选${status}状态`, async ({ page }) => {
      const token = await apiLogin('admin')
      const record = await createReturnAtStatus(token, status)
      await loginAs(page, 'admin')
      await gotoSupplierReturns(
        page,
        `?status=${status}&keyword=${encodeURIComponent(record.returnNo)}`,
      )
      await expect(page.locator('select').first()).toHaveValue(status)
      const row = page.getByRole('row').filter({ hasText: record.returnNo })
      await expect(row).toHaveCount(1)
      await expect(row.getByText(STATUS_LABELS[status], { exact: true })).toBeVisible()
    })
  }

  test('SR-FILTER-02. 正常用例：重置筛选恢复全部', async ({ page }) => {
    await loginAs(page, 'admin')
    await gotoSupplierReturns(page, '?status=pending')
    await expect(page.locator('select').first()).toHaveValue('pending')
    const responsePromise = page.waitForResponse((response) => isApiResponse(response, 'GET', '/supplier-returns'))
    await page.getByRole('button', { name: '重置', exact: true }).click()
    const response = await responsePromise
    expect(response.status(), 'reset status filter response').toBe(200)
    await expect(page.locator('select').first()).toHaveValue('')
    await expect(page).toHaveURL(`${FE_BASE}/supplier-returns`)
  })
})

test.describe('退货给供应商 -> 创建退货记录', () => {
  test('SR-CREATE-01. 正常用例：admin通过UI创建退货成功', async ({ page }) => {
    const token = await apiLogin('admin')
    const before = await requireFixtureStock(token, UI_RETURN_QUANTITY)
    await loginAs(page, 'admin')
    await openSupplierReturnsFromMenu(page)

    const refsResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'GET', '/materials'))
    await page.getByRole('button', { name: '新建退货', exact: true }).click()
    expect((await refsResponsePromise).status(), 'material refs for create modal').toBe(200)

    const modal = page.getByRole('heading', { name: '新建退货给供应商', exact: true }).locator('xpath=ancestor::div[contains(@class,"max-w-lg")]')
    await expect(modal).toBeVisible()
    const materialSelect = modal.locator('select').nth(0)
    await expect(materialSelect.locator(`option[value="${fixture.materialId}"]`)).toHaveCount(1)
    await materialSelect.selectOption(fixture.materialId)
    await modal.locator('input[type="number"]').nth(0).fill(String(UI_RETURN_QUANTITY))
    await modal.locator('select').nth(1).selectOption(fixture.supplierId)
    await modal.locator('select').nth(4).selectOption('quality_issue')
    await modal.locator('input[type="number"]').nth(1).fill(String(UNIT_PRICE * UI_RETURN_QUANTITY))
    await modal.locator('input[type="text"]').fill('SF-E2E-UI-CREATE')
    await modal.locator('textarea').fill('E2E UI create truth')

    const createResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'POST', '/supplier-returns'))
    const refreshResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'GET', '/supplier-returns'))
    await modal.getByRole('button', { name: '确认创建', exact: true }).click()
    const createResponse = await createResponsePromise
    const refreshResponse = await refreshResponsePromise
    expect(createResponse.status(), 'UI supplier return create').toBe(200)
    expect(refreshResponse.status(), 'UI list refresh after create').toBe(200)
    const payload = await createResponse.json()
    const id = expectId(payload?.data, 'UI supplier return create')
    const detail = await getReturnDetail(token, id)
    expect(detail.quantity, 'UI-created quantity').toBe(UI_RETURN_QUANTITY)
    expect(detail.refundAmount, 'UI-created refund amount').toBe(UNIT_PRICE * UI_RETURN_QUANTITY)
    expect(detail.trackingNo, 'UI-created tracking number').toBe('SF-E2E-UI-CREATE')
    expect(detail.status, 'UI-created initial status').toBe('pending')
    const after = await getMaterialSnapshot(token)
    expect(after.stock, 'UI create deducts exact quantity').toBe(before - UI_RETURN_QUANTITY)
    await expect(page.getByRole('row').filter({ hasText: detail.returnNo })).toHaveCount(1)
  })

  for (const role of ['warehouse_manager', 'procurement'] as RoleKey[]) {
    test(`SR-CREATE-0${role === 'warehouse_manager' ? '2' : '3'}. 正常用例：${role}创建退货成功`, async () => {
      const token = await apiLogin(role)
      const record = await createReturn(token, { reason: role === 'procurement' ? 'quantity_mismatch' : 'damaged' })
      expect(record.status).toBe('pending')
    })
  }

  test('SR-CREATE-04. 表单校验：缺少materialId返回400', async () => {
    const token = await apiLogin('admin')
    const result = await apiFetch(token, 'POST', '/supplier-returns', { quantity: 1, reason: 'quality_issue' })
    expect(result.status).toBe(400)
  })

  test('SR-CREATE-05. 表单校验：缺少quantity返回400', async () => {
    const token = await apiLogin('admin')
    const result = await apiFetch(token, 'POST', '/supplier-returns', { materialId: fixtureMaterialId(), reason: 'quality_issue' })
    expect(result.status).toBe(400)
  })

  test('SR-CREATE-06. 表单校验：缺少reason返回400', async () => {
    const token = await apiLogin('admin')
    const result = await apiFetch(token, 'POST', '/supplier-returns', { materialId: fixtureMaterialId(), quantity: 1 })
    expect(result.status).toBe(400)
  })

  for (const quantity of [0, -1]) {
    test(`SR-CREATE-${quantity === 0 ? '07' : '08'}. 表单校验：quantity=${quantity}返回400`, async () => {
      const token = await apiLogin('admin')
      const result = await apiFetch(token, 'POST', '/supplier-returns', {
        materialId: fixtureMaterialId(), quantity, reason: 'quality_issue',
      })
      expect(result.status).toBe(400)
    })
  }

  test('SR-CREATE-09. 业务冲突：库存不足返回422', async () => {
    const token = await apiLogin('admin')
    const stock = await requireFixtureStock(token, 1)
    const result = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: fixtureMaterialId(), quantity: stock + 1, reason: 'quality_issue',
    })
    expect(result.status).toBe(422)
  })

  test('SR-CREATE-10. 业务冲突：物料不存在返回404', async () => {
    const token = await apiLogin('admin')
    const result = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId: randomUUID(), quantity: 1, reason: 'quality_issue',
    })
    expect(result.status).toBe(404)
  })

  for (const role of ['technician', 'pathologist', 'finance'] as RoleKey[]) {
    test(`SR-CREATE-11-${role}. 权限：${role}创建退货返回403`, async () => {
      const token = await apiLogin(role)
      const result = await apiFetch(token, 'POST', '/supplier-returns', {
        materialId: fixtureMaterialId(), quantity: 1, reason: 'quality_issue',
      })
      expect(result.status).toBe(403)
    })
  }

  test('SR-CREATE-12. 并发：快速双击提交产生两个明确记录', async () => {
    const token = await apiLogin('admin')
    const before = await requireFixtureStock(token, 2)
    const body = { materialId: fixtureMaterialId(), quantity: 1, reason: 'quality_issue', remark: 'E2E concurrent create' }
    const [first, second] = await Promise.all([
      apiFetch(token, 'POST', '/supplier-returns', body),
      apiFetch(token, 'POST', '/supplier-returns', body),
    ])
    const firstData = expectData(first, 200, 'first concurrent create')
    const secondData = expectData(second, 200, 'second concurrent create')
    const firstId = expectId(firstData, 'first concurrent create')
    const secondId = expectId(secondData, 'second concurrent create')
    expect(firstId, 'concurrent creates have unique ids').not.toBe(secondId)
    const after = await getMaterialSnapshot(token)
    expect(after.stock, 'concurrent creates deduct twice').toBe(before - 2)
  })

  test('SR-CREATE-13. 正常用例：退货后库存精确扣减', async () => {
    const token = await apiLogin('admin')
    const quantity = 3
    const before = await requireFixtureStock(token, quantity)
    const record = await createReturn(token, { quantity, remark: 'E2E inventory deduction' })
    const after = await getMaterialSnapshot(token)
    expect(after.stock, 'inventory after supplier return').toBe(before - quantity)
    const log = after.stockLogs.find((item) => item.relatedId === record.id && item.type === 'supplier_return')
    expect(log, 'supplier-return stock log').toMatchObject({
      quantity: -quantity,
      beforeStock: before,
      afterStock: before - quantity,
    })
  })

  test('SR-CREATE-14. 正常用例：退货单号格式SR-YYYYMMDD-XXXXXX-XXX', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    expect(record.returnNo).toMatch(/^SR-\d{8}-\d{6}-\d{3}$/)
  })

  test('SR-CREATE-15. 正常用例：数量、退款金额和物流单号持久化', async () => {
    const token = await apiLogin('admin')
    const quantity = 2
    const refundAmount = UNIT_PRICE * quantity
    const record = await createReturn(token, {
      quantity,
      reason: 'damaged',
      refundAmount,
      trackingNo: 'SF123456',
      remark: 'E2E完整字段',
    })
    expect(record).toMatchObject({ quantity, refundAmount, trackingNo: 'SF123456', status: 'pending' })
  })
})

test.describe('退货给供应商 -> 状态流转', () => {
  test('SR-STATUS-01. 正常用例：pending→shipped', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    await transitionReturn(token, record.id, 'shipped')
  })

  test('SR-STATUS-02. 正常用例：shipped→received', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    await transitionReturn(token, record.id, 'shipped')
    await transitionReturn(token, record.id, 'received')
  })

  test('SR-STATUS-03. 正常用例：received→refunded', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    await transitionReturn(token, record.id, 'shipped')
    await transitionReturn(token, record.id, 'received')
    const final = await transitionReturn(token, record.id, 'refunded')
    expect(final.status).toBe('refunded')
  })

  test('SR-STATUS-04. 正常用例：pending→cancelled', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    const final = await transitionReturn(token, record.id, 'cancelled')
    expect(final.status).toBe('cancelled')
  })

  test('SR-STATUS-05. 业务冲突：refunded→shipped非法流转返回400且状态不变', async () => {
    const token = await apiLogin('admin')
    const record = await createReturnAtStatus(token, 'refunded')
    const result = await apiFetch(token, 'PUT', `/supplier-returns/${record.id}/status`, { status: 'shipped' })
    expect(result.status).toBe(400)
    expect((await getReturnDetail(token, record.id)).status).toBe('refunded')
  })

  test('SR-STATUS-06. 业务冲突：shipped→pending回退返回400且状态不变', async () => {
    const token = await apiLogin('admin')
    const record = await createReturnAtStatus(token, 'shipped')
    const result = await apiFetch(token, 'PUT', `/supplier-returns/${record.id}/status`, { status: 'pending' })
    expect(result.status).toBe(400)
    expect((await getReturnDetail(token, record.id)).status).toBe('shipped')
  })

  test('SR-STATUS-07. 表单校验：无效状态值返回400且状态不变', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    const result = await apiFetch(token, 'PUT', `/supplier-returns/${record.id}/status`, { status: 'invalid_status' })
    expect(result.status).toBe(400)
    expect((await getReturnDetail(token, record.id)).status).toBe('pending')
  })

  test('SR-STATUS-08. 权限：technician更新状态返回403且状态不变', async () => {
    const adminToken = await apiLogin('admin')
    const record = await createReturn(adminToken)
    const token = await apiLogin('technician')
    const result = await apiFetch(token, 'PUT', `/supplier-returns/${record.id}/status`, { status: 'shipped' })
    expect(result.status).toBe(403)
    expect((await getReturnDetail(adminToken, record.id)).status).toBe('pending')
  })

  test('SR-STATUS-09. 并发：同一记录并发流转结果可解释且最终取消', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    const [shipped, cancelled] = await Promise.all([
      apiFetch(token, 'PUT', `/supplier-returns/${record.id}/status`, { status: 'shipped' }),
      apiFetch(token, 'PUT', `/supplier-returns/${record.id}/status`, { status: 'cancelled' }),
    ])
    expect([200, 400]).toContain(shipped.status)
    expect(cancelled.status).toBe(200)
    expect((await getReturnDetail(token, record.id)).status).toBe('cancelled')
  })

  test('SR-STATUS-10. 异常恢复：更新不存在的记录返回404', async () => {
    const token = await apiLogin('admin')
    const result = await apiFetch(token, 'PUT', `/supplier-returns/${randomUUID()}/status`, { status: 'shipped' })
    expect(result.status).toBe(404)
  })

  test('SR-STATUS-11. UI差异：前端详情弹窗显示当前状态和流转按钮', async ({ page }) => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    await loginAs(page, 'admin')
    await gotoSupplierReturns(page, `?keyword=${encodeURIComponent(record.returnNo)}`)
    const modal = await openReturnDetail(page, record.returnNo)
    await expect(modal.getByText('待发货', { exact: true })).toBeVisible()
    await expect(modal.getByRole('button', { name: '标记为已发货', exact: true })).toBeVisible()
    await expect(modal.getByRole('button', { name: '取消退货', exact: true })).toBeVisible()
  })

  test('SR-STATUS-12. 正常用例：cancelled后不能再次流转', async () => {
    const token = await apiLogin('admin')
    const record = await createReturnAtStatus(token, 'cancelled')
    const result = await apiFetch(token, 'PUT', `/supplier-returns/${record.id}/status`, { status: 'shipped' })
    expect(result.status).toBe(400)
    expect((await getReturnDetail(token, record.id)).status).toBe('cancelled')
  })
})

test.describe('退货给供应商 -> 删除退货记录', () => {
  for (const role of ['admin', 'warehouse_manager'] as RoleKey[]) {
    test(`SR-DELETE-0${role === 'admin' ? '1' : '2'}. 正常用例：${role}删除pending状态退货记录`, async () => {
      const adminToken = await apiLogin('admin')
      const record = await createReturn(adminToken, { remark: `E2E delete by ${role}` })
      const token = await apiLogin(role)
      await deleteReturn(token, record.id)
    })
  }

  test('SR-DELETE-03. 业务冲突：删除shipped状态返回400', async () => {
    const token = await apiLogin('admin')
    const record = await createReturnAtStatus(token, 'shipped')
    const result = await apiFetch(token, 'DELETE', `/supplier-returns/${record.id}`)
    expect(result.status).toBe(400)
    expect((await getReturnDetail(token, record.id)).status).toBe('shipped')
  })

  test('SR-DELETE-04. 业务冲突：删除refunded状态返回400', async () => {
    const token = await apiLogin('admin')
    const record = await createReturnAtStatus(token, 'refunded')
    const result = await apiFetch(token, 'DELETE', `/supplier-returns/${record.id}`)
    expect(result.status).toBe(400)
    expect((await getReturnDetail(token, record.id)).status).toBe('refunded')
  })

  for (const role of ['technician', 'pathologist', 'finance'] as RoleKey[]) {
    test(`SR-DELETE-05-${role}. 权限：${role}删除退货记录返回403`, async () => {
      const adminToken = await apiLogin('admin')
      const record = await createReturn(adminToken)
      const token = await apiLogin(role)
      const result = await apiFetch(token, 'DELETE', `/supplier-returns/${record.id}`)
      expect(result.status).toBe(403)
      expect((await getReturnDetail(adminToken, record.id)).status).toBe('pending')
    })
  }

  test('SR-DELETE-06. 并发：并发删除只恢复一次库存', async () => {
    const token = await apiLogin('admin')
    const before = await requireFixtureStock(token, 1)
    const record = await createReturn(token)
    expect((await getMaterialSnapshot(token)).stock).toBe(before - 1)
    const [first, second] = await Promise.all([
      apiFetch(token, 'DELETE', `/supplier-returns/${record.id}`),
      apiFetch(token, 'DELETE', `/supplier-returns/${record.id}`),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 404])
    expect((await getMaterialSnapshot(token)).stock).toBe(before)
  })

  test('SR-DELETE-07. 正常用例：删除后库存精确恢复', async () => {
    const token = await apiLogin('admin')
    const quantity = 2
    const before = await requireFixtureStock(token, quantity)
    const record = await createReturn(token, { quantity, remark: 'E2E rollback' })
    expect((await getMaterialSnapshot(token)).stock).toBe(before - quantity)
    await deleteReturn(token, record.id)
    expect((await getMaterialSnapshot(token)).stock).toBe(before)
  })

  test('SR-DELETE-08. 表单校验：删除不存在的记录返回404', async () => {
    const token = await apiLogin('admin')
    const result = await apiFetch(token, 'DELETE', `/supplier-returns/${randomUUID()}`)
    expect(result.status).toBe(404)
  })

  test('SR-DELETE-09. 异常恢复：删除后再次删除返回404', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token)
    await deleteReturn(token, record.id)
    const second = await apiFetch(token, 'DELETE', `/supplier-returns/${record.id}`)
    expect(second.status).toBe(404)
  })

  test('SR-DELETE-10. UI差异：admin显示删除确认并完成回退', async ({ page }) => {
    const token = await apiLogin('admin')
    const before = await requireFixtureStock(token, 1)
    const record = await createReturn(token, { remark: 'E2E UI delete' })
    await loginAs(page, 'admin')
    await gotoSupplierReturns(page, `?keyword=${encodeURIComponent(record.returnNo)}`)
    const row = page.getByRole('row').filter({ hasText: record.returnNo })
    await expect(row).toHaveCount(1)
    await row.getByRole('button', { name: '删除', exact: true }).click()
    const modal = page.getByRole('heading', { name: '确认删除', exact: true }).locator('xpath=ancestor::div[contains(@class,"max-w-md")]')
    await expect(modal.getByText(record.returnNo, { exact: true })).toBeVisible()
    const deleteResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'DELETE', `/supplier-returns/${record.id}`))
    const refreshResponsePromise = page.waitForResponse((response) => isApiResponse(response, 'GET', '/supplier-returns'))
    await modal.getByRole('button', { name: '确认删除', exact: true }).click()
    expect((await deleteResponsePromise).status(), 'UI delete response').toBe(200)
    expect((await refreshResponsePromise).status(), 'UI delete refresh').toBe(200)
    await expect(page.getByText('暂无退货记录', { exact: true })).toBeVisible()
    expect((await apiFetch(token, 'GET', `/supplier-returns/${record.id}`)).status).toBe(404)
    expect((await getMaterialSnapshot(token)).stock).toBe(before)
  })

  test('SR-DELETE-11. 正常用例：删除后stock_logs有成对流水', async () => {
    const token = await apiLogin('admin')
    const quantity = 2
    const before = await requireFixtureStock(token, quantity)
    const record = await createReturn(token, { quantity })
    await deleteReturn(token, record.id)
    const snapshot = await getMaterialSnapshot(token)
    const createLog = snapshot.stockLogs.find((item) => item.relatedId === record.id && item.type === 'supplier_return')
    const rollbackLog = snapshot.stockLogs.find((item) => item.relatedId === record.id && item.type === 'cancel')
    expect(createLog, 'supplier-return deduction log').toMatchObject({
      quantity: -quantity,
      beforeStock: before,
      afterStock: before - quantity,
    })
    expect(rollbackLog, 'supplier-return rollback log').toMatchObject({
      quantity,
      beforeStock: before - quantity,
      afterStock: before,
    })
  })

  test('SR-DELETE-12. 异常恢复：删除cancelled状态返回400', async () => {
    const token = await apiLogin('admin')
    const record = await createReturnAtStatus(token, 'cancelled')
    const result = await apiFetch(token, 'DELETE', `/supplier-returns/${record.id}`)
    expect(result.status).toBe(400)
    expect((await getReturnDetail(token, record.id)).status).toBe('cancelled')
  })
})

test.describe('退货给供应商 -> 分页切换', () => {
  test('SR-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    const token = await apiLogin('admin')
    await ensureReturnCount(token, 21)
    await loginAs(page, 'admin')
    await openSupplierReturnsFromMenu(page)
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return isApiResponse(response, 'GET', '/supplier-returns') && url.searchParams.get('page') === '2'
    })
    await page.getByRole('button', { name: '2', exact: true }).click()
    expect((await responsePromise).status(), 'second-page response').toBe(200)
    await expect(page.getByText(/第 2 \/ \d+ 页/)).toBeVisible()
  })

  test('SR-PAGE-02. 边界：page=0后端修正为1', async () => {
    const token = await apiLogin('admin')
    const data = expectData(await apiFetch(token, 'GET', '/supplier-returns?page=0'), 200, 'page zero')
    expect(data.page).toBe(1)
    expect(data.pagination.page).toBe(1)
  })

  test('SR-PAGE-03. 边界：page=999返回空列表', async () => {
    const token = await apiLogin('admin')
    const data = expectData(
      await apiFetch(token, 'GET', '/supplier-returns?page=999&pageSize=20'),
      200,
      'page beyond end',
    )
    expect(data.list).toEqual([])
    expect(data.page).toBe(999)
  })

  test('SR-PAGE-04. 边界：pageSize=1', async () => {
    const token = await apiLogin('admin')
    const data = expectData(
      await apiFetch(token, 'GET', '/supplier-returns?page=1&pageSize=1'),
      200,
      'single-item page',
    )
    expect(data.list.length).toBeLessThanOrEqual(1)
    expect(data.pageSize).toBe(1)
  })

  test('SR-PAGE-05. 并发：快速切换分页均等待对应响应', async ({ page }) => {
    const token = await apiLogin('admin')
    await ensureReturnCount(token, 21)
    await loginAs(page, 'admin')
    await openSupplierReturnsFromMenu(page)
    for (const target of ['2', '1', '2']) {
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return isApiResponse(response, 'GET', '/supplier-returns') && url.searchParams.get('page') === target
      })
      await page.getByRole('button', { name: target, exact: true }).click()
      expect((await responsePromise).status(), `page ${target} response`).toBe(200)
      await expect(page.getByText(new RegExp(`第 ${target} / \\d+ 页`))).toBeVisible()
    }
  })

  test('SR-PAGE-06. UI差异：各可读角色分页控件一致', async ({ page }) => {
    for (const role of READ_ROLES) {
      await loginAs(page, role)
      await openSupplierReturnsFromMenu(page)
      await expect(page.getByRole('option', { name: '20条/页', exact: true })).toHaveCount(1)
      await expect(page.getByText(/共 \d+ 条记录，第 1 \/ \d+ 页/)).toBeVisible()
    }
  })
})

test.describe('退货给供应商 -> 角色权限矩阵', () => {
  const permissionScenes = [
    { id: 'TC-PERM-SR-001', role: 'technician' as RoleKey, method: 'GET', path: '/supplier-returns', expected: 403 },
    { id: 'TC-PERM-SR-002', role: 'pathologist' as RoleKey, method: 'GET', path: '/supplier-returns', expected: 403 },
    { id: 'TC-PERM-SR-003', role: 'finance' as RoleKey, method: 'GET', path: '/supplier-returns', expected: 200 },
    { id: 'TC-PERM-SR-004', role: 'technician' as RoleKey, method: 'POST', path: '/supplier-returns', expected: 403 },
    { id: 'TC-PERM-SR-005', role: 'pathologist' as RoleKey, method: 'POST', path: '/supplier-returns', expected: 403 },
    { id: 'TC-PERM-SR-006', role: 'finance' as RoleKey, method: 'POST', path: '/supplier-returns', expected: 403 },
    { id: 'TC-PERM-SR-007', role: 'technician' as RoleKey, method: 'DELETE', path: `/supplier-returns/${randomUUID()}`, expected: 403 },
    { id: 'TC-PERM-SR-008', role: 'pathologist' as RoleKey, method: 'DELETE', path: `/supplier-returns/${randomUUID()}`, expected: 403 },
    { id: 'TC-PERM-SR-009', role: 'finance' as RoleKey, method: 'DELETE', path: `/supplier-returns/${randomUUID()}`, expected: 403 },
  ]

  for (const scene of permissionScenes) {
    test(`${scene.id}. ${scene.role} ${scene.method} ${scene.path} 返回${scene.expected}`, async () => {
      const token = await apiLogin(scene.role)
      let result: ApiResult
      if (scene.method === 'GET') {
        result = await apiFetch(token, 'GET', scene.path)
      } else if (scene.method === 'POST') {
        result = await apiFetch(token, 'POST', scene.path, {
          materialId: fixtureMaterialId(), quantity: 1, reason: 'quality_issue',
        })
      } else {
        result = await apiFetch(token, 'DELETE', scene.path)
      }
      expect(result.status).toBe(scene.expected)
    })
  }

  test('TC-PERM-SR-EXTRA-01. admin GET /supplier-returns 返回200', async () => {
    const token = await apiLogin('admin')
    const data = expectData(await apiFetch(token, 'GET', '/supplier-returns'), 200, 'admin supplier-return read')
    expect(Array.isArray(data.list)).toBe(true)
  })
})

test.describe('退货给供应商 -> 业务流程树', () => {
  test('BF-SR-01. 主路径：通过UI创建退货→发货→收货→退款', async ({ page }) => {
    const token = await apiLogin('admin')
    const record = await createReturn(token, { quantity: 1, refundAmount: UNIT_PRICE, remark: 'E2E main flow' })
    await loginAs(page, 'admin')
    await gotoSupplierReturns(page, `?keyword=${encodeURIComponent(record.returnNo)}`)
    const modal = await openReturnDetail(page, record.returnNo)
    await transitionReturnViaUi(page, modal, record.id, '标记为已发货', 'shipped')
    await transitionReturnViaUi(page, modal, record.id, '供应商已收货', 'received')
    await transitionReturnViaUi(page, modal, record.id, '标记退款完成', 'refunded')
    await expect(modal.getByRole('button', { name: '取消退货', exact: true })).toHaveCount(0)
    const final = await getReturnDetail(token, record.id)
    expect(final.status, 'main-flow final status').toBe('refunded')
    expect(final.quantity, 'main-flow quantity').toBe(1)
    expect(final.refundAmount, 'main-flow refund amount').toBe(UNIT_PRICE)
  })

  test('BF-SR-02. 分支：创建退货→取消', async () => {
    const token = await apiLogin('admin')
    const record = await createReturn(token, { reason: 'other', remark: 'E2E cancel path' })
    const final = await transitionReturn(token, record.id, 'cancelled')
    expect(final.status).toBe('cancelled')
  })

  test('BF-SR-03. 分支：创建退货→删除并恢复库存', async () => {
    const token = await apiLogin('admin')
    const before = await requireFixtureStock(token, 1)
    const record = await createReturn(token, { remark: 'E2E delete path' })
    expect((await getMaterialSnapshot(token)).stock).toBe(before - 1)
    await deleteReturn(token, record.id)
    expect((await getMaterialSnapshot(token)).stock).toBe(before)
  })

  test('BF-SR-04. 异常：取消后不能删除且状态保留', async () => {
    const token = await apiLogin('admin')
    const record = await createReturnAtStatus(token, 'cancelled')
    const result = await apiFetch(token, 'DELETE', `/supplier-returns/${record.id}`)
    expect(result.status).toBe(400)
    expect((await getReturnDetail(token, record.id)).status).toBe('cancelled')
  })

  test('BF-SR-05. 边界：零库存物料不能创建退货', async () => {
    const token = await apiLogin('admin')
    const materialId = await createZeroStockMaterial(token)
    const result = await apiFetch(token, 'POST', '/supplier-returns', {
      materialId, quantity: 1, reason: 'quality_issue',
    })
    expect(result.status).toBe(422)
    expect((await getMaterialSnapshot(token, materialId)).stock).toBe(0)
  })

  test('BF-SR-06. 正常用例：创建后检查精确库存流水', async () => {
    const token = await apiLogin('admin')
    const before = await requireFixtureStock(token, 1)
    const record = await createReturn(token, { remark: 'E2E flow log' })
    const after = await getMaterialSnapshot(token)
    expect(after.stock).toBe(before - 1)
    expect(
      after.stockLogs.find((item) => item.relatedId === record.id && item.type === 'supplier_return'),
    ).toMatchObject({ quantity: -1, beforeStock: before, afterStock: before - 1 })
  })
})
