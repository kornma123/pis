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

/**
 * 三门 A/B/C（库存守恒 / 期间键 / 常量冻结）验收标志（终稿 §5·`~/Desktop/非P0域-修复方案.md`）。
 * **false = 影子模式**：体检可先跑、先校数据管道，但**输出不得进任何经营研判**，直到三门验收。
 * 未装三门时体检吃的成本/收入/趋势数据会"报喜不报忧"（成本静默算低 → 覆盖倍数虚高 / 传错月 → 趋势虚假跳变）。
 * 三门在本仓落地（各自 PR）后，把此常量翻 true = 解除影子模式（drift-guard 测试守，翻牌 = 显式立法动作）。
 */
export const PORTFOLIO_HEALTH_GATES_VERIFIED = false

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
  coverageMultipleTrendOnly: true
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

  const shadowMode = !PORTFOLIO_HEALTH_GATES_VERIFIED
  return {
    totalCm,
    fixedPool,
    coverageMultiple,
    coverageMultipleTrendOnly: true,
    capacityUtilization,
    measurableAccountCount,
    unmeasuredRevenueShare,
    reopenAutomationQuestion,
    revivalCap: REVIVAL_ACCOUNT_CAP,
    revivalUnmeasuredShareLine: REVIVAL_UNMEASURED_SHARE,
    shadowMode,
    gatesVerified: PORTFOLIO_HEALTH_GATES_VERIFIED,
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
