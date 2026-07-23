import { Phase1AError } from './statement-normalized-lines.js'

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
