import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectCostTable } from './components/ProjectCostTable'
import { MaterialCostTable } from './components/MaterialCostTable'
import { CostExportModal } from './components/CostExportModal'
import { CostDetailModal } from './components/CostDetailModal'
import { CostStatsCards } from './components/CostStatsCards'
import { PublicCostPanel } from './components/PublicCostPanel'
import { SupplierCostTable } from './components/SupplierCostTable'
import { useCostAnalysisPage } from './hooks/useCostAnalysisPage'

const mocks = vi.hoisted(() => ({
  requestGet: vi.fn(),
  downloadTextFile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/api/request', () => ({
  default: { get: mocks.requestGet },
}))

vi.mock('@/lib/utils', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/utils')>()
  return { ...original, downloadTextFile: mocks.downloadTextFile }
})

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

const projectRows = [
  {
    id: 'project-1',
    name: '=项目A',
    category: 'he',
    sampleCount: 2,
    unitCost: 25,
    totalCost: 50,
    ratio: 50,
    changeRate: undefined,
    sampleCountSource: 'lis',
  },
]

const materialRows = [
  {
    id: 'material-1',
    name: '\t=物料A',
    spec: '\r@危险规格',
    consumption: 2,
    consumptionUnit: '盒',
    totalCost: 50,
    ratio: 50,
    changeRate: undefined,
  },
]

const projectProps = {
  loading: false,
  data: projectRows as any,
  total: 1,
  page: 1,
  pageSize: 10,
  searchText: '',
  projectFilter: '',
  dataSource: 'all' as const,
  onSearchTextChange: vi.fn(),
  onProjectFilterChange: vi.fn(),
  onDataSourceChange: vi.fn(),
  onPageChange: vi.fn(),
  onPageSizeChange: vi.fn(),
  onOpenDetail: vi.fn(),
}

const materialProps = {
  loading: false,
  data: materialRows as any,
  total: 1,
  page: 1,
  pageSize: 10,
  searchText: '',
  onSearchTextChange: vi.fn(),
  onPageChange: vi.fn(),
  onPageSizeChange: vi.fn(),
}

function reportResponse(url: string, projects = projectRows) {
    if (url === '/reports/cost-by-project') {
      return {
        summary: { totalCost: 50, projectCost: 50, publicCost: 0, totalSamples: 2 },
        projects,
      }
    }
    if (url === '/reports/cost-by-material') return { materials: materialRows, trend: [] }
    if (url === '/reports/cost-by-supplier') return { suppliers: [] }
    if (url === '/reports/cost-trend') return { trend: [] }
    throw new Error(`unexpected request: ${url}`)
}

function mockReportRequests(projects = projectRows) {
  mocks.requestGet.mockImplementation((url: string) => {
    try {
      return Promise.resolve(reportResponse(url, projects))
    } catch (caught) {
      return Promise.reject(caught)
    }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('cost report truth boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('displays backend percentages once and renders missing values as not computable', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('missing financial data must never use randomness')
    })

    render(<ProjectCostTable {...projectProps} />)
    expect(screen.getByText('50.0%')).toBeInTheDocument()
    expect(screen.queryByText('5000.0%')).not.toBeInTheDocument()
    expect(screen.getByText('不可计算')).toBeInTheDocument()
    expect(random).not.toHaveBeenCalled()

    cleanup()
    render(<MaterialCostTable {...materialProps} />)
    expect(screen.getByText('50.0%')).toBeInTheDocument()
    expect(screen.queryByText('5000.0%')).not.toBeInTheDocument()
    expect(screen.getByText('不可计算')).toBeInTheDocument()
    expect(random).not.toHaveBeenCalled()
  })

  it('does not coerce a missing percentage to zero', () => {
    render(<MaterialCostTable {...materialProps} data={[{ ...materialRows[0], ratio: undefined }] as any} />)
    expect(screen.getAllByText('不可计算')).toHaveLength(2)
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument()
    expect(screen.queryByText('NaN%')).not.toBeInTheDocument()
  })

  it('keeps real zero distinct from unavailable values', () => {
    render(
      <MaterialCostTable
        {...materialProps}
        data={[{ ...materialRows[0], ratio: 0, changeRate: 0 }] as any}
      />,
    )
    expect(screen.getByText('0.0%')).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText('不可计算')).not.toBeInTheDocument()
  })

  it('does not coerce an unavailable project denominator to zero', () => {
    render(
      <ProjectCostTable
        {...projectProps}
        data={[{
          ...projectRows[0],
          sampleCount: 0,
          sampleCountSource: undefined,
          unitCost: 0,
        }] as any}
      />,
    )
    expect(screen.getAllByText('不可计算')).toHaveLength(3)
  })

  it('offers only the implemented CSV export and exposes busy state', () => {
    const onExport = vi.fn()
    const { rerender } = render(
      <CostExportModal open onClose={vi.fn()} onExport={onExport} exporting={false} dataReady />,
    )

    expect(screen.getByRole('dialog', { name: '导出成本分析报告' })).toBeInTheDocument()
    expect(screen.getByText('CSV 文件')).toBeInTheDocument()
    expect(screen.queryByText(/PDF|Excel|Word/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '生成并下载 CSV' }))
    expect(onExport).toHaveBeenCalledTimes(1)

    rerender(<CostExportModal open onClose={vi.fn()} onExport={onExport} exporting dataReady />)
    expect(screen.getByRole('button', { name: '正在生成文件…' })).toBeDisabled()

    rerender(<CostExportModal open onClose={vi.fn()} onExport={onExport} exporting={false} dataReady={false} />)
    expect(screen.getByRole('button', { name: '等待筛选结果…' })).toBeDisabled()
  })

  it('sends period, sample source and project category to verified report requests', async () => {
    mockReportRequests()
    const { result } = renderHook(() => useCostAnalysisPage())

    await waitFor(() => expect(mocks.requestGet).toHaveBeenCalledTimes(4))
    expect(mocks.requestGet).toHaveBeenCalledWith('/reports/cost-by-project', {
      params: {
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        dataSource: 'all',
      },
    })
    for (const endpoint of [
      '/reports/cost-by-material',
      '/reports/cost-by-supplier',
      '/reports/cost-trend',
    ]) {
      expect(mocks.requestGet).toHaveBeenCalledWith(endpoint, {
        params: { startDate: '2024-01-01', endDate: '2024-12-31' },
      })
    }

    mocks.requestGet.mockClear()
    act(() => {
      result.current.setDataSource('manual')
      result.current.setProjectFilter('ihc')
    })

    await waitFor(() => {
      expect(mocks.requestGet).toHaveBeenCalledWith('/reports/cost-by-project', {
        params: {
          startDate: '2024-01-01',
          endDate: '2024-12-31',
          dataSource: 'manual',
          projectType: 'ihc',
        },
      })
    })
  })

  it('reports export success only after a real non-empty file is generated', async () => {
    mockReportRequests()
    const { result } = renderHook(() => useCostAnalysisPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setExportModalOpen(true))
    await act(async () => result.current.handleExport())

    expect(mocks.downloadTextFile).toHaveBeenCalledTimes(1)
    const [filename, content, mimeType] = mocks.downloadTextFile.mock.calls[0]
    expect(filename).toMatch(/^成本分析_2024-01-01_2024-12-31\.csv$/)
    expect(content).toContain('项目A')
    expect(content).toContain('"\'=项目A"')
    expect(content).toContain('"\'\t=物料A"')
    expect(content).toContain('"\'\r@危险规格"')
    expect(content).toContain('"50.0%"')
    expect(content.length).toBeGreaterThan(20)
    expect(mimeType).toBe('text/csv;charset=utf-8')
    expect(mocks.downloadTextFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.toastSuccess.mock.invocationCallOrder[0],
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith('文件已生成，下载已开始')
    expect(result.current.exportModalOpen).toBe(false)
  })

  it('exports an unavailable sample denominator as not computable instead of zero', async () => {
    mockReportRequests([{
      ...projectRows[0],
      sampleCount: 0,
      sampleCountSource: undefined,
      unitCost: 0,
    }] as any)
    const { result } = renderHook(() => useCostAnalysisPage())
    await waitFor(() => expect(result.current.reportReady).toBe(true))

    await act(async () => result.current.handleExport())

    const content = mocks.downloadTextFile.mock.calls[0][1] as string
    expect(content).toContain('"不可计算","不可用","不可计算"')
    expect(content).not.toContain('"0","不可用"')
  })

  it('refuses to export stale rows while a changed filter is still loading', async () => {
    mockReportRequests()
    const { result } = renderHook(() => useCostAnalysisPage())
    await waitFor(() => expect(result.current.reportReady).toBe(true))

    mocks.requestGet.mockImplementation(() => new Promise(() => {}))
    act(() => result.current.setProjectFilter('ihc'))
    expect(result.current.reportReady).toBe(false)

    await act(async () => result.current.handleExport())
    expect(mocks.downloadTextFile).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('筛选结果尚未就绪，无法导出')
  })

  it('does not reveal stale rows after the current filter request fails', async () => {
    mockReportRequests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useCostAnalysisPage())
    await waitFor(() => expect(result.current.reportReady).toBe(true))

    mocks.requestGet.mockRejectedValue(new Error('current filter failed'))
    act(() => result.current.setProjectFilter('ihc'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.reportReady).toBe(false)
    expect(result.current.projectReport).toBeNull()
    expect(result.current.materialReport).toBeNull()
    expect(result.current.supplierReport).toBeNull()
    expect(result.current.trendReport).toBeNull()
    expect(result.current.loadError).toBe('成本报表加载失败，请重试')
    expect(mocks.toastError).toHaveBeenCalledWith('成本报表加载失败，请重试')
  })

  it('ignores an older filter response that arrives after the latest response', async () => {
    const oldRequests: Array<{
      url: string
      pending: ReturnType<typeof deferred<any>>
    }> = []
    const latestProjects = [{ ...projectRows[0], name: '最新筛选项目' }]
    let requestCount = 0
    mocks.requestGet.mockImplementation((url: string) => {
      requestCount += 1
      if (requestCount > 4) {
        return Promise.resolve(reportResponse(url, latestProjects))
      }
      const pending = deferred<any>()
      oldRequests.push({ url, pending })
      return pending.promise
    })

    const { result } = renderHook(() => useCostAnalysisPage())
    await waitFor(() => expect(oldRequests).toHaveLength(4))
    act(() => result.current.setProjectFilter('ihc'))
    await waitFor(() => expect(result.current.reportReady).toBe(true))
    expect(result.current.projectReport?.projects[0].name).toBe('最新筛选项目')

    await act(async () => {
      for (const request of oldRequests) {
        request.pending.resolve(reportResponse(request.url, [{ ...projectRows[0], name: '旧筛选项目' }]))
      }
      await Promise.all(oldRequests.map(request => request.pending.promise))
    })

    expect(result.current.projectReport?.projects[0].name).toBe('最新筛选项目')
    expect(result.current.reportReady).toBe(true)
  })

  it('keeps export failure visible and leaves the modal open', async () => {
    mockReportRequests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.downloadTextFile.mockImplementation(() => {
      throw new Error('browser download failed')
    })
    const { result } = renderHook(() => useCostAnalysisPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setExportModalOpen(true))
    await act(async () => result.current.handleExport())

    expect(mocks.toastError).toHaveBeenCalledWith('文件生成失败，请重试')
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(result.current.exportModalOpen).toBe(true)
  })

  it('marks public cost as unconnected instead of presenting the backend placeholder as a verified zero', () => {
    render(
      <CostStatsCards
        stats={{ totalCost: 50, projectCost: 50, publicCost: null, totalSamples: 2, avgCost: 25 }}
        supplierCount={0}
      />,
    )
    const publicCostCard = screen.getByText('公共成本').closest('div.bg-white')
    expect(publicCostCard).toHaveTextContent('未连接')
    expect(publicCostCard).not.toHaveTextContent('¥0.0万')

    cleanup()
    render(<PublicCostPanel />)
    expect(screen.getByText(/接口尚未提供公共成本事实/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps the project detail dialog to fields the active report API actually returns', () => {
    render(<CostDetailModal open project={projectRows[0] as any} onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: /项目成本摘要/ })).toBeInTheDocument()
    expect(screen.getByText('LIS 已映射病例')).toBeInTheDocument()
    expect(screen.queryByText('LIS系统同步')).not.toBeInTheDocument()
    expect(screen.queryByText('2024-01-15 08:00')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/患者姓名/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '导出明细' })).not.toBeInTheDocument()
  })

  it('does not invent supplier relationship status or material charts without a data source', () => {
    render(
      <SupplierCostTable
        data={[{ id: 's-1', name: '供应商一', amount: 50, orderCount: 1, status: 'long-term' }]}
        totalAmount={50}
      />,
    )
    expect(screen.queryByText('长期合作')).not.toBeInTheDocument()

    cleanup()
    render(<MaterialCostTable {...materialProps} />)
    expect(screen.queryByText('分类消耗饼图')).not.toBeInTheDocument()
    expect(screen.queryByText('价格趋势折线图')).not.toBeInTheDocument()
  })
})
