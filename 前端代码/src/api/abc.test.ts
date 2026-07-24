import { describe, it, expect, vi, beforeEach } from 'vitest'

// LOC-013：ABC 响应（bom-links）response→parser 边界行为测试。
vi.mock('./request', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

import request from './request'
import { abcApi } from './abc'

const mockGet = vi.mocked(request.get)

beforeEach(() => {
  vi.clearAllMocks()
})

async function expectContractRejection(p: Promise<unknown>) {
  await expect(p).rejects.toThrow(/合同校验失败/)
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

describe('abcApi.getBomLinks — ABC bom-links 专属 exact parser', () => {
  it('合法裸数组原样发布：quantity=0 保真，activityCenterName=null 保持 null（诚实未知，不编造占位名）', async () => {
    mockGet.mockResolvedValue([
      bomLink({ quantity: 0 }),
      bomLink({ id: 'link-2', activityCenterName: null, activityCenterCode: null, unit: null }),
    ])
    const res = await abcApi.getBomLinks('bom-1')
    expect(res).toHaveLength(2)
    expect(res[0].quantity).toBe(0)
    expect(res[1].activityCenterName).toBeNull()
  })

  it('合法空数组 = 有效成功（该 BOM 未配置作业关联），不得拒也不得造假', async () => {
    mockGet.mockResolvedValue([])
    const res = await abcApi.getBomLinks('bom-1')
    expect(res).toEqual([])
  })

  it('收到 { links: [...] } 信封形状 → 拒绝（exact parser 只认裸数组，形状不得互套）', async () => {
    mockGet.mockResolvedValue({ links: [bomLink()] })
    await expectContractRejection(abcApi.getBomLinks('bom-1'))
  })

  it('收到单个对象而非数组 → 拒绝', async () => {
    mockGet.mockResolvedValue(bomLink())
    await expectContractRejection(abcApi.getBomLinks('bom-1'))
  })

  it.each([
    ['quantity 为 null（未知不得折 0）', { quantity: null }],
    ['quantity 为字符串', { quantity: '2' }],
    ['quantity 为负', { quantity: -1 }],
    ['quantity 为 NaN', { quantity: NaN }],
    ['quantity 为 Infinity', { quantity: Infinity }],
    ['id 缺失', { id: undefined }],
    ['activityCenterId 缺失（身份断裂）', { activityCenterId: undefined }],
    ['activityCenterId 为空串', { activityCenterId: '' }],
    ['sortOrder 为小数', { sortOrder: 1.5 }],
    ['activityCenterName 为数字', { activityCenterName: 42 }],
  ])('关联行畸形（%s）→ 拒绝', async (_label, patch) => {
    mockGet.mockResolvedValue([bomLink(patch)])
    await expectContractRejection(abcApi.getBomLinks('bom-1'))
  })
})
