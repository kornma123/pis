/**
 * P3 — 导入体检卡评分测试。三失败场景（对账不平 / 黄金不符 / 病例缺口）如期 todo；全过 review；人工核对 ready。
 * 对齐导入测试台 v2 mockup 的演示样本（故意失败样本）。
 */
import { describe, it, expect } from 'vitest'
import { scoreStatement } from '../src/utils/import-score.js'
import { seedDefaultConfig } from '../src/utils/partner-config.js'
import { computeStatementRevenue } from '../src/utils/statement-revenue.js'
import type { ParsedRow } from '../src/utils/statement-parser/index.js'

const cfg = () => seedDefaultConfig({ name: '测试医院', code: 'PT-T' })
// 3 行组织学 IN，结算 100/200/300（settle 直接给）
const goodRows: ParsedRow[] = [
  { no: 'S26-001', item: '手术标本检查与诊断', remark: '', bill: 125, rate: 0.8, settle: 100, campus: '' },
  { no: 'S26-002', item: '内镜组织活检', remark: '', bill: 250, rate: 0.8, settle: 200, campus: '' },
  { no: 'S26-003', item: '穿刺组织活检', remark: '', bill: 375, rate: 0.8, settle: 300, campus: '' },
]
const rev = () => computeStatementRevenue(goodRows, cfg())

describe('全过 → review（待人工核对）', () => {
  it('识别率100% + 对账闭合 + 病例双向全中 + 黄金符 → review', () => {
    const s = scoreStatement(rev(), {
      declaredTotal: 600,
      lisAllCaseNos: ['S26-001', 'S26-002', 'S26-003'], lisInPeriodCaseNos: ['S26-001', 'S26-002', 'S26-003'],
      goldenExpected: 600,
    })
    expect(s.recognition.pass).toBe(true)
    expect(s.recognition.rate).toBe(1)
    expect(s.closure.pass).toBe(true)
    expect(s.caseMatch.forward.pass).toBe(true)
    expect(s.caseMatch.backward.pass).toBe(true)
    expect(s.golden.pass).toBe(true)
    expect(s.status).toBe('review')
    expect(s.failures).toHaveLength(0)
  })
})

describe('人工核对 → ready', () => {
  it('humanReviewed=true → ready', () => {
    const s = scoreStatement(rev(), { declaredTotal: 600, lisAllCaseNos: ['S26-001', 'S26-002', 'S26-003'], goldenExpected: 600, humanReviewed: true })
    expect(s.status).toBe('ready')
  })
})

describe('失败①：对账不平（漏读行 → Σ结算 ≠ declaredTotal）→ todo', () => {
  it('declaredTotal=2400 但逐行只 600（东安式漏读）→ closure 不过 → todo', () => {
    const s = scoreStatement(rev(), { declaredTotal: 2400, lisAllCaseNos: ['S26-001', 'S26-002', 'S26-003'] })
    expect(s.closure.pass).toBe(false)
    expect(s.closure.diff).toBe(-1800)
    expect(s.status).toBe('todo')
    expect(s.failures.some((f) => f.includes('对账不平'))).toBe(true)
  })
})

describe('失败②：黄金不符（算出 ≠ 财务期望）→ todo', () => {
  it('labRevenue 600 vs goldenExpected 650（苍南式黄金不符）→ todo', () => {
    const s = scoreStatement(rev(), { declaredTotal: 600, lisAllCaseNos: ['S26-001', 'S26-002', 'S26-003'], goldenExpected: 650 })
    expect(s.golden.pass).toBe(false)
    expect(s.golden.diff).toBe(-50)
    expect(s.status).toBe('todo')
  })
})

describe('失败③：病例缺口（双向）→ todo / 信息', () => {
  it('正向：对账单病理号 LIS 查无 → forward 不过 → todo', () => {
    const s = scoreStatement(rev(), { declaredTotal: 600, lisAllCaseNos: ['S26-001'] /* 缺 002/003 在该院全量 LIS */ })
    // 002/003 不在 LIS → 正向不全中
    expect(s.caseMatch.forward.matched).toBe(1)
    expect(s.caseMatch.forward.pass).toBe(false)
    expect(s.status).toBe('todo')
  })
  it('反向：LIS 有对账单未覆盖的病例 → backward 报缺口（信息项，不单独阻断 status）', () => {
    const s = scoreStatement(rev(), { declaredTotal: 600, lisAllCaseNos: ['S26-001', 'S26-002', 'S26-003', 'S26-999'], lisInPeriodCaseNos: ['S26-001', 'S26-002', 'S26-003', 'S26-999'], goldenExpected: 600 })
    expect(s.caseMatch.backward.missingFromStatement).toBe(1)
    expect(s.caseMatch.backward.missingCaseNos).toEqual(['S26-999'])
    expect(s.caseMatch.forward.pass).toBe(true) // 正向仍全中
    expect(s.status).toBe('review') // 反向缺口不阻断
  })
})

describe('边界：未识别行 / 无合计行 / 无 LIS 数据', () => {
  it('未匹配行 → 识别率<100% → todo', () => {
    const rows: ParsedRow[] = [
      { no: 'S26-001', item: '手术标本检查与诊断', remark: '', bill: 125, rate: 0.8, settle: 100, campus: '' },
      { no: 'X26-001', item: '组织学中英文报告-外籍人士', remark: '', bill: 200, rate: 1, settle: 200, campus: '' }, // 默认配置不识别
    ]
    const s = scoreStatement(computeStatementRevenue(rows, cfg()), { declaredTotal: 300 })
    expect(s.recognition.pass).toBe(false)
    expect(s.recognition.unmatched).toBe(1)
    expect(s.status).toBe('todo')
  })
  it('无 declaredTotal → 对账闭合无法校验 → todo', () => {
    const s = scoreStatement(rev(), { declaredTotal: null, lisAllCaseNos: ['S26-001', 'S26-002', 'S26-003'] })
    expect(s.closure.pass).toBeNull()
    expect(s.status).toBe('todo')
    expect(s.failures.some((f) => f.includes('无独立合计行'))).toBe(true)
  })
  it('无 LIS 字段 → 病例匹配跳过（null），不阻断', () => {
    const s = scoreStatement(rev(), { declaredTotal: 600 })
    expect(s.caseMatch.forward.pass).toBeNull()
    expect(s.caseMatch.backward.pass).toBeNull()
    expect(s.status).toBe('review')
  })
  it('该院 LIS 为空数组（完全没导过）→ 提示态 null 不红叉，不阻断（防告警疲劳）', () => {
    const s = scoreStatement(rev(), { declaredTotal: 600, lisAllCaseNos: [], lisInPeriodCaseNos: [] })
    expect(s.caseMatch.forward.pass).toBeNull()
    expect(s.caseMatch.backward.pass).toBeNull()
    expect(s.status).toBe('review')
    expect(s.failures).toHaveLength(0)
  })
  it('黄金值未录入 → 可选项跳过（null），不触发待处理（防每月都黄的告警疲劳）', () => {
    const s = scoreStatement(rev(), { declaredTotal: 600, lisAllCaseNos: ['S26-001', 'S26-002', 'S26-003'] })
    expect(s.golden.pass).toBeNull()
    expect(s.status).toBe('review')
  })
})
