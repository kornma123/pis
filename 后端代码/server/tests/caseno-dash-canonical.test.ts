/**
 * 病理号 dash 变体归一（canonicalCaseNo）—— PM 2026-07-07 拍板落地（四侧同归一后收敛）。
 *
 * 背景：病理号是 LIS/收入/成本/对账四侧共用的 join key。Excel/输入法常把 ASCII 连字符 '-'(U+002D) 悄悄变成
 *   en-dash '–'(U+2013)、减号 '−'(U+2212)、hyphen '‐'(U+2010) 等视觉近似字符。NFKC 单独不折这一族（只折
 *   全角 U+FF0D / 小号 U+FE63）→ 同一真实病理号因横线写法不同被当成两个 case、跨侧 join 漏配。
 *
 * PM（领域专家）2026-07-07 确认：病理号里的横线纯属录入格式差异、非区分符（'A-1' 与 'A−1' 不会是两个不同标本）；
 *   且组织+TCT 各给独立病理号（同号不混类型）。前置=四侧写 seam 均已经 canonicalCaseNo（LIS lis-import #84 /
 *   收入 statement-import·billing-revenue / 成本 cost-runs·cost-calculator #89 / 对账 reconciliation）→ 在
 *   canonicalCaseNo 一处折 dash 即四侧原子生效、无非对称漏配（曾因 LIS 侧未归一暂缓·对抗面板 wf_dd44b3ce 逮到）。
 *
 * 安全性：ASCII 号（'-'(U+002D) 或无横线）恒等 → golden ¥13,152/¥27,870 零回归（现网数据全 ASCII）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { canonicalCaseNo } from '../src/utils/classifier.js'
import { writeOutboundAbcSnapshot } from '../src/utils/cost-runs.js'
import { backfillAbcPartnerIds, getPartnerCostRollup } from '../src/utils/abc-partner-link.js'

// NFKC 未折、canonicalCaseNo 应折为 '-' 的 dash 变体（U+2010–U+2015 连字/破折族 + U+2212 减号）
const DASH_VARIANTS: Array<[string, string]> = [
  ['‐', 'U+2010 HYPHEN'],
  ['‑', 'U+2011 NON-BREAKING HYPHEN'],
  ['‒', 'U+2012 FIGURE DASH'],
  ['–', 'U+2013 EN DASH'],
  ['—', 'U+2014 EM DASH'],
  ['―', 'U+2015 HORIZONTAL BAR'],
  ['−', 'U+2212 MINUS SIGN'],
]

describe('① 每个 dash 变体都折成 ASCII "-"（NFKC 单独不折的残留族）', () => {
  for (const [ch, name] of DASH_VARIANTS) {
    it(`${name} → "-"`, () => {
      // 前提：NFKC 单独不把它折成 "-"（否则测的不是本 PR 的 dash 折叠）
      expect(ch.normalize('NFKC')).not.toBe('-')
      expect(canonicalCaseNo(`P26${ch}001`)).toBe('P26-001')
    })
  }
})

describe('② 跨侧一致性：同一病理号的不同横线写法 → 同一 canonical（join 不再漏配）', () => {
  it('en-dash / minus / hyphen / ASCII 四种写法归一到同一个 key', () => {
    const forms = ['P26-001', 'P26–001', 'P26−001', 'P26‐001']
    const canon = forms.map((f) => canonicalCaseNo(f))
    expect(new Set(canon).size).toBe(1) // 全部塌到同一 canonical
    expect(canon[0]).toBe('P26-001')
  })

  it('全角 + 异体横线混合：Ｐ２６–００１ → P26-001', () => {
    expect(canonicalCaseNo('Ｐ２６–００１')).toBe('P26-001')
  })
})

describe('③ golden 安全：ASCII 号恒等（现网数据全 ASCII → 零回归）', () => {
  it('ASCII 连字符 "-"(U+002D) 不变', () => {
    expect(canonicalCaseNo('S26-001')).toBe('S26-001')
  })
  it('无横线号不变', () => {
    expect(canonicalCaseNo('  A2026123  ')).toBe('A2026123') // 仅 trim，无横线可折
  })
  it('不误折非 dash 分隔符（/ _ 空格 字母数字均保留）', () => {
    expect(canonicalCaseNo('S26/001_x')).toBe('S26/001_x')
  })
  it('空/空白/null → 空串', () => {
    expect(canonicalCaseNo('')).toBe('')
    expect(canonicalCaseNo('   ')).toBe('')
    expect(canonicalCaseNo(null)).toBe('')
    expect(canonicalCaseNo(undefined)).toBe('')
  })
})

describe('④ 端到端钱路：en-dash 成本 case 与 ASCII 收入/LIS 号 join 命中', () => {
  let db: any
  const P = 'DASH-P'
  const CANON = 'D26-007' //          ASCII（LIS/收入侧存的形态）
  const ENDASH = 'D26–007' //    同一病理号的 en-dash 写法（成本侧原始输入）
  const MONTH = '2026-05'
  const BOM = 'DASH-BOM'
  const FS = 'DASH-FS'

  beforeAll(async () => {
    db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,service_scope,status) VALUES (?, 'DASHH','横线医院','technical_only',1)`).run(P)
    db.prepare(`INSERT INTO boms (id, code, name, type, status, is_deleted) VALUES (?, 'BOM-DASH', '横线BOM', 'project', 'active', 0)`).run(BOM)
    db.prepare(`INSERT INTO fee_standards (id, code, name, fee_per_slide, base_price, status) VALUES (?, 'FS-DASH', '技术费', 100, 0, 'active')`).run(FS)
    db.prepare(`INSERT INTO bom_fee_mappings (id, bom_id, fee_standard_id, quantity_multiplier, aggregation_scope, status) VALUES ('BFM-DASH', ?, ?, 1, 'outbound', 'active')`).run(BOM, FS)
    // LIS / 收入侧用 ASCII 号
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, specimen_type) VALUES ('LC-DASH', ?, ?, 'tissue')`).run(CANON, P)
    db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, partner_name, net_amount, lab_revenue, out_revenue, revenue_source, discount_rate, service_month, line_count)
                VALUES ('CR-DASH', ?, ?, '横线医院', 200, 200, 0, 'statement', 1, ?, 1)`).run(CANON, P, MONTH)
  })

  it('成本侧写 en-dash 号 → 落库归一为 ASCII → 归院 + 入服务月 rollup', () => {
    expect(ENDASH).not.toBe(CANON) // sanity：确是不同码点
    writeOutboundAbcSnapshot(db, {
      id: 'OB-DASH-1', outbound_no: 'OBN-DASH', bom_id: BOM,
      sample_count: 1, total_cost: 50, case_no: ENDASH,
      cost_month: MONTH, project_id: null,
    }, 'RUN-DASH', 'costed')

    const stored = (db.prepare(`SELECT case_no, cost_status FROM outbound_abc_details WHERE outbound_id = 'OB-DASH-1'`).get() as any)
    expect(stored.case_no).toBe(CANON) // en-dash 折成 ASCII，与 LIS/收入侧一致
    expect(stored.cost_status).toBe('costed')

    backfillAbcPartnerIds(db)
    expect((db.prepare(`SELECT partner_id FROM outbound_abc_details WHERE outbound_id='OB-DASH-1'`).get() as any).partner_id).toBe(P)

    const pc = getPartnerCostRollup(db, { serviceMonth: MONTH }).get(P)
    expect(pc).toBeTruthy()
    expect(pc!.costTotal).toBe(50) // en-dash 成本经 canonical join 进入服务月 rollup
  })
})
