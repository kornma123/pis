/**
 * BOM 版本化 + 对账核准链 — Phase 1 Schema
 *
 * 目标：
 *  - 新建 bom_versions 表（版本快照：snapshot/diff/changeLog/effective_scope/impact_summary）
 *  - reconciliation_logs 补 propose→approve 工作流列（status/reviewed_by/reviewed_at/
 *    applied_bom_id/proposed_usage/material_id/project_id）——提案信息须持久化以便审批时重放
 *  - 幂等：重复 initializeDatabase 不抛错
 *
 * 纯 ADD，不改既有表/列。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'

function columnsOf(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

let db: any

beforeAll(async () => {
  db = await getDb()
})

describe('BV-P1 Schema：bom_versions + reconciliation_logs 工作流列', () => {
  it('bom_versions 表存在且含关键列', () => {
    const cols = columnsOf(db, 'bom_versions')
    expect(cols.length).toBeGreaterThan(0) // 表存在
    for (const c of [
      'id',
      'bom_id',
      'version',
      'snapshot',
      'diff_summary',
      'change_log',
      'effective_scope',
      'impact_summary',
      'changed_by',
      'created_at',
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('reconciliation_logs 含 propose→approve 工作流列', () => {
    const cols = columnsOf(db, 'reconciliation_logs')
    // 既有审计列保留
    for (const c of ['id', 'type', 'old_value', 'new_value', 'reason', 'operator', 'created_at']) {
      expect(cols).toContain(c)
    }
    // 新增工作流列
    for (const c of [
      'status',
      'reviewed_by',
      'reviewed_at',
      'applied_bom_id',
      'proposed_usage',
      'material_id',
      'project_id',
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('reconciliation_logs.status 默认 pending', () => {
    db.prepare(
      `INSERT INTO reconciliation_logs (id, type, target_id, reason) VALUES ('RL-BV-DEF', 'bom_fix_proposal', 'T1', '默认值测试')`,
    ).run()
    const row = db.prepare(`SELECT status FROM reconciliation_logs WHERE id = 'RL-BV-DEF'`).get() as any
    expect(row.status).toBe('pending')
  })

  it('重复 initializeDatabase 幂等不抛错', async () => {
    const mod = await import('../src/database/DatabaseManager.js')
    expect(() => mod.initializeDatabase()).not.toThrow()
    // 二次 init 后列仍齐全
    expect(columnsOf(db, 'bom_versions')).toContain('effective_scope')
    expect(columnsOf(db, 'reconciliation_logs')).toContain('status')
  })
})
