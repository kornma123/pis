/**
 * billing-revenue（W4 实收聚合）单测 —— 用真实「单据…号收费单据.xls」(上海和睦家·组织病理) 的明细行验证：
 *  逐 case 实收=Σ开单金额、扣率解析、code-agnostic 存原始码、跳过小计/footer 噪声行。
 */
import { describe, it, expect } from 'vitest'
import { aggregateBilling, normalizeLine, type BillingRawRow } from '../src/utils/billing-revenue.js'

// 真实明细行工厂（中文表头，模拟前端 SheetJS 解析后 POST 的形态）
function L(seq: number, caseNo: string, code: string, item: string, price: number, qty: number, gross: number, disc: string, net: number): BillingRawRow {
  return {
    序号: seq, 病理号: caseNo, 送检医院: '上海和睦家医院', 登记类型: '组织病理', 标本名称: 'A标本',
    收费项目: item, 收费代码: code, 单价: price, 数量: qty, 单位: '例',
    计费金额: gross, 扣率: disc, 开单金额: net, 计费时间: '2026-06-02 14:36:17',
  }
}

// 取自真实数据的 5 个 case（含 80%/100% 扣率混合）
const H = '上海和睦家医院'
const ROWS: BillingRawRow[] = [
  // S26-02647: 3× 内镜活检 ¥165 80%→132
  L(1, 'S26-02647', '270300002b', '内镜组织活检检查与诊断-胃肠镜-和睦家', 165, 1, 165, '80%', 132),
  L(2, 'S26-02647', '270300002b', '内镜组织活检检查与诊断-胃肠镜-和睦家', 165, 1, 165, '80%', 132),
  L(3, 'S26-02647', '270300002b', '内镜组织活检检查与诊断-胃肠镜-和睦家', 165, 1, 165, '80%', 132),
  { 序号: '', 病理号: '小计', 计费金额: 495, 开单金额: 396 }, // 小计噪声行 → 跳过
  // S26-02725: 7 行
  L(1, 'S26-02725', '270500002b', '免疫组化检测（超过八项）-和睦家', 100, 2, 200, '80%', 160),
  L(2, 'S26-02725', '270500002a', '免疫组化检测（前八项）-和睦家', 200, 8, 1600, '80%', 1280),
  L(3, 'S26-02725', '270300002a', '内镜组织活检检查与诊断-宫腔镜-和睦家', 165, 1, 165, '80%', 132),
  L(4, 'S26-02725', '270300002a', '内镜组织活检检查与诊断-宫腔镜-和睦家', 165, 1, 165, '80%', 132),
  L(5, 'S26-02725', '270300002a', '内镜组织活检检查与诊断-宫腔镜-和睦家', 165, 1, 165, '80%', 132),
  L(6, 'S26-02725', '270300002a', '内镜组织活检检查与诊断-宫腔镜-和睦家', 165, 1, 165, '80%', 132),
  L(7, 'S26-02725', '270300002a', '内镜组织活检检查与诊断-宫腔镜-和睦家', 165, 1, 165, '80%', 132),
  { 序号: '', 病理号: '小计', 计费金额: 2625, 开单金额: 2100 },
  // S26-02726: 特染80×3 80% + 外籍报告150 100% + 手术小标本190 80%
  L(1, 'S26-02726', '270500001-1', '特殊染色及酶组织化学染色诊断（8个以内）-和睦家', 80, 3, 240, '80%', 192),
  L(2, 'S26-02726', '270900099-2', '组织学中英文报告-外籍人士-和睦家（150）', 150, 1, 150, '100%', 150),
  L(3, 'S26-02726', '270300005a', '手术标本检查与诊断(小标本)-和睦家', 190, 1, 190, '80%', 152),
  // S26-02646: 报告150 100% + 内镜165 80%
  L(1, 'S26-02646', '270900099-2', '组织学中英文报告-外籍人士-和睦家（150）', 150, 1, 150, '100%', 150),
  L(2, 'S26-02646', '270300002b', '内镜组织活检检查与诊断-胃肠镜-和睦家', 165, 1, 165, '80%', 132),
  // S26-02739: 手术小标本190 80%
  L(1, 'S26-02739', '270300005a', '手术标本检查与诊断(小标本)-和睦家', 190, 1, 190, '80%', 152),
  // footer 噪声行 → 跳过
  { 序号: '', 病理号: '', 送检医院: '¥15840', 扣率: '未收金额：' },
]

const agg = aggregateBilling(ROWS)
const caseOf = (no: string) => agg.cases.find((c) => c.caseNo === no)!

describe('billing-revenue：逐 case 实收 = Σ开单金额（折后）', () => {
  it('S26-02647：3 行 内镜活检 → 计费495 / 实收396 / 扣率0.8', () => {
    const c = caseOf('S26-02647')
    expect(c.grossAmount).toBe(495)
    expect(c.netAmount).toBe(396)
    expect(c.discountRate).toBe(0.8)
    expect(c.lineCount).toBe(3)
  })
  it('S26-02725：7 行(含IHC) → 计费2625 / 实收2100', () => {
    const c = caseOf('S26-02725')
    expect(c.grossAmount).toBe(2625)
    expect(c.netAmount).toBe(2100)
    expect(c.lineCount).toBe(7)
  })
  it('S26-02726：80%/100% 混合 → 计费580 / 实收494 / 扣率0.8517', () => {
    const c = caseOf('S26-02726')
    expect(c.grossAmount).toBe(580)
    expect(c.netAmount).toBe(494)
    expect(c.discountRate).toBe(0.8517)
  })
  it('S26-02646 / S26-02739：实收 282 / 152', () => {
    expect(caseOf('S26-02646').netAmount).toBe(282)
    expect(caseOf('S26-02739').netAmount).toBe(152)
  })
})

describe('billing-revenue：汇总 + 噪声行跳过', () => {
  it('5 case / 16 明细行，2 噪声行(小计/footer)被跳过', () => {
    expect(agg.summary.caseCount).toBe(5)
    expect(agg.summary.lineCount).toBe(16)
    expect(agg.summary.skippedRows).toBe(3) // 2 小计 + 1 footer
  })
  it('子集合计：计费4205 / 实收3424 / 整体扣率0.8143', () => {
    expect(agg.summary.grossTotal).toBe(4205)
    expect(agg.summary.netTotal).toBe(3424)
    expect(agg.summary.discountRate).toBe(0.8143)
  })
  it('服务月 = 2026-06；送检医院 = 上海和睦家医院', () => {
    expect(agg.summary.serviceMonths).toEqual(['2026-06'])
    expect(agg.summary.partnerNames).toEqual(['上海和睦家医院'])
  })
})

describe('billing-revenue：code-agnostic + 扣率解析鲁棒性', () => {
  it('原始旧码/院定制码原样保留（备 v2 逐码核对），不解析语义', () => {
    const codes = new Set(agg.lines.map((l) => l.chargeCode))
    expect(codes).toContain('270300002b')
    expect(codes).toContain('270900099-2')
    expect(codes).toContain('270500001-1')
  })
  it('同一病理号跨月 → 拆成两条 case revenue（不被首月吞掉，深审②修复）', () => {
    const rows = [
      { 序号: 1, 病理号: 'S26-XM', 送检医院: H, 收费代码: 'C1', 计费金额: 165, 扣率: '80%', 开单金额: 132, 计费时间: '2026-06-02 14:00:00' },
      { 序号: 1, 病理号: 'S26-XM', 送检医院: H, 收费代码: 'C2', 计费金额: 100, 扣率: '80%', 开单金额: 80, 计费时间: '2026-05-10 09:00:00' },
    ]
    const a = aggregateBilling(rows)
    expect(a.cases.length).toBe(2)
    expect(a.cases.map((c) => c.serviceMonth).sort()).toEqual(['2026-05', '2026-06'])
  })

  it('monthOf 容忍 2026/6/1 与单数字月（深审⑥修复）', () => {
    const a = aggregateBilling([{ 序号: 1, 病理号: 'Y', 送检医院: H, 收费代码: 'C', 计费金额: 100, 扣率: '80%', 开单金额: 80, 计费时间: '2026/6/1 8:00' }])
    expect(a.cases[0].serviceMonth).toBe('2026-06')
  })

  it('无收费代码但有金额的人工调整行 → 计入（code-agnostic，深审⑦修复）', () => {
    const a = aggregateBilling([{ 序号: 1, 病理号: 'Z', 送检医院: H, 收费代码: '', 计费金额: 0, 扣率: '', 开单金额: 50, 计费时间: '2026-06-01' }])
    expect(a.cases.length).toBe(1)
    expect(a.cases[0].netAmount).toBe(50)
  })

  it('扣率解析：80%→0.8 / 100%→1 / 0.8→0.8 / 缺失→net/gross 回退', () => {
    expect(normalizeLine(L(1, 'X', 'C', 'i', 100, 1, 100, '80%', 80)).discountRate).toBe(0.8)
    expect(normalizeLine(L(1, 'X', 'C', 'i', 100, 1, 100, '100%', 100)).discountRate).toBe(1)
    expect(normalizeLine({ 序号: 1, 病理号: 'X', 收费代码: 'C', 计费金额: 100, 开单金额: 80, 扣率: 0.8, 计费时间: '2026-06-01' }).discountRate).toBe(0.8)
    expect(normalizeLine({ 序号: 1, 病理号: 'X', 收费代码: 'C', 计费金额: 200, 开单金额: 150, 计费时间: '2026-06-01' }).discountRate).toBe(0.75)
  })
})
