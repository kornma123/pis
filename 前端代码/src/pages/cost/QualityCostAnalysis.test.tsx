import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import QualityCostAnalysis from './QualityCostAnalysis'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getQualityCosts: vi.fn(),
    getQualityCostSummary: vi.fn(),
    createQualityCost: vi.fn(),
    updateQualityCost: vi.fn(),
  },
}))

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}))

describe('QualityCostAnalysis display labels', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/')
    vi.mocked(abcApi.getQualityCosts).mockReset()
    vi.mocked(abcApi.getQualityCostSummary).mockReset()
    vi.mocked(abcApi.createQualityCost).mockReset()
    vi.mocked((abcApi as any).updateQualityCost).mockReset()

    vi.mocked(abcApi.getQualityCosts).mockResolvedValue({
      list: [
        {
          id: 'quality-cost-1',
          yearMonth: '2026-06',
          costType: 'prevention',
          subType: 'training',
          amount: 1200,
          description: '入职培训',
        },
      ],
    })
    vi.mocked(abcApi.getQualityCostSummary).mockResolvedValue({
      totalQualityCost: 1200,
      preventionCost: 1200,
      appraisalCost: 0,
      internalFailureCost: 0,
      externalFailureCost: 0,
    })
    vi.mocked(abcApi.createQualityCost).mockResolvedValue({ id: 'created-quality-cost' })
    vi.mocked((abcApi as any).updateQualityCost).mockResolvedValue({ id: 'quality-cost-1' })
  })

  it('displays and searches quality cost subtype labels instead of internal enum values', async () => {
    render(<QualityCostAnalysis />)

    const row = await screen.findByText('入职培训')
    const costRow = row.closest('tr')
    expect(costRow).not.toBeNull()
    expect(within(costRow as HTMLTableRowElement).getByText('培训费用')).toBeInTheDocument()
    expect(within(costRow as HTMLTableRowElement).queryByText('training')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('搜索质量成本...'), { target: { value: '培训费用' } })

    await waitFor(() => {
      expect(screen.getByText('入职培训')).toBeInTheDocument()
      expect(screen.queryByText('暂无质量成本数据')).not.toBeInTheDocument()
    })
  })

  it('uses URL keyword to load and keep the audit-linked quality cost visible', async () => {
    window.history.pushState({}, '', '/abc/quality-costs?keyword=quality-cost-1')
    render(<QualityCostAnalysis />)

    await waitFor(() => {
      expect(abcApi.getQualityCosts).toHaveBeenCalledWith({ keyword: 'quality-cost-1' })
    })
    expect(screen.getByPlaceholderText('搜索质量成本...')).toHaveValue('quality-cost-1')
    expect(await screen.findByText('入职培训')).toBeInTheDocument()
  })

  it('edits an existing quality cost instead of requiring an offline correction', async () => {
    render(<QualityCostAnalysis />)

    const row = await screen.findByText('入职培训')
    const costRow = row.closest('tr')
    expect(costRow).not.toBeNull()

    fireEvent.click(within(costRow as HTMLTableRowElement).getByRole('button', { name: '编辑' }))
    expect(await screen.findByRole('dialog', { name: '编辑质量成本' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: '成本类型 *' }), { target: { value: 'appraisal' } })
    fireEvent.change(screen.getByRole('combobox', { name: '子类型 *' }), { target: { value: 'quality_audit' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '金额 (元) *' }), { target: { value: '880' } })
    fireEvent.change(screen.getByRole('textbox', { name: /描述/ }), { target: { value: '质量成本更正后' } })
    fireEvent.click(screen.getByRole('button', { name: '更新' }))

    await waitFor(() => {
      expect((abcApi as any).updateQualityCost).toHaveBeenCalledWith('quality-cost-1', {
        yearMonth: '2026-06',
        costType: 'appraisal',
        subType: 'quality_audit',
        amount: 880,
        description: '质量成本更正后',
      })
    })
    expect(abcApi.createQualityCost).not.toHaveBeenCalled()
  })

  it('summarizes quality cost result and downstream chain before saving', async () => {
    render(<QualityCostAnalysis />)

    fireEvent.click(await screen.findByRole('button', { name: '录入质量成本' }))

    expect(await screen.findByText('质量成本结果确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：质量成本、成本预算、成本看板、质量改进、审计记录')).toBeInTheDocument()
    expect(screen.getByText('月份 2026-06')).toBeInTheDocument()
    expect(screen.getByText('成本类型 预防成本')).toBeInTheDocument()
    expect(screen.getByText('子类型 培训费用')).toBeInTheDocument()
    expect(screen.getByText('金额 ¥0.00')).toBeInTheDocument()
  })

  it('blocks saving quality cost without an explainable description', async () => {
    render(<QualityCostAnalysis />)

    fireEvent.click(await screen.findByRole('button', { name: '录入质量成本' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: '金额 (元) *' }), { target: { value: '600' } })

    expect(screen.getByText('请填写描述，系统才能解释质量成本来源、改进动作和审计依据。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '录入' })).toBeDisabled()
    expect(abcApi.createQualityCost).not.toHaveBeenCalled()
  })
})
