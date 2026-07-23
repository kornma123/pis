import { createHash } from 'node:crypto'
import {
  findStatementColumn,
  normalizeStatementText,
  statementColumnIdentity,
  statementMonthFromCell,
  type Grid,
  type StatementTemplate,
} from '../utils/statement-parser/index.js'

export type BusinessLine = 'IN' | 'OUT' | 'UNKNOWN' | 'NEUTRAL' | 'EXCLUDED'

export class Phase1AError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly httpStatus = 409,
  ) {
    super(`${code}: ${message}`)
    this.name = 'Phase1AError'
  }
}

export interface StatementImportInput {
  partnerId: string
  partnerName?: string
  settlementMonth: string
  sourceFile?: string
  sourceHash: string
  templateFamily: Exclude<StatementTemplate, 'unknown'>
  parserRevision: string
  configRevision: string
  sourceSheet?: string
  headerRow: number
  grid: Grid
  authoritativeEmpty?: boolean
  uploadedBy?: string
}

export interface NormalizedLineFact {
  sourceRow: number
  sourceColumn: string
  sourceLabel: string
  rowKind: 'detail' | 'subtotal' | 'declared_total' | 'header' | 'note'
  lineGrain: 'case' | 'aggregate' | 'out' | 'joint' | 'adjustment' | 'retainer'
  businessLine: BusinessLine
  amountRole: 'settlement' | 'declared_total'
  amount: number
  classificationStatus: 'classified' | 'pending' | 'not_applicable'
  ruleId?: string
  ruleVersion?: string
  itemName?: string
  caseNo?: string
  externalSubjectKey?: string
  rowSettlementMonth?: string
  settlementMonthBasis?: string
  reportDate?: string
  rawPayload?: Record<string, unknown>
}

export interface QualityFlagFact {
  flagType: string
  severity: 'blocking' | 'warning' | 'info'
  ownerRole: 'finance' | 'implementation' | 'cost' | 'admin'
  resolutionAction: string
  blocksPosting: 0 | 1
  blocksClosing: 0 | 1
  reasonCode: string
  message: string
  relatedSourceIdentity?: string
}

export interface StatementNormalizedFacts {
  lines: NormalizedLineFact[]
  flags: QualityFlagFact[]
  declaredTotal: number | null
  parsedTotal: number
  multiMonthBatch: boolean
}

export interface ImportStatementResult {
  batchId: string
  generationId: string
  supersedesGenerationId: string | null
  rawRowCount: number
  normalizedLineCount: number
  duplicate: boolean
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000

function stableId(prefix: string, ...parts: unknown[]): string {
  const hash = createHash('sha256').update(parts.map(part => String(part ?? '')).join('\u001f')).digest('hex')
  return `${prefix}-${hash.slice(0, 32)}`
}

export function statementGenerationId(input: Pick<
  StatementImportInput,
  'partnerId' | 'settlementMonth' | 'sourceHash' | 'parserRevision' | 'configRevision'
>): string {
  return stableId(
    'GEN',
    input.partnerId,
    input.settlementMonth,
    input.sourceHash,
    input.parserRevision,
    input.configRevision,
  )
}

function finiteAmount(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null
  const normalized = String(value).normalize('NFKC').replace(/[¥,\s]/g, '')
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) throw new Phase1AError('INVALID_FINANCIAL_AMOUNT', `${field} is not finite`, 422)
  if (Math.abs(parsed) > Number.MAX_SAFE_INTEGER / 10_000) {
    throw new Phase1AError('INVALID_FINANCIAL_AMOUNT', `${field} exceeds safe precision`, 422)
  }
  return round4(parsed)
}

function sourceIdentity(row: number, column: string): string {
  return `${row}:${column}`
}

function normalizedSourceColumn(index: number, label: unknown): string {
  return `${statementColumnIdentity(index)}:${normalizeStatementText(label)}`
}

function classifyDongan(item: string): { businessLine: BusinessLine; lineGrain: 'aggregate' | 'out'; ruleId?: string } {
  const normalized = normalizeStatementText(item).toUpperCase()
  if (/HPV|基因检测|FISH/.test(normalized)) {
    return { businessLine: 'OUT', lineGrain: 'out', ruleId: 'SEED-OUT-V1' }
  }
  if (/常规病理|免疫组化|EBER|特殊染色|冰冻|P16/.test(normalized)) {
    return { businessLine: 'IN', lineGrain: 'aggregate', ruleId: 'SEED-IN-V1' }
  }
  return { businessLine: 'UNKNOWN', lineGrain: 'aggregate' }
}

function donganFacts(input: StatementImportInput): StatementNormalizedFacts {
  const header = input.grid[input.headerRow] ?? []
  const itemColumn = findStatementColumn(header, [/项目名称/, /科室/])
  const amountColumn = findStatementColumn(header, [/^合计结算金额$/, /^结算金额$/])
  if (itemColumn < 0 || amountColumn < 0) {
    throw new Phase1AError('TEMPLATE_COLUMNS_MISSING', 'category_summary item/settlement column missing', 422)
  }
  const sourceColumn = normalizedSourceColumn(amountColumn, header[amountColumn])
  const sourceLabel = normalizeStatementText(header[amountColumn])
  const lines: NormalizedLineFact[] = []
  const flags: QualityFlagFact[] = []
  let declaredTotal: number | null = null

  for (let index = input.headerRow + 1; index < input.grid.length; index += 1) {
    const row = input.grid[index] ?? []
    const item = String(row[itemColumn] ?? '').trim()
    const amount = finiteAmount(row[amountColumn], `row ${index + 1}`)
    if (!item || amount === null) continue
    const physicalRow = index + 1
    if (/^(合计|总计)/.test(normalizeStatementText(item))) {
      declaredTotal = amount
      lines.push({
        sourceRow: physicalRow,
        sourceColumn,
        sourceLabel,
        rowKind: 'declared_total',
        lineGrain: 'aggregate',
        businessLine: 'NEUTRAL',
        amountRole: 'declared_total',
        amount,
        classificationStatus: 'not_applicable',
        itemName: item,
      })
      continue
    }
    const classification = classifyDongan(item)
    const identity = sourceIdentity(physicalRow, sourceColumn)
    lines.push({
      sourceRow: physicalRow,
      sourceColumn,
      sourceLabel,
      rowKind: 'detail',
      lineGrain: classification.lineGrain,
      businessLine: classification.businessLine,
      amountRole: 'settlement',
      amount,
      classificationStatus: classification.businessLine === 'UNKNOWN' ? 'pending' : 'classified',
      ruleId: classification.ruleId,
      ruleVersion: input.configRevision,
      itemName: item,
    })
    if (classification.businessLine === 'UNKNOWN') {
      flags.push({
        flagType: 'missing_rule',
        severity: 'blocking',
        ownerRole: 'implementation',
        resolutionAction: 'create_new_generation_with_named_rule',
        blocksPosting: 1,
        blocksClosing: 1,
        reasonCode: 'MISSING_CATEGORY_RULE',
        message: `No Phase 1A seed rule for ${item}`,
        relatedSourceIdentity: identity,
      })
    }
  }
  return finalizeFacts(lines, flags, declaredTotal)
}

function ganzhouFacts(input: StatementImportInput): StatementNormalizedFacts {
  const header = input.grid[input.headerRow] ?? []
  const itemColumn = findStatementColumn(header, [/送检项目名称/, /项目名称/])
  const reportColumn = findStatementColumn(header, [/报告日期/, /报告时间/])
  const amountColumn = findStatementColumn(header, [/^结算金额$/])
  if (itemColumn < 0 || reportColumn < 0 || amountColumn < 0) {
    throw new Phase1AError('TEMPLATE_COLUMNS_MISSING', 'outsourced_detail item/report/settlement column missing', 422)
  }
  const sourceColumn = normalizedSourceColumn(amountColumn, header[amountColumn])
  const sourceLabel = normalizeStatementText(header[amountColumn])
  const lines: NormalizedLineFact[] = []
  const flags: QualityFlagFact[] = []
  let declaredTotal: number | null = null

  for (let index = input.headerRow + 1; index < input.grid.length; index += 1) {
    const row = input.grid[index] ?? []
    const physicalRow = index + 1
    const first = normalizeStatementText(row[0])
    const amount = finiteAmount(row[amountColumn], `row ${physicalRow}`)
    if (amount === null) continue
    if (/^(合计|总计)/.test(first)) {
      declaredTotal = amount
      lines.push({
        sourceRow: physicalRow,
        sourceColumn,
        sourceLabel,
        rowKind: 'declared_total',
        lineGrain: 'out',
        businessLine: 'NEUTRAL',
        amountRole: 'declared_total',
        amount,
        classificationStatus: 'not_applicable',
      })
      continue
    }
    const itemName = String(row[itemColumn] ?? '').trim()
    if (!itemName) continue
    const reportDate = String(row[reportColumn] ?? '').trim()
    const rowSettlementMonth = statementMonthFromCell(reportDate)
    const identity = sourceIdentity(physicalRow, sourceColumn)
    lines.push({
      sourceRow: physicalRow,
      sourceColumn,
      sourceLabel,
      rowKind: 'detail',
      lineGrain: 'out',
      businessLine: 'OUT',
      amountRole: 'settlement',
      amount,
      classificationStatus: 'classified',
      ruleId: 'SEED-GANZHOU-PURE-OUT-V1',
      ruleVersion: input.configRevision,
      itemName,
      externalSubjectKey: stableId('SUBJECT', input.sourceHash, physicalRow),
      rowSettlementMonth: rowSettlementMonth ?? undefined,
      settlementMonthBasis: rowSettlementMonth ? 'report_date' : undefined,
      reportDate,
    })
    if (!rowSettlementMonth) {
      flags.push({
        flagType: 'settlement_month_basis_missing',
        severity: 'blocking',
        ownerRole: 'implementation',
        resolutionAction: 'create_new_generation_with_report_date',
        blocksPosting: 1,
        blocksClosing: 1,
        reasonCode: 'REPORT_DATE_REQUIRED',
        message: `Report date missing or invalid at source row ${physicalRow}`,
        relatedSourceIdentity: identity,
      })
    } else {
      flags.push({
        flagType: 'pure_out_without_case',
        severity: 'info',
        ownerRole: 'finance',
        resolutionAction: 'post_to_out_ledger',
        blocksPosting: 0,
        blocksClosing: 0,
        reasonCode: 'PURE_OUT_NO_CASE_EXPECTED',
        message: `Pure OUT source row ${physicalRow} has no case number by contract`,
        relatedSourceIdentity: identity,
      })
    }
  }
  return finalizeFacts(lines, flags, declaredTotal)
}

function compactMonthSignal(value: unknown): string | null {
  const text = normalizeStatementText(value)
  const compact = text.match(/(20\d{2})(0[1-9]|1[0-2])/)
  if (compact) return `${compact[1]}-${compact[2]}`
  return statementMonthFromCell(text)
}

function pingquanFacts(input: StatementImportInput): StatementNormalizedFacts {
  const header = input.grid[input.headerRow] ?? []
  const immunoColumn = findStatementColumn(header, [/\u514d\u7ec4\u7ed3\u7b97\u91d1\u989d/])
  const caseColumn = findStatementColumn(header, [/病理号/])
  const remoteColumn = findStatementColumn(header, [/远程会诊结算/])
  const declaredColumn = findStatementColumn(header, [/^结算合计$/])
  if (caseColumn < 0 || remoteColumn < 0 || immunoColumn < 0 || declaredColumn < 0) {
    throw new Phase1AError('TEMPLATE_COLUMNS_MISSING', 'consult_remote case/remote/immuno/total column missing', 422)
  }
  const remoteSourceColumn = normalizedSourceColumn(remoteColumn, header[remoteColumn])
  const remoteSourceLabel = normalizeStatementText(header[remoteColumn])
  const immunoSourceColumn = normalizedSourceColumn(immunoColumn, header[immunoColumn])
  const immunoSourceLabel = normalizeStatementText(header[immunoColumn])
  const declaredSourceColumn = normalizedSourceColumn(declaredColumn, header[declaredColumn])
  const declaredSourceLabel = normalizeStatementText(header[declaredColumn])
  const lines: NormalizedLineFact[] = []
  const flags: QualityFlagFact[] = []
  let declaredTotal: number | null = null

  for (let index = input.headerRow + 1; index < input.grid.length; index += 1) {
    const row = input.grid[index] ?? []
    const physicalRow = index + 1
    const first = normalizeStatementText(row[0])
    if (/^合计/.test(first)) {
      const immunoAmount = finiteAmount(row[immunoColumn], `row ${physicalRow}`)
      if (immunoAmount !== null) {
        lines.push({
          sourceRow: physicalRow,
          sourceColumn: immunoSourceColumn,
          sourceLabel: immunoSourceLabel,
          rowKind: 'detail',
          lineGrain: 'out',
          businessLine: 'UNKNOWN',
          amountRole: 'settlement',
          amount: immunoAmount,
          classificationStatus: immunoAmount === 0 ? 'not_applicable' : 'pending',
          ruleVersion: input.configRevision,
          itemName: immunoSourceLabel,
          rowSettlementMonth: input.settlementMonth,
          settlementMonthBasis: 'header',
        })
        if (immunoAmount !== 0) {
          flags.push({
            flagType: 'missing_rule',
            severity: 'blocking',
            ownerRole: 'implementation',
            resolutionAction: 'create_new_generation_with_named_rule',
            blocksPosting: 1,
            blocksClosing: 1,
            reasonCode: 'PINGQUAN_IMMUNO_NONZERO_UNCLASSIFIED',
            message: 'Non-zero Pingquan immuno settlement has no approved IN/OUT rule',
            relatedSourceIdentity: sourceIdentity(physicalRow, immunoSourceColumn),
          })
        }
      }
      const amount = finiteAmount(row[declaredColumn], `row ${physicalRow}`)
      if (amount !== null) {
        declaredTotal = amount
        lines.push({
          sourceRow: physicalRow,
          sourceColumn: declaredSourceColumn,
          sourceLabel: declaredSourceLabel,
          rowKind: 'declared_total',
          lineGrain: 'out',
          businessLine: 'NEUTRAL',
          amountRole: 'declared_total',
          amount,
          classificationStatus: 'not_applicable',
        })
      }
      continue
    }
    if (/小计/.test(first)) continue
    const amount = finiteAmount(row[remoteColumn], `row ${physicalRow}`)
    const caseNo = String(row[caseColumn] ?? '').trim()
    if (!caseNo || amount === null) continue
    lines.push({
      sourceRow: physicalRow,
      sourceColumn: remoteSourceColumn,
      sourceLabel: remoteSourceLabel,
      rowKind: 'detail',
      lineGrain: 'out',
      businessLine: 'OUT',
      amountRole: 'settlement',
      amount,
      classificationStatus: 'classified',
      ruleId: 'SEED-PINGQUAN-REMOTE-OUT-V1',
      ruleVersion: input.configRevision,
      caseNo,
      itemName: '远程会诊',
      rowSettlementMonth: input.settlementMonth,
      settlementMonthBasis: 'header',
    })
  }

  const headerSignal = compactMonthSignal(input.grid[0]?.[0])
  const fileSignal = compactMonthSignal(input.sourceFile)
  const sheetSignal = compactMonthSignal(input.sourceSheet)
  const competing = [headerSignal, fileSignal, sheetSignal].filter((value): value is string => Boolean(value))
  if (new Set(competing).size > 1) {
    flags.push({
      flagType: 'period_conflict',
      severity: 'blocking',
      ownerRole: 'finance',
      resolutionAction: 'future_adjustment_or_reclassification',
      blocksPosting: 1,
      blocksClosing: 1,
      reasonCode: 'PERIOD_CONFLICT_FAIL_CLOSED',
      message: `Conflicting period signals: header=${headerSignal ?? 'unknown'}, file=${fileSignal ?? 'unknown'}, sheet=${sheetSignal ?? 'unknown'}`,
    })
  }
  return finalizeFacts(lines, flags, declaredTotal)
}

function finalizeFacts(
  lines: NormalizedLineFact[],
  flags: QualityFlagFact[],
  declaredTotal: number | null,
): StatementNormalizedFacts {
  const parsedTotal = round4(lines
    .filter(line => line.rowKind === 'detail')
    .reduce((sum, line) => sum + line.amount, 0))
  if (declaredTotal !== null && Math.abs(parsedTotal - declaredTotal) > 0.01) {
    flags.push({
      flagType: 'declared_total_mismatch',
      severity: 'blocking',
      ownerRole: 'finance',
      resolutionAction: 'create_new_generation_after_reconciliation',
      blocksPosting: 0,
      blocksClosing: 1,
      reasonCode: 'DECLARED_TOTAL_MISMATCH',
      message: `Parsed total ${parsedTotal} does not match declared total ${declaredTotal}`,
    })
  }
  const months = new Set(lines.map(line => line.rowSettlementMonth).filter(Boolean))
  return { lines, flags, declaredTotal, parsedTotal, multiMonthBatch: months.size > 1 }
}

export function buildStatementNormalizedFacts(input: StatementImportInput): StatementNormalizedFacts {
  if (!input.partnerId || !input.sourceHash || !input.parserRevision || !input.configRevision) {
    throw new Phase1AError('GENERATION_KEY_INCOMPLETE', 'partner/source/parser/config are required', 400)
  }
  if (!MONTH_RE.test(input.settlementMonth)) {
    throw new Phase1AError('INVALID_SETTLEMENT_MONTH', 'settlementMonth must be YYYY-MM', 400)
  }
  if (!Number.isInteger(input.headerRow) || input.headerRow < 0 || !Array.isArray(input.grid)) {
    throw new Phase1AError('INVALID_STATEMENT_GRID', 'grid/headerRow are invalid', 400)
  }
  if (input.authoritativeEmpty === true) {
    if (input.grid.length !== 0) {
      throw new Phase1AError('INVALID_AUTHORITATIVE_EMPTY', 'authoritativeEmpty requires an empty parsed grid', 400)
    }
    return { lines: [], flags: [], declaredTotal: null, parsedTotal: 0, multiMonthBatch: false }
  }
  if (input.grid.length === 0) {
    throw new Phase1AError('EMPTY_STATEMENT_NOT_CONFIRMED', 'empty grid requires authoritativeEmpty=true', 422)
  }
  if (input.templateFamily === 'category_summary') return donganFacts(input)
  if (input.templateFamily === 'outsourced_detail') return ganzhouFacts(input)
  if (input.templateFamily === 'consult_remote') return pingquanFacts(input)
  throw new Phase1AError('TEMPLATE_NOT_IN_PHASE1A', input.templateFamily, 422)
}

export function importStatementBatch(db: any, input: StatementImportInput): ImportStatementResult {
  const generationId = statementGenerationId(input)
  const batchId = stableId('STMT', generationId)
  const facts = buildStatementNormalizedFacts(input)
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare(`
      SELECT id, generation_id, supersedes_generation_id, raw_row_count, normalized_line_count
      FROM statement_import_batches
      WHERE partner_id = ? AND settlement_month = ? AND source_hash = ?
        AND parser_revision = ? AND config_revision = ?
    `).get(
      input.partnerId,
      input.settlementMonth,
      input.sourceHash,
      input.parserRevision,
      input.configRevision,
    ) as any
    if (existing) {
      db.exec('COMMIT')
      return {
        batchId: existing.id,
        generationId: existing.generation_id,
        supersedesGenerationId: existing.supersedes_generation_id ?? null,
        rawRowCount: Number(existing.raw_row_count),
        normalizedLineCount: Number(existing.normalized_line_count),
        duplicate: true,
      }
    }

    const closed = db.prepare(`
      SELECT generation_id FROM statement_import_batches
      WHERE partner_id = ? AND settlement_month = ? AND status = 'closed'
      LIMIT 1
    `).get(input.partnerId, input.settlementMonth) as any
    if (closed) throw new Phase1AError('CLOSED_MONTH_CHANGE', `closed generation ${closed.generation_id}`)

    const previous = db.prepare(`
      SELECT generation_id FROM statement_import_batches
      WHERE partner_id = ? AND settlement_month = ? AND is_current = 1
      ORDER BY created_at DESC LIMIT 1
    `).get(input.partnerId, input.settlementMonth) as any
    const supersedesGenerationId = previous?.generation_id ?? null
    if (supersedesGenerationId) {
      db.prepare(`
        UPDATE statement_import_batches SET is_current = 0, updated_at = CURRENT_TIMESTAMP
        WHERE generation_id = ? AND status <> 'closed'
      `).run(supersedesGenerationId)
    }

    db.prepare(`
      INSERT INTO statement_import_batches (
        id, partner_id, partner_name, source_file, source_hash, template_family,
        parser_revision, config_revision, settlement_month, generation_id,
        supersedes_generation_id, is_current, source_sheet, declared_total,
        raw_row_count, normalized_line_count, status, uploaded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'parsed', ?)
    `).run(
      batchId,
      input.partnerId,
      input.partnerName ?? null,
      input.sourceFile ?? null,
      input.sourceHash,
      input.templateFamily,
      input.parserRevision,
      input.configRevision,
      input.settlementMonth,
      generationId,
      supersedesGenerationId,
      input.sourceSheet ?? null,
      facts.declaredTotal,
      input.grid.length,
      facts.lines.length,
      input.uploadedBy ?? null,
    )

    const insertRaw = db.prepare(`
      INSERT INTO statement_raw_rows (id, batch_id, generation_id, source_sheet, source_row, row_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    input.grid.forEach((row, index) => {
      insertRaw.run(
        stableId('RAW', generationId, input.sourceSheet ?? '', index + 1),
        batchId,
        generationId,
        input.sourceSheet ?? null,
        index + 1,
        JSON.stringify(row),
      )
    })

    const lineIds = new Map<string, string>()
    const insertLine = db.prepare(`
      INSERT INTO statement_normalized_lines (
        id, batch_id, generation_id, partner_id, settlement_month, row_settlement_month,
        settlement_month_basis, case_no, external_subject_key, item_name, source_sheet,
        source_row, source_column, source_label, template_family, row_kind, line_grain,
        business_line, amount_role, amount, classification_status, rule_id, rule_version,
        report_date, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const line of facts.lines) {
      const id = stableId('LINE', generationId, input.sourceSheet ?? '', line.sourceRow, line.sourceColumn, line.amountRole)
      lineIds.set(sourceIdentity(line.sourceRow, line.sourceColumn), id)
      insertLine.run(
        id,
        batchId,
        generationId,
        input.partnerId,
        input.settlementMonth,
        line.rowSettlementMonth ?? null,
        line.settlementMonthBasis ?? null,
        line.caseNo ?? null,
        line.externalSubjectKey ?? null,
        line.itemName ?? null,
        input.sourceSheet ?? null,
        line.sourceRow,
        line.sourceColumn,
        line.sourceLabel,
        input.templateFamily,
        line.rowKind,
        line.lineGrain,
        line.businessLine,
        line.amountRole,
        line.amount,
        line.classificationStatus,
        line.ruleId ?? null,
        line.ruleVersion ?? null,
        line.reportDate ?? null,
        line.rawPayload ? JSON.stringify(line.rawPayload) : null,
      )
    }

    const insertFlag = db.prepare(`
      INSERT INTO quality_flags (
        id, generation_id, flag_type, severity, owner_role, resolution_action,
        blocks_posting, blocks_closing, partner_id, settlement_month,
        related_batch_id, related_line_id, reason_code, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const flag of facts.flags) {
      const relatedLineId = flag.relatedSourceIdentity ? lineIds.get(flag.relatedSourceIdentity) ?? null : null
      insertFlag.run(
        stableId('FLAG', generationId, flag.flagType, relatedLineId ?? ''),
        generationId,
        flag.flagType,
        flag.severity,
        flag.ownerRole,
        flag.resolutionAction,
        flag.blocksPosting,
        flag.blocksClosing,
        input.partnerId,
        input.settlementMonth,
        batchId,
        relatedLineId,
        flag.reasonCode,
        flag.message,
      )
    }
    db.exec('COMMIT')
    return {
      batchId,
      generationId,
      supersedesGenerationId,
      rawRowCount: input.grid.length,
      normalizedLineCount: facts.lines.length,
      duplicate: false,
    }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}
