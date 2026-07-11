import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

describe('request', () => {
  let requestInterceptor: any
  let responseFulfilled: any
  let responseRejected: any
  let mod: any

  // 让 mock 的 axios 实例在被当作函数调用（重放原请求）时返回 sentinel，
  // 以便断言「刷新成功后原请求被重放」
  function makeMockInstance() {
    const fn: any = vi.fn((config: any) => Promise.resolve({ __replayed: true, config }))
    fn.get = vi.fn()
    fn.post = vi.fn()
    fn.put = vi.fn()
    fn.delete = vi.fn()
    fn.interceptors = {
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
    }
    return fn
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()

    vi.mocked(axios.create).mockReturnValue(makeMockInstance() as any)
    // 裸 axios.post 用于 /auth/refresh
    vi.mocked(axios.post).mockReset()

    vi.resetModules()
    mod = await import('./request')
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

  it('should clear all auth and redirect on 401 when no refreshToken', async () => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', '{"id":1}')
    localStorage.setItem('rememberUsername', 'admin')
    const error = { config: { url: '/inventory' }, response: { status: 401, data: {} } }

    await expect(responseRejected(error)).rejects.toEqual(error)
    // P1-11: clearAuth 统一清理
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('refreshToken')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
    expect(localStorage.getItem('rememberUsername')).toBeNull()
    // 无 refreshToken 时不应尝试调用 /auth/refresh
    expect(axios.post).not.toHaveBeenCalled()
  })

  it('P1-10: should try /auth/refresh on 401 then replay original request', async () => {
    localStorage.setItem('token', 'old-token')
    localStorage.setItem('refreshToken', 'refresh-1')
    // refresh 成功同时返回 DB 当前能力
    const refreshedUser = { role: '', primaryRole: null, roles: [], capabilities: {}, canSeeCost: false }
    vi.mocked(axios.post).mockResolvedValue({
      data: { success: true, data: { token: 'new-token', user: refreshedUser } },
    } as any)

    const error = { config: { url: '/inventory', headers: {} }, response: { status: 401 } }
    const result: any = await responseRejected(error)

    // 调用了 refresh 端点
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/auth/refresh'),
      { refreshToken: 'refresh-1' }
    )
    // 新 token 已写入
    expect(localStorage.getItem('token')).toBe('new-token')
    expect(JSON.parse(localStorage.getItem('user') || 'null')).toEqual(refreshedUser)
    // 原请求被重放，且带上新 token
    expect(result.__replayed).toBe(true)
    expect(result.config.headers.Authorization).toBe('Bearer new-token')
    // 未登出
    expect(localStorage.getItem('refreshToken')).toBe('refresh-1')
  })

  it('P1-10: should logout when /auth/refresh fails', async () => {
    localStorage.setItem('token', 'old-token')
    localStorage.setItem('refreshToken', 'refresh-1')
    localStorage.setItem('user', '{"id":1}')
    // refresh 失败
    vi.mocked(axios.post).mockRejectedValue(new Error('refresh failed'))

    const error = { config: { url: '/inventory', headers: {} }, response: { status: 401 } }
    await expect(responseRejected(error)).rejects.toEqual(error)

    expect(axios.post).toHaveBeenCalled()
    // refresh 失败 → 登出清理
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('refreshToken')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
  })

  it('P1-10: should not recurse when /auth/refresh itself returns 401', async () => {
    localStorage.setItem('token', 'old-token')
    localStorage.setItem('refreshToken', 'refresh-1')

    const error = { config: { url: '/auth/refresh', headers: {} }, response: { status: 401 } }
    await expect(responseRejected(error)).rejects.toEqual(error)

    // 刷新端点本身 401 → 直接登出，不再次调用 refresh
    expect(axios.post).not.toHaveBeenCalled()
    expect(localStorage.getItem('token')).toBeNull()
  })

  it('P1-11: clearAuth removes token/refreshToken/user/rememberUsername', () => {
    localStorage.setItem('token', 't')
    localStorage.setItem('refreshToken', 'r')
    localStorage.setItem('user', 'u')
    localStorage.setItem('rememberUsername', 'admin')

    mod.clearAuth()

    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('refreshToken')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
    expect(localStorage.getItem('rememberUsername')).toBeNull()
  })

  it('should reject with network error message', async () => {
    const error = { message: 'Network Error' }
    await expect(responseRejected(error)).rejects.toThrow('Network Error')
  })
})
