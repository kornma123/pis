import { render, screen, within } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { MaterialCostReport } from '@/types'
import { MaterialCostTable } from './MaterialCostTable'

type MaterialRow = MaterialCostReport['materials'][number]

const baseMaterial: MaterialRow = {
  id: 'm1',
  name: '测试物料',
  spec: 'SP-500',
  consumption: 10,
  consumptionUnit: '盒',
  totalCost: 1234.5,
  ratio: 0.25,
}

/**
 * 生产上 axios 拦截器返回未校验的运行时 payload（useCostAnalysisPage 以 any 接收），
 * 静态类型只是合同声明。fromWire 显式模拟这唯一一处不可信边界，仅用于注入
 * 违反合同的 malformed 输入；合同内取值（null / 缺失 / 有限数字 / NaN / ±Infinity）
 * 在 number | null 合同下本就合法，一律不使用任何 cast。
 */
function fromWire(rows: unknown[]): MaterialRow[] {
  return rows as MaterialRow[]
}

function renderAndGetChangeCell(data: MaterialRow[]) {
  render(
    <MaterialCostTable
      loading={false}
      data={data}
      total={data.length}
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
  return within(row as HTMLElement).getByTestId('material-change-rate')
}

function expectUncomputable(cell: HTMLElement) {
  expect(cell).toHaveTextContent('不可计算')
  expect(cell).not.toHaveTextContent('%')
  // 不得渲染任何趋势 SVG（TrendingUp/TrendingDown/Minus 均不允许）
  expect(cell.querySelector('svg')).toBeNull()
}

describe('MaterialCostTable 同比变化 fail-closed', () => {
  it('changeRate 为 null 时显示不可计算，不得伪造 0、随机数或趋势', () => {
    const cell = renderAndGetChangeCell([{ ...baseMaterial, changeRate: null }])
    expectUncomputable(cell)
  })

  it('changeRate 缺失（键不存在）时显示不可计算', () => {
    const cell = renderAndGetChangeCell([{ ...baseMaterial }])
    expectUncomputable(cell)
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('changeRate 为非有限数字（%s）时显示不可计算', (_label, value) => {
    const cell = renderAndGetChangeCell([{ ...baseMaterial, changeRate: value }])
    expectUncomputable(cell)
  })

  it.each([
    ['字符串', 'abc'],
    ['数字形态字符串', '12'],
    ['对象 {}', {}],
    ['数组 []', []],
  ])('changeRate 为合同外 malformed（%s）时显示不可计算', (_label, value) => {
    const cell = renderAndGetChangeCell(fromWire([{ ...baseMaterial, changeRate: value }]))
    expectUncomputable(cell)
  })

  it('changeRate 为合法 0 时必须显示 0%，不得吞掉', () => {
    const cell = renderAndGetChangeCell([{ ...baseMaterial, changeRate: 0 }])
    expect(cell).toHaveTextContent('0%')
    expect(cell).not.toHaveTextContent('不可计算')
    expect(cell.querySelector('svg')).not.toBeNull()
  })

  it('changeRate 为合法正数时保持原语义（+12%）', () => {
    const cell = renderAndGetChangeCell([{ ...baseMaterial, changeRate: 12 }])
    expect(cell).toHaveTextContent('+12%')
    expect(cell).not.toHaveTextContent('不可计算')
    expect(cell.querySelector('svg')).not.toBeNull()
  })

  it('changeRate 为合法负数时保持原语义（-8%）', () => {
    const cell = renderAndGetChangeCell([{ ...baseMaterial, changeRate: -8 }])
    expect(cell).toHaveTextContent('-8%')
    expect(cell).not.toHaveTextContent('不可计算')
    expect(cell.querySelector('svg')).not.toBeNull()
  })

  it('不可计算输出在重复渲染间保持稳定（无随机数）', () => {
    const data: MaterialRow[] = [{ ...baseMaterial, changeRate: null }]
    const props = {
      loading: false,
      data,
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
      return within(row).getByTestId('material-change-rate').textContent
    }
    const first = cellText()
    rerender(<MaterialCostTable {...props} />)
    const second = cellText()
    expect(first).toBe('不可计算')
    expect(second).toBe('不可计算')
    expect(first).toBe(second)
  })
})
