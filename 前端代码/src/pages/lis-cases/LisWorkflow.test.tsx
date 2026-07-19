import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lisCasesApi } from '@/api/lis-cases'
import { canAccess } from '@/lib/permissions'
import LisCasesPage from './LisCasesPage'

const mocks = vi.hoisted(() => ({
  readGrid: vi.fn(),
}))

vi.mock('@/api/lis-cases', () => ({
  lisCasesApi: {
    list: vi.fn(),
    preview: vi.fn(),
    import: vi.fn(),
    importMarkers: vi.fn(),
    batches: vi.fn(),
    markers: vi.fn(),
    setSpecimen: vi.fn(),
  },
}))

vi.mock('@/lib/permissions', () => ({
  canAccess: vi.fn(),
}))

vi.mock('@/pages/import-shared/ImportShared', () => ({
  useHospitals: () => ({ hospitals: [{ id: 'P-1', name: '测试医院' }] }),
  readGrid: mocks.readGrid,
  inputCls: 'input',
  btnCls: 'button-secondary',
  btnPri: 'button-primary',
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const emptyPage = { list: [], page: 1, pageSize: 20, total: 0 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readGrid.mockReset()
  vi.mocked(canAccess).mockReturnValue(true)
  vi.mocked(lisCasesApi.list).mockResolvedValue(emptyPage)
  vi.mocked(lisCasesApi.batches).mockResolvedValue([])
  vi.mocked(lisCasesApi.markers).mockResolvedValue([])
})

describe('LIS workflow truth and recovery', () => {
  it('renders a failed list load as unknown instead of a verified empty list', async () => {
    vi.mocked(lisCasesApi.list).mockRejectedValue(new Error('network unavailable'))

    render(<LisCasesPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('病例列表未加载')
    expect(screen.getByRole('button', { name: '重新加载病例' })).toBeInTheDocument()
    expect(screen.queryByText(/还没有病例/)).not.toBeInTheDocument()
  })

  it('does not expose specimen mutations without reconciliation write capability', async () => {
    vi.mocked(canAccess).mockImplementation((module, level) => module === 'reconciliation' && level === 'R')
    vi.mocked(lisCasesApi.list).mockResolvedValue({
      ...emptyPage,
      total: 1,
      list: [{
        id: 'LC-1', caseNo: 'S26-001', partnerId: 'P-1', partnerName: '测试医院',
        specimenType: 'tissue', specimenTypeSource: 'auto', status: 'normal',
        quantities: { heSlide: 1, block: 1, ihc: 0, specialStain: 0, eber: 0, pdl1: 0 },
        operateTime: '2026-07-18', importBatch: 'LIS-1',
      }],
    })

    render(<LisCasesPage />)

    const open = await screen.findByRole('button', { name: '查看病例 S26-001' })
    expect(screen.queryByRole('combobox', { name: '修改 S26-001 的样本类型' })).not.toBeInTheDocument()
    expect(within(open.closest('tr')!).getByText('组织')).toBeInTheDocument()
  })

  it('does not open an ambiguous detail when the partner mapping is missing', async () => {
    vi.mocked(lisCasesApi.list).mockResolvedValue({
      ...emptyPage,
      total: 1,
      list: [{
        id: 'LC-UNMAPPED', caseNo: 'S26-UNMAPPED', partnerId: null, partnerName: null,
        specimenType: null, specimenTypeSource: 'unknown', status: 'normal',
        quantities: { heSlide: 1, block: 1, ihc: 0, specialStain: 0, eber: 0, pdl1: 0 },
        operateTime: null, importBatch: 'LIS-1',
      }],
    })

    render(<LisCasesPage />)

    expect(await screen.findByText('合作方未映射，详情不可核定')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看病例 S26-UNMAPPED' })).not.toBeInTheDocument()
    expect(lisCasesApi.markers).not.toHaveBeenCalled()
  })

  it('separates local validation, server preview, confirmed submit, and partial evidence', async () => {
    mocks.readGrid
      .mockResolvedValueOnce([
        ['病理号', '送检医院', '登记时间', '蜡块数', '患者姓名'],
        ['S26-001', '测试医院', '2026-07-18', 1, '不应上传'],
      ])
      .mockResolvedValueOnce([
        ['病理号', '抗体名'],
        ['S26-001', 'P53'],
      ])
    vi.mocked(lisCasesApi.preview).mockResolvedValue({
      valid: 1,
      skipped: 0,
      hospitalCount: 1,
      newHospitals: [],
      specimenDistribution: { tissue: 1, tissue_complex: 0, cytology: 0 },
      warnings: [],
    })
    vi.mocked(lisCasesApi.import).mockResolvedValue({
      importBatch: 'LIS-1', imported: 0, inserted: 0, updated: 0, skipped: 0,
      partnersCreated: 0, partnersMatched: 1,
      rejectedCrossMonth: 1,
      rejectedCrossMonthSamples: [{ caseNo: 'S26-001', partnerName: '测试医院', existingMonth: '2026-06', incomingMonth: '2026-07' }],
      rejectedInvalidDate: 0,
      rejectedInvalidDateSamples: [],
    } as never)

    render(<LisCasesPage />)
    fireEvent.click(await screen.findByRole('button', { name: '导入 LIS 文件' }))

    const input = screen.getByLabelText('选择 LIS 文件')
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(['case'], '病例.xlsx'), new File(['marker'], '抗体.xlsx')] },
      })
    })

    expect(await screen.findByText('本地校验通过')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '运行服务端预检' }))
    expect(await screen.findByText('服务端预检通过')).toBeInTheDocument()
    expect(lisCasesApi.preview).toHaveBeenCalledWith([
      expect.not.objectContaining({ 患者姓名: expect.anything() }),
    ])

    fireEvent.click(screen.getByRole('button', { name: '确认提交导入' }))
    const dialog = screen.getByRole('dialog', { name: '确认提交 LIS 数据' })
    expect(lisCasesApi.import).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '开始提交' }))

    expect(await screen.findByRole('status', { name: '部分完成' })).toHaveTextContent('1 例跨月冲突已拒收')
    expect(screen.getByText(/抗体清单未提交/)).toBeInTheDocument()
    expect(lisCasesApi.importMarkers).not.toHaveBeenCalled()
    expect(screen.queryByText('导入完成')).not.toBeInTheDocument()
  })

  it('does not label a marker-only file as server-previewed', async () => {
    mocks.readGrid.mockResolvedValue([
      ['病理号', '抗体名'],
      ['S26-MARKER', 'P53'],
    ])

    render(<LisCasesPage />)
    fireEvent.click(await screen.findByRole('button', { name: '导入 LIS 文件' }))
    await act(async () => {
      fireEvent.change(screen.getByLabelText('选择 LIS 文件'), {
        target: { files: [new File(['marker'], '仅抗体.xlsx')] },
      })
    })

    fireEvent.click(await screen.findByRole('button', { name: '确认无病例可预检' }))

    expect(await screen.findByRole('status', { name: '病例预检不适用' })).toHaveTextContent('抗体清单尚未验证病理号到医院的映射')
    expect(lisCasesApi.preview).not.toHaveBeenCalled()
    expect(screen.queryByText('服务端预检通过')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认提交导入' })).toBeEnabled()
  })

  it('does not echo a rejected case payload in an error message', async () => {
    vi.mocked(lisCasesApi.list).mockRejectedValue(new Error('{"patientName":"不应回显","caseNo":"S26-SECRET"}'))

    render(<LisCasesPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('病例列表加载失败')
    expect(screen.queryByText(/不应回显|S26-SECRET/)).not.toBeInTheDocument()
  })

  it('discards an older list response after a newer filter request completes', async () => {
    let resolveOld!: (value: typeof emptyPage) => void
    const oldRequest = new Promise<typeof emptyPage>((resolve) => { resolveOld = resolve })
    vi.mocked(lisCasesApi.list)
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce({
        ...emptyPage,
        total: 1,
        list: [{
          id: 'NEW', caseNo: 'NEW-CASE', partnerId: 'P-1', partnerName: '测试医院',
          specimenType: 'tissue', specimenTypeSource: 'auto', status: 'normal',
          quantities: { heSlide: 1, block: 1, ihc: 0, specialStain: 0, eber: 0, pdl1: 0 },
          operateTime: null, importBatch: null,
        }],
      })

    render(<LisCasesPage />)
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索病理号' }), { target: { value: 'NEW' } })
    expect(await screen.findByText('NEW-CASE')).toBeInTheDocument()

    await act(async () => {
      resolveOld({
        ...emptyPage,
        total: 1,
        list: [{
          id: 'OLD', caseNo: 'OLD-CASE', partnerId: 'P-1', partnerName: '测试医院',
          specimenType: 'tissue', specimenTypeSource: 'auto', status: 'normal',
          quantities: { heSlide: 1, block: 1, ihc: 0, specialStain: 0, eber: 0, pdl1: 0 },
          operateTime: null, importBatch: null,
        }],
      })
    })

    await waitFor(() => expect(screen.queryByText('OLD-CASE')).not.toBeInTheDocument())
    expect(screen.getByText('NEW-CASE')).toBeInTheDocument()
  })

  it('keeps a marker request failure distinct from a verified empty marker list', async () => {
    const record = {
      id: 'LC-DETAIL', caseNo: 'S26-DETAIL', partnerId: 'P-1', partnerName: '测试医院',
      specimenType: 'tissue', specimenTypeSource: 'auto', status: 'normal',
      quantities: { heSlide: 1, block: 1, ihc: 0, specialStain: 0, eber: 0, pdl1: 0 },
      operateTime: null, importBatch: null,
    }
    vi.mocked(lisCasesApi.list).mockResolvedValue({ ...emptyPage, list: [record], total: 1 })
    vi.mocked(lisCasesApi.markers).mockRejectedValue(new Error('marker network unavailable'))

    render(<LisCasesPage />)
    fireEvent.click(await screen.findByRole('button', { name: '查看病例 S26-DETAIL' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('抗体清单未加载')
    expect(screen.getByText(/不能按“没有抗体”处理/)).toBeInTheDocument()
    expect(screen.queryByText(/已成功查询；当前没有匹配/)).not.toBeInTheDocument()
  })

  it('locks duplicate confirmed submits before React can rerender the button', async () => {
    mocks.readGrid.mockResolvedValue([
      ['病理号', '送检医院', '登记时间', '蜡块数'],
      ['S26-LOCK', '测试医院', '2026-07-18', 1],
    ])
    vi.mocked(lisCasesApi.preview).mockResolvedValue({
      valid: 1, skipped: 0, hospitalCount: 1, newHospitals: [],
      specimenDistribution: { tissue: 1, tissue_complex: 0, cytology: 0 }, warnings: [],
    })
    const pending = deferred<{ importBatch: string; imported: number; inserted: number; updated: number; skipped: number; partnersCreated: number; partnersMatched: number }>()
    vi.mocked(lisCasesApi.import).mockReturnValue(pending.promise)

    render(<LisCasesPage />)
    fireEvent.click(await screen.findByRole('button', { name: '导入 LIS 文件' }))
    await act(async () => {
      fireEvent.change(screen.getByLabelText('选择 LIS 文件'), { target: { files: [new File(['case'], '单例.xlsx')] } })
    })
    fireEvent.click(await screen.findByRole('button', { name: '运行服务端预检' }))
    await screen.findByText('服务端预检通过')
    fireEvent.click(screen.getByRole('button', { name: '确认提交导入' }))
    const submit = within(screen.getByRole('dialog', { name: '确认提交 LIS 数据' })).getByRole('button', { name: '开始提交' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(lisCasesApi.import).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ importBatch: 'LIS-LOCK', imported: 1, inserted: 1, updated: 0, skipped: 0, partnersCreated: 0, partnersMatched: 1 }))
    expect(await screen.findByRole('status', { name: '全部完成' })).toBeInTheDocument()
  })

  it('reports processing as unknown when a later case chunk loses its response', async () => {
    const rows = Array.from({ length: 151 }, (_, index) => [`S26-${String(index).padStart(3, '0')}`, '测试医院', '2026-07-18', 1])
    mocks.readGrid.mockResolvedValue([['病理号', '送检医院', '登记时间', '蜡块数'], ...rows])
    vi.mocked(lisCasesApi.preview).mockImplementation(async (cases) => ({
      valid: cases.length, skipped: 0, hospitalCount: 1, newHospitals: [],
      specimenDistribution: { tissue: cases.length, tissue_complex: 0, cytology: 0 }, warnings: [],
    }))
    vi.mocked(lisCasesApi.import)
      .mockResolvedValueOnce({ importBatch: 'LIS-1', imported: 150, inserted: 150, updated: 0, skipped: 0, partnersCreated: 0, partnersMatched: 1 })
      .mockRejectedValueOnce(new Error('response lost'))

    render(<LisCasesPage />)
    fireEvent.click(await screen.findByRole('button', { name: '导入 LIS 文件' }))
    await act(async () => {
      fireEvent.change(screen.getByLabelText('选择 LIS 文件'), { target: { files: [new File(['case'], '151例.xlsx')] } })
    })
    fireEvent.click(await screen.findByRole('button', { name: '运行服务端预检' }))
    await screen.findByText('服务端预检通过')
    fireEvent.click(screen.getByRole('button', { name: '确认提交导入' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认提交 LIS 数据' })).getByRole('button', { name: '开始提交' }))

    const unknown = await screen.findByRole('status', { name: '处理结果未知' })
    expect(unknown).toHaveTextContent('病例已确认写入 150 例')
    expect(unknown).toHaveTextContent('成功回执 1 批')
    expect(screen.queryByText('全部完成')).not.toBeInTheDocument()
  })
})
