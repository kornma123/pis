import { createHash } from 'node:crypto'
import { Phase1AError } from './statement-normalized-lines.js'

export interface CanonicalStatementArtifact {
  generation_id: string
  settlement_month: string
  partner_id: string
  partner_name: string | null
  batch_id: string
  source_file: string | null
  template_family: string
  declared_total: number | null
  parsed_total: number
  in_amount: number
  out_amount: number
  adjustment_amount: 0
  unknown_amount: number
  cost_pending_amount: null
  lis_pending_count: null
  quality_flags: Array<{
    flag_type: string
    severity: string
    blocks_posting: number
    blocks_closing: number
    reason_code: string
  }>
  parser_revision: string
  config_revision: string
  ledger_scope: 'statement_internal'
  pnl_bridge_status: 'not_integrated'
  confirmed_by: string | null
  confirmed_at: string | null
  confirmation_note: null
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]))
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000

export function buildCanonicalStatementArtifact(
  db: any,
  generationId: string,
): { artifact: CanonicalStatementArtifact; canonicalJson: string; artifactHash: string } {
  const batch = db.prepare(`
    SELECT * FROM statement_import_batches WHERE generation_id = ?
  `).get(generationId) as any
  if (!batch) throw new Phase1AError('GENERATION_NOT_FOUND', generationId, 404)

  const parsed = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN row_kind = 'detail' THEN amount ELSE 0 END), 0) parsed,
      COALESCE(SUM(CASE WHEN row_kind = 'detail' AND business_line = 'UNKNOWN' THEN amount ELSE 0 END), 0) unknown
    FROM statement_normalized_lines WHERE generation_id = ?
  `).get(generationId) as any
  const partner = db.prepare(`
    SELECT COALESCE(SUM(settlement_amount), 0) amount
    FROM partner_month_revenue_ledger WHERE generation_id = ?
  `).get(generationId) as any
  const out = db.prepare(`
    SELECT COALESCE(SUM(settlement_amount), 0) amount
    FROM out_settlement_ledger WHERE generation_id = ?
  `).get(generationId) as any
  const flags = db.prepare(`
    SELECT flag_type, severity, blocks_posting, blocks_closing, reason_code
    FROM quality_flags WHERE generation_id = ?
    ORDER BY flag_type, reason_code, id
  `).all(generationId) as any[]

  const artifact: CanonicalStatementArtifact = {
    generation_id: generationId,
    settlement_month: batch.settlement_month,
    partner_id: batch.partner_id,
    partner_name: batch.partner_name ?? null,
    batch_id: batch.id,
    source_file: batch.source_file ?? null,
    template_family: batch.template_family,
    declared_total: batch.declared_total === null ? null : round4(Number(batch.declared_total)),
    parsed_total: round4(Number(parsed.parsed)),
    in_amount: round4(Number(partner.amount)),
    out_amount: round4(Number(out.amount)),
    adjustment_amount: 0,
    unknown_amount: round4(Number(parsed.unknown)),
    cost_pending_amount: null,
    lis_pending_count: null,
    quality_flags: flags.map(flag => ({
      flag_type: flag.flag_type,
      severity: flag.severity,
      blocks_posting: Number(flag.blocks_posting),
      blocks_closing: Number(flag.blocks_closing),
      reason_code: flag.reason_code,
    })),
    parser_revision: batch.parser_revision,
    config_revision: batch.config_revision,
    ledger_scope: 'statement_internal',
    pnl_bridge_status: 'not_integrated',
    confirmed_by: batch.completed_by ?? null,
    confirmed_at: batch.completed_at ?? null,
    confirmation_note: null,
  }
  const serialized = canonicalJson(artifact)
  return {
    artifact,
    canonicalJson: serialized,
    artifactHash: `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
  }
}
