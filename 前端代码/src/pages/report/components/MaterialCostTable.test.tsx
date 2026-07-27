import { render, screen, within } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MaterialCostTable } from './MaterialCostTable'

const baseMaterial = {
  id: 'm1',
  name: '测试物料',
  spec: 'SP-500',
  consumption: 10,
  consumptionUnit: '盒',
  totalCost: 1234.5,
  ratio: 0.25,
}

function renderTable(changeRate: unknown) {
  const data = [{ ...baseMaterial, changeRate: changeRate as number | undefined }]
  render(
    <MaterialCostTable
      loading={false}
      data={data}
      total={1}
      page={1}
      pageSize={10}
      searchText=""
      onSearchTextChange={vi.fn()}
      onPageChange={vi.fn()}
      onPageSizeChange={vi.fn()}
    />,
  )
  const row = screen.getByText('测试物料').closest('tr')
  expect(row).not.toBeNull()
  // 表格列序：物料名称/规格型号/消耗数量/消耗金额/占比/同比变化
  return within(row as HTMLElement).getAllByRole('cell')[5]
}

describe('MaterialCostTable 同比变化 fail-closed', () => {
  it('changeRate 为 null 时显示不可计算，不得伪造 0 或趋势数字', () => {
    const cell = renderTable(null)
    expect(cell).toHaveTextContent('不可计算')
    expect(cell).not.toHaveTextContent('%')
  })

  it('changeRate 缺失（undefined）时显示不可计算', () => {
    const cell = renderTable(undefined)
    expect(cell).toHaveTextContent('不可计算')
    expect(cell).not.toHaveTextContent('%')
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['字符串', 'abc'],
    ['数字形态字符串', '12'],
  ])('changeRate 为 malformed（%s）时显示不可计算', (_label, value) => {
    const cell = renderTable(value)
    expect(cell).toHaveTextContent('不可计算')
    expect(cell).not.toHaveTextContent('%')
  })

  it('changeRate 为合法 0 时必须显示 0%，不得吞掉', () => {
    const cell = renderTable(0)
    expect(cell).toHaveTextContent('0%')
    expect(cell).not.toHaveTextContent('不可计算')
  })

  it('changeRate 为合法正数时保持原语义（+12%）', () => {
    const cell = renderTable(12)
    expect(cell).toHaveTextContent('+12%')
    expect(cell).not.toHaveTextContent('不可计算')
  })

  it('changeRate 为合法负数时保持原语义（-8%）', () => {
    const cell = renderTable(-8)
    expect(cell).toHaveTextContent('-8%')
    expect(cell).not.toHaveTextContent('不可计算')
  })

  it('不可计算输出在重复渲染间保持稳定（无随机数）', () => {
    const props = {
      loading: false,
      data: [{ ...baseMaterial, changeRate: null as unknown as number }],
      total: 1,
      page: 1,
      pageSize: 10,
      searchText: '',
      onSearchTextChange: vi.fn(),
      onPageChange: vi.fn(),
      onPageSizeChange: vi.fn(),
    }
    const { rerender } = render(<MaterialCostTable {...props} />)
    const cellText = () => {
      const row = screen.getByText('测试物料').closest('tr') as HTMLElement
      return within(row).getAllByRole('cell')[5].textContent
    }
    const first = cellText()
    rerender(<MaterialCostTable {...props} />)
    const second = cellText()
    expect(first).toBe('不可计算')
    expect(second).toBe('不可计算')
    expect(first).toBe(second)
  })
})
