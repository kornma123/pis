import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inboundApi } from '@/api/inventory'
import type { Location, Material } from '@/types'
import ImportInboundModal from './ImportInboundModal'
import { INBOUND_IMPORT_HEADERS } from '../importInboundModel'
import { readImportWorkflowJournal } from '../../import-shared/importWorkflowJournal'

vi.mock('@/api/inventory', () => ({ inboundApi: { create: vi.fn() } }))
vi.mock('@/api/request', () => ({ genIdempotencyKey: vi.fn(() => 'idem-ui-row-1') }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

const materials: Material[] = [{
  id: 'mat-1', code: 'M001', name: '试剂 A', spec: '', unit: '盒', price: 0,
  stock: 0, minStock: 0, maxStock: 0, safetyStock: 0, categoryId: 'cat-1',
  status: 'active', createdAt: '', updatedAt: '',
}]
const locations: Location[] = [{
  id: 'loc-1', code: 'L001', name: '冷藏一号', type: 'fridge', zone: 'A',
  capacity: 100, used: 0, status: 'active', createdAt: '',
}]
const validCsv = `${INBOUND_IMPORT_HEADERS.join(',')}\r\nM001,2,L001,B-1,0,,,,UI 导入`

function fileLike(name: string, text: string): File {
  return { name, text: vi.fn().mockResolvedValue(text) } as unknown as File
}

function renderModal() {
  const onClose = vi.fn()
  const onSuccess = vi.fn()
  const view = render(
    <ImportInboundModal
      onClose={onClose}
      onSuccess={onSuccess}
      materials={materials}
      locations={locations}
    />,
  )
  return {
    ...view,
    input: view.container.querySelector('input[type="file"]') as HTMLInputElement,
    onClose,
    onSuccess,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
})

describe('ImportInboundModal', () => {
  it('requires local validation and explicit confirmation, and locks duplicate submit clicks', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined
    vi.mocked(inboundApi.create).mockImplementation(() => new Promise(resolve => { resolveCreate = resolve }))
    const { input, onSuccess } = renderModal()
    const fileButton = screen.getByRole('button', { name: /选择或拖放 CSV 文件/ })
    fileButton.focus()
    expect(fileButton).toHaveFocus()

    fireEvent.change(input, { target: { files: [fileLike('direct.csv', validCsv)] } })
    await screen.findByText(/本地校验完成：共 1 行，1 行可提交/)
    expect(screen.getByText('0')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '核对并确认' }))
    fireEvent.click(screen.getByRole('checkbox'))
    const submit = screen.getByRole('button', { name: '确认并开始逐行入库' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => expect(inboundApi.create).toHaveBeenCalledTimes(1))
    expect(inboundApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct', materialId: 'mat-1', locationId: 'loc-1', price: 0 }),
      'idem-ui-row-1',
    )
    expect(onSuccess).not.toHaveBeenCalled()

    await act(async () => resolveCreate?.({ inboundNo: 'IB-UI-1' }))
    await screen.findByText(/文件 1 行：成功 1 行，服务失败 0 行，校验拒绝 0 行/)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('clears a previously valid confirmation immediately when a new invalid file is selected', async () => {
    const { input } = renderModal()

    fireEvent.change(input, { target: { files: [fileLike('first.csv', validCsv)] } })
    await screen.findByRole('button', { name: '核对并确认' })
    fireEvent.click(screen.getByRole('button', { name: '核对并确认' }))
    expect(screen.getByRole('checkbox')).toBeInTheDocument()

    fireEvent.change(input, { target: { files: [fileLike('replacement.xlsx', validCsv)] } })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('仅支持 CSV 文件')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '确认并开始逐行入库' })).toBeNull()
  })

  it('submits only valid rows from a mixed file and reports validation rejects separately', async () => {
    vi.mocked(inboundApi.create).mockResolvedValue({ inboundNo: 'IB-MIXED-1' })
    const mixedCsv = `${INBOUND_IMPORT_HEADERS.join(',')}\r\nM001,2,L001,B-1,0,,,,可入库\r\nUNKNOWN,1,L001,B-2,0,,,,拒绝`
    const { input } = renderModal()

    fireEvent.change(input, { target: { files: [fileLike('mixed.csv', mixedCsv)] } })
    await screen.findByText(/共 2 行，1 行可提交，1 行需修正/)

    const review = screen.getByRole('button', { name: '核对并确认' })
    expect(review).toBeEnabled()
    fireEvent.click(review)
    expect(screen.getByText(/只提交 1 行；另有 1 行校验拒绝/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '确认并开始逐行入库' }))

    await screen.findByText(/文件 2 行：成功 1 行，服务失败 0 行，校验拒绝 1 行/)
    expect(inboundApi.create).toHaveBeenCalledTimes(1)
    expect(readImportWorkflowJournal('direct-inbound')).toMatchObject({
      kind: 'direct-inbound',
      phase: 'settled',
      fileName: 'mixed.csv',
      summary: { total: 2, succeeded: 1, failed: 0, validationRejected: 1 },
    })
  })

  it('restores a minimal completed receipt after leaving without retaining source rows', async () => {
    vi.mocked(inboundApi.create).mockResolvedValue({ inboundNo: 'IB-RECOVER-1' })
    const first = renderModal()
    fireEvent.change(first.input, { target: { files: [fileLike('recover.csv', validCsv)] } })
    await screen.findByRole('button', { name: '核对并确认' })
    fireEvent.click(screen.getByRole('button', { name: '核对并确认' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '确认并开始逐行入库' }))
    await screen.findByText(/成功 1 行/)
    first.unmount()

    renderModal()
    expect(screen.getByRole('status')).toHaveTextContent('上次直接入库回执')
    expect(screen.getByRole('status')).toHaveTextContent('IB-RECOVER-1')
    expect(window.sessionStorage.getItem('coreone.import-workflow.direct-inbound.v1')).not.toContain('物料编码')
  })
})
