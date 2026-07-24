import { createHash } from 'node:crypto'
import { Phase1AError } from './statement-normalized-lines.js'

export interface StatementPostResult {
  generationId: string
  status: 'posted'
  partnerRevenueRows: number
  outSettlementRows: number
  inAmount: number
  outAmount: number
  ledgerScope: 'statement_internal'
  pnlBridgeStatus: 'not_integrated'
}

function ledgerId(prefix: string, generationId: string, sourceLineId: string): string {
  return `${prefix}-${createHash('sha256').update(`${generationId}\u001f${sourceLineId}`).digest('hex').slice(0, 32)}`
}

const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000

export function postStatementGeneration(db: any, generationId: string): StatementPostResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const batch = db.prepare(`
      SELECT * FROM statement_import_batches WHERE generation_id = ?
    `).get(generationId) as any
    if (!batch) throw new Phase1AError('GENERATION_NOT_FOUND', generationId, 404)
    if (batch.status === 'closed') throw new Phase1AError('GENERATION_CLOSED', generationId)
    if (!batch.is_current) throw new Phase1AError('STALE_GENERATION', generationId)

    const blocking = db.prepare(`
      SELECT flag_type, reason_code FROM quality_flags
      WHERE generation_id = ? AND blocks_posting = 1
      ORDER BY flag_type LIMIT 1
    `).get(generationId) as any
    if (blocking) {
      throw new Phase1AError(
        'BLOCKING_QUALITY_FLAGS',
        `${blocking.flag_type}:${blocking.reason_code}`,
        409,
      )
    }

    const lines = db.prepare(`
      SELECT * FROM statement_normalized_lines
      WHERE generation_id = ? AND row_kind = 'detail'
      ORDER BY source_row, source_column, id
    `).all(generationId) as any[]
    const insertPartner = db.prepare(`
      INSERT OR IGNORE INTO partner_month_revenue_ledger (
        id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
        category_label, business_line, settlement_amount, ledger_scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN', ?, 'statement_internal')
    `)
    const insertOut = db.prepare(`
      INSERT OR IGNORE INTO out_settlement_ledger (
        id, batch_id, generation_id, partner_id, settlement_month, source_line_id,
        out_type, item_name, external_subject_key, settlement_amount,
        lab_revenue_amount, ledger_scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'statement_internal')
    `)
    for (const line of lines) {
      const amount = Number(line.amount)
      if (!Number.isFinite(amount)) throw new Phase1AError('INVALID_FINANCIAL_AMOUNT', line.id, 422)
      if (amount === 0) continue
      if (line.business_line === 'IN' && line.line_grain === 'aggregate') {
        insertPartner.run(
          ledgerId('PML', generationId, line.id),
          batch.id,
          generationId,
          batch.partner_id,
          line.row_settlement_month ?? batch.settlement_month,
          line.id,
          line.item_name ?? null,
          amount,
        )
      } else if (line.business_line === 'OUT') {
        insertOut.run(
          ledgerId('OUT', generationId, line.id),
          batch.id,
          generationId,
          batch.partner_id,
          line.row_settlement_month ?? batch.settlement_month,
          line.id,
          line.rule_id ?? 'statement_out',
          line.item_name ?? null,
          line.external_subject_key ?? null,
          amount,
        )
      }
    }

    db.prepare(`
      UPDATE statement_import_batches
      SET status = CASE WHEN status IN ('parsed', 'posted') THEN 'posted' ELSE status END,
          updated_at = CURRENT_TIMESTAMP
      WHERE generation_id = ? AND status <> 'closed'
    `).run(generationId)

    const partner = db.prepare(`
      SELECT COUNT(*) rows, COALESCE(SUM(settlement_amount), 0) amount
      FROM partner_month_revenue_ledger WHERE generation_id = ?
    `).get(generationId) as any
    const out = db.prepare(`
      SELECT COUNT(*) rows, COALESCE(SUM(settlement_amount), 0) amount
      FROM out_settlement_ledger WHERE generation_id = ?
    `).get(generationId) as any
    db.exec('COMMIT')
    return {
      generationId,
      status: 'posted',
      partnerRevenueRows: Number(partner.rows),
      outSettlementRows: Number(out.rows),
      inAmount: round4(Number(partner.amount)),
      outAmount: round4(Number(out.amount)),
      ledgerScope: 'statement_internal',
      pnlBridgeStatus: 'not_integrated',
    }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}
