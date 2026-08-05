import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('axios')
vi.mock('sonner', () => ({ toast: { error: toastError } }))

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

    await expect(responseRejected(error)).rejects.toMatchObject({
      message: '请求失败，请稍后重试',
      response: { status: 401 },
    })
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
      message: '请求失败，请稍后重试',
      response: { status: 401 },
    })

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
    await expect(responseRejected(error)).rejects.toMatchObject({
      message: '请求失败，请稍后重试',
      response: { status: 401 },
    })

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

  describe('Issue71 错误展示脱敏', () => {
    it('authorization=Basic 凭据值不得��传（只遮 Basic 不算修）', () => {
      const raw = 'authorization=Basic dXNlcjpwYXNzd29yZA=='
      const out = mod.sanitizeErrorMessage(raw)
      expect(out).not.toContain('dXNlcjpwYXNzd29yZA==')
      expect(out).not.toContain('Basic dXNlcjpwYXNzd29yZA==')
    })

    it("单引号嵌套敏感键值 {'password': 'private-password'} 不得透传", () => {
      const raw = "{'password': 'private-password'}"
      const out = mod.sanitizeErrorMessage(raw)
      expect(out).not.toContain('private-password')
      expect(out).not.toContain('password')
    })

    it('转义引号嵌套敏感键不得透传', () => {
      const raw = '{\\"password\\":\\"private-password\\"}'
      const out = mod.sanitizeErrorMessage(raw)
      expect(out).not.toContain('private-password')
      expect(out).not.toContain('password')
    })

    it('Bearer / Digest 凭据值不得透传', () => {
      const raw = 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'
      const out = mod.sanitizeErrorMessage(raw)
      expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.abc.def')
      const digest = 'Digest username="u", response="deadbeef1234567890"'
      const out2 = mod.sanitizeErrorMessage(digest)
      expect(out2).not.toContain('deadbeef1234567890')
    })

    it('未加引号的 Digest 字段不得透传', () => {
      const raw = 'Digest username=u, response=deadbeef1234567890'
      const out = mod.sanitizeErrorMessage(raw)
      expect(out).not.toContain('deadbeef1234567890')
    })

    it('连续清洗同一个长 token 每次都必须 fail-closed', () => {
      const raw = 'Q'.repeat(48)
      expect(mod.sanitizeErrorMessage(raw)).toBe('')
      expect(mod.sanitizeErrorMessage(raw)).toBe('')
    })

    it('可识别 JSON 优先安全解析并递归清洗，普通字段保留', () => {
      const raw = JSON.stringify({
        data: { token: 'abc.def', password: 'x' },
        message: 'ok',
      })
      const out = mod.sanitizeErrorMessage(raw)
      expect(out).toContain('"token":"[REDACTED]"')
      expect(out).toContain('"password":"[REDACTED]"')
      expect(out).toContain('"message":"ok"')
      expect(out).not.toContain('abc.def')
      expect(out).not.toContain('"x"')
    })

    it('JSON 普通字段中的敏感句子也必须递归 fail-closed', () => {
      const raw = JSON.stringify({ message: 'password is hunter2', details: { note: 'Bearer secret-value' } })
      const out = mod.sanitizeErrorMessage(raw)
      expect(out).not.toContain('hunter2')
      expect(out).not.toContain('secret-value')
    })

    it('无敏感标记的普通文案原样保留', () => {
      const raw = '服务暂时不可用，请稍后重试'
      expect(mod.sanitizeErrorMessage(raw)).toBe(raw)
    })

    it('无法证明安全的非 JSON 敏感文本回退固定通用文案（空串）', () => {
      const raw = 'password is hunter2'
      const out = mod.sanitizeErrorMessage(raw)
      expect(out).not.toContain('hunter2')
      expect(out).toBe('')
    })

    it('拦截器 reject 负载不携带原始敏感 message', async () => {
      const response = {
        data: {
          success: false,
          error: { message: 'authorization=Basic dXNlcjpwYXNzd29yZA==' },
        },
      }
      await expect(responseFulfilled(response)).rejects.toMatchObject({
        message: expect.not.stringContaining('dXNlcjpwYXNzd29yZA=='),
      })
    })

    it('Axios 最终拒绝不得回显 message 或携带请求凭据', async () => {
      const secrets = [
        'hunter2',
        'header-secret',
        'body-secret',
        'param-secret',
        'url-secret',
        'request-secret',
        'backend-secret',
        'response-secret',
        'status-secret',
        'transport-secret',
        'custom-secret',
      ]
      const actualAxios = await vi.importActual<typeof import('axios')>('axios')
      const config = {
        method: 'post',
        url: '/inventory?token=url-secret',
        headers: { Authorization: 'Bearer header-secret' },
        data: JSON.stringify({ password: 'body-secret' }),
        params: { apiKey: 'param-secret' },
      }
      const rawRequest = { headers: { Authorization: 'Bearer request-secret' } }
      const rawResponse = {
          status: 500,
          statusText: 'password is status-secret',
          headers: { 'set-cookie': 'token=response-header-secret' },
          transportSecret: 'Bearer transport-secret',
          data: {
            error: { message: 'password is backend-secret' },
            debug: { token: 'response-secret' },
          },
      }
      const error = Object.assign(
        new actualAxios.AxiosError(
          'password is hunter2',
          'ERR_BAD_RESPONSE',
          config as never,
          rawRequest,
          { ...rawResponse, config } as never
        ),
        { diagnostic: 'Bearer custom-secret' }
      )
      // 真实 AxiosError 的 stack 一旦在拦截器前物化，旧实现只改 message 也无法清掉它。
      expect(error.stack).toContain('hunter2')

      let rejected: typeof error | undefined
      try {
        await responseRejected(error)
      } catch (caught) {
        rejected = caught as typeof error
      }

      expect(rejected).toBeDefined()
      expect(toastError).toHaveBeenCalledWith('请求失败，请稍后重试')
      expect(rejected?.message).toBe('请求失败，请稍后重试')
      expect(rejected?.code).toBe('ERR_BAD_RESPONSE')
      expect(rejected?.config).toEqual({ method: 'post' })
      expect(rejected?.request).toBeUndefined()
      expect(rejected?.response?.headers).toEqual({})
      expect(rejected?.stack).not.toContain('hunter2')
      expect(rejected?.diagnostic).toBeUndefined()
      expect(rejected?.response?.statusText).toBe('')
      expect(Object.prototype.hasOwnProperty.call(rejected?.response ?? {}, 'transportSecret')).toBe(false)
      const serialized = JSON.stringify(rejected)
      for (const secret of secrets) expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('response-header-secret')

      const unsafeCode = `TOKEN_${'Q'.repeat(48)}`
      const unsafeCodeError = new actualAxios.AxiosError('Network Error', unsafeCode)
      let unsafeCodeRejected: InstanceType<typeof actualAxios.AxiosError> | undefined
      try {
        await responseRejected(unsafeCodeError)
      } catch (caught) {
        unsafeCodeRejected = caught as InstanceType<typeof actualAxios.AxiosError>
      }
      expect(unsafeCodeRejected?.code).toBeUndefined()
      expect(JSON.stringify(unsafeCodeRejected)).not.toContain(unsafeCode)
    })
  })
})
