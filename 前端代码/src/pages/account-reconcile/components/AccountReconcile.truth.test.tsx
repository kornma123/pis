import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReconcileWorkbench } from './ReconcileWorkbench'
import { SupplementTracking } from './SupplementTracking'
import { pct, wan, yuan } from '../ui'

const mocks = vi.hoisted(() => ({
  workbench: vi.fn(),
  supplements: vi.fn(),
}))

vi.mock('@/api/account-reconcile', () => ({
  accountReconcileApi: {
    workbench: mocks.workbench,
    supplements: mocks.supplements,
    verdict: vi.fn(),
    complete: vi.fn(),
    reopen: vi.fn(),
    reopenClose: vi.fn(),
    approve: vi.fn(),
    collect: vi.fn(),
    giveup: vi.fn(),
    reopenSupplement: vi.fn(),
  },
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('account reconcile truth states', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('keeps a verified zero distinct from a missing value', () => {
    expect(wan(0)).toBe('0.00万元')
    expect(yuan(0)).toBe('¥0')
    expect(pct(0)).toBe('0%')
    expect(wan(undefined)).toBe('不可计算')
    expect(yuan(null)).toBe('不可计算')
    expect(pct(undefined)).toBe('不可计算')
  })

  it('does not turn a workbench load failure into a no-record empty state', async () => {
    mocks.workbench.mockRejectedValue(new Error('network down'))
    render(
      <ReconcileWorkbench
        partnerId="partner-1"
        partnerName="医院一"
        month="2026-07"
        canWrite
        onBack={vi.fn()}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('工作台数据没能加载')
    expect(screen.queryByText(/还没有核对记录/)).not.toBeInTheDocument()
  })

  it('does not turn a supplement load failure into a true empty month', async () => {
    mocks.supplements.mockRejectedValue(new Error('network down'))
    render(<SupplementTracking month="2026-07" canWrite />)

    expect(await screen.findByRole('alert')).toHaveTextContent('补收数据没能加载')
    expect(screen.queryByText(/本月暂无补收单/)).not.toBeInTheDocument()
  })
})
