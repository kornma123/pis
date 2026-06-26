import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import BudgetManagement from './BudgetManagement'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getBudgets: vi.fn(),
    createBudget: vi.fn(),
    updateBudget: vi.fn(),
  },
}))

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}))

describe('BudgetManagement side effects', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/')
    vi.mocked(abcApi.getBudgets).mockReset()
    vi.mocked(abcApi.createBudget).mockReset()
    vi.mocked((abcApi as any).updateBudget).mockReset()
    vi.mocked(abcApi.getBudgets).mockResolvedValue({
      list: [
        {
          id: 'budget-1',
          yearMonth: '2026-06',
          category: 'material',
          budgetAmount: 1000,
          actualAmount: 250,
          description: '本月重点试剂预算口径',
          status: 'active',
        },
      ],
    })
    vi.mocked(abcApi.createBudget).mockResolvedValue({ id: 'created-budget' })
    vi.mocked((abcApi as any).updateBudget).mockResolvedValue({ id: 'budget-1' })
  })

  it('derives execution rate from real API data and updates the selected budget instead of creating a duplicate', async () => {
    render(<BudgetManagement />)

    const rowLabel = await screen.findByText('材料成本')
    const budgetRow = rowLabel.closest('tr')
    expect(budgetRow).not.toBeNull()
    expect(within(budgetRow as HTMLTableRowElement).getByText('25.0%')).toBeInTheDocument()

    fireEvent.click(within(budgetRow as HTMLTableRowElement).getByRole('button', { name: '编辑' }))
    expect(await screen.findByRole('dialog', { name: '编辑预算' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('spinbutton', { name: '预算金额 (元) *' }), { target: { value: '1200' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '实际金额 (元)' }), { target: { value: '275' } })
    fireEvent.change(screen.getByRole('textbox', { name: /口径说明/ }), { target: { value: '更新后的预算口径说明' } })
    fireEvent.click(screen.getByRole('button', { name: '更新' }))

    await waitFor(() => {
      expect((abcApi as any).updateBudget).toHaveBeenCalledWith('budget-1', {
        yearMonth: '2026-06',
        category: 'material',
        budgetAmount: 1200,
        actualAmount: 275,
        description: '更新后的预算口径说明',
      })
    })
    expect(abcApi.createBudget).not.toHaveBeenCalled()
  })

  it('creates a budget with actual amount and an explainable budget note', async () => {
    render(<BudgetManagement />)
    await screen.findByText('材料成本')

    fireEvent.click(screen.getByRole('button', { name: '新增预算' }))
    expect(await screen.findByRole('dialog', { name: '新增预算' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('spinbutton', { name: '预算金额 (元) *' }), { target: { value: '3200' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '实际金额 (元)' }), { target: { value: '800' } })
    fireEvent.change(screen.getByRole('textbox', { name: /口径说明/ }), { target: { value: '新增质控预算说明' } })
    expect(screen.getByText('预算结果确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：成本预算、成本看板、执行进度、成本预警、审计记录')).toBeInTheDocument()
    expect(screen.getByText('成本类型 总预算')).toBeInTheDocument()
    expect(screen.getByText('预算金额 ¥3,200.00')).toBeInTheDocument()
    expect(screen.getByText('实际金额 ¥800.00')).toBeInTheDocument()
    expect(screen.getByText('执行率 25.0%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(abcApi.createBudget).toHaveBeenCalledWith({
        yearMonth: expect.any(String),
        category: 'total',
        budgetAmount: 3200,
        actualAmount: 800,
        description: '新增质控预算说明',
      })
    })
  })

  it('blocks creating a budget without an explainable budget note', async () => {
    render(<BudgetManagement />)
    await screen.findByText('材料成本')

    fireEvent.click(screen.getByRole('button', { name: '新增预算' }))
    expect(await screen.findByRole('dialog', { name: '新增预算' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('spinbutton', { name: '预算金额 (元) *' }), { target: { value: '3200' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '实际金额 (元)' }), { target: { value: '800' } })

    expect(screen.getByText('请填写口径说明，系统才能解释预算来源、实际金额口径和审计依据。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled()
    expect(abcApi.createBudget).not.toHaveBeenCalled()
  })

  it('opens the saved budget after creation so finance can confirm the tracked budget fact', async () => {
    const createdBudget = {
      id: 'budget-created',
      yearMonth: '2026-06',
      category: 'indirect',
      budgetAmount: 3200,
      actualAmount: 800,
      description: '新增间接成本预算说明',
      status: 'active',
    }
    vi.mocked(abcApi.createBudget).mockResolvedValueOnce({ id: 'budget-created' })
    vi.mocked(abcApi.getBudgets)
      .mockResolvedValueOnce({
        list: [{
          id: 'budget-1',
          yearMonth: '2026-06',
          category: 'material',
          budgetAmount: 1000,
          actualAmount: 250,
          description: '本月重点试剂预算口径',
          status: 'active',
        }],
      })
      .mockResolvedValue({ list: [createdBudget] })

    render(<BudgetManagement />)
    await screen.findByText('材料成本')

    fireEvent.click(screen.getByRole('button', { name: '新增预算' }))
    expect(await screen.findByRole('dialog', { name: '新增预算' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('月份 *'), { target: { value: '2026-06' } })
    fireEvent.change(screen.getByLabelText('成本类型 *'), { target: { value: 'indirect' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '预算金额 (元) *' }), { target: { value: '3200' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '实际金额 (元)' }), { target: { value: '800' } })
    fireEvent.change(screen.getByRole('textbox', { name: /口径说明/ }), { target: { value: '新增间接成本预算说明' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(abcApi.createBudget).toHaveBeenCalledWith({
        yearMonth: '2026-06',
        category: 'indirect',
        budgetAmount: 3200,
        actualAmount: 800,
        description: '新增间接成本预算说明',
      })
    })
    await waitFor(() => {
      expect(abcApi.getBudgets).toHaveBeenLastCalledWith({
        yearMonth: '2026-06',
        keyword: 'budget-created',
      })
    })
    expect(screen.getByPlaceholderText('搜索预算类型...')).toHaveValue('budget-created')
    expect(screen.getByDisplayValue('2026-06')).toBeInTheDocument()
    expect(await screen.findByText('间接成本')).toBeInTheDocument()
    expect(screen.getByText('新增间接成本预算说明')).toBeInTheDocument()
  })

  it('uses URL keyword to load and keep the audit-linked budget visible', async () => {
    window.history.pushState({}, '', '/abc/budgets?keyword=budget-1')
    render(<BudgetManagement />)

    await waitFor(() => {
      expect(abcApi.getBudgets).toHaveBeenCalledWith({ keyword: 'budget-1' })
    })
    expect(screen.getByPlaceholderText('搜索预算类型...')).toHaveValue('budget-1')
    expect(await screen.findByText('材料成本')).toBeInTheDocument()
    expect(screen.getByText('本月重点试剂预算口径')).toBeInTheDocument()
  })
})
