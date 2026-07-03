/**
 * Lane E 预警做真 —— useAlertsPage 契约与表单透传回归
 *
 * 修复前 bug（本测试锁定）：
 *  - handleProcess 调 /alerts/:id/process、handleIgnore 调 /alerts/:id/ignore
 *    → 后端只有 /:id/handle → 全 404。统一到 /handle 带 action。
 *  - 处理弹窗 opinion/result 从未透传 → remark 永远为空。现由 submitHandle 组装 remark 并透传。
 *  - opinion 必填：留空不提交、弹窗不关闭。
 *  - 「忽略预警」结果 → action='ignored'。
 *  - handleGenerate 触发 /alerts/generate；列表空且无筛选时自动生成一次。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useAlertsPage } from './useAlertsPage'
import type { AlertItem } from './useAlertsPage'
import request from '@/api/request'
import { toast } from 'sonner'

vi.mock('@/api/request', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const mockGet = request.get as unknown as ReturnType<typeof vi.fn>
const mockPost = request.post as unknown as ReturnType<typeof vi.fn>

function makeAlert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: 'AL-1', type: 'low-stock', level: 'warning',
    materialId: 'MAT-1', materialName: '试剂A', currentStock: 3, threshold: 10,
    message: '低库存', status: 'pending', createdAt: new Date().toISOString(),
    ...overrides,
  } as AlertItem
}

/** 让挂载时的列表拉取返回“有数据”，避免自动生成副作用干扰 mutation 断言 */
function withData() {
  mockGet.mockResolvedValue({ list: [makeAlert()], pagination: { total: 1, page: 1, pageSize: 10 } })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/alerts') // 清 URL 筛选参数
  mockPost.mockResolvedValue(null)
})

describe('useAlertsPage — /handle 契约与表单透传', () => {
  it('submitHandle 走 POST /alerts/:id/handle（不是 /process），透传 action+remark', async () => {
    withData()
    const { result } = renderHook(() => useAlertsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.openModal('handle', makeAlert()))
    act(() => result.current.setHandleForm({ opinion: '已下单50瓶', result: 'purchased' }))
    await act(async () => { await result.current.submitHandle() })

    expect(mockPost).toHaveBeenCalledTimes(1)
    const [url, body] = mockPost.mock.calls[0]
    expect(url).toBe('/alerts/AL-1/handle')
    expect(body.action).toBe('processed')
    expect(body.remark).toContain('已下单50瓶')
  })

  it('opinion 留空 → 不提交、toast 报错、弹窗不关闭', async () => {
    withData()
    const { result } = renderHook(() => useAlertsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.openModal('handle', makeAlert()))
    await act(async () => { await result.current.submitHandle() })

    expect(mockPost).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
    expect(result.current.modal.type).toBe('handle') // 未关闭
  })

  it('处理结果=忽略预警 → action=ignored', async () => {
    withData()
    const { result } = renderHook(() => useAlertsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.openModal('handle', makeAlert()))
    act(() => result.current.setHandleForm({ opinion: '暂不需要', result: 'ignored' }))
    await act(async () => { await result.current.submitHandle() })

    const [, body] = mockPost.mock.calls[0]
    expect(body.action).toBe('ignored')
  })

  it('handleIgnore 走 POST /alerts/:id/handle（不是 /ignore），action=ignored', async () => {
    withData()
    const { result } = renderHook(() => useAlertsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.handleIgnore('AL-9') })

    expect(mockPost).toHaveBeenCalledTimes(1)
    const [url, body] = mockPost.mock.calls[0]
    expect(url).toBe('/alerts/AL-9/handle')
    expect(body.action).toBe('ignored')
  })

  it('handleGenerate 触发 POST /alerts/generate', async () => {
    withData()
    const { result } = renderHook(() => useAlertsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.handleGenerate() })

    expect(mockPost).toHaveBeenCalledWith('/alerts/generate', expect.anything())
  })

  it('列表空且无筛选 → 自动生成一次', async () => {
    mockGet.mockResolvedValue({ list: [], pagination: { total: 0, page: 1, pageSize: 10 } })
    renderHook(() => useAlertsPage())
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/alerts/generate', expect.anything())
    })
    // 只自动生成一次，不循环
    const genCalls = mockPost.mock.calls.filter((c) => c[0] === '/alerts/generate')
    expect(genCalls.length).toBe(1)
  })

  it('初次拉取失败(total=0 但有 error) → 不误触发自动生成', async () => {
    mockGet.mockRejectedValue(new Error('network'))
    const { result } = renderHook(() => useAlertsPage())
    await waitFor(() => expect(result.current.loading).toBe(false))
    // 给 effect 充分的时间窗口，确认它没有把「加载失败」误当空态
    await new Promise((r) => setTimeout(r, 50))
    const genCalls = mockPost.mock.calls.filter((c) => c[0] === '/alerts/generate')
    expect(genCalls.length).toBe(0)
  })
})
