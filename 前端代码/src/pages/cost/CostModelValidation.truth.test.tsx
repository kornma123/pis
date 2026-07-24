import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// LOC-013：CostModelValidation 页面 response→parser→consumer 全链行为测试。
// 只 mock 传输层（@/api/request），master.ts/abc.ts 的真实 parser 全量参与；
// 所有负载严格对齐后端 bom-v1.1.ts / abc-v1.1.ts / response.ts 的活合同。
vi.mock('@/api/request', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

import request from '@/api/request'
import { toast } from 'sonner'
import CostModelValidation from './CostModelValidation'

const mockGet = vi.mocked(request.get)

function listEnvelope(list: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    list,
    page: 1,
    pageSize: 200,
    total: list.length,
    totalPages: 1,
    pagination: { page: 1, pageSize: 200, total: list.length, totalPages: 1 },
    ...overrides,
  }
}

function bomListItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bom-1',
    code: 'BOM-001',
    name: 'PD-L1 检测',
    version: 'v1.0',
    type: 'IHC',
    serviceId: null,
    materialCount: 1,
    supportableSamples: null,
    unitCost: 0,
    status: 'active',
    createdAt: '2026-07-01 00:00:00',
    updatedAt: '2026-07-02 00:00:00',
    ...overrides,
  }
}

function bomDetailPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bom-1',
    code: 'BOM-001',
    name: 'PD-L1 检测',
    version: 'v1.0',
    type: 'IHC',
    serviceId: null,
    supportableSamples: null,
    unitCost: null,
    status: 'active',
    materials: [
      { id: 'mat-1', name: '抗体A', spec: '1ml', usagePerSample: 5, unit: 'ml', price: 2, stock: 100, costRatio: 1 },
    ],
    versionHistory: [{ version: 'v1.0', updatedAt: '2026-07-02 00:00:00', changeLog: 'Current' }],
    ...overrides,
  }
}

function bomLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    bomId: 'bom-1',
    activityCenterId: 'ac-1',
    activityCenterName: '包埋',
    activityCenterCode: 'AC01',
    quantity: 2,
    unit: 'ml',
    sortOrder: 1,
    ...overrides,
  }
}

/** 路由式 mock：list / detail / links 三端点各回各的合同负载。 */
function mockHappyRoutes(links: unknown[] = []) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/boms') return Promise.resolve(listEnvelope([bomListItem()]))
    if (url === '/boms/bom-1') return Promise.resolve(bomDetailPayload())
    if (url === '/abc/bom-links/bom-1') return Promise.resolve(links)
    return Promise.reject(new Error(`unexpected url: ${url}`))
  })
}

async function renderAndSelectBom() {
  render(<CostModelValidation />)
  const option = await screen.findByRole('option', { name: 'PD-L1 检测' })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bom-1' } })
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
  return option
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('合法合同数据：合法 0 保真、可计算项真实计算', () => {
  it('list 加载成功 → BOM 可选；合法 unitCost=0 显示为 ¥0.00 而非不可用', async () => {
    mockHappyRoutes()
    await renderAndSelectBom()
    // 选中后元信息行：unitCost=0 是合法 0，必须显示金额
    expect(screen.getByText(/标准单位成本/).textContent).toContain('¥0.00')
    // supportableSamples=null → 诚实显示不可用，不折 0
    expect(screen.getByText(/可支持样本数/).textContent).toContain('不可用')
  })

  it('无作业关联（合法空数组）：材料按合同公式计算，作业=0，总成本=材料；收费/利润不可用', async () => {
    mockHappyRoutes([])
    await renderAndSelectBom()
    fireEvent.click(screen.getByRole('button', { name: /开始计算/ }))
    // 材料 = Σprice×usage = 2×5 = 10/片 × 3 样本 = ¥30.00；作业 = ¥0.00；总成本 = ¥30.00
    await screen.findAllByText('¥30.00')
    expect(screen.getAllByText('¥30.00').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('¥0.00').length).toBeGreaterThanOrEqual(1)
    // 收费标准不在合同中 → 收费金额/利润必须不可用，绝不显示幻影 ¥0
    expect(screen.getByText('收费金额').parentElement?.textContent).toContain('不可用')
    expect(screen.getByText('利润').parentElement?.textContent).toContain('不可用')
    expect(screen.queryByText('¥0.00', { selector: '.text-green-600' })).toBeNull()
    // 空作业关联的诚实空态
    expect(screen.getByText('该 BOM 未配置作业中心关联')).toBeInTheDocument()
  })

  it('有作业关联但费率不在合同中：数量保真显示，小计/合计/总成本/比例全部不可用，绝不按 0 费率假算', async () => {
    mockHappyRoutes([bomLink()])
    await renderAndSelectBom()
    fireEvent.click(screen.getByRole('button', { name: /开始计算/ }))
    await screen.findByText('包埋')
    // 数量为合同事实，保真显示
    expect(screen.getByText('包埋')).toBeInTheDocument()
    // 费率不在合同中 → 小计/合计/总成本不可用
    expect(screen.getByText('作业成本').parentElement?.textContent).toContain('不可用')
    expect(screen.getByText('总成本').parentElement?.textContent).toContain('不可用')
    expect(screen.getByText(/成本构成比例不可计算/)).toBeInTheDocument()
    // 材料成本仍真实计算（2×5×3）
    expect(screen.getByText('材料成本').parentElement?.textContent).toContain('¥30.00')
  })
})

describe('刷新失败 → 陈旧显示禁写 → 新鲜恢复', () => {
  it('成功后刷新失败：列表保留但标记陈旧、禁止计算；再次刷新成功后解禁', async () => {
    mockHappyRoutes()
    await renderAndSelectBom()
    // 选中且数据新鲜 → 按钮可用
    expect(screen.getByRole('button', { name: /开始计算/ })).not.toBeDisabled()

    // 第一次：刷新失败 → 陈旧
    mockGet.mockImplementation((url: string) => {
      if (url === '/boms') return Promise.reject(new Error('network down'))
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await screen.findByText(/数据已过期/)
    // 旧列表保留可见（stale display）
    expect(screen.getByRole('option', { name: 'PD-L1 检测' })).toBeInTheDocument()
    // 但写/校验动作被禁
    expect(screen.getByRole('button', { name: /开始计算/ })).toBeDisabled()

    // 第二次：新鲜同代响应成功 → 解禁
    mockHappyRoutes()
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await waitFor(() => expect(screen.queryByText(/数据已过期/)).toBeNull())
    expect(screen.getByRole('button', { name: /开始计算/ })).not.toBeDisabled()
  })

  it('陈旧状态下直接点计算（绕过 disabled 的异常路径）也被拦截，不发请求', async () => {
    mockHappyRoutes()
    await renderAndSelectBom()
    mockGet.mockImplementation((url: string) => {
      if (url === '/boms') return Promise.reject(new Error('network down'))
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await screen.findByText(/数据已过期/)
    const callsBefore = mockGet.mock.calls.length
    // 禁写闸 = disabled（UX）+ handler 内 stale 硬拦（防御纵深）两层；任一缺失都属闸被拆
    expect(screen.getByRole('button', { name: /开始计算/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /开始计算/ }))
    // 无论绕过路径是否触达 handler，都不得发出任何新请求
    expect(mockGet.mock.calls.length).toBe(callsBefore)
  })
})

describe('畸形/矛盾响应：绝不发布幻影数据', () => {
  it.each([
    ['unitCost 为字符串', listEnvelope([bomListItem({ unitCost: '12.5' })])],
    ['扁平与嵌套 total 矛盾', { ...listEnvelope([bomListItem()]), total: 99 }],
    ['list 项缺 id', listEnvelope([bomListItem({ id: undefined })])],
    ['detail 形状错投给 list 端点', bomDetailPayload()],
  ])('list 响应 %s → 页面显示数据不可用，无幻影列表、禁止计算', async (_label, payload) => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/boms') return Promise.resolve(payload)
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })
    render(<CostModelValidation />)
    await screen.findByText(/BOM 数据不可用/)
    expect(screen.queryByRole('option', { name: 'PD-L1 检测' })).toBeNull()
    expect(screen.getByRole('button', { name: /开始计算/ })).toBeDisabled()
  })

  it('计算时 detail 端点收到 list 信封（形状互换）→ 计算失败、无结果、列表转陈旧禁写', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/boms') return Promise.resolve(listEnvelope([bomListItem()]))
      if (url === '/boms/bom-1') return Promise.resolve(listEnvelope([bomListItem()]))
      if (url === '/abc/bom-links/bom-1') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })
    await renderAndSelectBom()
    fireEvent.click(screen.getByRole('button', { name: /开始计算/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.queryByText('计算过程明细（各作业中心成本分解）')).toBeNull()
    await screen.findByText(/数据已过期/)
    expect(screen.getByRole('button', { name: /开始计算/ })).toBeDisabled()
  })

  it('计算时 bom-links 行 quantity 为 null → 拒绝，不得按 0 量假算', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/boms') return Promise.resolve(listEnvelope([bomListItem()]))
      if (url === '/boms/bom-1') return Promise.resolve(bomDetailPayload())
      if (url === '/abc/bom-links/bom-1') return Promise.resolve([bomLink({ quantity: null })])
      return Promise.reject(new Error(`unexpected url: ${url}`))
    })
    await renderAndSelectBom()
    fireEvent.click(screen.getByRole('button', { name: /开始计算/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.queryByText('包埋')).toBeNull()
    expect(screen.queryByText('计算过程明细（各作业中心成本分解）')).toBeNull()
  })
})
