import {
  projectHospitalCmDirectoryForMonth,
} from './hospital-cm-directory.js'
import {
  readCurrentMonthScope,
  saveMonthScopeSnapshotLocked,
  type MonthScopeSnapshot,
  type PeriodEvidenceActor,
} from './hospital-cm-period-evidence.js'

/**
 * #182/O-1 · 版本化医院目录 → C1 月度范围(hospital_cm_month_scope_snapshots)的 gap-only 桥接。
 *
 * trusted/internal 链(本 PR 不暴露任何 HTTP 入口;未来入口必须经认证/授权中间件,actor 只能来自
 * 已认证身份):外部输入只有 serviceMonth / actor / reason。accounts、rosterSourceHash、目录版本、
 * rosterSourceRef、status、recordedAt 全部由服务端活事实与服务端时钟派生;caller 提交任何
 * accounts/hash/revision/name/code/alias/status/recordedAt/operator/mappingEvidenceHash/ready
 * 等字段一律拒绝。
 *
 * 口径铁律(与 hospital-cm-account-roster-source-decision §4 一致):
 * - accounts 永远使用目录月投影中稳定排序的 partners.id;绝不纳入 display name/code/alias。
 * - rosterSourceHash 只消费 projectHospitalCmDirectoryForMonth 给出的成员投影 hash;不另算第二套。
 * - scopeHash 只复用 C1 唯一公式(经 saveMonthScopeSnapshotLocked);不建 rosterScopeHash/第二套 scope。
 * - rosterSourceRef 固定为 roster://hospital-cm-directory/<directoryVersionId>。
 * - 每次调用在同一个 BEGIN IMMEDIATE 内:先取写锁,再读目录投影与 current scope,再裁决
 *   UNCHANGED/PUBLISHED/WITHDRAWN/UNAVAILABLE;任何 fault 整事务 ROLLBACK,零 partial。
 * - no-op(UNCHANGED)只在 current 为 complete 且稳定排序 accounts 与 rosterSourceHash 完全相同时成立;
 *   current 为 incomplete/withdrawn 时即使内容相同也必须追加新 complete。
 * - 投影 null/empty 绝不写 complete-empty;有旧 complete 时追加 withdrawn 使旧 validation run
 *   fail-closed,无旧 complete 或 current 已非 complete 时 UNAVAILABLE 零写(不制造事件风暴)。
 * - raw saveMonthScopeSnapshot 的严格失效语义不由本层软化;no-op 只发生在本桥接层(零 insert/audit/event)。
 */

const SERVICE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const BRIDGE_INPUT_KEYS = ['serviceMonth', 'actor', 'reason'] as const

interface StatementLike {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => unknown
}

/** 桥接连接:目录与 C1 两侧 db 合同的结构超集,且事务状态可自检(locked 写原语的硬前提)。 */
export interface HospitalCmDirectoryScopeBridgeDb {
  prepare: (sql: string) => StatementLike
  exec: (sql: string) => unknown
  readonly isTransaction: boolean
  close?: () => void
}

export class HospitalCmDirectoryScopeBridgeError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
    this.name = 'HospitalCmDirectoryScopeBridgeError'
  }
}

export type HospitalCmDirectoryScopeBridgeAction = 'PUBLISHED' | 'UNCHANGED' | 'WITHDRAWN' | 'UNAVAILABLE'

export interface HospitalCmDirectoryScopeBridgeResult {
  serviceMonth: string
  action: HospitalCmDirectoryScopeBridgeAction
  /** 本次裁决后的 current scope(UNCHANGED/UNAVAILABLE 时为既有行;UNAVAILABLE 且无旧 scope 时为 null)。 */
  scope: MonthScopeSnapshot | null
  /** 生成本次裁决的目录版本(投影为 null 时为 null)。 */
  directoryVersionId: string | null
}

interface NormalizedBridgeInput {
  serviceMonth: string
  actor: PeriodEvidenceActor
  reason: string
}

function normalizeBridgeInput(rawInput: unknown): NormalizedBridgeInput {
  if (rawInput == null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new HospitalCmDirectoryScopeBridgeError('BRIDGE_INPUT_INVALID', 400, '桥接输入必须是对象')
  }
  const input = rawInput as Record<string, unknown>
  const unsupported = Object.keys(input).filter((key) => !(BRIDGE_INPUT_KEYS as readonly string[]).includes(key))
  if (unsupported.length > 0) {
    // 不回显调用者键名(错误消息回显输入是注入/泄漏通道);accounts/hash/revision/status/recordedAt/
    // operator/mappingEvidenceHash 等一律没有入参位,只能由服务端活事实派生。
    throw new HospitalCmDirectoryScopeBridgeError(
      'BRIDGE_INPUT_UNSUPPORTED_FIELD',
      400,
      `存在 ${unsupported.length} 个不支持的输入字段;仅接受:serviceMonth、actor、reason`,
    )
  }
  const serviceMonth = input.serviceMonth
  if (typeof serviceMonth !== 'string' || !SERVICE_MONTH_RE.test(serviceMonth)) {
    throw new HospitalCmDirectoryScopeBridgeError('BRIDGE_SERVICE_MONTH_INVALID', 400, 'serviceMonth 必须是合法 YYYY-MM')
  }
  const actor = input.actor as Partial<PeriodEvidenceActor> | null
  if (actor == null || typeof actor !== 'object'
    || typeof actor.userId !== 'string' || actor.userId.trim() === ''
    || typeof actor.username !== 'string' || actor.username.trim() === '') {
    throw new HospitalCmDirectoryScopeBridgeError('BRIDGE_ACTOR_INVALID', 400, 'actor 必须来自可信边界且含 userId/username')
  }
  const reason = input.reason
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new HospitalCmDirectoryScopeBridgeError('BRIDGE_REASON_INVALID', 400, 'reason 必须是非空字符串')
  }
  // actor/reason 的 canonical 规则(控制字符/公式前缀/长度/unknown 占位)由写路径上的 C1 locked
  // 写原语原样复用;no-op 路径不写库,此处只做形状校验。
  return { serviceMonth, actor: { userId: actor.userId, username: actor.username }, reason }
}

function rollbackAndRethrow(db: HospitalCmDirectoryScopeBridgeDb, cause: unknown): never {
  let rollbackFailure: unknown = null
  for (let attempt = 0; db.isTransaction && attempt < 2; attempt += 1) {
    try {
      db.exec('ROLLBACK')
    } catch (error) {
      rollbackFailure = error
    }
  }
  if (db.isTransaction) {
    try {
      db.close?.()
    } catch {
      // 连接仍视为不可复用；只返回稳定错误，不泄漏底层 close/SQL 诊断。
    }
    const error = new HospitalCmDirectoryScopeBridgeError(
      'BRIDGE_ROLLBACK_FAILED',
      500,
      '目录范围桥接事务回滚失败，连接不可复用',
    ) as HospitalCmDirectoryScopeBridgeError & { cause?: unknown; rollbackCause?: unknown }
    error.cause = cause
    error.rollbackCause = rollbackFailure
    throw error
  }
  throw cause
}

function sameSortedAccounts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * 把目录月投影桥接为 C1 月度范围。每次调用在同一 BEGIN IMMEDIATE 内按固定顺序:
 * 只读目录投影 → 读 current scope → 裁决唯一动作 → 必要时经 C1 locked 写原语追加 → COMMIT;
 * 任一 projection/read/insert/audit/readback fault 全部 ROLLBACK。
 */
export function bridgeHospitalCmDirectoryScopeForMonth(
  db: HospitalCmDirectoryScopeBridgeDb,
  rawInput: unknown,
): HospitalCmDirectoryScopeBridgeResult {
  const input = normalizeBridgeInput(rawInput)
  db.exec('BEGIN IMMEDIATE')
  try {
    const projection = projectHospitalCmDirectoryForMonth(db, input.serviceMonth)
    const current = readCurrentMonthScope(db, input.serviceMonth)
    const directoryVersionId = projection?.directoryVersionId ?? null

    if (projection != null && projection.accounts.length > 0) {
      const rosterSourceRef = `roster://hospital-cm-directory/${projection.directoryVersionId}`
      const unchanged = current != null
        && current.status === 'complete'
        && sameSortedAccounts(current.accounts, projection.accounts)
        && current.rosterSourceHash === projection.rosterSourceHash
      if (unchanged) {
        db.exec('COMMIT')
        return { serviceMonth: input.serviceMonth, action: 'UNCHANGED', scope: current, directoryVersionId }
      }
      const scope = saveMonthScopeSnapshotLocked(db, {
        serviceMonth: input.serviceMonth,
        accounts: projection.accounts,
        rosterSourceRef,
        rosterSourceHash: projection.rosterSourceHash,
        status: 'complete',
        actor: input.actor,
        reason: input.reason,
      })
      db.exec('COMMIT')
      return { serviceMonth: input.serviceMonth, action: 'PUBLISHED', scope, directoryVersionId }
    }

    // 投影 null/empty:绝不写 complete-empty。
    if (current != null && current.status === 'complete') {
      // 名册源不再担保该月:追加 withdrawn(复制当前视图留证),旧 validation run 一律 fail-closed。
      const scope = saveMonthScopeSnapshotLocked(db, {
        serviceMonth: input.serviceMonth,
        accounts: current.accounts,
        rosterSourceRef: current.rosterSourceRef,
        rosterSourceHash: current.rosterSourceHash,
        status: 'withdrawn',
        actor: input.actor,
        reason: input.reason,
      })
      db.exec('COMMIT')
      return { serviceMonth: input.serviceMonth, action: 'WITHDRAWN', scope, directoryVersionId }
    }
    // 无旧 scope,或 current 已非 complete:沿用现有状态语义零写,不授权新状态/事件风暴。
    db.exec('COMMIT')
    return { serviceMonth: input.serviceMonth, action: 'UNAVAILABLE', scope: current, directoryVersionId }
  } catch (cause) {
    rollbackAndRethrow(db, cause)
  }
}
