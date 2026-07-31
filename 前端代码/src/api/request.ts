import axios from 'axios'
import type { AxiosError, AxiosRequestConfig } from 'axios'
import { toast } from 'sonner'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1'

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
const SENSITIVE_FIELD_NAMES =
  '(?:token|refreshToken|accessToken|password|passwd|secret|apiKey|apikey|authorization|auth|privateKey)'
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi
const SENSITIVE_ASSIGN_PATTERN = new RegExp(
  `("?)(${SENSITIVE_FIELD_NAMES})\\1\\s*[:=]\\s*(?:"([^"]*)"|([^,\\s}]+))`,
  'gi'
)

/** 对展示/日志可见文本做 Bearer 与敏感键值脱敏，不修改业务数据本身。 */
export function redactSensitiveText(input: string): string {
  const afterBearer = input.replace(BEARER_PATTERN, '$1[REDACTED]')
  return afterBearer.replace(
    SENSITIVE_ASSIGN_PATTERN,
    (_match: string, quote: string, key: string) =>
      `${quote}${key}${quote}${quote ? ':' : '='}${quote ? '"' : ''}[REDACTED]${quote ? '"' : ''}`
  )
}

function extractMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return undefined
}

function toSafeDisplayMessage(value: unknown, fallback: string): string {
  const raw = extractMessage(value)
  if (!raw || !raw.trim()) return fallback
  const redacted = redactSensitiveText(raw).trim()
  return redacted || fallback
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
      const rawError =
        typeof data.error === 'object' && data.error !== null ? data.error : {}
      const safeMessage = toSafeDisplayMessage(
        (rawError as { message?: unknown }).message,
        '操作失败'
      )
      toast.error(safeMessage)
      return Promise.reject({ ...rawError, message: safeMessage })
    }
    return data.data
  },
  async (error: AxiosError) => {
    const responseError = (error.response?.data as
      | { error?: { message?: unknown } }
      | undefined)?.error
    const rawBackendMessage =
      responseError && typeof responseError.message === 'string' && responseError.message.trim()
        ? responseError.message
        : undefined
    const safeBackendMessage = rawBackendMessage
      ? redactSensitiveText(rawBackendMessage).trim()
      : undefined
    if (responseError && safeBackendMessage && typeof responseError.message === 'string') {
      responseError.message = safeBackendMessage
    }
    const safeErrorMessage = toSafeDisplayMessage(error.message, '')
    if (typeof error.message === 'string' && safeErrorMessage && error.message !== safeErrorMessage) {
      ;(error as { message?: string }).message = safeErrorMessage
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
        return Promise.reject(error)
      }

      originalConfig._retried = true

      // 已有刷新在途：排队等待，拿到新 token 后重放
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          pendingQueue.push((token) => {
            if (!token) {
              reject(error)
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
          return Promise.reject(error)
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

    const displayMessage =
      safeBackendMessage || toSafeDisplayMessage(error.message, '网络错误')
    toast.error(displayMessage)
    return Promise.reject(error)
  }
)

// 运行时是原生 axios 实例；对外类型收敛为「已解包」的 ApiClient（见接口注释）。
export default request as unknown as ApiClient
