/**
 * 按医院盈利 —— 真实 case 黄金回归锚（增量纠错架构第 3 条）。
 *
 * 用户每确认一批真实数据的期望产出，就锁进这里；改判断逻辑/聚合前先跑本文件防回归。
 * **首锚**：上海和睦家医院 2026-06 收费单据（`单据2026062607544902号收费单据.xls`，用户确认准确）。
 * 仅存【病理号 + 金额】，不含患者姓名/临床信息（原始 .xls 不入库）。
 *
 * 已离线核验：本批 25 个病理号 100% 命中 LIS 导出（病例导出文档20260627.xls），故 case↔partner 可匹配。
 */
import { describe, it, expect } from 'vitest'
import { aggregateBilling, type BillingRawRow } from '../../src/utils/billing-revenue.js'

// —— 锚①：和睦家 2026-06 逐 case 实收（取自账单小计行，用户确认）——
const HEMUJIA_2026_06: Array<{ caseNo: string; gross: number; net: number }> = [
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

describe('GOLDEN 和睦家 2026-06：partner 级实收锚', () => {
  it('25 case · 计费 ¥15840 · 实收 ¥13152 · 整体扣率 0.8303', () => {
    expect(HEMUJIA_2026_06.length).toBe(25)
    const gross = HEMUJIA_2026_06.reduce((s, c) => s + c.gross, 0)
    const net = HEMUJIA_2026_06.reduce((s, c) => s + c.net, 0)
    expect(gross).toBe(15840)
    expect(net).toBe(13152)
    expect(Math.round((net / gross) * 10000) / 10000).toBe(0.8303)
  })
})

// —— 锚②：3 个有代表性的 case 走真实明细行 → aggregateBilling 复现锚① 的 case 实收（管道证明）——
function L(seq: number, caseNo: string, code: string, price: number, qty: number, gross: number, disc: string, net: number): BillingRawRow {
  return { 序号: seq, 病理号: caseNo, 送检医院: '上海和睦家医院', 登记类型: '组织病理', 收费代码: code, 收费项目: code, 单价: price, 数量: qty, 计费金额: gross, 扣率: disc, 开单金额: net, 计费时间: '2026-06-03 16:12:05' }
}
const LINES: BillingRawRow[] = [
  // S26-02679：报告100% + IHC超八项×4 + IHC前八项×8 + 内镜活检×4
  L(1, 'S26-02679', '270900099-2', 150, 1, 150, '100%', 150),
  L(2, 'S26-02679', '270500002b', 100, 4, 400, '80%', 320),
  L(3, 'S26-02679', '270500002a', 200, 8, 1600, '80%', 1280),
  L(4, 'S26-02679', '270300002b', 165, 1, 165, '80%', 132),
  L(5, 'S26-02679', '270300002b', 165, 1, 165, '80%', 132),
  L(6, 'S26-02679', '270300002b', 165, 1, 165, '80%', 132),
  L(7, 'S26-02679', '270300002b', 165, 1, 165, '80%', 132),
  // S26-02691：IHC前八项×8 + 内镜活检×2
  L(1, 'S26-02691', '270500002a', 200, 8, 1600, '80%', 1280),
  L(2, 'S26-02691', '270300002a', 165, 1, 165, '80%', 132),
  L(3, 'S26-02691', '270300002a', 165, 1, 165, '80%', 132),
  // S26-02725：IHC超八项×2 + IHC前八项×8 + 内镜活检×5
  L(1, 'S26-02725', '270500002b', 100, 2, 200, '80%', 160),
  L(2, 'S26-02725', '270500002a', 200, 8, 1600, '80%', 1280),
  L(3, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132),
  L(4, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132),
  L(5, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132),
  L(6, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132),
  L(7, 'S26-02725', '270300002a', 165, 1, 165, '80%', 132),
]

describe('GOLDEN 和睦家：明细行 → aggregateBilling 复现锚 case 实收', () => {
  const agg = aggregateBilling(LINES)
  const anchor = (no: string) => HEMUJIA_2026_06.find((c) => c.caseNo === no)!
  const got = (no: string) => agg.cases.find((c) => c.caseNo === no)!
  it.each(['S26-02679', 'S26-02691', 'S26-02725'])('%s: 明细聚合 = 锚 gross/net', (no) => {
    expect(got(no).grossAmount).toBe(anchor(no).gross)
    expect(got(no).netAmount).toBe(anchor(no).net)
  })
  it('服务月 2026-06 · 全部命中 partner 上海和睦家医院', () => {
    expect(agg.summary.serviceMonths).toEqual(['2026-06'])
    expect(agg.summary.partnerNames).toEqual(['上海和睦家医院'])
  })
})
