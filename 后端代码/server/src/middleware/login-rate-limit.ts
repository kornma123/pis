import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { sha256 } from '../config/security.js'
import { error } from '../utils/response.js'

export interface LoginRateLimitOptions {
  windowMs: number
  blockMs: number
  maxFailuresPerIp: number
  maxFailuresPerAccount: number
  maxTrackedKeys: number
}

export interface LoginRateLimitKeys {
  ip: string
  account?: string
}

export interface LoginRateLimitDecision {
  allowed: boolean
  reason?: 'account' | 'ip' | 'capacity'
  retryAfterSeconds?: number
}

interface FailureBucket {
  failures: number[]
  blockedUntil: number
}

const DEFAULT_OPTIONS: LoginRateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
  maxFailuresPerIp: 20,
  maxFailuresPerAccount: 5,
  maxTrackedKeys: 10_000,
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} 必须是 ${min}..${max} 的整数`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}..${max} 的整数`)
  }
  return value
}

/** 可调但有安全边界；无效配置直接拒绝模块加载，不会悄悄关闭限速。 */
export function resolveLoginRateLimitOptions(
  env: NodeJS.ProcessEnv = process.env
): LoginRateLimitOptions {
  const options = {
    windowMs: boundedInteger(env, 'AUTH_LOGIN_RATE_WINDOW_MS', DEFAULT_OPTIONS.windowMs, 1_000, 3_600_000),
    blockMs: boundedInteger(env, 'AUTH_LOGIN_RATE_BLOCK_MS', DEFAULT_OPTIONS.blockMs, 1_000, 86_400_000),
    maxFailuresPerIp: boundedInteger(
      env,
      'AUTH_LOGIN_MAX_FAILURES_PER_IP',
      DEFAULT_OPTIONS.maxFailuresPerIp,
      1,
      1_000
    ),
    maxFailuresPerAccount: boundedInteger(
      env,
      'AUTH_LOGIN_MAX_FAILURES_PER_ACCOUNT',
      DEFAULT_OPTIONS.maxFailuresPerAccount,
      1,
      100
    ),
    maxTrackedKeys: boundedInteger(
      env,
      'AUTH_LOGIN_MAX_TRACKED_KEYS',
      DEFAULT_OPTIONS.maxTrackedKeys,
      100,
      1_000_000
    ),
  }
  if (options.blockMs < options.windowMs) {
    throw new Error(
      'AUTH_LOGIN_RATE_BLOCK_MS 必须大于等于 AUTH_LOGIN_RATE_WINDOW_MS，以保持失败历史有界'
    )
  }
  return options
}

export class LoginFailureRateLimiter {
  private readonly buckets = new Map<string, FailureBucket>()
  private nextSweepAt = 0

  constructor(private readonly options: LoginRateLimitOptions = resolveLoginRateLimitOptions()) {}

  check(keys: LoginRateLimitKeys, now = Date.now()): LoginRateLimitDecision {
    this.sweep(now)
    const accountKey = keys.account ? `account:${keys.account}` : undefined
    const ipKey = `ip:${keys.ip}`
    const accountDecision = accountKey
      ? this.blockDecision(this.buckets.get(accountKey), 'account', now)
      : null
    if (accountDecision) return accountDecision
    const ipDecision = this.blockDecision(this.buckets.get(ipKey), 'ip', now)
    if (ipDecision) return ipDecision

    let missingKeys = this.missingKeyCount(accountKey, ipKey)
    if (this.buckets.size + missingKeys > this.options.maxTrackedKeys) {
      this.sweep(now, true)
      missingKeys = this.missingKeyCount(accountKey, ipKey)
    }
    if (this.buckets.size + missingKeys > this.options.maxTrackedKeys) {
      return {
        allowed: false,
        reason: 'capacity',
        retryAfterSeconds: Math.ceil(this.options.windowMs / 1000),
      }
    }
    if (accountKey && !this.buckets.has(accountKey)) {
      this.buckets.set(accountKey, { failures: [], blockedUntil: 0 })
    }
    if (!this.buckets.has(ipKey)) this.buckets.set(ipKey, { failures: [], blockedUntil: 0 })
    return { allowed: true }
  }

  recordFailure(keys: LoginRateLimitKeys, now = Date.now()): void {
    this.record(`ip:${keys.ip}`, this.options.maxFailuresPerIp, now)
    if (keys.account) this.record(`account:${keys.account}`, this.options.maxFailuresPerAccount, now)
  }

  recordSuccess(keys: LoginRateLimitKeys): void {
    if (keys.account) this.buckets.delete(`account:${keys.account}`)
  }

  private record(key: string, limit: number, now: number): void {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      this.sweep(now, true)
      if (this.buckets.size >= this.options.maxTrackedKeys) return
      bucket = { failures: [], blockedUntil: 0 }
      this.buckets.set(key, bucket)
    }
    bucket.failures = bucket.failures.filter(timestamp => timestamp > now - this.options.windowMs)
    bucket.failures.push(now)
    if (bucket.failures.length >= limit) {
      bucket.blockedUntil = Math.max(bucket.blockedUntil, now + this.options.blockMs)
    }
  }

  private missingKeyCount(accountKey: string | undefined, ipKey: string): number {
    return [accountKey, ipKey].filter(
      (key): key is string => typeof key === 'string' && !this.buckets.has(key)
    ).length
  }

  private blockDecision(
    bucket: FailureBucket | undefined,
    reason: 'account' | 'ip',
    now: number
  ): LoginRateLimitDecision | null {
    if (!bucket || bucket.blockedUntil <= now) return null
    return {
      allowed: false,
      reason,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000)),
    }
  }

  private sweep(now: number, force = false): void {
    if (!force && now < this.nextSweepAt) return
    for (const [key, bucket] of this.buckets) {
      bucket.failures = bucket.failures.filter(timestamp => timestamp > now - this.options.windowMs)
      if (bucket.blockedUntil <= now) bucket.blockedUntil = 0
      if (bucket.failures.length === 0 && bucket.blockedUntil === 0) this.buckets.delete(key)
    }
    this.nextSweepAt = now + Math.min(this.options.windowMs, 60_000)
  }
}

function requestKeys(req: Request): LoginRateLimitKeys {
  const username = typeof req.body?.username === 'string'
    ? req.body.username.normalize('NFKC').trim().toLowerCase()
    : ''
  return {
    ip: req.ip || req.socket.remoteAddress || 'unknown',
    account: username ? sha256(username) : undefined,
  }
}

interface LoginAttemptState {
  limiter: LoginFailureRateLimiter
  keys: LoginRateLimitKeys
  settled: boolean
}

const attemptStates = new WeakMap<Response, LoginAttemptState>()

export function recordLoginFailure(res: Response): void {
  const state = attemptStates.get(res)
  if (!state || state.settled) return
  state.settled = true
  state.limiter.recordFailure(state.keys)
}

export function recordLoginSuccess(res: Response): void {
  const state = attemptStates.get(res)
  if (!state || state.settled) return
  state.settled = true
  state.limiter.recordSuccess(state.keys)
}

/**
 * 路由在凭据判定点显式记录成功/失败，避免客户端提前断开导致依赖 response finish 的失败漏记。
 * 成功登录清除账号维度计数，但不清除同 IP 对其他账号的失败历史。
 * 状态有界且只保留账号哈希，不在内存或响应中保存原始用户名/口令。
 */
export function createLoginRateLimitMiddleware(
  limiter = new LoginFailureRateLimiter()
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = requestKeys(req)
    const decision = limiter.check(keys)
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds ?? 1))
      res.setHeader('Cache-Control', 'no-store')
      error(res, '登录失败次数过多，请稍后再试', 'TOO_MANY_REQUESTS', 429)
      return
    }
    const state: LoginAttemptState = { limiter, keys, settled: false }
    attemptStates.set(res, state)
    res.once('close', () => {
      if (!state.settled && !res.writableEnded) recordLoginFailure(res)
    })
    next()
  }
}

export const loginRateLimit = createLoginRateLimitMiddleware()
