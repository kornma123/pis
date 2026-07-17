import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboundRecord } from '@/types'
import Outbound from './Outbound'

const mocks = vi.hoisted(() => ({
  record: null as unknown as OutboundRecord,
  refresh: vi.fn(),
  setMultiple: vi.fn(),
}))

vi.mock('@/hooks/useUrlParams', () => ({
  useUrlParams: () => ({
    get: () => '',
    getNumber: (_key: string, fallback: number) => fallback,
    setMultiple: mocks.setMultiple,
  }),
}))

vi.mock('@/hooks/usePagination', () => ({
  usePagination: () => ({
    data: [mocks.record],
    loading: false,
    page: 1,
    pageSize: 10,
    total: 1,
    setPage: vi.fn(),
    setPageSize: vi.fn(),
    refresh: mocks.refresh,
  }),
}))

vi.mock('@/api/inventory', () => ({
  outboundApi: {
    getStats: () => Promise.resolve({
      monthTotal: 1,
      completed: 1,
      pending: 0,
      cancelled: 0,
    }),
  },
}))

vi.mock('@/api/master', () => ({
  materialApi: { getList: () => Promise.resolve({ list: [] }) },
  projectApi: { getList: () => Promise.resolve({ list: [] }) },
}))

vi.mock('./components/OutboundTable', () => ({
  default: ({ onPrintRecord }: { onPrintRecord: (record: OutboundRecord) => void }) => (
    <button type="button" data-testid="print-record" onClick={() => onPrintRecord(mocks.record)}>
      打印测试单据
    </button>
  ),
}))

vi.mock('./components/OutboundStats', () => ({ default: () => null }))
vi.mock('./components/OutboundQuickFilters', () => ({ default: () => null }))
vi.mock('./components/OutboundFilterBar', () => ({ default: () => null }))
vi.mock('./components/OutboundFormModal', () => ({ default: () => null }))
vi.mock('./components/OutboundDetailModal', () => ({ default: () => null }))
vi.mock('./components/OutboundCancelModal', () => ({ default: () => null }))
vi.mock('./components/OutboundDeleteModal', () => ({ default: () => null }))

const SCRIPT_PAYLOAD = '</td><script>window.__outboundXss = true</script>'
const IMAGE_PAYLOAD = '<img src=x onerror="window.__outboundXss = true">'
const SPECIAL_CHARACTERS = `& < > " '`

function createRecord(overrides: Partial<OutboundRecord> = {}): OutboundRecord {
  return {
    id: 'out-001',
    outboundNo: 'OUT-20260717-001',
    type: 'project',
    projectId: 'project-001',
    projectName: '中文项目',
    items: [
      {
        id: 'item-001',
        outboundId: 'out-001',
        materialId: 'material-001',
        materialName: '中文物料',
        batchId: 'batch-001',
        batchNo: '批次-001',
        quantity: 2,
        unit: '盒',
        unitCost: 12.5,
        totalCost: 25,
      },
    ],
    totalCost: 25,
    operator: '张三',
    status: 'completed',
    remark: '正常备注',
    createdAt: '2026-07-17T08:00:00.000Z',
    ...overrides,
  }
}

function arrangePrintWindow() {
  const printDocument = document.implementation.createHTMLDocument('')
  const print = vi.fn()
  const focus = vi.fn()
  const printWindow = {
    document: printDocument,
    print,
    focus,
    opener: window,
  } as unknown as Window
  const open = vi.spyOn(window, 'open').mockReturnValue(printWindow)

  return { focus, open, print, printDocument, printWindow }
}

function printCurrentRecord() {
  render(<Outbound />)
  fireEvent.click(screen.getByTestId('print-record'))
}

describe('Outbound print security', () => {
  beforeEach(() => {
    mocks.record = createRecord()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('renders hostile business fields only as text without script or event-handler nodes', () => {
    mocks.record = createRecord({
      outboundNo: `OUT ${SPECIAL_CHARACTERS}`,
      projectName: SCRIPT_PAYLOAD,
      operator: IMAGE_PAYLOAD,
      remark: `备注 ${SPECIAL_CHARACTERS} ${SCRIPT_PAYLOAD}`,
      items: [
        {
          ...createRecord().items[0],
          materialName: IMAGE_PAYLOAD,
          batchNo: SCRIPT_PAYLOAD,
          unit: SPECIAL_CHARACTERS,
        },
      ],
    })
    const { printDocument } = arrangePrintWindow()

    printCurrentRecord()

    expect(printDocument.querySelector('script')).toBeNull()
    expect(printDocument.querySelector('img')).toBeNull()
    expect(printDocument.querySelector('[onerror], [onload], [onclick]')).toBeNull()
    expect(printDocument.body.textContent).toContain(SCRIPT_PAYLOAD)
    expect(printDocument.body.textContent).toContain(IMAGE_PAYLOAD)
    expect(printDocument.body.textContent).toContain(SPECIAL_CHARACTERS)
  })

  it('opens an isolated print window and avoids markup injection APIs', () => {
    const { open, printWindow } = arrangePrintWindow()

    printCurrentRecord()

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(printWindow.opener).toBeNull()

    const source = [
      readFileSync(join(process.cwd(), 'src/pages/outbound/Outbound.tsx'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/pages/outbound/Outbound.print.ts'), 'utf8'),
    ].join('\n')
    expect(source).not.toMatch(/\bdocument\s*\.\s*write\s*\(/)
    expect(source).not.toMatch(/\.innerHTML\s*=/)
  })

  it('keeps normal Chinese content, empty-value fallbacks, and the print action working', () => {
    mocks.record = createRecord({
      projectName: '',
      operator: '',
      remark: '',
      items: [
        {
          ...createRecord().items[0],
          materialName: undefined,
          batchNo: undefined,
          unit: '',
        },
      ],
    })
    const { focus, print, printDocument } = arrangePrintWindow()

    printCurrentRecord()

    expect(printDocument.body.textContent).toContain('出库单')
    expect(printDocument.body.textContent).toContain('项目：-')
    expect(printDocument.body.textContent).toContain('操作人：- | 备注：无')
    expect(printDocument.body.textContent).toContain('本单据由 COREONE 系统自动生成')
    expect(focus).toHaveBeenCalledOnce()
    expect(print).toHaveBeenCalledOnce()
  })
})
