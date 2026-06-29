/**
 * P2 — 业务线分类引擎测试（替换 revenue-attribution A/B/C seam）。
 * 边界：前缀优先 / 全角归一 / 空前缀不匹配一切(v3地基坑) / 歧义 / 未匹配 / 仅 enabled 线 / 计入移出。
 */
import { describe, it, expect } from 'vitest'
import { classify, startsWithPrefix, containsKeyword } from '../src/utils/classifier.js'
import { seedDefaultConfig, type PartnerConfigLine } from '../src/utils/partner-config.js'

const L = seedDefaultConfig({ name: 'X', code: 'x' }).lines

describe('startsWithPrefix / containsKeyword（NFKC + 空值不匹配一切）', () => {
  it('空前缀/空关键词永不匹配（v3 修：曾匹配一切静默全错）', () => {
    expect(startsWithPrefix('S26-001', '')).toBe(false)
    expect(containsKeyword('任意文本', '')).toBe(false)
    expect(startsWithPrefix('', 'S')).toBe(false)
  })
  it('NFKC 全角归一：Ｈ ≈ H、全角数字', () => {
    expect(startsWithPrefix('Ｈ26-001', 'H')).toBe(true)
    expect(containsKeyword('ＰＤ-Ｌ１检测', 'PD-L1')).toBe(true)
  })
})

describe('classify 前缀优先', () => {
  it('M 号 → 外送NGS（移出 out）', () => {
    const r = classify(L, { no: 'M26-00017', item: '基因组病理检测（BRAF）' })
    expect(r.kind).toBe('matched')
    if (r.kind === 'matched') { expect(r.line.key).toBe('ngs'); expect(r.scope).toBe('out'); expect(r.by).toContain('前缀') }
  })
  it('冰 号 → 院内冰冻（计入 in）', () => {
    const r = classify(L, { no: '冰64853', item: '' })
    expect(r.kind).toBe('matched')
    if (r.kind === 'matched') { expect(r.line.key).toBe('frozen'); expect(r.scope).toBe('in') }
  })
  it('全角Ｈ → 线下外院会诊（计入 in）', () => {
    const r = classify(L, { no: 'Ｈ26-001', item: '会诊' })
    expect(r.kind).toBe('matched')
    if (r.kind === 'matched') expect(r.line.key).toBe('consult')
  })
})

describe('classify 关键词/备注', () => {
  it('手术标本 → 组织学（in）', () => {
    const r = classify(L, { no: 'S26-001', item: '手术标本检查与诊断(小标本)' })
    expect(r.kind).toBe('matched')
    if (r.kind === 'matched') { expect(r.line.key).toBe('histo'); expect(r.scope).toBe('in') }
  })
  it('TCT → 细胞·宫颈TCT（in）', () => {
    const r = classify(L, { no: 'C26-001', item: '妇科TCT检测' })
    if (r.kind === 'matched') expect(r.line.key).toBe('cyto')
    else throw new Error('应命中')
  })
  it('共建分成（备注/项目含分成）→ joint_share（out）', () => {
    const r = classify(L, { no: '', item: '科室共建利润分成净额' })
    expect(r.kind).toBe('matched')
    if (r.kind === 'matched') { expect(r.line.key).toBe('joint_share'); expect(r.scope).toBe('out') }
  })
  it('备注命中：remote 线远程（备注含「远程」）', () => {
    const r = classify(L, { no: 'X1', item: '某项目', remark: '远程会诊' })
    expect(r.kind).toBe('matched')
    if (r.kind === 'matched') expect(r.line.key).toBe('remote')
  })
  it('无命中 → none', () => {
    expect(classify(L, { no: 'X1', item: '组织学中英文报告-外籍人士' }).kind).toBe('none')
  })
})

describe('classify 歧义 + enabled 过滤', () => {
  const custom: PartnerConfigLine[] = [
    { key: 'a', name: '免疫线', on: true, scope: 'in', prefixes: [], keywords: ['免疫'], remarks: [] },
    { key: 'b', name: '组化线', on: true, scope: 'out', prefixes: [], keywords: ['组化'], remarks: [] },
    { key: 'c', name: '停用线', on: false, scope: 'in', prefixes: ['Z'], keywords: ['停用词'], remarks: [] },
  ]
  it('项目同时命中两条 enabled 线 → ambiguous', () => {
    const r = classify(custom, { no: '', item: '免疫组化染色' })
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.lines.map((l) => l.key).sort()).toEqual(['a', 'b'])
  })
  it('on=false 的线不参与（前缀 Z / 关键词 停用词 都不命中）', () => {
    expect(classify(custom, { no: 'Z9', item: '停用词' }).kind).toBe('none')
  })
})

describe('codex 修复回归', () => {
  it('F6 大小写折叠：关键词 panel 命中 Panel；前缀 M 命中小写 m', () => {
    const k = classify(L, { no: '', item: '泛癌 Panel 测序' })
    expect(k.kind).toBe('matched')
    if (k.kind === 'matched') expect(k.line.key).toBe('ngs')
    const p = classify(L, { no: 'm26-001', item: '' })
    expect(p.kind).toBe('matched')
    if (p.kind === 'matched') { expect(p.line.key).toBe('ngs'); expect(p.scope).toBe('out') }
  })
  it('F7 最长前缀优先：H(in) 与 HE(out) 共存时，HE26-001 命中 HE(out) 而非 H(in)', () => {
    const lines: PartnerConfigLine[] = [
      { key: 'h', name: 'H线', on: true, scope: 'in', prefixes: ['H'], keywords: [], remarks: [] },
      { key: 'he', name: 'HE线', on: true, scope: 'out', prefixes: ['HE'], keywords: [], remarks: [] },
    ]
    const r = classify(lines, { no: 'HE26-001', item: '' })
    expect(r.kind).toBe('matched')
    if (r.kind === 'matched') { expect(r.line.key).toBe('he'); expect(r.scope).toBe('out') }
    // 反向：纯 H 号仍命中 H 线
    const r2 = classify(lines, { no: 'H26-001', item: '' })
    if (r2.kind === 'matched') expect(r2.line.key).toBe('h')
  })
  it('HIGH-5 同长前缀并列：两条 enabled 线都配 H，H26-1 → 歧义(不静默取首条)', () => {
    const lines: PartnerConfigLine[] = [
      { key: 'a', name: 'A线', on: true, scope: 'in', prefixes: ['H'], keywords: [], remarks: [] },
      { key: 'b', name: 'B线', on: true, scope: 'out', prefixes: ['H'], keywords: [], remarks: [] },
    ]
    const r = classify(lines, { no: 'H26-1', item: '' })
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.lines.map((l) => l.key).sort()).toEqual(['a', 'b'])
  })
})
