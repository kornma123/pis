import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AlertHandleModal } from './AlertHandleModal'
import type { AlertItem } from '../hooks/useAlertsPage'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname + loc.search}</div>
}

function makeAlert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: 'a-1',
    type: 'expiry',
    level: 'warning',
    materialId: 'mat-1',
    materialName: '试剂A',
    currentStock: 2,
    threshold: 10,
    message: '即将过期',
    status: 'pending',
    createdAt: new Date().toISOString(),
    batchNo: 'B-202606',
    ...overrides,
  } as AlertItem
}

function renderModal(alert: AlertItem) {
  const onClose = vi.fn()
  const view = render(
    <MemoryRouter initialEntries={['/alerts']}>
      <AlertHandleModal
        open
        alert={alert}
        form={{ opinion: '', result: 'purchased' }}
        onClose={onClose}
        onChange={vi.fn()}
        onConfirm={vi.fn()}
      />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  )
  return { ...view, onClose }
}

describe('AlertHandleModal — P1-02 过期预警→报废深链', () => {
  beforeEach(() => {
    localStorage.setItem('user', JSON.stringify({ capabilities: { scraps: 'W' } }))
  })

  it('过期预警显示「去报废」按钮', () => {
    renderModal(makeAlert())
    expect(screen.getByRole('button', { name: /去报废/ })).toBeInTheDocument()
  })

  it('点击「去报废」导航到 /scraps 并带 materialId/batchId/reason=expired', () => {
    renderModal(makeAlert())
    fireEvent.click(screen.getByRole('button', { name: /去报废/ }))
    const loc = screen.getByTestId('location').textContent || ''
    expect(loc.startsWith('/scraps?')).toBe(true)
    const params = new URLSearchParams(loc.split('?')[1])
    expect(params.get('materialId')).toBe('mat-1')
    expect(params.get('batchId')).toBe('B-202606')
    expect(params.get('reason')).toBe('expired')
  })

  it('非过期预警（低库存）不显示「去报废」按钮', () => {
    renderModal(makeAlert({ type: 'low-stock' }))
    expect(screen.queryByRole('button', { name: /去报废/ })).toBeNull()
  })

  it('只有 scraps:W 才显示报废入口', () => {
    localStorage.setItem('user', JSON.stringify({ capabilities: { scraps: 'R' } }))
    renderModal(makeAlert())
    expect(screen.queryByRole('button', { name: /去报废/ })).toBeNull()
  })

  it('无批次号时仍带 materialId 与 reason，但不带 batchId', () => {
    renderModal(makeAlert({ batchNo: undefined }))
    fireEvent.click(screen.getByRole('button', { name: /去报废/ }))
    const loc = screen.getByTestId('location').textContent || ''
    const params = new URLSearchParams(loc.split('?')[1])
    expect(params.get('materialId')).toBe('mat-1')
    expect(params.get('reason')).toBe('expired')
    expect(params.has('batchId')).toBe(false)
  })

  it('提供命名对话框、初始焦点与 Escape 关闭键盘路径', () => {
    const { onClose } = renderModal(makeAlert())
    expect(screen.getByRole('dialog', { name: '处理或忽略预警' })).toBeInTheDocument()
    expect(screen.getByLabelText('处理意见 *')).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
