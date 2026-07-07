/**
 * §10.E 跨月复用 case_no → DB 路径禁输出（HIGH·防双计·独立对抗面板 wf_9e39b91b confirmed）。
 *
 * 背景：case_revenue 键含月 (partner_id,case_no,service_month) 允许跨月复用；lis_cases 键无月
 *   (partner_id,case_no)·ON CONFLICT 覆盖 → 同一份 marker/标量会被多月各计一次 = 双计 + 早月丢失。
 * 期望：命中 `COUNT(DISTINCT service_month)>1` 的 case **禁输出贡献毛利**（不进任何成本上卷），标 crossMonthReuse。
 *
 * 独立库（不污染 hospital-cm-service.test.ts 的对照表断言）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { buildHospitalCmByPartner } from '../src/utils/hospital-cm-service.js'

let db: any
const R = 'HCM-R'

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'HCMR', '跨月复用院', 'with_diagnosis', 1)`).run(R)
  db.prepare(`INSERT OR IGNORE INTO antibodies (id, name, category, per_test_price, price_status, status, is_deleted) VALUES ('AB-CK7','CK7','一抗',5,'has_price',1,0)`).run()
  db.prepare(`INSERT OR IGNORE INTO antibodies (id, name, category, per_test_price, price_status, status, is_deleted) VALUES ('AB-KI67','Ki-67','一抗',8,'has_price',1,0)`).run()
  // 同 case_no 'R-001' 在两个 service_month 各有一行 lab_revenue（病理科按月重置号=常见）
  db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
    VALUES ('HCR-R1','R-001',?,210,200,200,0,0.8,'statement','2026-03',1)`).run(R)
  db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
    VALUES ('HCR-R2','R-001',?,210,200,200,0,0.8,'statement','2026-04',1)`).run(R)
  // lis_cases 键无月 → 只存一行；markers 3 行（若不挡，两月各算 3×15 桶A = 双计）
  db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type) VALUES ('HLC-R','R-001',?,2,3,0,'tissue')`).run(R)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-R1','R-001',?,'CK7','Y000001')`).run(R)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-R2','R-001',?,'Ki-67','Y000001')`).run(R)
  db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type) VALUES ('HM-R3','R-001',?,'CK7','Y000001')`).run(R)
})

describe('跨月复用禁输出', () => {
  it('全月视图（不带 serviceMonth）：两行都禁输出、不双计成本、计 crossMonthReuseCaseCount', () => {
    const r = buildHospitalCmByPartner(db, { partnerId: R }).find((x) => x.partnerId === R)!
    expect(r.crossMonthReuseCaseCount).toBe(2) // 两个月的收入行都被 withhold
    expect(r.hospitalCm).toBe(0) // 禁输出·不进成本上卷（而非双计 2×桶A/桶B）
    expect(r.bucketA).toBe(0)
    expect(r.revenueCaseCount).toBe(0)
  })
  it('单月视图（serviceMonth=2026-03）：即便只看一月也禁输出（lis_cases 可能是别月覆盖后的错行）', () => {
    const r = buildHospitalCmByPartner(db, { partnerId: R, serviceMonth: '2026-03' }).find((x) => x.partnerId === R)!
    expect(r.crossMonthReuseCaseCount).toBe(1)
    expect(r.hospitalCm).toBe(0)
  })
})
