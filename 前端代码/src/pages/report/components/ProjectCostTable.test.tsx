import { render, screen, within } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectCostTable } from './ProjectCostTable'

const baseProject = {
  id: 'p1',
  name: '测试项目',
  category: 'molecular',
  sampleCount: 100,
  unitCost: 50,
  totalCost: 5000,
  ratio: 0.4,
}

function renderTable(changeRate: unknown) {
  const data = [{ ...baseProject, changeRate: changeRate as number | undefined }]
  render(
    <ProjectCostTable
      loading={false}
      data={data}
      total={1}
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
  // 表格列序：排名/检测项目/分类/成本金额/占比/病例数/单病例成本/同比变化/操作
  return within(row as HTMLElement).getAllByRole('cell')[7]
}

describe('ProjectCostTable 同比变化 fail-closed', () => {
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

  it('changeRate 为合法正数时保持原语义（+7%）', () => {
    const cell = renderTable(7)
    expect(cell).toHaveTextContent('+7%')
    expect(cell).not.toHaveTextContent('不可计算')
  })

  it('changeRate 为合法负数时保持原语义（-5%）', () => {
    const cell = renderTable(-5)
    expect(cell).toHaveTextContent('-5%')
    expect(cell).not.toHaveTextContent('不可计算')
  })

  it('不可计算输出在重复渲染间保持稳定（无随机数）', () => {
    const props = {
      loading: false,
      data: [{ ...baseProject, changeRate: null as unknown as number }],
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
      return within(row).getAllByRole('cell')[7].textContent
    }
    const first = cellText()
    rerender(<ProjectCostTable {...props} />)
    const second = cellText()
    expect(first).toBe('不可计算')
    expect(second).toBe('不可计算')
    expect(first).toBe(second)
  })
})
