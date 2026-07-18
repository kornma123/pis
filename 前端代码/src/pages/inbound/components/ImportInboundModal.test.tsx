import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inboundApi } from '@/api/inventory'
import type { Location, Material } from '@/types'
import ImportInboundModal from './ImportInboundModal'
import { INBOUND_IMPORT_HEADERS } from '../importInboundModel'

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
})

describe('ImportInboundModal', () => {
  it('requires local validation and explicit confirmation, and locks duplicate submit clicks', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined
    vi.mocked(inboundApi.create).mockImplementation(() => new Promise(resolve => { resolveCreate = resolve }))
    const { input, onSuccess } = renderModal()

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
    await screen.findByText(/提交结果：共 1 行，成功 1 行，失败 0 行/)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('clears a previously valid confirmation immediately when a new invalid file is selected', async () => {
    const { input } = renderModal()

    fireEvent.change(input, { target: { files: [fileLike('first.csv', validCsv)] } })
    await screen.findByRole('button', { name: '核对并确认' })
    fireEvent.click(screen.getByRole('button', { name: '核对并确认' }))
    expect(screen.getByRole('checkbox')).toBeInTheDocument()

    fireEvent.change(input, { target: { files: [fileLike('replacement.xlsx', validCsv)] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('仅支持 CSV 文件')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '确认并开始逐行入库' })).toBeNull()
  })
})
