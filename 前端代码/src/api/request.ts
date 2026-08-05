import axios from 'axios'
import type { AxiosError, AxiosRequestConfig } from 'axios'
import { toast } from 'sonner'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1'
const GENERIC_REQUEST_ERROR = '请求失败，请稍后重试'

/**
 * 响应拦截器（见下方）会在成功时返回 `response.data.data`，即**已解包**的业务负载。
 * 因此每个请求方法的运行时返回值是 `T` 本身，而不是 axios 默认的 `AxiosResponse<T>`。
 * 这里用 ApiClient 覆盖 axios 的方法签名，让静态类型与运行时行为对齐——调用方直接拿到 `T`。
 */
export interface ApiClient {
  get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>
  delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>
  head<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>
  options<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>
  post<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>
  put<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>
  patch<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>
}

const request = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

/**
 * 生成幂等键：用于入库/出库等写入提交，防止网络重试、代理重发、双击造成重复入账。
 * 同一次提交动作复用同一个 key（后端对同一 key 仅入账一次，重复请求回放首次结果）。
 */
export function genIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 统一清理本地登录态（token / refreshToken / user / rememberUsername） */
export function clearAuth() {
  localStorage.removeItem('token')
  localStorage.removeItem('refreshToken')
  localStorage.removeItem('user')
  localStorage.removeItem('rememberUsername')
}

/** 清理登录态并跳转登录页 */
function logoutAndRedirect() {
  clearAuth()
  window.location.href = '/login'
}

// ===== 展示层脱敏（Issue71）=====
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|auth|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|credential)/i
const SENSITIVE_MARKER_PATTERN =
  /(authorization|auth|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|credential|Bearer|Basic|Digest|NTLM|Negotiate)/i
const CREDENTIAL_SCHEME_PATTERN = /\b(?:Bearer|Basic|Digest|NTLM|Negotiate)\s+[^\s,;}\]]+/gi
const DIGEST_PAIR_PATTERN =
  /\b(?:username|response|uri|nc|cnonce|qop|algorithm|opaque|realm)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi
const LONG_TOKEN_PATTERN = /[A-Za-z0-9+/]{40,}={0,2}/
const SENSITIVE_KEY_VALUE_PATTERN =
  /(["']?)(authorization|auth|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|credential)\1\s*[:=]\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s,;}\]]+))/gi

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 非 JSON 文本的保守清洗：先解转义引号，再遮凭据 scheme 与敏感键值对。 */
function redactConservativeText(text: string): string {
  const normalized = text.replace(/\\"/g, '"').replace(/\\'/g, "'")
  const noSchemes = normalized
    .replace(CREDENTIAL_SCHEME_PATTERN, '[REDACTED]')
    .replace(DIGEST_PAIR_PATTERN, '[REDACTED]')
  return noSchemes.replace(SENSITIVE_KEY_VALUE_PATTERN, '[REDACTED]')
}

function hasSensitiveMarker(text: string): boolean {
  return SENSITIVE_MARKER_PATTERN.test(text) || LONG_TOKEN_PATTERN.test(text)
}

function redactJsonString(value: string): string {
  if (!value.trim()) return value
  if (hasSensitiveMarker(value)) return '[REDACTED]'
  const redacted = redactConservativeText(value)
  return hasSensitiveMarker(redacted) ? '[REDACTED]' : redacted
}

/** 可识别 JSON 的递归清洗：敏感键值整值替换为 [REDACTED]，普通字段保留。 */
function redactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, depth + 1))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        SENSITIVE_KEY_PATTERN.test(key) ||
        key === 'toJSON' ||
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        typeof item === 'bigint'
          ? '[REDACTED]'
          : redactJsonValue(item, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') return redactJsonString(value)
  return value
}

/**
 * 把后端错误原文转成可展示的安全文案。
 * - 可识别 JSON：安全解析 + 递归清洗后返回；
 * - 非 JSON：保守清洗；若无法证明原文已安全（敏感标记仍在），返回空串，
 *   调用方必须回退固定通用文案，禁止回显原始错误。
 */
export function sanitizeErrorMessage(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = undefined
  }
  if (parsed !== undefined) {
    return JSON.stringify(redactJsonValue(parsed))
  }

  // 一旦原始自由文本带有敏感标记，就不尝试保留局部片段，避免部分替换后的尾部泄漏。
  if (hasSensitiveMarker(trimmed)) return ''
  const redacted = redactConservativeText(trimmed).trim()
  if (!redacted) return ''
  if (hasSensitiveMarker(redacted)) return ''
  return redacted
}

/**
 * AxiosError 会携带请求 headers/body/query 与底层 request；最终交给业务层前只保留
 * 排障所需的安全元数据。401 重放决策完成前不得调用本函数，否则会破坏重试凭据。
 */
function sanitizeTransportValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeErrorMessage(value) || '[REDACTED]'
  if (Array.isArray(value) || isRecord(value)) return redactJsonValue(value)
  if (
    value === undefined ||
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  return '[REDACTED]'
}

function sanitizeAxiosErrorForDisplay(error: AxiosError): AxiosError {
  const safeMessage =
    typeof error.message === 'string' && error.message.trim()
      ? sanitizeErrorMessage(error.message)
      : ''
  const method = error.config?.method
  const safeMethod =
    typeof method === 'string' && /^(?:get|post|put|patch|delete|head|options)$/i.test(method)
      ? method
      : undefined
  const safeConfig = error.config
    ? ((safeMethod ? { method: safeMethod } : {}) as NonNullable<AxiosError['config']>)
    : undefined
  const originalResponse = error.response
  const safeResponse = originalResponse
    ? ({
        data: sanitizeTransportValue(originalResponse.data),
        status: originalResponse.status,
        statusText: '',
        headers: {},
        config: safeConfig || {},
      } as typeof originalResponse)
    : undefined

  // 新建白名单 Error，避免原 AxiosError 的已缓存 stack、toJSON 或自定义可枚举字段泄漏。
  const safeError = new Error(safeMessage || GENERIC_REQUEST_ERROR) as AxiosError
  safeError.name = 'AxiosError'
  if (typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) {
    safeError.code = error.code
  }
  safeError.config = safeConfig
  safeError.request = undefined
  safeError.response = safeResponse
  safeError.status = Number.isInteger(error.status)
    ? error.status
    : originalResponse?.status
  safeError.cause = undefined
  safeError.isAxiosError = true
  safeError.toJSON = () => ({
    name: safeError.name,
    message: safeError.message,
    code: safeError.code,
    status: safeError.status,
    config: safeError.config,
    response: safeResponse
      ? {
          data: safeResponse.data,
          status: safeResponse.status,
          statusText: '',
          headers: {},
          config: safeResponse.config,
        }
      : undefined,
  })
  return safeError
}

// ===== Token 续期：单飞锁 + 失败请求重放队列 =====
let isRefreshing = false
let pendingQueue: Array<(token: string | null) => void> = []

function flushQueue(token: string | null) {
  pendingQueue.forEach((cb) => cb(token))
  pendingQueue = []
}

/** 调用后端 /auth/refresh，同时原子刷新 token 与 DB 当前能力；成功返回新 token。 */
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem('refreshToken')
  if (!refreshToken) return null
  try {
    // 用裸 axios 避免触发本拦截器（防止递归）
    const resp = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken })
    const body = resp.data
    if (!body?.success) return null
    const newToken: string | undefined = body.data?.token
    const newRefresh: string | undefined = body.data?.refreshToken
    const refreshedUser: unknown = body.data?.user
    if (!newToken || !refreshedUser || typeof refreshedUser !== 'object') return null
    const serializedUser = JSON.stringify(refreshedUser)
    localStorage.setItem('user', serializedUser)
    localStorage.setItem('token', newToken)
    if (newRefresh) localStorage.setItem('refreshToken', newRefresh)
    return newToken
  } catch {
    return null
  }
}

request.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

request.interceptors.response.use(
  (response) => {
    const { data } = response
    if (!data.success) {
      const rawError: unknown = data.error
      if (typeof rawError === 'string') {
        const safe = sanitizeErrorMessage(rawError)
        const message = safe || '操作失败'
        toast.error(message)
        return Promise.reject({ message })
      }
      if (isRecord(rawError)) {
        const rawMessage = typeof rawError.message === 'string' ? rawError.message : ''
        const safe = sanitizeErrorMessage(rawMessage)
        const message = safe || '操作失败'
        toast.error(message)
        const sanitized = redactJsonValue(rawError) as Record<string, unknown>
        sanitized.message = message
        return Promise.reject(sanitized)
      }
      toast.error('操作失败')
      return Promise.reject({ message: '操作失败' })
    }
    return data.data
  },
  async (error: AxiosError) => {
    const responseError = (error.response?.data as { error?: unknown } | undefined)?.error
    let safeBackendMessage: string | undefined
    if (isRecord(responseError) && typeof responseError.message === 'string') {
      const safe = sanitizeErrorMessage(responseError.message)
      if (safe) {
        responseError.message = safe
        safeBackendMessage = safe
      } else {
        responseError.message = GENERIC_REQUEST_ERROR
        safeBackendMessage = GENERIC_REQUEST_ERROR
      }
    }
    if (error.response && isRecord(error.response.data)) {
      error.response.data = redactJsonValue(error.response.data) as typeof error.response.data
    }
    if (typeof error.message === 'string' && error.message.trim()) {
      const safe = sanitizeErrorMessage(error.message)
      error.message = safe || GENERIC_REQUEST_ERROR
    }

    const status = error.response?.status
    const originalConfig = error.config as
      | (AxiosRequestConfig & { _retried?: boolean; url?: string })
      | undefined

    if (status === 401 && originalConfig && !originalConfig._retried) {
      // 刷新端点本身 401 → 直接登出，避免递归
      const isRefreshCall = (originalConfig.url || '').includes('/auth/refresh')
      const hasRefreshToken = !!localStorage.getItem('refreshToken')

      if (isRefreshCall || !hasRefreshToken) {
        logoutAndRedirect()
        return Promise.reject(sanitizeAxiosErrorForDisplay(error))
      }

      originalConfig._retried = true

      // 已有刷新在途：排队等待，拿到新 token 后重放
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          pendingQueue.push((token) => {
            if (!token) {
              reject(sanitizeAxiosErrorForDisplay(error))
              return
            }
            originalConfig.headers = {
              ...(originalConfig.headers || {}),
              Authorization: `Bearer ${token}`,
            }
            resolve(request(originalConfig))
          })
        })
      }

      isRefreshing = true
      try {
        const newToken = await refreshAccessToken()
        if (!newToken) {
          flushQueue(null)
          logoutAndRedirect()
          return Promise.reject(sanitizeAxiosErrorForDisplay(error))
        }
        flushQueue(newToken)
        originalConfig.headers = {
          ...(originalConfig.headers || {}),
          Authorization: `Bearer ${newToken}`,
        }
        return request(originalConfig)
      } finally {
        isRefreshing = false
      }
    }

    const safeError = sanitizeAxiosErrorForDisplay(error)
    toast.error(safeBackendMessage || safeError.message || '网络错误')
    return Promise.reject(safeError)
  }
)

// 运行时是原生 axios 实例；对外类型收敛为「已解包」的 ApiClient（见接口注释）。
export default request as unknown as ApiClient
