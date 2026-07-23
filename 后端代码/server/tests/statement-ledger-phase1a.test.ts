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
