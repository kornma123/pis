import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LaneCPage from './LaneCPage'
import { useLaneCPage } from './useLaneCPage'
import type { LaneCConfig, LaneCRecord } from './types'

const masterApi = vi.hoisted(() => ({
  getMaterials: vi.fn(),
  getLocations: vi.fn(),
}))

vi.mock('@/api/master', () => ({
  materialApi: { getList: masterApi.getMaterials },
  locationApi: { getList: masterApi.getLocations },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

const laneApi = {
  getList: vi.fn(),
  getStats: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}

const record: LaneCRecord = {
  id: 'transfer-1',
  inboundNo: 'TF-001',
  materialId: 'material-1',
  materialName: '苏木素染液',
  quantity: 2,
  unit: '瓶',
  operator: 'tester',
  createdAt: '2026-07-19T08:00:00.000Z',
}

const material = {
  id: 'material-1',
  code: 'MAT-001',
  name: '苏木素染液',
  spec: '500ml',
  unit: '瓶',
  price: 10,
  stock: 5,
  minStock: 1,
  maxStock: 20,
  safetyStock: 2,
  categoryId: 'category-1',
  status: 'active' as const,
  createdAt: '2026-07-19T08:00:00.000Z',
  updatedAt: '2026-07-19T08:00:00.000Z',
}

const location = {
  id: 'location-1',
  code: 'LOC-001',
  name: 'A 区常温库',
  type: 'shelf' as const,
  zone: 'A 区',
  capacity: 100,
  used: 10,
  status: 'active' as const,
  createdAt: '2026-07-19T08:00:00.000Z',
}

const zeroStats = {
  total: 0,
  monthCount: 0,
  monthQty: 0,
  materialKinds: 0,
  todayCount: 0,
}

const nonZeroStats = {
  total: 9,
  monthCount: 8,
  monthQty: 7,
  materialKinds: 6,
  todayCount: 5,
}

const page = <T,>(list: T[]) => ({
  list,
  pagination: { page: 1, pageSize: 20, total: list.length, totalPages: list.length ? 1 : 0 },
})

function httpError(status: number) {
  return Object.assign(new Error(`internal http ${status} detail`), {
    response: { status },
  })
}

function networkError() {
  return Object.assign(new Error('internal network detail'), {
    name: 'AxiosError',
    code: 'ERR_NETWORK',
    isAxiosError: true,
  })
}

const config: LaneCConfig = {
  module: 'transfers',
  noun: '调拨',
  title: '调拨管理',
  subtitle: '在库位之间移动物料，总库存不变',
  createLabel: '调拨登记',
  createTone: 'blue',
  effect: { text: '总库存不变', tone: 'neutral' },
  note: '测试调拨语义。',
  filterKind: 'location',
  createMode: 'transfer',
  needsLocations: true,
  columns: [
    { key: 'record', label: '调拨单号', render: row => <span>{row.inboundNo}</span> },
  ],
  detailFields: row => [{ label: '调拨单号', value: row.inboundNo }],
  exportSheet: '调拨记录',
  exportFileName: '调拨记录',
  exportRow: row => ({ 调拨单号: row.inboundNo }),
  api: laneApi,
  validateCreate: () => null,
}

function setWritableUser() {
  localStorage.setItem('user', JSON.stringify({
    role: 'admin',
    roles: ['admin'],
    capabilities: { transfers: 'W' },
  }))
}

function statsCardText(label: string) {
  return screen.getByText(label).parentElement?.textContent || ''
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  setWritableUser()
  Object.values(laneApi).forEach(mock => mock.mockReset())
  Object.values(masterApi).forEach(mock => mock.mockReset())
  laneApi.getList.mockResolvedValue(page([]))
  laneApi.getStats.mockResolvedValue(zeroStats)
  laneApi.create.mockResolvedValue({ id: 'created' })
  laneApi.remove.mockResolvedValue({})
  masterApi.getMaterials.mockResolvedValue(page([material]))
  masterApi.getLocations.mockResolvedValue(page([location]))
})

describe('Lane C page request truth', () => {
  it('does not render four business zeros when the empty list is valid but stats has a network failure', async () => {
    laneApi.getStats.mockRejectedValue(networkError())

    render(<LaneCPage config={config} />)

    await waitFor(() => expect(laneApi.getStats).toHaveBeenCalledTimes(1))
    expect(statsCardText('本月调拨')).toContain('不可用')
    expect(statsCardText('本月件数')).toContain('不可用')
    expect(statsCardText('涉及物料')).toContain('不可用')
    expect(statsCardText('今日调拨')).toContain('不可用')
    expect(screen.getByRole('alert', { name: '调拨统计状态' })).toHaveTextContent('网络连接中断')
    expect(screen.getByText('本月还没有调拨记录')).toBeInTheDocument()
    expect(screen.queryByText('internal network detail')).not.toBeInTheDocument()
  })

  it.each([
    ['network', () => Promise.reject(networkError()), '网络连接中断'],
    ['403', () => Promise.reject(httpError(403)), '没有权限读取调拨统计'],
    ['404', () => Promise.reject(httpError(404)), '调拨统计服务入口不可用'],
    ['malformed', () => Promise.resolve({ total: 0, monthCount: 0 }), '调拨统计返回的数据格式异常'],
  ])('shows an explicit stats error for %s instead of zero', async (_name, response, expected) => {
    laneApi.getStats.mockImplementation(response)

    render(<LaneCPage config={config} />)

    const alert = await screen.findByRole('alert', { name: '调拨统计状态' })
    expect(alert).toHaveTextContent(expected)
    expect(statsCardText('本月调拨')).toContain('不可用')
    expect(alert).not.toHaveTextContent('internal')
  })

  it('keeps a verified all-zero stats response as four real zeros', async () => {
    render(<LaneCPage config={config} />)

    await waitFor(() => expect(statsCardText('本月调拨')).toContain('0'))
    expect(statsCardText('本月件数')).toContain('0')
    expect(statsCardText('涉及物料')).toContain('0')
    expect(statsCardText('今日调拨')).toContain('0')
    expect(screen.queryByRole('alert', { name: '调拨统计状态' })).not.toBeInTheDocument()
  })

  it.each([
    ['network', () => Promise.reject(networkError()), '网络连接中断'],
    ['403', () => Promise.reject(httpError(403)), '没有权限读取调拨记录'],
    ['404', () => Promise.reject(httpError(404)), '调拨记录服务入口不可用'],
    ['malformed', () => Promise.resolve({ list: null }), '调拨记录返回的数据格式异常'],
  ])('separates a %s list failure from verified empty', async (_name, response, expected) => {
    laneApi.getList.mockImplementation(response)

    render(<LaneCPage config={config} />)

    const alert = await screen.findByRole('alert', { name: '调拨记录状态' })
    expect(alert).toHaveTextContent(expected)
    expect(screen.queryByText('本月还没有调拨记录')).not.toBeInTheDocument()
    expect(screen.queryByText('共 0 条记录')).not.toBeInTheDocument()
    expect(alert).not.toHaveTextContent('internal')
  })

  it('renders the true empty state only after a valid empty list response', async () => {
    render(<LaneCPage config={config} />)

    expect(await screen.findByText('本月还没有调拨记录')).toBeInTheDocument()
    expect(screen.getByText('共 0 条记录')).toBeInTheDocument()
    expect(screen.queryByRole('alert', { name: '调拨记录状态' })).not.toBeInTheDocument()
  })

  it('keeps a successful location reference when the material reference fails', async () => {
    masterApi.getMaterials.mockRejectedValue(httpError(403))
    const { result } = renderHook(() => useLaneCPage(config))

    await waitFor(() => {
      expect(result.current.materialsState).toMatchObject({ status: 'error', failure: { kind: 'forbidden' } })
      expect(result.current.locationsState).toMatchObject({ status: 'ready', data: [location] })
    })
    expect(result.current.canCreate).toBe(false)
    expect(result.current.createBlockedReason).toContain('物料选项')
  })

  it('keeps a successful material reference when the location reference fails', async () => {
    masterApi.getLocations.mockRejectedValue(httpError(404))
    const { result } = renderHook(() => useLaneCPage(config))

    await waitFor(() => {
      expect(result.current.materialsState).toMatchObject({ status: 'ready', data: [material] })
      expect(result.current.locationsState).toMatchObject({ status: 'error', failure: { kind: 'not-found' } })
    })
    expect(result.current.canCreate).toBe(false)
    expect(result.current.createBlockedReason).toContain('库位选项')
  })

  it('keeps verified empty references distinct from reference failure', async () => {
    masterApi.getMaterials.mockResolvedValue(page([]))
    masterApi.getLocations.mockResolvedValue(page([]))
    const { result } = renderHook(() => useLaneCPage(config))

    await waitFor(() => {
      expect(result.current.materialsState).toEqual({ status: 'ready', data: [] })
      expect(result.current.locationsState).toEqual({ status: 'ready', data: [] })
    })
    expect(result.current.canCreate).toBe(false)
    expect(result.current.createBlockedReason).toBe('当前没有可用物料，暂不能登记调拨')
  })

  it('disables the create entry and explains why while required references are unverifiable', async () => {
    masterApi.getMaterials.mockRejectedValue(networkError())

    render(<LaneCPage config={config} />)

    const createButton = await screen.findByRole('button', { name: '调拨登记' })
    expect(createButton).toBeDisabled()
    expect(screen.getByRole('alert', { name: '调拨登记状态' })).toHaveTextContent('物料选项')
    expect(screen.getByRole('alert', { name: '调拨登记状态' })).toHaveTextContent('暂不能登记调拨')
  })

  it('recovers list, stats, material, and location truth independently on retry', async () => {
    laneApi.getList.mockRejectedValueOnce(networkError()).mockResolvedValue(page([]))
    laneApi.getStats.mockRejectedValueOnce(httpError(403)).mockResolvedValue(zeroStats)
    masterApi.getMaterials.mockRejectedValueOnce(httpError(404)).mockResolvedValue(page([material]))
    masterApi.getLocations.mockRejectedValueOnce(networkError()).mockResolvedValue(page([location]))
    const { result } = renderHook(() => useLaneCPage(config))

    await waitFor(() => {
      expect(result.current.listState.status).toBe('error')
      expect(result.current.statsState.status).toBe('error')
      expect(result.current.materialsState.status).toBe('error')
      expect(result.current.locationsState.status).toBe('error')
    })

    act(() => {
      result.current.refresh()
      result.current.retryStats()
      result.current.retryMaterials()
      result.current.retryLocations()
    })

    await waitFor(() => {
      expect(result.current.listState).toEqual({ status: 'ready', data: page([]) })
      expect(result.current.statsState).toEqual({ status: 'ready', data: zeroStats })
      expect(result.current.materialsState).toEqual({ status: 'ready', data: [material] })
      expect(result.current.locationsState).toEqual({ status: 'ready', data: [location] })
    })
    expect(result.current.canCreate).toBe(true)
  })

  it('marks every retained successful value stale when its refresh later fails', async () => {
    laneApi.getList.mockResolvedValueOnce(page([record])).mockRejectedValueOnce(networkError())
    laneApi.getStats.mockResolvedValueOnce(nonZeroStats).mockRejectedValueOnce(httpError(403))
    masterApi.getMaterials.mockResolvedValueOnce(page([material])).mockRejectedValueOnce(httpError(404))
    masterApi.getLocations.mockResolvedValueOnce(page([location])).mockRejectedValueOnce(networkError())
    const { result } = renderHook(() => useLaneCPage(config))

    await waitFor(() => {
      expect(result.current.listState.status).toBe('ready')
      expect(result.current.statsState.status).toBe('ready')
      expect(result.current.materialsState.status).toBe('ready')
      expect(result.current.locationsState.status).toBe('ready')
    })

    act(() => {
      result.current.refresh()
      result.current.retryStats()
      result.current.retryMaterials()
      result.current.retryLocations()
    })

    await waitFor(() => {
      expect(result.current.listState).toMatchObject({ status: 'stale', data: page([record]), failure: { kind: 'network' } })
      expect(result.current.statsState).toMatchObject({ status: 'stale', data: nonZeroStats, failure: { kind: 'forbidden' } })
      expect(result.current.materialsState).toMatchObject({ status: 'stale', data: [material], failure: { kind: 'not-found' } })
      expect(result.current.locationsState).toMatchObject({ status: 'stale', data: [location], failure: { kind: 'network' } })
    })
    expect(result.current.canCreate).toBe(false)
    expect(result.current.canMutateList).toBe(false)
  })
})
