import { render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AllocationModal } from './AllocationModal'

const row = {
  id: 'cc-1',
  code: 'IDC-001',
  name: '房租成本',
  costType: 'rent',
  monthlyAmount: 1200,
  allocationBase: 'sample_count',
  description: '用于月度间接成本分摊',
  status: 'active',
  createdAt: '2026-06-01',
  updatedAt: '2026-06-01',
}

describe('AllocationModal', () => {
  it('summarizes allocation result and downstream chains before submitting', () => {
    render(
      <AllocationModal
        open
        row={row as any}
        allocationForm={{
          yearMonth: '2026-06',
          totalAmount: 1200,
          allocationBaseValue: 300,
        }}
        allocations={[]}
        onClose={vi.fn()}
        onChangeForm={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('分摊结果确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：间接成本、月度分摊、项目成本、成本结账、审计记录')).toBeInTheDocument()
    expect(screen.getByText('年月 2026-06')).toBeInTheDocument()
    expect(screen.getByText('费用总额 ¥1200.00')).toBeInTheDocument()
    expect(screen.getByText('分摊基础 样本数 300')).toBeInTheDocument()
    expect(screen.getByText('单位分摊率 ¥4.0000')).toBeInTheDocument()
  })

  it('blocks submitting when allocation base value is not positive', () => {
    render(
      <AllocationModal
        open
        row={row as any}
        allocationForm={{
          yearMonth: '2026-06',
          totalAmount: 1200,
          allocationBaseValue: 0,
        }}
        allocations={[]}
        onClose={vi.fn()}
        onChangeForm={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('请填写大于 0 的分摊基础值，系统才能把间接成本分摊到项目成本。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '录入分摊' })).toBeDisabled()
  })
})
