import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accountReconcileApi } from '@/api/account-reconcile'
import type { OverviewResp } from '@/types/account-reconcile'
import { useAccountReconcile } from './useAccountReconcile'

vi.mock('@/api/account-reconcile', () => ({
  accountReconcileApi: {
    overview: vi.fn(),
    compute: vi.fn(),
    close: vi.fn(),
  },
}))
vi.mock('@/api/partner-config', () => ({
  partnerConfigApi: { partners: vi.fn() },
}))
vi.mock('@/lib/permissions', () => ({ canAccess: vi.fn(() => true) }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const mockOverview = vi.mocked(accountReconcileApi.overview)
const mockCompute = vi.mocked(accountReconcileApi.compute)
const mockClose = vi.mocked(accountReconcileApi.close)
const initialMonth = new Date().toISOString().slice(0, 7)
const otherMonth = initialMonth === '2026-06' ? '2026-05' : '2026-06'

function overview(serviceMonth: string, partnerId: string): OverviewResp {
  return {
    list: [{
      id: `${partnerId}:${serviceMonth}`,
      partnerId,
      partnerName: `${partnerId}医院`,
      serviceMonth,
      status: '复核完成',
      matchRate: 1,
      matchStatus: '正常',
      statementReady: true,
      lisReady: true,
      diffCount: 0,
      pendingCount: 0,
      unmatchedCount: 0,
      confirmedLabRevenue: 100,
    }],
    board: { total: 1, 待复核: 0, 复核完成: 1, 已关账: 0, 补收实收: 0, 确认实收: 100 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockOverview.mockReset()
  mockCompute.mockReset()
  mockClose.mockReset()
  mockCompute.mockResolvedValue({
    hospitalMonthId: 'HM-1',
    matchRate: 1,
    matchStatus: '正常',
    diffCount: 0,
    pendingCount: 0,
    unmatchedCount: 0,
    statementReady: true,
    lisReady: true,
  })
  mockClose.mockResolvedValue({ serviceMonth: initialMonth, closed: ['OLD'], skipped: [] })
})

describe('useAccountReconcile — 月份快照与 fail-closed', () => {
  it('切月同步清空旧可写快照；新月加载中所有写入口关闭', async () => {
    const nextLoad = deferred<OverviewResp>()
    mockOverview.mockResolvedValueOnce(overview(initialMonth, 'OLD')).mockReturnValueOnce(nextLoad.promise)
    const { result } = renderHook(() => useAccountReconcile())
    await waitFor(() => expect(result.current.list[0]?.partnerId).toBe('OLD'))

    act(() => result.current.openWorkbench('OLD', '旧医院'))
    expect(result.current.selected?.partnerId).toBe('OLD')

    act(() => result.current.setMonth(otherMonth))

    expect(result.current.month).toBe(otherMonth)
    expect(result.current.list).toEqual([])
    expect(result.current.board).toBeNull()
    expect(result.current.loadedMonth).toBeNull()
    expect(result.current.selected).toBeNull()
    expect(result.current.loading).toBe(true)
    expect(result.current.writeReady).toBe(false)

    await act(async () => { await result.current.computePartner('OLD') })
    await act(async () => { await result.current.recomputeAll() })
    await act(async () => {
      await result.current.closeMonth({ serviceMonth: initialMonth, partnerIds: ['OLD'] })
    })
    expect(mockCompute).not.toHaveBeenCalled()
    expect(mockClose).not.toHaveBeenCalled()
  })

  it('从工作台切回总览重新加载时立即丢弃旧医院选择，失败后不可返入旧工作台', async () => {
    mockOverview.mockResolvedValueOnce(overview(initialMonth, 'OLD')).mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useAccountReconcile())
    await waitFor(() => expect(result.current.loadedMonth).toBe(initialMonth))

    act(() => result.current.openWorkbench('OLD', '旧医院'))
    expect(result.current.selected?.partnerId).toBe('OLD')
    act(() => result.current.setTab('overview'))

    await waitFor(() => expect(result.current.loadError).toBe(true))
    expect(result.current.selected).toBeNull()
  })

  it('新月加载失败保持空快照并继续禁止写入', async () => {
    mockOverview.mockResolvedValueOnce(overview(initialMonth, 'OLD')).mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useAccountReconcile())
    await waitFor(() => expect(result.current.list[0]?.partnerId).toBe('OLD'))

    act(() => result.current.setMonth(otherMonth))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.list).toEqual([])
    expect(result.current.board).toBeNull()
    expect(result.current.loadedMonth).toBeNull()
    expect(result.current.loadError).toBe(true)
    expect(result.current.writeReady).toBe(false)
    await act(async () => { await result.current.computePartner('OLD') })
    expect(mockCompute).not.toHaveBeenCalled()
  })

  it('旧请求先返回时不得发布旧月，也不得提前解除新月 loading', async () => {
    const oldLoad = deferred<OverviewResp>()
    const newLoad = deferred<OverviewResp>()
    mockOverview.mockImplementation((month) => month === initialMonth ? oldLoad.promise : newLoad.promise)
    const { result } = renderHook(() => useAccountReconcile())
    await waitFor(() => expect(mockOverview).toHaveBeenCalledWith(initialMonth))

    act(() => result.current.setMonth(otherMonth))
    await waitFor(() => expect(mockOverview).toHaveBeenCalledWith(otherMonth))
    await act(async () => { oldLoad.resolve(overview(initialMonth, 'OLD')); await oldLoad.promise })

    expect(result.current.list).toEqual([])
    expect(result.current.loadedMonth).toBeNull()
    expect(result.current.loading).toBe(true)

    await act(async () => { newLoad.resolve(overview(otherMonth, 'NEW')); await newLoad.promise })
    await waitFor(() => expect(result.current.loadedMonth).toBe(otherMonth))
    expect(result.current.list[0]?.partnerId).toBe('NEW')
  })

  it('旧请求后返回时也不得覆盖已发布的新月快照', async () => {
    const oldLoad = deferred<OverviewResp>()
    const newLoad = deferred<OverviewResp>()
    mockOverview.mockImplementation((month) => month === initialMonth ? oldLoad.promise : newLoad.promise)
    const { result } = renderHook(() => useAccountReconcile())
    await waitFor(() => expect(mockOverview).toHaveBeenCalledWith(initialMonth))
    act(() => result.current.setMonth(otherMonth))
    await waitFor(() => expect(mockOverview).toHaveBeenCalledWith(otherMonth))

    await act(async () => { newLoad.resolve(overview(otherMonth, 'NEW')); await newLoad.promise })
    await waitFor(() => expect(result.current.list[0]?.partnerId).toBe('NEW'))
    await act(async () => { oldLoad.resolve(overview(initialMonth, 'OLD')); await oldLoad.promise })

    expect(result.current.loadedMonth).toBe(otherMonth)
    expect(result.current.list[0]?.partnerId).toBe('NEW')
  })

  it('关账请求必须显式绑定当前已加载月份，月份不一致时拒绝调用 API', async () => {
    mockOverview.mockResolvedValue(overview(initialMonth, 'CURRENT'))
    const { result } = renderHook(() => useAccountReconcile())
    await waitFor(() => expect(result.current.writeReady).toBe(true))

    await act(async () => {
      await result.current.closeMonth({ serviceMonth: otherMonth, partnerIds: ['CURRENT'] })
    })
    expect(mockClose).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.closeMonth({ serviceMonth: initialMonth, partnerIds: ['CURRENT'] })
    })
    expect(mockClose).toHaveBeenCalledWith(initialMonth, ['CURRENT'])
  })
})
