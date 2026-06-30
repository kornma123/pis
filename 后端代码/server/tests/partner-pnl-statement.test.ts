/**
 * P5 — partner-pnl 收入侧改造（读侧）：case_revenue.lab_revenue 非空 → 已对账(statement 权威，不走估算)；
 * 空 → 估算(实收×占比)。三态计数 sourceCounts。向后兼容：现有估算路径不变。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { loadCasePnls, buildPartnerPnl } from '../src/utils/partner-pnl-service.js'
import { loadChargeCatalog } from '../src/utils/charge-catalog.js'

let db: any
const PID = 'PT-STMT-1'

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'PT-ST01', '对账医院', 'with_diagnosis', 1)`).run(PID)
  // 已对账 case（配置驱动 /commit 落库了 lab_revenue=152）
  db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, partner_name, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
    VALUES ('CR-ST1','S26-001',?, '对账医院',190,152,152,0,0.8,'statement','2026-02',1)`).run(PID)
  // 已对账 + 含移出（lab 100，out 700，net 800）
  db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, partner_name, gross_amount, net_amount, lab_revenue, out_revenue, discount_rate, revenue_source, service_month, line_count)
    VALUES ('CR-ST2','M26-001',?, '对账医院',1000,800,100,700,0.8,'statement','2026-02',2)`).run(PID)
  // 估算 case（无 lab_revenue → NULL）+ LIS 数量 → 走 computeCasePnl
  db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, partner_name, gross_amount, net_amount, discount_rate, service_month, line_count)
    VALUES ('CR-ST3','S26-009',?, '对账医院',100,100,1,'2026-02',1)`).run(PID)
  db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, he_slide_count, block_count, ihc_count, specimen_type) VALUES ('LC-ST3','S26-009',?,1,1,0,'tissue')`).run(PID)
})

describe('loadCasePnls：lab_revenue 非空 → 已对账权威', () => {
  const get = (caseNo: string) => loadCasePnls(db, loadChargeCatalog(db), { partnerId: PID }).find((c) => c.caseNo === caseNo)!
  it('S26-001：revenueSource=statement，labRevenue=152（不被占比覆盖）', () => {
    const c = get('S26-001')
    expect(c.revenueSource).toBe('statement')
    expect(c.labRevenue).toBe(152)
    expect(c.inScopeRatio).toBe(1) // 152/152
  })
  it('M26-001：含移出 → labRevenue=100、outRevenue=700、inScopeRatio=0.125', () => {
    const c = get('M26-001')
    expect(c.revenueSource).toBe('statement')
    expect(c.labRevenue).toBe(100)
    expect(c.outRevenue).toBe(700)
    expect(c.inScopeRatio).toBe(0.125) // 100/800
  })
  it('S26-009：无 lab_revenue → revenueSource=estimated（走估算占比）', () => {
    const c = get('S26-009')
    expect(c.revenueSource).toBe('estimated')
    expect(c.labRevenue).toBeLessThanOrEqual(100)
  })
})

describe('buildPartnerPnl：sourceCounts 三态 + labRevenueTotal 用权威值', () => {
  it('已对账 2 + 估算 1；labRevenueTotal = 152 + 100 + 估算值', () => {
    const pnl = buildPartnerPnl(db, { partnerId: PID }).find((p) => p.partnerId === PID)!
    expect(pnl.sourceCounts.statement).toBe(2)
    expect(pnl.sourceCounts.estimated).toBe(1)
    expect(pnl.sourceCounts.corrected).toBe(0)
    // 实验室收入合计 ≥ 252（两已对账 152+100），加估算 case 的占比收入
    expect(pnl.labRevenueTotal).toBeGreaterThanOrEqual(252)
    expect(pnl.caseCount).toBe(3)
  })
})
