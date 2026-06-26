import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LogDetailModal } from './LogDetailModal'
import type { OperationLog } from '@/types'

const getLogType = () => ({ value: 'update', label: '更新', className: 'bg-blue-50' })
const getModuleLabel = (m: string) => m || '系统'

function makeLog(requestData: Record<string, unknown>): OperationLog {
  return {
    id: 'log-1',
    username: 'admin',
    operation: 'update',
    description: '更新物料',
    ip: '127.0.0.1',
    userAgent: 'jest',
    createdAt: new Date('2026-06-26T10:00:00Z').toISOString(),
    requestData,
  } as unknown as OperationLog
}

function renderModal(requestData: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <LogDetailModal
        open
        log={makeLog(requestData)}
        getLogType={getLogType}
        getModuleLabel={getModuleLabel}
        onClose={vi.fn()}
      />
    </MemoryRouter>
  )
}

describe('LogDetailModal — P1-03 嵌套对象渲染', () => {
  it('对象值渲染为格式化 JSON，不是 [object Object]', () => {
    renderModal({ before: { stock: 10, name: '试剂A' } })
    // 不应出现 [object Object]
    expect(screen.queryByText('[object Object]')).toBeNull()
    // 应出现 JSON 化后的字段内容
    const pre = document.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('"stock": 10')
    expect(pre!.textContent).toContain('"name": "试剂A"')
  })

  it('before/after 嵌套对象均被 JSON 化', () => {
    renderModal({
      before: { stock: 10 },
      after: { stock: 5 },
    })
    expect(screen.queryByText('[object Object]')).toBeNull()
    const pres = Array.from(document.querySelectorAll('pre'))
    const combined = pres.map((p) => p.textContent).join('\n')
    expect(combined).toContain('"stock": 10')
    expect(combined).toContain('"stock": 5')
  })

  it('数组值也被 JSON 化', () => {
    renderModal({ items: [{ id: 1 }, { id: 2 }] })
    const pre = document.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('"id": 1')
    expect(pre!.textContent).toContain('"id": 2')
  })

  it('原始值仍原样渲染（不包 pre）', () => {
    renderModal({ module: 'materials', count: 3 })
    // 在「变更详情」表格中，原始值直接作为单元格文本，且不被 pre 包裹
    const cells = Array.from(document.querySelectorAll('table td'))
    const stringCell = cells.find((c) => c.textContent === 'materials')
    const numberCell = cells.find((c) => c.textContent === '3')
    expect(stringCell).toBeTruthy()
    expect(numberCell).toBeTruthy()
    expect(stringCell!.querySelector('pre')).toBeNull()
    expect(numberCell!.querySelector('pre')).toBeNull()
  })
})
