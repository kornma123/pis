/**
 * K3-LOC-020 #178：导入拒收可见 —— LisImportView 直接渲染测试。
 * 覆盖：mixed-success 多 chunk 累计、三类 typed rejection、合法 0 与 unknown 分离、
 * malformed response、拒收时 marker 不消耗被拒号、拒收清单展示与本地导出。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lisCasesApi, parseLisImportResult } from '@/api/lis-cases'
import LisImportView from './LisImportView'

const mocks = vi.hoisted(() => ({
  readGrid: vi.fn(),
}))

vi.mock('@/api/lis-cases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/lis-cases')>()),
  lisCasesApi: {
    list: vi.fn(),
    preview: vi.fn(),
    import: vi.fn(),
    importMarkers: vi.fn(),
    batches: vi.fn(),
    markers: vi.fn(),
    setSpecimen: vi.fn(),
    correct: vi.fn(),
  },
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

const PREVIEW_OK = {
  valid: 1,
  skipped: 0,
  hospitalCount: 1,
  newHospitals: [],
  specimenDistribution: { tissue: 1, tissue_complex: 0, cytology: 0 },
  warnings: [],
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

/** 走通「选文件 → 服务端预检 → 确认提交 → 开始提交」全流程。 */
async function driveSubmit() {
  render(<LisImportView onBack={vi.fn()} onDone={vi.fn()} />)
  await act(async () => {
    fireEvent.change(screen.getByLabelText('选择 LIS 文件'), {
      target: { files: [new File(['case'], '病例.xlsx')] },
    })
  })
  fireEvent.click(await screen.findByRole('button', { name: '运行服务端预检' }))
  await screen.findByText('服务端预检通过')
  fireEvent.click(screen.getByRole('button', { name: '确认提交导入' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '确认提交 LIS 数据' })).getByRole('button', { name: '开始提交' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readGrid.mockReset()
  vi.mocked(lisCasesApi.batches).mockResolvedValue([])
  vi.mocked(lisCasesApi.preview).mockResolvedValue(PREVIEW_OK)
})

describe('#178 导入拒收可见', () => {
  it('mixed-success 多 chunk：拒收项跨 chunk 累计，任一拒收即「部分完成」，不 toast 全部成功', async () => {
    const rows = Array.from({ length: 151 }, (_, i) => [`S26-${String(i).padStart(3, '0')}`, '测试医院', '2026-07-18', 1])
    mocks.readGrid.mockResolvedValue([['病理号', '送检医院', '登记时间', '蜡块数'], ...rows])
    vi.mocked(lisCasesApi.preview).mockImplementation(async (cases) => ({ ...PREVIEW_OK, valid: cases.length }))
    vi.mocked(lisCasesApi.import)
      .mockResolvedValueOnce({
        importBatch: 'LIS-1', imported: 149, inserted: 149, updated: 0, skipped: 0,
        partnersCreated: 0, partnersMatched: 1,
        rejectedCrossMonth: 1, rejectedInvalidDate: 0, rejectedTotal: 1, rejectionsTruncated: false,
        rejections: [{ code: 'CROSS_MONTH_CONFLICT', caseNo: 'S26-010', partnerName: '测试医院', existingMonth: '2026-06', incomingMonth: '2026-07' }],
      } as never)
      .mockResolvedValueOnce({
        importBatch: 'LIS-2', imported: 0, inserted: 0, updated: 0, skipped: 0,
        partnersCreated: 0, partnersMatched: 1,
        rejectedCrossMonth: 0, rejectedInvalidDate: 1, rejectedTotal: 1, rejectionsTruncated: false,
        rejections: [{ code: 'INVALID_OPERATE_TIME', caseNo: 'S26-150', partnerName: '测试医院', value: '2026-02-31' }],
      } as never)
    const { toast } = await import('sonner')

    await driveSubmit()

    const evidence = await screen.findByRole('status', { name: '部分完成' })
    expect(evidence).toHaveTextContent('病例已确认写入 149 例')
    expect(evidence).toHaveTextContent('1 例跨月冲突已拒收')
    expect(evidence).toHaveTextContent('1 例登记日期非法已拒收')
    // 两个 chunk 的拒收项都进入可复核清单
    const list = screen.getByRole('region', { name: '拒收清单' })
    expect(within(list).getByText(/S26-010/)).toBeInTheDocument()
    expect(within(list).getByText(/S26-150/)).toBeInTheDocument()
    expect(within(list).getByText(/S26-010/)).toHaveTextContent('2026-06')
    expect(vi.mocked(toast.warning)).toHaveBeenCalled()
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(screen.queryByRole('status', { name: '全部完成' })).not.toBeInTheDocument()
  })

  it('三类 rejection item（跨月冲突/非法登记时间/shape-invalid）都带类型化标签展示', async () => {
    mocks.readGrid.mockResolvedValue([
      ['病理号', '送检医院', '登记时间', '蜡块数'],
      ['S26-001', '测试医院', '2026-07-18', 1],
    ])
    vi.mocked(lisCasesApi.import).mockResolvedValue({
      importBatch: 'LIS-1', imported: 0, inserted: 0, updated: 0, skipped: 1,
      partnersCreated: 0, partnersMatched: 1,
      rejectedCrossMonth: 1, rejectedInvalidDate: 1, rejectedTotal: 3, rejectionsTruncated: false,
      rejections: [
        { code: 'CROSS_MONTH_CONFLICT', caseNo: 'S26-001', partnerName: '测试医院', existingMonth: '2026-06', incomingMonth: '2026-07' },
        { code: 'INVALID_OPERATE_TIME', caseNo: 'S26-002', partnerName: '测试医院', value: '2026-13-40' },
        { code: 'ROW_SHAPE_INVALID', caseNo: '', partnerName: '缺号医院' },
      ],
    } as never)

    await driveSubmit()

    const list = within(await screen.findByRole('region', { name: '拒收清单' }))
    expect(list.getByText(/S26-001/).textContent).toContain('同号跨月冲突')
    expect(list.getByText(/S26-002/).textContent).toContain('登记时间非法')
    expect(list.getByText(/缺号医院/).textContent).toContain('格式不完整')
    // 计数与条目一致（未截断）：3 条全部可见
    expect(list.getAllByRole('listitem')).toHaveLength(3)
  })

  it('合法零：全部落库且无拒收 → 不显示拒收清单、无导出按钮、toast 成功', async () => {
    mocks.readGrid.mockResolvedValue([
      ['病理号', '送检医院', '登记时间', '蜡块数'],
      ['S26-001', '测试医院', '2026-07-18', 1],
    ])
    vi.mocked(lisCasesApi.import).mockResolvedValue({
      importBatch: 'LIS-1', imported: 1, inserted: 1, updated: 0, skipped: 0,
      partnersCreated: 0, partnersMatched: 1,
      rejectedCrossMonth: 0, rejectedInvalidDate: 0, rejectedTotal: 0, rejectionsTruncated: false,
      rejections: [],
    } as never)
    const { toast } = await import('sonner')

    await driveSubmit()

    expect(await screen.findByRole('status', { name: '全部完成' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '拒收清单' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '导出拒收清单' })).not.toBeInTheDocument()
    expect(vi.mocked(toast.success)).toHaveBeenCalled()
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
  })

  it('malformed response（缺计数字段）→ 处理结果未知，不计入已验证、不显示成功', async () => {
    mocks.readGrid.mockResolvedValue([
      ['病理号', '送检医院', '登记时间', '蜡块数'],
      ['S26-001', '测试医院', '2026-07-18', 1],
    ])
    vi.mocked(lisCasesApi.import).mockImplementation(async () => parseLisImportResult({}))
    const { toast } = await import('sonner')

    await driveSubmit()

    const unknown = await screen.findByRole('status', { name: '处理结果未知' })
    expect(unknown).toHaveTextContent('成功回执 0 批')
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).toHaveBeenCalled()
  })

  it.each([
    ['负数计数', { skipped: -1, rejectedTotal: -1 }],
    ['小数计数', { skipped: 0.5, rejectedTotal: 0.5, rejectionsTruncated: true }],
    ['imported 与 inserted+updated 矛盾', { imported: 2 }],
    ['rejectedTotal 与分类计数矛盾', { rejectedTotal: 2 }],
    ['截断标记与完整条目矛盾', { rejectionsTruncated: true }],
    ['畸形拒收条目', { rejections: [{ code: 'CROSS_MONTH_CONFLICT', caseNo: 'S26-X', partnerName: '医院', existingMonth: '2026-13', incomingMonth: '2026-07' }] }],
    ['拒收 code 与分类计数矛盾', {
      skipped: 1,
      rejectedTotal: 1,
      rejections: [{ code: 'CROSS_MONTH_CONFLICT', caseNo: 'S26-X', partnerName: '医院', existingMonth: '2026-06', incomingMonth: '2026-07' }],
    }],
  ])('%s → 处理结果未知，不发布部分成功', async (_label, override) => {
    mocks.readGrid.mockResolvedValue([
      ['病理号', '送检医院', '登记时间', '蜡块数'],
      ['S26-001', '测试医院', '2026-07-18', 1],
    ])
    vi.mocked(lisCasesApi.import).mockImplementation(async () => parseLisImportResult({
      importBatch: 'LIS-1', imported: 1, inserted: 1, updated: 0, skipped: 0,
      partnersCreated: 0, partnersMatched: 1,
      rejectedCrossMonth: 0, rejectedInvalidDate: 0, rejectedTotal: 0,
      rejectionsTruncated: false, rejections: [], ...override,
    }))

    await driveSubmit()

    expect(await screen.findByRole('status', { name: '处理结果未知' })).toHaveTextContent('成功回执 0 批')
    expect(screen.queryByRole('status', { name: '全部完成' })).not.toBeInTheDocument()
  })

  it('服务端拒收条目被截断时明确标成不完整，并禁止导出为完整清单', async () => {
    mocks.readGrid.mockResolvedValue([
      ['病理号', '送检医院', '登记时间', '蜡块数'],
      ['S26-001', '测试医院', '2026-07-18', 1],
    ])
    vi.mocked(lisCasesApi.import).mockResolvedValue({
      importBatch: 'LIS-1', imported: 0, inserted: 0, updated: 0, skipped: 2,
      partnersCreated: 0, partnersMatched: 1,
      rejectedCrossMonth: 0, rejectedInvalidDate: 0, rejectedTotal: 2,
      rejectionsTruncated: true,
      rejections: [{ code: 'ROW_SHAPE_INVALID', caseNo: '', partnerName: '测试医院' }],
    } as never)

    await driveSubmit()

    const list = await screen.findByRole('region', { name: '拒收清单' })
    expect(list).toHaveTextContent('拒收总数 2')
    expect(list).toHaveTextContent('清单不完整')
    expect(screen.queryByRole('button', { name: '导出拒收清单' })).not.toBeInTheDocument()
  })

  it('拒收时 marker 导入不消耗被拒 caseNo（抗体清单整体停住）', async () => {
    mocks.readGrid
      .mockResolvedValueOnce([
        ['病理号', '送检医院', '登记时间', '蜡块数'],
        ['S26-001', '测试医院', '2026-07-18', 1],
      ])
      .mockResolvedValueOnce([
        ['病理号', '抗体名'],
        ['S26-001', 'P53'],
      ])
    vi.mocked(lisCasesApi.import).mockResolvedValue({
      importBatch: 'LIS-1', imported: 0, inserted: 0, updated: 0, skipped: 0,
      partnersCreated: 0, partnersMatched: 1,
      rejectedCrossMonth: 1, rejectedInvalidDate: 0, rejectedTotal: 1, rejectionsTruncated: false,
      rejections: [{ code: 'CROSS_MONTH_CONFLICT', caseNo: 'S26-001', partnerName: '测试医院', existingMonth: '2026-06', incomingMonth: '2026-07' }],
    } as never)

    render(<LisImportView onBack={vi.fn()} onDone={vi.fn()} />)
    await act(async () => {
      fireEvent.change(screen.getByLabelText('选择 LIS 文件'), {
        target: { files: [new File(['case'], '病例.xlsx'), new File(['marker'], '抗体.xlsx')] },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: '运行服务端预检' }))
    await screen.findByText('服务端预检通过')
    fireEvent.click(screen.getByRole('button', { name: '确认提交导入' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认提交 LIS 数据' })).getByRole('button', { name: '开始提交' }))

    expect(await screen.findByRole('status', { name: '部分完成' })).toHaveTextContent('抗体清单未提交')
    expect(lisCasesApi.importMarkers).not.toHaveBeenCalled()
  })

  it('拒收 code 与分类计数矛盾时网络 parser 拒绝，marker API 不得继续调用', async () => {
    mocks.readGrid
      .mockResolvedValueOnce([
        ['病理号', '送检医院', '登记时间', '蜡块数'],
        ['S26-001', '测试医院', '2026-07-18', 1],
      ])
      .mockResolvedValueOnce([
        ['病理号', '抗体名'],
        ['S26-001', 'P53'],
      ])
    vi.mocked(lisCasesApi.import).mockImplementation(async () => parseLisImportResult({
      importBatch: 'LIS-1', imported: 0, inserted: 0, updated: 0, skipped: 1,
      partnersCreated: 0, partnersMatched: 1,
      rejectedCrossMonth: 0, rejectedInvalidDate: 0, rejectedTotal: 1,
      rejectionsTruncated: false,
      rejections: [{ code: 'CROSS_MONTH_CONFLICT', caseNo: 'S26-001', partnerName: '测试医院', existingMonth: '2026-06', incomingMonth: '2026-07' }],
    }))

    render(<LisImportView onBack={vi.fn()} onDone={vi.fn()} />)
    await act(async () => {
      fireEvent.change(screen.getByLabelText('选择 LIS 文件'), {
        target: { files: [new File(['case'], '病例.xlsx'), new File(['marker'], '抗体.xlsx')] },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: '运行服务端预检' }))
    await screen.findByText('服务端预检通过')
    fireEvent.click(await screen.findByRole('button', { name: '确认提交导入' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认提交 LIS 数据' })).getByRole('button', { name: '开始提交' }))

    expect(await screen.findByRole('status', { name: '处理结果未知' })).toBeInTheDocument()
    expect(lisCasesApi.importMarkers).not.toHaveBeenCalled()
  })

  it('拒收清单可本地导出 CSV（含全部已验证条目，不回显患者信息）', async () => {
    mocks.readGrid.mockResolvedValue([
      ['病理号', '送检医院', '登记时间', '蜡块数'],
      ['S26-001', '测试医院', '2026-07-18', 1],
    ])
    vi.mocked(lisCasesApi.import).mockResolvedValue({
      importBatch: 'LIS-1', imported: 0, inserted: 0, updated: 0, skipped: 0,
      partnersCreated: 0, partnersMatched: 1,
      rejectedCrossMonth: 1, rejectedInvalidDate: 0, rejectedTotal: 1, rejectionsTruncated: false,
      rejections: [{ code: 'CROSS_MONTH_CONFLICT', caseNo: '=2+2', partnerName: '+测试医院,含逗号', existingMonth: '2026-06', incomingMonth: '2026-07' }],
    } as never)
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob
      return 'blob:rejection-csv'
    })
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true, configurable: true })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await driveSubmit()
    await screen.findByRole('status', { name: '部分完成' })

    fireEvent.click(screen.getByRole('button', { name: '导出拒收清单' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0]
    const csv = await blobText(blob)
    expect(csv).toContain("'=2+2")
    expect(csv).toContain('CROSS_MONTH_CONFLICT')
    expect(csv).toContain('2026-06')
    expect(csv).toContain('"\'+测试医院,含逗号"') // 公式中和 + CSV 转义
    expect(csv).toContain('2026-06') // canonical 月份的 '-' 不应被公式中和
    expect(anchorClick).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:rejection-csv')
    anchorClick.mockRestore()
  })

  it('后续 chunk 失联：已验证 chunk 的拒收项仍可见，整体判定 unknown 而非合法零', async () => {
    const rows = Array.from({ length: 151 }, (_, i) => [`S26-${String(i).padStart(3, '0')}`, '测试医院', '2026-07-18', 1])
    mocks.readGrid.mockResolvedValue([['病理号', '送检医院', '登记时间', '蜡块数'], ...rows])
    vi.mocked(lisCasesApi.preview).mockImplementation(async (cases) => ({ ...PREVIEW_OK, valid: cases.length }))
    vi.mocked(lisCasesApi.import)
      .mockResolvedValueOnce({
        importBatch: 'LIS-1', imported: 149, inserted: 149, updated: 0, skipped: 0,
        partnersCreated: 0, partnersMatched: 1,
        rejectedCrossMonth: 1, rejectedInvalidDate: 0, rejectedTotal: 1, rejectionsTruncated: false,
        rejections: [{ code: 'CROSS_MONTH_CONFLICT', caseNo: 'S26-010', partnerName: '测试医院', existingMonth: '2026-06', incomingMonth: '2026-07' }],
      } as never)
      .mockRejectedValueOnce(new Error('response lost'))

    await driveSubmit()

    const unknown = await screen.findByRole('status', { name: '处理结果未知' })
    expect(unknown).toHaveTextContent('成功回执 1 批')
    const list = screen.getByRole('region', { name: '拒收清单' })
    expect(within(list).getByText(/S26-010/)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '全部完成' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('status', { name: '部分完成' })).not.toBeInTheDocument())
  })
})
