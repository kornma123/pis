/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { importStatementBatch, type StatementImportInput } from '../src/services/statement-normalized-lines.js'
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
const FX = join(__dirname, 'fixtures', 'statements')

function dongan(): StatementImportInput {
  const name = 'out_category_summary__dongan_2601.json'
  const fx = JSON.parse(readFileSync(join(FX, name), 'utf8'))
  return {
    partnerId: 'PT-DA',
    partnerName: fx.hospital,
    settlementMonth: '2026-01',
    sourceFile: fx.sourceFile,
    sourceHash: `sha256:${name}`,
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
    expect(classifyStatementReadiness({
      ...base,
      expectedRawRows: 0,
      actualRawRows: 0,
      expectedNormalizedLines: 0,
      actualNormalizedLines: 0,
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
  it('accepts only an explicitly authoritative empty statement as complete_empty', () => {
    const empty = {
      ...dongan(),
      partnerId: 'PT-EMPTY',
      sourceHash: 'sha256:authoritative-empty',
      grid: [],
      headerRow: 0,
    }
    expect(() => importStatementBatch(db, empty)).toThrow(/EMPTY_STATEMENT_NOT_CONFIRMED/)

    const imported = importStatementBatch(db, { ...empty, authoritativeEmpty: true })
    expect(readStatementSourceReadiness(db, 'PT-EMPTY', '2026-01', imported.generationId))
      .toMatchObject({
        state: 'complete_empty',
        reason_code: 'AUTHORITATIVE_EMPTY_IMPORT',
        totals: { raw_rows: 0, normalized_lines: 0 },
      })
    postStatementGeneration(db, imported.generationId)
    computeStatementMonth(db, 'PT-EMPTY', '2026-01', imported.generationId)
    completeStatementMonth(db, 'PT-EMPTY', '2026-01', imported.generationId, 'maker')
    expect(closeStatementMonth(db, 'PT-EMPTY', '2026-01', imported.generationId, 'checker').status)
      .toBe('closed')
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
})
