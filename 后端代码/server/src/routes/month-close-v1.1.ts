import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { requireAnyRole } from '../middleware/permissions.js'
import { success, error } from '../utils/response.js'
import { Phase1AError } from '../services/statement-normalized-lines.js'
import {
  closeStatementMonth,
  completeStatementMonth,
  computeStatementMonth,
  readStatementMonth,
} from '../services/statement-month-close-phase1a.js'

const router = Router()
const requireFinance = requireAnyRole('finance')

function actor(req: any): string {
  return String(req.user?.username ?? req.user?.userId ?? '').trim()
}

function generation(req: any): string {
  return String(req.body?.generationId ?? req.query?.generationId ?? '').trim()
}

function respondError(res: any, caught: unknown): void {
  if (caught instanceof Phase1AError) {
    error(res, caught.message, caught.code, caught.httpStatus)
    return
  }
  const message = caught instanceof Error ? caught.message : 'Phase 1A month-close operation failed'
  error(res, message, 'PHASE1A_INTERNAL_ERROR', 500)
}

router.post('/:settlementMonth/partners/:partnerId/compute', requireFinance, (req, res) => {
  try {
    success(res, computeStatementMonth(
      getDatabase(),
      req.params.partnerId,
      req.params.settlementMonth,
      generation(req),
    ))
  } catch (caught) {
    respondError(res, caught)
  }
})

router.get('/:settlementMonth/partners/:partnerId/summary', requireFinance, (req, res) => {
  try {
    success(res, readStatementMonth(
      getDatabase(),
      req.params.partnerId,
      req.params.settlementMonth,
      generation(req),
    ))
  } catch (caught) {
    respondError(res, caught)
  }
})

router.post('/:settlementMonth/partners/:partnerId/complete', requireFinance, (req, res) => {
  try {
    const operator = actor(req)
    if (!operator) throw new Phase1AError('ACTOR_REQUIRED', 'Authenticated actor required', 400)
    success(res, completeStatementMonth(
      getDatabase(),
      req.params.partnerId,
      req.params.settlementMonth,
      generation(req),
      operator,
    ))
  } catch (caught) {
    respondError(res, caught)
  }
})

router.post('/:settlementMonth/partners/:partnerId/close', requireFinance, (req, res) => {
  try {
    const operator = actor(req)
    if (!operator) throw new Phase1AError('ACTOR_REQUIRED', 'Authenticated actor required', 400)
    success(res, closeStatementMonth(
      getDatabase(),
      req.params.partnerId,
      req.params.settlementMonth,
      generation(req),
      operator,
    ))
  } catch (caught) {
    respondError(res, caught)
  }
})

export default router
