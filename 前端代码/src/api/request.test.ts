import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

describe('request', () => {
  let requestInterceptor: any
  let responseFulfilled: any
  let responseRejected: any
  let request: any

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()

    const mockInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: {
        request: {
          use: vi.fn((onFulfilled: any) => {
            requestInterceptor = onFulfilled
          }),
        },
        response: {
          use: vi.fn((onFulfilled: any, onRejected: any) => {
            responseFulfilled = onFulfilled
            responseRejected = onRejected
          }),
        },
      },
    }

    vi.mocked(axios.create).mockReturnValue(mockInstance as any)

    vi.resetModules()
    request = (await import('./request')).default
  })

  it('should create axios instance with correct config', () => {
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 30000,
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    )
  })

  it('should attach Authorization header when token exists', () => {
    localStorage.setItem('token', 'test-token')
    const config = { headers: {} }
    const result = requestInterceptor(config)
    expect(result.headers.Authorization).toBe('Bearer test-token')
  })

  it('should not attach Authorization header when no token', () => {
    const config = { headers: {} }
    const result = requestInterceptor(config)
    expect(result.headers.Authorization).toBeUndefined()
  })

  it('should unwrap response data on success', () => {
    const response = { data: { success: true, data: { id: 1 } } }
    const result = responseFulfilled(response)
    expect(result).toEqual({ id: 1 })
  })

  it('should reject when API returns success=false', async () => {
    const response = {
      data: { success: false, error: { message: '操作失败' } },
    }
    await expect(responseFulfilled(response)).rejects.toEqual(response.data.error)
  })

  it('should clear token and redirect on 401', async () => {
    localStorage.setItem('token', 'test-token')
    const error = { response: { status: 401, data: {} } }

    await expect(responseRejected(error)).rejects.toEqual(error)
    expect(localStorage.getItem('token')).toBeNull()
  })

  it('should reject with network error message', async () => {
    const error = { message: 'Network Error' }
    await expect(responseRejected(error)).rejects.toThrow('Network Error')
  })
})
