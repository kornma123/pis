/**
 * LOC-015 运行时输入合同 —— 不可信金额/计数的具名 typed unavailable。
 *
 * 契约（Issue #15 最小交付合同 1/2）：
 *   - 只接受类型正确、有限、安全、非负且精度合法的数值；
 *   - 合法显式 0 保持 0；
 *   - missing / null / blank / text / container / NaN / Infinity / unsafe number
 *     一律返回 `{ status: 'unavailable', reason }`，绝不折零；
 *   - 任何写路径不得把 unavailable 当 0 继续发布（fail-closed 或扣留）。
 *
 * reason 语义：
 *   missing     = null / undefined
 *   blank       = 空串 / 纯空白串
 *   malformed   = 非数值类型（text / object / array / boolean / bigint）
 *   non_finite  = NaN / Infinity / -Infinity
 *   unsafe      = 超出安全整数边界（或 scaled 后超出 Number.MAX_SAFE_INTEGER）
 *   out_of_range= 越出 [min, max]（默认金额/计数禁止负数）
 *   precision   = 小数精度超出允许 scale
 */

export type EvidenceUnavailableReason =
  | 'missing'
  | 'blank'
  | 'malformed'
  | 'non_finite'
  | 'unsafe'
  | 'out_of_range'
  | 'precision'

export interface EvidenceIssue {
  caseNo?: string
  field: string
  reason: EvidenceUnavailableReason
}

export type EvidenceFact =
  | { status: 'ok'; value: number }
  | { status: 'unavailable'; reason: EvidenceUnavailableReason }

export interface ReadEvidenceNumberOptions {
  /** 只接受安全整数（默认 false） */
  integer?: boolean
  /** 允许的小数位（金额默认 2；计数忽略） */
  scale?: number
  /** 下界（默认不限制；readEvidenceCount/Amount 显式传 0） */
  min?: number
  /** 上界（默认不限制） */
  max?: number
}

function unavailable(reason: EvidenceUnavailableReason): EvidenceFact {
  return { status: 'unavailable', reason }
}

/**
 * 严格数值读取：任何不可信输入返回具名 unavailable，调用方负责 fail-closed/扣留。
 * 不抛错（除非调用方显式选择），因此同一函数可同时服务“整批 fail-closed”与
 * “逐条扣留”两种策略。
 */
export function readEvidenceNumber(value: unknown, opts: ReadEvidenceNumberOptions = {}): EvidenceFact {
  if (value === null || value === undefined) return unavailable('missing')
  if (typeof value === 'string') {
    return value.trim() === '' ? unavailable('blank') : unavailable('malformed')
  }
  if (typeof value !== 'number') return unavailable('malformed')
  if (!Number.isFinite(value)) return unavailable('non_finite')
  if (opts.integer && !Number.isSafeInteger(value)) return unavailable('unsafe')

  const scale = opts.integer ? 0 : (opts.scale ?? 2)
  const pow = 10 ** scale
  const scaled = value * pow
  const rounded = Math.round(scaled)
  if (!Number.isSafeInteger(rounded)) return unavailable('unsafe')
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2
  if (Math.abs(scaled - rounded) > tolerance) return unavailable('precision')
  if (opts.min !== undefined && value < opts.min) return unavailable('out_of_range')
  if (opts.max !== undefined && value > opts.max) return unavailable('out_of_range')
  return { status: 'ok', value }
}

/** 计数：有限、安全、非负整数；合法 0 保真。 */
export function readEvidenceCount(value: unknown): EvidenceFact {
  return readEvidenceNumber(value, { integer: true, min: 0 })
}

/** 金额：有限、安全、非负且精度合法；合法 0 保真。 */
export function readEvidenceAmount(value: unknown, opts: { scale?: number } = {}): EvidenceFact {
  return readEvidenceNumber(value, { min: 0, scale: opts.scale ?? 2 })
}

/**
 * 具名不可用错误：供“整批 fail-closed”的写/读路径使用（如对账折扣率、补收折实收）。
 * code/status/issues 均可被路由识别，绝不把 unknown 折成 0 或成功金额。
 */
export class EvidenceUnavailableError extends Error {
  readonly code = 'EVIDENCE_UNAVAILABLE' as const
  readonly status = 422
  readonly issues: EvidenceIssue[]

  constructor(issues: EvidenceIssue[], message = '数据不可用：金额/计数证据缺失或不可信，已拒绝发布') {
    super(message)
    this.name = 'EvidenceUnavailableError'
    this.issues = issues
  }
}

/** 把逐条扣留信息折叠为 API 具名不可用状态。 */
export function toEvidenceWireState(
  issues: EvidenceIssue[] | undefined,
  extra?: { affectedPartners?: string[] },
): { status: 'ok' } | { status: 'unavailable'; issues: EvidenceIssue[]; affectedPartners?: string[] } {
  if (!issues || issues.length === 0) return { status: 'ok' }
  return { status: 'unavailable', issues, ...(extra?.affectedPartners ? { affectedPartners: extra.affectedPartners } : {}) }
}
