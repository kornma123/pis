import axios from 'axios'
import type { AxiosError, AxiosRequestConfig } from 'axios'
import { toast } from 'sonner'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1'

const STABLE_ERROR_CODE = /^[A-Z][A-Z0-9_:-]{0,63}$/
const VALIDATION_CODE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,127}$/
const FIELD_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

export interface SafeValidationIssue {
  field?: string
  code?: string
  path?: Array<string | number>
}

interface SafeErrorBody {
  code?: string
  message: string
  validation?: SafeValidationIssue[]
}

interface SafeErrorResponse {
  status: number
  data: {
    success: false
    error: SafeErrorBody
  }
}

export class ApiRequestError extends Error {
  readonly status?: number
  readonly code?: string
  readonly validation?: SafeValidationIssue[]
  readonly response?: SafeErrorResponse

  constructor(message: string, status?: number, code?: string, validation?: SafeValidationIssue[]) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
    this.validation = validation

    if (status !== undefined) {
      const error: SafeErrorBody = { message }
      if (code) error.code = code
      if (validation) error.validation = validation
      this.response = { status, data: { success: false, error } }
    }

    // Do not carry a raw server stack or a local absolute path into downstream logs.
    this.stack = undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHttpStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : undefined
}

function readStableCode(value: unknown): string | undefined {
  return typeof value === 'string' && STABLE_ERROR_CODE.test(value) ? value : undefined
}

function readValidationCode(value: unknown): string | undefined {
  return typeof value === 'string' && VALIDATION_CODE.test(value) ? value : undefined
}

function readFieldName(value: unknown): string | undefined {
  return typeof value === 'string' && FIELD_NAME.test(value) ? value : undefined
}

function readFieldPath(value: unknown): Array<string | number> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return undefined
  const path: Array<string | number> = []
  for (const segment of value) {
    if (Number.isInteger(segment) && Number(segment) >= 0) {
      path.push(Number(segment))
    } else if (typeof segment === 'string' && FIELD_SEGMENT.test(segment)) {
      path.push(segment)
    } else {
      return undefined
    }
  }
  return path
}

function sanitizeValidationIssue(value: unknown, fallbackField?: string): SafeValidationIssue | undefined {
  if (typeof value === 'string') {
    const code = readValidationCode(value)
    return code ? { ...(fallbackField ? { field: fallbackField } : {}), code } : undefined
  }
  if (!isRecord(value)) return undefined

  const field = readFieldName(value.field) || fallbackField
  const code = readValidationCode(value.code)
  const path = readFieldPath(value.path)
  if (!field && !code && !path) return undefined
  return {
    ...(field ? { field } : {}),
    ...(code ? { code } : {}),
    ...(path ? { path } : {}),
  }
}

function sanitizeValidationSource(value: unknown): SafeValidationIssue[] {
  if (Array.isArray(value)) {
    return value.slice(0, 50).flatMap((issue) => {
      const safeIssue = sanitizeValidationIssue(issue)
      return safeIssue ? [safeIssue] : []
    })
  }
  if (!isRecord(value)) return []

  return Object.entries(value).slice(0, 50).flatMap(([field, issue]) => {
    const safeField = readFieldName(field)
    if (!safeField) return []
    const values = Array.isArray(issue) ? issue.slice(0, 10) : [issue]
    return values.flatMap((item) => {
      const safeIssue = sanitizeValidationIssue(item, safeField)
      return safeIssue ? [safeIssue] : []
    })
  })
}

function readValidation(error: Record<string, unknown> | undefined): SafeValidationIssue[] | undefined {
  if (!error) return undefined
  const issues = [error.validation, error.fieldErrors, error.errors]
    .flatMap(sanitizeValidationSource)
    .slice(0, 50)
  return issues.length > 0 ? issues : undefined
}

function safeUserMessage(status: number | undefined, code: string | undefined): string {
  if (code === 'ACCOUNT_DISABLED') return '账号已停用，请联系管理员'
  if (code === 'AUTH_STATE_UNAVAILABLE') return '登录状态暂时无法确认，请稍后重试'
  if (code === 'NEEDS_CONFIRM') return '本次操作需要确认，请核对后继续'
  if (status === undefined) return '网络连接失败，请检查网络后重试'
  if (status === 401) return '登录状态已失效，请重新登录'
  if (status === 403) return '没有权限执行此操作，如需帮助请联系管理员'
  if (status === 404) return '请求的内容不存在或已不可用'
  if (status === 409) return '数据状态已变化，请刷新后重试'
  if (status === 429) return '请求过于频繁，请稍后再试'
  if (status === 400 || status === 422) return '提交内容未通过校验，请检查后重试'
  if (status >= 500) return '服务暂时不可用，请稍后重试'
  return '操作未完成，请稍后重试'
}

function apiErrorFromEnvelope(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  return isRecord(value.error) ? value.error : undefined
}

function createSafeError(status: number | undefined, rawApiError?: Record<string, unknown>): ApiRequestError {
  const code = readStableCode(rawApiError?.code) || (status === undefined ? 'NETWORK_ERROR' : undefined)
  return new ApiRequestError(safeUserMessage(status, code), status, code, readValidation(rawApiError))
}

function sanitizeAxiosError(error: AxiosError): ApiRequestError {
  const status = readHttpStatus(error.response?.status)
  return createSafeError(status, apiErrorFromEnvelope(error.response?.data))
}

function rejectWithToast(error: ApiRequestError): Promise<never> {
  toast.error(error.message)
  return Promise.reject(error)
}

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
    if (!isRecord(data) || data.success !== true) {
      return rejectWithToast(
        createSafeError(readHttpStatus(response.status), apiErrorFromEnvelope(data))
      )
    }
    return data.data as any
  },
  async (error: AxiosError) => {
    const status = error.response?.status
    const originalConfig = error.config as
      | (AxiosRequestConfig & { _retried?: boolean; url?: string })
      | undefined

    if (status === 401 && originalConfig && !originalConfig._retried) {
      // 刷新端点本身 401 → 直接登出，避免递归
      const isRefreshCall = (originalConfig.url || '').includes('/auth/refresh')
      const hasRefreshToken = !!localStorage.getItem('refreshToken')

      if (isRefreshCall || !hasRefreshToken) {
        const safeError = sanitizeAxiosError(error)
        toast.error(safeError.message)
        logoutAndRedirect()
        return Promise.reject(safeError)
      }

      originalConfig._retried = true

      // 已有刷新在途：排队等待，拿到新 token 后重放
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          pendingQueue.push((token) => {
            if (!token) {
              reject(sanitizeAxiosError(error))
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
          const safeError = sanitizeAxiosError(error)
          toast.error(safeError.message)
          logoutAndRedirect()
          return Promise.reject(safeError)
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

    return rejectWithToast(sanitizeAxiosError(error))
  }
)

// 运行时是原生 axios 实例；对外类型收敛为「已解包」的 ApiClient（见接口注释）。
export default request as unknown as ApiClient
