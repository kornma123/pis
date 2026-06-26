import { render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CostCenterFormModal } from './CostCenterFormModal'

describe('CostCenterFormModal', () => {
  it('summarizes cost center configuration and downstream chains before saving', () => {
    render(
      <CostCenterFormModal
        open
        type="create"
        form={{
          code: 'IDC-RENT',
          name: '房租成本',
          costType: 'rent',
          monthlyAmount: 1200,
          allocationBase: 'sample_count',
          description: '用于月度间接成本分摊',
          status: 'active',
        }}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('成本中心配置确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：成本中心、月度分摊、项目成本、成本结账、审计记录')).toBeInTheDocument()
    expect(screen.getByText('成本中心 房租成本')).toBeInTheDocument()
    expect(screen.getByText('月度金额 ¥1200.00')).toBeInTheDocument()
    expect(screen.getByText('分摊基础 样本数')).toBeInTheDocument()
    expect(screen.getByText('状态 已启用')).toBeInTheDocument()
  })
})
