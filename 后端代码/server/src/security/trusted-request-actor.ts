import type { Request, Response } from 'express'
import { error } from '../utils/response.js'

export type TrustedRequestActor = Readonly<{
  userId: string
  username: string
}>

type RequestIdentity = {
  userId?: unknown
  username?: unknown
  role?: unknown
  roles?: unknown
}

type RequestWithIdentity = Request & { user?: RequestIdentity }

const C0_CONTROL_END = 0x1f
const DELETE_CONTROL = 0x7f
const LINE_SEPARATOR = 0x2028
const PARAGRAPH_SEPARATOR = 0x2029
const MAX_IDENTITY_LENGTH = 128

const UNTRUSTED_ACTOR_KEYS = new Set([
  'operator',
  'actor',
  'createdby',
  'updatedby',
  'approvedby',
  'auditactor',
  'audituser',
  'audituserid',
  'userid',
  'username',
])

function hasRejectedIdentityCodeUnit(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (
      codeUnit <= C0_CONTROL_END
      || codeUnit === DELETE_CONTROL
      || codeUnit === LINE_SEPARATOR
      || codeUnit === PARAGRAPH_SEPARATOR
    ) return true
  }
  return false
}

function stableIdentityPart(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed !== value || trimmed.length > MAX_IDENTITY_LENGTH) return null
  if (hasRejectedIdentityCodeUnit(trimmed)) return null
  return trimmed
}

export function requireTrustedRequestActor(req: Request, res: Response): TrustedRequestActor | null {
  const identity = (req as RequestWithIdentity).user
  if (!identity || typeof identity !== 'object') {
    error(res, '需要有效的登录身份', 'AUTHENTICATED_ACTOR_REQUIRED', 401)
    return null
  }

  const userId = stableIdentityPart(identity.userId)
  const username = stableIdentityPart(identity.username)
  if (!userId || !username) {
    error(res, '登录身份缺少稳定用户标识', 'INVALID_AUTHENTICATED_ACTOR', 401)
    return null
  }

  const activeRole = stableIdentityPart(identity.role)
  const roles = Array.isArray(identity.roles)
    ? identity.roles.map(stableIdentityPart)
    : []
  if (!activeRole || roles.length === 0 || roles.some((role) => role === null) || !roles.includes(activeRole)) {
    error(res, '登录身份与权限上下文不一致', 'ACTOR_PERMISSION_CONTEXT_MISMATCH', 403)
    return null
  }

  return Object.freeze({ userId, username })
}

function canonicalActorKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function withoutUntrustedActorFields<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const safeEntries = Object.entries(body as Record<string, unknown>)
    .filter(([key]) => !UNTRUSTED_ACTOR_KEYS.has(canonicalActorKey(key)))
  return Object.fromEntries(safeEntries) as T
}
