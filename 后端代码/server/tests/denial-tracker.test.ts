/**
 * 行为验证：P-3 拒绝写审计的纯状态机 createDenialTracker（middleware/audit-log.ts）。
 *
 * 为什么单独测纯类：聚合/告警/滚动窗口是有状态逻辑，用真 HTTP 测阈值会撞 60s 真实时钟 → 慢且脆。
 * 故把决策逻辑抽成注入时钟的纯工厂，这里在**手核的边界时间戳**上断言**可观察决策**
 * （逐条 vs 抑制 vs 告警），而非重推它自己的算术（防同义反复假测试）。
 * 中间件→DB 落库的 wiring 由 bv-write-audit-middleware.test.ts 的真 HTTP 集成用例覆盖。
 */
import { describe, it, expect } from 'vitest'
import { createDenialTracker } from '../src/middleware/audit-log.js'

// 可控时钟 + 小阈值，确定性
function mk(overrides: Record<string, unknown> = {}) {
  const clock = { t: 1_000_000 }
  const tr = createDenialTracker({
    now: () => clock.t,
    windowMs: 1000,
    aggThreshold: 3,
    alertDistinct: 2,
    alertHammer: 100,
    ...overrides,
  })
  return { clock, tr }
}
const other = (subjectKey: string, i: number) =>
  ({ subjectKey, statusClass: 'other' as const, endpoint: `PUT /x/${i}`, newId: `agg-${subjectKey}-o-${i}` })
const authz = (subjectKey: string, ep: string) =>
  ({ subjectKey, statusClass: 'authz' as const, endpoint: ep, newId: `agg-${subjectKey}-a-${ep}` })

describe('createDenialTracker：逐条 vs 聚合（比较符边界）', () => {
  it('前 AGG 条逐条、第 AGG+1 条起抑制并即时可持久聚合（aggThreshold=3：N-1/N/N+1）', () => {
    const { tr } = mk()
    const d1 = tr.record(other('u', 1))
    expect(d1.action).toBe('individual')
    expect(d1.totalCount).toBe(1)
    expect(tr.record(other('u', 2)).action).toBe('individual')
    const d3 = tr.record(other('u', 3)) // N=3 仍逐条（<= AGG）
    expect(d3.action).toBe('individual')
    expect(d3.totalCount).toBe(3)
    const d4 = tr.record(other('u', 4)) // N+1=4 → 首次抑制
    expect(d4.action).toBe('suppressed')
    expect(d4.aggInsert).toBe(true)
    expect(d4.suppressedCount).toBe(1)
    expect(d4.totalCount).toBe(4)
    const d5 = tr.record(other('u', 5)) // 第二次抑制 → 复用同一聚合行、只 UPDATE
    expect(d5.action).toBe('suppressed')
    expect(d5.aggInsert).toBe(false)
    expect(d5.aggId).toBe(d4.aggId)
    expect(d5.suppressedCount).toBe(2)
    expect(d5.totalCount).toBe(5)
  })
})

describe('createDenialTracker：越权探测告警', () => {
  it('distinct 端点广度达阈值 → 告警一次（每窗口只一次）', () => {
    const { tr } = mk() // alertDistinct=2
    expect(tr.record(authz('u', 'POST /users')).alert).toBeNull() // distinct 1
    expect(tr.record(authz('u', 'POST /roles')).alert).toEqual({ distinctEndpoints: 2, count: 2 })
    expect(tr.record(authz('u', 'POST /suppliers')).alert).toBeNull() // 已告警，只一次
  })

  it('单端点重试风暴不误报（distinct 恒 1，从不告警）', () => {
    const { tr } = mk({ alertDistinct: 2, alertHammer: 100 })
    for (let i = 0; i < 10; i++) {
      expect(tr.record(authz('u', 'POST /users')).alert).toBeNull()
    }
  })

  it('单端点重锤兜底：原始计数达 hammer 阈值即告警', () => {
    const { tr } = mk({ alertDistinct: 99, alertHammer: 3 })
    expect(tr.record(authz('u', 'POST /users')).alert).toBeNull() // count 1
    expect(tr.record(authz('u', 'POST /users')).alert).toBeNull() // count 2
    expect(tr.record(authz('u', 'POST /users')).alert).toEqual({ distinctEndpoints: 1, count: 3 })
  })

  it('other(非 403) 不参与告警计数', () => {
    const { tr } = mk({ alertDistinct: 2 })
    tr.record(other('u', 1))
    tr.record(other('u', 2))
    expect(tr.record(other('u', 3)).alert).toBeNull() // other 洪水从不触发告警
  })
})

describe('createDenialTracker：滚动窗口整窗重置', () => {
  it('跨窗后计数/聚合/告警全清、可再次告警（now-windowStart===WINDOW_MS 即滚动）', () => {
    const { clock, tr } = mk({ windowMs: 1000, aggThreshold: 3, alertDistinct: 2 })
    tr.record(authz('u', 'POST /a'))
    expect(tr.record(authz('u', 'POST /b')).alert).not.toBeNull() // 窗1 告警
    clock.t += 999
    const still = tr.record(authz('u', 'POST /c'))
    expect(still.windowRolled).toBe(false) // 999 < WINDOW_MS，仍同窗
    clock.t += 1 // now-windowStart == 1000 == WINDOW_MS → 滚动
    const rolled = tr.record(authz('u', 'POST /a'))
    expect(rolled.windowRolled).toBe(true)
    expect(rolled.totalCount).toBe(1) // 计数重置
    expect(rolled.alert).toBeNull() // 新窗 distinct 1，未达阈值
    expect(tr.record(authz('u', 'POST /b')).alert).not.toBeNull() // 新窗可再告警（alerted 已清）
  })

  it('跨窗后聚合重开（aggId 清空 → 再次 aggInsert=true）', () => {
    const { clock, tr } = mk({ windowMs: 1000, aggThreshold: 2 })
    tr.record(other('u', 1))
    tr.record(other('u', 2))
    expect(tr.record(other('u', 3)).aggInsert).toBe(true) // 窗1 首次抑制
    clock.t += 1000
    const first = tr.record(other('u', 4)) // 新窗第一条 → 触发滚动
    expect(first.windowRolled).toBe(true) // windowRolled 只标记触发滚动的那一条
    expect(first.totalCount).toBe(1)
    tr.record(other('u', 5)) // 新窗 count 2
    const reAgg = tr.record(other('u', 6)) // 新窗首次抑制 → 新聚合行（aggId 已随滚动清空）
    expect(reAgg.windowRolled).toBe(false) // 滚动发生在 u4，此条同窗
    expect(reAgg.aggInsert).toBe(true)
  })
})

describe('createDenialTracker：类隔离 + 主体隔离', () => {
  it('other 洪水被抑制不淹没 authz 逐条取证', () => {
    const { tr } = mk({ aggThreshold: 2 })
    tr.record(other('u', 1))
    tr.record(other('u', 2))
    expect(tr.record(other('u', 3)).action).toBe('suppressed') // other 已抑制
    const a = tr.record(authz('u', 'POST /users'))
    expect(a.action).toBe('individual') // authz 仍逐条，未被 other 波及
    expect(a.statusClass).toBe('authz')
    expect(a.totalCount).toBe(1)
  })

  it('不同 subject 计数互相独立', () => {
    const { tr } = mk({ aggThreshold: 2 })
    tr.record(other('u1', 1))
    tr.record(other('u1', 2))
    expect(tr.record(other('u1', 3)).action).toBe('suppressed') // u1 抑制
    const u2 = tr.record(other('u2', 1))
    expect(u2.action).toBe('individual') // u2 独立、未受 u1 影响
    expect(u2.totalCount).toBe(1)
  })
})

describe('createDenialTracker：内存安全网（sweep / 驱逐 / 过期）', () => {
  const o = (subjectKey: string, i: number) =>
    ({ subjectKey, statusClass: 'other' as const, endpoint: 'x', newId: `n-${subjectKey}-${i}` })

  it('超过 MAX_SUBJECTS → 最旧 subject 被驱逐（内存有界；抓 sort 方向翻转变异）', () => {
    const clock = { t: 1_000_000 }
    const tr = createDenialTracker({ now: () => clock.t, windowMs: 1_000_000, aggThreshold: 99, maxSubjects: 3 })
    clock.t = 1_000_000
    tr.record(o('u_old', 1))
    clock.t = 1_000_001
    tr.record(o('u_old', 2)) // u_old 计数 2、最旧窗口
    for (let i = 0; i < 10; i++) {
      clock.t = 1_000_100 + i // 各自更新的 windowStart，u_old 恒为最旧
      tr.record(o(`u${i}`, i))
    }
    expect(tr.size()).toBeLessThanOrEqual(3 + 1) // 有界（摊还 sweep-then-add，瞬时至多 cap+1）
    // u_old 已被「最旧先驱逐」清掉 → 再记它是全新条目（count 从 1、非续到 3）
    clock.t = 1_000_200
    const reAppear = tr.record(o('u_old', 9))
    expect(reAppear.totalCount).toBe(1) // sort 若翻成 b-a(留最旧/逐最新)，u_old 会被保留 → 此处将是 3，断言变红
    expect(reAppear.windowRolled).toBe(false) // 全新条目(map 无此 key)非滚动
  })

  it('摊还清扫(达 DENIAL_SWEEP_EVERY 事件)删除过期窗口，回收内存（抓过期谓词翻转变异）', () => {
    const clock = { t: 0 }
    const tr = createDenialTracker({ now: () => clock.t, windowMs: 1000, aggThreshold: 999, maxSubjects: 100_000 })
    for (let i = 0; i < 3; i++) tr.record(o(`old${i}`, i)) // 3 个活跃窗口，windowStart=0
    expect(tr.size()).toBe(3)
    clock.t = 10_000 // 远超 windowMs → old0-2 全部过期
    for (let i = 0; i < 256; i++) tr.record(o('driver', i)) // 打满 256 事件触发摊还 sweep
    // sweep 先删过期窗口(old0-2, 10000>=1000)；driver(windowStart=10000)未过期保留
    expect(tr.size()).toBe(1) // 过期谓词若翻成 <（永不删），old0-2 会残留 → size=4，断言变红
  })
})

describe('createDenialTracker：同步临界区不变量', () => {
  it('record() 返回同步值（非 thenable）——保证临界区无 await/交错', () => {
    const { tr } = mk()
    const d = tr.record(other('u', 1)) as any
    expect(d && typeof d.then).not.toBe('function')
  })
})
