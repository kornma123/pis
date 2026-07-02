import type { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'

/**
 * 全站写操作统一审计中间件（独立立项：通用 CRUD 留痕）。
 *
 * 背景：RBAC 守卫不是审计落点（对读也触发、在操作成功前跑，见 middleware/auth.ts 头注释）；
 * 成本/对账域已在操作层各自审计（abc_audit_logs / reconciliation_logs），但通用 CRUD
 * （用户/角色/物料/库存/供应商/入出库/盘点/单据…）此前逐路由手动写、覆盖不全（FRS-16 §3.1.3）。
 * 本中间件补齐这一缺口：给**所有**登录后写操作统一留痕，未来新路由零改动即被覆盖。
 *
 * 决策（2026-07-02，用户拍板）：
 *  - 覆盖范围 = 全站双轨：成本/对账域也进 operation_logs（与其专属审计并存），
 *    使 operation_logs 成为「谁在何时改了什么」的统一访问账本；专属表保留 before/after 明细。
 *  - 口径 = 只记成功(2xx)；失败尝试(403/422/…)不入库，避免被失败请求刷爆/日志投毒。
 *  - 强制脱敏：password/token/secret 等字段不落库（安全红线）。
 *
 * 铁律：
 *  - 只作用于写方法(POST/PUT/PATCH/DELETE)；对读(GET)天然不记。
 *  - 仅在 req.user 存在时记（公开接口如 /auth 登录无 req.user → 天然排除，也避免记录密码）。
 *  - 绝不阻断响应、绝不抛错（try/catch 吞掉写日志异常，日志失败不影响业务）。
 *  - 复用现有 operation_logs 表，无 schema 变更；response_data 恒为 null（不落库响应体，防泄敏）。
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// 命中即打码的敏感字段名（大小写不敏感、子串匹配）
const SENSITIVE_KEY = /pass|pwd|token|secret|credential|authorization/i
const REDACTED = '[REDACTED]'
const MAX_JSON = 4000

interface AuthRequest extends Request {
  user?: { userId: string; username: string; role: string; roles?: string[] }
}

/** 递归打码敏感字段；非对象原样返回；深度/环保护 */
export function scrubSensitive(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 6) return value
  if (Array.isArray(value)) return value.map((v) => scrubSensitive(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrubSensitive(v, depth + 1)
  }
  return out
}

function stringifyCapped(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try {
    const s = JSON.stringify(value)
    if (s === undefined || s === '{}' || s === 'null') return s === '{}' ? '{}' : (s ?? null)
    return s.length > MAX_JSON ? s.slice(0, MAX_JSON) + '…' : s
  } catch {
    return null
  }
}

/** 从挂载路径推导模块名：/api/v1/<module>/... → <module> */
function moduleLabel(req: Request): string {
  const base = (req.baseUrl || '').replace('/api/v1', '').replace(/^\//, '')
  const seg = base.split('/')[0]
  if (seg) return seg
  const p = (req.originalUrl || req.path || '').replace(/^\/api\/v1\/?/, '').replace(/^\//, '')
  return p.split(/[/?]/)[0] || 'unknown'
}

export function auditWrite(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!MUTATING.has(req.method)) { next(); return }

  // 包裹 res.json 以捕获创建接口返回的目标 id（仅提取 id，不落库整个响应体）
  let capturedBody: any
  const originalJson = res.json.bind(res)
  res.json = ((body: any) => {
    capturedBody = body
    return originalJson(body)
  }) as Response['json']

  res.on('finish', () => {
    try {
      const user = req.user
      if (!user) return // 未登录 / 公开接口（含 /auth 登录）→ 不记，也避免记录密码
      if (res.statusCode < 200 || res.statusCode >= 300) return // 只记成功(2xx)

      const targetId = req.params?.id || capturedBody?.data?.id || null
      const mod = moduleLabel(req)
      const db = getDatabase()
      db.prepare(`
        INSERT INTO operation_logs (id, user_id, username, operation, description, request_data, response_data, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        user.userId || null,
        user.username || '',
        `${req.method} ${mod}`,
        `${user.username || 'system'} ${req.method} ${req.originalUrl}${targetId ? ` (${targetId})` : ''}`,
        stringifyCapped(scrubSensitive(req.body)),
        null,
        req.ip || req.socket?.remoteAddress || '',
        req.get?.('user-agent') || '',
      )
    } catch (err) {
      console.warn('Failed to write write-audit log', err)
    }
  })

  next()
}
