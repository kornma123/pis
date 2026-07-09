/**
 * 就绪谓词 computeReadiness —— DEC-6 + LEG + 公理一 + §六.5「改红不改炸」的回归 + 机器证。
 *
 * 承重断言（专家补丁 3 条 + §六.5）：
 *   ① 认账绑值版本：pool.version === pool.ratifiedVersion 才算认账有效（值被改 → 自动回 UNRATIFIED）。
 *   ② due 必填修公理一：未满足条件漏填 due → **红**（configError + missing_due finding），**不抛异常**。
 *   ③ 滑动告警：预计就绪日后移 = 一个事件（finding·上豁免面板·非页面悄悄变的日期）。
 *   §六.5 硬 assert 挪进 CI：本文件「无 due 的未满足条件必被判红」= 机器证红色机制生效（非靠人眼）。
 */
import { describe, it, expect } from 'vitest'
import {
  computeReadiness,
  CURRENT_KNOWN_READINESS,
  CURRENT_KNOWN_READINESS_INPUT,
  PORTFOLIO_HEALTH_GATES_VERIFIED,
  READINESS_MIN_CLOSED_PERIODS,
  READINESS_FOUNDATION_GATES,
  READINESS_PARAM_VERSION,
  type ReadinessInput,
} from '../src/utils/portfolio-health.js'

// —— 一个「全绿」输入构造器（就绪所有条件都满足）——
function readyInput(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    foundationGatesGreen: { inventory_conservation: true, period_key: true, constant_freeze: true },
    fixedPool: { configured: true, value: 100000, version: 'v1', ratifiedVersion: 'v1' },
    verifiedClosedPeriods: READINESS_MIN_CLOSED_PERIODS,
    firstRealPeriodValidated: true,
    schedule: {
      foundation: { owner: 'tech', due: '2026-09-30' },
      denominator: { owner: 'business', due: '2026-08-31' },
      history: { owner: 'pm', due: null },
      first_period: { owner: 'tech', due: '2026-10-31' },
    },
    projectedReadyDate: '2026-10-31',
    ...over,
  }
}

describe('computeReadiness · 全绿路径', () => {
  it('四条件全满足 → ready:true·无红色 finding', () => {
    const r = computeReadiness(readyInput())
    expect(r.ready).toBe(true)
    expect(r.checklist).toHaveLength(4)
    expect(r.checklist.every((c) => c.met)).toBe(true)
    expect(r.checklist.every((c) => !c.configError && !c.overdue)).toBe(true)
    expect(r.findings).toHaveLength(0)
    // checklist 形状：{key,met,owner,due}
    expect(r.checklist.map((c) => c.key).sort()).toEqual(['denominator', 'first_period', 'foundation', 'history'])
  })

  it('任一条件未满足 → ready:false（非就绪 = 影子模式）', () => {
    expect(computeReadiness(readyInput({ firstRealPeriodValidated: false })).ready).toBe(false)
    expect(computeReadiness(readyInput({ verifiedClosedPeriods: 2 })).ready).toBe(false)
    expect(computeReadiness(readyInput({ foundationGatesGreen: false })).ready).toBe(false)
  })
})

describe('computeReadiness · 数据地基门（缺门 fail-closed）', () => {
  it('三门逐门给·全绿才满足；缺一门/false 一门 → 未满足 + detail 列红门', () => {
    const twoGreen = computeReadiness(readyInput({ foundationGatesGreen: { inventory_conservation: true, period_key: true } }))
    const fnd = twoGreen.checklist.find((c) => c.key === 'foundation')!
    expect(fnd.met).toBe(false) // 缺 constant_freeze = fail-closed
    expect(fnd.detail).toContain('constant_freeze')
  })
  it('布尔汇总也接：true=全绿·false=全红', () => {
    expect(computeReadiness(readyInput({ foundationGatesGreen: true })).checklist.find((c) => c.key === 'foundation')!.met).toBe(true)
    expect(computeReadiness(readyInput({ foundationGatesGreen: false })).checklist.find((c) => c.key === 'foundation')!.met).toBe(false)
  })
})

describe('computeReadiness · 固定成本池认账绑值版本（专家补丁①）', () => {
  const base = readyInput()
  it('已配置 ∧ version==ratifiedVersion → 认账有效·met', () => {
    const c = computeReadiness(base).checklist.find((x) => x.key === 'denominator')!
    expect(c.met).toBe(true)
    expect(c.detail).toContain('已认账')
  })
  it('未配置 → 未满足 + HON-5「未配置」态（不渲染 0）', () => {
    const c = computeReadiness(readyInput({ fixedPool: { configured: false, value: null, version: null, ratifiedVersion: null } })).checklist.find((x) => x.key === 'denominator')!
    expect(c.met).toBe(false)
    expect(c.detail).toContain('未配置')
  })
  it('值恒 0 → 视为未配置（HON-5·不渲染 0）', () => {
    const c = computeReadiness(readyInput({ fixedPool: { configured: true, value: 0, version: 'v1', ratifiedVersion: 'v1' } })).checklist.find((x) => x.key === 'denominator')!
    expect(c.met).toBe(false)
    expect(c.detail).toContain('未配置')
  })
  it('坏值 Infinity/NaN/负 → 视为未配置（Number.isFinite 挡·node:sqlite REAL 列会吞 Infinity）', () => {
    for (const bad of [Infinity, -Infinity, NaN, -5]) {
      const c = computeReadiness(readyInput({ fixedPool: { configured: true, value: bad, version: 'v1', ratifiedVersion: 'v1' } })).checklist.find((x) => x.key === 'denominator')!
      expect(c.met).toBe(false)
      expect(c.detail).toContain('未配置')
    }
  })
  it('已配置但未认账 → UNRATIFIED·未满足', () => {
    const c = computeReadiness(readyInput({ fixedPool: { configured: true, value: 100000, version: 'v1', ratifiedVersion: null } })).checklist.find((x) => x.key === 'denominator')!
    expect(c.met).toBe(false)
    expect(c.detail).toContain('UNRATIFIED')
  })
  it('⭐绑值版本核心：签了旧值(v1)、值被改成 v2 → version≠ratifiedVersion → 自动回 UNRATIFIED·未满足', () => {
    const c = computeReadiness(readyInput({ fixedPool: { configured: true, value: 120000, version: 'v2', ratifiedVersion: 'v1' } })).checklist.find((x) => x.key === 'denominator')!
    expect(c.met).toBe(false)
    expect(c.detail).toContain('认账已失效')
    expect(c.detail).toContain('v2')
    expect(c.detail).toContain('v1')
  })
  it('⭐空白版本不得判「已认账」（CONFIRMED#2·防 SQLite TEXT \'\' 击穿·空串/纯空格均 met:false）', () => {
    for (const v of ['', '   ']) {
      const c = computeReadiness(readyInput({ fixedPool: { configured: true, value: 100000, version: v, ratifiedVersion: v } })).checklist.find((x) => x.key === 'denominator')!
      expect(c.met).toBe(false) // '' === '' 字面相等·但语义 = 从未认账 → 绝不放行
      expect(c.detail).toContain('无版本号')
    }
    // 已认账版本空白（值有版本但认账版本空）→ UNRATIFIED
    const c2 = computeReadiness(readyInput({ fixedPool: { configured: true, value: 100000, version: 'v1', ratifiedVersion: '' } })).checklist.find((x) => x.key === 'denominator')!
    expect(c2.met).toBe(false)
    expect(c2.detail).toContain('UNRATIFIED')
  })
})

describe('computeReadiness · 历史≥N 期（N=3·纯日历）', () => {
  it('2 期 < 3 → 未满足；3 期 = N → 满足', () => {
    expect(computeReadiness(readyInput({ verifiedClosedPeriods: 2 })).checklist.find((c) => c.key === 'history')!.met).toBe(false)
    expect(computeReadiness(readyInput({ verifiedClosedPeriods: 3 })).checklist.find((c) => c.key === 'history')!.met).toBe(true)
  })
  it('history 的 due = 预计就绪日（缺 schedule.due 时由 projectedReadyDate 兜底）', () => {
    const c = computeReadiness(readyInput({ verifiedClosedPeriods: 1, projectedReadyDate: '2026-12-31' })).checklist.find((x) => x.key === 'history')!
    expect(c.met).toBe(false)
    expect(c.due).toBe('2026-12-31') // 兜底成功 → 未满足但有 due → 不判红
    expect(c.configError).toBeUndefined()
  })
})

describe('computeReadiness · §六.5 改红不改炸 + 公理一（CI 硬 assert）', () => {
  it('⭐机器证：未满足且漏填 due → 判红（configError + missing_due finding），且**不抛异常**', () => {
    // history 未满足、且 projectedReadyDate 也缺 → due 无兜底 → 必须红（非静默绿）
    const input = readyInput({ verifiedClosedPeriods: 0, projectedReadyDate: null, schedule: { history: { owner: 'pm', due: null } } })
    let r!: ReturnType<typeof computeReadiness>
    expect(() => { r = computeReadiness(input) }).not.toThrow() // 红不炸
    const hist = r.checklist.find((c) => c.key === 'history')!
    expect(hist.met).toBe(false)
    expect(hist.due).toBeNull()
    expect(hist.configError).toBe(true) // 渲染红
    expect(r.findings.some((f) => f.type === 'missing_due' && f.conditionKey === 'history')).toBe(true)
  })

  it('⭐CI 完备性 assert：任何输入下，「未满足 ∧ due 空」的条件都被判红（configError）——机器替人眼', () => {
    // 构造一个每条件都未满足、且全部漏填 due 的极端输入
    const allUnmetNoDue: ReadinessInput = {
      foundationGatesGreen: false,
      fixedPool: { configured: false, value: null, version: null, ratifiedVersion: null },
      verifiedClosedPeriods: 0,
      firstRealPeriodValidated: false,
      schedule: {
        foundation: { owner: 'tech', due: null },
        denominator: { owner: 'business', due: null },
        history: { owner: 'pm', due: null },
        first_period: { owner: 'tech', due: null },
      },
      projectedReadyDate: null, // history 无兜底
    }
    const r = computeReadiness(allUnmetNoDue)
    // 硬不变量：没有任何「未满足 ∧ due 空」的条件逃过红标（= 公理一「忘填死线≠永久绿」被机器守住）
    const silentlyGreen = r.checklist.filter((c) => !c.met && c.due == null && c.configError !== true)
    expect(silentlyGreen).toEqual([])
    expect(r.checklist.filter((c) => c.configError).length).toBe(4) // 四条件全判红
    expect(r.findings.filter((f) => f.type === 'missing_due').length).toBe(4)
  })

  it('⭐空白 due（\'\' / 纯空格）= 漏填 → 判红（CONFIRMED#1·防 HTML 空字段/SQLite \'\' 击穿公理一）', () => {
    for (const bad of ['', '   ']) {
      const r = computeReadiness(readyInput({ foundationGatesGreen: false, asOf: undefined, schedule: { foundation: { owner: 'tech', due: bad } } }))
      const fnd = r.checklist.find((c) => c.key === 'foundation')!
      expect(fnd.met).toBe(false)
      expect(fnd.due).toBeNull() // 空白归一成 null（渲染层直接红·不留 '' 假象）
      expect(fnd.configError).toBe(true)
      expect(r.findings.some((f) => f.type === 'missing_due' && f.conditionKey === 'foundation')).toBe(true)
    }
    // history 兜底也不被空白 projectedReadyDate 击穿
    const rh = computeReadiness(readyInput({ verifiedClosedPeriods: 0, projectedReadyDate: '', schedule: { history: { owner: 'pm', due: '' } } }))
    const hist = rh.checklist.find((c) => c.key === 'history')!
    expect(hist.due).toBeNull()
    expect(hist.configError).toBe(true)
  })

  it('空白 due + 注入 asOf → 只判 missing_due·不误报 overdue（\'\' 字典序 < 任何日期·归一成 null 后 overdue 分支不触发）', () => {
    const r = computeReadiness(readyInput({ foundationGatesGreen: false, asOf: '2026-11-15', schedule: { foundation: { owner: 'tech', due: '' } } }))
    const fnd = r.checklist.find((c) => c.key === 'foundation')!
    expect(fnd.configError).toBe(true)
    expect(fnd.overdue).toBeUndefined() // 归一 null → overdue 分支 due!=null 为假 → 不误标过期
    expect(r.findings.some((f) => f.type === 'missing_due' && f.conditionKey === 'foundation')).toBe(true)
    expect(r.findings.some((f) => f.type === 'overdue' && f.conditionKey === 'foundation')).toBe(false)
  })

  it('未满足但 due 已填 → 不判 configError（有死线 = 合规任务·非配置错）', () => {
    const r = computeReadiness(readyInput({ firstRealPeriodValidated: false }))
    const fp = r.checklist.find((c) => c.key === 'first_period')!
    expect(fp.met).toBe(false)
    expect(fp.due).toBe('2026-10-31')
    expect(fp.configError).toBeUndefined()
    expect(r.findings.some((f) => f.type === 'missing_due')).toBe(false)
  })
})

describe('computeReadiness · 过期变红（注入 asOf·无 wall clock）', () => {
  it('未满足 + due < asOf → overdue 红 + overdue finding（上 GOV-3 豁免面板）', () => {
    const r = computeReadiness(readyInput({ firstRealPeriodValidated: false, asOf: '2026-11-15' }))
    const fp = r.checklist.find((c) => c.key === 'first_period')! // due 2026-10-31 < asOf 2026-11-15
    expect(fp.overdue).toBe(true)
    expect(r.findings.some((f) => f.type === 'overdue' && f.conditionKey === 'first_period')).toBe(true)
  })
  it('不给 asOf → 不判过期（纯函数·不臆造当前日期）', () => {
    const r = computeReadiness(readyInput({ firstRealPeriodValidated: false }))
    expect(r.checklist.every((c) => !c.overdue)).toBe(true)
    expect(r.findings.some((f) => f.type === 'overdue')).toBe(false)
  })
  it('已满足条件即使 due 早于 asOf 也不算过期', () => {
    const r = computeReadiness(readyInput({ asOf: '2027-01-01' }))
    expect(r.checklist.every((c) => !c.overdue)).toBe(true)
  })
})

describe('computeReadiness · 滑动告警（专家补丁③）', () => {
  it('预计就绪日后移（prev < now）+ history 未满足 → slip 事件 finding', () => {
    const r = computeReadiness(readyInput({ verifiedClosedPeriods: 1, previousProjectedReadyDate: '2026-10-31', projectedReadyDate: '2026-12-31' }))
    const slip = r.findings.find((f) => f.type === 'projected_ready_date_slipped')
    expect(slip).toBeDefined()
    expect(slip!.from).toBe('2026-10-31')
    expect(slip!.to).toBe('2026-12-31')
    expect(slip!.conditionKey).toBe('history')
  })
  it('预计就绪日未后移（prev == now）→ 无 slip 事件', () => {
    const r = computeReadiness(readyInput({ verifiedClosedPeriods: 1, previousProjectedReadyDate: '2026-10-31', projectedReadyDate: '2026-10-31' }))
    expect(r.findings.some((f) => f.type === 'projected_ready_date_slipped')).toBe(false)
  })
  it('history 已满足（≥N）→ 不再报后移（已到就绪）', () => {
    const r = computeReadiness(readyInput({ verifiedClosedPeriods: 3, previousProjectedReadyDate: '2026-10-31', projectedReadyDate: '2026-12-31' }))
    expect(r.findings.some((f) => f.type === 'projected_ready_date_slipped')).toBe(false)
  })
  it('空白 previousProjectedReadyDate（\'\' / 空格）→ 不误报后移（从未记录预计日 = 没后移·norm 归一后 guard 短路）', () => {
    for (const prev of ['', '   ']) {
      const r = computeReadiness(readyInput({ verifiedClosedPeriods: 0, previousProjectedReadyDate: prev, projectedReadyDate: '2026-12-31' }))
      expect(r.findings.some((f) => f.type === 'projected_ready_date_slipped')).toBe(false) // 不再报 "从 <空> 后移到 X"
    }
  })
})

describe('就绪谓词 · 现实态 + backward-compat', () => {
  it('CURRENT_KNOWN_READINESS 现实 = 未就绪（三门未验收/池未认账/0 期/首周期未校验）', () => {
    expect(CURRENT_KNOWN_READINESS.ready).toBe(false)
    expect(CURRENT_KNOWN_READINESS.checklist.every((c) => !c.met)).toBe(true)
  })
  it('现实态快照的未满足条件 due 均已填（满足公理一·无 configError）', () => {
    expect(CURRENT_KNOWN_READINESS.checklist.every((c) => c.due != null)).toBe(true)
    expect(CURRENT_KNOWN_READINESS.checklist.some((c) => c.configError)).toBe(false)
    expect(CURRENT_KNOWN_READINESS.findings.filter((f) => f.type === 'missing_due')).toEqual([])
  })
  it('PORTFOLIO_HEALTH_GATES_VERIFIED = computeReadiness(现实态).ready = false（backward-compat·现在是算出来的）', () => {
    expect(PORTFOLIO_HEALTH_GATES_VERIFIED).toBe(false)
    expect(PORTFOLIO_HEALTH_GATES_VERIFIED).toBe(CURRENT_KNOWN_READINESS.ready)
    expect(PORTFOLIO_HEALTH_GATES_VERIFIED).toBe(computeReadiness(CURRENT_KNOWN_READINESS_INPUT).ready)
  })
})

describe('LEG 参数登记 drift-guard（改 = 显式立法·具名+版本化）', () => {
  it('N=3·两限定进登记（改值 = bump 版本 + 改本测试）', () => {
    expect(READINESS_MIN_CLOSED_PERIODS).toBe(3)
  })
  it('数据地基门集 = {库存守恒/期间键/常量冻结}（具名闭合）', () => {
    expect([...READINESS_FOUNDATION_GATES]).toEqual(['inventory_conservation', 'period_key', 'constant_freeze'])
  })
  it('阈值登记版本钉死（改任一 READINESS_* 阈值/门集 = 同步 bump 此版本）', () => {
    expect(READINESS_PARAM_VERSION).toBe('2026-07-09.a')
  })
  it('⭐「谁签什么」缺省映射行为钉死（CONFIRMED#3·空/缺 schedule 时 checklist owner 落缺省）', () => {
    // 空 schedule → 各条件 owner 走缺省映射；denominator 必须是 business（碰钱·不可代签）
    const r = computeReadiness(readyInput({ schedule: {} }))
    const ownerOf = (k: string) => r.checklist.find((c) => c.key === k)!.owner
    expect(ownerOf('denominator')).toBe('business') // 认账门签字方·改成 tech/pm = 静默把不可代签门交给非业务方
    expect(ownerOf('foundation')).toBe('tech')
    expect(ownerOf('history')).toBe('pm')
    expect(ownerOf('first_period')).toBe('tech')
  })
})
