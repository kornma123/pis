/**
 * GOLDEN · 和睦家纯实验室收入（新口径 2026-06-30，已锁）
 *
 * 纯实验室 = 制片(split 拆) + 染色(IN)；医生诊断 / 报告 / 现场服务 = 诊断桶(diagnosis)；外送/共建 = 外送桶(out)。
 * 制片份额（最终）= splitProcRate × 工作量 / (splitProcRate × 工作量 + 105)，逐病例：
 *   - 组织检诊：工作量 = LIS 真蜡块（对账单 × LIS 按病理号 join），splitProcRate=36。
 *   - TCT/冰冻：工作量 = 账单数量（qty），splitProcRate=75 / 36（LIS 暂无该字段，诚实降级）。
 *
 * 锁定 golden（守恒校验通过，独立复现 docs/analysis/hemujia-golden-lis-join.cjs）：
 *   - 和睦家全月 26.2：纯实验室 = ¥27,870（真蜡块精算，165/166 病例 LIS 匹配），诊断桶 27,671，守恒 55,541。
 *   - 精度进展：数量-忽略 22,835 → 数量估算 25,772 → LIS 真蜡块 27,870（LIS 比账单数量高，因一部位切多蜡块）。
 *
 * codex 复核（findings/09）HIGH-1 已落实：本测试**不再是 it.todo**，核心 27,870 为真断言，
 * 且加「无 LIS → 数值不同（更低）」的对照，证明 LIS join 真实生效（非空跑）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedDefaultConfig, type PartnerConfig, type PartnerConfigLine } from '../../src/utils/partner-config.js'
import { parseLineItems, type Grid } from '../../src/utils/statement-parser/index.js'
import { computeStatementRevenue } from '../../src/utils/statement-revenue.js'

/** 和睦家新口径配置：制片 split（组织按 LIS 蜡块 / TCT·冰冻按数量）/ 染色 IN / 报告·现场 诊断桶。
 *  keywords 按真实对账单 12 个项目名设计，逐项恰命中一条线（无歧义、无未匹配）——见 hemujia-golden-lis-join.cjs 路由。 */
function hemujiaConfig(): PartnerConfig {
  const c = seedDefaultConfig({ name: '上海和睦家医院', code: 'PT-HMJ' })
  const lines: PartnerConfigLine[] = [
    { key: 'histo', name: '组织制片(检诊)', on: true, scope: 'split', splitProcRate: 36, splitWorkload: 'lis_blk', prefixes: [], keywords: ['检查与诊断'], remarks: [] },
    { key: 'frozen', name: '冰冻制片', on: true, scope: 'split', splitProcRate: 36, splitWorkload: 'qty', prefixes: [], keywords: ['术中', '冰冻切片'], remarks: [] },
    { key: 'tct', name: '细胞TCT制片', on: true, scope: 'split', splitProcRate: 75, splitWorkload: 'qty', prefixes: [], keywords: ['TCT'], remarks: [] },
    { key: 'stain', name: '免疫组化/特染', on: true, scope: 'in', prefixes: [], keywords: ['免疫组化', '特殊染色', '酶组织化学'], remarks: [] },
    { key: 'report', name: '报告(诊断桶)', on: true, scope: 'diagnosis', prefixes: [], keywords: ['报告'], remarks: [] },
    { key: 'onsite', name: '现场服务(诊断桶)', on: true, scope: 'diagnosis', prefixes: [], keywords: ['现场服务'], remarks: [] },
  ]
  c.lines = lines
  return c
}

/** LIS 蜡块工作量（脱敏 fixture，仅 病理号+蜡块数）→ Map<病理号,{blk}>。 */
function lisWorkload(): Map<string, { blk: number }> {
  const arr = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'statements', 'lis_workload__hemujia_2602.json'), 'utf8'),
  ) as Array<{ no: string; blk: number }>
  const m = new Map<string, { blk: number }>()
  for (const r of arr) m.set(String(r.no).toUpperCase(), { blk: Number(r.blk) || 0 })
  return m
}

describe('GOLDEN 和睦家纯实验室收入（新口径：制片 split + 染色 IN；诊断/报告/现场=诊断桶；外送=外送桶）', () => {
  const fx = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'statements', 'out_line_item__hemujia_2602.json'), 'utf8'),
  )
  const parsed = parseLineItems(fx.grid as Grid)
  const cfg = hemujiaConfig()
  const rev = computeStatementRevenue(parsed.rows, cfg, { lisWorkload: lisWorkload() })

  it('守恒：全部结算 = 声明合计 55,541（不静默吞）', () => {
    expect(Math.round(rev.totalSettle)).toBe(55541)
    expect(parsed.declaredTotal).toBe(55541)
  })

  it('⭐ 全月 26.2（对账单 × LIS 真蜡块）→ 纯实验室 = ¥27,870，诊断桶 = ¥27,671', () => {
    expect(Math.round(rev.labRevenue)).toBe(27870)
    expect(Math.round(rev.diagnosisSettle)).toBe(27671)
  })

  it('守恒红线（含诊断桶）：lab + diagnosis + out + unmatched + ambiguous == totalSettle', () => {
    const sum = rev.labRevenue + rev.diagnosisSettle + rev.outSettle + rev.unmatchedSettle + rev.ambiguousSettle
    expect(Math.round(sum)).toBe(55541)
    // 逐项无静默丢弃：外送/未匹配/歧义在本院配置下应为 0（12 项全命中 split/in/diagnosis）
    expect(rev.outSettle).toBe(0)
    expect(rev.unmatchedSettle).toBe(0)
    expect(rev.ambiguousSettle).toBe(0)
  })

  it('LIS join 真实生效（有齿）：无 LIS 蜡块 → 制片按账单数量降级 → 纯实验室更低、≠27,870', () => {
    const revNoLis = computeStatementRevenue(parsed.rows, cfg) // 不传 lisWorkload
    expect(Math.round(revNoLis.labRevenue)).not.toBe(27870)
    // LIS 蜡块(260) > 账单部位数(~150) → 制片份额更高 → 有 LIS 的实验室收入更高
    expect(revNoLis.labRevenue).toBeLessThan(rev.labRevenue)
  })

  it('MED-4 诚实：按业务线拆分，标明工作量来源（组织=LIS蜡块 / TCT·冰冻=账单数量 / 染色=整条IN）', () => {
    const byKey = Object.fromEntries(rev.byLine.map((l) => [l.key, l]))
    // split 线有 labShare(制片)/diagShare(诊断)；in 线整条入实验室
    expect(byKey.histo.scope).toBe('split')
    expect(byKey.histo.labShare! + byKey.histo.diagShare!).toBeCloseTo(byKey.histo.settle, 1)
    expect(byKey.stain.scope).toBe('in')
    expect(byKey.report.scope).toBe('diagnosis')
    // 染色整条计入实验室（免疫组化前八/超八 + 特染 = 10400+1120+128 = 11648）
    expect(Math.round(byKey.stain.settle)).toBe(11648)
  })
})
