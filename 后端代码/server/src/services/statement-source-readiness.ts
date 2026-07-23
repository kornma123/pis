import {
  computeAuthoritativeEmptyEvidenceHash,
  Phase1AError,
  type AuthoritativeEmptyReceiptClaims,
} from './statement-normalized-lines.js'

export type SourceReadinessState =
  | 'complete'
  | 'complete_empty'
  | 'partial'
  | 'stale'
  | 'unavailable'
  | 'error'

export interface SourceReadinessResult<T = unknown> {
  source: 'statement' | 'lis' | 'revenue'
  partner_id: string
  settlement_month: string
  generation_id: string
  state: SourceReadinessState
  observed_at: string
  reason_code: string
  required: boolean
  data?: T
  totals?: Record<string, number>
}

export interface StatementReadinessSnapshot {
  source: 'statement'
  partnerId: string
  settlementMonth: string
  generationId: string
  observedAt: string
  expectedRawRows: number
  actualRawRows: number
  expectedNormalizedLines: number
  actualNormalizedLines: number
  current: boolean
  status: string
  sourceFile?: string | null
  sourceSheet?: string | null
  sourceHash?: string | null
  templateFamily?: string | null
  emptyEvidenceHash?: string | null
  emptyVerifiedBy?: string | null
  emptyVerifiedAt?: string | null
  emptyExpiresAt?: string | null
  emptyCoverageJson?: string | null
  parserRevision?: string | null
  configRevision?: string | null
}

function hasValidAuthoritativeEmptyEvidence(snapshot: StatementReadinessSnapshot): boolean {
  if (
    !snapshot.sourceFile
    || !snapshot.sourceSheet
    || !snapshot.sourceHash
    || !snapshot.templateFamily
    || !snapshot.emptyEvidenceHash
    || !snapshot.emptyVerifiedBy
    || !snapshot.emptyVerifiedAt
    || !snapshot.emptyExpiresAt
    || !snapshot.emptyCoverageJson
    || !snapshot.parserRevision
    || !snapshot.configRevision
    || !Number.isFinite(Date.parse(snapshot.emptyVerifiedAt))
    || !Number.isFinite(Date.parse(snapshot.emptyExpiresAt))
  ) return false
  try {
    const coverage = JSON.parse(snapshot.emptyCoverageJson) as AuthoritativeEmptyReceiptClaims['coverage']
    if (
      coverage.scope !== 'complete_source'
      || coverage.sourceSheet !== snapshot.sourceSheet
      || coverage.rawRowCount !== 0
      || coverage.normalizedLineCount !== 0
    ) return false
    const record: AuthoritativeEmptyReceiptClaims = {
      schemaVersion: 'statement-authoritative-empty/v1',
      sourceIdentity: {
        partnerId: snapshot.partnerId,
        settlementMonth: snapshot.settlementMonth,
        sourceFile: snapshot.sourceFile,
        sourceSheet: snapshot.sourceSheet,
        templateFamily: snapshot.templateFamily as AuthoritativeEmptyReceiptClaims['sourceIdentity']['templateFamily'],
      },
      coverage,
      canonicalContentHash: snapshot.sourceHash,
      parserRevision: snapshot.parserRevision,
      configRevision: snapshot.configRevision,
      expectedGenerationId: snapshot.generationId,
      verifiedAt: snapshot.emptyVerifiedAt,
      expiresAt: snapshot.emptyExpiresAt,
      verifiedBy: snapshot.emptyVerifiedBy,
    }
    return computeAuthoritativeEmptyEvidenceHash(record) === snapshot.emptyEvidenceHash
  } catch {
    return false
  }
}

export function classifyStatementReadiness(
  snapshot: StatementReadinessSnapshot,
): SourceReadinessResult<{ raw_rows: number; normalized_lines: number }> {
  const base = {
    source: snapshot.source,
    partner_id: snapshot.partnerId,
    settlement_month: snapshot.settlementMonth,
    generation_id: snapshot.generationId,
    observed_at: snapshot.observedAt,
    required: true,
  } as const
  if (snapshot.status === 'error') {
    return { ...base, state: 'error', reason_code: 'STATEMENT_GENERATION_ERROR' }
  }
  if (snapshot.status === 'unavailable') {
    return { ...base, state: 'unavailable', reason_code: 'STATEMENT_GENERATION_UNAVAILABLE' }
  }
  if (!snapshot.current) {
    return { ...base, state: 'stale', reason_code: 'SUPERSEDED_GENERATION' }
  }
  if (
    snapshot.expectedRawRows !== snapshot.actualRawRows
    || snapshot.expectedNormalizedLines !== snapshot.actualNormalizedLines
  ) {
    return { ...base, state: 'partial', reason_code: 'FACT_COUNT_MISMATCH' }
  }
  const data = {
    raw_rows: snapshot.actualRawRows,
    normalized_lines: snapshot.actualNormalizedLines,
  }
  if (snapshot.actualRawRows === 0 && snapshot.actualNormalizedLines === 0) {
    if (!hasValidAuthoritativeEmptyEvidence(snapshot)) {
      return {
        ...base,
        state: 'unavailable',
        reason_code: 'AUTHORITATIVE_EMPTY_EVIDENCE_MISSING_OR_INVALID',
      }
    }
    return {
      ...base,
      state: 'complete_empty',
      reason_code: 'AUTHORITATIVE_EMPTY_IMPORT',
      data,
      totals: { raw_rows: 0, normalized_lines: 0 },
    }
  }
  return {
    ...base,
    state: 'complete',
    reason_code: 'STATEMENT_FACTS_COMPLETE',
    data,
    totals: data,
  }
}

export function readStatementSourceReadiness(
  db: any,
  partnerId: string,
  settlementMonth: string,
  generationId: string,
): SourceReadinessResult<{ raw_rows: number; normalized_lines: number }> {
  const batch = db.prepare(`
    SELECT * FROM statement_import_batches
    WHERE partner_id = ? AND settlement_month = ? AND generation_id = ?
  `).get(partnerId, settlementMonth, generationId) as any
  if (!batch) throw new Phase1AError('GENERATION_NOT_FOUND', generationId, 404)
  const raw = db.prepare(`
    SELECT COUNT(*) count FROM statement_raw_rows WHERE generation_id = ?
  `).get(generationId) as any
  const normalized = db.prepare(`
    SELECT COUNT(*) count FROM statement_normalized_lines WHERE generation_id = ?
  `).get(generationId) as any
  return classifyStatementReadiness({
    source: 'statement',
    partnerId,
    settlementMonth,
    generationId,
    observedAt: String(batch.updated_at),
    expectedRawRows: Number(batch.raw_row_count),
    actualRawRows: Number(raw.count),
    expectedNormalizedLines: Number(batch.normalized_line_count),
    actualNormalizedLines: Number(normalized.count),
    current: Boolean(batch.is_current),
    status: String(batch.status),
    sourceFile: batch.source_file ?? null,
    sourceSheet: batch.source_sheet ?? null,
    sourceHash: batch.source_hash ?? null,
    templateFamily: batch.template_family ?? null,
    emptyEvidenceHash: batch.empty_evidence_hash ?? null,
    emptyVerifiedBy: batch.empty_verified_by ?? null,
    emptyVerifiedAt: batch.empty_verified_at ?? null,
    emptyExpiresAt: batch.empty_expires_at ?? null,
    emptyCoverageJson: batch.empty_coverage_json ?? null,
    parserRevision: batch.parser_revision ?? null,
    configRevision: batch.config_revision ?? null,
  })
}

export function readAuxiliarySourceReadiness(
  source: 'lis' | 'revenue',
  partnerId: string,
  settlementMonth: string,
  generationId: string,
): SourceReadinessResult {
  return {
    source,
    partner_id: partnerId,
    settlement_month: settlementMonth,
    generation_id: generationId,
    state: 'unavailable',
    observed_at: new Date(0).toISOString(),
    reason_code: 'MANIFEST_NOT_CONNECTED',
    required: false,
  }
}
