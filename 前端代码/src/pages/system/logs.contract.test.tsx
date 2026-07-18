import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useLogsPage: vi.fn() }))

vi.mock('./hooks/useLogsPage', () => ({
  useLogsPage: mocks.useLogsPage,
  LOG_TYPES: [],
  MODULES: [{ value: '', label: '全部模块' }],
}))

import Logs from './Logs'

function pageState(overrides: Record<string, unknown> = {}) {
  return {
    data: [], loading: false, error: null, total: 0, page: 1, pageSize: 20,
    setPage: vi.fn(), setPageSize: vi.fn(), refresh: vi.fn(),
    typeFilter: '', setTypeFilter: vi.fn(),
    moduleFilter: '', setModuleFilter: vi.fn(),
    userFilter: '', setUserFilter: vi.fn(),
    startDate: '', setStartDate: vi.fn(), endDate: '', setEndDate: vi.fn(),
    stats: { pageOps: 0, loginCount: 0, dataChanges: 0, activeUsers: 0 },
    handleSearch: vi.fn(), handleReset: vi.fn(), openDetail: vi.fn(),
    getLogType: () => ({ value: 'unknown', label: '未识别', className: 'bg-gray-100' }),
    getAvatarChar: () => '?', getModuleLabel: () => '系统',
    showDetail: false, detailLog: null, setShowDetail: vi.fn(),
    showExport: false, setShowExport: vi.fn(),
    exporting: false, exportError: null,
    exportForm: { format: 'xlsx', includeBasic: true, includeDetail: true, includeIP: false, includeDiff: false },
    setExportForm: vi.fn(), handleExport: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => mocks.useLogsPage.mockReturnValue(pageState()))

describe('Logs page truth labels and states', () => {
  it('labels KPI values as current-page statistics', () => {
    render(<Logs />)
    expect(screen.getByText('本页操作')).toBeInTheDocument()
    expect(screen.getByText('本页登录')).toBeInTheDocument()
    expect(screen.getByText('本页数据变更')).toBeInTheDocument()
    expect(screen.getByText('本页活跃用户')).toBeInTheDocument()
    expect(screen.queryByText('今日操作')).not.toBeInTheDocument()
  })

  it('shows the server error with a retry action instead of an empty-table message', () => {
    mocks.useLogsPage.mockReturnValue(pageState({ error: '日志服务不可用' }))
    render(<Logs />)
    expect(screen.getByText('日志服务不可用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    expect(screen.queryByText('暂无日志数据')).not.toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(screen.queryByText(/第 1 \/ 1 页/)).not.toBeInTheDocument()
  })

  it('exposes the real export form and delegates to the tested file-export handler', () => {
    mocks.useLogsPage.mockReturnValue(pageState({ showExport: true }))
    render(<Logs />)
    expect(screen.getByRole('button', { name: '导出日志' })).toBeInTheDocument()
    expect(screen.getByText('沿用当前页面已加载的操作类型、模块、用户和日期筛选')).toBeInTheDocument()
    expect(screen.getAllByLabelText('开始日期')).toHaveLength(1)
    expect(screen.getAllByLabelText('结束日期')).toHaveLength(1)
    expect(screen.getByRole('checkbox', { name: /请求响应原文/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    expect(mocks.useLogsPage.mock.results.at(-1)?.value.handleExport).toHaveBeenCalledTimes(1)
  })
})
