import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityCenterList } from './ActivityCenterList'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('ActivityCenterList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
    localStorage.clear()
    localStorage.setItem('token', 'unit-token')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/v1/abc/activity-centers')) {
        return {
          json: async () => ({
            success: true,
            data: [
              {
                id: 'CENTER-PARENT-001',
                code: 'AC_PARENT_001',
                name: '病理前处理',
                description: '父级作业中心',
                costDriverType: 'slide_count',
                parentId: null,
                sortOrder: 1,
                status: 'active',
                createdAt: '2026-06-21T00:00:00.000Z',
                updatedAt: '2026-06-21T00:00:00.000Z',
              },
              {
                id: 'CENTER-PW-DEEP-001',
                code: 'AC_PW_DEEP_001',
                name: '深链验证作业中心',
                description: '作业中心深链验证说明',
                costDriverType: 'slide_count',
                parentId: 'CENTER-PARENT-001',
                sortOrder: 12,
                status: 'inactive',
                createdAt: '2026-06-21T00:00:00.000Z',
                updatedAt: '2026-06-21T00:00:00.000Z',
              },
            ],
          }),
        } as Response
      }
      if (url.includes('/api/v1/abc/cost-drivers')) {
        return {
          json: async () => ({
            success: true,
            data: [{
              id: 'driver-slide',
              code: 'slide_count',
              name: '切片数',
              unit: '张',
              status: 'active',
            }],
          }),
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))
  })

  it('uses keyword from URL so audit links open a filtered activity center list', async () => {
    window.history.replaceState(null, '', '/abc/activity-centers?keyword=CENTER-PW-DEEP-001')

    render(createElement(ActivityCenterList))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/v1/abc/activity-centers?keyword=CENTER-PW-DEEP-001',
      expect.any(Object),
    ))
    expect(screen.getByPlaceholderText('搜索作业中心...')).toHaveValue('CENTER-PW-DEEP-001')
    expect(await screen.findByText('深链验证作业中心')).toBeInTheDocument()
    expect(screen.getByText('作业中心深链验证说明')).toBeInTheDocument()
    expect(screen.getByText('切片数（张）')).toBeInTheDocument()
    expect(screen.getByText('病理前处理')).toBeInTheDocument()
    expect(screen.getByText('禁用')).toBeInTheDocument()
  })

  it('lets finance maintain parent center and status from the activity center modal', async () => {
    const fetchMock = vi.mocked(fetch)
    window.history.replaceState(null, '', '/abc/activity-centers')

    render(createElement(ActivityCenterList))

    await screen.findByText('深链验证作业中心')
    fireEvent.click(screen.getByRole('button', { name: '编辑 深链验证作业中心' }))

    const parentSelect = screen.getByLabelText('上级作业中心')
    const statusSelect = screen.getByLabelText('状态')
    expect(parentSelect).toHaveValue('CENTER-PARENT-001')
    expect(statusSelect).toHaveValue('inactive')

    fireEvent.change(parentSelect, { target: { value: '' } })
    fireEvent.change(statusSelect, { target: { value: 'active' } })
    fireEvent.click(screen.getByRole('button', { name: '更新' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/abc/activity-centers/CENTER-PW-DEEP-001',
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"parentId":""'),
      }),
    ))
    const updateCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input) === '/api/v1/abc/activity-centers/CENTER-PW-DEEP-001' && (init as RequestInit)?.method === 'PUT'
    )
    expect(updateCall).toBeDefined()
    expect(JSON.parse(String((updateCall?.[1] as RequestInit).body))).toMatchObject({
      parentId: '',
      status: 'active',
    })
  })

  it('focuses the newly created activity center so cost pool users can confirm the collection node', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v1/abc/activity-centers') && init?.method === 'POST') {
        return {
          json: async () => ({
            success: true,
            data: {
              id: 'CENTER-CREATED-001',
              code: 'AC_CREATED_001',
              name: '新建切片作业中心',
            },
          }),
        } as Response
      }
      if (url.includes('/api/v1/abc/activity-centers')) {
        return {
          json: async () => ({
            success: true,
            data: [{
              id: 'CENTER-CREATED-001',
              code: 'AC_CREATED_001',
              name: '新建切片作业中心',
              description: '用于切片成本归集',
              costDriverType: 'slide_count',
              parentId: null,
              sortOrder: 18,
              status: 'active',
              createdAt: '2026-06-21T00:00:00.000Z',
              updatedAt: '2026-06-21T00:00:00.000Z',
            }],
          }),
        } as Response
      }
      if (url.includes('/api/v1/abc/cost-drivers')) {
        return {
          json: async () => ({
            success: true,
            data: [{
              id: 'driver-slide',
              code: 'slide_count',
              name: '切片数',
              unit: '张',
              status: 'active',
            }],
          }),
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(null, '', '/abc/activity-centers?keyword=old-center')

    render(createElement(ActivityCenterList))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/abc/activity-centers?keyword=old-center',
      expect.any(Object),
    ))

    fireEvent.click(screen.getByRole('button', { name: '新增作业中心' }))
    fireEvent.change(screen.getByLabelText('代码 *'), { target: { value: 'AC_CREATED_001' } })
    fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: '新建切片作业中心' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '用于切片成本归集' } })
    fireEvent.change(screen.getByLabelText('成本动因类型 *'), { target: { value: 'slide_count' } })
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/abc/activity-centers',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"code":"AC_CREATED_001"'),
      }),
    ))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/abc/activity-centers?keyword=AC_CREATED_001',
      expect.any(Object),
    ))
    expect(screen.getByPlaceholderText('搜索作业中心...')).toHaveValue('AC_CREATED_001')
  })
})
