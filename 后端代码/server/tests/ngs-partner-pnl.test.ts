/**
 * NGS 外购转销并入院级 P&L 集成测试 —— loadNgsByPartner 上卷 + buildPartnerPnl 含 NGS 毛利/总毛利。
 * 验证：NGS-only 医院（无院内 case_revenue）也出现在院级 P&L，且 totalMargin = 院内毛利 + NGS 毛利。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { buildPartnerPnl, loadNgsByPartner } from '../src/utils/partner-pnl-service.js'

describe('NGS 并入院级 P&L', () => {
  let db: any
  beforeAll(async () => {
    db = await getDb()
    db.prepare(
      `INSERT OR IGNORE INTO partners (id, code, name, service_scope, status, is_deleted) VALUES (?, ?, ?, 'technical_only', 1, 0)`,
    ).run('PNGS', 'PNGS', 'NGS测试医院')
    const ins = db.prepare(
      `INSERT OR IGNORE INTO ngs_orders (id, order_no, partner_id, partner_name, product_name, sell_price, outsource_cost, margin, order_month)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    ins.run('O1', 'N0001', 'PNGS', 'NGS测试医院', '结直肠119', 8500, 1350, 7150, '2026-06')
    ins.run('O2', 'N0002', 'PNGS', 'NGS测试医院', '胃112', 8500, 1350, 7150, '2026-06')
  })

  it('loadNgsByPartner：按医院上卷 收入17000/外包成本2700/毛利14300', () => {
    const a = loadNgsByPartner(db).get('PNGS')!
    expect(a.orderCount).toBe(2)
    expect(a.revenue).toBe(17000)
    expect(a.cost).toBe(2700)
    expect(a.margin).toBe(14300)
  })

  it('buildPartnerPnl：NGS-only 医院出现，ngsMargin/totalMargin 正确（院内毛利=0）', () => {
    const p = buildPartnerPnl(db).find((r) => r.partnerId === 'PNGS')!
    expect(p).toBeTruthy()
    expect(p.ngsRevenue).toBe(17000)
    expect(p.ngsCost).toBe(2700)
    expect(p.ngsMargin).toBe(14300)
    expect(p.grossMargin).toBe(0) // 无院内 case_revenue
    expect(p.totalMargin).toBe(14300) // 院内 0 + NGS 14300
  })

  it('幂等：同 (order_no, product_name, order_month) 重导只 1 行并更新为新值（Codex 审查 HIGH 修复）', () => {
    const up = db.prepare(`
      INSERT INTO ngs_orders (id, order_no, partner_id, partner_name, product_name, sell_price, outsource_cost, margin, order_month, import_batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_no, product_name, order_month) DO UPDATE SET
        sell_price = excluded.sell_price, outsource_cost = excluded.outsource_cost, margin = excluded.margin, updated_at = CURRENT_TIMESTAMP
    `)
    up.run('I1', 'NIDEM', 'PNGS', 'NGS测试医院', '结直肠119', 8500, 1350, 7150, '2026-07', 'B1')
    up.run('I2', 'NIDEM', 'PNGS', 'NGS测试医院', '结直肠119', 9000, 1400, 7600, '2026-07', 'B2') // 重导同键 → 更新非新增
    const rows = db.prepare(`SELECT sell_price, margin FROM ngs_orders WHERE order_no = 'NIDEM'`).all() as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].sell_price).toBe(9000)
    expect(rows[0].margin).toBe(7600)
  })
})
