/**
 * K3-LOC-020 #179：登记月带留痕更正 —— LisCaseDetail 直接渲染测试。
 * 覆盖：更正入口权限门控、exact payload（partnerId/caseNo/expected CAS/new/reason/confirm）、
 * 成功后按服务端 truth 刷新、empty reason / 未确认拦截、stale 提示重载、双击锁。
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lisCasesApi } from '@/api/lis-cases'
import { canAccess } from '@/lib/permissions'
import LisCaseDetail from './LisCaseDetail'

vi.mock('@/api/lis-cases', () => ({
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

vi.mock('@/lib/permissions', () => ({
  canAccess: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const RECORD = {
  id: 'LC-1', caseNo: 'S26-001', partnerId: 'P-1', partnerName: '测试医院',
  specimenType: 'tissue', specimenTypeSource: 'auto', status: 'normal',
  quantities: { heSlide: 1, block: 1, ihc: 0, specialStain: 0, eber: 0, pdl1: 0 },
  operateTime: '2026-06-20', importBatch: 'LIS-1',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function renderDetail() {
  render(<LisCaseDetail partnerId="P-1" caseNo="S26-001" onBack={vi.fn()} />)
  await screen.findByText('S26-001')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(canAccess).mockReturnValue(true)
  vi.mocked(lisCasesApi.list).mockResolvedValue({ list: [RECORD], page: 1, pageSize: 20, total: 1 })
  vi.mocked(lisCasesApi.markers).mockResolvedValue([])
})

describe('#179 登记月带留痕更正', () => {
  it('happy path：exact payload（expected=当前登记时间 CAS），成功后按服务端 truth 刷新展示', async () => {
    vi.mocked(lisCasesApi.correct).mockResolvedValue({
      caseNo: 'S26-001', partnerId: 'P-1', oldOperateTime: '2026-06-20', newOperateTime: '2026-07-05', reason: '登记月录错',
    } as never)
    const { toast } = await import('sonner')

    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: '更正登记时间' }))

    const form = screen.getByRole('region', { name: '登记时间更正' })
    expect(within(form).getByText('2026-06-20')).toBeInTheDocument() // 当前值作为 CAS expected 展示
    fireEvent.change(within(form).getByLabelText('新登记时间'), { target: { value: '2026-07-05' } })
    fireEvent.change(within(form).getByLabelText('更正原因'), { target: { value: '登记月录错' } })
    fireEvent.click(within(form).getByRole('checkbox'))
    fireEvent.click(within(form).getByRole('button', { name: '提交更正' }))

    expect(lisCasesApi.correct).toHaveBeenCalledTimes(1)
    expect(lisCasesApi.correct).toHaveBeenCalledWith({
      partnerId: 'P-1',
      caseNo: 'S26-001',
      expectedOperateTime: '2026-06-20',
      newOperateTime: '2026-07-05',
      reason: '登记月录错',
      confirm: true,
    })
    // 展示刷新为服务端返回的 canonical truth，而非本地输入值
    expect(await screen.findByText('2026-07-05')).toBeInTheDocument()
    expect(vi.mocked(toast.success)).toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: '登记时间更正' })).not.toBeInTheDocument()
  })

  it('无 reconciliation W → 不显示更正入口', async () => {
    vi.mocked(canAccess).mockImplementation((module, level) => module === 'reconciliation' && level === 'R')
    await renderDetail()
    expect(screen.queryByRole('button', { name: '更正登记时间' })).not.toBeInTheDocument()
  })

  it('reason 为空 → 提交被拦，不发起请求', async () => {
    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: '更正登记时间' }))
    const form = screen.getByRole('region', { name: '登记时间更正' })
    fireEvent.change(within(form).getByLabelText('新登记时间'), { target: { value: '2026-07-05' } })
    fireEvent.click(within(form).getByRole('checkbox'))
    fireEvent.click(within(form).getByRole('button', { name: '提交更正' }))
    expect(lisCasesApi.correct).not.toHaveBeenCalled()
    expect(within(form).getByRole('alert')).toHaveTextContent('原因')
  })

  it('未显式确认 → 提交被拦，不发起请求', async () => {
    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: '更正登记时间' }))
    const form = screen.getByRole('region', { name: '登记时间更正' })
    fireEvent.change(within(form).getByLabelText('新登记时间'), { target: { value: '2026-07-05' } })
    fireEvent.change(within(form).getByLabelText('更正原因'), { target: { value: '登记月录错' } })
    fireEvent.click(within(form).getByRole('button', { name: '提交更正' }))
    expect(lisCasesApi.correct).not.toHaveBeenCalled()
    expect(within(form).getByRole('alert')).toHaveTextContent('确认')
  })

  it('stale（服务端 409 STALE_EXPECTED）→ 提示已被修改并需重新加载，不乐观写入', async () => {
    vi.mocked(lisCasesApi.correct).mockRejectedValue({ status: 409, code: 'STALE_EXPECTED', message: 'stale' })
    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: '更正登记时间' }))
    const form = screen.getByRole('region', { name: '登记时间更正' })
    fireEvent.change(within(form).getByLabelText('新登记时间'), { target: { value: '2026-07-05' } })
    fireEvent.change(within(form).getByLabelText('更正原因'), { target: { value: '登记月录错' } })
    fireEvent.click(within(form).getByRole('checkbox'))
    fireEvent.click(within(form).getByRole('button', { name: '提交更正' }))

    expect(await within(form).findByRole('alert')).toHaveTextContent('已被修改')
    expect(screen.queryByText('2026-07-05')).not.toBeInTheDocument() // 不乐观写入
    // 重新加载后 CAS 基准刷新
    vi.mocked(lisCasesApi.list).mockResolvedValue({ list: [{ ...RECORD, operateTime: '2026-06-30' }], page: 1, pageSize: 20, total: 1 })
    fireEvent.click(within(form).getByRole('button', { name: '重新加载' }))
    expect(await screen.findByText('2026-06-30')).toBeInTheDocument()
  })

  it('双击/重复提交只发一次更正请求', async () => {
    const pending = deferred<{ caseNo: string; partnerId: string; oldOperateTime: string; newOperateTime: string; reason: string }>()
    vi.mocked(lisCasesApi.correct).mockReturnValue(pending.promise)
    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: '更正登记时间' }))
    const form = screen.getByRole('region', { name: '登记时间更正' })
    fireEvent.change(within(form).getByLabelText('新登记时间'), { target: { value: '2026-07-05' } })
    fireEvent.change(within(form).getByLabelText('更正原因'), { target: { value: '登记月录错' } })
    fireEvent.click(within(form).getByRole('checkbox'))
    const submit = within(form).getByRole('button', { name: '提交更正' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(lisCasesApi.correct).toHaveBeenCalledTimes(1)
    pending.resolve({ caseNo: 'S26-001', partnerId: 'P-1', oldOperateTime: '2026-06-20', newOperateTime: '2026-07-05', reason: '登记月录错' })
    expect(await screen.findByText('2026-07-05')).toBeInTheDocument()
  })
})
