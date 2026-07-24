import { buildCanonicalStatementArtifact, type CanonicalStatementArtifact } from './statement-canonical-artifact.js'
import { Phase1AError } from './statement-normalized-lines.js'
import {
  readAuxiliarySourceReadiness,
  readStatementSourceReadiness,
  type SourceReadinessResult,
} from './statement-source-readiness.js'

export interface StatementMonthResult {
  partnerId: string
  settlementMonth: string
  generationId: string
  status: string
  artifact: CanonicalStatementArtifact
  canonicalJson: string
  artifactHash: string
  readiness: SourceReadinessResult[]
}

function loadBatch(db: any, partnerId: string, settlementMonth: string, generationId: string): any {
  const batch = db.prepare(`
    SELECT * FROM statement_import_batches
    WHERE partner_id = ? AND settlement_month = ? AND generation_id = ?
  `).get(partnerId, settlementMonth, generationId) as any
  if (!batch) throw new Phase1AError('GENERATION_NOT_FOUND', generationId, 404)
  return batch
}

function assertReadyForIrreversibleAction(
  db: any,
  partnerId: string,
  settlementMonth: string,
  generationId: string,
): SourceReadinessResult[] {
  const statement = readStatementSourceReadiness(db, partnerId, settlementMonth, generationId)
  if (!['complete', 'complete_empty'].includes(statement.state)) {
    throw new Phase1AError('STATEMENT_SOURCE_NOT_COMPLETE', statement.reason_code)
  }
  const blocking = db.prepare(`
    SELECT flag_type, reason_code FROM quality_flags
    WHERE generation_id = ? AND blocks_closing = 1
    ORDER BY flag_type LIMIT 1
  `).get(generationId) as any
  if (blocking) {
    throw new Phase1AError('BLOCKING_QUALITY_FLAGS', `${blocking.flag_type}:${blocking.reason_code}`)
  }
  return [
    statement,
    readAuxiliarySourceReadiness('lis', partnerId, settlementMonth, generationId),
    readAuxiliarySourceReadiness('revenue', partnerId, settlementMonth, generationId),
  ]
}

function buildResult(
  db: any,
  partnerId: string,
  settlementMonth: string,
  generationId: string,
  status: string,
  readiness: SourceReadinessResult[],
): StatementMonthResult {
  const artifact = buildCanonicalStatementArtifact(db, generationId)
  return {
    partnerId,
    settlementMonth,
    generationId,
    status,
    artifact: artifact.artifact,
    canonicalJson: artifact.canonicalJson,
    artifactHash: artifact.artifactHash,
    readiness,
  }
}

export function computeStatementMonth(
  db: any,
  partnerId: string,
  settlementMonth: string,
  generationId: string,
): StatementMonthResult {
  const batch = loadBatch(db, partnerId, settlementMonth, generationId)
  if (batch.status === 'closed') throw new Phase1AError('GENERATION_CLOSED', generationId)
  if (!batch.is_current) throw new Phase1AError('STALE_GENERATION', generationId)
  if (!['posted', 'computed'].includes(batch.status)) {
    throw new Phase1AError('GENERATION_NOT_POSTED', String(batch.status))
  }
  const readiness = assertReadyForIrreversibleAction(db, partnerId, settlementMonth, generationId)
  const artifact = buildCanonicalStatementArtifact(db, generationId)
  db.prepare(`
    UPDATE statement_import_batches
    SET status = 'computed', artifact_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE generation_id = ? AND status IN ('posted', 'computed')
  `).run(artifact.artifactHash, generationId)
  return {
    partnerId,
    settlementMonth,
    generationId,
    status: 'computed',
    artifact: artifact.artifact,
    canonicalJson: artifact.canonicalJson,
    artifactHash: artifact.artifactHash,
    readiness,
  }
}

export function readStatementMonth(
  db: any,
  partnerId: string,
  settlementMonth: string,
  generationId: string,
): StatementMonthResult {
  const batch = loadBatch(db, partnerId, settlementMonth, generationId)
  const readiness = [
    readStatementSourceReadiness(db, partnerId, settlementMonth, generationId),
    readAuxiliarySourceReadiness('lis', partnerId, settlementMonth, generationId),
    readAuxiliarySourceReadiness('revenue', partnerId, settlementMonth, generationId),
  ]
  const result = buildResult(db, partnerId, settlementMonth, generationId, batch.status, readiness)
  if (batch.artifact_hash && batch.artifact_hash !== result.artifactHash) {
    throw new Phase1AError('ARTIFACT_HASH_MISMATCH', generationId)
  }
  return result
}

export function completeStatementMonth(
  db: any,
  partnerId: string,
  settlementMonth: string,
  generationId: string,
  actor: string,
): StatementMonthResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const batch = loadBatch(db, partnerId, settlementMonth, generationId)
    if (batch.status === 'closed') throw new Phase1AError('GENERATION_CLOSED', generationId)
    if (batch.status !== 'computed') throw new Phase1AError('GENERATION_NOT_COMPUTED', String(batch.status))
    const readiness = assertReadyForIrreversibleAction(db, partnerId, settlementMonth, generationId)
    const artifact = buildCanonicalStatementArtifact(db, generationId)
    if (batch.artifact_hash !== artifact.artifactHash) {
      throw new Phase1AError('ARTIFACT_HASH_MISMATCH', generationId)
    }
    const result = db.prepare(`
      UPDATE statement_import_batches
      SET status = 'complete', completed_at = CURRENT_TIMESTAMP, completed_by = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE generation_id = ? AND status = 'computed' AND artifact_hash = ?
    `).run(actor, generationId, artifact.artifactHash)
    if (Number(result.changes) !== 1) throw new Phase1AError('GENERATION_STATE_CONFLICT', generationId)
    const completedArtifact = buildCanonicalStatementArtifact(db, generationId)
    const hashUpdate = db.prepare(`
      UPDATE statement_import_batches
      SET artifact_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE generation_id = ? AND status = 'complete' AND artifact_hash = ?
    `).run(completedArtifact.artifactHash, generationId, artifact.artifactHash)
    if (Number(hashUpdate.changes) !== 1) throw new Phase1AError('GENERATION_STATE_CONFLICT', generationId)
    db.exec('COMMIT')
    return buildResult(db, partnerId, settlementMonth, generationId, 'complete', readiness)
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}

export function closeStatementMonth(
  db: any,
  partnerId: string,
  settlementMonth: string,
  generationId: string,
  actor: string,
): StatementMonthResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const batch = loadBatch(db, partnerId, settlementMonth, generationId)
    if (batch.status === 'closed') throw new Phase1AError('GENERATION_CLOSED', generationId)
    if (batch.status !== 'complete') throw new Phase1AError('GENERATION_NOT_COMPLETE', String(batch.status))
    const readiness = assertReadyForIrreversibleAction(db, partnerId, settlementMonth, generationId)
    const artifact = buildCanonicalStatementArtifact(db, generationId)
    if (batch.artifact_hash !== artifact.artifactHash) {
      throw new Phase1AError('ARTIFACT_HASH_MISMATCH', generationId)
    }
    const result = db.prepare(`
      UPDATE statement_import_batches
      SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE generation_id = ? AND status = 'complete' AND artifact_hash = ?
    `).run(actor, generationId, artifact.artifactHash)
    if (Number(result.changes) !== 1) throw new Phase1AError('GENERATION_STATE_CONFLICT', generationId)
    db.exec('COMMIT')
    return buildResult(db, partnerId, settlementMonth, generationId, 'closed', readiness)
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}
