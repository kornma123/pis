import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import { error } from './response.js'

/**
 * 幂等键工具：让入库/出库等写入提交防止网络重试、前端双击、代理重发造成重复入账。
 *
 * 约定：
 * - 客户端为「同一次提交动作」生成稳定 key（如一次 uuid），通过 `Idempotency-Key` 头或请求体 `idempotencyKey` 传入。
 * - 后端在写入事务内 claim 该 key（PRIMARY KEY，重复即冲突），成功后把首次响应随事务一并落库（finalize）。
 * - 重复请求回放首次结果（同一单号/ID），而不是再写一条；不带 key 时维持原行为（向后兼容）。
 * - 同一 key 但请求体不同 → 视为客户端误用，返回 409 拒绝，避免静默返回错误结果。
 *
 * 并发说明：本项目后端为单连接同步 SQLite（node:sqlite DatabaseSync）+ Express 单线程，
 * 单次请求处理函数从 BEGIN 到 COMMIT 同步执行、事务之间不会交错，故「先查回放 + 事务内 claim」即可保证不重复入账。
 */

export interface StoredIdempotency {
  scope: string
  fingerprint: string
  statusCode: number
  body: unknown
}

/** 从请求读取幂等键：优先 `Idempotency-Key` 头，回退请求体 `idempotencyKey` 字段。无则返回 null。 */
export function readIdempotencyKey(req: Request): string | null {
  const header = req.get('Idempotency-Key') || req.get('X-Idempotency-Key')
  const fromHeader = typeof header === 'string' ? header.trim() : ''
  if (fromHeader) return fromHeader
  const body = (req as any).body
  const fromBody = body && typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
  return fromBody || null
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** 计算请求体指纹（排除幂等键本身），用于检测「同 key 不同内容」的误用。 */
export function fingerprintRequest(body: unknown): string {
  let payload: unknown = body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const clone = { ...(body as Record<string, unknown>) }
    delete clone.idempotencyKey
    payload = clone
  }
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

function lookupIdempotency(db: any, key: string): StoredIdempotency | null {
  const row = db
    .prepare('SELECT scope, request_fingerprint, status_code, response_body FROM idempotency_keys WHERE idempotency_key = ?')
    .get(key) as any
  if (!row || row.response_body == null) return null
  return {
    scope: row.scope,
    fingerprint: row.request_fingerprint,
    statusCode: Number(row.status_code),
    body: JSON.parse(row.response_body),
  }
}

/**
 * 若该 key 已有首次结果：回放（相同内容）或拒绝（不同内容 409），并返回 true 表示已处理（调用方应 return）。
 * 用于事务前快速路径，以及事务内 claim 冲突后的回放路径。
 */
export function tryReplayIdempotency(
  db: any,
  res: Response,
  key: string | null,
  scope: string,
  fingerprint: string,
): boolean {
  if (!key) return false
  const existing = lookupIdempotency(db, key)
  if (!existing) return false
  if (existing.scope !== scope || existing.fingerprint !== fingerprint) {
    error(res, '幂等键已用于不同的请求内容，请改用新的幂等键', 'IDEMPOTENCY_KEY_REUSED', 409)
    return true
  }
  res.status(existing.statusCode).json(existing.body)
  return true
}

/** 事务内占用幂等键（PRIMARY KEY 冲突即抛错）。response_body 留空，待 finalize 回填。 */
export function claimIdempotency(
  db: any,
  key: string,
  scope: string,
  fingerprint: string,
  operator?: string | null,
): void {
  db.prepare(
    'INSERT INTO idempotency_keys (idempotency_key, scope, request_fingerprint, status_code, response_body, operator) VALUES (?, ?, ?, NULL, NULL, ?)',
  ).run(key, scope, fingerprint, operator ?? null)
}

/** 事务内回填首次响应，使已提交的幂等行始终携带完整结果，供后续重复请求回放。 */
export function finalizeIdempotency(db: any, key: string, statusCode: number, body: unknown): void {
  db.prepare('UPDATE idempotency_keys SET status_code = ?, response_body = ? WHERE idempotency_key = ?').run(
    statusCode,
    JSON.stringify(body),
    key,
  )
}

/** 判断错误是否为幂等键唯一约束冲突（并发/重复 claim）。 */
export function isIdempotencyConflict(err: any): boolean {
  const message = String(err?.message || '')
  return message.includes('idempotency_keys') && /UNIQUE|PRIMARY KEY|constraint/i.test(message)
}
