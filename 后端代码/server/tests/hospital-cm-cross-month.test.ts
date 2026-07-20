/**
 * #163 阶段2 · 跨月 case 可避免成本按各月收入占比（lab_revenue 权重）分摊（PM 拍板 Q2'=A）。
 *
 * 背景：case_revenue 键含月 (partner_id,case_no,service_month) 允许同一身份跨月结算；
 *   lis_cases 键无月 (partner_id,case_no) → 物理成本事实只有一份。阶段1 把跨月复用整例扣留
 *   （makeWithheldCase·禁输出）；阶段2 改为：成本先按整例算一次，再按各月 lab_revenue 占比
 *   分摊到各月，bucketA/bucketB/avoidableCost 分别精确守恒。
 * 红线（TASK-CONTRACT §4）：
 *   · 分摊发生在输出月过滤之前：单月查询的分母仍是该身份全部合格月；
 *   · 权重只读 lab_revenue——net_amount/gross_amount 即便矛盾也绝不影响结果；
 *   · 分组 = (partner_id, case_no)：跨院同号绝不串；
 *   · lab_revenue≤0 的月不进分摊（同源闸 ADR-002），也不强发明分摊答案；
 *   · 跨月身份里夹 NULL/非法月份行 = 异常 → 保持整例扣留（fail-closed 兜底）。
 *
 * 独立库（不污染 hospital-cm-service.test.ts 的对照表断言）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { buildHospitalCmByPartner, loadHospitalCmCases } from '../src/utils/hospital-cm-service.js'

let db: any
const R = 'HCM-R' // 分摊验证院
const Q = 'HCM-Q' // 同 case_no 隔离验证院
const X = 'HCM-X' // 异常（非法月）扣留验证院

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'HCMR', '跨月分摊院', 'with_diagnosis', 1)`).run(R)
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'HCMQ', '同号隔离院', 'with_diagnosis', 1)`).run(Q)
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'HCMX', '异常扣留院', 'with_diagnosis', 1)`).run(X)
  db.prepare(`INSERT OR IGNORE INTO antibodies (id, name, category, per_test_price, price_status, status, is_deleted) VALUES ('AB-CK7','CK7','一抗',5,'has_price',1,0)`).run()

  const cr = (id: string, caseNo: string, pid: string, lab: number, gross: number, net: number, month: string | null) =>
    db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0.8, 'statement', ?, 1)`).run(id, caseNo, pid, gross, net, lab, month)

  // R-001：跨 2026-03(lab=100)/2026-04(lab=300) 两月；net/gross 故意与 lab 比例矛盾（999:111 ≠ 100:300，1000:200 ≠ 100:300）
  cr('HCR-R1', 'R-001', R, 100, 1000, 999, '2026-03')
  cr('HCR-R2', 'R-001', R, 300, 200, 111, '2026-04')
  // 2 片 CK7（一抗 ¥5×2）：桶A=2×15=30，桶B=2×5=10，可避免成本=40
  db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES ('HLC-R','R-001',?,0,2,0,'tissue')`).run(R)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-R1','R-001',?,'CK7','Y000001')`).run(R)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-R2','R-001',?,'CK7','Y000001')`).run(R)

  // Q 院同 case_no 'R-001'（仅 2026-03 一个月 lab=50 · 1 片 CK7）：隔离验证——绝不被 R 院两月分母吸进去
  cr('HCR-Q1', 'R-001', Q, 50, 50, 50, '2026-03')
  db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES ('HLC-Q','R-001',?,0,1,0,'tissue')`).run(Q)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-Q1','R-001',?,'CK7','Y000001')`).run(Q)

  // R-ZERO：跨月但 2026-04 lab=0（同源闸→该月诊断桶）；合格月只有 2026-03 → 03 月独背全部成本 40
  cr('HCR-Z1', 'R-ZERO', R, 100, 100, 100, '2026-03')
  cr('HCR-Z2', 'R-ZERO', R, 0, 0, 0, '2026-04')
  db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES ('HLC-Z','R-ZERO',?,0,2,0,'tissue')`).run(R)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-Z1','R-ZERO',?,'CK7','Y000001')`).run(R)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-Z2','R-ZERO',?,'CK7','Y000001')`).run(R)

  // X-001：跨月身份里夹一行 NULL 月份（异常·无法安全归因）→ 保持整例扣留
  cr('HCR-X1', 'X-001', X, 100, 100, 100, '2026-05')
  cr('HCR-X2', 'X-001', X, 50, 50, 50, null)
  db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES ('HLC-X1','X-001',?,0,1,0,'tissue')`).run(X)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-X1','X-001',?,'CK7','Y000001')`).run(X)

  // X-002：非法月份 '2026-13' + 合法月 → 同样整例扣留
  cr('HCR-X3', 'X-002', X, 100, 100, 100, '2026-13')
  cr('HCR-X4', 'X-002', X, 100, 100, 100, '2026-06')
  db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES ('HLC-X2','X-002',?,0,1,0,'tissue')`).run(X)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-X2','X-002',?,'CK7','Y000001')`).run(X)
})

describe('跨月分摊（#163 阶段2·PM Q2\'=A）', () => {
  it('R-001 全月视图：成本按 lab 占比 25%/75% 分摊，bucketA/bucketB/avoidableCost 逐桶精确守恒', () => {
    const cases = loadHospitalCmCases(db, { partnerId: R }).filter((c: any) => c.caseNo === 'R-001')
    expect(cases).toHaveLength(2)
    const mar = cases.find((c: any) => c.serviceMonth === '2026-03')!
    const apr = cases.find((c: any) => c.serviceMonth === '2026-04')!
    // 整例成本只算一次：桶A=30 桶B=10 可避免=40（2 片 CK7）；按 100/300 分摊 → 10 / 30
    expect(mar.bucket).toBe('staining')
    expect(mar.labRevenue).toBe(100)
    expect(mar.bucketA).toBe(7.5)
    expect(mar.bucketB).toBe(2.5)
    expect(mar.avoidableCost).toBe(10)
    expect(mar.cm).toBe(90)
    expect(apr.bucket).toBe('staining')
    expect(apr.labRevenue).toBe(300)
    expect(apr.bucketA).toBe(22.5)
    expect(apr.bucketB).toBe(7.5)
    expect(apr.avoidableCost).toBe(30)
    expect(apr.cm).toBe(270)
    // 逐桶精确守恒（物理由度不拆：每月行保留整例片数）
    expect(mar.bucketA + apr.bucketA).toBe(30)
    expect(mar.bucketB + apr.bucketB).toBe(10)
    expect(mar.avoidableCost + apr.avoidableCost).toBe(40)
    expect(mar.cm + apr.cm).toBe(360) // = (100+300) − 40
    expect(mar.billableSlides).toBe(2)
    expect(apr.billableSlides).toBe(2)
  })

  it('R-001 单月视图（2026-03）：分母仍是全部合格月 → 03 月只背 10，不是自权 40', () => {
    const cases = loadHospitalCmCases(db, { partnerId: R, serviceMonth: '2026-03' }).filter((c: any) => c.caseNo === 'R-001')
    expect(cases).toHaveLength(1)
    expect(cases[0].avoidableCost).toBe(10)
    expect(cases[0].bucketA).toBe(7.5)
    expect(cases[0].cm).toBe(90)
    const r = buildHospitalCmByPartner(db, { partnerId: R, serviceMonth: '2026-03' }).find((x: any) => x.partnerId === R)!
    expect(r.crossMonthReuseCaseCount).toBe(0) // 合法跨月不再禁输出
    expect(r.hospitalCm).toBe(150) // R-001(90) + R-ZERO(60)
  })

  it('R 院全月上卷：跨月不再禁输出、无双计（成本 80 = 40+40，不是 160）', () => {
    const r = buildHospitalCmByPartner(db, { partnerId: R }).find((x: any) => x.partnerId === R)!
    expect(r.crossMonthReuseCaseCount).toBe(0)
    expect(r.hospitalCm).toBe(420) // R-001: 90+270；R-ZERO: 60+0
    expect(r.labRevenueInRate).toBe(500) // 100+300+100（R-ZERO 04 月 lab=0 入诊断桶·不入率）
    expect(r.bucketA).toBe(60) // 30 + 30
    expect(r.bucketB).toBe(20) // 10 + 10
    expect(r.revenueCaseCount).toBe(3) // R-001×2 + R-ZERO 03 月
    expect(r.diagnosisCaseCount).toBe(1) // R-ZERO 04 月
  })

  it('net/gross 与 lab 比例矛盾时权重仍只读 lab_revenue', () => {
    const cases = loadHospitalCmCases(db, { partnerId: R }).filter((c: any) => c.caseNo === 'R-001')
    const mar = cases.find((c: any) => c.serviceMonth === '2026-03')!
    // 若误用 net：999/(999+111)=0.9 → 36；若误用 gross：1000/1200≈0.833 → 33.33。lab 权重 → 10。
    expect(mar.avoidableCost).toBe(10)
    expect(mar.bucketA).toBe(7.5)
  })

  it('跨院同 case_no 绝不串：Q 院 R-001 独立计算，不进 R 院分母', () => {
    const qCases = loadHospitalCmCases(db, { partnerId: Q }).filter((c: any) => c.caseNo === 'R-001')
    expect(qCases).toHaveLength(1)
    expect(qCases[0].bucket).toBe('staining')
    expect(qCases[0].bucketA).toBe(15) // 1 片 ×15
    expect(qCases[0].bucketB).toBe(5)
    expect(qCases[0].avoidableCost).toBe(20)
    expect(qCases[0].cm).toBe(30)
    // R 院分摊不受 Q 院 50 元影响（若串院：03 月分母=150 → 40×100/450≈8.89 ≠ 10）
    const rMar = loadHospitalCmCases(db, { partnerId: R, serviceMonth: '2026-03' }).find((c: any) => c.caseNo === 'R-001')!
    expect(rMar.avoidableCost).toBe(10)
  })

  it('lab≤0 月不进分摊：R-ZERO 合格月只有 03 → 03 月独背全部 40；04 月诊断桶不减成本', () => {
    const cases = loadHospitalCmCases(db, { partnerId: R }).filter((c: any) => c.caseNo === 'R-ZERO')
    expect(cases).toHaveLength(2)
    const mar = cases.find((c: any) => c.serviceMonth === '2026-03')!
    const apr = cases.find((c: any) => c.serviceMonth === '2026-04')!
    expect(mar.bucket).toBe('staining')
    expect(mar.avoidableCost).toBe(40)
    expect(mar.cm).toBe(60)
    expect(apr.bucket).toBe('diagnosis') // 同源闸：lab=0 有 marker → 诊断桶·不减成本
    expect(apr.avoidableCost).toBe(0)
    expect(apr.cm).toBe(0)
  })
})

describe('异常跨月身份仍整例扣留（fail-closed 兜底·不发明分摊答案）', () => {
  it('X-001：跨月身份夹 NULL 月份行 → 两行都标 cross_month_reuse 禁输出', () => {
    const cases = loadHospitalCmCases(db, { partnerId: X }).filter((c: any) => c.caseNo === 'X-001')
    expect(cases).toHaveLength(2)
    expect(cases.every((c: any) => c.bucket === 'cross_month_reuse')).toBe(true)
    expect(cases.every((c: any) => c.avoidableCost === 0 && c.cm === 0)).toBe(true)
  })

  it('X-002：非法月份 2026-13 + 合法月 → 整例扣留', () => {
    const cases = loadHospitalCmCases(db, { partnerId: X }).filter((c: any) => c.caseNo === 'X-002')
    expect(cases).toHaveLength(2)
    expect(cases.every((c: any) => c.bucket === 'cross_month_reuse')).toBe(true)
  })

  it('X 院上卷：扣留 4 行进 crossMonthReuseCaseCount，不出 CM、不进成本上卷', () => {
    const r = buildHospitalCmByPartner(db, { partnerId: X }).find((x: any) => x.partnerId === X)!
    expect(r.crossMonthReuseCaseCount).toBe(4)
    expect(r.hospitalCm).toBe(0)
    expect(r.bucketA).toBe(0)
    expect(r.revenueCaseCount).toBe(0)
  })
})
