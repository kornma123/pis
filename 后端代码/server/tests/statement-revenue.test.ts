/**
 * P2 — 对账单收入归集测试（实验室收入 = Σ(IN 结算)）。
 *
 * 黄金锚：上海和睦家 W4 25 case（全组织学 IN）→ labRevenue = ¥13,152（逐行手算交叉核，见下）。
 * 守恒红线：labRevenue + outSettle + unmatchedSettle + ambiguousSettle == Σ全行 settle == declaredTotal（不静默吞）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedDefaultConfig, type PartnerConfig } from '../src/utils/partner-config.js'
import { parseLineItems, type Grid, type ParsedRow } from '../src/utils/statement-parser/index.js'
import { computeStatementRevenue, resolveRate } from '../src/utils/statement-revenue.js'

// —— 和睦家 W4（单据2026062607544902号收费单据.xls，用户确认准确；仅病理号+金额，无 PII）——
const HEMUJIA_W4: Array<{ caseNo: string; gross: number; net: number }> = [
  { caseNo: 'S26-02637', gross: 340, net: 302 }, { caseNo: 'S26-02638', gross: 645, net: 546 },
  { caseNo: 'S26-02639', gross: 315, net: 282 }, { caseNo: 'S26-02640', gross: 480, net: 414 },
  { caseNo: 'S26-02646', gross: 315, net: 282 }, { caseNo: 'S26-02647', gross: 495, net: 396 },
  { caseNo: 'S26-02648', gross: 190, net: 152 }, { caseNo: 'S26-02678', gross: 315, net: 282 },
  { caseNo: 'S26-02679', gross: 2810, net: 2278 }, { caseNo: 'S26-02680', gross: 315, net: 282 },
  { caseNo: 'S26-02681', gross: 190, net: 152 }, { caseNo: 'S26-02682', gross: 645, net: 546 },
  { caseNo: 'S26-02687', gross: 340, net: 302 }, { caseNo: 'S26-02688', gross: 190, net: 152 },
  { caseNo: 'S26-02689', gross: 315, net: 282 }, { caseNo: 'S26-02690', gross: 480, net: 414 },
  { caseNo: 'S26-02691', gross: 1930, net: 1544 }, { caseNo: 'S26-02692', gross: 645, net: 546 },
  { caseNo: 'S26-02693', gross: 340, net: 302 }, { caseNo: 'S26-02724', gross: 340, net: 302 },
  { caseNo: 'S26-02725', gross: 2625, net: 2100 }, { caseNo: 'S26-02726', gross: 580, net: 494 },
  { caseNo: 'S26-02727', gross: 190, net: 152 }, { caseNo: 'S26-02728', gross: 620, net: 496 },
  { caseNo: 'S26-02739', gross: 190, net: 152 },
]
const cfg = (): PartnerConfig => seedDefaultConfig({ name: '上海和睦家医院', code: 'PT-HMJ' })

describe('GOLDEN 和睦家 W4：实验室收入 = Σ(IN 结算) = ¥13,152', () => {
  // 全部 S26 = 手术标本（组织学，IN）；settle 取账单实收 net；逐行手算 Σnet=13152。
  const rows: ParsedRow[] = HEMUJIA_W4.map((c) => ({ no: c.caseNo, item: '手术标本检查与诊断', remark: '', bill: c.gross, rate: NaN, settle: c.net, campus: '' }))
  const rev = computeStatementRevenue(rows, cfg())
  it('25 行全部计入实验室（组织学 IN），labRevenue=13152，outSettle=0', () => {
    expect(rev.counts).toEqual({ total: 25, in: 25, out: 0, split: 0, diagnosis: 0, unmatched: 0, ambiguous: 0 })
    expect(rev.labRevenue).toBe(13152)
    expect(rev.outSettle).toBe(0)
  })
  it('守恒：in+out+unmatched+ambiguous == totalSettle', () => {
    expect(rev.labRevenue + rev.outSettle + rev.unmatchedSettle + rev.ambiguousSettle).toBe(rev.totalSettle)
    expect(rev.totalSettle).toBe(13152)
  })
})

describe('GOLDEN 和睦家月度结算表 26.2：全管道（parse→classify→收入）守恒', () => {
  const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'statements', 'out_line_item__hemujia_2602.json'), 'utf8'))
  const parsed = parseLineItems(fx.grid as Grid)
  const rev = computeStatementRevenue(parsed.rows, cfg())
  it('守恒红线：Σ分类后 settle == declaredTotal 55541（无静默丢弃）', () => {
    const sum = rev.labRevenue + rev.outSettle + rev.unmatchedSettle + rev.ambiguousSettle
    expect(rev.totalSettle).toBe(55541)
    expect(sum).toBe(55541)
    expect(parsed.declaredTotal).toBe(55541)
  })
  it('默认配置下 labRevenue=46763，其余为未匹配(待逐院配置补识别词)', () => {
    expect(rev.labRevenue).toBe(46763)
    expect(rev.unmatchedSettle).toBe(8778)
    expect(rev.outSettle).toBe(0)
  })
  it('byLine 拆分：组织学/细胞TCT/线下会诊/院内冰冻 均计入(in)', () => {
    const keys = rev.byLine.map((l) => l.key).sort()
    expect(keys).toEqual(['consult', 'cyto', 'frozen', 'histo'])
    expect(rev.byLine.every((l) => l.scope === 'in')).toBe(true)
    expect(rev.byLine.find((l) => l.key === 'histo')!.settle).toBe(26144)
  })
})

describe('扣率三级（细盖粗，仅估算用——行无结算时）', () => {
  const c = cfg()
  c.discount.def = 0.9
  c.discount.byLine = [{ key: 'histo', rate: 0.85 }]
  c.discount.byItem = [{ item: 'PD-L1', rate: 0.75 }]
  it('按项目 > 按线 > 默认', () => {
    expect(resolveRate(c, c.lines.find((l) => l.key === 'consult')!, 'PD-L1 检测')).toBe(0.75) // byItem
    expect(resolveRate(c, c.lines.find((l) => l.key === 'histo')!, '手术标本')).toBe(0.85) // byLine
    expect(resolveRate(c, c.lines.find((l) => l.key === 'cyto')!, '妇科TCT')).toBe(0.9) // default
  })
  it('行无结算列 → settle = 开单 × 三级扣率', () => {
    const rows: ParsedRow[] = [{ no: 'S26-1', item: '手术标本检查与诊断', remark: '', bill: 200, rate: NaN, settle: NaN, campus: '' }]
    const rev = computeStatementRevenue(rows, c)
    expect(rev.rows[0].settle).toBe(170) // 200 × 0.85（histo byLine）
    expect(rev.labRevenue).toBe(170)
  })
})

describe('settle 真实优先 + OUT 不进实验室收入', () => {
  it('对账单已给结算 → 直接采信（不被配置扣率覆盖）', () => {
    const c = cfg()
    c.discount.def = 0.5 // 故意与实收不符
    const rows: ParsedRow[] = [{ no: 'S26-1', item: '手术标本检查与诊断', remark: '', bill: 100, rate: 0.8, settle: 80, campus: '' }]
    const rev = computeStatementRevenue(rows, c)
    expect(rev.rows[0].settle).toBe(80) // 采信账单实收，非 100×0.5
    expect(rev.labRevenue).toBe(80)
  })
  it('M 号 NGS → outSettle，不进 labRevenue', () => {
    const rows: ParsedRow[] = [{ no: 'M26-001', item: '基因组病理检测（BRAF）', remark: '', bill: 1000, rate: 0.7, settle: 700, campus: '' }]
    const rev = computeStatementRevenue(rows, cfg())
    expect(rev.labRevenue).toBe(0)
    expect(rev.outSettle).toBe(700)
    expect(rev.counts.out).toBe(1)
  })
})
