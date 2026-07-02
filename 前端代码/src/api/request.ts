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

// ===== Token 续期：单飞锁 + 失败请求重放队列 =====
let isRefreshing = false
let pendingQueue: Array<(token: string | null) => void> = []

function flushQueue(token: string | null) {
  pendingQueue.forEach((cb) => cb(token))
  pendingQueue = []
}

/** 调用后端 /auth/refresh 换取新 token；成功返回新 token，失败返回 null */
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
    if (!newToken) return null
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
      toast.error(data.error?.message || '操作失败')
      return Promise.reject(data.error)
    }
    return data.data
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

    const msg = error.response?.data
      ? (error.response.data as any)?.error?.message
      : undefined
    toast.error(msg || error.message || '网络错误')
    return Promise.reject(error)
  }
)

// 运行时是原生 axios 实例；对外类型收敛为「已解包」的 ApiClient（见接口注释）。
export default request as unknown as ApiClient
