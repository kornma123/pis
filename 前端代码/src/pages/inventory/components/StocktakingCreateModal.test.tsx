import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StocktakingCreateModal } from './StocktakingCreateModal'
import {
  isSamePositionSnapshot,
  type StocktakingPositionOption,
} from '../hooks/useStocktakingPage'

const position: StocktakingPositionOption = {
  id: 'pos-1',
  version: 3,
  materialId: 'mat-1',
  materialCode: 'IHC-DAB-001',
  materialName: 'DAB 显色试剂盒',
  unit: '盒',
  batchId: 'batch-1',
  batchNo: 'DAB-202607-03',
  locationId: 'loc-1',
  locationName: '冷藏库 A-03-02',
  quantity: 10,
}

function renderModal(step: 1 | 2 | 3, overrides: Record<string, unknown> = {}) {
  const props = {
    open: true,
    step,
    positions: [position],
    confirmedPosition: position,
    loading: false,
    keyword: '',
    selectedPositionId: 'pos-1',
    actualStock: '12',
    remark: '',
    submitting: false,
    onClose: vi.fn(),
    onKeywordChange: vi.fn(),
    onSelectPosition: vi.fn(),
    onActualStockChange: vi.fn(),
    onRemarkChange: vi.fn(),
    onStepChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }
  render(<StocktakingCreateModal {...props} />)
  return props
}

describe('StocktakingCreateModal', () => {
  it('只显示现有库存位置，并传递精确位置选择', () => {
    const props = renderModal(1, { selectedPositionId: '' })

    expect(screen.getByText('DAB 显色试剂盒')).toBeInTheDocument()
    expect(screen.getByText('DAB-202607-03')).toBeInTheDocument()
    expect(screen.getByText('冷藏库 A-03-02')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /DAB 显色试剂盒/ }))
    expect(props.onSelectPosition).toHaveBeenCalledWith('pos-1')
  })

  it('在确认页明确展示快照和差异，再保存盘点结果', () => {
    const props = renderModal(3)

    expect(screen.getByText('10 → 12 盒')).toBeInTheDocument()
    expect(screen.getByText('+2 盒')).toBeInTheDocument()
    expect(screen.getByText(/保存后只记录盘点结果/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存盘点结果' }))
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('确认页保持操作者确认的快照，不跟随后台刷新的活跃位置', () => {
    const refreshed = { ...position, version: 4, quantity: 11 }
    renderModal(3, { positions: [refreshed], confirmedPosition: position })

    expect(screen.getByText('10 → 12 盒')).toBeInTheDocument()
    expect(screen.queryByText('11 → 12 盒')).not.toBeInTheDocument()
    expect(isSamePositionSnapshot(position, refreshed)).toBe(false)
    expect(isSamePositionSnapshot(position, position)).toBe(true)
  })
})
