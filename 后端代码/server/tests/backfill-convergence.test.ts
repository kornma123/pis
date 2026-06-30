/**
 * PRD-0 T1.6 收敛 — backfillAbcPartnerIds 须收敛到当前真相（对抗复核发现）。
 *
 * 场景：case_no 在 A 院单独存在时被精确回填到 A；之后 B 院导入同一本地编号（跨院撞号）→ 该 case_no 变歧义。
 * 旧实现只「增」不「清」：再次回填时 UPDATE WHERE COUNT(DISTINCT)=1 不再匹配 → A 的回填值滞留 = 隐蔽成本串院。
 * §7.1「歧义保持未回填」要求：歧义出现后再回填须把该行 partner_id 清回 NULL（待人工补院），保证幂等+收敛。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { backfillAbcPartnerIds } from '../src/utils/abc-partner-link.js'

let db: any
const A = 'CVG-A', B = 'CVG-B'

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES (?, 'CVGA','收敛A',1)`).run(A)
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES (?, 'CVGB','收敛B',1)`).run(B)
})

describe('T1.6 回填收敛：歧义出现后清回 NULL', () => {
  it('单院时精确回填到 A', () => {
    db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,specimen_type) VALUES ('CL1','CVG-001',?,'tissue')`).run(A)
    db.prepare(`INSERT INTO outbound_abc_details (id,outbound_id,case_no,total_cost,cost_status) VALUES ('CC1','o-1','CVG-001',100,'costed')`).run()
    backfillAbcPartnerIds(db)
    expect((db.prepare(`SELECT partner_id FROM outbound_abc_details WHERE id='CC1'`).get() as any).partner_id).toBe(A)
  })

  it('B 院导入同号后再回填 → 该 ABC 行清回 NULL（不滞留 A，不隐蔽串院）', () => {
    db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,specimen_type) VALUES ('CL2','CVG-001',?,'tissue')`).run(B)
    const r = backfillAbcPartnerIds(db)
    expect((db.prepare(`SELECT partner_id FROM outbound_abc_details WHERE id='CC1'`).get() as any).partner_id).toBeNull()
    expect(r.clearedAmbiguous).toBeGreaterThanOrEqual(1)
    expect(r.skippedAmbiguous).toBeGreaterThanOrEqual(1)
  })

  it('幂等：再次回填结果不变（仍 NULL）', () => {
    backfillAbcPartnerIds(db)
    expect((db.prepare(`SELECT partner_id FROM outbound_abc_details WHERE id='CC1'`).get() as any).partner_id).toBeNull()
  })
})
