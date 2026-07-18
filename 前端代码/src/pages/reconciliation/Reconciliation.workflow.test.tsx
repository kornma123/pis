import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Reconciliation from './Reconciliation'
import { useReconciliationPage } from './hooks/useReconciliationPage'

const mocks = vi.hoisted(() => ({
  requestGet: vi.fn(),
  requestPost: vi.fn(),
  requestPut: vi.fn(),
  downloadTextFile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/api/request', () => ({
  default: { get: mocks.requestGet, post: mocks.requestPost, put: mocks.requestPut },
}))

vi.mock('@/lib/utils', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/utils')>()
  return { ...original, downloadTextFile: mocks.downloadTextFile }
})

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: vi.fn() },
}))

function responseFor(url: string) {
  if (url === '/reconciliation/summary') {
    return { totalCases: 1, linkedOutbounds: 1, unlinkedOutbounds: 0, projectsWithoutBom: 0 }
  }
  if (url === '/reconciliation/projects') {
    return {
      list: [{
        id: 'p-1', code: 'P1', name: '=危险项目', bom_id: 'b-1', type: 'ihc',
        case_count: 1, outbound_count: 1, hasBom: true, boms: [{ id: 'b-1', code: 'B1', name: 'BOM 1' }],
      }],
    }
  }
  if (url === '/reconciliation/materials') {
    return {
      list: [{
        materialId: 'm-1', materialName: '@危险物料', spec: '盒', unit: '盒', projectCount: 1,
        theoryTotal: 1, actualTotal: 0, diff: -1, diffRate: '-100.0', status: 'danger', price: 0,
      }],
    }
  }
  if (url === '/reconciliation/cases') {
    return { list: [], pagination: { total: 0, page: 2, pageSize: 20 } }
  }
  throw new Error(`unexpected request: ${url}`)
}

function mockSuccessfulReads() {
  mocks.requestGet.mockImplementation((url: string) => Promise.resolve(responseFor(url)))
}

describe('reconciliation workflow truth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 6, 18, 9, 0, 0))
    window.history.replaceState(null, '', '/reconciliation')
    localStorage.setItem('user', JSON.stringify({
      username: 'finance-a',
      roles: ['finance'],
      capabilities: { reconciliation: 'W' },
    }))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    localStorage.clear()
  })

  it('binds preset periods to real local date ranges instead of only changing the highlight', async () => {
    mockSuccessfulReads()
    const { result } = renderHook(() => useReconciliationPage())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.startDate).toBe('2026-07-01')
    expect(result.current.endDate).toBe('2026-07-31')

    act(() => result.current.setPeriod('quarter'))
    expect(result.current.startDate).toBe('2026-07-01')
    expect(result.current.endDate).toBe('2026-09-30')
  })

  it('renders a retryable error instead of presenting a failed request as an empty result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.requestGet.mockRejectedValue(new Error('service unavailable'))

    render(<Reconciliation />)

    expect(await screen.findByRole('alert')).toHaveTextContent('数据没能加载')
    expect(screen.queryByText('暂无数据')).not.toBeInTheDocument()
  })

  it('generates a formula-safe CSV only from the successfully loaded period facts', async () => {
    mockSuccessfulReads()
    render(<Reconciliation />)

    const exportButton = await screen.findByRole('button', { name: /导出本期对账 CSV/ })
    await waitFor(() => expect(exportButton).toBeEnabled())
    fireEvent.click(exportButton)

    expect(mocks.downloadTextFile).toHaveBeenCalledTimes(1)
    const [filename, content] = mocks.downloadTextFile.mock.calls[0]
    expect(filename).toContain('2026-07-01_2026-07-31')
    expect(content).toContain("'=危险项目")
    expect(content).toContain("'@危险物料")
    expect(mocks.toastSuccess).toHaveBeenCalledWith('对账 CSV 已生成，下载已开始')
  })

  it('restores period, tab, filters and pagination context from the URL', async () => {
    window.history.replaceState(null, '', '/reconciliation?tab=case&period=custom&startDate=2026-06-01&endDate=2026-06-30&csearch=P26&cproject=p-1&cstatus=normal&cpage=2')
    mockSuccessfulReads()

    const { result } = renderHook(() => useReconciliationPage())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.activeTab).toBe('case')
    expect(result.current.period).toBe('custom')
    expect(result.current.startDate).toBe('2026-06-01')
    expect(result.current.endDate).toBe('2026-06-30')
    expect(result.current.caseSearch).toBe('P26')
    expect(result.current.caseFilterProject).toBe('p-1')
    expect(result.current.caseFilterStatus).toBe('normal')
    expect(result.current.casePagination.page).toBe(2)
    await waitFor(() => expect(mocks.requestGet).toHaveBeenCalledWith('/reconciliation/cases', {
      params: { page: 2, pageSize: 20, search: 'P26', projectId: 'p-1', status: 'normal' },
    }))
  })

  it('exposes tab semantics and hides mutations for a read-only capability', async () => {
    mockSuccessfulReads()
    localStorage.setItem('user', JSON.stringify({
      username: 'viewer', roles: ['finance'], capabilities: { reconciliation: 'R' },
    }))

    render(<Reconciliation />)

    expect(await screen.findByRole('tablist', { name: '消耗对账视图' })).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    await waitFor(() => expect(tabs[1]).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByText(/当前为只读模式/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '导入 LIS 数据' })).not.toBeInTheDocument()
  })
})
