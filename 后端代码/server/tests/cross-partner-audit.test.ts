/**
 * PRD-0 T1.0 + T1.1 — 跨院串账止血：lis_cases 复合唯一键 (partner_id, case_no) + 跨院审计报告。
 *
 * 红线：不同医院各自编号可撞号（医院各自编号体系）。旧库 case_no 全局 UNIQUE → 第二家医院同号被拒/覆盖。
 * 迁移为 UNIQUE(partner_id, case_no) 后，同一 case_no 可在多院并存；审计函数报告跨院同号/NULL/ABC 歧义计数。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { auditCrossPartnerCaseNos } from '../src/utils/cross-partner-audit.js'

let db: any

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES ('AUD-A','AUD-A','审计A院',1)`).run()
  db.prepare(`INSERT OR IGNORE INTO partners (id,code,name,status) VALUES ('AUD-B','AUD-B','审计B院',1)`).run()
  // 跨院同号（医院各自编号撞号）—— 旧 UNIQUE(case_no) 会拒绝第二行，迁移后两行并存
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,he_slide_count) VALUES ('LCA','AUD-DUP','AUD-A',1)`).run()
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id,he_slide_count) VALUES ('LCB','AUD-DUP','AUD-B',2)`).run()
  // 单院独有
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id) VALUES ('LCC','AUD-SOLO','AUD-A')`).run()
  // partner_id 为空的历史行（迁移不得自动并入任意医院）
  db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id) VALUES ('LCD','AUD-NULL',NULL)`).run()
  // ABC 成本明细
  db.prepare(`INSERT INTO outbound_abc_details (id,outbound_id,case_no,total_cost,cost_status) VALUES ('DA','o1','AUD-DUP',10,'costed')`).run()   // 歧义（对应两院）
  db.prepare(`INSERT INTO outbound_abc_details (id,outbound_id,case_no,total_cost,cost_status) VALUES ('DB','o2','AUD-SOLO',20,'costed')`).run()  // 精确（对应单院）
  db.prepare(`INSERT INTO outbound_abc_details (id,outbound_id,case_no,total_cost,cost_status) VALUES ('DC','o3','AUD-NOMATCH',30,'costed')`).run() // 无 LIS 匹配
})

describe('T1.1 lis_cases 复合唯一键 (partner_id, case_no)', () => {
  it('同一 case_no 可在两家医院并存（不再被全局 UNIQUE 覆盖）', () => {
    const rows = db.prepare(`SELECT partner_id, he_slide_count FROM lis_cases WHERE case_no='AUD-DUP' ORDER BY partner_id`).all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.partner_id)).toEqual(['AUD-A', 'AUD-B'])
    expect(rows.find((r) => r.partner_id === 'AUD-A').he_slide_count).toBe(1) // A 未被 B 覆盖
    expect(rows.find((r) => r.partner_id === 'AUD-B').he_slide_count).toBe(2)
  })

  it('复合唯一索引存在：同院同号重复插入被拒', () => {
    expect(() =>
      db.prepare(`INSERT INTO lis_cases (id,case_no,partner_id) VALUES ('LCDUP','AUD-DUP','AUD-A')`).run(),
    ).toThrow()
  })
})

describe('TC1.0 跨院审计报告（gate T1.6 回填口径）', () => {
  it('输出四项计数：跨院同号 / NULL partner / ABC 精确 / ABC 歧义', () => {
    const a = auditCrossPartnerCaseNos(db)
    expect(a.lisDuplicateCaseNoAcrossPartnerCount).toBe(1) // AUD-DUP
    expect(a.lisNullPartnerCount).toBe(1) // AUD-NULL
    expect(a.abcCaseNoMatchedSinglePartnerCount).toBe(1) // AUD-SOLO
    expect(a.abcCaseNoAmbiguousCount).toBe(1) // AUD-DUP
  })

  it('ABC 歧义>0 → 不得走单键回填（精确优先、拒绝歧义）', () => {
    const a = auditCrossPartnerCaseNos(db)
    expect(a.abcCaseNoAmbiguousCount).toBeGreaterThan(0)
  })
})
