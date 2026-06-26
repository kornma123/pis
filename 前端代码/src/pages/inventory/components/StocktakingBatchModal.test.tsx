import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StocktakingBatchModal } from './StocktakingBatchModal'
import type { Material } from '@/types'
import type { BatchRow } from '../hooks/useStocktakingPage'

function makeMaterial(id: string, code: string, stock: number): Material {
  return {
    id, code, name: `物料${code}`, spec: '', unit: '瓶', price: 10, stock,
    minStock: 0, maxStock: 999, safetyStock: 0, categoryId: 'CAT',
    status: 'active', createdAt: '', updatedAt: '',
  } as Material
}

const materials = [makeMaterial('M1', 'A', 100), makeMaterial('M2', 'B', 50)]

function renderModal(rows: BatchRow[], over: Partial<React.ComponentProps<typeof StocktakingBatchModal>> = {}) {
  const onRowsChange = vi.fn()
  const onSubmit = vi.fn()
  render(
    <StocktakingBatchModal
      open
      rows={rows}
      operator=""
      materials={materials}
      isSubmitting={false}
      onClose={vi.fn()}
      onRowsChange={onRowsChange}
      onOperatorChange={vi.fn()}
      onSubmit={onSubmit}
      {...over}
    />
  )
  return { onRowsChange, onSubmit }
}

describe('StocktakingBatchModal — P1-04 批量盘点', () => {
  it('提交按钮在无已填物料行时禁用', () => {
    renderModal([{ materialId: '', actualStock: '', remark: '' }])
    const btn = screen.getByRole('button', { name: /提交盘点/ })
    expect(btn).toBeDisabled()
  })

  it('已选物料后提交按钮可用，点击触发 onSubmit', () => {
    const { onSubmit } = renderModal([{ materialId: 'M1', actualStock: 90, remark: '' }])
    const btn = screen.getByRole('button', { name: /提交盘点/ })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('「添加一行」追加空行', () => {
    const { onRowsChange } = renderModal([{ materialId: 'M1', actualStock: 90, remark: '' }])
    fireEvent.click(screen.getByRole('button', { name: /添加一行/ }))
    expect(onRowsChange).toHaveBeenCalledWith([
      { materialId: 'M1', actualStock: 90, remark: '' },
      { materialId: '', actualStock: '', remark: '' },
    ])
  })

  it('显示实盘与账面的差异（实盘 90 - 账面 100 = -10）', () => {
    renderModal([{ materialId: 'M1', actualStock: 90, remark: '' }])
    expect(screen.getByText('-10')).toBeInTheDocument()
  })

  it('修改实盘数量时回传到 onRowsChange', () => {
    const { onRowsChange } = renderModal([{ materialId: 'M1', actualStock: '', remark: '' }])
    const input = screen.getByLabelText('实盘数量-1')
    fireEvent.change(input, { target: { value: '88' } })
    expect(onRowsChange).toHaveBeenCalledWith([{ materialId: 'M1', actualStock: 88, remark: '' }])
  })

  it('已选物料在其它行的下拉中禁用，避免重复选择', () => {
    renderModal([
      { materialId: 'M1', actualStock: 90, remark: '' },
      { materialId: '', actualStock: '', remark: '' },
    ])
    // 第 2 行下拉里 M1 选项应被禁用
    const select2 = screen.getByLabelText('物料-2') as HTMLSelectElement
    const m1Option = Array.from(select2.options).find(o => o.value === 'M1')
    expect(m1Option?.disabled).toBe(true)
  })
})
