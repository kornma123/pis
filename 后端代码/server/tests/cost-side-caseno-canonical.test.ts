/**
 * ABC 成本侧 case_no 落库 NFKC 归一 —— 补齐 LIS/收入侧 canonicalCaseNo 的成本侧半边。
 *
 * 背景：LIS/收入侧写 seam 已统一走 canonicalCaseNo(NFKC+trim)（lis-import / reconciliation / billing-revenue /
 *   statement-import），但 ABC 成本侧曾写 raw case_no → 含全角/兼容字符的病理号在两条钱路 join 上与 canonical
 *   的 LIS/收入侧对不上：
 *     ① backfillAbcPartnerIds：lis_cases.case_no = outbound_abc_details.case_no（成本归院·partner 归属）
 *     ② getPartnerCostRollup(serviceMonth)：case_revenue.case_no = outbound_abc_details.case_no（院级单月 P&L 成本上卷）
 *   全角号成本因此成孤儿、不归院、不入单月毛利。
 *
 * 本测试证：全角号 outbound 经成本写 seam（writeOutboundAbcSnapshot / calculateSlideCostWithFee）后 case_no
 *   落库即 canonical → 两条 join 命中 + case_charge_groups 幂等键按 canonical 稳定（全角/半角不裂成两组、不双计）。
 *
 * 现网影响仅全角号（当前数据全 ASCII → canonicalCaseNo 恒等 → golden ¥13,152/¥27,870 零回归）；
 * 本测试锁不变量「每个落库 case_no 皆 canonical」，防成本侧回退 raw。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { writeOutboundAbcSnapshot } from '../src/utils/cost-runs.js'
import { calculateSlideCostWithFee } from '../src/utils/cost-calculator.js'
import { canonicalCaseNo } from '../src/utils/classifier.js'
import { backfillAbcPartnerIds, getPartnerCostRollup } from '../src/utils/abc-partner-link.js'

let db: any
const P = 'CS-CANON-P'
const CANON = 'S26-ABC' //          半角 ASCII 病理号（LIS/收入侧存的形态）
const FULL = 'Ｓ２６－ＡＢＣ' //      同一病理号的全角/兼容字符形态（Ｓ=U+FF33 / 全角数字 / U+FF0D 全角连字符）
const MONTH = '2026-05'

const BOM = 'CS-CANON-BOM'
const FS = 'CS-CANON-FS'
const BOM2 = 'CS-CANON-BOM2'
const FS2 = 'CS-CANON-FS2'
const CANON2 = 'T26-007'
const FULL2 = 'Ｔ２６－００７' // NFKC → 'T26-007'

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,service_scope,status) VALUES (?, 'CSCANON','成本归一医院','technical_only',1)`).run(P)

  // 最小「可核算」BOM：boms + fee_standards + bom_fee_mappings。有 fee 映射 → feeBreakdown 非空 →
  // cost_status='costed'（否则 getPartnerCostRollup 的 COST_OK 会把 cost_exception 排除，②的 join 断言测不到）。
  // ① 用 outbound 级映射（writeOutboundAbcSnapshot 路径）
  db.prepare(`INSERT INTO boms (id, code, name, type, status, is_deleted) VALUES (?, 'BOM-CSCANON', '成本归一BOM', 'project', 'active', 0)`).run(BOM)
  db.prepare(`INSERT INTO fee_standards (id, code, name, fee_per_slide, base_price, status) VALUES (?, 'FS-CSCANON', '技术费', 100, 0, 'active')`).run(FS)
  db.prepare(`INSERT INTO bom_fee_mappings (id, bom_id, fee_standard_id, quantity_multiplier, aggregation_scope, status) VALUES ('BFM-CSCANON', ?, ?, 1, 'outbound', 'active')`).run(BOM, FS)

  // ③ 用 case 级映射（applyCaseChargeGroup 写 case_charge_groups 的路径）
  db.prepare(`INSERT INTO boms (id, code, name, type, status, is_deleted) VALUES (?, 'BOM-CSCANON2', '成本归一BOM2', 'project', 'active', 0)`).run(BOM2)
  db.prepare(`INSERT INTO fee_standards (id, code, name, fee_per_slide, base_price, status) VALUES (?, 'FS-CSCANON2', '病例费', 30, 0, 'active')`).run(FS2)
  db.prepare(`INSERT INTO bom_fee_mappings (id, bom_id, fee_standard_id, quantity_multiplier, aggregation_scope, status) VALUES ('BFM-CSCANON2', ?, ?, 1, 'case', 'active')`).run(BOM2, FS2)
})

describe('① 成本写 seam：全角号 outbound → outbound_abc_details.case_no 落库即 canonical', () => {
  it('sanity：FULL 与 CANON 是不同码点，且 NFKC(FULL)=CANON（否则测不出归一）', () => {
    expect(FULL).not.toBe(CANON)
    expect(FULL.normalize('NFKC')).toBe(CANON)
  })

  it('writeOutboundAbcSnapshot 把全角 case_no 归一为半角落库（cost_status=costed）', () => {
    const outboundId = 'OB-CS-CANON-1'
    writeOutboundAbcSnapshot(db, {
      id: outboundId, outbound_no: 'OBN-1', bom_id: BOM,
      sample_count: 1, total_cost: 50, case_no: FULL,
      cost_month: MONTH, project_id: null,
    }, 'RUN-CS-CANON', 'costed')

    const row = db.prepare(`SELECT case_no, cost_status, total_cost FROM outbound_abc_details WHERE outbound_id = ?`).get(outboundId) as any
    expect(row).toBeTruthy()
    expect(row.case_no).toBe(CANON) //       ← 核心：落库 canonical，而非 raw 全角
    expect(row.case_no).not.toBe(FULL)
    expect(row.cost_status).toBe('costed') // 有 fee 映射 → 不落 cost_exception → 进 rollup
  })
})

describe('② canonical 落库 → 两条钱路 join 命中（全角号仍归院 + 入单月院级 P&L）', () => {
  it('backfillAbcPartnerIds：LIS(canonical) 命中 → 全角号成本归院 P', () => {
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, specimen_type) VALUES ('LC-CS-CANON', ?, ?, 'tissue')`).run(CANON, P)
    const r = backfillAbcPartnerIds(db)
    expect(r.updated).toBeGreaterThanOrEqual(1)
    const row = db.prepare(`SELECT partner_id FROM outbound_abc_details WHERE outbound_id = 'OB-CS-CANON-1'`).get() as any
    expect(row.partner_id).toBe(P) // 若成本侧写 raw 全角 → 与 canonical LIS 不命中 → 恒 NULL（回归即暴露）
  })

  it('getPartnerCostRollup(serviceMonth)：case_revenue(canonical) join 命中 → 成本入院 P 单月', () => {
    db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, partner_name, net_amount, lab_revenue, out_revenue, revenue_source, discount_rate, service_month, line_count)
                VALUES ('CR-CS-CANON', ?, ?, '成本归一医院', 200, 200, 0, 'statement', 1, ?, 1)`).run(CANON, P, MONTH)
    const pc = getPartnerCostRollup(db, { serviceMonth: MONTH }).get(P)
    expect(pc).toBeTruthy()
    expect(pc!.costTotal).toBe(50) // 全角号成本经 canonical join 进入服务月 rollup（raw 则 join 落空、rollup 无此院）
  })
})

describe('③ case_charge_groups：全角 caseNo 归一落库 + 幂等键不破 dedup（同案全角/半角不裂成两组）', () => {
  const run = (caseNo: string) =>
    calculateSlideCostWithFee(db, {
      bomId: BOM2, slideCount: 1, month: MONTH, materialCost: 10,
      caseNo, applyCaseAggregation: true, sampleCount: 1, caseCount: 1,
    })

  it('首次全角 → case_charge_groups.case_no 落 canonical，单行', () => {
    expect(FULL2.normalize('NFKC')).toBe(CANON2)
    run(FULL2)
    const rows = db.prepare(`SELECT case_no, outbound_count FROM case_charge_groups WHERE fee_standard_id = ?`).all(FS2) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].case_no).toBe(CANON2)
    expect(rows[0].case_no).not.toBe(FULL2)
  })

  it('再两次（全角 + 半角）→ ON CONFLICT 归并同一组（不裂/不双计），outbound_count 累加到 3', () => {
    run(FULL2) //  又一张全角
    run(CANON2) // 一张本就半角（模拟别来源已 canonical）
    const rows = db.prepare(`SELECT case_no, outbound_count FROM case_charge_groups WHERE fee_standard_id = ?`).all(FS2) as any[]
    expect(rows.length).toBe(1) //               仍单行：全角与半角未裂成两组（幂等键 charge_group_id 按 canonical 稳定）
    expect(rows[0].case_no).toBe(CANON2)
    expect(rows[0].outbound_count).toBe(3) //    三次调用累加到同一组 → 无重复行、无双计
  })
})

describe('④ 守卫：canonicalCaseNo 暂不折 dash 变体（PM 拍「应统一」但推迟到四侧同归一后·防单方非对称漏配）', () => {
  // PM 2026-07-07 已拍「病理号横线纯录入格式·应统一」，但 dash 折叠必须四侧（LIS/收入/成本/对账）同时经 canonicalCaseNo 才安全。
  // master 的 LIS 写侧(lis-import.ts)尚未走 canonicalCaseNo（在兄弟分支 f497e5c3，未合）→ 若此处单方折 dash，会把
  // 「两侧同为 en-dash、本可命中」的 join 拆开（对抗面板 wf_dd44b3ce·semantic-reliance 逮到）。本用例钉「暂不折」，
  // 防有人在 LIS 侧归一前提前单方加 dash 折叠。待四侧同归一后作为独立收敛统一加，届时改本断言为「折」。
  it('en-dash/minus/hyphen 暂保留原样（NFKC 单独也不折）——四侧同归一前不单方折', () => {
    expect('–'.normalize('NFKC')).not.toBe('-') //          NFKC 单独不折 en-dash（前提）
    expect(canonicalCaseNo('P26–001')).toBe('P26–001') //   canonicalCaseNo 暂保留 en-dash（U+2013）
    expect(canonicalCaseNo('P26−001')).toBe('P26−001') //   保留 minus（U+2212）
    expect(canonicalCaseNo('P26‐001')).toBe('P26‐001') //   保留 hyphen（U+2010）
  })
})
