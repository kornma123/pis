import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test'

type CapabilityLevel = 'R' | 'W'

type ApiReply<T = unknown> = {
  status?: number
  data?: T
  message?: string
  abort?: boolean
}

type InboundCreateCall = {
  body: Record<string, unknown>
  idempotencyKey: string
  request: Request
}

type ApiMockOptions = {
  capabilities?: Record<string, CapabilityLevel>
  purchaseOrders?: Array<Record<string, unknown>>
  inboundListReplies?: Array<ApiReply<Record<string, unknown>>>
  statsReplies?: Array<ApiReply<Record<string, unknown>>>
  createInbound?: (
    call: InboundCreateCall,
    state: ApiMockState,
  ) => ApiReply | Promise<ApiReply>
}

type ApiMockState = {
  inboundListRequests: number
  statsRequests: number
  inboundCreates: InboundCreateCall[]
  unhandled: string[]
  missingAuthorization: string[]
}

const MOCK_TOKEN =
  'e30.eyJ1c2VybmFtZSI6ImUyZSIsInJvbGUiOiJhZG1pbiIsInJlYWxOYW1lIjoiRTJFIFVzZXIifQ.'

const WRITE_CAPABILITIES: Record<string, CapabilityLevel> = {
  purchase_orders: 'W',
  inbound: 'W',
  materials: 'R',
  suppliers: 'R',
  locations: 'R',
}

const READ_CAPABILITIES: Record<string, CapabilityLevel> = {
  purchase_orders: 'R',
  inbound: 'R',
  materials: 'R',
  suppliers: 'R',
  locations: 'R',
}

const material = {
  id: 'mat-1',
  code: 'M001',
  name: '试剂 A',
  spec: '10 mL',
  unit: '盒',
  price: 0,
  stock: 0,
  minStock: 0,
  maxStock: 100,
  safetyStock: 0,
  categoryId: 'cat-1',
  status: 'active',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

const supplier = {
  id: 'sup-1',
  code: 'S001',
  name: '供应商 A',
  status: 'active',
  cooperationCount: 0,
  totalAmount: 0,
  rating: 0,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

const location = {
  id: 'loc-1',
  code: 'L001',
  name: '冷藏一号',
  type: 'fridge',
  zone: 'A',
  capacity: 100,
  used: 0,
  status: 'active',
  createdAt: '2026-07-01T00:00:00.000Z',
}

function purchaseOrder(
  id: string,
  orderNo: string,
  status: string,
  receivedQty: number,
) {
  const orderedQty = 10
  const remainingQty = orderedQty - receivedQty
  return {
    id,
    orderNo,
    order_no: orderNo,
    materialId: material.id,
    material_id: material.id,
    materialName: material.name,
    material_name: material.name,
    supplierId: supplier.id,
    supplier_id: supplier.id,
    supplierName: supplier.name,
    supplier_name: supplier.name,
    orderedQty,
    ordered_qty: orderedQty,
    receivedQty,
    received_qty: receivedQty,
    remainingQty,
    remaining_qty: remainingQty,
    unit: material.unit,
    unitPrice: 5,
    unit_price: 5,
    totalAmount: 50,
    total_amount: 50,
    expectedDate: '2026-07-20',
    expected_date: '2026-07-20',
    status,
    remark: '',
    createdAt: '2026-07-01T00:00:00.000Z',
    created_at: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  }
}

const defaultPurchaseOrders = [
  purchaseOrder('po-pending', 'PO-PENDING', 'pending', 0),
  purchaseOrder('po-partial', 'PO-PARTIAL', 'partial', 4),
  purchaseOrder('po-completed', 'PO-COMPLETED', 'completed', 10),
  purchaseOrder('po-unknown', 'PO-UNKNOWN', 'backend_new_state', 0),
]

const emptyPage = {
  list: [],
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
}

const zeroStats = {
  total: 0,
  completed: 0,
  cancelled: 0,
  amount: 0,
  supplierCount: 0,
  pendingOrders: 0,
}

function session(capabilities: Record<string, CapabilityLevel>) {
  return {
    token: MOCK_TOKEN,
    refreshToken: 'mock-refresh-token',
    user: {
      id: 'user-e2e',
      username: 'e2e',
      realName: 'E2E User',
      role: 'admin',
      roles: ['admin'],
      capabilities,
      canSeeCost: false,
    },
  }
}

async function seedAuthenticatedSession(
  page: Page,
  capabilities: Record<string, CapabilityLevel>,
) {
  await page.addInitScript((mockSession) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('token', mockSession.token)
    localStorage.setItem('refreshToken', mockSession.refreshToken)
    localStorage.setItem('user', JSON.stringify(mockSession.user))
  }, session(capabilities))
}

async function fulfillSuccess(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ success: true, data }),
  })
}

async function fulfillFailure(route: Route, status: number, message: string) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({
      success: false,
      error: { code: `MOCK_${status}`, message },
    }),
  })
}

async function fulfillReply(route: Route, reply: ApiReply) {
  if (reply.abort) {
    await route.abort('failed')
    return
  }
  const status = reply.status ?? 200
  if (status >= 400) {
    await fulfillFailure(route, status, reply.message ?? `mock HTTP ${status}`)
    return
  }
  await fulfillSuccess(route, reply.data ?? {})
}

function replyAt<T>(replies: ApiReply<T>[] | undefined, index: number, fallback: ApiReply<T>) {
  if (!replies?.length) return fallback
  return replies[Math.min(index, replies.length - 1)]
}

async function installApiMock(page: Page, options: ApiMockOptions = {}) {
  const capabilities = options.capabilities ?? WRITE_CAPABILITIES
  const orders = options.purchaseOrders ?? defaultPurchaseOrders
  const mockSession = session(capabilities)
  const state: ApiMockState = {
    inboundListRequests: 0,
    statsRequests: 0,
    inboundCreates: [],
    unhandled: [],
    missingAuthorization: [],
  }

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api\/v1/, '') || '/'
    const requestLabel = `${method} ${path}`

    if (!path.startsWith('/auth/') && !request.headers().authorization) {
      state.missingAuthorization.push(requestLabel)
    }

    if (method === 'POST' && path === '/auth/login') {
      await fulfillSuccess(route, mockSession)
      return
    }
    if (method === 'POST' && path === '/auth/refresh') {
      await fulfillSuccess(route, mockSession)
      return
    }
    if (method === 'GET' && path === '/materials') {
      await fulfillSuccess(route, {
        list: [material],
        pagination: { page: 1, pageSize: 999, total: 1, totalPages: 1 },
      })
      return
    }
    if (method === 'GET' && path === '/suppliers') {
      await fulfillSuccess(route, {
        list: [supplier],
        pagination: { page: 1, pageSize: 999, total: 1, totalPages: 1 },
      })
      return
    }
    if (method === 'GET' && path === '/locations') {
      await fulfillSuccess(route, {
        list: [location],
        pagination: { page: 1, pageSize: 999, total: 1, totalPages: 1 },
      })
      return
    }
    if (method === 'GET' && path === '/purchase-orders') {
      const pageNumber = Number(url.searchParams.get('page')) || 1
      const pageSize = Number(url.searchParams.get('pageSize')) || 20
      await fulfillSuccess(route, {
        list: orders,
        pagination: {
          page: pageNumber,
          pageSize,
          total: orders.length,
          totalPages: Math.ceil(orders.length / pageSize),
        },
      })
      return
    }
    if (method === 'GET' && path.startsWith('/purchase-orders/')) {
      const id = decodeURIComponent(path.slice('/purchase-orders/'.length))
      const order = orders.find((candidate) => candidate.id === id)
      if (!order) {
        await fulfillFailure(route, 404, '采购订单不存在')
        return
      }
      await fulfillSuccess(route, order)
      return
    }
    if (method === 'GET' && path === '/inbound/stats') {
      const reply = replyAt(
        options.statsReplies,
        state.statsRequests,
        { data: zeroStats },
      )
      state.statsRequests += 1
      await fulfillReply(route, reply)
      return
    }
    if (method === 'GET' && path === '/inbound') {
      const reply = replyAt(
        options.inboundListReplies,
        state.inboundListRequests,
        { data: emptyPage },
      )
      state.inboundListRequests += 1
      await fulfillReply(route, reply)
      return
    }
    if (method === 'POST' && path === '/inbound') {
      let body: Record<string, unknown> = {}
      try {
        body = request.postDataJSON() as Record<string, unknown>
      } catch {
        // Keep the malformed request observable to the assertion below.
      }
      const call: InboundCreateCall = {
        body,
        idempotencyKey: request.headers()['idempotency-key'] ?? '',
        request,
      }
      state.inboundCreates.push(call)
      const reply = options.createInbound
        ? await options.createInbound(call, state)
        : {
            data: {
              id: `inbound-${state.inboundCreates.length}`,
              inboundNo: `IB-MOCK-${state.inboundCreates.length}`,
            },
          }
      await fulfillReply(route, reply)
      return
    }

    state.unhandled.push(requestLabel)
    await fulfillFailure(route, 501, `测试未声明的 API：${requestLabel}`)
  })

  return state
}

async function bootstrap(page: Page, options: ApiMockOptions = {}) {
  await seedAuthenticatedSession(
    page,
    options.capabilities ?? WRITE_CAPABILITIES,
  )
  return installApiMock(page, options)
}

function assertMockBoundary(state: ApiMockState) {
  expect(state.unhandled, '页面发出了未纳入测试合同的 API 请求').toEqual([])
  expect(state.missingAuthorization, '业务 API 请求必须携带模拟登录令牌').toEqual([])
}

function csv(rows: string[][]) {
  return rows.map((row) => row.join(',')).join('\r\n')
}

const importHeaders = [
  '物料编码',
  '入库数量',
  '库位编码',
  '批号',
  '单价',
  '供应商编码',
  '生产日期',
  '有效期至',
  '备注',
]

async function uploadCsv(
  dialog: Locator,
  name: string,
  rows: string[][],
) {
  await dialog.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv([importHeaders, ...rows]), 'utf8'),
  })
}

async function advanceValidatedImportToConfirm(dialog: Locator) {
  const review = dialog.getByRole('button', { name: '核对并确认' })
  await expect(review).toBeEnabled()
  await review.click()
  await expect(dialog).toContainText(/即将逐行提交/)

  const acknowledgement = dialog.getByRole('checkbox', { name: /我已确认.*直接入库/ })
  const confirm = dialog.getByRole('button', { name: /确认并开始逐行入库/ })
  await expect(acknowledgement).not.toBeChecked()
  await expect(confirm).toBeDisabled()
  await acknowledgement.check()
  await expect(confirm).toBeEnabled()
  return confirm
}

async function openImportDialog(page: Page) {
  await page.goto('/inbound')
  const trigger = page.getByRole('button', { name: '批量导入' })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '批量导入入库' })
  await expect(dialog).toBeVisible()
  return { dialog, trigger }
}

test.describe('采购单到入库：真实能力与稳定上下文', () => {
  test('采购页移除假收货，unknown 无动作，pending 限制上下文可刷新、后退和返回', async ({ page }) => {
    const state = await bootstrap(page)
    const sourcePath =
      '/purchase-orders?status=pending&keyword=M001&page=2&pageSize=10'

    await page.goto(sourcePath)
    await expect(page.getByRole('heading', { name: '采购订单', exact: true })).toBeVisible()

    const pendingRow = page.getByRole('row').filter({ hasText: 'PO-PENDING' })
    const partialRow = page.getByRole('row').filter({ hasText: 'PO-PARTIAL' })
    const completedRow = page.getByRole('row').filter({ hasText: 'PO-COMPLETED' })
    const unknownRow = page.getByRole('row').filter({ hasText: 'PO-UNKNOWN' })

    await expect(pendingRow).toBeVisible()
    await expect(partialRow).toBeVisible()
    await expect(completedRow).toBeVisible()
    await expect(unknownRow).toContainText('未知状态')

    await expect(page.getByRole('button', { name: /^(收货|确认收货)$/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^(收货|确认收货)$/ })).toHaveCount(0)
    await expect(unknownRow.getByRole('button', { name: /收货|入库|取消/ })).toHaveCount(0)
    await expect(unknownRow.getByRole('link')).toHaveCount(0)
    await expect(completedRow.getByRole('link', { name: /入库/ })).toHaveCount(0)

    const restrictionLink = pendingRow.getByRole('link', { name: '查看入库限制' })
    await expect(restrictionLink).toBeVisible()
    await expect(restrictionLink).toHaveAttribute('title', /暂不可执行|后端.*原子校验/)
    await expect(page.getByRole('note')).toContainText(/关联采购单入库.*暂不可执行|后端.*原子校验/)
    await expect(partialRow.getByRole('link', { name: '查看入库限制' })).toBeVisible()

    await restrictionLink.click()
    await expect(page).toHaveURL(/\/inbound\?/)
    await expect.poll(() => {
      const url = new URL(page.url())
      return {
        purchaseOrderId: url.searchParams.get('purchaseOrderId'),
        materialId: url.searchParams.get('materialId'),
        type: url.searchParams.get('type'),
        returnTo: url.searchParams.get('returnTo'),
      }
    }).toEqual({
      purchaseOrderId: 'po-pending',
      materialId: 'mat-1',
      type: 'purchase',
      returnTo: sourcePath,
    })

    await expect(page.getByText('PO-PENDING', { exact: true })).toBeVisible()
    await expect(page.getByText(/关联采购单入库.*暂不可执行|后端.*原子校验/)).toBeVisible()
    const returnLink = page.getByRole('link', { name: '返回采购订单' })
    await expect(returnLink).toBeVisible()

    await page.reload()
    await expect(page.getByText('PO-PENDING', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: '返回采购订单' })).toBeVisible()

    await page.goBack()
    await expect(page).toHaveURL(/\/purchase-orders\?/)
    await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBe('pending')
    await expect.poll(() => new URL(page.url()).searchParams.get('keyword')).toBe('M001')

    await page.goForward()
    await expect.poll(() => new URL(page.url()).searchParams.get('purchaseOrderId')).toBe('po-pending')
    await page.getByRole('link', { name: '返回采购订单' }).click()
    await expect.poll(() => {
      const url = new URL(page.url())
      return {
        pathname: url.pathname,
        status: url.searchParams.get('status'),
        keyword: url.searchParams.get('keyword'),
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
      }
    }).toEqual({
      pathname: '/purchase-orders',
      status: 'pending',
      keyword: 'M001',
      page: '2',
      pageSize: '10',
    })

    expect(state.inboundCreates).toHaveLength(0)
    assertMockBoundary(state)
  })

  test('只读权限与可执行入口分开：说明原因但不暴露写操作', async ({ page }) => {
    const state = await bootstrap(page, { capabilities: READ_CAPABILITIES })

    await page.goto('/purchase-orders')
    const pendingRow = page.getByRole('row').filter({ hasText: 'PO-PENDING' })
    await expect(pendingRow.getByRole('link', { name: '查看入库限制' }))
      .toHaveAttribute('title', /没有入库写权限|无入库写权限/)
    await expect(page.getByRole('button', { name: '新建采购订单' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^(收货|确认收货|取消)$/ })).toHaveCount(0)

    await page.goto('/inbound')
    await expect(page.getByRole('button', { name: '新增入库' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '扫码入库' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '批量导入' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '打印记录' })).toBeVisible()

    expect(state.inboundCreates).toHaveLength(0)
    assertMockBoundary(state)
  })
})

test.describe('入库读取态：错误、空数据、真实 0 与后端 unknown', () => {
  test('列表网络错误显示可重试错误态，恢复成功后才显示空态', async ({ page }) => {
    const state = await bootstrap(page, {
      inboundListReplies: [
        { abort: true },
        { data: emptyPage },
      ],
    })

    await page.goto('/inbound')
    const errorAlert = page.getByRole('alert').filter({ hasText: /加载失败|网络/ }).first()
    await expect(errorAlert).toBeVisible()
    await expect(page.getByText(/暂无数据|暂无入库记录/)).toHaveCount(0)

    await page.getByRole('button', { name: /重试加载|重新加载|^重试$/ }).click()
    await expect(page.getByText(/暂无数据|暂无入库记录/)).toBeVisible()
    await expect(errorAlert).toHaveCount(0)
    expect(state.inboundListRequests).toBeGreaterThanOrEqual(2)
    assertMockBoundary(state)
  })

  test('统计真实 0 可见；统计接口失败则显示未知而不伪造 0', async ({ page }) => {
    const state = await bootstrap(page, {
      statsReplies: [
        { data: zeroStats },
        { status: 503, message: '统计服务暂不可用' },
      ],
    })

    await page.goto('/inbound')
    const stats = page.locator('[aria-label="入库统计"]')
    await expect(stats).toBeVisible()
    await expect(stats).toContainText(/全部入库记录|本月入库/)
    await expect(stats).toContainText('0')
    await expect(stats).not.toContainText(/未知|暂不可用/)

    await page.reload()
    await expect(stats).toContainText(/未能核实|未知|暂不可用|加载失败/)
    await expect(stats.getByText('0', { exact: true })).toHaveCount(0)
    expect(state.statsRequests).toBeGreaterThanOrEqual(2)
    assertMockBoundary(state)
  })
})

test.describe('入库 CSV：预览、校验、确认、结果与恢复', () => {
  test('部分失败不假成功，错误行用同一幂等键重试且校验失败行不提交', async ({ page }) => {
    const failedAttempts = new Map<string, number>()
    const state = await bootstrap(page, {
      createInbound: ({ body }) => {
        const batchNo = String(body.batchNo ?? '')
        if (batchNo === 'B-FAIL') {
          const attempt = (failedAttempts.get(batchNo) ?? 0) + 1
          failedAttempts.set(batchNo, attempt)
          if (attempt === 1) {
            return { status: 503, message: 'B-FAIL 网络中断' }
          }
        }
        return { data: { id: `ib-${batchNo}`, inboundNo: `IB-${batchNo}` } }
      },
    })
    const { dialog } = await openImportDialog(page)

    await uploadCsv(dialog, 'validation-errors.csv', [
      ['M001', '2', 'L001', 'B-OK', '0', 'S001', '2026-07-01', '2027-07-01', '有效行'],
      ['UNKNOWN', '1', 'MISSING', 'B-BAD', '', 'S001', '2026-02-31', '', '校验失败行'],
    ])

    await expect(dialog.getByRole('table', { name: /CSV 本地校验与提交结果/ })).toBeVisible()
    await expect(dialog).toContainText(/本地校验完成/)
    await expect(dialog).toContainText(/1\s*行可提交/)
    await expect(dialog).toContainText(/1\s*行需修正/)
    await expect(dialog.getByText('B-BAD', { exact: true })).toBeVisible()
    await expect(dialog).toContainText(/物料.*未匹配|库位.*未匹配/)
    await expect(dialog.getByRole('button', { name: '核对并确认' })).toBeDisabled()
    expect(state.inboundCreates).toHaveLength(0)

    await uploadCsv(dialog, 'partial-result.csv', [
      ['M001', '2', 'L001', 'B-OK', '0', 'S001', '2026-07-01', '2027-07-01', '有效行'],
      ['M001', '1', 'L001', 'B-FAIL', '5', 'S001', '', '', '服务失败后重试'],
    ])
    await expect(dialog).toContainText(/2\s*行可提交/)
    await expect(dialog).toContainText(/0\s*行需修正/)
    await expect(dialog.getByText('B-BAD', { exact: true })).toHaveCount(0)

    const confirm = await advanceValidatedImportToConfirm(dialog)
    await confirm.click()

    await expect.poll(() => state.inboundCreates.length).toBe(2)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(/提交结果/)
    await expect(dialog).toContainText(/成功\s*1/)
    await expect(dialog).toContainText(/失败\s*1/)

    const firstFailedCall = state.inboundCreates.find(
      (call) => call.body.batchNo === 'B-FAIL',
    )
    expect(firstFailedCall?.idempotencyKey).toBeTruthy()
    expect(state.inboundCreates.some((call) => call.body.batchNo === 'B-BAD')).toBe(false)

    await dialog.getByRole('button', { name: /仅重试.*失败行|重试失败/ }).click()
    await expect.poll(() => state.inboundCreates.length).toBe(3)

    const failedCalls = state.inboundCreates.filter(
      (call) => call.body.batchNo === 'B-FAIL',
    )
    expect(failedCalls).toHaveLength(2)
    expect(failedCalls[1].idempotencyKey).toBe(firstFailedCall?.idempotencyKey)
    expect(failedCalls[1].body).toEqual(firstFailedCall?.body)
    await expect(dialog).toContainText(/成功\s*2|全部.*成功/)
    await expect(dialog).toContainText(/失败\s*0|没有失败/)

    assertMockBoundary(state)
  })

  test('确认双击单飞：在途时禁用且只产生一个写请求', async ({ page }) => {
    let releaseRequest!: () => void
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const state = await bootstrap(page, {
      createInbound: async ({ body }) => {
        await requestGate
        return { data: { id: 'ib-single', inboundNo: `IB-${String(body.batchNo)}` } }
      },
    })
    const { dialog } = await openImportDialog(page)
    await uploadCsv(dialog, 'double-click.csv', [
      ['M001', '1', 'L001', 'B-SINGLE', '0', 'S001', '', '', '双击只提交一次'],
    ])

    const confirm = await advanceValidatedImportToConfirm(dialog)
    await confirm.evaluate((element) => {
      const button = element as HTMLButtonElement
      button.click()
      button.click()
    })

    try {
      await expect.poll(() => state.inboundCreates.length).toBe(1)
      await expect(confirm).toBeDisabled()
    } finally {
      releaseRequest()
    }

    await expect(dialog).toContainText(/成功\s*1|全部.*成功/)
    expect(state.inboundCreates[0].idempotencyKey).toBeTruthy()
    assertMockBoundary(state)
  })

  test('较早文件的迟到解析不会覆盖较新预览或触发 stale confirm', async ({ page }) => {
    const state = await bootstrap(page)
    await page.addInitScript(() => {
      const originalText = File.prototype.text
      File.prototype.text = function patchedText() {
        const currentFile = this
        if (currentFile.name === 'slow-old.csv') {
          return new Promise<void>((resolve) => window.setTimeout(resolve, 300))
            .then(() => originalText.call(currentFile))
        }
        return originalText.call(currentFile)
      }
    })

    const { dialog } = await openImportDialog(page)
    const input = dialog.locator('input[type="file"]')
    await input.setInputFiles({
      name: 'slow-old.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv([
        importHeaders,
        ['M001', '1', 'L001', 'B-STALE', '0', 'S001', '', '', '旧文件'],
      ]), 'utf8'),
    })
    await input.setInputFiles({
      name: 'fast-new.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv([
        importHeaders,
        ['M001', '1', 'L001', 'B-FRESH', '0', 'S001', '', '', '新文件'],
      ]), 'utf8'),
    })

    await expect(dialog.getByText('B-FRESH', { exact: true })).toBeVisible()
    await page.waitForTimeout(400)
    await expect(dialog.getByText('B-FRESH', { exact: true })).toBeVisible()
    await expect(dialog.getByText('B-STALE', { exact: true })).toHaveCount(0)

    const confirm = await advanceValidatedImportToConfirm(dialog)
    await confirm.click()
    await expect.poll(() => state.inboundCreates.length).toBe(1)
    expect(state.inboundCreates[0].body.batchNo).toBe('B-FRESH')
    assertMockBoundary(state)
  })
})

test.describe('跨端与键盘可达性', () => {
  for (const viewport of [
    { name: 'mobile-375', width: 375, height: 812 },
    { name: 'tablet-768', width: 768, height: 1024 },
    { name: 'desktop-1280', width: 1280, height: 800 },
  ]) {
    test(`${viewport.name} 的采购与入库关键区无页面级横向溢出`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      const state = await bootstrap(page)

      for (const path of ['/purchase-orders', '/inbound']) {
        await page.goto(path)
        await expect(page.locator('main').getByRole('heading').first()).toBeVisible()
        await expect.poll(() => page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth
        )).toBeLessThanOrEqual(1)
      }

      await expect(page.getByRole('button', { name: '新增入库' })).toBeVisible()
      await expect(page.getByRole('button', { name: '扫码入库' })).toBeVisible()
      await expect(page.getByRole('button', { name: '批量导入' })).toBeVisible()
      await expect(page.getByRole('button', { name: '打印记录' })).toBeVisible()
      assertMockBoundary(state)
    })
  }

  test('批量导入可由键盘打开，dialog 有名称和焦点，Escape 后焦点归还', async ({ page }) => {
    const state = await bootstrap(page)
    await page.goto('/inbound')
    const trigger = page.getByRole('button', { name: '批量导入' })

    await trigger.focus()
    await expect(trigger).toBeFocused()
    await trigger.press('Enter')

    const dialog = page.getByRole('dialog', { name: '批量导入入库' })
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect.poll(() => page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"]')
      return Boolean(modal?.contains(document.activeElement))
    })).toBe(true)
    await expect(dialog.getByRole('button', { name: /选择.*文件|上传.*文件/ })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    assertMockBoundary(state)
  })
})
