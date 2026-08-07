import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StocktakingDetail } from '@/api/stocktaking'
import { StocktakingDetailModal } from './StocktakingDetailModal'

const row: StocktakingDetail = {
  id: 'stocktaking-1',
  stocktakingNo: 'ST-001',
  materialId: 'material-1',
  materialCode: 'MAT-001',
  materialName: '盘点试剂',
  unit: '盒',
  positionId: 'position-1',
  batchId: 'batch-1',
  batchNo: 'BATCH-001',
  locationId: 'location-1',
  locationName: '冷藏库 A-01',
  resolutionState: 'resolved',
  snapshotVersion: 1,
  currentPositionVersion: 2,
  systemStock: 10,
  actualStock: 12,
  difference: 2,
  currentStock: 12,
  operator: 'counter',
  status: 'adjusted',
  reason: 'pending',
  remark: null,
  adjustmentEventId: 'event-1',
  latestEventId: 'event-1',
  createdAt: '2026-08-07T12:00:00.000Z',
  events: [{
    id: 'event-1',
    eventKind: 'adjustment',
    parentEventId: null,
    rootEventId: 'event-1',
    chainDepth: 0,
    quantityDelta: 2,
    inventoryBefore: 10,
    inventoryAfter: 12,
    operator: 'counter',
    reason: 'pending',
    createdAt: '2026-08-07T12:05:00.000Z',
  }],
  explanations: [],
}

function props(canAdjust: boolean) {
  return {
    open: true,
    row,
    loading: false,
    canAdjust,
    canReverse: false,
    explanation: '',
    explanationSubmitting: false,
    onExplanationChange: vi.fn(),
    onAppendExplanation: vi.fn(),
    onAdjust: vi.fn(),
    onReverse: vi.fn(),
    onClose: vi.fn(),
  }
}

describe('StocktakingDetailModal permissions', () => {
  it('只向具有库存调整权限的用户显示追加说明控件', () => {
    const view = render(<StocktakingDetailModal {...props(false)} />)
    expect(screen.queryByLabelText('补充说明')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '追加说明' })).not.toBeInTheDocument()

    view.rerender(<StocktakingDetailModal {...props(true)} />)
    expect(screen.getByLabelText('补充说明')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '追加说明' })).toBeInTheDocument()
  })
})
