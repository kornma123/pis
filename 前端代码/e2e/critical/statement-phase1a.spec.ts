import { createHash, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiLogin } from './fixtures'

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
})
