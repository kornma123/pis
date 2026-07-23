import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { requireAnyRole } from '../middleware/permissions.js'
import { success, error } from '../utils/response.js'
import {
  buildStatementNormalizedFacts,
  importStatementBatch,
  Phase1AError,
  type StatementImportInput,
} from '../services/statement-normalized-lines.js'
import { postStatementGeneration } from '../services/statement-ledger-phase1a.js'

const router = Router()
const requireFinance = requireAnyRole('finance')
const trustedActor = (req: any): string =>
  String(req.user?.username ?? req.user?.userId ?? '').trim()

function respondError(res: any, caught: unknown): void {
  if (caught instanceof Phase1AError) {
    error(res, caught.message, caught.code, caught.httpStatus)
    return
  }
  const message = caught instanceof Error ? caught.message : 'Phase 1A statement operation failed'
  error(res, message, 'PHASE1A_INTERNAL_ERROR', 500)
}

router.post('/preview-normalized', requireFinance, (req, res) => {
  try {
    const actor = trustedActor(req)
    const input = { ...(req.body as StatementImportInput), uploadedBy: actor }
    const facts = buildStatementNormalizedFacts(input, { actor })
    success(res, {
      declaredTotal: facts.declaredTotal,
      parsedTotal: facts.parsedTotal,
      normalizedLines: facts.lines,
      qualityFlags: facts.flags,
      ledgerScope: 'statement_internal',
      pnlBridgeStatus: 'not_integrated',
    }, 'Phase 1A normalized preview; no facts persisted')
  } catch (caught) {
    respondError(res, caught)
  }
})

router.post('/', requireFinance, (req, res) => {
  try {
    const actor = trustedActor(req)
    const input = { ...(req.body as StatementImportInput), uploadedBy: actor }
    const result = importStatementBatch(getDatabase(), input, { actor })
    success(res, result, result.duplicate ? 'Existing generation returned idempotently' : 'Immutable statement generation created')
  } catch (caught) {
    respondError(res, caught)
  }
})

router.post('/:id/post', requireFinance, (req, res) => {
  try {
    const db = getDatabase()
    const batch = db.prepare('SELECT generation_id FROM statement_import_batches WHERE id = ?')
      .get(req.params.id) as any
    if (!batch) throw new Phase1AError('GENERATION_NOT_FOUND', req.params.id, 404)
    success(res, postStatementGeneration(db, batch.generation_id), 'Statement-internal ledgers posted')
  } catch (caught) {
    respondError(res, caught)
  }
})

router.get('/:id/quality-flags', requireFinance, (req, res) => {
  try {
    const db = getDatabase()
    const batch = db.prepare('SELECT generation_id FROM statement_import_batches WHERE id = ?')
      .get(req.params.id) as any
    if (!batch) throw new Phase1AError('GENERATION_NOT_FOUND', req.params.id, 404)
    const flags = db.prepare(`
      SELECT flag_type, severity, owner_role, resolution_action, blocks_posting,
             blocks_closing, reason_code, message, related_line_id, created_at
      FROM quality_flags WHERE generation_id = ?
      ORDER BY severity, flag_type, id
    `).all(batch.generation_id)
    success(res, { generationId: batch.generation_id, flags })
  } catch (caught) {
    respondError(res, caught)
  }
})

export default router
