import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request, { genIdempotencyKey } from '@/api/request'
import Returns from './Returns'
import Scraps from '../scraps/Scraps'

let capturedConfig: any

vi.mock('../_laneC/LaneCPage', () => ({
  default: ({ config }: { config: unknown }) => {
    capturedConfig = config
    return <div>lane-c</div>
  },
}))

vi.mock('@/api/request', () => ({
  default: { post: vi.fn() },
  genIdempotencyKey: vi.fn(),
}))

vi.mock('@/api/inventory', () => ({
  returnApi: { getList: vi.fn(), getStats: vi.fn(), create: vi.fn(), delete: vi.fn() },
  scrapApi: { getList: vi.fn(), getStats: vi.fn(), create: vi.fn(), delete: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  capturedConfig = null
  let sequence = 0
  vi.mocked(genIdempotencyKey).mockReset().mockImplementation(() => `idem-${++sequence}`)
})

describe('Return and scrap recoverable create mutations', () => {
  it.each([
    ['退库', Returns, '/returns'],
    ['报废', Scraps, '/scraps'],
  ])('reuses the same idempotency key when the same %s payload is retried', async (_name, Page, path) => {
    vi.mocked(request.post).mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ id: 'ok' })
    render(<Page />)
    const form = { materialId: 'M-1', quantity: 2, reason: 'other', remark: '核对后重试' }

    await expect(capturedConfig.api.create(form)).rejects.toThrow('response lost')
    await expect(capturedConfig.api.create(form)).resolves.toEqual({ id: 'ok' })

    expect(request.post).toHaveBeenNthCalledWith(1, path, expect.any(Object), {
      headers: { 'Idempotency-Key': 'idem-1' },
    })
    expect(request.post).toHaveBeenNthCalledWith(2, path, expect.any(Object), {
      headers: { 'Idempotency-Key': 'idem-1' },
    })
  })

  it.each([
    ['退库', Returns, '/returns'],
    ['报废', Scraps, '/scraps'],
  ])('does not call an unverified %s receipt successful and keeps its retry key', async (_name, Page, path) => {
    vi.mocked(request.post).mockResolvedValueOnce({}).mockResolvedValueOnce({ id: 'verified' })
    render(<Page />)
    const form = { materialId: 'M-1', quantity: 2, reason: 'other', remark: '核对回执' }

    await expect(capturedConfig.api.create(form)).rejects.toThrow('无法验证的回执')
    await expect(capturedConfig.api.create(form)).resolves.toEqual({ id: 'verified' })

    expect(request.post).toHaveBeenNthCalledWith(1, path, expect.any(Object), {
      headers: { 'Idempotency-Key': 'idem-1' },
    })
    expect(request.post).toHaveBeenNthCalledWith(2, path, expect.any(Object), {
      headers: { 'Idempotency-Key': 'idem-1' },
    })
  })
})
