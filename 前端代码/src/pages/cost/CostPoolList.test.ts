import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import { CostPoolList, isManualCostPoolFormReady } from './CostPoolList'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getCostPools: vi.fn(),
    createCostPool: vi.fn(),
    syncCostPools: vi.fn(),
    autoCollectCostPools: vi.fn(),
    recalculateCostPools: vi.fn(),
    getActivityCenters: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('CostPoolList helpers', () => {
  it('requires activity center, non-negative costs, positive driver quantity and adjustment reason', () => {
    expect(isManualCostPoolFormReady({
      activityCenterId: 'center-1',
      directCost: '100',
      indirectCost: '20',
      driverQuantity: '10',
      adjustmentReason: '月末人工成本补录',
      sourceDocumentNo: '',
      attachmentUrl: '',
      description: '',
    })).toBe(true)

    expect(isManualCostPoolFormReady({
      activityCenterId: 'center-1',
      directCost: '100',
      indirectCost: '20',
      driverQuantity: '10',
      adjustmentReason: '   ',
      sourceDocumentNo: '',
      attachmentUrl: '',
      description: '',
    })).toBe(false)

    expect(isManualCostPoolFormReady({
      activityCenterId: 'center-1',
      directCost: '100',
      indirectCost: '20',
      driverQuantity: '0',
      adjustmentReason: '月末人工成本补录',
      sourceDocumentNo: '',
      attachmentUrl: '',
      description: '',
    })).toBe(false)
  })
})

describe('CostPoolList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
    localStorage.clear()
    localStorage.setItem('user', JSON.stringify({ role: 'finance' }))
    vi.mocked(abcApi.getCostPools).mockResolvedValue({
      list: [{
        id: 'POOL-PW-DEEP-001',
        activityCenterName: '深链验证成本池中心',
        activityCenterCode: 'AC-PW-DEEP-001',
        yearMonth: '2026-06',
        directCost: 100,
        indirectCost: 20,
        totalCost: 120,
        driverQuantity: 10,
        driverRate: 12,
        source: 'manual',
        adjustmentReason: '页面深链验证调整',
        sourceDocumentNo: 'DOC-PW-DEEP-001',
        description: '成本池深链验证说明',
      }],
      pagination: { total: 1 },
    } as any)
  })

  it('L5-2: 归集后展示完全吸收对账与间接基准（CHAIN-06/09）', async () => {
    vi.mocked(abcApi.autoCollectCostPools).mockResolvedValue({
      absorption: { sumPools: 1400, sourceTotal: 1400, diff: 0, ok: true, basis: 'by_direct_cost' },
      sourceTotals: { laborCost: 800, equipmentCost: 400, indirectCost: 200 },
    } as any)
    render(createElement(CostPoolList))
    await waitFor(() => expect(abcApi.getCostPools).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: /自动归集/ }))
    await waitFor(() => expect(screen.getByText(/完全吸收：Σ池 = Σ来源/)).toBeInTheDocument())
    expect(screen.getByText(/按各中心直接成本占比/)).toBeInTheDocument()
  })

  it('uses keyword from URL so audit links open a filtered cost pool list', async () => {
    window.history.replaceState(null, '', '/abc/cost-pools?keyword=POOL-PW-DEEP-001')

    render(createElement(CostPoolList))

    await waitFor(() => expect(abcApi.getCostPools).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'POOL-PW-DEEP-001',
      page: 1,
      pageSize: 10,
    })))
    expect(screen.getByPlaceholderText('作业中心 / 编码 / 说明')).toHaveValue('POOL-PW-DEEP-001')
    expect(await screen.findByText('深链验证成本池中心')).toBeInTheDocument()
    expect(screen.getByText('DOC-PW-DEEP-001')).toBeInTheDocument()
  })

  it('focuses a newly saved manual cost pool by its source document so finance can verify the adjustment fact', async () => {
    window.history.replaceState(null, '', '/abc/cost-pools?keyword=old-pool')
    vi.mocked(abcApi.getActivityCenters).mockResolvedValue({
      list: [{
        id: 'center-created',
        name: '切片作业中心',
        code: 'AC_SLIDE',
        status: 'active',
      }],
    } as any)
    vi.mocked(abcApi.createCostPool).mockResolvedValue({
      id: 'POOL-CREATED-001',
      sourceDocumentNo: 'FIN-ADJ-202606',
    } as any)

    render(createElement(CostPoolList))

    await waitFor(() => expect(abcApi.getCostPools).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'old-pool',
      page: 1,
      pageSize: 10,
    })))

    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'auto_collect' } })
    await waitFor(() => expect(abcApi.getCostPools).toHaveBeenCalledWith(expect.objectContaining({
      source: 'auto_collect',
      keyword: 'old-pool',
    })))

    fireEvent.click(screen.getByRole('button', { name: '手工录入' }))
    await waitFor(() => expect(abcApi.getActivityCenters).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('作业中心'), { target: { value: 'center-created' } })
    fireEvent.change(screen.getByLabelText('直接成本'), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText('间接成本'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('动因量'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('来源单据'), { target: { value: 'FIN-ADJ-202606' } })
    fireEvent.change(screen.getByLabelText(/调整原因/), { target: { value: '月末人工成本补录，经财务复核调整本期成本池' } })
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '本期手工成本调整' } })
    expect(screen.getByText('成本池结果确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：成本池、动因费率、项目成本、成本结账、审计记录')).toBeInTheDocument()
    expect(screen.getByText('作业中心 切片作业中心')).toBeInTheDocument()
    expect(screen.getByText('总成本 ¥230.00')).toBeInTheDocument()
    expect(screen.getByText('动因费率 ¥11.50 / 单位动因')).toBeInTheDocument()
    expect(screen.getByText('来源单据 FIN-ADJ-202606')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存成本池' }))

    await waitFor(() => expect(abcApi.createCostPool).toHaveBeenCalledWith(expect.objectContaining({
      activityCenterId: 'center-created',
      directCost: 200,
      indirectCost: 30,
      driverQuantity: 20,
      source: 'manual',
      sourceDocumentNo: 'FIN-ADJ-202606',
      adjustmentReason: '月末人工成本补录，经财务复核调整本期成本池',
      description: '本期手工成本调整',
    })))
    await waitFor(() => expect(abcApi.getCostPools).toHaveBeenCalledWith(expect.objectContaining({
      source: 'manual',
      keyword: 'FIN-ADJ-202606',
      page: 1,
      pageSize: 10,
    })))
    expect(screen.getByLabelText('来源')).toHaveValue('manual')
    expect(screen.getByPlaceholderText('作业中心 / 编码 / 说明')).toHaveValue('FIN-ADJ-202606')
  })

  it('blocks saving manual cost pool until an activity center is selected', async () => {
    vi.mocked(abcApi.getActivityCenters).mockResolvedValue({
      list: [{
        id: 'center-created',
        name: '切片作业中心',
        code: 'AC_SLIDE',
        status: 'active',
      }],
    } as any)

    render(createElement(CostPoolList))

    fireEvent.click(await screen.findByRole('button', { name: '手工录入' }))
    await waitFor(() => expect(abcApi.getActivityCenters).toHaveBeenCalled())

    expect(screen.getByText('请选择作业中心，系统才能把手工成本归入正确作业中心和动因费率。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存成本池' })).toBeDisabled()
  })
})
