/**
 * 组合体检 + 人看对照表 —— P0 四轮外审收敛终稿的**顶层框架**（纯口径·无 DB）。
 *
 * 权威依据：`~/Desktop/P0决策逻辑-四轮收敛终稿.md`（顶层框架两层 + 功能重分配 + round-4 双触发/性质断言）。
 *
 * 核心决定（四轮外审 + 内审证伪「按逐账户利润率排名→谈价清单」）：
 *   在固定成本重、产能受约束的生意里，「按逐账户利润率排名」选错了**分析单位**——它天然把「大额薄利」的
 *   顶梁柱账户（绝对贡献最大、率最低）推上刀口。**改两层框架**：
 *     第 1 层 · 组合体检（不点名任何账户）：∑CM ÷ 固定成本池 = 覆盖倍数（**只看趋势·不信绝对值**）+ 产能利用率；
 *     第 2 层 · 人看对照表（要看单账户时）：绝对贡献 + 率 + 趋势**并列**·系统不排名/不打分/不自动生成清单。
 *   检测层退役；算术沉入处方层（目标报价 = 底线 + 谈判余量）；每单位瓶颈贡献门控在第 3 层。
 *
 * ⚠️ 本文件**不产生任何自动点名/谈价清单**。`checkTerminationPreFilter` 是**封存进复活条款的不可谈判性质断言**
 *    （§4b）：将来账户数越线、重建自动化时，新分析单位无论怎么设计，这条断言**先于设计存在**。
 */

import type { HospitalCm } from './hospital-cm.js'

// ────────────────────────────────────────────────────────────────────────────
// 具名常量（终稿 §2/§4c·照「C 域档1」立法：具名 + drift-guard 测试 + 变更留痕。别让四轮换来的触发器自己成为下一个未立法旋钮）
// ────────────────────────────────────────────────────────────────────────────

// ── LEG·就绪谓词政策参数登记（具名 + 版本化 + drift-guard·专家 Q4/§二/§六.5）──
//    比例原则：碰钱/对外结论参数（固定成本池、拆分常量）业务方签；系统时序工程参数（N 期、门集、通过标准）技术负责人签，同样具名可见。

/** LEG·就绪谓词阈值登记版本（改任一 READINESS_* 阈值/门集 = bump 本版本 + 同步改 drift-guard 测试 = 显式立法动作）。 */
export const READINESS_PARAM_VERSION = '2026-07-13.a'

/**
 * LEG·就绪最小完整结算周期数 N（**技术负责人签**·系统时序工程参数·非碰钱/对外结论参数）。
 * 两限定（写进登记·非拍脑袋）：
 *  ① 计数口径 = 只数「已结算(closed) ∧ 过期间键校验(DATA-4)」的完整周期（= verifiedClosedPeriods）——**非自然月历、非草稿期**；
 *  ② 3 = 「能开始看趋势」下限（分辨趋势方向 vs 单期噪声至少 3 点）、**非「可信」门槛**（可信靠标准成本校准里程碑·另立）。
 */
export const READINESS_MIN_CLOSED_PERIODS = 3

/** LEG·哪些数据地基门算数（三门 A/B/C·具名闭合集·全绿才满足 foundation 条件·缺门 = fail-closed 未绿）。 */
export const READINESS_FOUNDATION_GATES = ['inventory_conservation', 'period_key', 'constant_freeze'] as const

/**
 * @deprecated 影子模式旧硬开关已换成**算出来的就绪谓词** `computeReadiness()`（DEC-6 + LEG + 公理一）。
 * `PORTFOLIO_HEALTH_GATES_VERIFIED` 现在是 `computeReadiness(CURRENT_KNOWN_READINESS_INPUT).ready` 的 backward-compat 别名
 * （定义在本文件末尾就绪谓词区）——不再手翻 true，而是消费端喂真状态给 computeReadiness 自动转绿。见文件末尾「就绪谓词」区。
 */

/** 复活双触发①：可测账户数上限（人可目视规模）。越线 → 重开「要不要自动化」这个**问题**（不是自动化本身）。 */
export const REVIVAL_ACCOUNT_CAP = 30

/** 复活双触发②：UNMEASURED 收入占比线（由决策方定·先给占位 0.30）。
 *  理由：业务增长的新账户很可能偏代送/会诊/外送 → 表可长期很小、而盲区在按另一条曲线增长；只盯行数会漏掉"看不见的钱变多了"。 */
export const REVIVAL_UNMEASURED_SHARE = 0.30

// ────────────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────────────

/** 账户 CM 摘要（第 1/2 层的输入·从 HospitalCm 派生或直接给定）。 */
export interface AccountCmSummary {
  partnerId: string
  partnerName?: string | null
  cm: number // 绝对贡献毛利（院级·标准成本口径）
  inScopeRevenue: number // 进率实收
  cmRate: number // 率 = cm / inScopeRevenue（表里一列·非排序默认）
  avoidableCost: number // 可避免成本
  measurable: boolean // 可测（穿过数据 gate·非 UNMEASURED；代送/会诊/外送 = false）
  unmeasuredRevenue?: number // 该账户范围外/未测量收入（UNMEASURED·代送/会诊/外送）
  // —— 产能占用（第 3 层门控用·瓶颈实测前 undefined）——
  sharedOccupancy?: number // 共享瓶颈占用（已扣除专属产能）
  dedicatedFixedCost?: number // 专属产能成本（已入可避免成本的那部分）
}

/** 从 HospitalCm 派生账户摘要（measurable = 经营线内、非诊断桶为主）。 */
export function toAccountSummary(h: HospitalCm, opts: { measurable?: boolean; unmeasuredRevenue?: number } = {}): AccountCmSummary {
  return {
    partnerId: h.partnerId,
    partnerName: h.partnerName,
    cm: h.hospitalCm,
    inScopeRevenue: h.labRevenueInRate,
    cmRate: h.cmRate,
    avoidableCost: Math.round((h.bucketA + h.bucketB + Number.EPSILON) * 100) / 100,
    measurable: opts.measurable ?? h.revenueCaseCount > 0,
    unmeasuredRevenue: opts.unmeasuredRevenue,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// §4a 产能费单算一次（处方层底线·反螺旋冻结）—— 换岗：检测→处方（"已决定谈之后、目标价该要多少"）
// ────────────────────────────────────────────────────────────────────────────

export interface CapacityContext {
  totalFixedPool: number // 固定成本池（全量）
  /**
   * 计划期初**定死**的共享产能（反螺旋冻结·round-3 二.2 / round-4 第3项）。
   * ⚠️ 期内**不随实际走量重算**；仅计划修订时重算（修订点在趋势线打标）；且**不因"报价导致的走量流失"机械下调基数**。
   *   —— 底线驱动目标报价 → 报价激进→走量流失→基数缩小→费率抬升→再流失 = 同一个螺旋换处方通道复活；冻结分配(非费率)是唯一断轴。
   */
  plannedSharedCapacity: number
  targetProfit?: number // 目标利润（默认 0 → 纯固定回收）
  scarcityRate?: number // 瓶颈机会成本率（吃紧时·默认 0 = 闲置纯回收）；与 fixedRecoveryRate **取 max·永不相加**
  dedicatedByAccount?: Map<string, number> // 各账户专属产能成本（已入可避免成本）
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const r4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000

/** 专属产能成本合计（一个家：从共享池分子里扣掉，别双计）。 */
export function totalDedicated(ctx: CapacityContext): number {
  let s = 0
  if (ctx.dedicatedByAccount) for (const v of ctx.dedicatedByAccount.values()) s += Number(v) || 0
  return r2(s)
}

/**
 * 共享固定池 = 总固定池 − Σ专属产能成本（一个家：费率分子也扣专属，不只扣占用基数）。
 * 不变量：sharedFixedPool + Σdedicated == totalFixedPool（不重、不漏）。
 */
export function sharedFixedPool(ctx: CapacityContext): number {
  return r2(ctx.totalFixedPool - totalDedicated(ctx))
}

/** 固定回收费率 = (共享固定池 + 目标利润) / 计划共享产能（冻结分配·非随走量重算）。 */
export function fixedRecoveryRate(ctx: CapacityContext): number {
  const cap = Number(ctx.plannedSharedCapacity) || 0
  if (cap <= 0) return 0
  return r4((sharedFixedPool(ctx) + (ctx.targetProfit ?? 0)) / cap)
}

/**
 * 产能费单算一次 = 共享占用 × max(固定回收费率, 瓶颈机会成本率)。
 * 闲置→纯固定回收；瓶颈→绑定机会成本；**永不相加**。共享占用未给（瓶颈未实测）→ 返回 null（第 3 层门控·不臆造）。
 */
export function capacityCharge(account: AccountCmSummary, ctx: CapacityContext): number | null {
  if (account.sharedOccupancy == null) return null
  const rate = Math.max(fixedRecoveryRate(ctx), ctx.scarcityRate ?? 0)
  return r2((Number(account.sharedOccupancy) || 0) * rate)
}

/** 处方层底线 = 可避免成本 + 产能费（专属产能成本只有一个家：已在 avoidableCost 里）。共享占用未测 → null。 */
export function floor(account: AccountCmSummary, ctx: CapacityContext): number | null {
  const cc = capacityCharge(account, ctx)
  if (cc == null) return null
  return r2(account.avoidableCost + cc)
}

/** 目标报价 = 底线 + 谈判余量（**处方·非检测**：已决定要谈之后开多少价）。 */
export function targetPrice(account: AccountCmSummary, ctx: CapacityContext, negotiationMargin: number): number | null {
  const f = floor(account, ctx)
  if (f == null) return null
  return r2(f + (Number(negotiationMargin) || 0))
}

// ────────────────────────────────────────────────────────────────────────────
// §4b 行为层性质断言（封存进复活条款 + 终止预筛的不可谈判项）
//   netContribution(a) = inScopeRevenue − avoidableCost
//   assert netContribution(a) >= capacityCharge(a) ⇒ a 不得被自动点名 / 自动入终止预筛
//   —— 性质断言（非点名断言）：某"最大绝对贡献·最低率"账户只是当前实例；先钉死定义，防实现者"双减可避免成本"。
// ────────────────────────────────────────────────────────────────────────────

export function netContribution(account: AccountCmSummary): number {
  return r2(account.inScopeRevenue - account.avoidableCost)
}

/** 净贡献者：净贡献 ≥ 单算完整经济费用（含产能费）。共享占用未测 → 无法判定（返回 undefined·不臆造）。 */
export function isNetContributor(account: AccountCmSummary, ctx: CapacityContext): boolean | undefined {
  const cc = capacityCharge(account, ctx)
  if (cc == null) return undefined
  return netContribution(account) >= cc
}

/**
 * 是否**够格**进终止预筛（反例守卫）：真恶化（netContribution < capacityCharge）才够格。
 * ⚠️ 评估窗 = 终止门同窗·连续 N 个已结账期（避免单期噪声让豁免闪烁）；本函数按传入的窗口聚合摘要判，窗口由调用方保证。
 */
export function eligibleForTerminationPreFilter(account: AccountCmSummary, ctx: CapacityContext): boolean | undefined {
  const nc = isNetContributor(account, ctx)
  if (nc === undefined) return undefined
  return !nc // 净贡献者不够格；只有真恶化才够格
}

export interface InvariantViolation {
  partnerId: string
  netContribution: number
  capacityCharge: number | null // null = 产能费未实测·无法验证 §4b（D20 互锁拦截·非静默放行）
  reason: string
}

/**
 * 性质断言检查器（**任何未来自动点名机制都必须先过这道**）：
 * 传入一个候选点名集（未来某机制产出的），返回其中**违反不变量的账户**。
 * 现行系统不产生任何自动点名 → 候选集恒空 → 无违反。本函数是**封存的复活条款**：重建自动化时先跑它。
 *
 * ⚠️ D20 互锁：产能费(occupancy)未实测 → 无法计算 capacityCharge → **无法验证 §4b**。
 *   此时若候选集**非空**（有人在重建自动点名），**不静默放行**、直接判违反——
 *   复活前置 = 产能费已实测且 §4b 能跑；未满足前禁止任何自动点名（否则先重建点名再测产能，顶梁柱照样误伤）。
 */
export function checkTerminationPreFilter(
  accounts: AccountCmSummary[],
  ctx: CapacityContext,
  candidateFlagged: Set<string>,
): { ok: boolean; violations: InvariantViolation[] } {
  const violations: InvariantViolation[] = []
  for (const a of accounts) {
    if (!candidateFlagged.has(a.partnerId)) continue
    const cc = capacityCharge(a, ctx)
    const nc = netContribution(a)
    if (cc == null) {
      // D20 互锁：无法验证 → 拒绝（不静默 continue），把"未满足复活前置就自动点名"拦下
      violations.push({ partnerId: a.partnerId, netContribution: nc, capacityCharge: null, reason: '产能费未实测·无法验证净贡献者性质断言 → 禁止自动点名（D20 互锁·复活前置未满足）' })
      continue
    }
    if (nc >= cc) {
      violations.push({ partnerId: a.partnerId, netContribution: nc, capacityCharge: cc, reason: '净贡献者被自动点名（违反不可谈判性质断言·§4b）' })
    }
  }
  return { ok: violations.length === 0, violations }
}

// ────────────────────────────────────────────────────────────────────────────
// 第 1 层 · 组合体检（不点名任何账户）
// ────────────────────────────────────────────────────────────────────────────

export interface PortfolioHealth {
  totalCm: number // 全组合总贡献毛利
  fixedPool: number // 固定成本池
  coverageMultiple: number // 覆盖倍数 = totalCm / fixedPool
  /** 覆盖倍数**只看趋势·不信绝对值**（校准前）——做进产品的**显式标注**、非小字。绝对值判断待标准成本校准里程碑后启用。 */
  coverageMultipleTrendOnly: boolean
  capacityUtilization: number | null // 产能利用率（未实测 → null·第 3 层门控）
  // —— 复活双触发（做进体检显示·让触发是被观测到的·不靠谁记备忘录）——
  measurableAccountCount: number // 进表的可测账户数（不是在册数·UNMEASURED 不增行）
  unmeasuredRevenueShare: number // UNMEASURED 收入占比
  reopenAutomationQuestion: boolean // 双触发：可测账户数越线 或 UNMEASURED 占比越线
  revivalCap: number // = REVIVAL_ACCOUNT_CAP（随显示，便于人看到离线还多远）
  revivalUnmeasuredShareLine: number // = REVIVAL_UNMEASURED_SHARE
  // —— 影子模式（三门 A/B/C 未验收 → 输出不得进经营研判）——
  shadowMode: boolean
  gatesVerified: boolean
  disclaimer: string
}

export interface PortfolioHealthInput {
  fixedPool: number
  plannedSharedCapacity?: number // 给了 + actualSharedUsage → 算利用率
  actualSharedUsage?: number
  /** 本次请求实时算出的完整 readiness；缺省/false 均 fail-closed，禁止回退读取模块级静态常量。 */
  gatesVerified?: boolean
}

/**
 * 组合体检（第 1 层）。**不点名任何账户·不排名·不生成清单**。
 * 校准前只答"在变好还是变坏"（覆盖倍数趋势）；"够不够"的绝对值判断待标准成本校准里程碑（见终稿 §5）。
 */
export function buildPortfolioHealth(accounts: AccountCmSummary[], input: PortfolioHealthInput): PortfolioHealth {
  const measurable = accounts.filter((a) => a.measurable)
  const totalCm = r2(measurable.reduce((s, a) => s + a.cm, 0))
  const fixedPool = Number(input.fixedPool) || 0
  const coverageMultiple = fixedPool > 0 ? r4(totalCm / fixedPool) : 0

  const totalInScope = accounts.reduce((s, a) => s + (Number(a.inScopeRevenue) || 0), 0)
  const totalUnmeasured = accounts.reduce((s, a) => s + (Number(a.unmeasuredRevenue) || 0), 0)
  const denom = totalInScope + totalUnmeasured
  const unmeasuredRevenueShare = denom > 0 ? r4(totalUnmeasured / denom) : 0

  const measurableAccountCount = measurable.length
  const reopenAutomationQuestion =
    measurableAccountCount > REVIVAL_ACCOUNT_CAP || unmeasuredRevenueShare > REVIVAL_UNMEASURED_SHARE

  const capacityUtilization =
    input.plannedSharedCapacity != null && input.actualSharedUsage != null && input.plannedSharedCapacity > 0
      ? r4(input.actualSharedUsage / input.plannedSharedCapacity)
      : null

  const gatesVerified = input.gatesVerified === true
  const shadowMode = !gatesVerified
  return {
    totalCm,
    fixedPool,
    coverageMultiple,
    coverageMultipleTrendOnly: shadowMode,
    capacityUtilization,
    measurableAccountCount,
    unmeasuredRevenueShare,
    reopenAutomationQuestion,
    revivalCap: REVIVAL_ACCOUNT_CAP,
    revivalUnmeasuredShareLine: REVIVAL_UNMEASURED_SHARE,
    shadowMode,
    gatesVerified,
    disclaimer: shadowMode
      ? '影子模式·三门(库存守恒/期间键/常量冻结)未验收——覆盖倍数只看趋势·不信绝对值·输出不得进经营研判'
      : '覆盖倍数绝对值判断已启用（标准成本校准里程碑已过）',
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 第 2 层 · 人看对照表（要看单账户时）—— 绝对贡献 + 率 + 趋势**并列**·系统不排名/不打分/不生成清单
// ────────────────────────────────────────────────────────────────────────────

export interface ComparisonRow {
  partnerId: string
  partnerName?: string | null
  cm: number // 绝对贡献（**默认排序键·降序**）
  cmRate: number // 率（表里**一列**·不提供按率排序的默认视图）
  fixedCoverageShare: number // 率旁并列：占全组固定成本覆盖的份额 = cm / Σcm
  trend: number[] | null // 趋势用**同账户历史**（非跨账户对比）
  measurable: boolean
}

/**
 * 人看对照表（第 2 层）。**表的硬规格（防"人眼自己排名"把误伤从算法搬进人脑）**：
 *   · 默认按**绝对贡献降序**（不提供按率排序的默认视图）；
 *   · 率旁并列"占全组固定成本覆盖的份额"；
 *   · 趋势用同账户历史。
 * **系统不排名不打分不生成清单**——由人结合关系/战略/议价力自己权衡。
 */
export function buildComparisonTable(accounts: AccountCmSummary[], trends?: Map<string, number[]>): ComparisonRow[] {
  const totalCm = accounts.reduce((s, a) => s + (Number(a.cm) || 0), 0)
  return accounts
    .map((a) => ({
      partnerId: a.partnerId,
      partnerName: a.partnerName,
      cm: r2(a.cm),
      cmRate: r4(a.cmRate),
      fixedCoverageShare: totalCm !== 0 ? r4(a.cm / totalCm) : 0,
      trend: trends?.get(a.partnerId) ?? null,
      measurable: a.measurable,
    }))
    .sort((x, y) => y.cm - x.cm) // 默认按绝对贡献降序（顶梁柱在顶·非按率把它讲反）
}

// ════════════════════════════════════════════════════════════════════════════
// 就绪谓词 computeReadiness（DEC-6 + LEG + GOV-3 + 公理一）—— 替代硬编码 GATES_VERIFIED 开关
//   就绪 = 数据地基门全绿 ∧ 固定成本池已配置且已认账(RATIFIED·绑值版本) ∧ 历史≥N 期 ∧ 首个真实周期通过校验
//   每个未满足条件 = 带 owner + 死线(due) 的**任务**（非被动等待）；漏填 due / 过期 = **红**（改红不改炸·§六.5）。
//   ⚠️ 纯函数·**恒不调 Date.now()**：过期判定需注入 asOf（项目固定测试时钟纪律·commit 3851c19f 同款）。
// ════════════════════════════════════════════════════════════════════════════

/** 就绪四条件键（穷举·闭合枚举）。 */
export type ReadinessConditionKey = 'foundation' | 'denominator' | 'history' | 'first_period'

/**
 * 条件推进/签字方（比例原则·§二/「谁签什么」）：
 *  - `tech`：系统时序工程参数（地基门、首周期校验、N 期标准）→ 技术负责人签；
 *  - `business`：碰钱/对外结论（固定成本池认账）→ 业务决策方签·**不可代签**；
 *  - `pm`：历史≥N 期是纯日历、无人可加速 → 具名推进人（PM）月度过一遍。
 */
export type ReadinessOwnerRole = 'tech' | 'business' | 'pm'

/** 数据地基三门（§5·库存守恒 / 期间键 / 常量冻结）之一。 */
export type FoundationGate = (typeof READINESS_FOUNDATION_GATES)[number]

/** 固定成本池状态（认账绑值版本·专家第 2 轮补丁）。 */
export interface FixedPoolState {
  configured: boolean // 是否已配置（HON-5：恒 0/未配 ≠ 已配·不渲染 0）
  value: number | null
  version: string | null // 当前值的版本（值一改 → drift-guard 强制 bump）
  ratifiedVersion: string | null // 已认账(RATIFIED)的那个版本；== version 才算认账有效
}

export interface ReadinessCondition {
  key: ReadinessConditionKey
  label: string
  met: boolean
  owner: ReadinessOwnerRole
  /** 目标日期/死线（YYYY-MM-DD）。⚠️ 未满足时**必填**（公理一：忘填死线=永久绿）。history 的 due = 预计就绪日。 */
  due: string | null
  detail?: string
  /** 未满足且 due 空 = 配置错（违反公理一）→ 渲染**红**（非静默绿）。运行时软标·硬 assert 在 CI 测试。 */
  configError?: boolean
  /** 责任人与（需要时）独立复核人尚未具名指派；治理证据不完整时必须 fail-closed。 */
  assignmentError?: boolean
  /** 注入 asOf 且未满足且 due < asOf → 过期 → 渲染**红**·上 GOV-3 豁免面板。 */
  overdue?: boolean
}

export type ReadinessFindingType = 'missing_due' | 'overdue' | 'projected_ready_date_slipped'

/** 运行时红色校验发现 / 滑动告警事件（红不炸·§六.5）。 */
export interface ReadinessFinding {
  type: ReadinessFindingType
  conditionKey: ReadinessConditionKey | null
  message: string
  from?: string | null // 滑动告警：后移前的预计就绪日
  to?: string | null // 滑动告警：后移后的预计就绪日
}

export interface ReadinessInput {
  /** 数据地基门（三门 A/B/C）逐门绿否；全绿才满足 foundation。缺门 = 未绿（fail-closed）。也接布尔汇总。 */
  foundationGatesGreen: Partial<Record<FoundationGate, boolean>> | boolean
  fixedPool: FixedPoolState
  /** 已结算 ∧ 过期间键校验(DATA-4) 的完整周期数（verifiedClosedPeriods·非自然月历/草稿期）。 */
  verifiedClosedPeriods: number
  firstRealPeriodValidated: boolean
  /** 各条件 owner + 死线（未满足条件的 due 必填·公理一）。history 的 due 缺省由 projectedReadyDate 兜底。 */
  schedule?: Partial<Record<ReadinessConditionKey, { owner?: ReadinessOwnerRole; due?: string | null }>>
  /** 预计就绪日（history 的 due·纯日历投影·由调用方按周期节奏算）。 */
  projectedReadyDate?: string | null
  /** 上次记录的预计就绪日 → 新值更晚 = 后移事件（滑动告警·非页面悄悄变的日期）。 */
  previousProjectedReadyDate?: string | null
  /** 过期判定参照日（YYYY-MM-DD·**注入**·不用 wall clock）；不给 → 不判过期。 */
  asOf?: string
}

export interface ReadinessResult {
  ready: boolean
  checklist: ReadinessCondition[]
  /** 运行时红色校验发现（红不炸·§六.5）+ 滑动告警事件。 */
  findings: ReadinessFinding[]
}

/**
 * LEG·「谁签什么」缺省映射（比例原则·§二/谁签什么表·drift-guard 守）。
 * ⚠️ `denominator:'business'` = **碰钱/对外结论·业务决策方签·不可代签**——改这条 = 把认账门交给非业务方 = 静默降级。
 * 改任一映射 = 显式立法（同步 bump READINESS_PARAM_VERSION + 改 hospital-cm-constants-driftguard 测试）。
 */
export const DEFAULT_READINESS_OWNER: Record<ReadinessConditionKey, ReadinessOwnerRole> = {
  foundation: 'tech',
  denominator: 'business',
  history: 'pm',
  first_period: 'tech',
}

/**
 * 空白即缺失（fail-closed）：null/undefined/空串/纯空白 都当"没填"。
 * 防 HTML 空字段 / SQLite TEXT `''`（TEXT 区分 '' 与 NULL）击穿 due必填(公理一) 与 认账绑值门——
 * `== null` 挡不住 `''`、且 `'' !== ''`=false 会让空白版本被判"已认账"（对抗复核 CONFIRMED#1/#2）。
 */
function blank(v: string | null | undefined): boolean {
  return v == null || v.trim() === ''
}

const READINESS_CONDITION_LABEL: Record<ReadinessConditionKey, string> = {
  foundation: '数据地基门全绿（库存守恒 / 期间键 / 常量冻结）',
  denominator: '固定成本池已配置且已认账（RATIFIED·绑值版本）',
  history: `历史 ≥ ${READINESS_MIN_CLOSED_PERIODS} 个已校验完整结算周期`,
  first_period: '首个真实周期通过校验',
}

/** 地基门全绿判定（布尔汇总 or 逐门·缺门 = 未绿·fail-closed）。 */
function foundationGatesMet(g: ReadinessInput['foundationGatesGreen']): { met: boolean; redGates: FoundationGate[] } {
  if (typeof g === 'boolean') return { met: g, redGates: g ? [] : [...READINESS_FOUNDATION_GATES] }
  const redGates = READINESS_FOUNDATION_GATES.filter((gate) => g[gate] !== true)
  return { met: redGates.length === 0, redGates }
}

/**
 * 固定成本池认账判定（**认账绑值版本**·专家第 2 轮补丁）：
 *   已配置 ∧ 值>0 ∧ version == ratifiedVersion（签的是"那个值(版本Y)"、非字段）。
 *   值一改 → drift-guard 强制 version 变 → ≠ ratifiedVersion → 自动回 UNRATIFIED、判未满足。
 */
function denominatorRatified(p: FixedPoolState): { met: boolean; detail: string } {
  // Number.isFinite 挡 Infinity/-Infinity/NaN（记忆 coreone-node-sqlite-infinity-write：node:sqlite 对 REAL 列接受 Infinity）——
  // 固定成本池 = Infinity 是坏值、绝不能当"已配置"放行；NaN>0 本就 false，Infinity>0 却为 true 故须显式拦。
  if (!p.configured || p.value == null || !Number.isFinite(p.value) || !(p.value > 0)) {
    return { met: false, detail: '未配置（HON-5：不渲染 0·先配置固定成本池）' }
  }
  // blank() 而非 == null：空白/纯空格版本语义 = 无版本/从未认账，绝不能因 '' === '' 字面相等被判"已认账"放行（CONFIRMED#2）。
  if (blank(p.version)) return { met: false, detail: '已配置但无版本号（无法绑值认账）' }
  if (blank(p.ratifiedVersion)) return { met: false, detail: 'UNRATIFIED：值已配置但未认账（业务决策方签字·不可代签）' }
  if (p.version !== p.ratifiedVersion) {
    return { met: false, detail: `认账已失效：当前值版本(${p.version}) ≠ 已认账版本(${p.ratifiedVersion})——值被改过、需重新认账（绑值版本·自动回 UNRATIFIED）` }
  }
  return { met: true, detail: `已认账·版本 ${p.version}` }
}

/**
 * 就绪谓词（纯函数·§二 + §六.5）。返回 `{ ready, checklist:[{key,met,owner,due,...}], findings }`。
 * `ready = checklist.every(met)`；任一未满足 → 非就绪 → 影子模式（输出不得进经营研判）。
 * **红不改炸**：未满足且漏填 due / 已过期 → 产出红色 finding + 条件标 configError/overdue（**不抛异常**）；
 *   硬 assert（无 due 的未满足条件必被判红）挪进 CI 测试（见 readiness-predicate.test.ts）。
 */
export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const findings: ReadinessFinding[] = []
  const sched = input.schedule ?? {}
  // 空白 due 归一成 null（fail-closed）：'' 不是合法死线·必须落进公理一红标（CONFIRMED#1）。
  const norm = (v: string | null | undefined): string | null => (blank(v) ? null : v!)
  const dueOf = (k: ReadinessConditionKey): string | null => {
    const s = sched[k]
    // history 的 due = 预计就绪日（缺省由 projectedReadyDate 兜底·纯日历·加速不了）
    if (k === 'history') return norm(s?.due) ?? norm(input.projectedReadyDate) ?? null
    return norm(s?.due) ?? null
  }
  const ownerOf = (k: ReadinessConditionKey): ReadinessOwnerRole => sched[k]?.owner ?? DEFAULT_READINESS_OWNER[k]

  const fnd = foundationGatesMet(input.foundationGatesGreen)
  const den = denominatorRatified(input.fixedPool)
  const closed = Number(input.verifiedClosedPeriods) || 0
  const historyMet = closed >= READINESS_MIN_CLOSED_PERIODS
  const firstMet = input.firstRealPeriodValidated === true

  const raw: Array<{ key: ReadinessConditionKey; met: boolean; detail: string }> = [
    { key: 'foundation', met: fnd.met, detail: fnd.met ? '三门全绿' : `未绿门：${fnd.redGates.join(' / ')}` },
    { key: 'denominator', met: den.met, detail: den.detail },
    { key: 'history', met: historyMet, detail: `已校验完整周期 ${closed}/${READINESS_MIN_CLOSED_PERIODS}（纯日历·无法加速 → due=预计就绪日）` },
    { key: 'first_period', met: firstMet, detail: firstMet ? '首个真实周期已通过校验' : '首个真实周期尚未通过校验' },
  ]

  const checklist: ReadinessCondition[] = raw.map((c) => {
    const due = dueOf(c.key)
    const cond: ReadinessCondition = { key: c.key, label: READINESS_CONDITION_LABEL[c.key], met: c.met, owner: ownerOf(c.key), due, detail: c.detail }
    if (!c.met && blank(due)) { // blank() 双保险：即便 dueOf 归一被绕过，空白 due 仍判红（防击穿公理一）
      cond.due = null // 归一：空白死线在 checklist 里落成 null（渲染层直接红·不留 '' 假象）
      cond.configError = true // 公理一：未满足且无死线 = 红（不静默绿·白名单刚修掉的那个 bug）
      findings.push({ type: 'missing_due', conditionKey: c.key, message: `条件「${cond.label}」未满足且未填死线（违反公理一）→ 红：必须补 owner + 死线` })
    }
    if (!c.met && due != null && input.asOf != null && due < input.asOf) {
      cond.overdue = true // 过期变红·上 GOV-3 豁免面板
      findings.push({ type: 'overdue', conditionKey: c.key, message: `条件「${cond.label}」死线 ${due} 已过期（asOf ${input.asOf}）→ 红·上 GOV-3 豁免面板` })
    }
    return cond
  })

  // 滑动告警：预计就绪日后移 = **一个事件**（告警 + 上豁免面板·不是页面上悄悄变的日期）
  // norm() 归一空白（与 dueOf 同款·CONFIRMED#1 一致性）：空白 prev = 从未记录过预计日 = 没"后移"，
  //   否则 '' 字典序 < 任何真日期 → 会误报"从 <空> 后移到 X"（对抗复核确认批 LOW·闭合本函数最后一条裸串日期路径）。
  const prev = norm(input.previousProjectedReadyDate)
  const now = norm(input.projectedReadyDate)
  if (!historyMet && prev != null && now != null && now > prev) {
    findings.push({ type: 'projected_ready_date_slipped', conditionKey: 'history', from: prev, to: now, message: `预计就绪日后移：${prev} → ${now}（某期未过校验·verifiedClosedPeriods 未涨）→ 告警 + 上 GOV-3 豁免面板` })
  }

  const ready = checklist.every((c) => c.met)
  return { ready, checklist, findings }
}

/**
 * 当前已知就绪状态快照（现实：三门未全验收 / 池未认账 / 历史 0 期 / 首周期未校验）。
 * ⚠️ 这是「现实状态」**输入**·非可乱翻的旋钮——地基门落地 / 池认账 / N 期到 / 首周期校验过后，
 *    由消费端（route/前端·**另 task**）改用 `computeReadiness(实时探测真状态)` 喂真值；
 *    此默认仅供 backward-compat const 与 buildPortfolioHealth 无实时 readiness 时 fail-closed（= 影子模式）。
 * 未满足条件的 due 均已填（满足公理一）；改这些死线/owner = 显式立法（drift-guard 守）。
 */
export const CURRENT_KNOWN_READINESS_INPUT: ReadinessInput = {
  foundationGatesGreen: { inventory_conservation: false, period_key: false, constant_freeze: false },
  fixedPool: { configured: false, value: null, version: null, ratifiedVersion: null },
  verifiedClosedPeriods: 0,
  firstRealPeriodValidated: false,
  schedule: {
    foundation: { owner: 'tech', due: '2026-09-30' },
    denominator: { owner: 'business', due: '2026-08-31' },
    history: { owner: 'pm', due: null }, // due 由 projectedReadyDate 兜底（预计就绪日）
    first_period: { owner: 'tech', due: '2026-10-31' },
  },
  projectedReadyDate: '2026-10-31',
  previousProjectedReadyDate: '2026-10-31',
}

/** 当前已知就绪结果（模块级算一次·供 backward-compat const + buildPortfolioHealth 默认 fail-closed）。 */
export const CURRENT_KNOWN_READINESS: ReadinessResult = computeReadiness(CURRENT_KNOWN_READINESS_INPUT)

/**
 * @deprecated 改用 `computeReadiness()`。保留供既有 route（`hospital-pnl-v1.1.ts`）/测试 backward-compat。
 * 语义 = **全就绪谓词**是否绿（数据地基门 ∧ 池已认账 ∧ 历史≥N ∧ 首周期校验）——现实 = `false`（影子模式）。
 * 全绿后**不是手翻此常量**，而是消费端喂真状态给 `computeReadiness` 自动转绿（drift-guard 守现实态 = false）。
 */
export const PORTFOLIO_HEALTH_GATES_VERIFIED: boolean = CURRENT_KNOWN_READINESS.ready
