/**
 * 逐抗体细粒度初判 · 复用线 A 抗体名 resolver（DRY 收敛 · 健壮性）—— 纯口径 TDD。
 *
 * 收敛两点（都不是 bug，是 DRY/健壮性；见 PR「reconcile 复用 antibody-name-map」）：
 *  ① isRealAntibodyMarker 的**名字兜底分支**委托线 A `classifyMarker`（判为「抗体」才算真抗体）。
 *     · advice_type 白名单仍是**主信号**（权威、优先）——本组前 3 例锁「主信号优先不变」。
 *     · 无 advice_type 时，名字兜底改用 classifyMarker → `免组HE`/`分子`/特染(PAS/Masson/网状…) 也能正确剔除
 *       （#40 旧兜底 `/白片|重切|深切/`＋精确 `^he$` 会漏判成抗体）。
 *  ② classifyCaseHints 分组键从原始名改为 `normalizeAntibodyName`（展示仍用原始名）——
 *     同蜡块两片把同抗体拼成 `Ki67`/`Ki-67` 时不再漏判返工。
 *
 * 线索非定论·财务终判·不改差异计数/认定/补收 gate/golden。
 */
import { describe, it, expect } from 'vitest'
import { isRealAntibodyMarker, classifyCaseHints, type MarkerRow } from '../src/utils/reconcile-account.js'

describe('DRY① isRealAntibodyMarker · advice_type 主信号优先（不变）', () => {
  it('有 advice_type：白名单 Y000001/Y000003 → true，即便名字像特染/工序（advice 权威压过名字）', () => {
    // 名字像特染，但 advice_type 判为抗体 → 认 advice（主信号优先，行为不变）
    expect(isRealAntibodyMarker({ markerName: 'PAS', waxNo: 'A1', adviceType: 'Y000001' })).toBe(true)
    expect(isRealAntibodyMarker({ markerName: '免组HE', waxNo: 'A1', adviceType: 'Y000003' })).toBe(true)
  })
  it('有 advice_type：非白名单（Y000006/Y000007/未文档化）→ false，即便名字像抗体', () => {
    expect(isRealAntibodyMarker({ markerName: 'CK7', waxNo: 'A1', adviceType: 'Y000007' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: 'CD20', waxNo: 'A1', adviceType: 'Y000005' })).toBe(false)
  })
})

describe('DRY① isRealAntibodyMarker · 无 advice_type 名字兜底委托 classifyMarker', () => {
  it('具名真抗体（无码）→ true（不变）', () => {
    expect(isRealAntibodyMarker({ markerName: 'ALK', waxNo: 'A1' })).toBe(true)
    expect(isRealAntibodyMarker({ markerName: 'Ki-67', waxNo: 'A1' })).toBe(true)
    // 含 "HE" 但非精确 HE 的真抗体不误伤（HER2/hepatocyte/HGAL…）
    expect(isRealAntibodyMarker({ markerName: 'HER2', waxNo: 'A1' })).toBe(true)
    expect(isRealAntibodyMarker({ markerName: 'Hepatocyte', waxNo: 'A1' })).toBe(true)
  })
  it('工序标签（无码）→ false（不变）', () => {
    expect(isRealAntibodyMarker({ markerName: 'HE', waxNo: 'A1' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: '普通白片', waxNo: 'A1' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: '重切', waxNo: 'A1' })).toBe(false)
  })
  it('【收敛红线】无码时 免组HE → false（旧兜底精确 ^he$ 会漏判成抗体）', () => {
    expect(isRealAntibodyMarker({ markerName: '免组HE', waxNo: 'A1' })).toBe(false)
  })
  it('【收敛红线】无码时 分子（白片）→ false（旧兜底不认 bare 分子）', () => {
    expect(isRealAntibodyMarker({ markerName: '分子', waxNo: 'A1' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: '分子白片', waxNo: 'A1' })).toBe(false)
  })
  it('【收敛红线】无码时 特染 → false（旧兜底完全漏判成抗体）', () => {
    expect(isRealAntibodyMarker({ markerName: 'PAS', waxNo: 'A1' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: 'Masson', waxNo: 'A1' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: '网状纤维染色', waxNo: 'A1' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: '抗酸', waxNo: 'A1' })).toBe(false)
  })
})

describe('DRY② classifyCaseHints · 规范化分组键（展示仍用原始名）', () => {
  it('【收敛红线】同蜡块 Ki67 / Ki-67 → 判返工（拼写差异归一后 distinct 切片≥2）', () => {
    const markers: MarkerRow[] = [
      { markerName: 'Ki67', waxNo: 'A2', sectionNo: 'A2-01', adviceType: 'Y000001' },
      { markerName: 'Ki-67', waxNo: 'A2', sectionNo: 'A2-02', adviceType: 'Y000001' },
    ]
    const rework = classifyCaseHints(markers).find((h) => h.hintType === '疑似返工')
    expect(rework).toBeDefined()
    expect(rework?.occurrences).toBe(2)
    // 展示名仍是原始拼写，不是规范化后的 KI67
    expect(['Ki67', 'Ki-67']).toContain(rework?.markerName)
  })
  it('跨蜡块 CK7 → 多病灶（不变，非返工）', () => {
    const markers: MarkerRow[] = [
      { markerName: 'CK7', waxNo: 'A2', adviceType: 'Y000001' },
      { markerName: 'CK7', waxNo: 'A4', adviceType: 'Y000001' },
    ]
    const hints = classifyCaseHints(markers)
    expect(hints.find((h) => h.hintType === '多病灶')?.occurrences).toBe(2)
    expect(hints.find((h) => h.hintType === '疑似返工')).toBeUndefined()
  })
  it('不同抗体（CK7 vs CK20）规范化不同 → 不误并（各自独立，无假返工）', () => {
    const markers: MarkerRow[] = [
      { markerName: 'CK7', waxNo: 'A2', sectionNo: 'A2-01', adviceType: 'Y000001' },
      { markerName: 'CK20', waxNo: 'A2', sectionNo: 'A2-02', adviceType: 'Y000001' },
    ]
    expect(classifyCaseHints(markers).find((h) => h.hintType === '疑似返工')).toBeUndefined()
  })

  // —— 歧义键碰撞防护（复用线 A ambiguousNorm）——
  // TCR(a/b)=TCRαβ 与 TCR(G/D)=TCRγδ 是台账里**两种不同抗体**，去克隆号后都→'TCR'（seed 里唯一歧义键）。
  // 规范化合并会把它们误并→伪造返工/多病灶（后者=对双计费的错误指控）。必须不合并。
  it('【碰撞防护】TCR(a/b) 与 TCR(G/D) 跨蜡块 → 不误报多病灶（两种不同抗体，非同抗体多病灶）', () => {
    const markers: MarkerRow[] = [
      { markerName: 'TCR(a/b)', waxNo: 'A2', sectionNo: 'A2-01', adviceType: 'Y000001' },
      { markerName: 'TCR(G/D)', waxNo: 'A4', sectionNo: 'A4-01', adviceType: 'Y000001' },
    ]
    expect(classifyCaseHints(markers).find((h) => h.hintType === '多病灶')).toBeUndefined()
  })
  it('【碰撞防护】TCR(a/b) 与 TCR(G/D) 同蜡块不同切片 → 不误报返工（不同抗体，非返工）', () => {
    const markers: MarkerRow[] = [
      { markerName: 'TCR(a/b)', waxNo: 'A2', sectionNo: 'A2-01', adviceType: 'Y000001' },
      { markerName: 'TCR(G/D)', waxNo: 'A2', sectionNo: 'A2-02', adviceType: 'Y000001' },
    ]
    expect(classifyCaseHints(markers).find((h) => h.hintType === '疑似返工')).toBeUndefined()
  })
  it('同一 TCR(a/b) 真重复（同蜡块不同切片）仍判返工（歧义防护不误伤真返工）', () => {
    const markers: MarkerRow[] = [
      { markerName: 'TCR(a/b)', waxNo: 'A2', sectionNo: 'A2-01', adviceType: 'Y000001' },
      { markerName: 'TCR(a/b)', waxNo: 'A2', sectionNo: 'A2-02', adviceType: 'Y000001' },
    ]
    const rework = classifyCaseHints(markers).find((h) => h.hintType === '疑似返工')
    expect(rework).toMatchObject({ markerName: 'TCR(a/b)', waxNo: 'A2', occurrences: 2 })
  })
})
