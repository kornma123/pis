import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CostDriverList, formatTierRulesForDisplay, normalizeTierRulesForSubmit } from './CostDriverList'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('CostDriverList helpers', () => {
  it('normalizes continuous tier rules for submission and display', () => {
    const normalized = normalizeTierRulesForSubmit([
      { from: '0', to: '100', rate: '2', label: '0-100张' },
      { from: '100', to: '', rate: '1.5', label: '100张以上' },
    ], '张')

    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return

    expect(normalized.tierRules).toEqual([
      { from: 0, to: 100, rate: 2, label: '0-100张' },
      { from: 100, to: null, rate: 1.5, label: '100张以上' },
    ])
    expect(formatTierRulesForDisplay(normalized.tierRules, '张')).toBe('0-100张：¥2/张；100张以上：¥1.5/张')
  })

  it('rejects overlapping or non-continuous tier ranges', () => {
    expect(normalizeTierRulesForSubmit([
      { from: '0', to: '100', rate: '2' },
      { from: '90', to: '200', rate: '1.5' },
    ], '张')).toEqual({
      ok: false,
      message: '阶梯区间必须连续且不能重叠',
    })
  })
})

describe('CostDriverList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
    localStorage.clear()
    localStorage.setItem('token', 'unit-token')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/v1/abc/cost-drivers')) {
        return {
          json: async () => ({
            success: true,
            data: [{
              id: 'DRIVER-PW-DEEP-001',
              code: 'driver_pw_deep_001',
              name: '深链验证阶梯动因',
              unit: '张',
              calculationMethod: 'tiered',
              tierRules: [
                { from: 0, to: 100, rate: 2, label: '0-100张' },
                { from: 100, to: null, rate: 1.5, label: '100张以上' },
              ],
              description: '成本动因深链验证说明',
              status: 'active',
              createdAt: '2026-06-21T00:00:00.000Z',
            }],
          }),
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }))
  })

  it('uses keyword from URL so audit links open a filtered cost driver list', async () => {
    window.history.replaceState(null, '', '/abc/cost-drivers?keyword=DRIVER-PW-DEEP-001')

    render(createElement(CostDriverList))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/v1/abc/cost-drivers?keyword=DRIVER-PW-DEEP-001',
      expect.any(Object),
    ))
    expect(screen.getByPlaceholderText('搜索成本动因...')).toHaveValue('DRIVER-PW-DEEP-001')
    expect(await screen.findByText('深链验证阶梯动因')).toBeInTheDocument()
    expect(screen.getByText('0-100张：¥2/张；100张以上：¥1.5/张')).toBeInTheDocument()
  })

  it('focuses the newly created cost driver so activity center users can immediately confirm the costing口径', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v1/abc/cost-drivers') && init?.method === 'POST') {
        return {
          json: async () => ({
            success: true,
            data: {
              id: 'DRIVER-CREATED-001',
              code: 'driver_created_001',
              name: '新建切片张数动因',
            },
          }),
        } as Response
      }
      if (url.includes('/api/v1/abc/cost-drivers')) {
        return {
          json: async () => ({
            success: true,
            data: [{
              id: 'DRIVER-CREATED-001',
              code: 'driver_created_001',
              name: '新建切片张数动因',
              unit: '张',
              calculationMethod: 'linear',
              tierRules: null,
              description: '用于作业中心成本归集',
              status: 'active',
              createdAt: '2026-06-21T00:00:00.000Z',
            }],
          }),
        } as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(null, '', '/abc/cost-drivers?keyword=old-driver')

    render(createElement(CostDriverList))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/abc/cost-drivers?keyword=old-driver',
      expect.any(Object),
    ))

    fireEvent.click(screen.getByRole('button', { name: '新增成本动因' }))
    fireEvent.change(screen.getByPlaceholderText('例如：slide_count'), { target: { value: 'driver_created_001' } })
    fireEvent.change(screen.getByPlaceholderText('例如：切片数'), { target: { value: '新建切片张数动因' } })
    fireEvent.change(screen.getByPlaceholderText('例如：张、个、次'), { target: { value: '张' } })
    fireEvent.change(screen.getByPlaceholderText('成本动因的详细描述'), { target: { value: '用于作业中心成本归集' } })
    expect(screen.getByText('成本动因结果确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：成本动因、作业中心、成本池、动因费率、项目成本、审计记录')).toBeInTheDocument()
    expect(screen.getByText('代码 driver_created_001')).toBeInTheDocument()
    expect(screen.getByText('名称 新建切片张数动因')).toBeInTheDocument()
    expect(screen.getByText('单位 张')).toBeInTheDocument()
    expect(screen.getByText('计算方法 线性')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/abc/cost-drivers',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"code":"driver_created_001"'),
      }),
    ))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/abc/cost-drivers?keyword=driver_created_001',
      expect.any(Object),
    ))
    expect(screen.getByPlaceholderText('搜索成本动因...')).toHaveValue('driver_created_001')
  })
})
