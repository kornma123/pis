/**
 * 组合体检 + 人看对照表 + 性质断言 —— P0 四轮外审收敛终稿顶层框架回归。
 *
 * 承重测试 = **ACC-D 性质断言（§4b）**：ACC-D（东安县医院·绝对贡献最大 ¥36,994、率最低 68.7%）是**净贡献者**，
 *   四代不同机制在它身上同方向误判正是"按率排名选错分析单位"的证据 → 本断言**封存**：净贡献者不得被自动点名。
 *   数据来源 = 记忆 coreone-cm-target-attempt-real-data（ACC-D ¥36,994 > 和睦家 ¥22,348 > 新城 ¥4,979）。
 */
import { describe, it, expect } from 'vitest'
import {
  buildPortfolioHealth,
  buildComparisonTable,
  checkTerminationPreFilter,
  eligibleForTerminationPreFilter,
  isNetContributor,
  netContribution,
  capacityCharge,
  sharedFixedPool,
  totalDedicated,
  fixedRecoveryRate,
  toAccountSummary,
  type AccountCmSummary,
  type CapacityContext,
  PORTFOLIO_HEALTH_GATES_VERIFIED,
} from '../src/utils/portfolio-health.js'

// —— 三账户（真数据数量级）：ACC-D 顶梁柱（大额薄利·率最低），ACC-A 高率小额，ACC-C 最小 ——
const ACC_D: AccountCmSummary = { partnerId: 'ACC-D', partnerName: '东安县医院', inScopeRevenue: 53848, avoidableCost: 16854, cm: 36994, cmRate: 0.687, measurable: true, unmeasuredRevenue: 0, sharedOccupancy: 500 }
const ACC_A: AccountCmSummary = { partnerId: 'ACC-A', partnerName: '和睦家系', inScopeRevenue: 25986, avoidableCost: 3638, cm: 22348, cmRate: 0.86, measurable: true, unmeasuredRevenue: 0, sharedOccupancy: 300 }
const ACC_C: AccountCmSummary = { partnerId: 'ACC-C', partnerName: '新城', inScopeRevenue: 5946, avoidableCost: 967, cm: 4979, cmRate: 0.8373, measurable: true, unmeasuredRevenue: 0, sharedOccupancy: 100 }
const ACCOUNTS = [ACC_D, ACC_A, ACC_C]

// 产能上下文：固定池 40000 / 计划共享产能 1000 单位 → 回收费率 40/单位
const CTX: CapacityContext = { totalFixedPool: 40000, plannedSharedCapacity: 1000, targetProfit: 0 }
// capacityCharge：ACC-D 500×40=20000 · ACC-A 300×40=12000 · ACC-C 100×40=4000

describe('§4b 行为层性质断言：净贡献者不得被自动点名（ACC-D 封存条款）', () => {
  it('ACC-D 净贡献 36994 ≥ 产能费 20000 → 净贡献者', () => {
    expect(netContribution(ACC_D)).toBe(36994) // 53848 − 16854
    expect(capacityCharge(ACC_D, CTX)).toBe(20000) // 500 × 40
    expect(isNetContributor(ACC_D, CTX)).toBe(true)
    // 三家都是净贡献者
    expect(ACCOUNTS.every((a) => isNetContributor(a, CTX) === true)).toBe(true)
  })

  it('把"按率排名点名最低率"的 ACC-D 塞进候选点名集 → 断言逮住违反（这正是四轮要避免的误伤）', () => {
    const naiveFlag = new Set(['ACC-D']) // 某天有人按率排名，点了率最低的顶梁柱
    const r = checkTerminationPreFilter(ACCOUNTS, CTX, naiveFlag)
    expect(r.ok).toBe(false)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0].partnerId).toBe('ACC-D')
  })

  it('反例守卫：真恶化账户（净贡献 < 产能费）够格进终止预筛、点名它不算违反', () => {
    const ACC_BAD: AccountCmSummary = { partnerId: 'ACC-BAD', inScopeRevenue: 5000, avoidableCost: 6000, cm: -1000, cmRate: -0.2, measurable: true, sharedOccupancy: 50 }
    // netContribution −1000 < capacityCharge 2000 → 非净贡献者 → 够格
    expect(isNetContributor(ACC_BAD, CTX)).toBe(false)
    expect(eligibleForTerminationPreFilter(ACC_BAD, CTX)).toBe(true)
    const r = checkTerminationPreFilter([...ACCOUNTS, ACC_BAD], CTX, new Set(['ACC-BAD']))
    expect(r.ok).toBe(true) // 点名真恶化账户不违反断言
  })

  it('共享占用未测（第 3 层门控）→ 不臆造产能费', () => {
    const noOcc: AccountCmSummary = { ...ACC_D, sharedOccupancy: undefined }
    expect(capacityCharge(noOcc, CTX)).toBeNull()
    expect(isNetContributor(noOcc, CTX)).toBeUndefined()
  })

  it('D20 互锁：产能费未测 + 有候选点名集 → 拒绝（不静默放行），未点名则 ok', () => {
    const noOcc: AccountCmSummary = { ...ACC_D, sharedOccupancy: undefined }
    // 有人在产能费未测时喂候选点名集 → 拦下（复活前置未满足）
    const flagged = checkTerminationPreFilter([noOcc], CTX, new Set(['ACC-D']))
    expect(flagged.ok).toBe(false)
    expect(flagged.violations[0].capacityCharge).toBeNull()
    expect(flagged.violations[0].reason).toContain('D20')
    // 没点名任何账户 → 不违反（现行系统候选恒空 = 天然 ok）
    expect(checkTerminationPreFilter([noOcc], CTX, new Set()).ok).toBe(true)
  })
})

describe('§4a 产能费单算一次 + 一个家不变量', () => {
  it('sharedFixedPool + Σdedicated == totalFixedPool（不重、不漏）', () => {
    const ctx: CapacityContext = { ...CTX, dedicatedByAccount: new Map([['ACC-D', 5000]]) }
    expect(totalDedicated(ctx)).toBe(5000)
    expect(sharedFixedPool(ctx)).toBe(35000) // 40000 − 5000
    expect(sharedFixedPool(ctx) + totalDedicated(ctx)).toBe(ctx.totalFixedPool)
  })
  it('固定回收费率 = (共享池 + 目标利润) / 计划共享产能（冻结分配）', () => {
    expect(fixedRecoveryRate(CTX)).toBe(40) // 40000/1000
  })
})

describe('第 2 层 人看对照表：默认按绝对贡献降序·不按率', () => {
  it('顶梁柱 ACC-D 排在最上（绝对贡献最大）——而非按率把它讲反排最下', () => {
    const rows = buildComparisonTable(ACCOUNTS)
    expect(rows.map((r) => r.partnerId)).toEqual(['ACC-D', 'ACC-A', 'ACC-C']) // 36994 > 22348 > 4979
    // 率是表里一列（存在但不主导排序）
    expect(rows[0].cmRate).toBe(0.687) // ACC-D 率最低却排第一
    // 率旁并列"占全组固定成本覆盖份额"
    expect(rows[0].fixedCoverageShare).toBe(0.5751) // 36994 / 64321
  })
  it('趋势用同账户历史（传入即透出·非跨账户对比）', () => {
    const rows = buildComparisonTable(ACCOUNTS, new Map([['ACC-D', [30000, 33000, 36994]]]))
    expect(rows[0].trend).toEqual([30000, 33000, 36994])
    expect(rows[1].trend).toBeNull()
  })

  it('D2：UNMEASURED 行的贡献、率、覆盖份额保持 unknown/null，并排在可测行之后', () => {
    const unmeasured: AccountCmSummary = {
      partnerId: 'ACC-U',
      partnerName: '零病例医院',
      inScopeRevenue: 0,
      avoidableCost: 0,
      cm: 0,
      cmRate: 0,
      measurable: false,
    }
    const rows = buildComparisonTable([unmeasured, ...ACCOUNTS])
    expect(rows.at(-1)).toMatchObject({
      partnerId: 'ACC-U',
      measurable: false,
      cm: null,
      cmRate: null,
      fixedCoverageShare: null,
    })
  })
})

describe('第 1 层 组合体检：覆盖倍数只看趋势 + 影子模式 + 复活双触发', () => {
  it('覆盖倍数 = ∑CM / 固定池·标 trendOnly·影子模式', () => {
    const h = buildPortfolioHealth(ACCOUNTS, { fixedPool: 40000, unmeasuredRevenueScopeAndDenominatorVerified: true })
    expect(h.totalCm).toBe(64321) // 36994+22348+4979
    expect(h.coverageMultiple).toBe(1.608) // 64321/40000
    expect(h.coverageMultipleTrendOnly).toBe(true)
    expect(h.shadowMode).toBe(true) // 三门未验收
    expect(h.gatesVerified).toBe(false)
    expect(h.measurableAccountCount).toBe(3)
    expect(h.reopenAutomationQuestion).toBe(false) // 3 ≤ 30 且无 UNMEASURED
  })

  it('本次请求的实时 readiness 为真时可退出影子态；不再被模块级旧常量永久锁死', () => {
    const h = buildPortfolioHealth(ACCOUNTS, { fixedPool: 40000, gatesVerified: true })
    expect(h.shadowMode).toBe(false)
    expect(h.gatesVerified).toBe(true)
    expect(h.coverageMultipleTrendOnly).toBe(false)
  })

  it('复活双触发②：UNMEASURED 收入占比越线 → 重开自动化问题（表没变大但看不见的钱变多了）', () => {
    // 加一个 UNMEASURED 账户（代送/会诊/外送·measurable=false·不进表行数但占收入）
    const unmeasured: AccountCmSummary = { partnerId: 'ACC-U', inScopeRevenue: 0, avoidableCost: 0, cm: 0, cmRate: 0, measurable: false, unmeasuredRevenue: 200000 }
    const h = buildPortfolioHealth([...ACCOUNTS, unmeasured], { fixedPool: 40000, unmeasuredRevenueScopeAndDenominatorVerified: true })
    expect(h.measurableAccountCount).toBe(3) // UNMEASURED 不增表行数
    expect(h.unmeasuredRevenueShare).toBeGreaterThan(0.3)
    expect(h.reopenAutomationQuestion).toBe(true) // UNMEASURED 占比越线触发
  })

  it('D2：缺固定池时固定池与覆盖倍数都保持 unknown/null，不伪造 0', () => {
    const h = buildPortfolioHealth(ACCOUNTS, {})
    expect(h.fixedPool).toBeNull()
    expect(h.coverageMultiple).toBeNull()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'D2：无效固定池 %s 不可作为分母，固定池与覆盖倍数均为 null',
    (fixedPool) => {
      const h = buildPortfolioHealth(ACCOUNTS, { fixedPool })
      expect(h.fixedPool).toBeNull()
      expect(h.coverageMultiple).toBeNull()
    },
  )

  it.each([Number.MIN_VALUE, 1e-308])(
    'D2：极小正固定池 %s 使覆盖倍数溢出时，保留池值但倍数为 null',
    (fixedPool) => {
      const h = buildPortfolioHealth(ACCOUNTS, { fixedPool })
      expect(h.fixedPool).toBe(fixedPool)
      expect(h.coverageMultiple).toBeNull()
    },
  )

  it('D2：未证明全量医院范围与收入分母时，未测占比及其复活判断保持 unknown/null', () => {
    const unmeasured: AccountCmSummary = {
      partnerId: 'ACC-U',
      inScopeRevenue: 0,
      avoidableCost: 0,
      cm: 0,
      cmRate: 0,
      measurable: false,
      unmeasuredRevenue: 200000,
    }
    const h = buildPortfolioHealth([...ACCOUNTS, unmeasured], { fixedPool: 40000 })
    expect(h.unmeasuredRevenueShare).toBeNull()
    expect(h.reopenAutomationQuestion).toBeNull()
  })

  it('D2：占比未知不会抹掉已知的账户数越线触发（三值 OR）', () => {
    const overCap = Array.from({ length: 31 }, (_, index): AccountCmSummary => ({
      ...ACC_D,
      partnerId: `ACC-${index + 1}`,
    }))
    const h = buildPortfolioHealth(overCap, { fixedPool: 40000 })
    expect(h.unmeasuredRevenueShare).toBeNull()
    expect(h.reopenAutomationQuestion).toBe(true)
  })

  it('D2：分母经显式验证后沿用原公式/阈值；真实零仍是可展示的 0', () => {
    const knownZero = buildPortfolioHealth(ACCOUNTS, {
      fixedPool: 40000,
      unmeasuredRevenueScopeAndDenominatorVerified: true,
    })
    expect(knownZero.unmeasuredRevenueShare).toBe(0)
    expect(knownZero.reopenAutomationQuestion).toBe(false)

    const unmeasured: AccountCmSummary = {
      partnerId: 'ACC-U',
      inScopeRevenue: 0,
      avoidableCost: 0,
      cm: 0,
      cmRate: 0,
      measurable: false,
      unmeasuredRevenue: 200000,
    }
    const knownHigh = buildPortfolioHealth([...ACCOUNTS, unmeasured], {
      fixedPool: 40000,
      unmeasuredRevenueScopeAndDenominatorVerified: true,
    })
    expect(knownHigh.unmeasuredRevenueShare).toBe(0.6998)
    expect(knownHigh.reopenAutomationQuestion).toBe(true)
  })

  it('D2：PARTIAL 账户的显式未测金额仍进入原公式，不因 measurable=true 被漏掉', () => {
    const partial = { ...ACC_D, unmeasuredRevenue: 50000 }
    const h = buildPortfolioHealth([partial, ACC_A, ACC_C], {
      fixedPool: 40000,
      unmeasuredRevenueScopeAndDenominatorVerified: true,
    })
    expect(h.unmeasuredRevenueShare).toBe(0.3682)
    expect(h.reopenAutomationQuestion).toBe(true)
  })

  it('D2：即便调用方声称分母已验证，缺金额或负金额仍 fail-closed 为 unknown/null', () => {
    const incomplete: AccountCmSummary = {
      partnerId: 'ACC-U', inScopeRevenue: 0, avoidableCost: 0, cm: 0, cmRate: 0, measurable: false,
    }
    const negative: AccountCmSummary = { ...incomplete, unmeasuredRevenue: -1 }
    expect(buildPortfolioHealth([...ACCOUNTS, incomplete], {
      fixedPool: 40000,
      unmeasuredRevenueScopeAndDenominatorVerified: true,
    }).unmeasuredRevenueShare).toBeNull()
    expect(buildPortfolioHealth([...ACCOUNTS, negative], {
      fixedPool: 40000,
      unmeasuredRevenueScopeAndDenominatorVerified: true,
    }).unmeasuredRevenueShare).toBeNull()
  })

  it('D2：已验证范围但分母为 0 或金额非有限数时，占比仍不可算', () => {
    const zero: AccountCmSummary = {
      partnerId: 'ACC-Z', inScopeRevenue: 0, avoidableCost: 0, cm: 0, cmRate: 0, measurable: true, unmeasuredRevenue: 0,
    }
    const infinite: AccountCmSummary = { ...zero, partnerId: 'ACC-INF', unmeasuredRevenue: Number.POSITIVE_INFINITY }
    expect(buildPortfolioHealth([zero], {
      fixedPool: 40000,
      unmeasuredRevenueScopeAndDenominatorVerified: true,
    }).unmeasuredRevenueShare).toBeNull()
    expect(buildPortfolioHealth([infinite], {
      fixedPool: 40000,
      unmeasuredRevenueScopeAndDenominatorVerified: true,
    }).unmeasuredRevenueShare).toBeNull()
  })

  it('D2：已测收入为负数或非有限数时，即使已声明完整也不可算占比', () => {
    for (const inScopeRevenue of [-1, Number.POSITIVE_INFINITY]) {
      const invalid = { ...ACC_D, inScopeRevenue }
      expect(buildPortfolioHealth([invalid, ACC_A, ACC_C], {
        fixedPool: 40000,
        unmeasuredRevenueScopeAndDenominatorVerified: true,
      }).unmeasuredRevenueShare).toBeNull()
    }
  })

  it('产能利用率：未实测 → null（第 3 层门控·不臆造）', () => {
    expect(buildPortfolioHealth(ACCOUNTS, { fixedPool: 40000 }).capacityUtilization).toBeNull()
    expect(buildPortfolioHealth(ACCOUNTS, { fixedPool: 40000, plannedSharedCapacity: 1000, actualSharedUsage: 900 }).capacityUtilization).toBe(0.9)
  })
})

describe('toAccountSummary：从 HospitalCm 派生（avoidableCost = 桶A+桶B）', () => {
  it('派生摘要', () => {
    const hospital = { partnerId: 'ACC-A', partnerName: '和睦家系', hospitalCm: 116.64, labRevenueInRate: 200, cmRate: 0.5832, bucketA: 45, bucketB: 38.36, revenueCaseCount: 1, nonIhcRevenue: 12 } as any
    const s = toAccountSummary(hospital)
    expect(s.cm).toBe(116.64)
    expect(s.avoidableCost).toBe(83.36) // 45+38.36
    expect(s.measurable).toBe(true)
    expect(s.unmeasuredRevenue).toBeUndefined() // 非 IHC 收入不在本层擅自晋升为未测分子
    expect(toAccountSummary(hospital, {
      measurable: false,
      unmeasuredRevenue: 12,
    }).unmeasuredRevenue).toBe(12)
  })
})

describe('影子模式常量', () => {
  it('三门未验收 → PORTFOLIO_HEALTH_GATES_VERIFIED=false（翻 true = 显式立法）', () => {
    expect(PORTFOLIO_HEALTH_GATES_VERIFIED).toBe(false)
  })
})
