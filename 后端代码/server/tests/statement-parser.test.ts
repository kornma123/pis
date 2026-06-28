/**
 * P1 — 对账单解析层测试（康湾真实文件 fixtures，PII 已脱敏）。
 *
 * 红线：每模板从真实文件解析出正确 rows + 独立声明合计(declaredTotal)；
 *   **对账闭合**：Σ逐行 settle == declaredTotal（抓漏读行）。结算 settle = 开单 bill × 扣率 rate（绝不把开单当结算）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectTemplate,
  detectColMap,
  parseLineItems,
  parseStatement,
  parseCategorySummary,
  parseJointVenture,
  type Grid,
} from '../src/utils/statement-parser/index.js'

const FX = join(__dirname, 'fixtures', 'statements')
function load(name: string): { template: string; grid: Grid; headerRow: number } {
  return JSON.parse(readFileSync(join(FX, name), 'utf8'))
}
const FILES = {
  line_item: 'out_line_item__hemujia_2602.json',
  service_fee_mixed: 'out_service_fee_mixed__wenzhou_2604.json',
  consult_remote: 'out_consult_remote__pingquan_2603.json',
  diagnostic_fee: 'out_diagnostic_fee__ningbo_2602.json',
  category_summary: 'out_category_summary__dongan_2601.json',
  joint_venture: 'out_joint_venture__shimen_2603.json',
  outsourced_detail: 'out_outsourced_detail__ganzhou.json',
}

describe('detectTemplate（7 模板真实文件全部识别）', () => {
  for (const [tid, file] of Object.entries(FILES)) {
    it(`${tid} → ${tid}`, () => {
      expect(detectTemplate(load(file).grid)).toBe(tid)
    })
  }
})

describe('对账闭合红线：Σ逐行 settle == declaredTotal（line-item 家族 5 模板）', () => {
  const family = ['line_item', 'service_fee_mixed', 'consult_remote', 'diagnostic_fee', 'outsourced_detail'] as const
  for (const tid of family) {
    it(`${tid} 闭合`, () => {
      const r = parseLineItems(load(FILES[tid]).grid)
      expect(r.declaredTotal).not.toBeNull()
      expect(Math.abs(r.rowSettleSum - (r.declaredTotal as number))).toBeLessThan(0.01)
    })
  }
})

describe('line_item（和睦家 26.2）', () => {
  const r = parseLineItems(load(FILES.line_item).grid)
  it('rows / declaredTotal / declaredGross', () => {
    expect(r.rows.length).toBe(257)
    expect(r.declaredTotal).toBe(55541)
    expect(r.declaredGross).toBe(68220)
    expect(r.rowSettleSum).toBe(55541)
  })
  it('colMap 自动识别（病理号/项目名称/收费金额/结算扣率/结算金额）', () => {
    expect(r.colMap.caseNo).toBe(1)
    expect(r.colMap.item).toBe(5)
    expect(r.colMap.bill).toBe(8)
    expect(r.colMap.rate).toBe(9)
    expect(r.colMap.settle).toBe(10)
  })
  it('settle = bill × rate（术中快速冰冻：180 × 0.8 = 144）', () => {
    const row = r.rows.find((x) => x.item.includes('术中快速') && x.bill === 180)
    expect(row).toBeTruthy()
    expect(row!.rate).toBe(0.8)
    expect(row!.settle).toBe(144)
  })
  it('病理号前缀保留（B/S/C…供 P2 分类）', () => {
    expect(r.rows.every((x) => x.no.length > 0)).toBe(true)
    expect(r.rows.some((x) => /^B/.test(x.no))).toBe(true)
  })
})

describe('service_fee_mixed（温州中心 26.4）', () => {
  const r = parseLineItems(load(FILES.service_fee_mixed).grid)
  it('declaredTotal 42485.64 + 闭合', () => {
    expect(r.declaredTotal).toBe(42485.64)
    expect(r.rowSettleSum).toBe(42485.64)
  })
  it('免疫组化*16：2654.6 × 0.88 = 2336.05（结算=医院收费×分配率）', () => {
    const row = r.rows.find((x) => x.item === '免疫组化*16')
    expect(row).toBeTruthy()
    expect(row!.bill).toBe(2654.6)
    expect(row!.rate).toBe(0.88)
    expect(row!.settle).toBe(2336.05)
  })
})

describe('outsourced_detail（赣州，无病理号）', () => {
  const r = parseLineItems(load(FILES.outsourced_detail).grid)
  it('declaredTotal 40219.2 + 闭合；行无病理号但有项目+实收', () => {
    expect(r.declaredTotal).toBe(40219.2)
    expect(r.rowSettleSum).toBe(40219.2)
    expect(r.colMap.caseNo).toBe(-1)
    expect(r.rows.every((x) => x.no === '' && x.item.length > 0 && Number.isFinite(x.settle))).toBe(true)
  })
})

describe('diagnostic_fee（宁波）— 合计行脱敏回归守护', () => {
  it('declaredTotal 3136（合计行不被脱敏毁掉）', () => {
    const r = parseLineItems(load(FILES.diagnostic_fee).grid)
    expect(r.declaredTotal).toBe(3136)
    expect(r.rowSettleSum).toBe(3136)
  })
})

describe('category_summary（东安人民，行=类别）', () => {
  const r = parseCategorySummary(load(FILES.category_summary).grid)
  it('declaredTotal 121016.9 + 类别含常规病理诊断 51697.5', () => {
    expect(r.declaredTotal).toBe(121016.9)
    expect(r.rowSettleSum).toBe(121016.9)
    const c = r.categories.find((x) => x.category.includes('常规病理诊断'))
    expect(c).toBeTruthy()
    expect(c!.settle).toBe(51697.5)
  })
  it('dispatcher 路由到 category 解析器', () => {
    const any = parseStatement(load(FILES.category_summary).grid) as any
    expect(any.template).toBe('category_summary')
    expect(any.categories.length).toBeGreaterThan(0)
  })
})

describe('joint_venture（石门共建利润表）', () => {
  it('按科室解析出行，含妇科', () => {
    const r = parseJointVenture(load(FILES.joint_venture).grid)
    expect(r.depts.length).toBeGreaterThan(0)
    expect(r.depts.some((d) => d.dept.includes('妇科'))).toBe(true)
  })
})

describe('通用解析单元（合成网格）', () => {
  it('缺结算列 → settle = 开单×扣率（§8.2）+ 警告', () => {
    const grid: Grid = [
      ['病理号', '项目名称', '医院收费', '扣率'],
      ['S26-001', '手术标本检查与诊断(小标本)', '190', '0.85'],
      ['合计', '', '190', ''],
    ]
    const r = parseLineItems(grid)
    expect(r.rows[0].settle).toBe(161.5) // 190 × 0.85
    expect(r.warnings.some((w) => w.includes('开单×扣率'))).toBe(true)
  })
  it('NFKC 归一：全角数字/列名识别', () => {
    const grid: Grid = [
      ['病理号', '项目名称', '收费金额', '结算扣率', '结算金额'],
      ['Ｓ２６-００２', 'TCT检测', '１５０', '０.８', '１２０'],
    ]
    const cm = detectColMap(grid[0])
    expect(cm.settle).toBe(4)
    const r = parseLineItems(grid)
    expect(r.rows[0].settle).toBe(120)
  })
  it('小计行不计入明细、不当作 declaredTotal（仅 grand 合计）', () => {
    const grid: Grid = [
      ['编号', '服务项目', '医院收费', '分配率', '结算金额'],
      ['H26-1', '免疫组化', '100', '0.9', '90'],
      ['小计－会诊', '', '100', '', '90'],
      ['E26-1', 'HPV-E6E7', '280', '0.83', '232.4'],
      ['合计', '', '380', '', '322.4'],
    ]
    const r = parseLineItems(grid)
    expect(r.rows.length).toBe(2) // 小计/合计 不算明细
    expect(r.declaredTotal).toBe(322.4)
    expect(r.rowSettleSum).toBe(322.4)
  })
})

describe('codex 修复回归', () => {
  it('F1 扣率 %-aware：「90%」→0.9，无结算列时 settle=开单×0.9（非 ×90 百倍虚高）', () => {
    const grid: Grid = [
      ['病理号', '项目名称', '收费金额', '结算扣率'],
      ['S26-1', '活检', '100', '90%'],
      ['合计', '', '100'],
    ]
    const r = parseLineItems(grid)
    expect(r.rows[0].rate).toBe(0.9)
    expect(r.rows[0].settle).toBe(90) // 100 × 0.9，绝非 9000
  })
  it('F1 扣率「85」(未写%)>1 视为百分数→0.85', () => {
    const grid: Grid = [['病理号', '项目名称', '收费金额', '结算扣率'], ['S1', '活检', '200', '85']]
    expect(parseLineItems(grid).rows[0].settle).toBe(170) // 200 × 0.85
  })
  it('F8 真合计行标签叫「结算合计」时 declaredTotal 不漏成 null', () => {
    const grid: Grid = [
      ['病理号', '项目名称', '收费金额', '结算金额'],
      ['S1', '活检', '100', '90'],
      ['结算合计', '', '100', '90'],
    ]
    const r = parseLineItems(grid)
    expect(r.declaredTotal).toBe(90)
    expect(r.rowSettleSum).toBe(90)
  })
})
