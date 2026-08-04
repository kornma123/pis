import { render, screen, within } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectCostReport } from '@/types'
import { ProjectCostTable } from './ProjectCostTable'

type ProjectRow = ProjectCostReport['projects'][number]

const baseProject: ProjectRow = {
  id: 'p1',
  name: '测试项目',
  category: 'molecular',
  sampleCount: 100,
  unitCost: 50,
  totalCost: 5000,
  ratio: 0.4,
}

/**
 * 生产上 axios 拦截器返回未校验的运行时 payload（useCostAnalysisPage 以 any 接收），
 * 静态类型只是合同声明。fromWire 显式模拟这唯一一处不可信边界，仅用于注入
 * 违反合同的 malformed 输入；合同内取值（null / 缺失 / 有限数字 / NaN / ±Infinity）
 * 在 number | null 合同下本就合法，一律不使用任何 cast。
 */
function fromWire(rows: unknown[]): ProjectRow[] {
  return rows as ProjectRow[]
}

function renderAndGetChangeCell(data: ProjectRow[]) {
  render(
    <ProjectCostTable
      loading={false}
      data={data}
      total={data.length}
      page={1}
      pageSize={10}
      searchText=""
      projectFilter=""
      dataSource="lis"
      onSearchTextChange={vi.fn()}
      onProjectFilterChange={vi.fn()}
      onDataSourceChange={vi.fn()}
      onPageChange={vi.fn()}
      onPageSizeChange={vi.fn()}
      onOpenDetail={vi.fn()}
    />,
  )
  const row = screen.getByText('测试项目').closest('tr')
  expect(row).not.toBeNull()
  return within(row as HTMLElement).getByTestId('project-change-rate')
}

function expectUncomputable(cell: HTMLElement) {
  expect(cell).toHaveTextContent('不可计算')
  expect(cell).not.toHaveTextContent('%')
  // 不得渲染任何趋势 SVG（TrendingUp/TrendingDown/Minus 均不允许）
  expect(cell.querySelector('svg')).toBeNull()
}

describe('ProjectCostTable 同比变化 fail-closed', () => {
  it('changeRate 为 null 时显示不可计算，不得伪造 0、随机数或趋势', () => {
    const cell = renderAndGetChangeCell([{ ...baseProject, changeRate: null }])
    expectUncomputable(cell)
  })

  it('changeRate 缺失（键不存在）时显示不可计算', () => {
    const cell = renderAndGetChangeCell([{ ...baseProject }])
    expectUncomputable(cell)
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('changeRate 为非有限数字（%s）时显示不可计算', (_label, value) => {
    const cell = renderAndGetChangeCell([{ ...baseProject, changeRate: value }])
    expectUncomputable(cell)
  })

  it.each([
    ['字符串', 'abc'],
    ['数字形态字符串', '12'],
    ['对象 {}', {}],
    ['数组 []', []],
  ])('changeRate 为合同外 malformed（%s）时显示不可计算', (_label, value) => {
    const cell = renderAndGetChangeCell(fromWire([{ ...baseProject, changeRate: value }]))
    expectUncomputable(cell)
  })

  it('changeRate 为合法 0 时必须显示 0%，不得吞掉', () => {
    const cell = renderAndGetChangeCell([{ ...baseProject, changeRate: 0 }])
    expect(cell).toHaveTextContent('0%')
    expect(cell).not.toHaveTextContent('不可计算')
    expect(cell.querySelector('svg')).not.toBeNull()
  })

  it('changeRate 为合法正数时保持原语义（+7%）', () => {
    const cell = renderAndGetChangeCell([{ ...baseProject, changeRate: 7 }])
    expect(cell).toHaveTextContent('+7%')
    expect(cell).not.toHaveTextContent('不可计算')
    expect(cell.querySelector('svg')).not.toBeNull()
  })

  it('changeRate 为合法负数时保持原语义（-5%）', () => {
    const cell = renderAndGetChangeCell([{ ...baseProject, changeRate: -5 }])
    expect(cell).toHaveTextContent('-5%')
    expect(cell).not.toHaveTextContent('不可计算')
    expect(cell.querySelector('svg')).not.toBeNull()
  })

  it('不可计算输出在重复渲染间保持稳定（无随机数）', () => {
    const data: ProjectRow[] = [{ ...baseProject, changeRate: null }]
    const props = {
      loading: false,
      data,
      total: 1,
      page: 1,
      pageSize: 10,
      searchText: '',
      projectFilter: '',
      dataSource: 'lis' as const,
      onSearchTextChange: vi.fn(),
      onProjectFilterChange: vi.fn(),
      onDataSourceChange: vi.fn(),
      onPageChange: vi.fn(),
      onPageSizeChange: vi.fn(),
      onOpenDetail: vi.fn(),
    }
    const { rerender } = render(<ProjectCostTable {...props} />)
    const cellText = () => {
      const row = screen.getByText('测试项目').closest('tr') as HTMLElement
      return within(row).getByTestId('project-change-rate').textContent
    }
    const first = cellText()
    rerender(<ProjectCostTable {...props} />)
    const second = cellText()
    expect(first).toBe('不可计算')
    expect(second).toBe('不可计算')
    expect(first).toBe(second)
  })
})
