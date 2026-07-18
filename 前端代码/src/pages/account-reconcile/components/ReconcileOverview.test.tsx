import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { HospitalMonth } from '@/types/account-reconcile'
import { ReconcileOverview } from './ReconcileOverview'

function hospital(overrides: Partial<HospitalMonth> = {}): HospitalMonth {
  return {
    id: 'HM-1',
    partnerId: 'P-1',
    partnerName: '测试医院',
    serviceMonth: '2026-05',
    status: '复核完成',
    matchRate: 1,
    matchStatus: '正常',
    statementReady: true,
    lisReady: true,
    diffCount: 0,
    pendingCount: 0,
    unmatchedCount: 0,
    confirmedLabRevenue: 100,
    ...overrides,
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    canWrite: true,
    writeReady: true,
    month: '2026-05',
    loadedMonth: '2026-05',
    loadError: false,
    setMonth: vi.fn(),
    tab: 'overview',
    setTab: vi.fn(),
    selected: null,
    openWorkbench: vi.fn(),
    backToOverview: vi.fn(),
    list: [hospital()],
    board: { total: 1, 待复核: 0, 复核完成: 1, 已关账: 0, 补收实收: 0, 确认实收: 100 },
    loading: false,
    busy: false,
    loadOverview: vi.fn(),
    partners: [{ id: 'P-1', name: '测试医院' }],
    loadPartners: vi.fn(),
    computePartner: vi.fn(),
    recomputeAll: vi.fn(),
    closeMonth: vi.fn(),
    ...overrides,
  } as never
}

describe('ReconcileOverview — 关账范围确认与 UI fail-closed', () => {
  it('稳定快照先确认月份和医院范围，再按 loadedMonth 提交关账', () => {
    const ctx = context() as any
    render(<ReconcileOverview ctx={ctx} />)

    fireEvent.click(screen.getByRole('button', { name: '关账本月（1家）' }))
    expect(ctx.closeMonth).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('2026年5月')).toBeInTheDocument()
    expect(within(dialog).getByText('测试医院')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '确认关账 1 家' }))
    expect(ctx.closeMonth).toHaveBeenCalledWith({ serviceMonth: '2026-05', partnerIds: ['P-1'] })
  })

  it.each([
    ['loading', { loading: true, writeReady: false }],
    ['error', { loadError: true, writeReady: false }],
  ])('%s 状态即使残留旧列表也不渲染业务快照或写入口', (_name, state) => {
    const ctx = context({
      ...state,
      list: [hospital({ statementReady: false, lisReady: false })],
    }) as any
    render(<ReconcileOverview ctx={ctx} />)

    expect(screen.getByRole('button', { name: '重算本月' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '重算' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /关账本月/ })).not.toBeInTheDocument()
    expect(screen.queryByText('实验室实收 · 已确认')).not.toBeInTheDocument()
  })

  it('loadedMonth 与选择月份不一致时保留只读快照但禁用全部总览写操作', () => {
    const ctx = context({ loadedMonth: '2026-04', writeReady: false, list: [hospital({ statementReady: false, lisReady: false })] }) as any
    render(<ReconcileOverview ctx={ctx} />)

    expect(screen.getByRole('button', { name: '重算本月' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重算' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /关账本月/ })).toBeDisabled()
  })

  it('加载失败显示可重试错误态，重试只重新读取不写业务数据', () => {
    const ctx = context({ list: [], board: null, loadError: true, writeReady: false }) as any
    render(<ReconcileOverview ctx={ctx} />)

    expect(screen.getByRole('alert')).toHaveTextContent('数据没能加载')
    expect(screen.queryByText(/还没有核对记录/)).not.toBeInTheDocument()
    expect(screen.queryByText('实验室实收 · 已确认')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(ctx.loadOverview).toHaveBeenCalledTimes(1)
    expect(ctx.computePartner).not.toHaveBeenCalled()
    expect(ctx.closeMonth).not.toHaveBeenCalled()
  })
})
