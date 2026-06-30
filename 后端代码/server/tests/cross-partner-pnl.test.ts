/**
 * PRD-0 TC1 + T1.4 + T1.5 + T1.6 — 跨院同号在 P&L / 成本 / ABC 回填全链路不串账。
 *
 * 背景：A、B 两院各有同一 case_no（医院各自编号撞号）+ 各自 LIS 数量 + 各自 ABC 成本。
 *  - T1.4 P&L 收入 join 带 partner：buildPartnerPnl({partnerId:B}) 只 join B 的 LIS 行，不因单键 join 重复/串数量。
 *  - T1.5 case 成本 rollup 带 partner：getCaseCostRollup 不把 A/B 同号成本混算。
 *  - T1.6 ABC 回填精确优先、拒绝歧义：同号跨院 → 不回填；同号单院 → 精确回填。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { loadCasePnls, loadCasePnlsWithCost, buildPartnerPnl } from '../src/utils/partner-pnl-service.js'
import { loadChargeCatalog } from '../src/utils/charge-catalog.js'
import { backfillAbcPartnerIds } from '../src/utils/abc-partner-link.js'

let db: any
const A = 'XP-A', B = 'XP-B'

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,service_scope,status) VALUES (?, 'XP-A','跨院盈亏A','technical_only',1)`).run(A)
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,service_scope,status) VALUES (?, 'XP-B','跨院盈亏B','technical_only',1)`).run(B)

  // 同号 S26-DUP：A 的 LIS 数量大、B 的小 → 估算收入应各自不同（证明各 join 自己的 LIS 行）
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,he_slide_count,block_count,ihc_count,specimen_type) VALUES ('XLA','S26-DUP',?,10,10,8,'tissue')`).run(A)
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,he_slide_count,block_count,ihc_count,specimen_type) VALUES ('XLB','S26-DUP',?,1,0,0,'tissue')`).run(B)

  // 各自 case_revenue（估算路径：无 lab_revenue）
  db.prepare(`INSERT INTO case_revenue (id,case_no,partner_id,partner_name,net_amount,discount_rate,service_month,line_count) VALUES ('XRA','S26-DUP',?,'跨院盈亏A',1000,1,'2026-05',1)`).run(A)
  db.prepare(`INSERT INTO case_revenue (id,case_no,partner_id,partner_name,net_amount,discount_rate,service_month,line_count) VALUES ('XRB','S26-DUP',?,'跨院盈亏B',1000,1,'2026-05',1)`).run(B)

  // 各自 ABC 成本（partner_id 已知）：A=100、B=500
  db.prepare(`INSERT INTO outbound_abc_details (id,outbound_id,case_no,partner_id,total_cost,cost_status,cost_month) VALUES ('XCA','o-a','S26-DUP',?,100,'costed','2026-05')`).run(A)
  db.prepare(`INSERT INTO outbound_abc_details (id,outbound_id,case_no,partner_id,total_cost,cost_status,cost_month) VALUES ('XCB','o-b','S26-DUP',?,500,'costed','2026-05')`).run(B)
})

describe('T1.4 P&L 收入 join 带 partner（不因单键 join 重复/串数量）', () => {
  it('loadCasePnls({partnerId:B}) 只 1 个 S26-DUP（不被 A 的同号 LIS 行重复 join 成 2 条）', () => {
    const cat = loadChargeCatalog(db)
    const bCases = loadCasePnls(db, cat, { partnerId: B }).filter((c) => c.caseNo === 'S26-DUP')
    expect(bCases).toHaveLength(1)
    expect(bCases[0].partnerId).toBe(B)
    const aCases = loadCasePnls(db, cat, { partnerId: A }).filter((c) => c.caseNo === 'S26-DUP')
    expect(aCases).toHaveLength(1)
    // A 的 LIS 数量更大 → 估算实验室收入 > B（各自 join 自己的 LIS 行，没串）
    expect(aCases[0].labRevenue).toBeGreaterThan(bCases[0].labRevenue)
  })

  it('buildPartnerPnl 各院 caseCount=1（同号不串成跨院 2 例）', () => {
    const a = buildPartnerPnl(db, { partnerId: A }).find((p) => p.partnerId === A)!
    const b = buildPartnerPnl(db, { partnerId: B }).find((p) => p.partnerId === B)!
    expect(a.caseCount).toBe(1)
    expect(b.caseCount).toBe(1)
  })
})

describe('T1.5 case 成本 rollup 带 partner（A/B 同号成本不混算）', () => {
  it('loadCasePnlsWithCost：A 的 S26-DUP 成本=100、B 的=500（不合并成 600）', () => {
    const a = loadCasePnlsWithCost(db, { partnerId: A }).find((c) => c.caseNo === 'S26-DUP')!
    const b = loadCasePnlsWithCost(db, { partnerId: B }).find((c) => c.caseNo === 'S26-DUP')!
    expect(a.costTotal).toBe(100)
    expect(b.costTotal).toBe(500)
  })
})

describe('T1.6 ABC 回填精确优先、拒绝歧义', () => {
  beforeAll(() => {
    // 歧义：AMB-DUP 跨 A、B 两院；单院：SOLO-1 仅 A 院。两条 ABC 成本 partner_id 暂为空待回填。
    db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,specimen_type) VALUES ('LAMA','AMB-DUP',?, 'tissue')`).run(A)
    db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,specimen_type) VALUES ('LAMB','AMB-DUP',?, 'tissue')`).run(B)
    db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,specimen_type) VALUES ('LSOLO','SOLO-1',?, 'tissue')`).run(A)
    db.prepare(`INSERT INTO outbound_abc_details (id,outbound_id,case_no,total_cost,cost_status) VALUES ('CAMB','o-amb','AMB-DUP',7,'costed')`).run()
    db.prepare(`INSERT INTO outbound_abc_details (id,outbound_id,case_no,total_cost,cost_status) VALUES ('CSOLO','o-solo','SOLO-1',9,'costed')`).run()
  })

  it('歧义 case_no（AMB-DUP）不回填 partner_id（保持 NULL + 计入 skippedAmbiguous）', () => {
    const r = backfillAbcPartnerIds(db)
    const amb = db.prepare(`SELECT partner_id FROM outbound_abc_details WHERE id='CAMB'`).get() as any
    expect(amb.partner_id).toBeNull() // 不得随机选 A 或 B
    expect(r.skippedAmbiguous).toBeGreaterThanOrEqual(1)
  })

  it('单院 case_no（SOLO-1）精确回填到该院', () => {
    backfillAbcPartnerIds(db)
    const solo = db.prepare(`SELECT partner_id FROM outbound_abc_details WHERE id='CSOLO'`).get() as any
    expect(solo.partner_id).toBe(A)
  })
})
