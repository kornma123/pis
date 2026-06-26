import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { laborTimeApi } from '@/api/master'
import type { StandardLaborTime } from '@/types'
import { LaborTimeDetailModal } from './LaborTimeDetailModal'

vi.mock('@/api/master', () => ({
  laborTimeApi: {
    getDetail: vi.fn(),
  },
}))

const listRow: StandardLaborTime = {
  id: 'labor-1',
  stepCode: 'IHC-INCUBATE',
  stepName: '抗体孵育',
  projectType: 'ihc',
  standardMinutes: 30,
  laborRatePerMinute: 1.5,
  isEquipmentStep: false,
  description: '列表摘要',
  sortOrder: 10,
  referenceSource: 'system',
  referenceSourceLabel: '系统预设',
  createdAt: '2026-01-01T08:00:00Z',
  updatedAt: '2026-01-02T09:00:00Z',
}

const detailRow: StandardLaborTime = {
  ...listRow,
  standardMinutes: 45,
  laborRatePerMinute: 2.25,
  isEquipmentStep: true,
  description: '来自详情接口的完整说明',
  sortOrder: 20,
  referenceSource: 'industry',
  referenceSourceLabel: '行业标准',
  updatedAt: '2026-06-16T10:00:00Z',
}

describe('LaborTimeDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(laborTimeApi.getDetail).mockResolvedValue(detailRow as any)
  })

  it('loads and renders the latest labor time detail', async () => {
    render(
      <LaborTimeDetailModal
        open
        row={listRow}
        onClose={vi.fn()}
        onEdit={vi.fn()}
      />
    )

    expect(screen.getByRole('dialog', { name: '工时详情 - 抗体孵育' })).toBeInTheDocument()
    expect(screen.getByText('IHC-INCUBATE')).toBeInTheDocument()

    await waitFor(() => expect(laborTimeApi.getDetail).toHaveBeenCalledWith('labor-1'))
    expect(await screen.findByText('45 分钟')).toBeInTheDocument()
    expect(screen.getByText('¥2.25')).toBeInTheDocument()
    expect(screen.getByText('设备步骤')).toBeInTheDocument()
    expect(screen.getByText('行业标准')).toBeInTheDocument()
    expect(screen.getByText('来自详情接口的完整说明')).toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
  })

  it('hides edit action for read-only viewers', async () => {
    render(
      <LaborTimeDetailModal
        open
        row={listRow}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        canEdit={false}
      />
    )

    await waitFor(() => expect(laborTimeApi.getDetail).toHaveBeenCalledWith('labor-1'))
    expect(screen.queryByRole('button', { name: '编辑工时' })).not.toBeInTheDocument()
  })
})
