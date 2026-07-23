/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  buildStatementNormalizedFacts,
  computeStatementSourceHash,
  importStatementBatch,
  parseStatementAmount,
  type StatementImportInput,
} from '../src/services/statement-normalized-lines.js'
import { postStatementGeneration } from '../src/services/statement-ledger-phase1a.js'
import {
  closeStatementMonth,
  completeStatementMonth,
  computeStatementMonth,
  readStatementMonth,
} from '../src/services/statement-month-close-phase1a.js'

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

function createFixedPredecessorSchema(
  database: DatabaseSync,
  withInvalidLineage = false,
  immediateParent = false,
): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE statement_import_batches (
      id TEXT PRIMARY KEY, partner_id TEXT NOT NULL, partner_name TEXT, source_file TEXT,
      source_hash TEXT NOT NULL, template_family TEXT NOT NULL, parser_revision TEXT NOT NULL,
      config_revision TEXT NOT NULL,
      settlement_month TEXT NOT NULL CHECK(settlement_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
      generation_id TEXT NOT NULL UNIQUE, supersedes_generation_id TEXT,
      is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)), source_sheet TEXT,
      declared_total DECIMAL(18,4), raw_row_count INTEGER NOT NULL CHECK(raw_row_count >= 0),
      normalized_line_count INTEGER NOT NULL CHECK(normalized_line_count >= 0),
      status TEXT NOT NULL DEFAULT 'parsed'
        CHECK(status IN ('parsed', 'posted', 'computed', 'complete', 'closed', 'error', 'unavailable')),
      artifact_hash TEXT, uploaded_by TEXT,
      ${immediateParent ? `
      empty_evidence_hash TEXT, empty_verified_by TEXT, empty_verified_at DATETIME,
      empty_coverage_json TEXT,` : ''}
      completed_at DATETIME, completed_by TEXT, closed_at DATETIME, closed_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(partner_id, settlement_month, source_hash, parser_revision, config_revision),
      UNIQUE(id, generation_id),
      UNIQUE(id, generation_id, partner_id, settlement_month)
    );
    CREATE TABLE statement_raw_rows (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, generation_id TEXT NOT NULL, source_sheet TEXT,
      source_row INTEGER NOT NULL CHECK(source_row >= 1), row_json TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(batch_id, generation_id) REFERENCES statement_import_batches(id, generation_id),
      UNIQUE(generation_id, source_sheet, source_row)
    );
    CREATE TABLE statement_normalized_lines (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, generation_id TEXT NOT NULL,
      partner_id TEXT NOT NULL, settlement_month TEXT NOT NULL, row_settlement_month TEXT,
      settlement_month_basis TEXT, case_no TEXT, external_subject_key TEXT, item_name TEXT,
      source_sheet TEXT, source_row INTEGER NOT NULL, source_column TEXT NOT NULL,
      source_label TEXT NOT NULL, template_family TEXT NOT NULL,
      row_kind TEXT NOT NULL CHECK(row_kind IN ('detail', 'subtotal', 'declared_total', 'header', 'note')),
      line_grain TEXT NOT NULL CHECK(line_grain IN ('case', 'aggregate', 'out', 'joint', 'adjustment', 'retainer')),
      business_line TEXT NOT NULL CHECK(business_line IN ('IN', 'OUT', 'UNKNOWN', 'NEUTRAL', 'EXCLUDED')),
      amount_role TEXT NOT NULL,
      amount DECIMAL(18,4) NOT NULL, classification_status TEXT NOT NULL, rule_id TEXT,
      rule_version TEXT, report_date TEXT, raw_payload TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(batch_id, generation_id, partner_id, settlement_month)
        REFERENCES statement_import_batches(id, generation_id, partner_id, settlement_month),
      UNIQUE(generation_id, source_sheet, source_row, source_column, amount_role),
      UNIQUE(id, generation_id, batch_id),
      UNIQUE(id, generation_id, batch_id, partner_id, settlement_month)
    );
    CREATE TABLE quality_flags (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, flag_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('blocking', 'warning', 'info')),
      owner_role TEXT NOT NULL, resolution_action TEXT NOT NULL,
      blocks_posting INTEGER NOT NULL CHECK(blocks_posting IN (0, 1)),
      blocks_closing INTEGER NOT NULL CHECK(blocks_closing IN (0, 1)), partner_id TEXT NOT NULL,
      settlement_month TEXT NOT NULL, related_batch_id TEXT NOT NULL, related_line_id TEXT,
      reason_code TEXT NOT NULL, message TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(related_batch_id, generation_id, partner_id, settlement_month)
        REFERENCES statement_import_batches(id, generation_id, partner_id, settlement_month),
      FOREIGN KEY(related_line_id, generation_id, related_batch_id, partner_id, settlement_month)
        REFERENCES statement_normalized_lines(id, generation_id, batch_id, partner_id, settlement_month)
    );
    CREATE TABLE partner_month_revenue_ledger (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, generation_id TEXT NOT NULL,
      partner_id TEXT NOT NULL, settlement_month TEXT NOT NULL, source_line_id TEXT NOT NULL UNIQUE,
      category_label TEXT, business_line TEXT NOT NULL CHECK(business_line = 'IN'),
      settlement_amount DECIMAL(18,4) NOT NULL,
      ledger_scope TEXT NOT NULL DEFAULT 'statement_internal' CHECK(ledger_scope = 'statement_internal'),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(batch_id, generation_id) REFERENCES statement_import_batches(id, generation_id),
      FOREIGN KEY(source_line_id, generation_id, batch_id)
        REFERENCES statement_normalized_lines(id, generation_id, batch_id)
    );
    CREATE TABLE out_settlement_ledger (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, generation_id TEXT NOT NULL,
      partner_id TEXT NOT NULL, settlement_month TEXT NOT NULL, source_line_id TEXT NOT NULL UNIQUE,
      out_type TEXT NOT NULL, item_name TEXT, external_subject_key TEXT,
      settlement_amount DECIMAL(18,4) NOT NULL,
      lab_revenue_amount DECIMAL(18,4) NOT NULL DEFAULT 0 CHECK(lab_revenue_amount = 0),
      ledger_scope TEXT NOT NULL DEFAULT 'statement_internal' CHECK(ledger_scope = 'statement_internal'),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(batch_id, generation_id) REFERENCES statement_import_batches(id, generation_id),
      FOREIGN KEY(source_line_id, generation_id, batch_id)
        REFERENCES statement_normalized_lines(id, generation_id, batch_id)
    );
    CREATE INDEX idx_statement_batches_partner_month_current
      ON statement_import_batches(partner_id, settlement_month, is_current);
    CREATE UNIQUE INDEX uq_statement_batches_one_current_generation
      ON statement_import_batches(partner_id, settlement_month) WHERE is_current = 1;
    CREATE INDEX idx_statement_raw_rows_generation
      ON statement_raw_rows(generation_id, source_row);
    CREATE INDEX idx_statement_lines_partner_month_generation
      ON statement_normalized_lines(partner_id, settlement_month, generation_id);
    CREATE UNIQUE INDEX uq_quality_flags_generation_identity
      ON quality_flags(generation_id, flag_type, COALESCE(related_line_id, ''));
    CREATE INDEX idx_quality_flags_generation_blocking
      ON quality_flags(generation_id, blocks_posting, blocks_closing);
    CREATE INDEX idx_partner_month_revenue_generation
      ON partner_month_revenue_ledger(partner_id, settlement_month, generation_id);
    CREATE INDEX idx_out_settlement_generation
      ON out_settlement_ledger(partner_id, settlement_month, generation_id);
    CREATE TRIGGER trg_statement_batch_immutable_identity
      BEFORE UPDATE ON statement_import_batches
      WHEN OLD.partner_id <> NEW.partner_id OR OLD.generation_id <> NEW.generation_id
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_IMPORT_FACT'); END;
    CREATE TRIGGER trg_statement_batch_no_delete
      BEFORE DELETE ON statement_import_batches
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_IMPORT_FACT'); END;
    CREATE TRIGGER trg_statement_raw_rows_no_update
      BEFORE UPDATE ON statement_raw_rows
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RAW_FACT'); END;
    CREATE TRIGGER trg_statement_raw_rows_no_delete
      BEFORE DELETE ON statement_raw_rows
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RAW_FACT'); END;
    CREATE TRIGGER trg_statement_normalized_lines_no_update
      BEFORE UPDATE ON statement_normalized_lines
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_NORMALIZED_FACT'); END;
    CREATE TRIGGER trg_statement_normalized_lines_no_delete
      BEFORE DELETE ON statement_normalized_lines
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_NORMALIZED_FACT'); END;
    CREATE TRIGGER trg_quality_flags_no_update
      BEFORE UPDATE ON quality_flags
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_QUALITY_FACT'); END;
    CREATE TRIGGER trg_quality_flags_no_delete
      BEFORE DELETE ON quality_flags
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_QUALITY_FACT'); END;
    CREATE TRIGGER trg_partner_month_revenue_ledger_no_update
      BEFORE UPDATE ON partner_month_revenue_ledger
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_LEDGER_FACT'); END;
    CREATE TRIGGER trg_partner_month_revenue_ledger_no_delete
      BEFORE DELETE ON partner_month_revenue_ledger
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_LEDGER_FACT'); END;
    CREATE TRIGGER trg_out_settlement_ledger_no_update
      BEFORE UPDATE ON out_settlement_ledger
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_LEDGER_FACT'); END;
    CREATE TRIGGER trg_out_settlement_ledger_no_delete
      BEFORE DELETE ON out_settlement_ledger
      BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_LEDGER_FACT'); END;
    INSERT INTO statement_import_batches (
      id, partner_id, source_file, source_hash, template_family, parser_revision, config_revision,
      settlement_month, generation_id, source_sheet, raw_row_count, normalized_line_count, status
    ) VALUES (
      'B-PRE', 'PT-PRE', 'pre.xlsx', 'sha256:predecessor', 'category_summary',
      'parser-phase1a-v1', 'seed-phase1a-v1', '2026-01', 'GEN-PRE', 'Sheet1', 1, 1, 'parsed'
    );
    INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
      VALUES ('RAW-PRE', 'B-PRE', 'GEN-PRE', 'Sheet1', 1, '[]');
    INSERT INTO statement_normalized_lines (
      id, batch_id, generation_id, partner_id, settlement_month, row_settlement_month,
      settlement_month_basis, source_sheet, source_row, source_column, source_label,
      template_family, row_kind, line_grain, business_line, amount_role, amount,
      classification_status, raw_payload
    ) VALUES (
      'LINE-PRE', 'B-PRE', 'GEN-PRE', 'PT-PRE', '2026-01', NULL, 'import_month',
      'Sheet1', 1, 'A', 'pre', 'category_summary', 'detail', 'aggregate', 'IN',
      'settlement', 1, 'classified', '{}'
    )
  `)
  database.prepare(`
    INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
    VALUES ('RAW-PRE-2', 'B-PRE', 'GEN-PRE', 'Sheet1', 2, '[]')
  `).run()
  const insertLine = database.prepare(`
    INSERT INTO statement_normalized_lines (
      id, batch_id, generation_id, partner_id, settlement_month, row_settlement_month,
      settlement_month_basis, source_sheet, source_row, source_column, source_label,
      template_family, row_kind, line_grain, business_line, amount_role, amount,
      classification_status, raw_payload
    ) VALUES (?, 'B-PRE', 'GEN-PRE', 'PT-PRE', '2026-01', NULL, 'import_month',
      'Sheet1', ?, ?, 'pre', 'category_summary', 'detail', 'aggregate', 'IN',
      'settlement', 1, 'classified', '{}')
  `)
  for (let index = 2; index <= 4; index += 1) {
    insertLine.run(`LINE-PRE-${index}`, index, `A${index}`)
  }
  const insertFlag = database.prepare(`
    INSERT INTO quality_flags (
      id, generation_id, flag_type, severity, owner_role, resolution_action,
      blocks_posting, blocks_closing, partner_id, settlement_month,
      related_batch_id, related_line_id, reason_code, message
    ) VALUES (?, 'GEN-PRE', ?, 'info', 'finance', 'none', 0, 0,
      'PT-PRE', '2026-01', 'B-PRE', NULL, ?, 'predecessor fixture')
  `)
  for (let index = 1; index <= 4; index += 1) {
    insertFlag.run(`FLAG-PRE-${index}`, `pre_flag_${index}`, `PRE_FLAG_${index}`)
  }
  const insertRevenue = database.prepare(`
    INSERT INTO partner_month_revenue_ledger (
      id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
      category_label, business_line, settlement_amount, ledger_scope
    ) VALUES (?, 'B-PRE', 'GEN-PRE', 'PT-PRE', '2026-01', ?, 'pre', 'IN', 1, 'statement_internal')
  `)
  const insertOut = database.prepare(`
    INSERT INTO out_settlement_ledger (
      id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
      out_type, item_name, external_subject_key, settlement_amount, lab_revenue_amount, ledger_scope
    ) VALUES (?, 'B-PRE', 'GEN-PRE', 'PT-PRE', '2026-01', ?, 'pre', 'pre', NULL, 1, 0, 'statement_internal')
  `)
  for (let index = 1; index <= 3; index += 1) {
    const lineId = index === 1 ? 'LINE-PRE' : `LINE-PRE-${index}`
    insertRevenue.run(`PML-PRE-${index}`, lineId)
    insertOut.run(`OUT-PRE-${index}`, lineId)
  }
  if (withInvalidLineage) {
    database.exec('PRAGMA foreign_keys = OFF')
    database.exec(`
      INSERT INTO partner_month_revenue_ledger (
        id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
        category_label, business_line, settlement_amount, ledger_scope
      ) VALUES (
        'PML-PRE-BAD', 'B-PRE', 'GEN-PRE', 'PT-OTHER', '2026-02', 'LINE-PRE-4',
        'bad', 'IN', 1, 'statement_internal'
      )
    `)
    database.exec('PRAGMA foreign_keys = ON')
  }
}

beforeAll(async () => {
  const manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  db = manager.getDatabase()
})

describe('S1/S2 Phase 1A canonical schema, immutability and generation idempotency', () => {
  it('provides an explicit predecessor-schema upgrade entry instead of relying on CREATE IF NOT EXISTS', async () => {
    const manager = await import('../src/database/DatabaseManager.js')
    expect(manager).toHaveProperty('upgradeStatementPhase1ASchema')
  })

  it('upgrades the fixed predecessor schema transactionally, reruns idempotently and accepts a post-upgrade import', async () => {
    const manager = await import('../src/database/DatabaseManager.js')
    const predecessor = new DatabaseSync(':memory:')
    try {
      createFixedPredecessorSchema(predecessor)
      expect(manager.upgradeStatementPhase1ASchema(predecessor)).toBe('upgraded')
      expect(manager.upgradeStatementPhase1ASchema(predecessor)).toBe('current')
      const batchColumns = (predecessor.prepare('PRAGMA table_info(statement_import_batches)')
        .all() as Array<{ name: string }>).map(column => column.name)
      expect(batchColumns).toEqual(expect.arrayContaining([
        'empty_evidence_hash',
        'empty_verified_by',
        'empty_verified_at',
        'empty_expires_at',
        'empty_coverage_json',
      ]))
      const lineColumns = (predecessor.prepare('PRAGMA table_info(statement_normalized_lines)')
        .all() as Array<{ name: string }>).map(column => column.name)
      expect(lineColumns).toContain('ledger_settlement_month')
      expect((predecessor.prepare(`
        SELECT ledger_settlement_month month FROM statement_normalized_lines WHERE id = 'LINE-PRE'
      `).get() as any).month).toBe('2026-01')
      expect(predecessor.prepare('PRAGMA foreign_key_check').all()).toEqual([])

      const imported = importStatementBatch(
        predecessor,
        input('out_category_summary__dongan_2601.json', 'PT-POST-UPGRADE', '2026-01'),
      )
      expect(imported).toMatchObject({ duplicate: false, rawRowCount: expect.any(Number) })
    } finally {
      predecessor.close()
    }
  })

  it('upgrades the fixed immediate-parent persisted shape and remains restart-idempotent', async () => {
    const manager = await import('../src/database/DatabaseManager.js')
    const predecessor = new DatabaseSync(':memory:')
    try {
      createFixedPredecessorSchema(predecessor, false, true)
      expect(manager.upgradeStatementPhase1ASchema(predecessor)).toBe('upgraded')
      expect(manager.upgradeStatementPhase1ASchema(predecessor)).toBe('current')
      expect(manager.upgradeStatementPhase1ASchema(predecessor)).toBe('current')
      expect((predecessor.prepare('PRAGMA table_info(statement_import_batches)')
        .all() as Array<{ name: string }>).map(column => column.name)).toEqual([
        'id', 'partner_id', 'partner_name', 'source_file', 'source_hash', 'template_family',
        'parser_revision', 'config_revision', 'settlement_month', 'generation_id',
        'supersedes_generation_id', 'is_current', 'source_sheet', 'declared_total',
        'raw_row_count', 'normalized_line_count', 'status', 'artifact_hash', 'uploaded_by',
        'empty_evidence_hash', 'empty_verified_by', 'empty_verified_at', 'empty_expires_at',
        'empty_coverage_json', 'empty_receipt_nonce', 'empty_idempotency_key',
        'completed_at', 'completed_by', 'closed_at', 'closed_by', 'created_at', 'updated_at',
      ])
      expect((predecessor.prepare('SELECT COUNT(*) n FROM statement_import_batches').get() as any).n).toBe(1)
      const facts = ['statement_raw_rows', 'statement_normalized_lines', 'quality_flags']
        .map(table => Number((predecessor.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n))
        .reduce((sum, count) => sum + count, 0)
      const ledgers = ['partner_month_revenue_ledger', 'out_settlement_ledger']
        .map(table => Number((predecessor.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n))
        .reduce((sum, count) => sum + count, 0)
      expect(facts).toBe(10)
      expect(ledgers).toBe(6)
      expect(predecessor.prepare('PRAGMA foreign_key_check').all()).toEqual([])

      const imported = importStatementBatch(
        predecessor,
        input('out_category_summary__dongan_2601.json', 'PT-RESTART-FLOW', '2026-01'),
      )
      postStatementGeneration(predecessor, imported.generationId)
      const computed = computeStatementMonth(predecessor, 'PT-RESTART-FLOW', '2026-01', imported.generationId)
      expect(readStatementMonth(predecessor, 'PT-RESTART-FLOW', '2026-01', imported.generationId).artifactHash)
        .toBe(computed.artifactHash)
      completeStatementMonth(predecessor, 'PT-RESTART-FLOW', '2026-01', imported.generationId, 'maker')
      expect(closeStatementMonth(
        predecessor,
        'PT-RESTART-FLOW',
        '2026-01',
        imported.generationId,
        'checker',
      ).status).toBe('closed')
    } finally {
      predecessor.close()
    }
  })

  it('fails closed when a current six-table manifest has a rogue column or missing trigger', async () => {
    const manager = await import('../src/database/DatabaseManager.js')
    for (const mutation of ['rogue-column', 'missing-trigger', 'missing-index', 'weak-quality'] as const) {
      const candidate = new DatabaseSync(':memory:')
      try {
        createFixedPredecessorSchema(candidate)
        expect(manager.upgradeStatementPhase1ASchema(candidate)).toBe('upgraded')
        if (mutation === 'rogue-column') {
          candidate.exec('ALTER TABLE quality_flags ADD COLUMN rogue_identity TEXT')
        } else if (mutation === 'missing-trigger') {
          candidate.exec('DROP TRIGGER trg_quality_flags_no_update')
        } else if (mutation === 'missing-index') {
          candidate.exec('DROP INDEX idx_quality_flags_generation_blocking')
        } else {
          candidate.exec(`
            ALTER TABLE quality_flags RENAME TO quality_flags_strong;
            CREATE TABLE quality_flags AS SELECT * FROM quality_flags_strong;
            DROP TABLE quality_flags_strong
          `)
        }
        expect(() => manager.upgradeStatementPhase1ASchema(candidate))
          .toThrow(/STATEMENT_PHASE1A_SCHEMA_UNSUPPORTED/)
      } finally {
        candidate.close()
      }
    }
  })

  it('rejects raw SQLite non-text identity values instead of accepting TEXT affinity coercion', async () => {
    const manager = await import('../src/database/DatabaseManager.js')
    const candidate = new DatabaseSync(':memory:')
    try {
      createFixedPredecessorSchema(candidate)
      expect(manager.upgradeStatementPhase1ASchema(candidate)).toBe('upgraded')
      const identities: Record<string, string[]> = {
        statement_import_batches: [
          'id', 'partner_id', 'source_hash', 'parser_revision', 'config_revision',
          'settlement_month', 'generation_id', 'supersedes_generation_id',
          'empty_receipt_nonce', 'empty_idempotency_key',
        ],
        statement_raw_rows: ['id', 'batch_id', 'generation_id'],
        statement_normalized_lines: [
          'id', 'batch_id', 'generation_id', 'partner_id', 'settlement_month',
          'ledger_settlement_month',
        ],
        quality_flags: [
          'id', 'generation_id', 'partner_id', 'settlement_month',
          'related_batch_id', 'related_line_id',
        ],
        partner_month_revenue_ledger: [
          'id', 'batch_id', 'generation_id', 'partner_id', 'settlement_month', 'source_line_id',
        ],
        out_settlement_ledger: [
          'id', 'batch_id', 'generation_id', 'partner_id', 'settlement_month', 'source_line_id',
        ],
      }
      for (const [table, columns] of Object.entries(identities)) {
        const manifest = candidate.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string
          type: string
        }>
        for (const column of columns) {
          expect(manifest.find(item => item.name === column)?.type, `${table}.${column}`).toBe('BLOB')
        }
      }
      const insertRaw = candidate.prepare(`
        INSERT INTO statement_raw_rows
          (id, batch_id, generation_id, source_sheet, source_row, row_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (const [index, invalid] of [12345, Buffer.from('blob-id'), null].entries()) {
        expect(() => insertRaw.run(invalid, 'B-PRE', 'GEN-PRE', 'Sheet1', 90 + index, '[]'))
          .toThrow()
      }
      expect((candidate.prepare('SELECT COUNT(*) n FROM statement_raw_rows').get() as any).n).toBe(2)
    } finally {
      candidate.close()
    }
  })

  it('fails closed on partial/unknown schemas and rolls back an invalid predecessor lineage', async () => {
    const manager = await import('../src/database/DatabaseManager.js')
    const partial = new DatabaseSync(':memory:')
    try {
      partial.exec('CREATE TABLE statement_import_batches (id TEXT PRIMARY KEY)')
      expect(() => manager.upgradeStatementPhase1ASchema(partial))
        .toThrow(/STATEMENT_PHASE1A_SCHEMA_UNSUPPORTED/)
      expect((partial.prepare(`
        SELECT COUNT(*) n FROM sqlite_master
        WHERE type = 'table' AND name = 'statement_import_batches'
      `).get() as any).n).toBe(1)
    } finally {
      partial.close()
    }

    const invalid = new DatabaseSync(':memory:')
    try {
      createFixedPredecessorSchema(invalid, true)
      expect(() => manager.upgradeStatementPhase1ASchema(invalid))
        .toThrow(/STATEMENT_PHASE1A_UPGRADE_FAILED/)
      const columns = (invalid.prepare('PRAGMA table_info(statement_import_batches)')
        .all() as Array<{ name: string }>).map(column => column.name)
      expect(columns).not.toContain('empty_evidence_hash')
      expect((invalid.prepare(`
        SELECT COUNT(*) n FROM partner_month_revenue_ledger WHERE id = 'PML-PRE-BAD'
      `).get() as any).n).toBe(1)
      expect((invalid.prepare(`
        SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '__loc004b_predecessor_%'
      `).get() as any).n).toBe(0)
    } finally {
      invalid.close()
    }
  })

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
