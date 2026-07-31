import { createHash, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { apiLogin, loginThroughUi } from './fixtures'

function apiBaseUrl(): string {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

async function apiPost(
  request: APIRequestContext,
  token: string,
  path: string,
  data: Record<string, unknown>,
) {
  return request.post(`${apiBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  })
}

test.describe('critical Phase 1A statement ledger contract', () => {
  test('account reconciliation requires exact generations and a strict settlement month', async ({ request }) => {
    const financeToken = await apiLogin(request, 'finance')
    const missingGeneration = await apiPost(
      request,
      financeToken,
      '/account-reconcile/compute',
      { partnerId: 'PT-E2E-LOC005', settlementMonth: '2026-06' },
    )
    expect(missingGeneration.status()).toBe(400)
    expect((await missingGeneration.json())?.error?.code).toBe('GENERATION_BINDING_REQUIRED')

    const invalidMonth = await apiPost(
      request,
      financeToken,
      '/account-reconcile/compute',
      {
        partnerId: 'PT-E2E-LOC005',
        settlementMonth: '2026-13',
        statementGenerationId: 'STMT-E2E-LOC005',
        reconcileGenerationId: 'RECON-E2E-LOC005',
      },
    )
    expect(invalidMonth.status()).toBe(400)
    expect((await invalidMonth.json())?.error?.code).toBe('INVALID_SETTLEMENT_MONTH')
  })

  test('finance completes the authoritative-empty chain while wrong roles and bad receipts fail closed', async ({ request }) => {
    const financeToken = await apiLogin(request, 'finance')
    const wrongRoleToken = await apiLogin(request, 'warehouse_manager')
    const identity = randomUUID()
    const sourceHash = `sha256:${createHash('sha256').update('[]').digest('hex')}`
    const input = {
      partnerId: `PT-E2E-${identity}`,
      settlementMonth: '2026-01',
      sourceFile: `phase1a-${identity}.xlsx`,
      sourceHash,
      templateFamily: 'category_summary',
      parserRevision: 'parser-phase1a-v1',
      configRevision: 'seed-phase1a-v1',
      sourceSheet: 'Sheet1',
      headerRow: 0,
      grid: [],
      idempotencyKey: `REQ-${identity}`,
    }

    const forbidden = await apiPost(
      request,
      wrongRoleToken,
      '/statement-batches/authoritative-empty-receipts',
      input,
    )
    expect(forbidden.status()).toBe(403)
    expect((await forbidden.json())?.error?.code).toBe('FORBIDDEN')

    const issued = await apiPost(
      request,
      financeToken,
      '/statement-batches/authoritative-empty-receipts',
      input,
    )
    expect(issued.status()).toBe(200)
    const receipt = (await issued.json())?.data?.receipt
    expect(receipt).toEqual(expect.any(String))

    const tampered = `${receipt.slice(0, -1)}${receipt.endsWith('a') ? 'b' : 'a'}`
    const rejectedTamper = await apiPost(request, financeToken, '/statement-batches', {
      ...input,
      emptyReceipt: tampered,
    })
    expect(rejectedTamper.status()).toBe(422)
    expect((await rejectedTamper.json())?.error?.code).toBe('AUTHORITATIVE_EMPTY_RECEIPT_INVALID')

    const imported = await apiPost(request, financeToken, '/statement-batches', {
      ...input,
      emptyReceipt: receipt,
    })
    expect(imported.status()).toBe(200)
    const importedData = (await imported.json())?.data
    expect(importedData).toMatchObject({
      duplicate: false,
      rawRowCount: 0,
      normalizedLineCount: 0,
    })

    const rejectedReplay = await apiPost(request, financeToken, '/statement-batches', {
      ...input,
      emptyReceipt: receipt,
    })
    expect(rejectedReplay.status()).toBe(409)
    expect((await rejectedReplay.json())?.error?.code).toBe('AUTHORITATIVE_EMPTY_RECEIPT_CONSUMED')

    const posted = await apiPost(
      request,
      financeToken,
      `/statement-batches/${importedData.batchId}/post`,
      {},
    )
    expect(posted.status()).toBe(200)
    expect((await posted.json())?.data).toMatchObject({
      status: 'posted',
      ledgerScope: 'statement_internal',
      pnlBridgeStatus: 'not_integrated',
    })

    const monthPath = `/month-close/${input.settlementMonth}/partners/${input.partnerId}`
    const generation = { generationId: importedData.generationId }
    for (const action of ['compute', 'complete', 'close'] as const) {
      const response = await apiPost(request, financeToken, `${monthPath}/${action}`, generation)
      expect(response.status(), `${action}: ${await response.text()}`).toBe(200)
    }
    const summary = await request.get(
      `${apiBaseUrl()}${monthPath}/summary?generationId=${encodeURIComponent(importedData.generationId)}`,
      { headers: { Authorization: `Bearer ${financeToken}` } },
    )
    expect(summary.status()).toBe(200)
    const summaryData = (await summary.json())?.data
    expect(summaryData).toMatchObject({
      generationId: importedData.generationId,
      status: 'closed',
    })
    expect(summaryData.readiness[0]).toMatchObject({
      source: 'statement',
      state: 'complete_empty',
      reason_code: 'AUTHORITATIVE_EMPTY_IMPORT',
    })
  })

  test('overview board discovers statement generations and reports no reconcile generation before compute', async ({ request }) => {
    const financeToken = await apiLogin(request, 'finance')

    const invalid = await request.get(
      `${apiBaseUrl()}/account-reconcile/overview?settlementMonth=2026-13`,
      { headers: { Authorization: `Bearer ${financeToken}` } },
    )
    expect(invalid.status()).toBe(400)
    expect((await invalid.json())?.error?.code).toBe('INVALID_SETTLEMENT_MONTH')

    const identity = randomUUID()
    const partnerId = `PT-E2E-BOARD-${identity}`
    const input = {
      partnerId,
      settlementMonth: '2026-02',
      sourceFile: `phase1a-board-${identity}.xlsx`,
      sourceHash: `sha256:${createHash('sha256').update('[]').digest('hex')}`,
      templateFamily: 'category_summary',
      parserRevision: 'parser-phase1a-v1',
      configRevision: 'seed-phase1a-v1',
      sourceSheet: 'Sheet1',
      headerRow: 0,
      grid: [],
      idempotencyKey: `REQ-${identity}`,
    }
    const receiptResp = await apiPost(request, financeToken, '/statement-batches/authoritative-empty-receipts', input)
    expect(receiptResp.status()).toBe(200)
    const receipt = (await receiptResp.json())?.data?.receipt
    const imported = await apiPost(request, financeToken, '/statement-batches', { ...input, emptyReceipt: receipt })
    expect(imported.status()).toBe(200)
    const importedData = (await imported.json())?.data
    const posted = await apiPost(request, financeToken, `/statement-batches/${importedData.batchId}/post`, {})
    expect(posted.status()).toBe(200)

    const board = await request.get(
      `${apiBaseUrl()}/account-reconcile/overview?settlementMonth=${input.settlementMonth}`,
      { headers: { Authorization: `Bearer ${financeToken}` } },
    )
    expect(board.status()).toBe(200)
    const boardData = (await board.json())?.data
    expect(boardData?.settlementMonth).toBe(input.settlementMonth)
    const item = (boardData?.items || []).find((i: { partnerId: string }) => i.partnerId === partnerId)
    expect(item, 'board must expose the imported partner').toBeTruthy()
    expect(item.statementGenerationId).toBe(importedData.generationId)
    expect(item.statementBatchStatus).toBe('posted')
    expect(item.reconcileGenerationId).toBeNull()
    expect(item.generationStatus).toBeNull()
    expect(boardData?.board?.total).toEqual(expect.any(Number))
  })

  test('a new statement generation supersedes the board statementGenerationId while reconcile stays unbound', async ({ request }) => {
    const financeToken = await apiLogin(request, 'finance')
    const identity = randomUUID()
    const partnerId = `PT-E2E-SUPERSEDE-${identity}`
    const makeInput = (parserRevision: string) => ({
      partnerId,
      settlementMonth: '2026-03',
      sourceFile: `phase1a-supersede-${identity}.xlsx`,
      sourceHash: `sha256:${createHash('sha256').update('[]').digest('hex')}`,
      templateFamily: 'category_summary',
      parserRevision,
      configRevision: 'seed-phase1a-v1',
      sourceSheet: 'Sheet1',
      headerRow: 0,
      grid: [],
      idempotencyKey: `REQ-${identity}-${parserRevision}`,
    })
    const importGeneration = async (parserRevision: string) => {
      const input = makeInput(parserRevision)
      const issued = await apiPost(request, financeToken, '/statement-batches/authoritative-empty-receipts', input)
      expect(issued.status()).toBe(200)
      const receipt = (await issued.json())?.data?.receipt
      const imported = await apiPost(request, financeToken, '/statement-batches', { ...input, emptyReceipt: receipt })
      expect(imported.status()).toBe(200)
      return (await imported.json())?.data
    }

    const v1 = await importGeneration('parser-phase1a-v1')
    const v2 = await importGeneration('parser-phase1a-v2')
    expect(v2.generationId).not.toBe(v1.generationId)
    expect(v2.supersedesGenerationId).toBe(v1.generationId)

    const board = await request.get(
      `${apiBaseUrl()}/account-reconcile/overview?settlementMonth=2026-03`,
      { headers: { Authorization: `Bearer ${financeToken}` } },
    )
    expect(board.status()).toBe(200)
    const item = ((await board.json())?.data?.items || []).find(
      (i: { partnerId: string }) => i.partnerId === partnerId,
    )
    expect(item, 'board must expose the superseded partner').toBeTruthy()
    // 账单重出后 board 只认新 statement generation（is_current 翻转）；
    // reconcile 侧仍可能绑定旧代（本票 finding 的触发前提），未核对时保持 null。
    expect(item.statementGenerationId).toBe(v2.generationId)
    expect(item.reconcileGenerationId).toBeNull()
    expect(item.reconcileStatementGenerationId).toBeNull()
  })
})

// —— LOC-005 前端代次绑定 UI 回归（真前端 + 真后端进程；四个 account-reconcile 端点按后端路由真实合同注入）——
// 后端没有任何 API 能造出「已计算且绑定某 statement 代」的对账事实（compute 需要逐 case 账单明细行，
// Phase 1A 三模板只产聚合/OUT 行），故 overview/workbench/compute/verdict 用 page.route 注入与
// account-reconcile-v1.1.ts 完全同形的响应；登录、导航、前端状态机、点击链路全部真跑。
// 注入层同时扮演忠实后端替身：workbench / verdict / compute 收到错配 binding 一律
// 409 RECONCILE_GENERATION_MISMATCH（与 assertExactGeneration 行为一致），绝不会对错配请求放行。

const UI_MONTH = '2026-06'
const UI_PARTNER = 'PT-E2E-MISMATCH'
const UI_PARTNER_NAME = '错配医院'
const UI_STMT_V1 = 'GEN-E2E-V1'
const UI_STMT_V2 = 'GEN-E2E-V2'
const UI_RECON_V1 = 'RECON-E2E-1'
const UI_HM_ID = 'HM-E2E-1'
const UI_DIFF_ID = 'DIFF-E2E-1'
const UI_SUPPLEMENT_ID = 'SUP-E2E-OMITTED-MONTH'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface BoardItemFixture {
  id: string | null
  partnerId: string
  partnerName: string | null
  serviceMonth: string
  status: '待复核' | '复核完成' | '已关账' | null
  matchRate: number | null
  matchStatus: '正常' | '匹配偏低' | '先查' | '待对齐' | null
  statementReady: boolean
  lisReady: boolean
  diffCount: number
  pendingCount: number
  unmatchedCount: number
  confirmedLabRevenue: number | null
  hospitalMonthId: string | null
  statementGenerationId: string | null
  statementBatchStatus: string | null
  reconcileGenerationId: string | null
  reconcileStatementGenerationId: string | null
  generationStatus: 'pending' | 'complete' | 'closed' | null
}

function boardItem(overrides: Partial<BoardItemFixture> & { partnerId: string }): BoardItemFixture {
  return {
    id: null,
    partnerName: null,
    serviceMonth: UI_MONTH,
    status: null,
    matchRate: null,
    matchStatus: null,
    statementReady: false,
    lisReady: false,
    diffCount: 0,
    pendingCount: 0,
    unmatchedCount: 0,
    confirmedLabRevenue: null,
    hospitalMonthId: null,
    statementGenerationId: null,
    statementBatchStatus: null,
    reconcileGenerationId: null,
    reconcileStatementGenerationId: null,
    generationStatus: null,
    ...overrides,
  }
}

interface DiffVerdictState {
  verdict: string | null
  verdictBy: string | null
  followUp: string | null
}

interface ReconcileUiHarness {
  workbenchQueries: URLSearchParams[]
  computeBodies: Array<Record<string, unknown>>
  verdictBodies: Array<Record<string, unknown>>
  setItems(items: BoardItemFixture[]): void
  /** 让接下来 count 次 workbench GET 以 500 失败（模拟认定后的权威重读故障）。 */
  failWorkbenchReads(count: number): void
}

function boardEnvelope(month: string | null, items: BoardItemFixture[]) {
  const rows = month === UI_MONTH ? items : []
  const computed = rows.filter((i) => i.id !== null)
  return {
    success: true,
    data: {
      settlementMonth: month ?? UI_MONTH,
      items: rows,
      board: {
        total: computed.length,
        待复核: computed.filter((i) => i.status === '待复核').length,
        复核完成: computed.filter((i) => i.status === '复核完成').length,
        已关账: computed.filter((i) => i.status === '已关账').length,
        补收实收: 0,
        确认实收: 0,
      },
    },
  }
}

function snapshotFor(b: { partnerId: string; settlementMonth: string; statementGenerationId: string; reconcileGenerationId: string }) {
  return {
    ...b,
    hospitalMonthId: UI_HM_ID,
    status: 'pending',
    completedAt: null,
    completedBy: null,
    closedAt: null,
    closedBy: null,
    confirmedLabRevenue: null,
    statementArtifactHash: 'sha256:e2e-ui-fixture',
    result: { matchRate: 1, matchStatus: '正常', diffs: [], unmatched: [] },
    caseHints: {},
  }
}

function workbenchEnvelope(
  b: { partnerId: string; settlementMonth: string; statementGenerationId: string; reconcileGenerationId: string },
  diffVerdict: DiffVerdictState,
) {
  return {
    success: true,
    data: {
      snapshot: snapshotFor(b),
      diffs: [
        {
          id: UI_DIFF_ID,
          caseNo: 'E2E-CASE-1',
          lineType: '免疫组化',
          billCount: 5,
          lisCount: 3,
          delta: 2,
          amountImpact: 200,
          systemHint: '疑似计费项目用错',
          lowConfidence: false,
          verdict: diffVerdict.verdict,
          verdictReason: null,
          verdictBy: diffVerdict.verdictBy,
          followUp: diffVerdict.followUp,
        },
      ],
      caseHints: {},
    },
  }
}

const generationMismatch = {
  success: false,
  error: { code: 'RECONCILE_GENERATION_MISMATCH', message: 'reconciliation generation binding mismatch' },
}

async function installReconcileUiRoutes(
  page: Page,
  initialItems: BoardItemFixture[],
  initialDiffVerdict: DiffVerdictState = { verdict: null, verdictBy: null, followUp: null },
): Promise<ReconcileUiHarness> {
  let items = initialItems
  let diffVerdict: DiffVerdictState = initialDiffVerdict
  let workbenchReadFailures = 0
  const harness: ReconcileUiHarness = {
    workbenchQueries: [],
    computeBodies: [],
    verdictBodies: [],
    setItems: (next) => {
      items = next
    },
    failWorkbenchReads: (count) => {
      workbenchReadFailures = count
    },
  }
  const bindingOf = (source: URLSearchParams | Record<string, unknown>) => {
    const get = (key: string) =>
      String(source instanceof URLSearchParams ? source.get(key) ?? '' : source[key] ?? '')
    return {
      partnerId: get('partnerId'),
      settlementMonth: get('settlementMonth'),
      statementGenerationId: get('statementGenerationId'),
      reconcileGenerationId: get('reconcileGenerationId'),
    }
  }
  const matchesBoundGeneration = (b: { partnerId: string; statementGenerationId: string; reconcileGenerationId: string }) => {
    const item = items.find((i) => i.partnerId === b.partnerId)
    return !!item
      && item.reconcileGenerationId === b.reconcileGenerationId
      && item.reconcileStatementGenerationId === b.statementGenerationId
  }

  await page.route(/\/api\/v1\/account-reconcile\/overview/, (route) => {
    const month = new URL(route.request().url()).searchParams.get('settlementMonth')
    return route.fulfill({ json: boardEnvelope(month, items) })
  })
  await page.route(/\/api\/v1\/account-reconcile\/workbench/, (route) => {
    const params = new URL(route.request().url()).searchParams
    harness.workbenchQueries.push(params)
    if (workbenchReadFailures > 0) {
      workbenchReadFailures -= 1
      return route.fulfill({
        status: 500,
        json: { success: false, error: { code: 'INTERNAL_ERROR', message: 'e2e injected authoritative re-read failure' } },
      })
    }
    const b = bindingOf(params)
    if (!matchesBoundGeneration(b)) return route.fulfill({ status: 409, json: generationMismatch })
    return route.fulfill({ json: workbenchEnvelope(b, diffVerdict) })
  })
  await page.route(/\/api\/v1\/account-reconcile\/compute/, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    harness.computeBodies.push(body)
    const b = bindingOf(body)
    const item = items.find((i) => i.partnerId === b.partnerId)
    // 忠实替身：沿用旧对账代但 statement 代已变 → 与后端一致 409；铸新代（uuid 不在册）→ supersede 成功并愈合。
    if (item?.reconcileGenerationId === b.reconcileGenerationId && item.reconcileStatementGenerationId !== b.statementGenerationId) {
      return route.fulfill({ status: 409, json: generationMismatch })
    }
    items = items.map((i) =>
      i.partnerId === b.partnerId
        ? {
            ...i,
            id: i.id ?? UI_HM_ID,
            hospitalMonthId: i.hospitalMonthId ?? UI_HM_ID,
            status: i.status ?? '待复核',
            matchRate: 1,
            matchStatus: '正常' as const,
            statementReady: true,
            lisReady: true,
            statementGenerationId: b.statementGenerationId,
            reconcileGenerationId: b.reconcileGenerationId,
            reconcileStatementGenerationId: b.statementGenerationId,
            generationStatus: 'pending' as const,
          }
        : i,
    )
    return route.fulfill({ json: { success: true, data: snapshotFor(b) } })
  })
  await page.route(/\/api\/v1\/account-reconcile\/diffs\/[^/]+\/verdict/, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    harness.verdictBodies.push(body)
    const b = bindingOf(body)
    if (!matchesBoundGeneration(b)) return route.fulfill({ status: 409, json: generationMismatch })
    // 权威写入生效：后续 workbench 重读必须带回真实操作者（财务 caiwu）。
    diffVerdict = { verdict: String(body.reason ?? ''), verdictBy: 'caiwu', followUp: 'settled' }
    // 与后端 verdict 响应同形：无 verdictBy 字段（权威 actor 只能重读取得）。
    return route.fulfill({
      json: { success: true, data: { id: UI_DIFF_ID, verdict: body.reason ?? null, followUp: 'settled', pendingCount: 0, duplicate: false } },
    })
  })
  return harness
}

async function openAccountReconcileMonth(page: Page) {
  await page.goto('/account-reconcile')
  await page.locator('input[type="month"]').fill(UI_MONTH)
}

test.describe('critical supplement collection month authority UI contract', () => {
  test('finance collect request omits collectedMonth so the backend owns the Shanghai default', async ({ page }) => {
    await loginThroughUi(page, 'finance')
    await installReconcileUiRoutes(page, [])

    let collected = false
    const listQueries: URLSearchParams[] = []
    const collectRequests: Array<{ method: string; body: Record<string, unknown> }> = []
    const supplement = () => ({
      id: UI_SUPPLEMENT_ID,
      partnerId: 'PT-E2E-COLLECT',
      serviceMonth: UI_MONTH,
      sourceDiffId: UI_DIFF_ID,
      caseNo: 'E2E-COLLECT-1',
      amount: 1200,
      caseCount: 1,
      status: collected ? '已补收' : '待补收',
      collectedAt: collected ? '2026-09-01T00:00:00.000Z' : null,
      collectedMonth: collected ? '2026-09' : null,
      collectedRevenue: collected ? 960 : null,
      giveUpReason: null,
      operator: collected ? 'caiwu' : null,
      reviewStatus: 'approved',
      submittedBy: 'jishuyuan1',
      reviewedBy: 'shenheren',
      reviewedAt: '2026-08-31T15:00:00.000Z',
    })

    await page.route(/\/api\/v1\/account-reconcile\/supplements(?:\?.*)?$/, (route) => {
      const url = new URL(route.request().url())
      listQueries.push(url.searchParams)
      return route.fulfill({
        json: {
          success: true,
          data: {
            list: [supplement()],
            board: {
              待补收金额: collected ? 0 : 1200,
              已补收金额: collected ? 1200 : 0,
              已放弃金额: 0,
              已补收实收: collected ? 960 : 0,
              待补收数: collected ? 0 : 1,
              待签发数: 0,
              补收率: collected ? 1 : 0,
            },
          },
        },
      })
    })
    await page.route(
      new RegExp(`/api/v1/account-reconcile/supplements/${UI_SUPPLEMENT_ID}/collect$`),
      (route) => {
        const rawBody = route.request().postData()
        collectRequests.push({
          method: route.request().method(),
          body: rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {},
        })
        collected = true
        return route.fulfill({
          json: {
            success: true,
            data: {
              id: UI_SUPPLEMENT_ID,
              status: '已补收',
              collectedMonth: '2026-09',
            },
          },
        })
      },
    )

    await page.getByRole('link', { name: '账实核对', exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/account-reconcile')
    await page.locator('input[type="month"]').fill(UI_MONTH)
    await page.getByRole('tab', { name: '③ 补收追踪', exact: true }).click()

    const row = page.getByRole('row', { name: /PT-E2E-COLLECT/ })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '标记已补收', exact: true }).click()

    await expect.poll(() => collectRequests.length).toBe(1)
    expect(collectRequests[0].method).toBe('POST')
    expect(collectRequests[0].body).toEqual({})
    expect(Object.prototype.hasOwnProperty.call(collectRequests[0].body, 'collectedMonth')).toBe(false)
    expect(listQueries.length).toBeGreaterThan(0)
    for (const query of listQueries) expect(query.get('serviceMonth')).toBe(UI_MONTH)
    await expect(row).toContainText('计入 2026年9月')
  })
})

test.describe('critical account-reconcile generation binding UI contract', () => {
  test('consistent v1/v1 binding opens the workbench carrying the exact four-field binding', async ({ page }) => {
    await loginThroughUi(page, 'finance')
    const harness = await installReconcileUiRoutes(page, [
      boardItem({
        id: UI_HM_ID,
        partnerId: UI_PARTNER,
        partnerName: UI_PARTNER_NAME,
        status: '待复核',
        matchRate: 1,
        matchStatus: '正常',
        statementReady: true,
        lisReady: true,
        diffCount: 1,
        pendingCount: 1,
        hospitalMonthId: UI_HM_ID,
        statementGenerationId: UI_STMT_V1,
        statementBatchStatus: 'posted',
        reconcileGenerationId: UI_RECON_V1,
        reconcileStatementGenerationId: UI_STMT_V1,
        generationStatus: 'pending',
      }),
    ])
    await openAccountReconcileMonth(page)

    const row = page.locator('tbody tr', { hasText: UI_PARTNER_NAME })
    await expect(row).toBeVisible()
    await expect(row.getByText('账单已更新，请重算')).toHaveCount(0)
    await row.getByRole('button', { name: '去核对 →' }).click()

    await expect(page.getByText('差异明细')).toBeVisible()
    await expect(page.getByText('病理号 E2E-CASE-1')).toBeVisible()
    // React StrictMode 开发双挂载会重放初载 effect：断言至少一次，且每次都携带同一精确四元组。
    expect(harness.workbenchQueries.length).toBeGreaterThan(0)
    for (const query of harness.workbenchQueries) {
      expect(Object.fromEntries(query.entries())).toEqual({
        partnerId: UI_PARTNER,
        settlementMonth: UI_MONTH,
        statementGenerationId: UI_STMT_V1,
        reconcileGenerationId: UI_RECON_V1,
      })
    }
  })

  test('statement v2 with reconcile bound to v1 blocks the workbench and only recomputes into a fresh generation', async ({ page }) => {
    await loginThroughUi(page, 'finance')
    const harness = await installReconcileUiRoutes(page, [
      boardItem({
        id: UI_HM_ID,
        partnerId: UI_PARTNER,
        partnerName: UI_PARTNER_NAME,
        status: '待复核',
        matchRate: 1,
        matchStatus: '正常',
        statementReady: true,
        lisReady: true,
        diffCount: 1,
        pendingCount: 1,
        hospitalMonthId: UI_HM_ID,
        statementGenerationId: UI_STMT_V2,
        statementBatchStatus: 'posted',
        reconcileGenerationId: UI_RECON_V1,
        reconcileStatementGenerationId: UI_STMT_V1,
        generationStatus: 'pending',
      }),
    ])
    await openAccountReconcileMonth(page)

    const row = page.locator('tbody tr', { hasText: UI_PARTNER_NAME })
    await expect(row).toBeVisible()
    await expect(row.getByText('账单已更新，请重算')).toBeVisible()
    await expect(row.getByRole('button', { name: /去核对|看明细/ })).toHaveCount(0)
    expect(harness.workbenchQueries).toHaveLength(0)

    await row.getByRole('button', { name: '重算', exact: true }).click()
    await expect.poll(() => harness.computeBodies.length).toBe(1)
    const computeBody = harness.computeBodies[0]
    expect(computeBody).toMatchObject({
      partnerId: UI_PARTNER,
      settlementMonth: UI_MONTH,
      statementGenerationId: UI_STMT_V2,
    })
    expect(String(computeBody.reconcileGenerationId)).not.toBe(UI_RECON_V1)
    expect(String(computeBody.reconcileGenerationId)).toMatch(UUID_PATTERN)

    // 重算愈合后：错配提示消失、去核对开放，且携带愈合后的精确四元组（StrictMode 双挂载下断言每次而非次数）。
    const openButton = row.getByRole('button', { name: '去核对 →' })
    await expect(openButton).toBeVisible()
    await expect(row.getByText('账单已更新，请重算')).toHaveCount(0)
    await openButton.click()
    await expect(page.getByText('差异明细')).toBeVisible()
    expect(harness.workbenchQueries.length).toBeGreaterThan(0)
    for (const query of harness.workbenchQueries) {
      expect(Object.fromEntries(query.entries())).toEqual({
        partnerId: UI_PARTNER,
        settlementMonth: UI_MONTH,
        statementGenerationId: UI_STMT_V2,
        reconcileGenerationId: String(computeBody.reconcileGenerationId),
      })
    }
  })

  test('rows without a reconcile generation keep the legacy compute entry and never show stale copy', async ({ page }) => {
    const legacy = boardItem({
      id: 'HM-E2E-LEGACY',
      partnerId: 'PT-E2E-LEGACY',
      partnerName: '未算医院',
      status: '待复核',
      matchRate: 1,
      matchStatus: '正常',
      statementReady: true,
      lisReady: true,
      hospitalMonthId: 'HM-E2E-LEGACY',
      statementGenerationId: 'GEN-E2E-LEGACY',
      statementBatchStatus: 'posted',
    })
    const notReady = boardItem({
      id: 'HM-E2E-NOTREADY',
      partnerId: 'PT-E2E-NOTREADY',
      partnerName: '未齐医院',
      status: '待复核',
      hospitalMonthId: 'HM-E2E-NOTREADY',
    })
    await loginThroughUi(page, 'finance')
    const harness = await installReconcileUiRoutes(page, [legacy, notReady])
    await openAccountReconcileMonth(page)

    const legacyRow = page.locator('tbody tr', { hasText: '未算医院' })
    await expect(legacyRow).toBeVisible()
    await expect(legacyRow.getByRole('button', { name: '计算', exact: true })).toBeVisible()
    await expect(legacyRow.getByRole('button', { name: /去核对|看明细/ })).toHaveCount(0)
    await expect(legacyRow.getByText('账单已更新，请重算')).toHaveCount(0)

    const notReadyRow = page.locator('tbody tr', { hasText: '未齐医院' })
    await expect(notReadyRow).toBeVisible()
    await expect(notReadyRow.getByText('数据待对齐')).toBeVisible()
    await expect(notReadyRow.getByText('账单已更新，请重算')).toHaveCount(0)
    await expect(page.getByText('部分院数据未到齐')).toBeVisible()

    await legacyRow.getByRole('button', { name: '计算', exact: true }).click()
    await expect.poll(() => harness.computeBodies.length).toBe(1)
    expect(harness.computeBodies[0]).toMatchObject({
      partnerId: 'PT-E2E-LEGACY',
      settlementMonth: UI_MONTH,
      statementGenerationId: 'GEN-E2E-LEGACY',
    })
    expect(String(harness.computeBodies[0].reconcileGenerationId)).toMatch(UUID_PATTERN)
    await expect(legacyRow.getByRole('button', { name: '去核对 →' })).toBeVisible()
    await expect(legacyRow.getByText('账单已更新，请重算')).toHaveCount(0)
  })

  test('a statement regenerated between overview load and click fails closed inside the workbench', async ({ page }) => {
    await loginThroughUi(page, 'finance')
    const harness = await installReconcileUiRoutes(page, [
      boardItem({
        id: UI_HM_ID,
        partnerId: UI_PARTNER,
        partnerName: UI_PARTNER_NAME,
        status: '待复核',
        matchRate: 1,
        matchStatus: '正常',
        statementReady: true,
        lisReady: true,
        diffCount: 1,
        pendingCount: 1,
        hospitalMonthId: UI_HM_ID,
        statementGenerationId: UI_STMT_V1,
        statementBatchStatus: 'posted',
        reconcileGenerationId: UI_RECON_V1,
        reconcileStatementGenerationId: UI_STMT_V1,
        generationStatus: 'pending',
      }),
    ])
    await openAccountReconcileMonth(page)

    const row = page.locator('tbody tr', { hasText: UI_PARTNER_NAME })
    const openButton = row.getByRole('button', { name: '去核对 →' })
    await expect(openButton).toBeVisible()

    // 账单在总览加载之后、点击之前被重出：board 已是 v2 + 对账仍绑 v1，行内仍持旧快照。
    harness.setItems([
      boardItem({
        id: UI_HM_ID,
        partnerId: UI_PARTNER,
        partnerName: UI_PARTNER_NAME,
        status: '待复核',
        matchRate: 1,
        matchStatus: '正常',
        statementReady: true,
        lisReady: true,
        diffCount: 1,
        pendingCount: 1,
        hospitalMonthId: UI_HM_ID,
        statementGenerationId: UI_STMT_V2,
        statementBatchStatus: 'posted',
        reconcileGenerationId: UI_RECON_V1,
        reconcileStatementGenerationId: UI_STMT_V1,
        generationStatus: 'pending',
      }),
    ])
    await openButton.click()

    await expect(page.getByText('账单已更新，本次核对仍绑定旧账单，请回总览重算。')).toBeVisible()
    expect(harness.workbenchQueries).toHaveLength(0)
  })

  test('verdict re-reads the authoritative workbench and shows the real operator instead of 我', async ({ page }) => {
    await loginThroughUi(page, 'finance')
    const harness = await installReconcileUiRoutes(page, [
      boardItem({
        id: UI_HM_ID,
        partnerId: UI_PARTNER,
        partnerName: UI_PARTNER_NAME,
        status: '待复核',
        matchRate: 1,
        matchStatus: '正常',
        statementReady: true,
        lisReady: true,
        diffCount: 1,
        pendingCount: 1,
        hospitalMonthId: UI_HM_ID,
        statementGenerationId: UI_STMT_V1,
        statementBatchStatus: 'posted',
        reconcileGenerationId: UI_RECON_V1,
        reconcileStatementGenerationId: UI_STMT_V1,
        generationStatus: 'pending',
      }),
    ])
    await openAccountReconcileMonth(page)
    await page.locator('tbody tr', { hasText: UI_PARTNER_NAME }).getByRole('button', { name: '去核对 →' }).click()
    await expect(page.getByText('差异明细')).toBeVisible()
    // StrictMode 双挂载下初载可能多于 1 次；记录认定前计数，认定后必须增加（权威重读）。
    const workbenchQueriesBeforeVerdict = harness.workbenchQueries.length
    expect(workbenchQueriesBeforeVerdict).toBeGreaterThan(0)

    await page.locator('select').selectOption('核对无误')
    await expect.poll(() => harness.verdictBodies.length).toBe(1)
    expect(harness.verdictBodies[0]).toMatchObject({
      partnerId: UI_PARTNER,
      settlementMonth: UI_MONTH,
      statementGenerationId: UI_STMT_V1,
      reconcileGenerationId: UI_RECON_V1,
      reason: '核对无误',
    })

    // 认定成功后必须重读权威 workbench（次数较认定前增加），最终展示真实 operator。
    await expect.poll(() => harness.workbenchQueries.length).toBeGreaterThan(workbenchQueriesBeforeVerdict)
    const verdictLine = page.locator('div.text-green-700', { hasText: '✓ 已认定：核对无误' })
    await expect(verdictLine).toBeVisible()
    await expect(verdictLine).toContainText('caiwu')
    await expect(verdictLine).not.toContainText('我')

    // 刷新后即时展示与权威重读一致：同一个真实 operator，永不出现「我」。
    await page.reload()
    await page.locator('input[type="month"]').fill(UI_MONTH)
    await page.locator('tbody tr', { hasText: UI_PARTNER_NAME }).getByRole('button', { name: '去核对 →' }).click()
    const verdictLineAfterReload = page.locator('div.text-green-700', { hasText: '✓ 已认定：核对无误' })
    await expect(verdictLineAfterReload).toBeVisible()
    await expect(verdictLineAfterReload).toContainText('caiwu')
    await expect(verdictLineAfterReload).not.toContainText('我')
  })

  test('a failed authoritative re-read after re-verdict clears the old operator instead of keeping it or inventing 我', async ({ page }) => {
    await loginThroughUi(page, 'finance')
    const harness = await installReconcileUiRoutes(page, [
      boardItem({
        id: UI_HM_ID,
        partnerId: UI_PARTNER,
        partnerName: UI_PARTNER_NAME,
        status: '待复核',
        matchRate: 1,
        matchStatus: '正常',
        statementReady: true,
        lisReady: true,
        diffCount: 1,
        pendingCount: 0,
        hospitalMonthId: UI_HM_ID,
        statementGenerationId: UI_STMT_V1,
        statementBatchStatus: 'posted',
        reconcileGenerationId: UI_RECON_V1,
        reconcileStatementGenerationId: UI_STMT_V1,
        generationStatus: 'pending',
      }),
    ], { verdict: '计费项目用错', verdictBy: 'laowang', followUp: 'external_fix' })
    await openAccountReconcileMonth(page)
    await page.locator('tbody tr', { hasText: UI_PARTNER_NAME }).getByRole('button', { name: '去核对 →' }).click()
    await expect(page.getByText('差异明细')).toBeVisible()
    const initialLine = page.locator('div.text-green-700', { hasText: '✓ 已认定：计费项目用错' })
    await expect(initialLine).toBeVisible()
    await expect(initialLine).toContainText('laowang')

    // 改认定：认定写成功，但随后的权威 workbench 重读失败 → 降级只更新结论、清空 actor。
    await page.getByRole('button', { name: '改认定' }).click()
    harness.failWorkbenchReads(1)
    await page.locator('select').selectOption('核对无误')
    await expect.poll(() => harness.verdictBodies.length).toBe(1)
    expect(harness.verdictBodies[0]).toMatchObject({
      partnerId: UI_PARTNER,
      settlementMonth: UI_MONTH,
      statementGenerationId: UI_STMT_V1,
      reconcileGenerationId: UI_RECON_V1,
      reason: '核对无误',
    })
    const fallbackLine = page.locator('div.text-green-700', { hasText: '✓ 已认定：核对无误' })
    await expect(fallbackLine).toBeVisible()
    await expect(fallbackLine).not.toContainText('laowang')
    await expect(fallbackLine).not.toContainText('我')

    // 刷新后权威重读成功：以服务端真实 actor 为准，旧操作者与「我」都不出现。
    await page.reload()
    await page.locator('input[type="month"]').fill(UI_MONTH)
    await page.locator('tbody tr', { hasText: UI_PARTNER_NAME }).getByRole('button', { name: '去核对 →' }).click()
    const reloadedLine = page.locator('div.text-green-700', { hasText: '✓ 已认定：核对无误' })
    await expect(reloadedLine).toBeVisible()
    await expect(reloadedLine).toContainText('caiwu')
    await expect(reloadedLine).not.toContainText('laowang')
    await expect(reloadedLine).not.toContainText('我')
  })
})
