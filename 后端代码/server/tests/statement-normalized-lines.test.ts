/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildStatementNormalizedFacts,
  computeStatementSourceHash,
  importStatementBatch,
  parseStatementAmount,
  type StatementImportInput,
} from '../src/services/statement-normalized-lines.js'

let db: any
const FX = join(__dirname, 'fixtures', 'statements')
const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FX, name), 'utf8'))
}

function input(name: string, partnerId: string, settlementMonth: string): StatementImportInput {
  const fx = fixture(name)
  return {
    partnerId,
    partnerName: fx.hospital,
    settlementMonth,
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

describe('S1/S2 Phase 1A canonical schema, immutability and generation idempotency', () => {
  it('creates all six canonical SQLite tables and keeps raw rows immutable', () => {
    const names = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'statement_import_batches', 'statement_raw_rows', 'statement_normalized_lines',
        'quality_flags', 'partner_month_revenue_ledger', 'out_settlement_ledger'
      ) ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)
    expect(names).toEqual([
      'out_settlement_ledger',
      'partner_month_revenue_ledger',
      'quality_flags',
      'statement_import_batches',
      'statement_normalized_lines',
      'statement_raw_rows',
    ])

    const created = importStatementBatch(db, input('out_category_summary__dongan_2601.json', 'PT-DA', '2026-01'))
    const raw = db.prepare('SELECT id FROM statement_raw_rows WHERE batch_id = ? LIMIT 1').get(created.batchId) as any
    expect(() => db.prepare('UPDATE statement_raw_rows SET row_json = ? WHERE id = ?').run('[]', raw.id))
      .toThrow(/IMMUTABLE_RAW_FACT/)
  })

  it('returns the same generation on exact retry and appends a superseding generation for a new revision', () => {
    const first = importStatementBatch(db, input('out_category_summary__dongan_2601.json', 'PT-DA-IDEM', '2026-01'))
    const retry = importStatementBatch(db, input('out_category_summary__dongan_2601.json', 'PT-DA-IDEM', '2026-01'))
    expect(retry).toMatchObject({ batchId: first.batchId, generationId: first.generationId, duplicate: true })
    expect((db.prepare('SELECT COUNT(*) n FROM statement_normalized_lines WHERE generation_id = ?')
      .get(first.generationId) as any).n)
      .toBe(first.normalizedLineCount)

    const revisedInput = { ...input('out_category_summary__dongan_2601.json', 'PT-DA-IDEM', '2026-01'), configRevision: 'seed-phase1a-v2' }
    const revised = importStatementBatch(db, revisedInput)
    expect(revised.generationId).not.toBe(first.generationId)
    const row = db.prepare('SELECT supersedes_generation_id, is_current FROM statement_import_batches WHERE id = ?')
      .get(revised.batchId) as any
    expect(row).toEqual({ supersedes_generation_id: first.generationId, is_current: 1 })
    expect((db.prepare('SELECT is_current FROM statement_import_batches WHERE id = ?').get(first.batchId) as any).is_current)
      .toBe(0)

    const replacementInput = structuredClone(revisedInput)
    replacementInput.grid[0][0] = `${String(replacementInput.grid[0][0] ?? '')} replacement`
    replacementInput.sourceHash = computeStatementSourceHash(replacementInput.grid)
    const replacement = importStatementBatch(db, replacementInput)
    expect(replacement.supersedesGenerationId).toBe(revised.generationId)
    expect((db.prepare('SELECT is_current FROM statement_import_batches WHERE id = ?').get(revised.batchId) as any).is_current)
      .toBe(0)
    expect((db.prepare(`
      SELECT COUNT(*) n FROM statement_import_batches
      WHERE partner_id = ? AND settlement_month = ? AND is_current = 1
    `).get('PT-DA-IDEM', '2026-01') as any).n).toBe(1)
  })

  it('rejects concurrent changed content under an idempotency hash with zero partial writes', async () => {
    const original = input('out_category_summary__dongan_2601.json', 'PT-HASH-CONFLICT', '2026-01')
    const first = importStatementBatch(db, original)
    const changed = structuredClone(original)
    changed.grid[5][5] = 999
    const competing = structuredClone(original)
    competing.grid[5][5] = 998
    const before = {
      batches: (db.prepare('SELECT COUNT(*) n FROM statement_import_batches WHERE partner_id = ?')
        .get(original.partnerId) as any).n,
      raw: (db.prepare('SELECT COUNT(*) n FROM statement_raw_rows WHERE generation_id = ?')
        .get(first.generationId) as any).n,
      normalized: (db.prepare('SELECT COUNT(*) n FROM statement_normalized_lines WHERE generation_id = ?')
        .get(first.generationId) as any).n,
    }
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => importStatementBatch(db, changed)),
      Promise.resolve().then(() => importStatementBatch(db, competing)),
    ])
    expect(outcomes).toHaveLength(2)
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected')
      expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/SOURCE_CONTENT_CONFLICT/)
    }
    expect({
      batches: (db.prepare('SELECT COUNT(*) n FROM statement_import_batches WHERE partner_id = ?')
        .get(original.partnerId) as any).n,
      raw: (db.prepare('SELECT COUNT(*) n FROM statement_raw_rows WHERE generation_id = ?')
        .get(first.generationId) as any).n,
      normalized: (db.prepare('SELECT COUNT(*) n FROM statement_normalized_lines WHERE generation_id = ?')
        .get(first.generationId) as any).n,
    }).toEqual(before)
  })

  it('rejects a generation that points at a different batch parent', () => {
    const left = importStatementBatch(db, input('out_category_summary__dongan_2601.json', 'PT-FK-LEFT', '2026-01'))
    const right = importStatementBatch(db, input('out_category_summary__dongan_2601.json', 'PT-FK-RIGHT', '2026-01'))
    const before = (db.prepare('SELECT COUNT(*) n FROM statement_raw_rows').get() as any).n
    expect(() => db.prepare(`
      INSERT INTO statement_raw_rows (
        id, batch_id, generation_id, source_sheet, source_row, row_json
      ) VALUES ('RAW-CROSS-GENERATION', ?, ?, 'cross', 999, '[]')
    `).run(left.batchId, right.generationId)).toThrow(/FOREIGN KEY constraint failed/)
    expect((db.prepare('SELECT COUNT(*) n FROM statement_raw_rows').get() as any).n).toBe(before)
  })
})

describe('S3-S5 three Candidate fixtures', () => {
  it('never coerces missing, whitespace, NBSP, containers or non-decimal amounts to zero', () => {
    const invalidValues: unknown[] = [' ', '\u00a0', [], {}, 'not-a-decimal', '1e3']
    for (const value of invalidValues) {
      if (typeof value === 'string' && value.trim() === '') {
        expect(parseStatementAmount(value, 'amount')).toBeNull()
      } else {
        expect(() => parseStatementAmount(value, 'amount')).toThrow(/INVALID_FINANCIAL_AMOUNT/)
      }
    }
    for (const value of [' ', '\u00a0']) {
      const changed = input('out_category_summary__dongan_2601.json', `PT-AMOUNT-${value.length}`, '2026-01')
      changed.grid[5][3] = value
      changed.sourceHash = computeStatementSourceHash(changed.grid)
      expect(() => buildStatementNormalizedFacts(changed)).toThrow(/MISSING_FINANCIAL_AMOUNT/)
    }
    const zero = input('out_category_summary__dongan_2601.json', 'PT-AMOUNT-ZERO', '2026-01')
    zero.grid[5][3] = '0'
    zero.sourceHash = computeStatementSourceHash(zero.grid)
    expect(buildStatementNormalizedFacts(zero).lines).toContainEqual(expect.objectContaining({
      amount: 0,
      itemName: expect.any(String),
    }))
  })

  it('normalizes Dongan with declared=121016.9, IN=93264.9 and OUT=27752.0', () => {
    const facts = buildStatementNormalizedFacts(input('out_category_summary__dongan_2601.json', 'PT-DA', '2026-01'))
    const details = facts.lines.filter(line => line.rowKind === 'detail')
    expect(facts.declaredTotal).toBe(121016.9)
    expect(round4(details.filter(line => line.businessLine === 'IN').reduce((sum, line) => sum + line.amount, 0))).toBe(93264.9)
    expect(round4(details.filter(line => line.businessLine === 'OUT').reduce((sum, line) => sum + line.amount, 0))).toBe(27752)
    expect(details.find(line => line.itemName?.includes('FISH'))).toMatchObject({
      amount: 0,
      businessLine: 'OUT',
      lineGrain: 'out',
    })
    expect(facts.flags.some(flag => flag.flagType === 'declared_total_mismatch')).toBe(false)
  })

  it('normalizes Ganzhou as pure OUT by report_date without inventing case numbers', () => {
    const facts = buildStatementNormalizedFacts(input('out_outsourced_detail__ganzhou.json', 'PT-GZ', '2026-03'))
    const details = facts.lines.filter(line => line.rowKind === 'detail')
    const byMonth = Object.fromEntries(['2026-01', '2026-02', '2026-03'].map(month => [
      month,
      round4(details.filter(line => line.rowSettlementMonth === month).reduce((sum, line) => sum + line.amount, 0)),
    ]))
    expect(byMonth).toEqual({ '2026-01': 2570.4, '2026-02': 7534.8, '2026-03': 30114 })
    expect(details.every(line =>
      line.businessLine === 'OUT'
      && line.lineGrain === 'out'
      && line.settlementMonthBasis === 'report_date'
      && !line.caseNo
    )).toBe(true)
    expect(facts.declaredTotal).toBe(40219.2)
  })

  it('preserves Pingquan source column and creates an unresolvable double-blocking period conflict', () => {
    const facts = buildStatementNormalizedFacts(input('out_consult_remote__pingquan_2603.json', 'PT-PQ', '2026-03'))
    const remote = facts.lines.filter(line => line.sourceLabel.includes('远程会诊结算') && line.rowKind === 'detail')
    expect(remote.map(line => line.amount)).toEqual([308.7, 308.7])
    expect(remote.every(line => line.businessLine === 'OUT' && line.sourceColumn.length > 0)).toBe(true)
    const immuno = facts.lines.filter(line => line.sourceLabel === '\u514d\u7ec4\u7ed3\u7b97\u91d1\u989d')
    expect(immuno).toEqual([expect.objectContaining({
      amount: 0,
      businessLine: 'UNKNOWN',
      classificationStatus: 'not_applicable',
    })])
    expect(facts.declaredTotal).toBe(617.4)
    expect(facts.flags).toContainEqual(expect.objectContaining({
      flagType: 'period_conflict',
      blocksPosting: 1,
      blocksClosing: 1,
      resolutionAction: 'future_adjustment_or_reclassification',
    }))
  })

  it('blocks a non-zero Pingquan immuno amount until a named rule creates a new generation', () => {
    const changed = input('out_consult_remote__pingquan_2603.json', 'PT-PQ-RULE', '2026-03')
    const immunoColumn = changed.grid[changed.headerRow]
      .findIndex(value => String(value).replace(/\s/g, '') === '\u514d\u7ec4\u7ed3\u7b97\u91d1\u989d')
    const totalRow = changed.grid.findIndex(row => String(row[0]).trim() === '\u5408\u8ba1')
    changed.grid[totalRow][immunoColumn] = 1
    changed.sourceHash = computeStatementSourceHash(changed.grid)
    const facts = buildStatementNormalizedFacts(changed)
    expect(facts.lines).toContainEqual(expect.objectContaining({
      amount: 1,
      businessLine: 'UNKNOWN',
      classificationStatus: 'pending',
    }))
    expect(facts.flags).toContainEqual(expect.objectContaining({
      flagType: 'missing_rule',
      blocksPosting: 1,
      blocksClosing: 1,
      reasonCode: 'PINGQUAN_IMMUNO_NONZERO_UNCLASSIFIED',
    }))
  })
})
