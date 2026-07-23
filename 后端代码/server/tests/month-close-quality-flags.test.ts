/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import statementBatchRoutes from '../src/routes/statement-batches-v1.1.js'
import {
  computeAuthoritativeEmptyEvidenceHash,
  computeStatementSourceHash,
  importStatementBatch,
  type AuthoritativeEmptyEvidenceRecord,
  type StatementImportInput,
} from '../src/services/statement-normalized-lines.js'
import { postStatementGeneration } from '../src/services/statement-ledger-phase1a.js'
import {
  classifyStatementReadiness,
  readAuxiliarySourceReadiness,
  readStatementSourceReadiness,
} from '../src/services/statement-source-readiness.js'
import {
  closeStatementMonth,
  completeStatementMonth,
  computeStatementMonth,
  readStatementMonth,
} from '../src/services/statement-month-close-phase1a.js'

let db: any
let routeApp: express.Express
const FX = join(__dirname, 'fixtures', 'statements')

function dongan(): StatementImportInput {
  const name = 'out_category_summary__dongan_2601.json'
  const fx = JSON.parse(readFileSync(join(FX, name), 'utf8'))
  return {
    partnerId: 'PT-DA',
    partnerName: fx.hospital,
    settlementMonth: '2026-01',
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

function authoritativeEmpty(partnerId: string): StatementImportInput {
  const input: StatementImportInput = {
    ...dongan(),
    partnerId,
    grid: [],
    headerRow: 0,
    sourceHash: computeStatementSourceHash([]),
  }
  input.emptyEvidence = {
    schemaVersion: 'statement-authoritative-empty/v1',
    sourceIdentity: {
      partnerId,
      settlementMonth: input.settlementMonth,
      sourceFile: input.sourceFile!,
      sourceSheet: input.sourceSheet!,
      templateFamily: input.templateFamily,
    },
    coverage: {
      scope: 'complete_source',
      sourceSheet: input.sourceSheet!,
      rawRowCount: 0,
      normalizedLineCount: 0,
    },
    canonicalContentHash: input.sourceHash,
    verifiedAt: new Date().toISOString(),
  }
  return input
}

beforeAll(async () => {
  const manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
  routeApp = express()
  routeApp.use(express.json())
  routeApp.use((req: any, _res, next) => {
    req.user = { username: 'trusted-finance', role: 'finance', roles: ['finance'] }
    next()
  })
  routeApp.use('/api/v1/statement-batches', statementBatchRoutes)
})

describe('six-state SourceReadinessResult contract', () => {
  it('distinguishes complete, complete_empty, partial, stale, unavailable and error', () => {
    const base = {
      source: 'statement' as const,
      partnerId: 'PT',
      settlementMonth: '2026-01',
      generationId: 'GEN',
      observedAt: '2026-01-31T00:00:00.000Z',
      expectedRawRows: 2,
      actualRawRows: 2,
      expectedNormalizedLines: 1,
      actualNormalizedLines: 1,
      current: true,
      status: 'posted',
    }
    expect(classifyStatementReadiness(base).state).toBe('complete')
    const emptyRecord: AuthoritativeEmptyEvidenceRecord = {
      schemaVersion: 'statement-authoritative-empty/v1',
      sourceIdentity: {
        partnerId: base.partnerId,
        settlementMonth: base.settlementMonth,
        sourceFile: 'empty.xlsx',
        sourceSheet: 'Sheet1',
        templateFamily: 'category_summary',
      },
      coverage: {
        scope: 'complete_source',
        sourceSheet: 'Sheet1',
        rawRowCount: 0,
        normalizedLineCount: 0,
      },
      canonicalContentHash: computeStatementSourceHash([]),
      verifiedAt: '2026-01-31T00:00:00.000Z',
      verifiedBy: 'trusted-finance',
    }
    expect(classifyStatementReadiness({
      ...base,
      expectedRawRows: 0,
      actualRawRows: 0,
      expectedNormalizedLines: 0,
      actualNormalizedLines: 0,
      sourceFile: emptyRecord.sourceIdentity.sourceFile,
      sourceSheet: emptyRecord.sourceIdentity.sourceSheet,
      sourceHash: emptyRecord.canonicalContentHash,
      templateFamily: emptyRecord.sourceIdentity.templateFamily,
      emptyEvidenceHash: computeAuthoritativeEmptyEvidenceHash(emptyRecord),
      emptyVerifiedBy: emptyRecord.verifiedBy,
      emptyVerifiedAt: emptyRecord.verifiedAt,
      emptyCoverageJson: JSON.stringify(emptyRecord.coverage),
    }).state).toBe('complete_empty')
    expect(classifyStatementReadiness({ ...base, actualRawRows: 1 }).state).toBe('partial')
    expect(classifyStatementReadiness({ ...base, current: false }).state).toBe('stale')
    expect(classifyStatementReadiness({ ...base, status: 'unavailable' }).state).toBe('unavailable')
    expect(classifyStatementReadiness({ ...base, status: 'error' }).state).toBe('error')
  })

  it('does not turn missing LIS/revenue manifests into zero or success', () => {
    for (const source of ['lis', 'revenue'] as const) {
      const result = readAuxiliarySourceReadiness(source, 'PT', '2026-01', 'GEN')
      expect(result).toMatchObject({
        source,
        required: false,
        state: 'unavailable',
        reason_code: 'MANIFEST_NOT_CONNECTED',
      })
      expect(result).not.toHaveProperty('data')
      expect(result).not.toHaveProperty('totals')
    }
  })
})

describe('same-generation compute/read/complete/close', () => {
  it('rejects a bare authoritativeEmpty boolean at the service boundary', () => {
    const empty = authoritativeEmpty('PT-EMPTY-BARE')
    delete empty.emptyEvidence
    expect(() => importStatementBatch(db, empty)).toThrow(/AUTHORITATIVE_EMPTY_EVIDENCE_REQUIRED/)
    expect(() => importStatementBatch(db, { ...empty, authoritativeEmpty: true }))
      .toThrow(/AUTHORITATIVE_EMPTY_EVIDENCE_REQUIRED/)
  })

  it('accepts complete_empty only with valid trusted evidence and preserves its DB projection', () => {
    const empty = authoritativeEmpty('PT-EMPTY-VALID')
    const imported = importStatementBatch(db, empty, { actor: 'trusted-finance' })
    const readiness = readStatementSourceReadiness(
      db,
      empty.partnerId,
      empty.settlementMonth,
      imported.generationId,
    )
    expect(readiness).toMatchObject({
      state: 'complete_empty',
      reason_code: 'AUTHORITATIVE_EMPTY_IMPORT',
      totals: { raw_rows: 0, normalized_lines: 0 },
    })
    const row = db.prepare(`
      SELECT empty_evidence_hash, empty_verified_by, empty_verified_at, empty_coverage_json
      FROM statement_import_batches WHERE id = ?
    `).get(imported.batchId) as any
    expect(row.empty_evidence_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(row.empty_verified_by).toBe('trusted-finance')
    expect(row.empty_verified_at).toBe(empty.emptyEvidence!.verifiedAt)
    expect(JSON.parse(row.empty_coverage_json)).toEqual(empty.emptyEvidence!.coverage)
  })

  it('keeps a raw-SQL empty batch without trusted evidence unavailable instead of inventing success', () => {
    const sourceHash = computeStatementSourceHash([])
    db.prepare(`
      INSERT INTO statement_import_batches (
        id, partner_id, source_hash, template_family, parser_revision, config_revision,
        settlement_month, generation_id, raw_row_count, normalized_line_count, status
      ) VALUES (
        'STMT-EMPTY-UNVERIFIED', 'PT-EMPTY-UNVERIFIED', ?, 'category_summary',
        'parser-phase1a-v1', 'seed-phase1a-v1', '2026-01',
        'GEN-EMPTY-UNVERIFIED', 0, 0, 'parsed'
      )
    `).run(sourceHash)
    const readiness = readStatementSourceReadiness(
      db,
      'PT-EMPTY-UNVERIFIED',
      '2026-01',
      'GEN-EMPTY-UNVERIFIED',
    )
    expect(readiness).toMatchObject({
      state: 'unavailable',
      reason_code: 'AUTHORITATIVE_EMPTY_EVIDENCE_MISSING_OR_INVALID',
    })
    expect(readiness).not.toHaveProperty('data')
    expect(readiness).not.toHaveProperty('totals')
  })

  it('rejects bare or missing-source empty claims at the route and writes no DB facts', async () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM statement_import_batches').get() as any).n
    const bare = await request(routeApp).post('/api/v1/statement-batches').send({
      ...dongan(),
      partnerId: 'PT-EMPTY-ROUTE-BARE',
      sourceHash: computeStatementSourceHash([]),
      grid: [],
      headerRow: 0,
      authoritativeEmpty: true,
    })
    expect(bare.status).toBe(422)
    expect(bare.body.error.code).toBe('AUTHORITATIVE_EMPTY_EVIDENCE_REQUIRED')

    const missingSourceInput = authoritativeEmpty('PT-EMPTY-ROUTE-MISSING')
    const missingSource = await request(routeApp).post('/api/v1/statement-batches').send({
      ...missingSourceInput,
      sourceFile: undefined,
      sourceSheet: undefined,
    })
    expect(missingSource.status).toBe(422)
    expect(missingSource.body.error.code).toBe('AUTHORITATIVE_EMPTY_SOURCE_UNKNOWN')
    expect((db.prepare('SELECT COUNT(*) n FROM statement_import_batches').get() as any).n).toBe(before)
  })

  it('binds all consumers to one generation and makes closed state irreversible', () => {
    const imported = importStatementBatch(db, dongan())
    postStatementGeneration(db, imported.generationId)

    expect(readStatementSourceReadiness(db, 'PT-DA', '2026-01', imported.generationId).state).toBe('complete')
    const computed = computeStatementMonth(db, 'PT-DA', '2026-01', imported.generationId)
    const read = readStatementMonth(db, 'PT-DA', '2026-01', imported.generationId)
    expect(read.artifactHash).toBe(computed.artifactHash)
    expect(() => readStatementMonth(db, 'PT-DA', '2026-01', 'GEN-WRONG')).toThrow(/GENERATION_NOT_FOUND/)

    const completed = completeStatementMonth(db, 'PT-DA', '2026-01', imported.generationId, 'maker')
    expect(completed.status).toBe('complete')
    expect(completed.artifactHash).not.toBe(computed.artifactHash)
    const closed = closeStatementMonth(db, 'PT-DA', '2026-01', imported.generationId, 'checker')
    expect(closed.status).toBe('closed')
    expect(closed.artifactHash).toBe(completed.artifactHash)

    expect(() => computeStatementMonth(db, 'PT-DA', '2026-01', imported.generationId))
      .toThrow(/GENERATION_CLOSED/)
    expect(() => postStatementGeneration(db, imported.generationId)).toThrow(/GENERATION_CLOSED/)
    expect(() => importStatementBatch(db, { ...dongan(), configRevision: 'seed-phase1a-v2' }))
      .toThrow(/CLOSED_MONTH_CHANGE/)
    expect(() => db.prepare(`
      UPDATE statement_import_batches SET status = 'parsed' WHERE generation_id = ?
    `).run(imported.generationId)).toThrow(/CLOSED_GENERATION_IMMUTABLE/)

    const row = db.prepare(`
      SELECT status, generation_id, artifact_hash, closed_by
      FROM statement_import_batches WHERE generation_id = ?
    `).get(imported.generationId) as any
    expect(row).toEqual({
      status: 'closed',
      generation_id: imported.generationId,
      artifact_hash: completed.artifactHash,
      closed_by: 'checker',
    })
  })

  it('rejects raw-SQL inserts into every fact child of a closed generation and preserves all counts', () => {
    const source = { ...dongan(), partnerId: 'PT-CLOSED-CHILDREN' }
    const imported = importStatementBatch(db, source)
    postStatementGeneration(db, imported.generationId)
    computeStatementMonth(db, source.partnerId, source.settlementMonth, imported.generationId)
    completeStatementMonth(db, source.partnerId, source.settlementMonth, imported.generationId, 'maker')
    closeStatementMonth(db, source.partnerId, source.settlementMonth, imported.generationId, 'checker')
    const unusedLine = db.prepare(`
      SELECT l.id FROM statement_normalized_lines l
      LEFT JOIN partner_month_revenue_ledger p ON p.source_line_id = l.id
      LEFT JOIN out_settlement_ledger o ON o.source_line_id = l.id
      WHERE l.generation_id = ? AND p.id IS NULL AND o.id IS NULL
      ORDER BY l.id LIMIT 1
    `).get(imported.generationId) as any
    const counts = () => Object.fromEntries([
      'statement_import_batches',
      'statement_raw_rows',
      'statement_normalized_lines',
      'quality_flags',
      'partner_month_revenue_ledger',
      'out_settlement_ledger',
    ].map(table => [table, (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n]))
    const before = counts()
    const attempts = [
      () => db.prepare(`
        INSERT INTO statement_raw_rows
          (id, batch_id, generation_id, source_sheet, source_row, row_json)
        VALUES ('RAW-LATE', ?, ?, 'late', 999, '[]')
      `).run(imported.batchId, imported.generationId),
      () => db.prepare(`
        INSERT INTO statement_normalized_lines (
          id, batch_id, generation_id, partner_id, settlement_month, source_row,
          source_column, source_label, template_family, row_kind, line_grain,
          business_line, amount_role, amount, classification_status
        ) VALUES ('LINE-LATE', ?, ?, ?, ?, 999, 'Z', 'late', 'category_summary',
          'detail', 'aggregate', 'IN', 'settlement', 1, 'classified')
      `).run(imported.batchId, imported.generationId, source.partnerId, source.settlementMonth),
      () => db.prepare(`
        INSERT INTO quality_flags (
          id, generation_id, flag_type, severity, owner_role, resolution_action,
          blocks_posting, blocks_closing, partner_id, settlement_month,
          related_batch_id, reason_code, message
        ) VALUES ('FLAG-LATE', ?, 'late', 'blocking', 'finance', 'none',
          1, 1, ?, ?, ?, 'LATE', 'late')
      `).run(imported.generationId, source.partnerId, source.settlementMonth, imported.batchId),
      () => db.prepare(`
        INSERT INTO partner_month_revenue_ledger (
          id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
          category_label, business_line, settlement_amount, ledger_scope
        ) VALUES ('PML-LATE', ?, ?, ?, ?, ?, 'late', 'IN', 1, 'statement_internal')
      `).run(imported.batchId, imported.generationId, source.partnerId, source.settlementMonth, unusedLine.id),
      () => db.prepare(`
        INSERT INTO out_settlement_ledger (
          id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
          out_type, settlement_amount, lab_revenue_amount, ledger_scope
        ) VALUES ('OUT-LATE', ?, ?, ?, ?, ?, 'late', 1, 0, 'statement_internal')
      `).run(imported.batchId, imported.generationId, source.partnerId, source.settlementMonth, unusedLine.id),
    ]
    for (const attempt of attempts) expect(attempt).toThrow(/CLOSED_PARENT_IMMUTABLE/)
    expect(() => db.prepare('DELETE FROM statement_import_batches WHERE id = ?').run(imported.batchId))
      .toThrow(/CLOSED_GENERATION_IMMUTABLE/)
    expect(counts()).toEqual(before)
  })
})
