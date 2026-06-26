import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LaborTimeForm } from '../hooks/useLaborTimePage'
import { LaborTimeFormModal } from './LaborTimeFormModal'

const form: LaborTimeForm = {
  stepCode: 'LAB-IHC-LOCKED',
  stepName: '抗体孵育',
  projectType: 'ihc',
  standardMinutes: 30,
  laborRatePerMinute: 2,
  isEquipmentStep: false,
  description: '',
  sortOrder: 10,
  referenceSource: 'system',
}

describe('LaborTimeFormModal', () => {
  it('keeps step code and project type read-only while editing', () => {
    render(
      <LaborTimeFormModal
        open
        type="edit"
        form={form}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByDisplayValue('LAB-IHC-LOCKED')).toHaveAttribute('readonly')
    expect(screen.getByText('免疫组化')).toBeInTheDocument()
  })

  it('summarizes labor cost result and downstream chains before saving', () => {
    render(
      <LaborTimeFormModal
        open
        type="create"
        form={form}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByText('工时成本确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：工时定义、人工成本、项目成本、成本重算、审计记录')).toBeInTheDocument()
    expect(screen.getByText('步骤 抗体孵育')).toBeInTheDocument()
    expect(screen.getByText('标准时长 30 分钟')).toBeInTheDocument()
    expect(screen.getByText('人工成本/次 ¥60.00')).toBeInTheDocument()
  })

  it('blocks saving when standard minutes is not positive', () => {
    render(
      <LaborTimeFormModal
        open
        type="create"
        form={{ ...form, standardMinutes: 0 }}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByText('请填写大于 0 的标准时长，系统才能计算人工成本并参与项目成本重算。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })
})
