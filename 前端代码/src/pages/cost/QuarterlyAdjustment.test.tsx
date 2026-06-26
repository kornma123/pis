import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { costAdjustmentApi } from '@/api/master'
import { toast } from 'sonner'
import QuarterlyAdjustment from './QuarterlyAdjustment'

vi.mock('@/api/master', () => ({
  costAdjustmentApi: {
    getSuggestions: vi.fn(),
    create: vi.fn(),
    review: vi.fn(),
    getList: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

const suggestionResponse = {
  suggestions: [{
    costCenterId: 'center-slide',
    costCenterName: '切片作业中心',
    costCenterCode: 'AC_SLIDE',
    costType: 'maintenance',
    yearQuarter: '2026-Q2',
    preProvisionAmount: 1000,
    actualAmount: 0,
    adjustmentAmount: 0,
    isQuarterEnd: true,
  }],
}

describe('QuarterlyAdjustment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.setSystemTime(new Date('2026-06-22T09:00:00.000Z'))
    vi.mocked(costAdjustmentApi.getSuggestions).mockResolvedValue(suggestionResponse as any)
    vi.mocked(costAdjustmentApi.getList).mockResolvedValue({
      list: [{
        id: 'adjustment-created',
        costCenterId: 'center-slide',
        costCenterName: '切片作业中心',
        yearQuarter: '2026-Q2',
        preProvisionAmount: 1000,
        actualAmount: 1280,
        adjustmentAmount: 280,
        adjustmentReason: '季度维护费补差',
        submittedByName: '财务张三',
        reviewStatus: 'pending',
      }],
    } as any)
    vi.mocked(costAdjustmentApi.create).mockResolvedValue({
      id: 'adjustment-created',
      costCenterId: 'center-slide',
      costCenterName: '切片作业中心',
      yearQuarter: '2026-Q2',
      preProvisionAmount: 1000,
      actualAmount: 1280,
      adjustmentAmount: 280,
      adjustmentReason: '季度维护费补差',
      submittedByName: '财务张三',
      reviewStatus: 'pending',
    } as any)
  })

  it('opens the pending record after creating an adjustment so finance can verify the submitted fact', async () => {
    render(createElement(QuarterlyAdjustment))

    expect(await screen.findByText('切片作业中心')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /提交调整/ }))
    fireEvent.change(screen.getByPlaceholderText('请输入实际发生的费用金额'), { target: { value: '1280' } })
    fireEvent.change(screen.getByPlaceholderText('请说明实际费用来源、差异原因或财务复核依据'), { target: { value: '季度维护费补差' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await waitFor(() => expect(costAdjustmentApi.create).toHaveBeenCalledWith({
      costCenterId: 'center-slide',
      yearQuarter: '2026-Q2',
      actualAmount: 1280,
      adjustmentReason: '季度维护费补差',
    }))
    await waitFor(() => expect(costAdjustmentApi.getList).toHaveBeenCalledWith(expect.objectContaining({
      yearQuarter: '2026-Q2',
      reviewStatus: 'pending',
    })))
    expect(screen.getByPlaceholderText('搜索成本中心/提交人...')).toHaveValue('切片作业中心')
    await waitFor(() => {
      expect(screen.getAllByText('待审核').length).toBeGreaterThan(1)
    })
    expect(screen.getByText('财务张三')).toBeInTheDocument()
  })

  it('blocks creating an adjustment without an adjustment reason', async () => {
    render(createElement(QuarterlyAdjustment))

    expect(await screen.findByText('切片作业中心')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /提交调整/ }))
    fireEvent.change(screen.getByPlaceholderText('请输入实际发生的费用金额'), { target: { value: '1280' } })

    expect(screen.getByText('请填写调整原因，系统才能留下成本结账和审计依据。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled()
    expect(costAdjustmentApi.create).not.toHaveBeenCalled()
  })

  it('keeps the created adjustment visible without a misleading load error when the follow-up refresh fails', async () => {
    vi.mocked(costAdjustmentApi.getList).mockRejectedValue(new Error('refresh failed'))
    vi.mocked(costAdjustmentApi.getSuggestions)
      .mockResolvedValueOnce(suggestionResponse as any)
      .mockRejectedValue(new Error('suggestions refresh failed'))

    render(createElement(QuarterlyAdjustment))

    expect(await screen.findByText('切片作业中心')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /提交调整/ }))
    fireEvent.change(screen.getByPlaceholderText('请输入实际发生的费用金额'), { target: { value: '1280' } })
    fireEvent.change(screen.getByPlaceholderText('请说明实际费用来源、差异原因或财务复核依据'), { target: { value: '季度维护费补差' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await waitFor(() => expect(costAdjustmentApi.create).toHaveBeenCalled())
    await waitFor(() => expect(costAdjustmentApi.getList).toHaveBeenCalledWith({
      yearQuarter: '2026-Q2',
      reviewStatus: 'pending',
    }))
    expect(screen.getByPlaceholderText('搜索成本中心/提交人...')).toHaveValue('切片作业中心')
    expect(await screen.findByText('财务张三')).toBeInTheDocument()
    expect(screen.getAllByText('待审核').length).toBeGreaterThan(1)
    expect(toast.success).toHaveBeenCalledWith('调整记录已创建')
    expect(toast.error).not.toHaveBeenCalledWith('加载调整记录失败')
    expect(toast.error).not.toHaveBeenCalledWith('加载调整建议失败')
  })

  it('opens the approved record after review so finance can confirm the adjustment was accepted', async () => {
    const approvedRecord = {
      id: 'adjustment-created',
      costCenterId: 'center-slide',
      costCenterName: '切片作业中心',
      yearQuarter: '2026-Q2',
      preProvisionAmount: 1000,
      actualAmount: 1280,
      adjustmentAmount: 280,
      adjustmentReason: '季度维护费补差',
      submittedByName: '财务张三',
      reviewStatus: 'approved',
    }
    vi.mocked(costAdjustmentApi.getList)
      .mockResolvedValueOnce({
        list: [{
          ...approvedRecord,
          reviewStatus: 'pending',
        }],
      } as any)
      .mockResolvedValueOnce({
        list: [approvedRecord],
      } as any)
    vi.mocked(costAdjustmentApi.review).mockResolvedValue({} as any)

    render(createElement(QuarterlyAdjustment))

    fireEvent.click(screen.getByRole('button', { name: '调整记录' }))
    await waitFor(() => expect(costAdjustmentApi.getList).toHaveBeenCalledWith({
      yearQuarter: '2026-Q2',
    }))
    fireEvent.click(await screen.findByRole('button', { name: '审核' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(costAdjustmentApi.review).toHaveBeenCalledWith('adjustment-created', {
      status: 'approved',
      reason: '',
    }))
    await waitFor(() => expect(costAdjustmentApi.getList).toHaveBeenLastCalledWith({
      yearQuarter: '2026-Q2',
      reviewStatus: 'approved',
    }))
    expect(screen.getByPlaceholderText('搜索成本中心/提交人...')).toHaveValue('切片作业中心')
    expect(screen.getByDisplayValue('已通过')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('已通过').length).toBeGreaterThan(1))
  })

  it('keeps the reviewed adjustment visible without a misleading load error when the follow-up refresh fails', async () => {
    vi.mocked(costAdjustmentApi.getList)
      .mockResolvedValueOnce({
        list: [{
          id: 'adjustment-created',
          costCenterId: 'center-slide',
          costCenterName: '切片作业中心',
          yearQuarter: '2026-Q2',
          preProvisionAmount: 1000,
          actualAmount: 1280,
          adjustmentAmount: 280,
          adjustmentReason: '季度维护费补差',
          submittedByName: '财务张三',
          reviewStatus: 'pending',
        }],
      } as any)
      .mockRejectedValue(new Error('refresh failed'))
    vi.mocked(costAdjustmentApi.review).mockResolvedValue({} as any)

    render(createElement(QuarterlyAdjustment))

    fireEvent.click(screen.getByRole('button', { name: '调整记录' }))
    fireEvent.click(await screen.findByRole('button', { name: '审核' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(costAdjustmentApi.review).toHaveBeenCalledWith('adjustment-created', {
      status: 'approved',
      reason: '',
    }))
    await waitFor(() => expect(costAdjustmentApi.getList).toHaveBeenLastCalledWith({
      yearQuarter: '2026-Q2',
      reviewStatus: 'approved',
    }))
    expect(screen.getByPlaceholderText('搜索成本中心/提交人...')).toHaveValue('切片作业中心')
    expect(screen.getByDisplayValue('已通过')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('已通过').length).toBeGreaterThan(1))
    expect(toast.success).toHaveBeenCalledWith('已通过')
    expect(toast.error).not.toHaveBeenCalledWith('加载调整记录失败')
  })
})
