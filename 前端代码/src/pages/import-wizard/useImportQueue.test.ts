import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { statementImportApi } from '@/api/statement-import'
import { partnerConfigApi } from '@/api/partner-config'
import { readGrid } from '@/pages/import-shared/ImportShared'
import type { CommitResult, PreviewResult } from '@/types/statement-import'
import { useImportQueue, type CommitOutcome } from './useImportQueue'

vi.mock('@/api/statement-import', () => ({
  statementImportApi: {
    preview: vi.fn(),
    commit: vi.fn(),
    classifyRule: vi.fn(),
    lisCoverage: vi.fn(),
  },
}))
vi.mock('@/api/partner-config', () => ({
  partnerConfigApi: { get: vi.fn() },
}))
vi.mock('@/pages/import-shared/ImportShared', () => ({
  readGrid: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const mockPreview = vi.mocked(statementImportApi.preview)
const mockCommit = vi.mocked(statementImportApi.commit)
const mockPartnerConfig = vi.mocked(partnerConfigApi.get)
const mockReadGrid = vi.mocked(readGrid)

const grid = [
  ['客户：测试医院'],
  ['病理号', '项目名称', '结算金额'],
  ['CASE-1', '手术标本检查与诊断', 100],
]

const preview: PreviewResult = {
  partnerId: 'P-1',
  configVersion: 1,
  template: 'case_detail',
  serviceMonth: '2026-05',
  declaredTotal: 100,
  revenue: {
    labRevenue: 100,
    diagnosisSettle: 0,
    outSettle: 0,
    unmatchedSettle: 0,
    ambiguousSettle: 0,
    totalSettle: 100,
    splitLisExpected: 0,
    splitLisMissing: 0,
    byLine: [],
    counts: { total: 1, in: 1, out: 0, split: 0, diagnosis: 0, unmatched: 0, ambiguous: 0 },
  },
  score: {
    recognition: { total: 1, matched: 1, unmatched: 0, ambiguous: 0, rate: 1, pass: true },
    closure: { declaredTotal: 100, computed: 100, diff: 0, pass: true },
    caseMatch: {
      forward: { withCaseNo: 1, matched: 1, rate: 1, pass: true },
      backward: { lisInPeriod: 1, missingFromStatement: 0, missingCaseNos: [], pass: true },
    },
    golden: { expected: null, computed: 100, diff: null, pass: null },
    status: 'ready',
    failures: [],
  },
  needsAttention: [],
}

const committed: CommitResult = {
  partnerId: 'P-1',
  serviceMonth: '2026-05',
  configVersion: 1,
  importBatch: 'STMT-1',
  caseCount: 1,
  labRevenue: 100,
  diagnosisSettle: 0,
  outSettle: 0,
  unmatchedSettle: 0,
  ambiguousSettle: 0,
  skippedNoCase: 0,
  splitLisExpected: 0,
  splitLisMissing: 0,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function setupQueue() {
  const { result } = renderHook(() => useImportQueue([{ id: 'P-1', name: '测试医院' } as never]))
  await act(async () => {
    await result.current.addFiles([new File(['fixture'], '测试医院-2026年5月.xlsx')])
  })
  await waitFor(() => expect(result.current.active).not.toBeNull())
  return result
}

async function runCommit(action: () => Promise<CommitOutcome>) {
  let outcome: CommitOutcome = 'err'
  await act(async () => { outcome = await action() })
  return outcome
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReadGrid.mockResolvedValue(grid)
  mockPartnerConfig.mockResolvedValue({ config: { lines: [] }, version: 1 } as never)
  mockPreview.mockResolvedValue(preview)
})

describe('useImportQueue — NEEDS_CONFIRM 旁路合同', () => {
  it('只有 NEEDS_CONFIRM 返回确认态；其他 409 必须失败关闭', async () => {
    const result = await setupQueue()
    const item = result.current.active!
    mockCommit.mockRejectedValueOnce({
      response: { status: 409, data: { error: { code: 'NEEDS_CONFIRM', message: '需人工确认' } } },
    })

    expect(await runCommit(() => result.current.commit(item, false))).toEqual({
      kind: 'confirm',
      itemId: item.id,
      partnerId: 'P-1',
      serviceMonth: '2026-05',
      message: '需人工确认',
    })

    mockCommit.mockRejectedValueOnce({
      response: { status: 409, data: { error: { code: 'CONFLICT', message: '配置版本冲突' } } },
    })
    expect(await runCommit(() => result.current.commit(item, false))).toBe('err')
    await waitFor(() => expect(result.current.active?.error).toBe('配置版本冲突'))
  })

  it('非 409 即使伪装成 NEEDS_CONFIRM 也不可进入确认旁路', async () => {
    const result = await setupQueue()
    const item = result.current.active!
    mockCommit.mockRejectedValueOnce({
      response: { status: 400, data: { error: { code: 'NEEDS_CONFIRM', message: '错误状态码' } } },
    })

    expect(await runCommit(() => result.current.commit(item, false))).toBe('err')
    await waitFor(() => expect(result.current.active?.status).toBe('error'))
  })

  it('确认旁路拒绝空理由，并把非空理由与 confirm:true 绑定到同一请求', async () => {
    const result = await setupQueue()
    const item = result.current.active!

    expect(await runCommit(() => result.current.commit(item, true, '   '))).toBe('err')
    expect(mockCommit).not.toHaveBeenCalled()

    mockCommit.mockResolvedValueOnce(committed)
    expect(await runCommit(() => result.current.commit(item, true, '  无独立合计行，财务已逐行复核  '))).toBe('ok')
    expect(mockCommit).toHaveBeenCalledWith({
      partnerId: 'P-1',
      grid,
      serviceMonth: '2026-05',
      confirm: true,
      overrideReason: '无独立合计行，财务已逐行复核',
    })
  })

  it('旧月份的延迟成功响应不得把已入库状态贴到新月份', async () => {
    const result = await setupQueue()
    const item = result.current.active!
    const pending = deferred<CommitResult>()
    mockCommit.mockReturnValueOnce(pending.promise)

    let commitPromise!: Promise<CommitOutcome>
    await act(async () => {
      commitPromise = result.current.commit(item, false)
      await Promise.resolve()
    })
    await act(async () => { await result.current.setMonth(item.id, '2026-06') })
    await act(async () => { pending.resolve(committed); await commitPromise })

    expect(result.current.active?.month).toBe('2026-06')
    expect(result.current.active?.committed).toBeNull()
    expect(result.current.active?.status).not.toBe('committed')
  })

  it('旧月份的延迟 NEEDS_CONFIRM 不得在新月份生成确认入口或错误态', async () => {
    const result = await setupQueue()
    const item = result.current.active!
    const pending = deferred<CommitResult>()
    mockCommit.mockReturnValueOnce(pending.promise)

    let commitPromise!: Promise<CommitOutcome>
    await act(async () => {
      commitPromise = result.current.commit(item, false)
      await Promise.resolve()
    })
    await act(async () => { await result.current.setMonth(item.id, '2026-06') })
    let outcome: CommitOutcome = 'ok'
    await act(async () => {
      pending.reject({ response: { status: 409, data: { error: { code: 'NEEDS_CONFIRM', message: '旧月门禁' } } } })
      outcome = await commitPromise
    })

    expect(outcome).toBe('err')
    expect(result.current.active?.month).toBe('2026-06')
    expect(result.current.active?.error).toBe('')
    expect(result.current.active?.status).toBe('ready')
  })

  it('旧医院的延迟配置响应不得覆盖新医院的归类候选或清掉新预览', async () => {
    const result = await setupQueue()
    const item = result.current.active!
    const oldConfig = deferred<never>()
    mockPartnerConfig
      .mockReturnValueOnce(oldConfig.promise)
      .mockResolvedValueOnce({ config: { lines: [{ key: 'NEW-LINE' }] }, version: 3 } as never)

    let oldSwitch!: Promise<void>
    await act(async () => {
      oldSwitch = result.current.setPartner(item.id, 'P-OLD')
      await Promise.resolve()
    })
    await act(async () => { await result.current.setPartner(item.id, 'P-NEW') })
    await act(async () => {
      oldConfig.resolve({ config: { lines: [{ key: 'OLD-LINE' }] }, version: 2 } as never)
      await oldSwitch
    })

    expect(result.current.active?.partnerId).toBe('P-NEW')
    expect(result.current.active?.lines).toEqual([{ key: 'NEW-LINE' }])
    expect(result.current.active?.preview).not.toBeNull()
    expect(result.current.active?.status).toBe('ready')
  })

  it('同医院 A-B-A 往返时较早的 A 配置响应不得覆盖较新的 A', async () => {
    const result = await setupQueue()
    const item = result.current.active!
    const oldA = deferred<Awaited<ReturnType<typeof partnerConfigApi.get>>>()
    mockPartnerConfig
      .mockReturnValueOnce(oldA.promise)
      .mockResolvedValueOnce({ config: { lines: [{ key: 'B-LINE' }] }, version: 2 } as never)
      .mockResolvedValueOnce({ config: { lines: [{ key: 'NEW-A-LINE' }] }, version: 3 } as never)

    let firstA!: Promise<void>
    await act(async () => {
      firstA = result.current.setPartner(item.id, 'P-A')
      await Promise.resolve()
    })
    await act(async () => { await result.current.setPartner(item.id, 'P-B') })
    await act(async () => { await result.current.setPartner(item.id, 'P-A') })
    await act(async () => {
      oldA.resolve({ config: { lines: [{ key: 'OLD-A-LINE' }] }, version: 1 } as never)
      await firstA
    })

    expect(result.current.active?.partnerId).toBe('P-A')
    expect(result.current.active?.lines).toEqual([{ key: 'NEW-A-LINE' }])
  })

  it('同医院同月份的较早预览后返回时不得覆盖较新的预览', async () => {
    const result = await setupQueue()
    const item = result.current.active!
    const oldPreview = deferred<PreviewResult>()
    mockPreview
      .mockReturnValueOnce(oldPreview.promise)
      .mockResolvedValueOnce({ ...preview, configVersion: 3 })

    let firstPreview!: Promise<void>
    await act(async () => {
      firstPreview = result.current.runPreview(item)
      await Promise.resolve()
    })
    await act(async () => { await result.current.runPreview(result.current.active!) })
    await act(async () => {
      oldPreview.resolve({ ...preview, configVersion: 2 })
      await firstPreview
    })

    expect(result.current.active?.configVersion).toBe(3)
  })
})
