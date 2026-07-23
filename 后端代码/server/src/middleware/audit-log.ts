import type { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'

/**
 * 全站写操作统一审计中间件（通用 CRUD 留痕）+ P-3 拒绝写审计（SEC-3·取证脊柱的另一半）。
 *
 * ── 第一半（既有）：成功写留痕 ─────────────────────────────────────────
 * 背景：RBAC 守卫不是审计落点（对读也触发、在操作成功前跑，见 middleware/auth.ts 头注释）；
 * 成本/对账域已在操作层各自审计（abc_audit_logs / reconciliation_logs），但通用 CRUD
 * （用户/角色/物料/库存/供应商/入出库/盘点/单据…）此前逐路由手动写、覆盖不全（FRS-16 §3.1.3）。
 * 本中间件给**所有**登录后写操作统一留痕，未来新路由零改动即被覆盖。
 * 决策（2026-07-02 拍板）：全站双轨（成本/对账域并存专属审计）+ 强制脱敏（password/token/secret 不落库）。
 *
 * ── 第二半（P-3 / SEC-3）：拒绝写留痕 ───────────────────────────────────
 * 门 E 那批权限守卫只能证明「门关了」，永远证不了「有没有人在推门」——被拒的越权写(403)一条不入库、
 * 越权探测无痕。本次补上：对登录后的写操作，**成功与被拒都记**。
 *   1. 被拒写(4xx) 记 {操作人, 路径(剥 query), 方法, 时间, 状态码/拒因码}——**绝不记请求体**（防日志投毒 + 防敏感数据入库）。
 *   2. 同一主体每分钟同类被拒 > 阈值 → 逐条转「一条聚合计数行」（防失败请求刷爆日志）。
 *   3. 同账号短时间对多个写端点被拒(403) → 落一条越权探测告警行 + console.warn 实时信号（探测行为签名）。
 *   4. 口径不变：只对**登录后**(req.user)的写记；GET/公开接口(/auth 登录)/未登录(401 无 req.user) 天然不记。
 *
 * ── 落库口径 ──────────────────────────────────────────────────────
 * 复用现有 operation_logs 表，靠新增可空 outcome 列区分（NULL=成功、'denied'、'denied_agg'、'security_alert'）；
 * request_data：成功=脱敏后 body；被拒/聚合/告警=**仅元数据 {status,code} 或计数**，绝无 req.body。
 * 被拒行经现有 /api/v1/logs 视图可见（operation/description 人读）；console.warn 供运维监控管道。
 *
 * ── 铁律 ──────────────────────────────────────────────────────────
 *  - 只作用于写方法(POST/PUT/PATCH/DELETE)；对读(GET)天然不记（顶部 MUTATING 卫早返回）。
 *  - 仅在 req.user 存在时记；绝不阻断响应、绝不抛错（try/catch 吞掉写日志异常）。
 *  - 拒绝分支与成功分支**物理隔离**（三互斥终态早返回）：被拒路径绝不触达 req.body 序列化（安全红线）。
 *  - 同步临界区：record() 及其触发的 DB 写 / console.warn **必须全同步、无 await/Promise/让出 I/O**——
 *    共享 Map 的读改写之所以原子，全靠 node 单线程 + DatabaseSync 同步 + finish 回调跑完才轮到下一个；
 *    任何 await 引入交错 → 丢增量/双告警/窗口重置撕裂。禁止把网络告警 sink 塞进临界区。
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// 命中即打码的敏感字段名（大小写不敏感、子串匹配）
const SENSITIVE_KEY = /pass|pwd|token|secret|credential|authorization/i
const REDACTED = '[REDACTED]'
const MAX_JSON = 4000
const MAX_DESC = 512 // 拒绝行 path/description 长度封顶（防日志膨胀/注入）
const MAX_CODE = 64 // 拒因码长度封顶

// ── P-3 拒绝写审计阈值（模块常量，导出供测试引用——改常量测试不脆断）────────────────
export const DENIAL_WINDOW_MS = 60_000 // 滚动窗口（每主体每类计数窗口）
export const DENIAL_AGG_THRESHOLD = 20 // 每主体每窗口每类被拒 > 此值 → 逐条转聚合（防刷）
export const DENIAL_ALERT_DISTINCT = 5 // 每主体每窗口 403 命中 >= 此数个不同写端点 → 越权探测告警
export const DENIAL_ALERT_HAMMER = 20 // 或单窗 403 原始计数 >= 此值（单端点重锤）→ 告警
export const DENIAL_MAX_SUBJECTS = 10_000 // Map 硬上限（安全网；subjectKey=签发 userId，基数≈并发真实用户）
const DENIAL_SWEEP_EVERY = 256 // 摊还清扫间隔（每 K 事件才扫，防 deny 洪水放大成 O(n²)）

interface AuthRequest extends Request {
  user?: { userId: string; username: string; role: string; roles?: string[] }
}

const SUCCESS_AUDIT_METADATA = Symbol('coreone.success-audit-metadata')

export function setSuccessAuditMetadata(
  res: Response,
  metadata: Record<string, string | number | boolean | null>,
): void {
  ;(res as Response & { [SUCCESS_AUDIT_METADATA]?: unknown })[SUCCESS_AUDIT_METADATA] = { ...metadata }
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

/**
 * 拒绝行安全清洗的路径：**剥掉 query string**（?token=/?email=/患者标识常藏 URL，key-name 脱敏抓不到）、
 * 剔除控制字符（换行/回车防日志注入 + 存储型 XSS 面）、长度封顶。成功路径沿用 originalUrl（既有行为，
 * 不在 P-3 改动面内）——只有拒绝路径用它。
 */
function cleanPath(req: Request): string {
  const raw = String(req.originalUrl || req.path || '')
  const noQuery = raw.split('?')[0]
  // eslint-disable-next-line no-control-regex
  const stripped = noQuery.replace(/[\x00-\x1f\x7f]/g, '')
  return stripped.length > MAX_DESC ? stripped.slice(0, MAX_DESC) : stripped
}

/**
 * 只读**标量**拒因码：仅取 error.code（字符串）并封顶；缺失回退 String(statusCode)。
 * 绝不 JSON.stringify capturedBody、绝不读 error/error.message/error.details——
 * error() 工具在 dev 模式注入 details 并回显 message（会泄漏回显输入/PII，见 utils/response.ts）。
 */
function scalarCode(capturedBody: any, status: number): string {
  const c = capturedBody?.error?.code
  if (typeof c === 'string' && c.length > 0) return c.slice(0, MAX_CODE)
  return String(status)
}

// ════════════════════════════════════════════════════════════════════════
// 纯拒绝追踪器（工厂；无 DB / 无 I/O；决策与落库解耦，可注入时钟做确定性单测）
//   - 状态 = 进程内 Map<subjectKey, 窗口>；subjectKey = 签发 userId（恒有）→ 基数天然有界。
//   - 聚合按「类」独立：authz(403) 与 other(其它 4xx) 各自计数，良性 4xx 洪水永不淹没 403 取证。
//   - 告警只看 authz(403)：distinct(方法+路径) >= 阈值（枚举/广探测）或原始计数 >= 重锤阈值（单端点重锤），
//     每窗口只发一次（消单端点重试风暴/前端越权按钮/SoD 自审 403 误报）。
//   - 即时可持久聚合：跨过阈值后，抑制的第一条返回 aggInsert=true（调用方 INSERT 一行、id=newId），
//     其后返回同一 aggId（调用方 UPDATE 该行计数）——无定时器、无「末窗悬挂」、跨重启行仍在。
// ════════════════════════════════════════════════════════════════════════
export type DenialClass = 'authz' | 'other'

export interface DenialRecordInput {
  subjectKey: string
  statusClass: DenialClass
  endpoint: string // 方法+cleanPath；用于 authz distinct 告警计数
  newId: string // 调用方预生成的 uuid，仅在本类本窗首次抑制时用作聚合行 id
}

export interface DenialDecision {
  action: 'individual' | 'suppressed'
  statusClass: DenialClass
  windowStart: number
  windowRolled: boolean
  totalCount: number // 本类本窗被拒总数（含已逐条 + 已抑制）
  aggInsert: boolean // 抑制且本类本窗首次 → 调用方 INSERT 聚合行（id=aggId）
  aggId: string | null // 聚合行 id（已存在或本次新建）
  suppressedCount: number // 已抑制条数（suppressed 时 >= 1）
  alert: null | { distinctEndpoints: number; count: number } // 恰在越权阈值跨越那一刻非空一次
}

export interface DenialTracker {
  record(input: DenialRecordInput): DenialDecision
  size(): number
}

interface ClassState {
  count: number
  aggId: string | null
  suppressed: number
}
interface Win {
  windowStart: number
  authz: ClassState
  other: ClassState
  distinct: Set<string> // authz 命中的不同端点（告警用）
  alerted: boolean
}

export function createDenialTracker(
  opts: {
    now?: () => number
    windowMs?: number
    aggThreshold?: number
    alertDistinct?: number
    alertHammer?: number
    maxSubjects?: number
  } = {},
): DenialTracker {
  const now = opts.now ?? (() => Date.now())
  const WINDOW_MS = opts.windowMs ?? DENIAL_WINDOW_MS
  const AGG = opts.aggThreshold ?? DENIAL_AGG_THRESHOLD
  const ALERT_DISTINCT = opts.alertDistinct ?? DENIAL_ALERT_DISTINCT
  const ALERT_HAMMER = opts.alertHammer ?? DENIAL_ALERT_HAMMER
  const MAX_SUBJECTS = opts.maxSubjects ?? DENIAL_MAX_SUBJECTS

  const map = new Map<string, Win>()
  let sinceSweep = 0

  const fresh = (t: number): Win => ({
    windowStart: t,
    authz: { count: 0, aggId: null, suppressed: 0 },
    other: { count: 0, aggId: null, suppressed: 0 },
    distinct: new Set<string>(),
    alerted: false,
  })

  // 摊还清扫：先删过期窗口，仍超 cap 则按 windowStart 淘汰最老。即时持久聚合 → 淘汰不丢计数。
  const sweep = (t: number): void => {
    for (const [k, w] of map) if (t - w.windowStart >= WINDOW_MS) map.delete(k)
    if (map.size > MAX_SUBJECTS) {
      const oldest = [...map.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart)
      for (let i = 0; i < oldest.length && map.size > MAX_SUBJECTS; i++) map.delete(oldest[i][0])
    }
  }

  const record = (input: DenialRecordInput): DenialDecision => {
    const t = now()
    if (++sinceSweep >= DENIAL_SWEEP_EVERY || map.size > MAX_SUBJECTS) {
      sinceSweep = 0
      sweep(t)
    }

    let w = map.get(input.subjectKey)
    let rolled = false
    // 滚动窗口：过期即整窗全字段重置（新窗 aggId/alerted/distinct 全清 → 不会永久卡抑制/永久静默）
    if (!w || t - w.windowStart >= WINDOW_MS) {
      rolled = !!w
      w = fresh(t)
      map.set(input.subjectKey, w)
    }

    const cls = input.statusClass === 'authz' ? w.authz : w.other
    cls.count++

    // 告警仅 authz：distinct 端点广度 或 单端点重锤，每窗口一次
    let alert: DenialDecision['alert'] = null
    if (input.statusClass === 'authz') {
      if (input.endpoint) w.distinct.add(input.endpoint)
      if (!w.alerted && (w.distinct.size >= ALERT_DISTINCT || cls.count >= ALERT_HAMMER)) {
        w.alerted = true
        alert = { distinctEndpoints: w.distinct.size, count: cls.count }
      }
    }

    // 逐条 vs 聚合（比较符钉死：count <= AGG 逐条 → 前 AGG 条逐条，第 AGG+1 条起抑制）
    if (cls.count <= AGG) {
      return {
        action: 'individual',
        statusClass: input.statusClass,
        windowStart: w.windowStart,
        windowRolled: rolled,
        totalCount: cls.count,
        aggInsert: false,
        aggId: null,
        suppressedCount: 0,
        alert,
      }
    }
    let aggInsert = false
    if (!cls.aggId) {
      cls.aggId = input.newId
      aggInsert = true
    }
    cls.suppressed++
    return {
      action: 'suppressed',
      statusClass: input.statusClass,
      windowStart: w.windowStart,
      windowRolled: rolled,
      totalCount: cls.count,
      aggInsert,
      aggId: cls.aggId,
      suppressedCount: cls.suppressed,
      alert,
    }
  }

  return { record, size: () => map.size }
}

// ── 模块级单例 + 测试钩子 ─────────────────────────────────────────────────
let denialClock: () => number = () => Date.now()
let denialTracker: DenialTracker = createDenialTracker({ now: () => denialClock() })
/**
 * 测试隔离：重建单例（清空 Map）并复位时钟为 Date.now（防注入时钟跨用例泄漏）。
 * 纯逻辑单测应各自 createDenialTracker(...) 独立实例、无需本钩子；本钩子仅供跑真 app 的集成测试隔离单例。
 */
export function __resetDenialTrackerForTest(): void {
  denialClock = () => Date.now()
  denialTracker = createDenialTracker({ now: () => denialClock() })
}

// ── 落库 helper（全同步；operation_logs 复用；response_data 恒 null 防泄敏）──────────────
function insertLog(
  db: any,
  row: {
    id?: string
    userId: string | null
    username: string
    operation: string
    description: string
    requestData: string | null
    ip: string
    ua: string
    outcome: string | null
  },
): void {
  db.prepare(
    `INSERT INTO operation_logs (id, user_id, username, operation, description, request_data, response_data, ip, user_agent, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id || uuidv4(), row.userId, row.username, row.operation, row.description, row.requestData, null, row.ip, row.ua, row.outcome)
}

export function auditWrite(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!MUTATING.has(req.method)) {
    next()
    return
  }

  // 包裹 res.json 以捕获成功创建接口的目标 id、以及被拒响应的**标量拒因码**（不落库整个响应体）
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
      const status = res.statusCode
      const db = getDatabase()
      const mod = moduleLabel(req)
      const ip = req.ip || req.socket?.remoteAddress || ''
      const ua = req.get?.('user-agent') || ''

      // ── 终态 (a)：成功 2xx —— 原行为不变（写脱敏 body）──────────────────────
      if (status >= 200 && status < 300) {
        const targetId = req.params?.id || capturedBody?.data?.id || null
        insertLog(db, {
          userId: user.userId || null,
          username: user.username || '',
          operation: `${req.method} ${mod}`,
          description: `${user.username || 'system'} ${req.method} ${req.originalUrl}${targetId ? ` (${targetId})` : ''}`,
          requestData: stringifyCapped(
            (res as Response & { [SUCCESS_AUDIT_METADATA]?: unknown })[SUCCESS_AUDIT_METADATA]
              ?? scrubSensitive(req.body),
          ),
          ip,
          ua,
          outcome: null,
        })
        return
      }

      // ── 终态 (b)：被拒 4xx —— P-3 拒绝写审计（安全红线：绝不触达 req.body 序列化）──────
      if (status >= 400 && status < 500) {
        const code = scalarCode(capturedBody, status)
        const path = cleanPath(req)
        const statusClass: DenialClass = status === 403 || status === 401 ? 'authz' : 'other'
        const subjectKey = user.userId || user.username || 'unknown'
        const decision = denialTracker.record({
          subjectKey,
          statusClass,
          endpoint: `${req.method} ${path}`,
          newId: uuidv4(),
        })

        if (decision.action === 'individual') {
          insertLog(db, {
            userId: user.userId || null,
            username: user.username || '',
            operation: `DENIED ${req.method} ${mod}`,
            description: `${user.username || 'system'} ${req.method} ${path} 被拒(${status}/${code})`,
            requestData: JSON.stringify({ status, code }), // 仅元数据，**绝无 body**
            ip,
            ua,
            outcome: 'denied',
          })
        } else {
          // 抑制：即时可持久聚合——首次 INSERT 聚合行，后续 UPDATE 其计数（无定时器/无末窗悬挂）
          const aggReq = JSON.stringify({
            aggregated: true,
            statusClass,
            total: decision.totalCount,
            suppressed: decision.suppressedCount,
            windowStart: decision.windowStart,
          })
          const aggDesc = `${user.username || 'system'} 本窗口 ${mod}(${statusClass}) 被拒 ${decision.totalCount} 次（超阈聚合，${decision.suppressedCount} 条未逐条记）`
          if (decision.aggInsert && decision.aggId) {
            insertLog(db, {
              id: decision.aggId,
              userId: user.userId || null,
              username: user.username || '',
              operation: `DENIED_AGG ${mod}`,
              description: aggDesc,
              requestData: aggReq,
              ip,
              ua,
              outcome: 'denied_agg',
            })
          } else if (decision.aggId) {
            db.prepare(`UPDATE operation_logs SET request_data = ?, description = ? WHERE id = ?`).run(aggReq, aggDesc, decision.aggId)
          }
        }

        // ── 越权探测告警：先落库成功再 console.warn（库故障 → 无告警风暴）；结构化信号防日志伪造 ──
        if (decision.alert) {
          insertLog(db, {
            userId: user.userId || null,
            username: user.username || '',
            operation: `SECURITY_ALERT ${mod}`,
            description: `⚠️ 疑似越权探测：${user.username || 'system'} 本窗口对 ${decision.alert.distinctEndpoints} 个写端点被拒 ${decision.alert.count} 次`,
            requestData: JSON.stringify({
              alert: 'denied-write-burst',
              distinctEndpoints: decision.alert.distinctEndpoints,
              count: decision.alert.count,
              windowStart: decision.windowStart,
            }),
            ip,
            ua,
            outcome: 'security_alert',
          })
          // 落库成功才发实时信号；结构化对象（非字符串插值）防日志伪造/注入
          console.warn('[SECURITY] denied-write-burst', {
            operator: user.username || '',
            subjectKey,
            module: mod,
            distinctEndpoints: decision.alert.distinctEndpoints,
            count: decision.alert.count,
            ip,
          })
        }
        return
      }

      // ── 终态 (c)：3xx / 5xx —— 不记（5xx=服务器故障非访问拒绝，归 errorHandler/错误监控）──
      return
    } catch (err) {
      console.warn('Failed to write write-audit log', err)
    }
  })

  next()
}
