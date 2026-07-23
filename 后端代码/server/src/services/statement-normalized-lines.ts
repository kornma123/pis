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
  /** @deprecated A client boolean is never authoritative; use emptyEvidence. */
  authoritativeEmpty?: boolean
  emptyEvidence?: AuthoritativeEmptyEvidenceInput
  uploadedBy?: string
}

export interface AuthoritativeEmptyEvidenceInput {
  schemaVersion: 'statement-authoritative-empty/v1'
  sourceIdentity: {
    partnerId: string
    settlementMonth: string
    sourceFile: string
    sourceSheet: string
    templateFamily: Exclude<StatementTemplate, 'unknown'>
  }
  coverage: {
    scope: 'complete_source'
    sourceSheet: string
    rawRowCount: 0
    normalizedLineCount: 0
  }
  canonicalContentHash: string
  verifiedAt: string
}

export interface TrustedStatementImportContext {
  actor?: string
  now?: Date
}

export interface AuthoritativeEmptyEvidenceRecord extends AuthoritativeEmptyEvidenceInput {
  verifiedBy: string
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
const SHA256_RE = /^sha256:[0-9a-f]{64}$/
const DECIMAL_RE = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?|\.\d{1,4})$/
const EMPTY_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const EMPTY_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1000
const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000

function stableId(prefix: string, ...parts: unknown[]): string {
  const hash = createHash('sha256').update(parts.map(part => String(part ?? '')).join('\u001f')).digest('hex')
  return `${prefix}-${hash.slice(0, 32)}`
}

function canonicalGrid(grid: Grid): Grid {
  if (!Array.isArray(grid)) {
    throw new Phase1AError('INVALID_STATEMENT_GRID', 'grid must be an array', 400)
  }
  return grid.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Phase1AError('INVALID_STATEMENT_GRID', `row ${rowIndex + 1} must be an array`, 400)
    }
    return row.map((cell, columnIndex) => {
      if (cell === null || cell === undefined) return null
      if (typeof cell === 'string') return cell
      if (typeof cell === 'number' && Number.isFinite(cell)) return Object.is(cell, -0) ? 0 : cell
      throw new Phase1AError(
        'INVALID_STATEMENT_GRID_CELL',
        `row ${rowIndex + 1} column ${columnIndex + 1} must be string, finite number or null`,
        422,
      )
    })
  })
}

export function computeStatementSourceHash(grid: Grid): string {
  const serialized = JSON.stringify(canonicalGrid(grid))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

export function computeAuthoritativeEmptyEvidenceHash(
  record: AuthoritativeEmptyEvidenceRecord,
): string {
  const serialized = JSON.stringify({
    schemaVersion: record.schemaVersion,
    sourceIdentity: record.sourceIdentity,
    coverage: record.coverage,
    canonicalContentHash: record.canonicalContentHash,
    verifiedAt: record.verifiedAt,
    verifiedBy: record.verifiedBy,
  })
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
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

export function parseStatementAmount(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Phase1AError('INVALID_FINANCIAL_AMOUNT', `${field} has an invalid type`, 422)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Phase1AError('INVALID_FINANCIAL_AMOUNT', `${field} must be finite`, 422)
  }
  const normalized = String(value).normalize('NFKC').trim().replace(/^[¥￥]\s*/, '')
  if (normalized === '') return null
  if (!DECIMAL_RE.test(normalized)) {
    throw new Phase1AError('INVALID_FINANCIAL_AMOUNT', `${field} must be a strict decimal`, 422)
  }
  const parsed = Number(normalized.replace(/,/g, ''))
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
    const amount = parseStatementAmount(row[amountColumn], `row ${index + 1}`)
    if (!item) continue
    if (amount === null) {
      throw new Phase1AError('MISSING_FINANCIAL_AMOUNT', `row ${index + 1} settlement amount is missing`, 422)
    }
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
      break
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
    const itemName = String(row[itemColumn] ?? '').trim()
    const amount = parseStatementAmount(row[amountColumn], `row ${physicalRow}`)
    if (amount === null) {
      if (!first && !itemName) continue
      throw new Phase1AError('MISSING_FINANCIAL_AMOUNT', `row ${physicalRow} settlement amount is missing`, 422)
    }
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
      const immunoAmount = parseStatementAmount(row[immunoColumn], `row ${physicalRow}`)
      if (immunoAmount === null) {
        throw new Phase1AError('MISSING_FINANCIAL_AMOUNT', `row ${physicalRow} immuno amount is missing`, 422)
      }
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
      const amount = parseStatementAmount(row[declaredColumn], `row ${physicalRow}`)
      if (amount === null) {
        throw new Phase1AError('MISSING_FINANCIAL_AMOUNT', `row ${physicalRow} declared amount is missing`, 422)
      }
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
    const caseNo = String(row[caseColumn] ?? '').trim()
    if (!caseNo) continue
    const amount = parseStatementAmount(row[remoteColumn], `row ${physicalRow}`)
    if (amount === null) {
      throw new Phase1AError('MISSING_FINANCIAL_AMOUNT', `row ${physicalRow} remote amount is missing`, 422)
    }
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

interface VerifiedStatementImport {
  input: StatementImportInput
  emptyEvidenceRecord: AuthoritativeEmptyEvidenceRecord | null
  emptyEvidenceHash: string | null
  emptyCoverageJson: string | null
}

function verifyStatementImportInput(
  candidate: StatementImportInput,
  context: TrustedStatementImportContext = {},
): VerifiedStatementImport {
  if (!candidate.partnerId || !candidate.sourceHash || !candidate.parserRevision || !candidate.configRevision) {
    throw new Phase1AError('GENERATION_KEY_INCOMPLETE', 'partner/source/parser/config are required', 400)
  }
  if (!MONTH_RE.test(candidate.settlementMonth)) {
    throw new Phase1AError('INVALID_SETTLEMENT_MONTH', 'settlementMonth must be YYYY-MM', 400)
  }
  if (!Number.isInteger(candidate.headerRow) || candidate.headerRow < 0 || !Array.isArray(candidate.grid)) {
    throw new Phase1AError('INVALID_STATEMENT_GRID', 'grid/headerRow are invalid', 400)
  }
  const grid = canonicalGrid(candidate.grid)
  if (candidate.authoritativeEmpty !== undefined) {
    throw new Phase1AError(
      'AUTHORITATIVE_EMPTY_EVIDENCE_REQUIRED',
      'client authoritativeEmpty boolean is not trusted',
      422,
    )
  }
  const sourceHash = computeStatementSourceHash(grid)
  if (!SHA256_RE.test(candidate.sourceHash) || candidate.sourceHash !== sourceHash) {
    throw new Phase1AError(
      'SOURCE_CONTENT_CONFLICT',
      'declared sourceHash does not match the server canonical grid hash',
      409,
    )
  }
  const input: StatementImportInput = { ...candidate, grid, sourceHash }

  if (grid.length !== 0) {
    if (candidate.emptyEvidence) {
      throw new Phase1AError(
        'INVALID_AUTHORITATIVE_EMPTY_EVIDENCE',
        'authoritative-empty evidence cannot accompany non-empty content',
        422,
      )
    }
    if (candidate.headerRow >= grid.length) {
      throw new Phase1AError('INVALID_STATEMENT_GRID', 'headerRow is outside the canonical grid', 400)
    }
    return { input, emptyEvidenceRecord: null, emptyEvidenceHash: null, emptyCoverageJson: null }
  }

  const evidence = candidate.emptyEvidence
  const actor = context.actor?.trim()
  if (!evidence || !actor) {
    throw new Phase1AError(
      'AUTHORITATIVE_EMPTY_EVIDENCE_REQUIRED',
      'empty source requires trusted verifier evidence',
      422,
    )
  }
  const sourceFile = candidate.sourceFile?.trim()
  const sourceSheet = candidate.sourceSheet?.trim()
  if (!sourceFile || !sourceSheet) {
    throw new Phase1AError(
      'AUTHORITATIVE_EMPTY_SOURCE_UNKNOWN',
      'empty evidence requires a known source file and sheet',
      422,
    )
  }
  if (
    evidence.schemaVersion !== 'statement-authoritative-empty/v1'
    || evidence.sourceIdentity.partnerId !== candidate.partnerId
    || evidence.sourceIdentity.settlementMonth !== candidate.settlementMonth
    || evidence.sourceIdentity.sourceFile !== sourceFile
    || evidence.sourceIdentity.sourceSheet !== sourceSheet
    || evidence.sourceIdentity.templateFamily !== candidate.templateFamily
    || evidence.coverage.scope !== 'complete_source'
    || evidence.coverage.sourceSheet !== sourceSheet
    || evidence.coverage.rawRowCount !== 0
    || evidence.coverage.normalizedLineCount !== 0
    || evidence.canonicalContentHash !== sourceHash
  ) {
    throw new Phase1AError(
      'INVALID_AUTHORITATIVE_EMPTY_EVIDENCE',
      'empty evidence is not bound to the source identity, coverage and content',
      422,
    )
  }
  const verifiedAtMs = Date.parse(evidence.verifiedAt)
  const nowMs = (context.now ?? new Date()).getTime()
  if (
    !Number.isFinite(verifiedAtMs)
    || verifiedAtMs < nowMs - EMPTY_EVIDENCE_MAX_AGE_MS
    || verifiedAtMs > nowMs + EMPTY_EVIDENCE_FUTURE_SKEW_MS
  ) {
    throw new Phase1AError(
      'INVALID_AUTHORITATIVE_EMPTY_EVIDENCE_TIME',
      'empty evidence timestamp is invalid, stale or in the future',
      422,
    )
  }
  const emptyEvidenceRecord: AuthoritativeEmptyEvidenceRecord = {
    schemaVersion: evidence.schemaVersion,
    sourceIdentity: {
      partnerId: evidence.sourceIdentity.partnerId,
      settlementMonth: evidence.sourceIdentity.settlementMonth,
      sourceFile,
      sourceSheet,
      templateFamily: evidence.sourceIdentity.templateFamily,
    },
    coverage: {
      scope: evidence.coverage.scope,
      sourceSheet,
      rawRowCount: 0,
      normalizedLineCount: 0,
    },
    canonicalContentHash: sourceHash,
    verifiedAt: new Date(verifiedAtMs).toISOString(),
    verifiedBy: actor,
  }
  return {
    input,
    emptyEvidenceRecord,
    emptyEvidenceHash: computeAuthoritativeEmptyEvidenceHash(emptyEvidenceRecord),
    emptyCoverageJson: JSON.stringify(emptyEvidenceRecord.coverage),
  }
}

function buildVerifiedStatementNormalizedFacts(input: StatementImportInput): StatementNormalizedFacts {
  if (input.grid.length === 0) {
    return { lines: [], flags: [], declaredTotal: null, parsedTotal: 0, multiMonthBatch: false }
  }
  if (input.templateFamily === 'category_summary') return donganFacts(input)
  if (input.templateFamily === 'outsourced_detail') return ganzhouFacts(input)
  if (input.templateFamily === 'consult_remote') return pingquanFacts(input)
  throw new Phase1AError('TEMPLATE_NOT_IN_PHASE1A', input.templateFamily, 422)
}

export function buildStatementNormalizedFacts(
  candidate: StatementImportInput,
  context: TrustedStatementImportContext = {},
): StatementNormalizedFacts {
  return buildVerifiedStatementNormalizedFacts(verifyStatementImportInput(candidate, context).input)
}

export function importStatementBatch(
  db: any,
  candidate: StatementImportInput,
  context: TrustedStatementImportContext = {},
): ImportStatementResult {
  const verified = verifyStatementImportInput(candidate, context)
  const input = verified.input
  const generationId = statementGenerationId(input)
  const batchId = stableId('STMT', generationId)
  const facts = buildVerifiedStatementNormalizedFacts(input)
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare(`
      SELECT id, generation_id, supersedes_generation_id, raw_row_count, normalized_line_count,
             empty_evidence_hash
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
      if ((existing.empty_evidence_hash ?? null) !== verified.emptyEvidenceHash) {
        throw new Phase1AError(
          'AUTHORITATIVE_EMPTY_EVIDENCE_CONFLICT',
          'the generation already exists with different authoritative-empty evidence',
          409,
        )
      }
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
        raw_row_count, normalized_line_count, status, uploaded_by,
        empty_evidence_hash, empty_verified_by, empty_verified_at, empty_coverage_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'parsed', ?, ?, ?, ?, ?)
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
      verified.emptyEvidenceHash,
      verified.emptyEvidenceRecord?.verifiedBy ?? null,
      verified.emptyEvidenceRecord?.verifiedAt ?? null,
      verified.emptyCoverageJson,
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
