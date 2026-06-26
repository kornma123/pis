import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EquipmentFormModal } from './EquipmentFormModal'
import type { EquipmentForm } from '../hooks/useEquipmentPage'

const form: EquipmentForm = {
  code: 'EQ-LOCKED',
  name: '染色机',
  model: '',
  manufacturer: '',
  purchasePrice: 100000,
  purchaseDate: '2026-01-01',
  depreciableLifeYears: 5,
  residualValue: 10000,
  depreciationMethod: 'straight_line',
  totalCapacity: 0,
  capacityUnit: 'minutes',
  status: 'active',
  locationId: '',
  typeId: '',
}

describe('EquipmentFormModal', () => {
  it('keeps backend-controlled equipment code read-only while editing', () => {
    render(
      <EquipmentFormModal
        open
        type="edit"
        form={form}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByDisplayValue('EQ-LOCKED')).toHaveAttribute('readonly')
  })

  it('shows depreciation and downstream confirmation before saving equipment', () => {
    render(
      <EquipmentFormModal
        open
        type="create"
        form={form}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByText('设备折旧结果确认')).toBeInTheDocument()
    expect(screen.getByText('可折旧金额')).toBeInTheDocument()
    expect(screen.getByText('¥90,000.00')).toBeInTheDocument()
    expect(screen.getByText('年折旧额')).toBeInTheDocument()
    expect(screen.getByText('¥18,000.00')).toBeInTheDocument()
    expect(screen.getByText('月折旧额')).toBeInTheDocument()
    expect(screen.getByText('¥1,500.00')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：设备档案、折旧统计、月度成本、BOM 成本、审计记录')).toBeInTheDocument()
  })

  it('shows unit depreciation when using units of production', () => {
    render(
      <EquipmentFormModal
        open
        type="create"
        form={{
          ...form,
          depreciationMethod: 'units_of_production',
          totalCapacity: 30000,
          capacityUnit: '张',
        }}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByText('单位折旧')).toBeInTheDocument()
    expect(screen.getByText('¥3.00/张')).toBeInTheDocument()
  })
})
