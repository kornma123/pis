/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeStatementSourceHash,
  importStatementBatch,
  type StatementImportInput,
} from '../src/services/statement-normalized-lines.js'
import { postStatementGeneration } from '../src/services/statement-ledger-phase1a.js'
import { buildCanonicalStatementArtifact } from '../src/services/statement-canonical-artifact.js'

let db: any
const FX = join(__dirname, 'fixtures', 'statements')

function input(name: string, partnerId: string, month: string): StatementImportInput {
  const fx = JSON.parse(readFileSync(join(FX, name), 'utf8'))
  return {
    partnerId,
    partnerName: fx.hospital,
    settlementMonth: month,
    sourceFile: fx.sourceFile,
    sourceHash: computeStatementSourceHash(fx.grid),
    templateFamily: fx.template,
    parserRevision: 'parser-phase1a-v1',
    configRevision: 'seed-phase1a-v1',
    sourceSheet: fx.sheet,
    headerRow: fx.headerRow,
    grid: fx.grid,
    uploadedBy: 'loc-004b-test',
  }
}

beforeAll(async () => {
  const manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
})

describe('S6 derived ledgers and canonical machine artifact', () => {
  it('accepts raw-SQL ledger rows only when the exact source lineage matches', () => {
    const source = input('out_category_summary__dongan_2601.json', 'PT-LINEAGE-EXACT', '2026-01')
    const imported = importStatementBatch(db, source)
    const inLine = db.prepare(`
      SELECT id, ledger_settlement_month month, amount
      FROM statement_normalized_lines
      WHERE generation_id = ? AND business_line = 'IN' AND amount > 0
      ORDER BY id LIMIT 1
    `).get(imported.generationId) as any
    const outLine = db.prepare(`
      SELECT id, ledger_settlement_month month, amount
      FROM statement_normalized_lines
      WHERE generation_id = ? AND business_line = 'OUT' AND amount > 0
      ORDER BY id LIMIT 1
    `).get(imported.generationId) as any
    db.prepare(`
      INSERT INTO partner_month_revenue_ledger (
        id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
        category_label, business_line, settlement_amount, ledger_scope
      ) VALUES ('PML-EXACT', ?, ?, ?, ?, ?, 'exact', 'IN', ?, 'statement_internal')
    `).run(
      imported.batchId,
      imported.generationId,
      source.partnerId,
      inLine.month,
      inLine.id,
      inLine.amount,
    )
    db.prepare(`
      INSERT INTO out_settlement_ledger (
        id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
        out_type, settlement_amount, lab_revenue_amount, ledger_scope
      ) VALUES ('OUT-EXACT', ?, ?, ?, ?, ?, 'exact', ?, 0, 'statement_internal')
    `).run(
      imported.batchId,
      imported.generationId,
      source.partnerId,
      outLine.month,
      outLine.id,
      outLine.amount,
    )
    expect((db.prepare(`
      SELECT COUNT(*) n FROM partner_month_revenue_ledger
      WHERE id = 'PML-EXACT' AND source_line_id = ?
    `).get(inLine.id) as any).n).toBe(1)
    expect((db.prepare(`
      SELECT COUNT(*) n FROM out_settlement_ledger
      WHERE id = 'OUT-EXACT' AND source_line_id = ?
    `).get(outLine.id) as any).n).toBe(1)
  })

  it('rejects raw-SQL cross-partner and cross-month ledger lineage with zero partial rows', () => {
    const source = input('out_category_summary__dongan_2601.json', 'PT-LINEAGE', '2026-01')
    const imported = importStatementBatch(db, source)
    const inLine = db.prepare(`
      SELECT id FROM statement_normalized_lines
      WHERE generation_id = ? AND business_line = 'IN' AND amount > 0
      ORDER BY id LIMIT 1
    `).get(imported.generationId) as any
    const outLine = db.prepare(`
      SELECT id FROM statement_normalized_lines
      WHERE generation_id = ? AND business_line = 'OUT' AND amount > 0
      ORDER BY id LIMIT 1
    `).get(imported.generationId) as any
    const before = {
      partner: (db.prepare('SELECT COUNT(*) n FROM partner_month_revenue_ledger').get() as any).n,
      out: (db.prepare('SELECT COUNT(*) n FROM out_settlement_ledger').get() as any).n,
    }
    expect(() => db.prepare(`
      INSERT INTO partner_month_revenue_ledger (
        id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
        category_label, business_line, settlement_amount, ledger_scope
      ) VALUES (
        'PML-CROSS-PARTNER', ?, ?, 'PT-OTHER', ?, ?, 'cross', 'IN', 1, 'statement_internal'
      )
    `).run(imported.batchId, imported.generationId, source.settlementMonth, inLine.id))
      .toThrow(/FOREIGN KEY constraint failed/)
    expect(() => db.prepare(`
      INSERT INTO out_settlement_ledger (
        id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
        out_type, settlement_amount, lab_revenue_amount, ledger_scope
      ) VALUES (
        'OUT-CROSS-MONTH', ?, ?, ?, '2026-02', ?, 'cross', 1, 0, 'statement_internal'
      )
    `).run(imported.batchId, imported.generationId, source.partnerId, outLine.id))
      .toThrow(/FOREIGN KEY constraint failed/)
    expect({
      partner: (db.prepare('SELECT COUNT(*) n FROM partner_month_revenue_ledger').get() as any).n,
      out: (db.prepare('SELECT COUNT(*) n FROM out_settlement_ledger').get() as any).n,
    }).toEqual(before)
  })

  it('posts Dongan and Ganzhou idempotently without merging into case_revenue', () => {
    const da = importStatementBatch(db, input('out_category_summary__dongan_2601.json', 'PT-DA-ART', '2026-01'))
    const first = postStatementGeneration(db, da.generationId)
    const retry = postStatementGeneration(db, da.generationId)
    expect(first).toEqual(retry)
    const daIn = db.prepare(`
      SELECT COALESCE(SUM(settlement_amount), 0) amount
      FROM partner_month_revenue_ledger WHERE generation_id = ?
    `).get(da.generationId) as any
    const daOut = db.prepare(`
      SELECT COALESCE(SUM(settlement_amount), 0) amount
      FROM out_settlement_ledger WHERE generation_id = ?
    `).get(da.generationId) as any
    expect({ in: daIn.amount, out: daOut.amount }).toEqual({ in: 93264.9, out: 27752 })
    expect((db.prepare('SELECT COUNT(*) n FROM out_settlement_ledger WHERE generation_id = ? AND settlement_amount = 0')
      .get(da.generationId) as any).n).toBe(0)

    const gz = importStatementBatch(db, input('out_outsourced_detail__ganzhou.json', 'PT-GZ', '2026-03'))
    postStatementGeneration(db, gz.generationId)
    const rows = db.prepare(`
      SELECT settlement_month month, ROUND(SUM(settlement_amount), 4) amount,
             ROUND(SUM(lab_revenue_amount), 4) lab
      FROM out_settlement_ledger WHERE generation_id = ?
      GROUP BY settlement_month ORDER BY settlement_month
    `).all(gz.generationId) as any[]
    expect(rows).toEqual([
      { month: '2026-01', amount: 2570.4, lab: 0 },
      { month: '2026-02', amount: 7534.8, lab: 0 },
      { month: '2026-03', amount: 30114, lab: 0 },
    ])
    expect((db.prepare('SELECT COUNT(*) n FROM case_revenue WHERE partner_id IN (?, ?)').get('PT-DA', 'PT-GZ') as any).n)
      .toBe(0)
  })

  it('fails closed for Pingquan period conflict and writes no posted ledger', () => {
    const pq = importStatementBatch(db, input('out_consult_remote__pingquan_2603.json', 'PT-PQ', '2026-03'))
    expect(() => postStatementGeneration(db, pq.generationId)).toThrow(/BLOCKING_QUALITY_FLAGS/)
    expect((db.prepare('SELECT COUNT(*) n FROM out_settlement_ledger WHERE generation_id = ?')
      .get(pq.generationId) as any).n).toBe(0)
  })

  it('produces deterministic canonical JSON/hash with explicit statement-only boundary', () => {
    const da = importStatementBatch(db, input('out_category_summary__dongan_2601.json', 'PT-DA', '2026-01'))
    postStatementGeneration(db, da.generationId)
    const a = buildCanonicalStatementArtifact(db, da.generationId)
    const b = buildCanonicalStatementArtifact(db, da.generationId)
    expect(a).toEqual(b)
    expect(a.artifact).toMatchObject({
      generation_id: da.generationId,
      declared_total: 121016.9,
      parsed_total: 121016.9,
      in_amount: 93264.9,
      out_amount: 27752,
      ledger_scope: 'statement_internal',
      pnl_bridge_status: 'not_integrated',
    })
    expect(a.canonicalJson).not.toContain('患者')
    expect(a.artifactHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
