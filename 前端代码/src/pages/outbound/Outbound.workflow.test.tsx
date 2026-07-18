import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { canAccess } from '@/lib/permissions'
import { outboundApi } from '@/api/inventory'
import { materialApi, projectApi } from '@/api/master'
import Outbound from './Outbound'

vi.mock('@/api/inventory', () => ({
  outboundApi: {
    getList: vi.fn(),
    getStats: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))
vi.mock('@/api/master', () => ({
  materialApi: { getList: vi.fn() },
  projectApi: { getList: vi.fn() },
}))
vi.mock('@/lib/permissions', () => ({ canAccess: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

describe('Outbound workflow states', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/outbound')
    vi.mocked(canAccess).mockImplementation((_module, level = 'R') => level === 'R')
    vi.mocked(outboundApi.getList).mockResolvedValue({
      list: [], pagination: { total: 0, page: 1, pageSize: 10 },
    } as any)
    vi.mocked(outboundApi.getStats).mockResolvedValue({
      total: 0, completed: 0, pending: 0, cancelled: 0, totalCost: 0,
    } as any)
    vi.mocked(materialApi.getList).mockResolvedValue({ list: [] } as any)
    vi.mocked(projectApi.getList).mockResolvedValue({ list: [] } as any)
  })

  it('hides every write entry when the session only has outbound read access', async () => {
    render(<Outbound />)
    await waitFor(() => expect(outboundApi.getList).toHaveBeenCalled())

    expect(screen.queryByRole('button', { name: '出库登记' })).not.toBeInTheDocument()
    expect(screen.getByText('你可以查看出库记录，但当前账号没有出库写权限。')).toBeInTheDocument()
  })

  it('renders a retryable list error instead of an empty-success state', async () => {
    vi.mocked(outboundApi.getList).mockRejectedValueOnce(new Error('network unavailable'))

    render(<Outbound />)

    expect(await screen.findByText('出库记录没能加载')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载出库记录' })).toBeInTheDocument()
    expect(screen.queryByText('暂无出库记录')).not.toBeInTheDocument()
  })

  it('exposes keyboard-reachable table and dialog semantics without refetching options on every open', async () => {
    vi.mocked(canAccess).mockReturnValue(true)
    render(<Outbound />)

    await waitFor(() => expect(outboundApi.getList).toHaveBeenCalled())
    await waitFor(() => expect(materialApi.getList).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('columnheader', { name: '出库时间' })).toHaveAttribute('aria-sort', 'descending')

    fireEvent.click(screen.getByRole('button', { name: '出库登记' }))
    const dialog = await screen.findByRole('dialog', { name: '出库登记' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByLabelText('关联项目')).toBeInTheDocument()
    expect(screen.getByLabelText('物料 1')).toBeInTheDocument()
    expect(screen.getByLabelText('数量')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '出库登记' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '出库登记' }))
    await screen.findByRole('dialog', { name: '出库登记' })
    expect(materialApi.getList).toHaveBeenCalledTimes(1)
    expect(projectApi.getList).toHaveBeenCalledTimes(1)
  })
})
