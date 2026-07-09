/**
 * 授权组合子注册表 —— 「授权条件」的**唯一具名词汇表**。
 *
 * 背景（迁移序第 1 步 · 权限影子断言矩阵前置）：授权「条件」若散落在 handler 的 `if` 里就**无法可靠枚举**
 * （人工标注漏一个 = isSuperset 假绿；纯机器抽语义不可判）。正解 = 让不可枚举的条件在构造上不存在——
 * 每一处对「操作者身份」的 allow/deny 决策都只能经这里注册过的具名工厂/守卫表达。枚举 = 扫本注册表的符号
 * （中间件位 + 具名守卫位），抽出来的就是全集。配套 lint（scripts/build-discipline/check-authz-combinators.cjs）
 * 堵住路由 handler 里的「野生授权逻辑」（裸 req.user.role / 内联 SoD 判决），把这个不变量机器化。
 *
 * ⚠️ 本文件是「注册表」——新增授权条件类型加在这里、别在路由 handler 里裸写。
 *
 * 完整注册表 = 本文件（requireAdmin/isAdmin/assertNotSelfReview/assertCaliberChangeAllowed）
 *            + permissions.ts（requirePermission/requireAnyRole，数据驱动 RBAC 主守卫）
 *            + auth.ts（requireRole 遗留 shim / requireCostWorkbenchAccess）。
 *
 * 设计取舍——为何 SoD/口径门是「具名守卫」而非 pre-route 中间件：
 *   这两类条件 data-dependent（须先 load 资源 / 比对 req.body vs DB 现值）且发生在 handler 里其它
 *   404/409/422 early-return **之后**。若强做成 pre-route 中间件会改变响应排序 → 破坏「行为逐字节等价」
 *   （本次是纯结构重构、绝不改任何鉴权判定）。故它们保留在原调用位，但收进本注册表的**具名守卫**——
 *   仍是封闭的具名词汇表、仍可被下游矩阵枚举，只是枚举点是「具名守卫调用」而非「中间件链」。
 */
import type { Request, Response, NextFunction } from 'express'
import { error } from '../utils/response.js'

interface AuthedRequest extends Request {
  user?: { userId?: string; username?: string; role?: string; roles?: string[] }
}

/** SoD 自审拒绝的默认错误码（单一事实源；路由层禁止裸写此字面量，见 lint 规则②）。 */
export const SELF_REVIEW_FORBIDDEN = 'SELF_REVIEW_FORBIDDEN'

/**
 * 具名谓词：请求操作者是否为 admin（**roles-aware**：primary role='admin' 或 roles[] 含 'admin'）。
 * 与 partner-config/statement-import 原本地 isAdmin 逐字节一致（口径门用它）。
 */
export function isAdmin(req: Request): boolean {
  const u = (req as AuthedRequest).user
  return u?.role === 'admin' || (u?.roles ?? []).includes('admin')
}

/** 仅按 primary role 判 admin（**不看 roles[]**）——用于须精确复刻 `user.role === 'admin'` 语义的老站点（如 alerts）。 */
function isAdminByPrimaryRole(req: Request): boolean {
  return (req as AuthedRequest).user?.role === 'admin'
}

/**
 * 路由守卫：要求操作者为 admin。
 * @param opts.primaryRoleOnly 只看 primary role（默认 false = roles-aware）。alerts 须 true 以逐字节复刻旧站点。
 * @param opts.message/code    拒绝时的文案/错误码（默认 'Forbidden: insufficient permissions' / 'FORBIDDEN'）——
 *                             可覆盖以逐字节匹配被提升站点的原响应。
 * 说明：user 缺失时同样判 403（不发 401）——复刻 alerts 原 `!user || user.role !== 'admin'` 的 `!user` 分支；
 *      且实际上挂载层 requirePermission 已保证 req.user 存在，故 401 分支不可达。
 */
export function requireAdmin(opts: { primaryRoleOnly?: boolean; message?: string; code?: string } = {}) {
  const message = opts.message ?? 'Forbidden: insufficient permissions'
  const code = opts.code ?? 'FORBIDDEN'
  return (req: Request, res: Response, next: NextFunction): void => {
    const ok = opts.primaryRoleOnly ? isAdminByPrimaryRole(req) : isAdmin(req)
    if (!ok) { error(res, message, code, 403); return }
    next()
  }
}

/**
 * 具名 SoD 守卫：禁止操作者审核/签发**自己提交**的东西（检测与处方分离）。
 * 返回 true = 放行（提交人 ≠ 操作者）；返回 false 且已发 `403 {code}` = 拒绝——handler 调用形如
 *   `if (!assertNotSelfReview(res, { ... })) return`（保留在原调用位，排序不变）。
 * @param submitterId          目标资源的提交人（DB 行字段，如 submitted_by / operator）。
 * @param actorId              当前操作者标识（须与 submitterId 同源可比：username↔username 或 userId↔userId）。
 * @param message              拒绝文案（逐字节复刻原站点）。
 * @param code                 错误码（默认 SELF_REVIEW_FORBIDDEN；cost-adjustment 站点用 'FORBIDDEN'）。
 * @param failClosedOnMissing  为 true 时 submitterId 缺失（!submitterId）也判拒——数据缺陷→拒签发
 *                             （逐字节复刻 account-reconcile 的 `!so.submitted_by || ...`）。
 */
export function assertNotSelfReview(
  res: Response,
  opts: {
    submitterId: unknown
    actorId: unknown
    message: string
    code?: string
    failClosedOnMissing?: boolean
  },
): boolean {
  const { submitterId, actorId, message, code = SELF_REVIEW_FORBIDDEN, failClosedOnMissing = false } = opts
  if ((failClosedOnMissing && !submitterId) || submitterId === actorId) {
    error(res, message, code, 403)
    return false
  }
  return true
}

/**
 * 具名守卫：口径（拆分/诊断）变更仅 admin 可做——领域决策，财务侧只读。
 * 返回 true = 放行；返回 false 且已发 `403 FORBIDDEN` = 拒绝。handler 形如
 *   `if (!assertCaliberChangeAllowed(req, res, <本次是否改了口径>, '<文案>')) return`。
 * 用 roles-aware isAdmin（与 partner-config/statement-import 原本地 isAdmin 一致）。
 */
export function assertCaliberChangeAllowed(req: Request, res: Response, changed: boolean, message: string): boolean {
  if (changed && !isAdmin(req)) {
    error(res, message, 'FORBIDDEN', 403)
    return false
  }
  return true
}
