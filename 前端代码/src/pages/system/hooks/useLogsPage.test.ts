import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from '@/api/request'
import { useLogsPage } from './useLogsPage'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  setMultiple: vi.fn(),
  jsonToSheet: vi.fn(() => ({ sheet: true })),
  bookNew: vi.fn(() => ({ workbook: true })),
  appendSheet: vi.fn(),
  writeFile: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('@/api/request', () => ({ default: { get: mocks.get } }))
vi.mock('@/hooks/useUrlParams', () => ({
  useUrlParams: () => ({ getNumber: (_key: string, fallback: number) => fallback, setMultiple: mocks.setMultiple }),
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, warning: mocks.toastWarning },
}))
vi.mock('xlsx', () => ({
  utils: { json_to_sheet: mocks.jsonToSheet, book_new: mocks.bookNew, book_append_sheet: mocks.appendSheet },
  writeFile: mocks.writeFile,
}))

const exportRow = {
  id: 'log-1',
  userId: 'user-alice',
  username: 'alice',
  operation: 'POST inventory',
  actionType: 'create' as const,
  module: 'inventory',
  outcome: null,
  description: '新增库存',
  ip: '127.0.0.1',
  userAgent: 'contract-test',
  createdAt: '2026-07-18T09:00:00.000Z',
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/logs/export') return { rows: [exportRow], total: 1, maxRows: 10000 }
    return { list: [], pagination: { total: 0, page: 1, pageSize: 20 } }
  })
})

describe('useLogsPage evidence contract', () => {
  it('does not label denied or unknown operations as login', async () => {
    const { result } = renderHook(() => useLogsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.getLogType('DENIED POST inventory')).toMatchObject({ value: 'denied', label: '已拒绝' })
    expect(result.current.getLogType('CUSTOM_ACTION inventory')).toMatchObject({ value: 'unknown', label: '未识别' })
    expect(result.current.getLogType('LOGIN', 'denied')).toMatchObject({ value: 'denied', label: '已拒绝' })
    expect(result.current.getModuleLabel('')).toBe('未识别')
  })

  it('exposes a failed list request as an error state instead of only an empty list', async () => {
    mocks.get.mockRejectedValueOnce(new Error('日志服务不可用'))
    const { result } = renderHook(() => useLogsPage())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('日志服务不可用')
  })

  it('sends every visible list filter to the server query', async () => {
    const { result } = renderHook(() => useLogsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setTypeFilter('denied')
      result.current.setModuleFilter('inventory')
      result.current.setUserFilter('alice')
      result.current.setStartDate('2026-07-01')
      result.current.setEndDate('2026-07-18')
    })

    await waitFor(() => {
      expect(vi.mocked(request.get)).toHaveBeenCalledWith('/logs', {
        params: {
          page: 1,
          pageSize: 20,
          type: 'denied',
          module: 'inventory',
          username: 'alice',
          startDate: '2026-07-01',
          endDate: '2026-07-18',
        },
      })
    })
  })

  it('exports the server-filtered evidence through a real file writer', async () => {
    const { result } = renderHook(() => useLogsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setTypeFilter('create')
      result.current.setModuleFilter('inventory')
      result.current.setUserFilter('alice')
      result.current.setStartDate('2026-07-01')
      result.current.setEndDate('2026-07-18')
      result.current.setExportForm({
        startDate: '2026-07-01',
        endDate: '2026-07-18',
        format: 'csv',
        includeBasic: true,
        includeDetail: true,
        includeIP: true,
        includeDiff: false,
      })
    })

    await act(async () => { await result.current.handleExport() })

    expect(vi.mocked(request.get)).toHaveBeenCalledWith('/logs/export', {
      params: expect.objectContaining({
        type: 'create',
        module: 'inventory',
        username: 'alice',
        startDate: '2026-07-01',
        endDate: '2026-07-18',
      }),
    })
    expect(mocks.jsonToSheet).toHaveBeenCalledWith([
      expect.objectContaining({
        操作用户: 'alice',
        操作类型: '新增',
        操作模块: '库存管理',
        操作内容: '新增库存',
        原始动作: 'POST inventory',
        执行结果: '未记录',
        IP地址: '127.0.0.1',
      }),
    ])
    expect(mocks.appendSheet).toHaveBeenCalledWith({ workbook: true }, { sheet: true }, '操作日志')
    expect(mocks.writeFile).toHaveBeenCalledWith(
      { workbook: true },
      expect.stringMatching(/^操作日志_.*\.csv$/),
      expect.objectContaining({ bookType: 'csv' }),
    )
  })
})
