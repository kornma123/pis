import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import axios from 'axios'
import { toast } from 'sonner'

vi.mock('axios')
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

describe('request', () => {
  let requestInterceptor: any
  let responseFulfilled: any
  let responseRejected: any
  let mod: any
  let consoleError: ReturnType<typeof vi.spyOn>
  let consoleWarn: ReturnType<typeof vi.spyOn>

  async function captureRejection(promise: Promise<unknown>) {
    try {
      await promise
    } catch (error) {
      return error as any
    }
    throw new Error('Expected promise to reject')
  }

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
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    vi.mocked(axios.create).mockReturnValue(makeMockInstance() as any)
    // 裸 axios.post 用于 /auth/refresh
    vi.mocked(axios.post).mockReset()

    vi.resetModules()
    mod = await import('./request')
  })

  afterEach(() => {
    consoleError.mockRestore()
    consoleWarn.mockRestore()
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

  it('sanitizes a success=false envelope and still rejects with its stable diagnostics', async () => {
    const internal = 'SQLITE_ERROR at C:\\srv\\coreone\\db.ts:42 patient=张三'
    const response = {
      status: 500,
      config: {
        data: { patientName: '张三' },
        headers: { Authorization: 'Bearer secret-token', Cookie: 'sid=secret' },
      },
      data: {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: internal,
          stack: internal,
          sql: 'select * from patients',
          path: 'C:\\srv\\coreone\\db.ts',
          payload: { patientName: '张三' },
        },
      },
    }

    const rejected = await captureRejection(responseFulfilled(response))

    expect(toast.error).toHaveBeenCalledWith('服务暂时不可用，请稍后重试')
    expect(rejected).toMatchObject({
      name: 'ApiRequestError',
      message: '服务暂时不可用，请稍后重试',
      status: 500,
      code: 'DB_ERROR',
      response: {
        status: 500,
        data: {
          success: false,
          error: {
            code: 'DB_ERROR',
            message: '服务暂时不可用，请稍后重试',
          },
        },
      },
    })
    expect(rejected.stack).toBeUndefined()
    expect(rejected.config).toBeUndefined()
    expect(rejected.request).toBeUndefined()
    expect(JSON.stringify(rejected)).not.toContain(internal)
    expect(JSON.stringify(rejected)).not.toContain('secret-token')
    expect(JSON.stringify(rejected)).not.toContain('patientName')
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it('should clear all auth and redirect on 401 when no refreshToken', async () => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', '{"id":1}')
    localStorage.setItem('rememberUsername', 'admin')
    const error = { config: { url: '/inventory' }, response: { status: 401, data: {} } }

    await expect(responseRejected(error)).rejects.toMatchObject({
      name: 'ApiRequestError',
      message: '登录状态已失效，请重新登录',
      status: 401,
    })
    expect(toast.error).toHaveBeenCalledWith('登录状态已失效，请重新登录')
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
    await expect(responseRejected(error)).rejects.toMatchObject({
      name: 'ApiRequestError',
      message: '登录状态已失效，请重新登录',
      status: 401,
    })

    expect(axios.post).toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('登录状态已失效，请重新登录')
    // refresh 失败 → 登出清理
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('refreshToken')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
  })

  it('P1-10: should not recurse when /auth/refresh itself returns 401', async () => {
    localStorage.setItem('token', 'old-token')
    localStorage.setItem('refreshToken', 'refresh-1')

    const error = { config: { url: '/auth/refresh', headers: {} }, response: { status: 401 } }
    await expect(responseRejected(error)).rejects.toMatchObject({
      name: 'ApiRequestError',
      message: '登录状态已失效，请重新登录',
      status: 401,
    })

    // 刷新端点本身 401 → 直接登出，不再次调用 refresh
    expect(axios.post).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('登录状态已失效，请重新登录')
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

  it('gives a safe actionable network message without turning failure into data', async () => {
    const error = {
      message: 'Network Error: connect ECONNREFUSED C:\\internal\\api',
      config: {
        data: { financialAmount: 12345 },
        headers: { Authorization: 'Bearer network-secret' },
      },
    }

    const rejected = await captureRejection(responseRejected(error))

    expect(toast.error).toHaveBeenCalledWith('网络连接失败，请检查网络后重试')
    expect(rejected).toMatchObject({
      name: 'ApiRequestError',
      message: '网络连接失败，请检查网络后重试',
      code: 'NETWORK_ERROR',
    })
    expect(rejected.response).toBeUndefined()
    expect(rejected.config).toBeUndefined()
    expect(rejected.stack).toBeUndefined()
    expect(JSON.stringify(rejected)).not.toContain('network-secret')
  })

  it('maps rate limiting to safe guidance while retaining status and stable code', async () => {
    const error = {
      message: 'Request failed',
      response: {
        status: 429,
        data: {
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'redis://internal:6379 bucket=patient-import',
            stack: 'C:\\srv\\rate-limit.ts:9',
          },
        },
      },
    }

    const rejected = await captureRejection(responseRejected(error))

    expect(toast.error).toHaveBeenCalledWith('请求过于频繁，请稍后再试')
    expect(rejected).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      response: {
        status: 429,
        data: {
          error: {
            code: 'RATE_LIMITED',
            message: '请求过于频繁，请稍后再试',
          },
        },
      },
    })
    expect(JSON.stringify(rejected)).not.toContain('redis://')
  })

  it('retains only structural validation diagnostics and removes raw values', async () => {
    const internal = 'quantity=999999 for patient 张三 at C:\\srv\\validation.ts'
    const error = {
      response: {
        status: 422,
        data: {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: internal,
            validation: [
              {
                field: 'items[0].quantity',
                code: 'too_large',
                path: ['items', 0, 'quantity'],
                message: internal,
                value: 999999,
                input: { patientName: '张三', amount: 999999 },
              },
            ],
            payload: { patientName: '张三' },
          },
        },
      },
    }

    const rejected = await captureRejection(responseRejected(error))

    expect(toast.error).toHaveBeenCalledWith('提交内容未通过校验，请检查后重试')
    expect(rejected).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      validation: [
        {
          field: 'items[0].quantity',
          code: 'too_large',
          path: ['items', 0, 'quantity'],
        },
      ],
      response: {
        status: 422,
        data: {
          error: {
            code: 'VALIDATION_ERROR',
            message: '提交内容未通过校验，请检查后重试',
            validation: [
              {
                field: 'items[0].quantity',
                code: 'too_large',
                path: ['items', 0, 'quantity'],
              },
            ],
          },
        },
      },
    })
    expect(JSON.stringify(rejected)).not.toContain(internal)
    expect(JSON.stringify(rejected)).not.toContain('patientName')
    expect(JSON.stringify(rejected)).not.toContain('999999')
  })

  it('does not expose 500 response stack, SQL, absolute path, payload, or request secrets', async () => {
    const internal = 'SQLITE_CONSTRAINT select * from finance C:\\srv\\db.ts patient=张三'
    const error = {
      message: internal,
      stack: internal,
      config: {
        data: { amount: 8888, patientName: '张三' },
        headers: { Authorization: 'Bearer top-secret', Cookie: 'sid=cookie-secret' },
      },
      request: { body: { amount: 8888 } },
      response: {
        status: 500,
        data: {
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: internal,
            stack: internal,
            sql: 'select * from finance',
            path: 'C:\\srv\\db.ts',
            payload: { amount: 8888, patientName: '张三' },
          },
        },
      },
    }

    const rejected = await captureRejection(responseRejected(error))
    const serialized = JSON.stringify(rejected)

    expect(toast.error).toHaveBeenCalledWith('服务暂时不可用，请稍后重试')
    expect(rejected).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' })
    expect(rejected.stack).toBeUndefined()
    expect(rejected.config).toBeUndefined()
    expect(rejected.request).toBeUndefined()
    expect(serialized).not.toContain('SQLITE_CONSTRAINT')
    expect(serialized).not.toContain('select * from finance')
    expect(serialized).not.toContain('C:\\\\srv')
    expect(serialized).not.toContain('payload')
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('cookie-secret')
    expect(serialized).not.toContain('patientName')
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
  })
})
