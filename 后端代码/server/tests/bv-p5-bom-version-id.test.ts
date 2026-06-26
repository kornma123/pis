/**
 * BV Phase 5：outbound_abc_details.bom_version_id 回填
 *
 * - 有活跃版本的 BOM 出库核算 → bom_version_id = 当时活跃版本行 id（历史可复现）
 * - 无版本（历史 BOM 未落版本）→ bom_version_id 为 null，不报错（向后兼容降级）
 *
 * 直接调用 runCostRecalculation（cost-runs 的写路径，即本阶段修改处）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'

let db: any
let runCostRecalculation: any

function seedOutbound(suffix: string, month: string) {
  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
     VALUES (?, ?, ?, 'µL', 'CAT-A', 100, 1, 0)`).run(`MAT-${suffix}`, `C-${suffix}`, `抗体${suffix}`)
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status, is_deleted)
     VALUES (?, ?, ?, 'v1.0', 'ihc', 1, 0)`).run(`BOM-${suffix}`, `BC-${suffix}`, `BOM${suffix}`)
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
     VALUES (?, ?, ?, 2, 'µL')`).run(`BI-${suffix}`, `BOM-${suffix}`, `MAT-${suffix}`)
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status, is_deleted)
     VALUES (?, ?, ?, 'ihc', ?, 1, 0)`).run(`PRJ-${suffix}`, `PC-${suffix}`, `项目${suffix}`, `BOM-${suffix}`)
  db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, project_id, operator, status, is_deleted, sample_count, total_cost, created_at)
     VALUES (?, ?, 'bom', ?, 'admin', 'completed', 0, 1, 100, ?)`)
    .run(`OB-${suffix}`, `OBN-${suffix}`, `PRJ-${suffix}`, `${month}-15 10:00:00`)
}

beforeAll(async () => {
  db = await getDb()
  runCostRecalculation = (await import('../src/utils/cost-runs.js')).runCostRecalculation
  // V1：有版本
  seedOutbound('V1', '2026-07')
  db.prepare(`INSERT INTO bom_versions (id, bom_id, version, snapshot) VALUES ('VER-V1', 'BOM-V1', 'v1.0', '{}')`).run()
  // V2：无版本
  seedOutbound('V2', '2026-08')
})

describe('BV-P5：bom_version_id 回填', () => {
  it('有活跃版本 → bom_version_id = 该版本行 id', () => {
    runCostRecalculation(db, '2026-07', 'admin', 'recalculate')
    const detail = db.prepare(`SELECT bom_version_id FROM outbound_abc_details WHERE outbound_id = 'OB-V1'`).get() as any
    expect(detail).toBeTruthy()
    expect(detail.bom_version_id).toBe('VER-V1')
  })

  it('无版本 → bom_version_id 为 null，不报错', () => {
    expect(() => runCostRecalculation(db, '2026-08', 'admin', 'recalculate')).not.toThrow()
    const detail = db.prepare(`SELECT bom_version_id FROM outbound_abc_details WHERE outbound_id = 'OB-V2'`).get() as any
    expect(detail).toBeTruthy()
    expect(detail.bom_version_id).toBeNull()
  })
})
