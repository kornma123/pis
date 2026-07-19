import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { partnerConfigApi } from '@/api/partner-config'
import PartnerConfigPage from './PartnerConfigPage'
import type { PartnerConfig } from '@/types/partner-config'

vi.mock('@/api/partner-config', () => ({
  partnerConfigApi: {
    partners: vi.fn(),
    get: vi.fn(),
    changes: vi.fn(),
    save: vi.fn(),
    rollback: vi.fn(),
    baseline: vi.fn(),
  },
}))

vi.mock('@/lib/permissions', () => ({
  getRoles: vi.fn(() => ['finance']),
  getUserRole: vi.fn(() => 'finance'),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const config: PartnerConfig = {
  basic: { full: '测试医院', short: '测试', code: 'P-1', group: '', campus: '', start: '2026-01', status: '合作中', contact: '' },
  amount: { bill: '未税', settle: '未税', rate: 0 },
  parse: { uploaded: false, file: '', rows: 0, template: '', colMap: {} },
  lines: [
    { key: 'split-line', name: '管理员拆分线', on: true, scope: 'split', prefixes: ['S'], keywords: ['制片'], remarks: [], splitProcRate: 36, splitWorkload: 'lis_blk' },
    { key: 'in-line', name: '财务普通线', on: true, scope: 'in', prefixes: [], keywords: [], remarks: [] },
  ],
  discount: { def: 0.9, byLine: [], byItem: [] },
  special: { retainer: { on: false, name: '', amount: 0 }, joint: { on: false, ratio: 0, share: '' } },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(partnerConfigApi.partners).mockResolvedValue({ list: [{ id: 'P-1', code: 'P-1', name: '测试医院' }], total: 1 })
  vi.mocked(partnerConfigApi.get).mockResolvedValue({ partnerId: 'P-1', version: 2, isBaseline: false, config })
  vi.mocked(partnerConfigApi.changes).mockResolvedValue([])
})

async function openConfig() {
  render(<PartnerConfigPage />)
  fireEvent.click(await screen.findByRole('button', { name: /测试医院/ }))
  await screen.findByDisplayValue('测试医院')
}

describe('Partner configuration workflow', () => {
  it('starts independent config and history requests in parallel', async () => {
    const pendingConfig = deferred<{ partnerId: string; version: number; isBaseline: boolean; config: PartnerConfig }>()
    vi.mocked(partnerConfigApi.get).mockReturnValue(pendingConfig.promise)

    render(<PartnerConfigPage />)
    fireEvent.click(await screen.findByRole('button', { name: /测试医院/ }))

    expect(partnerConfigApi.get).toHaveBeenCalledWith('P-1')
    expect(partnerConfigApi.changes).toHaveBeenCalledWith('P-1')
    await act(async () => pendingConfig.resolve({ partnerId: 'P-1', version: 2, isBaseline: false, config }))
  })

  it('makes every split or diagnosis line field read-only for finance', async () => {
    await openConfig()
    fireEvent.click(screen.getByRole('tab', { name: '业务分类' }))

    expect(screen.getByDisplayValue('管理员拆分线')).toBeDisabled()
    expect(screen.getByRole('switch', { name: /管理员拆分线/ })).toBeDisabled()
    expect(screen.getByDisplayValue('S')).toBeDisabled()
    expect(screen.queryByRole('button', { name: '删除业务线 管理员拆分线' })).not.toBeInTheDocument()

    expect(screen.getByDisplayValue('财务普通线')).toBeEnabled()
  })

  it('confirms and locks baseline mutation until a verified result returns', async () => {
    const pending = deferred<{ partnerId: string; baselineVersion: number }>()
    vi.mocked(partnerConfigApi.baseline).mockReturnValue(pending.promise)
    await openConfig()

    fireEvent.click(screen.getByRole('button', { name: '设为导入基线' }))
    const dialog = screen.getByRole('dialog', { name: '设为月度导入基线？' })
    expect(partnerConfigApi.baseline).not.toHaveBeenCalled()

    const confirm = within(dialog).getByRole('button', { name: '确认设置' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(partnerConfigApi.baseline).toHaveBeenCalledTimes(1)
    expect(within(dialog).getByRole('button', { name: '设置中…' })).toBeDisabled()

    await act(async () => pending.resolve({ partnerId: 'P-1', baselineVersion: 2 }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设为月度导入基线？' })).not.toBeInTheDocument())
    expect(screen.getByText(/v2 · 基线/)).toBeInTheDocument()
  })

  it('drops an older hospital response after the user returns and opens another hospital', async () => {
    const firstConfig = deferred<{ partnerId: string; version: number; isBaseline: boolean; config: PartnerConfig }>()
    const firstHistory = deferred<never[]>()
    const secondConfig = { ...config, basic: { ...config.basic, full: '第二医院', code: 'P-2' } }
    vi.mocked(partnerConfigApi.partners).mockResolvedValue({
      list: [{ id: 'P-1', code: 'P-1', name: '第一医院' }, { id: 'P-2', code: 'P-2', name: '第二医院' }],
      total: 2,
    })
    vi.mocked(partnerConfigApi.get).mockImplementation((id) => id === 'P-1'
      ? firstConfig.promise
      : Promise.resolve({ partnerId: 'P-2', version: 3, isBaseline: false, config: secondConfig }))
    vi.mocked(partnerConfigApi.changes).mockImplementation((id) => id === 'P-1' ? firstHistory.promise : Promise.resolve([]))

    render(<PartnerConfigPage />)
    fireEvent.click(await screen.findByRole('button', { name: /第一医院/ }))
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    fireEvent.click(await screen.findByRole('button', { name: /第二医院/ }))
    expect(await screen.findByDisplayValue('第二医院')).toBeInTheDocument()

    await act(async () => {
      firstConfig.resolve({ partnerId: 'P-1', version: 2, isBaseline: false, config })
      firstHistory.resolve([])
      await Promise.all([firstConfig.promise, firstHistory.promise])
    })
    expect(screen.getByDisplayValue('第二医院')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('测试医院')).not.toBeInTheDocument()
  })
})
