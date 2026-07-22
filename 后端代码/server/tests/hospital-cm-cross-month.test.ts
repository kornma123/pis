/**
 * LOC-002 / PM_DECISION_C：同一 (partner_id, case_no) 的单份标准成本，
 * 在 serviceMonth 过滤前按各结算月 lab_revenue 权重做最大余数分摊。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { getDb } from './p0-harness.js'
import {
  HospitalCmSourceDataError,
  buildHospitalCmByPartner,
  loadHospitalCmCases,
} from '../src/utils/hospital-cm-service.js'

let db: Awaited<ReturnType<typeof getDb>>
const R = 'HCM-XM-R'
const S = 'HCM-XM-S'
const BAD = 'HCM-XM-BAD'

function insertPartner(id: string, code: string): void {
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status)
    VALUES (?, ?, ?, 'with_diagnosis', 1)`).run(id, code, `${code}医院`)
}

function insertRevenue(
  id: string,
  caseNo: string,
  partnerId: string,
  serviceMonth: string,
  labRevenue: number,
  netAmount = labRevenue,
  grossAmount = labRevenue,
): void {
  db.prepare(`INSERT INTO case_revenue
    (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue,
     discount_rate, revenue_source, service_month, line_count)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0.8, 'statement', ?, 1)`)
    .run(id, caseNo, partnerId, grossAmount, netAmount, labRevenue, serviceMonth)
}

function insertCase(caseNo: string, partnerId: string, markerName: string, suffix: string): void {
  db.prepare(`INSERT INTO lis_cases
    (id, case_no, partner_id, block_count, ihc_count, special_stain_count, specimen_type)
    VALUES (?, ?, ?, 1, 1, 0, 'tissue')`).run(`HLC-${suffix}`, caseNo, partnerId)
  db.prepare(`INSERT INTO lis_case_markers
    (id, case_no, partner_id, marker_name, advice_type)
    VALUES (?, ?, ?, ?, 'Y000001')`).run(`HLM-${suffix}`, caseNo, partnerId, markerName)
}

function rowsFor(caseNo: string, partnerId = R, serviceMonth?: string) {
  return loadHospitalCmCases(db, { partnerId, serviceMonth })
    .filter((row) => row.caseNo === caseNo)
    .sort((a, b) => String(a.serviceMonth).localeCompare(String(b.serviceMonth)))
}

beforeAll(async () => {
  db = await getDb()
  insertPartner(R, 'HCMXMR')
  insertPartner(S, 'HCMXMS')
  insertPartner(BAD, 'HCMXMB')

  db.prepare(`INSERT OR IGNORE INTO antibodies
    (id, name, category, per_test_price, price_status, status, is_deleted)
    VALUES ('AB-XM-CK7', 'XM-CK7', '一抗', 5, 'has_price', 1, 0)`).run()
  db.prepare(`INSERT OR IGNORE INTO antibodies
    (id, name, category, per_test_price, price_status, status, is_deleted)
    VALUES ('AB-XM-TIE', 'XM-TIE', '一抗', 5.01, 'has_price', 1, 0)`).run()

  // 权重 1:2:4；net/gross 刻意反向冲突，确保权重只能来自 lab_revenue。
  insertRevenue('HCR-XM-R1', 'R-001', R, '2026-03', 100, 900, 900)
  insertRevenue('HCR-XM-R2', 'R-001', R, '2026-04', 200, 20, 20)
  insertRevenue('HCR-XM-R3', 'R-001', R, '2026-05', 400, 10, 10)
  insertCase('R-001', R, 'XM-CK7', 'XM-R1')

  // 桶B=501分、等权；唯一尾分应落到更早月份。
  insertRevenue('HCR-XM-T1', 'R-TIE', R, '2026-01', 100)
  insertRevenue('HCR-XM-T2', 'R-TIE', R, '2026-02', 100)
  insertCase('R-TIE', R, 'XM-TIE', 'XM-TIE')

  // 不同 partner 的同号病例必须是独立身份；S 只有单月，应保留完整成本。
  insertRevenue('HCR-XM-S1', 'R-001', S, '2026-03', 100)
  insertCase('R-001', S, 'XM-TIE', 'XM-S1')
})

describe('跨月成本分摊（PM_DECISION_C）', () => {
  it('在 serviceMonth 过滤前分摊，bucket A/B 分别守恒且 avoidableCost 只由两桶相加', () => {
    const all = rowsFor('R-001')
    expect(all.map((row) => [row.serviceMonth, row.bucketA, row.bucketB, row.avoidableCost, row.cm])).toEqual([
      ['2026-03', 2.14, 0.71, 2.85, 97.15],
      ['2026-04', 4.29, 1.43, 5.72, 194.28],
      ['2026-05', 8.57, 2.86, 11.43, 388.57],
    ])
    expect(all.reduce((sum, row) => sum + row.bucketA, 0)).toBe(15)
    expect(all.reduce((sum, row) => sum + row.bucketB, 0)).toBe(5)
    expect(all.reduce((sum, row) => sum + row.avoidableCost, 0)).toBe(20)
    for (const row of all) expect(row.avoidableCost).toBeCloseTo(row.bucketA + row.bucketB, 10)

    const march = rowsFor('R-001', R, '2026-03')
    expect(march).toHaveLength(1)
    expect(march[0]).toMatchObject({ bucketA: 2.14, bucketB: 0.71, avoidableCost: 2.85 })
  })

  it('按最大余数而非最大权重补尾分；余数并列时取最早 service_month', () => {
    const weighted = rowsFor('R-001')
    // 桶A 精确余数次序：4月 > 3月 > 5月，所以唯一尾分给4月，不给权重最大的5月。
    expect(weighted.map((row) => row.bucketA)).toEqual([2.14, 4.29, 8.57])

    const tied = rowsFor('R-TIE')
    expect(tied.map((row) => [row.serviceMonth, row.bucketB])).toEqual([
      ['2026-01', 2.51],
      ['2026-02', 2.5],
    ])
  })

  it('身份键保持 (partner_id, case_no)，合法跨月不再整例扣留', () => {
    expect(rowsFor('R-001', S)).toMatchObject([
      { partnerId: S, serviceMonth: '2026-03', bucketA: 15, bucketB: 5.01, avoidableCost: 20.01 },
    ])
    const rollup = buildHospitalCmByPartner(db, { partnerId: R }).find((row) => row.partnerId === R)!
    expect(rollup.crossMonthReuseCaseCount).toBe(0)
    expect(rollup.revenueCaseCount).toBe(5)

    // 无 partner 预过滤的批量路径也必须按复合身份分组，不能只靠调用参数偶然隔离。
    const unfiltered = loadHospitalCmCases(db).filter((row) => row.caseNo === 'R-001')
    expect(unfiltered.filter((row) => row.partnerId === R).map((row) => row.bucketA)).toEqual([2.14, 4.29, 8.57])
    expect(unfiltered.filter((row) => row.partnerId === S)).toMatchObject([
      { serviceMonth: '2026-03', bucketA: 15, bucketB: 5.01 },
    ])
  })
})

describe('lab_revenue 权威金额事实 fail-closed', () => {
  function insertLiteral(caseNo: string, literal: string, month = '2026-06'): void {
    db.prepare(`INSERT INTO case_revenue
      (id, case_no, partner_id, gross_amount, net_amount, lab_revenue, out_revenue,
       discount_rate, revenue_source, service_month, line_count)
      VALUES (?, ?, ?, 1, 1, ${literal}, 0, 0.8, 'statement', ?, 1)`)
      .run(`HCR-${caseNo}-${month}`, caseNo, BAD, month)
  }

  function deleteRevenue(caseNo: string): void {
    db.prepare('DELETE FROM case_revenue WHERE partner_id = ? AND case_no = ?').run(BAD, caseNo)
  }

  it.each([
    ['TEXT', "'not-a-number'"],
    ['NaN', "'NaN'"],
    ['Infinity', "'Infinity'"],
    ['unsafe', '9007199254740991'],
    ['precision>4', '1.00001'],
    ['negative', '-1'],
    ['NULL', 'NULL'],
  ])('%s 不得被折为 0 或进入分摊', (_label, literal) => {
    const caseNo = `BAD-${String(_label).replace(/[^A-Za-z0-9]/g, '')}`
    try {
      insertLiteral(caseNo, literal)
      expect(() => loadHospitalCmCases(db, { partnerId: BAD })).toThrow(HospitalCmSourceDataError)
    } finally {
      deleteRevenue(caseNo)
    }
  })

  it('跨月全零分母 fail-closed；单月合法零仍保留诊断桶语义', () => {
    try {
      insertLiteral('BAD-ZERO', '0', '2026-06')
      insertLiteral('BAD-ZERO', '0', '2026-07')
      expect(() => loadHospitalCmCases(db, { partnerId: BAD })).toThrow(HospitalCmSourceDataError)
    } finally {
      deleteRevenue('BAD-ZERO')
    }

    try {
      insertLiteral('GOOD-ZERO', '0')
      expect(loadHospitalCmCases(db, { partnerId: BAD })).toMatchObject([
        { caseNo: 'GOOD-ZERO', labRevenue: 0, avoidableCost: 0 },
      ])
    } finally {
      deleteRevenue('GOOD-ZERO')
    }
  })

  it('即使只请求早月，也先验证同身份的全部结算月后再发布', () => {
    try {
      insertLiteral('BAD-LATE', '100', '2026-06')
      insertLiteral('BAD-LATE', "'NaN'", '2026-07')
      expect(() => loadHospitalCmCases(db, { partnerId: BAD, serviceMonth: '2026-06' }))
        .toThrow(HospitalCmSourceDataError)
    } finally {
      deleteRevenue('BAD-LATE')
    }
  })
})
