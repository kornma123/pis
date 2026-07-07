/**
 * 统一旁路台账（非-P0 审计项 ⑦）。
 *
 * 背景：E/A/B/D/C 各道闸修完后，出现至少三处**运行时人工旁路/软兜底**——B 的 `confirm=true` 强制落库、
 * A 的出库缺批次软兜底、D 的补收单独立签发。本系统的原病就是「静默」：修完之后静默会**搬家到旁路里**——
 * 每个旁路被谁、以什么理由按下去，若不记录，半年后旁路就是**新的无守卫写路径**。
 *
 * 本模块把这些旁路汇入**一张 `override_log` 表**（gate_type + module + operator + reason(必填) + before/after 快照），
 * 并给「旁路使用频率」一个第 1 层体检指标——**旁路被高频使用 = 闸的阈值错了、或有人在绕**，两者都要人管。
 *
 * fail-safe：台账记录失败**绝不阻断**合法业务（与 outbound recordLedgerDrift 同款吞错取向）。
 */
import { v4 as uuidv4 } from 'uuid'

/** 旁路闸类型（体检按此聚合）。C 的「改常量」是代码部署、非运行时旁路，靠 drift-guard 测试 + git 追溯，不入本台账。 */
export type OverrideGate =
  | 'import_confirm' // B：对账单导入 /commit confirm===true 强制越过 NEEDS_CONFIRM
  | 'ledger_drift_fallback' // A：出库缺批次软兜底（物料均价/基准价，非静默 0）
  | 'supplement_approve' // D：补收单独立签发（pending_review → approved）

export interface OverrideInput {
  gateType: OverrideGate
  module: string
  targetId?: string | null
  operator: string
  /** 旁路理由（用户填 or 系统兜底口径）——强制非空；空则落 '(未提供理由)' 而非丢失记录。 */
  reason: string
  /** ⚠️ before/after 快照**只传服务端 curated 白名单对象**（如 {gateReasons}/{materialId,unitCost}），
   *  **切勿直接透传 req.body**——本模块不做 scrubSensitive 脱敏（不同于全站 auditWrite），透传原始请求体会把 PII/token 落库。 */
  before?: unknown
  after?: unknown
}

const MAX_SNAP = 4000
function snap(v: unknown): string | null {
  if (v === undefined || v === null) return null
  try {
    const s = JSON.stringify(v)
    return s.length > MAX_SNAP ? s.slice(0, MAX_SNAP) : s
  } catch {
    return null
  }
}

/** 落一条旁路台账。reason 必填（空则记 '(未提供理由)'）；fail-safe：写库失败吞错不阻断业务。 */
export function recordOverride(db: any, input: OverrideInput): void {
  try {
    const reason = String(input.reason ?? '').trim() || '(未提供理由)'
    db.prepare(
      `INSERT INTO override_log (id, gate_type, module, target_id, operator, reason, before_snapshot, after_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuidv4(), input.gateType, input.module, input.targetId ?? null, input.operator || 'system', reason, snap(input.before), snap(input.after))
  } catch (e) {
    console.error('recordOverride failed (non-blocking):', e)
  }
}

export interface OverrideFrequencyRow {
  gateType: string
  module: string
  count: number
  distinctOperators: number
  lastAt: string | null
}

export interface OverrideFrequency {
  since: string | null
  total: number
  byGate: OverrideFrequencyRow[]
}

/**
 * 旁路使用频率体检（第 1 层指标）：按 gate_type/module 聚合计数 + 去重操作人 + 最近一次。
 * 高频 = 闸阈值错了、或有人在绕——两者都要人管。sinceMonth（YYYY-MM）限定窗口，缺省全量。
 */
export function getOverrideFrequency(db: any, opts: { sinceMonth?: string } = {}): OverrideFrequency {
  const since = opts.sinceMonth && /^\d{4}-\d{2}$/.test(opts.sinceMonth) ? opts.sinceMonth : null
  const where = since ? `WHERE substr(created_at, 1, 7) >= ?` : ''
  const params = since ? [since] : []
  const rows = db.prepare(`
    SELECT gate_type AS gateType, module,
           COUNT(*) AS count, COUNT(DISTINCT operator) AS distinctOperators, MAX(created_at) AS lastAt
    FROM override_log ${where}
    GROUP BY gate_type, module
    ORDER BY count DESC
  `).all(...params) as any[]
  const byGate = rows.map((r) => ({
    gateType: String(r.gateType),
    module: String(r.module),
    count: Number(r.count) || 0,
    distinctOperators: Number(r.distinctOperators) || 0,
    lastAt: r.lastAt || null,
  }))
  return { since, total: byGate.reduce((s, r) => s + r.count, 0), byGate }
}
