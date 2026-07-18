import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitOutcome, QueueItem } from './useImportQueue'
import type { PreviewResult } from '@/types/statement-import'
import ImportWizardPage from './ImportWizardPage'

const mocks = vi.hoisted(() => ({
  useImportQueue: vi.fn(),
  lisCoverage: vi.fn(),
}))

vi.mock('./useImportQueue', () => ({ useImportQueue: mocks.useImportQueue }))
vi.mock('@/api/statement-import', () => ({
  statementImportApi: { lisCoverage: mocks.lisCoverage },
}))
vi.mock('@/pages/import-shared/ImportShared', () => ({
  useHospitals: () => ({ hospitals: [{ id: 'P-1', name: '测试医院' }] }),
  ScoreCard: () => <div>评分卡</div>,
  ByLineTable: () => <div>业务线</div>,
  AttentionItem: ({ onClassify }: { onClassify: (lineKey: string, ruleType: 'keyword', value: string) => void }) => (
    <button onClick={() => onClassify('LINE-1', 'keyword', '项目')}>写回归类</button>
  ),
  btnCls: 'button-secondary',
  btnPri: 'button-primary',
  inputCls: 'input',
  yuan: (value: number) => `¥${value}`,
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const preview: PreviewResult = {
  partnerId: 'P-1',
  configVersion: 1,
  template: 'case_detail',
  serviceMonth: '2026-05',
  declaredTotal: 100,
  revenue: {
    labRevenue: 100,
    diagnosisSettle: 0,
    outSettle: 0,
    unmatchedSettle: 0,
    ambiguousSettle: 0,
    totalSettle: 100,
    splitLisExpected: 0,
    splitLisMissing: 0,
    byLine: [],
    counts: { total: 1, in: 1, out: 0, split: 0, diagnosis: 0, unmatched: 0, ambiguous: 0 },
  },
  score: {
    recognition: { total: 1, matched: 1, unmatched: 0, ambiguous: 0, rate: 1, pass: true },
    closure: { declaredTotal: 100, computed: 100, diff: 0, pass: true },
    caseMatch: {
      forward: { withCaseNo: 1, matched: 1, rate: 1, pass: true },
      backward: { lisInPeriod: 1, missingFromStatement: 0, missingCaseNos: [], pass: true },
    },
    golden: { expected: null, computed: 100, diff: null, pass: null },
    status: 'ready',
    failures: [],
  },
  needsAttention: [],
}

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'q1',
    fileName: '测试医院-2026年5月.xlsx',
    grid: [['客户：测试医院']],
    partnerId: 'P-1',
    suggestedName: '测试医院',
    month: '2026-05',
    preview,
    committed: null,
    error: '',
    configVersion: 1,
    lines: [],
    status: 'ready',
    ...overrides,
  }
}

function queue(active: QueueItem, commit = vi.fn()) {
  return {
    queue: [active], active, activeId: active.id, setActiveId: vi.fn(), busy: false,
    addFile: vi.fn(), addFiles: vi.fn(), setPartner: vi.fn(), setMonth: vi.fn(), classify: vi.fn(),
    commit, removeItem: vi.fn(), runPreview: vi.fn(),
  }
}

function renderPage() {
  return render(<MemoryRouter><ImportWizardPage /></MemoryRouter>)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.lisCoverage.mockResolvedValue({ total: 1, withBlocks: 1, inPeriod: 1 })
})

describe('ImportWizardPage — 明确旁路理由与失败态', () => {
  it('NEEDS_CONFIRM 后必须填写理由，确认请求携带同一条理由', async () => {
    const active = item()
    const confirmation = {
      kind: 'confirm',
      itemId: active.id,
      partnerId: active.partnerId,
      serviceMonth: active.month,
      message: '历史份额变化超过阈值，请人工确认本次入库',
    }
    const commit = vi.fn().mockResolvedValueOnce(confirmation).mockResolvedValueOnce('ok')
    mocks.useImportQueue.mockReturnValue(queue(active, commit))
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '入库这一家' }))
    await screen.findByText(confirmation.message)

    const reason = screen.getByLabelText('确认理由')
    const confirm = screen.getByRole('button', { name: '确认入库（含未识别）' })
    expect(confirm).toBeDisabled()
    fireEvent.change(reason, { target: { value: '无独立合计行，财务已逐行复核' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2))
    expect(commit).toHaveBeenNthCalledWith(1, active, false, undefined)
    expect(commit).toHaveBeenNthCalledWith(2, active, true, '无独立合计行，财务已逐行复核')
  })

  it('提交失败态保留只读诊断，但禁止再次入库和写回归类', () => {
    const active = item({
      status: 'error',
      error: '配置版本冲突',
      preview: { ...preview, needsAttention: [{ no: 'CASE-1', item: '未知项目', settle: 100, status: 'unmatched' }] },
    })
    mocks.useImportQueue.mockReturnValue(queue(active))
    renderPage()

    expect(screen.getByText('配置版本冲突')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '入库这一家' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '写回归类' })).toBeDisabled()
  })

  it('旧队列项的延迟确认不得显示到后来切换的队列项', async () => {
    const first = item({ id: 'q1', fileName: 'A.xlsx' })
    const second = item({ id: 'q2', fileName: 'B.xlsx' })
    const pending = deferred<CommitOutcome>()
    const commit = vi.fn().mockReturnValueOnce(pending.promise)
    let current = queue(first, commit)
    mocks.useImportQueue.mockImplementation(() => current)
    const view = renderPage()

    fireEvent.click(screen.getByRole('button', { name: '入库这一家' }))
    current = queue(second, commit)
    view.rerender(<MemoryRouter><ImportWizardPage /></MemoryRouter>)
    const message = 'A 医院历史份额异常，需要确认'
    await act(async () => {
      pending.resolve({ kind: 'confirm', itemId: first.id, partnerId: first.partnerId, serviceMonth: first.month, message })
      await pending.promise
    })

    expect(screen.queryByText(message)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('确认理由')).not.toBeInTheDocument()
  })
})
