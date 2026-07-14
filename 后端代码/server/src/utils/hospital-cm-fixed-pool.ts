import { createHash, randomUUID } from 'node:crypto'
import { writeAuditLog } from './cost-runs.js'
import type { FixedPoolState } from './portfolio-health.js'

interface FixedPoolStatement {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => unknown
}

export interface HospitalCmFixedPoolDb {
  prepare: (sql: string) => FixedPoolStatement
  exec: (sql: string) => unknown
}

export const HOSPITAL_CM_FIXED_POOL_POLICY_VERSION = 'ADR-008.fixed-pool.v1'
export const FIXED_POOL_SCOPE_ATTESTATION = 'FIXED_ONLY_EXCLUDES_MATERIALS_AND_VARIABLE_COSTS'
export const FIXED_POOL_SOURCE_KIND = 'FINANCE_MONTHLY_FIXED_COST_LEDGER'

const SERVICE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const SHA256_RE = /^[a-fA-F0-9]{64}$/
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const CSV_FORMULA_PREFIX_RE = /^[\s]*[=+\-@]/

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

export class HospitalCmFixedPoolError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
    this.name = 'HospitalCmFixedPoolError'
  }
}

export interface HospitalCmFixedPoolActor {
  userId: string
  username: string
}

export interface HospitalCmFixedPoolVersion {
  id: string
  eventNumber: number
  serviceMonth: string
  versionNumber: number
  version: string
  amountMinor: number
  value: number
  currency: 'CNY'
  scopePolicyVersion: string
  scopeAttestation: string
  sourceKind: string
  sourceEvidenceRef: string
  sourceEvidenceHash: string
  contentHash: string
  supersedesVersionId: string | null
  changeReason: string
  createdByUserId: string
  createdByUsername: string
  createdAt: string
}

export type HospitalCmFixedPoolDecision = 'RATIFIED' | 'REVOKED'

export interface HospitalCmFixedPoolDecisionEvent {
  id: string
  eventNumber: number
  poolVersionId: string
  version: string
  contentHash: string
  decision: HospitalCmFixedPoolDecision
  evidenceRef: string
  evidenceHash: string
  reason: string
  decidedByUserId: string
  decidedByUsername: string
  ownerAssignmentRevision: number | null
  decidedAt: string
}

interface VersionRow {
  id: string
  eventNumber: number
  serviceMonth: string
  versionNumber: number
  amountMinor: number
  currency: 'CNY'
  scopePolicyVersion: string
  scopeAttestation: string
  sourceKind: string
  sourceEvidenceRef: string
  sourceEvidenceHash: string
  contentHash: string
  supersedesVersionId: string | null
  changeReason: string
  createdByUserId: string
  createdByUsername: string
  createdAt: string
}

interface DecisionRow {
  id: string
  eventNumber: number
  poolVersionId: string
  serviceMonth: string
  versionNumber: number
  contentHash: string
  decision: HospitalCmFixedPoolDecision
  evidenceRef: string
  evidenceHash: string
  reason: string
  decidedByUserId: string
  decidedByUsername: string
  ownerAssignmentRevision: number | null
  decidedAt: string
}

interface OwnerRow {
  ownerRole: string | null
  ownerUserId: string | null
  ownerName: string | null
  ownerAssignmentRevision: number | null
}

interface IdempotencyRow {
  actorUserId: string
  requestHash: string
  resultKind: 'VERSION' | 'DECISION'
  resultId: string
}

export interface HospitalCmFixedPoolRuntimeState extends FixedPoolState {
  serviceMonth: string
  amountMinor: number | null
  currency: 'CNY' | null
  versionId: string | null
  versionNumber: number | null
  contentHash: string | null
  currentDecision: HospitalCmFixedPoolDecision | null
  currentDecisionEventId: string | null
  invalidationCode:
    | 'NOT_CONFIGURED'
    | 'UNRATIFIED'
    | 'CURRENT_VERSION_UNRATIFIED'
    | 'RATIFICATION_REVOKED'
    | 'OWNER_UNASSIGNED'
    | 'OWNER_ROLE_INVALID'
    | 'OWNER_ASSIGNMENT_INVALID'
    | 'OWNER_INACTIVE'
    | 'OWNER_CHANGED'
    | 'POLICY_MISMATCH'
    | null
  policyCurrent: boolean
  ownerAssigned: boolean
  ownerActive: boolean
  ownerAssignmentRevision: number
  ratification: null | {
    eventId: string
    version: string
    decision: HospitalCmFixedPoolDecision
    evidenceRef: string
    evidenceHash: string
    reason: string
    decidedByUsername: string
    ownerAssignmentRevision: number | null
    decidedAt: string
  }
  stateFingerprint: string
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function versionLabel(serviceMonth: string, versionNumber: number): string {
  return `${serviceMonth}.v${versionNumber}`
}

function normalizeHash(value: unknown, code: string, fieldLabel: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!SHA256_RE.test(normalized)) throw new HospitalCmFixedPoolError(code, 400, `${fieldLabel}必须是 64 位 SHA-256`)
  return normalized
}

function requireText(
  value: unknown,
  opts: { code: string; label: string; max: number; rejectCsvFormula?: boolean },
): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > opts.max || containsControlCharacter(normalized)) {
    throw new HospitalCmFixedPoolError(opts.code, 400, `${opts.label}缺失、过长或含控制字符`)
  }
  if (opts.rejectCsvFormula && CSV_FORMULA_PREFIX_RE.test(normalized)) {
    throw new HospitalCmFixedPoolError(opts.code, 400, `${opts.label}不得以 CSV 公式字符开头`)
  }
  return normalized
}

function normalizeActor(actor: HospitalCmFixedPoolActor): HospitalCmFixedPoolActor {
  return {
    userId: requireText(actor?.userId, { code: 'FIXED_POOL_ACTOR_INVALID', label: '操作人 userId', max: 128 }),
    username: requireText(actor?.username, { code: 'FIXED_POOL_ACTOR_INVALID', label: '操作人用户名', max: 128 }),
  }
}

function normalizeServiceMonth(value: unknown): string {
  const month = typeof value === 'string' ? value.trim() : ''
  if (!SERVICE_MONTH_RE.test(month)) {
    throw new HospitalCmFixedPoolError('FIXED_POOL_SERVICE_MONTH_INVALID', 400, 'serviceMonth 必须是合法 YYYY-MM')
  }
  return month
}

export function isHospitalCmFixedPoolServiceMonth(value: unknown): value is string {
  return typeof value === 'string' && SERVICE_MONTH_RE.test(value)
}

function normalizeIdempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new HospitalCmFixedPoolError(
      'FIXED_POOL_IDEMPOTENCY_KEY_INVALID',
      400,
      'Idempotency-Key 必填，且必须为 8~128 位安全字符',
    )
  }
  return key
}

function versionFromRow(row: VersionRow): HospitalCmFixedPoolVersion {
  return {
    ...row,
    version: versionLabel(row.serviceMonth, Number(row.versionNumber)),
    amountMinor: Number(row.amountMinor),
    value: Number(row.amountMinor) / 100,
    versionNumber: Number(row.versionNumber),
    eventNumber: Number(row.eventNumber),
  }
}

function validOwnerAssignmentRevision(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null
  return value
}

function decisionFromRow(row: DecisionRow): HospitalCmFixedPoolDecisionEvent {
  return {
    id: row.id,
    eventNumber: Number(row.eventNumber),
    poolVersionId: row.poolVersionId,
    version: versionLabel(row.serviceMonth, Number(row.versionNumber)),
    contentHash: row.contentHash,
    decision: row.decision,
    evidenceRef: row.evidenceRef,
    evidenceHash: row.evidenceHash,
    reason: row.reason,
    decidedByUserId: row.decidedByUserId,
    decidedByUsername: row.decidedByUsername,
    // 旧候选表补列后可能是 NULL；保留为无效证据，不能 Number(NULL) 伪装成 revision 0。
    ownerAssignmentRevision: validOwnerAssignmentRevision(row.ownerAssignmentRevision),
    decidedAt: row.decidedAt,
  }
}

const VERSION_SELECT = `
  SELECT event_number AS eventNumber,
         id,
         service_month AS serviceMonth,
         version_no AS versionNumber,
         amount_minor AS amountMinor,
         currency,
         scope_policy_version AS scopePolicyVersion,
         scope_attestation AS scopeAttestation,
         source_kind AS sourceKind,
         source_evidence_ref AS sourceEvidenceRef,
         source_evidence_hash AS sourceEvidenceHash,
         content_hash AS contentHash,
         supersedes_version_id AS supersedesVersionId,
         change_reason AS changeReason,
         created_by_user_id AS createdByUserId,
         created_by_username AS createdByUsername,
         created_at AS createdAt
  FROM hospital_cm_fixed_pool_versions
`

const DECISION_SELECT = `
  SELECT event.event_number AS eventNumber,
         event.id,
         event.pool_version_id AS poolVersionId,
         version.service_month AS serviceMonth,
         version.version_no AS versionNumber,
         event.pool_content_hash AS contentHash,
         event.decision,
         event.evidence_ref AS evidenceRef,
         event.evidence_hash AS evidenceHash,
         event.decision_reason AS reason,
         event.decided_by_user_id AS decidedByUserId,
         event.decided_by_username AS decidedByUsername,
         event.owner_assignment_revision AS ownerAssignmentRevision,
         event.decided_at AS decidedAt
  FROM hospital_cm_fixed_pool_ratification_events AS event
  INNER JOIN hospital_cm_fixed_pool_versions AS version ON version.id = event.pool_version_id
`

export function ensureHospitalCmFixedPoolSchema(db: HospitalCmFixedPoolDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hospital_cm_fixed_pool_versions (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      service_month TEXT NOT NULL CHECK (
        LENGTH(service_month) = 7
        AND service_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
        AND CAST(SUBSTR(service_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      ),
      version_no INTEGER NOT NULL CHECK (version_no >= 1),
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
      currency TEXT NOT NULL CHECK (currency = 'CNY'),
      scope_policy_version TEXT NOT NULL CHECK (LENGTH(TRIM(scope_policy_version)) > 0),
      scope_attestation TEXT NOT NULL CHECK (LENGTH(TRIM(scope_attestation)) > 0),
      source_kind TEXT NOT NULL CHECK (LENGTH(TRIM(source_kind)) > 0),
      source_evidence_ref TEXT NOT NULL CHECK (LENGTH(TRIM(source_evidence_ref)) > 0),
      source_evidence_hash TEXT NOT NULL CHECK (
        LENGTH(source_evidence_hash) = 64 AND source_evidence_hash NOT GLOB '*[^0-9A-Fa-f]*'
      ),
      content_hash TEXT NOT NULL CHECK (
        LENGTH(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9A-Fa-f]*'
      ),
      supersedes_version_id TEXT,
      change_reason TEXT NOT NULL CHECK (LENGTH(TRIM(change_reason)) > 0),
      created_by_user_id TEXT NOT NULL CHECK (LENGTH(TRIM(created_by_user_id)) > 0),
      created_by_username TEXT NOT NULL CHECK (LENGTH(TRIM(created_by_username)) > 0),
      created_at TEXT NOT NULL,
      UNIQUE (service_month, version_no),
      FOREIGN KEY (supersedes_version_id) REFERENCES hospital_cm_fixed_pool_versions(id)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_fixed_pool_ratification_events (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      pool_version_id TEXT NOT NULL,
      pool_content_hash TEXT NOT NULL CHECK (
        LENGTH(pool_content_hash) = 64 AND pool_content_hash NOT GLOB '*[^0-9A-Fa-f]*'
      ),
      decision TEXT NOT NULL CHECK (decision IN ('RATIFIED','REVOKED')),
      evidence_ref TEXT NOT NULL CHECK (LENGTH(TRIM(evidence_ref)) > 0),
      evidence_hash TEXT NOT NULL CHECK (
        LENGTH(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9A-Fa-f]*'
      ),
      decision_reason TEXT NOT NULL CHECK (LENGTH(TRIM(decision_reason)) > 0),
      decided_by_user_id TEXT NOT NULL CHECK (LENGTH(TRIM(decided_by_user_id)) > 0),
      decided_by_username TEXT NOT NULL CHECK (LENGTH(TRIM(decided_by_username)) > 0),
      owner_assignment_revision INTEGER NOT NULL CHECK (owner_assignment_revision >= 1),
      decided_at TEXT NOT NULL,
      FOREIGN KEY (pool_version_id) REFERENCES hospital_cm_fixed_pool_versions(id)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_fixed_pool_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK (
        LENGTH(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9A-Fa-f]*'
      ),
      operation TEXT NOT NULL,
      result_kind TEXT NOT NULL CHECK (result_kind IN ('VERSION','DECISION')),
      result_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hcm_fixed_pool_versions_month_current
      ON hospital_cm_fixed_pool_versions(service_month, version_no DESC);
    CREATE INDEX IF NOT EXISTS idx_hcm_fixed_pool_decisions_version_latest
      ON hospital_cm_fixed_pool_ratification_events(pool_version_id, event_number DESC);

    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_versions_no_update
      BEFORE UPDATE ON hospital_cm_fixed_pool_versions
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_VERSION_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_versions_no_delete
      BEFORE DELETE ON hospital_cm_fixed_pool_versions
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_VERSION_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_ratifications_no_update
      BEFORE UPDATE ON hospital_cm_fixed_pool_ratification_events
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_RATIFICATION_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_ratifications_no_delete
      BEFORE DELETE ON hospital_cm_fixed_pool_ratification_events
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_RATIFICATION_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_idempotency_no_update
      BEFORE UPDATE ON hospital_cm_fixed_pool_idempotency
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_IDEMPOTENCY_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_idempotency_no_delete
      BEFORE DELETE ON hospital_cm_fixed_pool_idempotency
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_IDEMPOTENCY_APPEND_ONLY'); END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_version_sequence_guard
      BEFORE INSERT ON hospital_cm_fixed_pool_versions
      WHEN NEW.version_no <> COALESCE((
             SELECT MAX(version_no) + 1
             FROM hospital_cm_fixed_pool_versions
             WHERE service_month = NEW.service_month
           ), 1)
        OR (NEW.version_no = 1 AND NEW.supersedes_version_id IS NOT NULL)
        OR (NEW.version_no > 1 AND NEW.supersedes_version_id IS NOT (
             SELECT id
             FROM hospital_cm_fixed_pool_versions
             WHERE service_month = NEW.service_month
             ORDER BY version_no DESC
             LIMIT 1
           ))
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_VERSION_SEQUENCE_INVALID'); END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_decision_version_guard
      BEFORE INSERT ON hospital_cm_fixed_pool_ratification_events
      WHEN NOT EXISTS (
             SELECT 1
             FROM hospital_cm_fixed_pool_versions
             WHERE id = NEW.pool_version_id AND content_hash = NEW.pool_content_hash
           )
        OR NEW.pool_version_id IS NOT (
             SELECT current.id
             FROM hospital_cm_fixed_pool_versions AS current
             WHERE current.service_month = (
               SELECT target.service_month
               FROM hospital_cm_fixed_pool_versions AS target
               WHERE target.id = NEW.pool_version_id
             )
             ORDER BY current.version_no DESC
             LIMIT 1
           )
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_DECISION_VERSION_INVALID'); END;

  `)

  // SQLite 的 INSERT OR REPLACE 会先走 INSERT，再删除冲突行；默认 recursive_triggers=OFF 时，
  // 仅有 UPDATE/DELETE guard 不足以保证 append-only。重复稳定键必须在 INSERT 阶段直接拒绝。
  db.exec(`
    DROP TRIGGER IF EXISTS trg_hcm_fixed_pool_versions_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_fixed_pool_ratifications_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_fixed_pool_idempotency_duplicate_guard;
    CREATE TRIGGER trg_hcm_fixed_pool_versions_duplicate_guard
      BEFORE INSERT ON hospital_cm_fixed_pool_versions
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_fixed_pool_versions
             WHERE id = NEW.id
                OR event_number = NEW.event_number
                OR (service_month = NEW.service_month AND version_no = NEW.version_no)
           )
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_VERSION_APPEND_ONLY'); END;
    CREATE TRIGGER trg_hcm_fixed_pool_ratifications_duplicate_guard
      BEFORE INSERT ON hospital_cm_fixed_pool_ratification_events
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_fixed_pool_ratification_events
             WHERE id = NEW.id OR event_number = NEW.event_number
           )
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_RATIFICATION_APPEND_ONLY'); END;
    CREATE TRIGGER trg_hcm_fixed_pool_idempotency_duplicate_guard
      BEFORE INSERT ON hospital_cm_fixed_pool_idempotency
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_fixed_pool_idempotency
             WHERE idempotency_key = NEW.idempotency_key
           )
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_IDEMPOTENCY_APPEND_ONLY'); END;
  `)

  // 本表在 B 中新增；仍保留幂等前向补列，旧事件无 revision 时永久 fail-closed。
  const ratificationColumns = db.prepare('PRAGMA table_info(hospital_cm_fixed_pool_ratification_events)').all() as Array<{ name: string }>
  if (!ratificationColumns.some((column) => column.name === 'owner_assignment_revision')) {
    db.exec('ALTER TABLE hospital_cm_fixed_pool_ratification_events ADD COLUMN owner_assignment_revision INTEGER')
  }

  // owner 身份与“哪一次指派”同时绑定；A→B→A 不得让旧签字复活。
  db.exec(`
    DROP TRIGGER IF EXISTS trg_hcm_fixed_pool_decision_owner_guard;
    DROP TRIGGER IF EXISTS trg_hcm_fixed_pool_decision_transition_guard;
    CREATE TRIGGER trg_hcm_fixed_pool_decision_owner_guard
      BEFORE INSERT ON hospital_cm_fixed_pool_ratification_events
      WHEN NEW.owner_assignment_revision IS NULL
        OR TYPEOF(NEW.owner_assignment_revision) <> 'integer'
        OR NEW.owner_assignment_revision < 1
        OR COALESCE((
             SELECT owner_role
             FROM hospital_cm_readiness_milestones
             WHERE condition_key = 'denominator'
           ), '') <> 'business'
        OR COALESCE((
             SELECT owner_user_id
             FROM hospital_cm_readiness_milestones
             WHERE condition_key = 'denominator'
           ), '') <> NEW.decided_by_user_id
        OR COALESCE((
             SELECT owner_assignment_revision
             FROM hospital_cm_readiness_milestones
             WHERE condition_key = 'denominator'
           ), -1) <> NEW.owner_assignment_revision
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_RATIFIER_NOT_CURRENT_OWNER_ASSIGNMENT'); END;

    CREATE TRIGGER trg_hcm_fixed_pool_decision_transition_guard
      BEFORE INSERT ON hospital_cm_fixed_pool_ratification_events
      WHEN (NEW.decision = 'RATIFIED' AND COALESCE((
              SELECT decision
              FROM hospital_cm_fixed_pool_ratification_events
              WHERE pool_version_id = NEW.pool_version_id
              ORDER BY event_number DESC
              LIMIT 1
            ), '') = 'RATIFIED' AND COALESCE((
              SELECT owner_assignment_revision
              FROM hospital_cm_fixed_pool_ratification_events
              WHERE pool_version_id = NEW.pool_version_id
              ORDER BY event_number DESC
              LIMIT 1
            ), -1) = NEW.owner_assignment_revision)
        OR (NEW.decision = 'REVOKED' AND COALESCE((
              SELECT decision
              FROM hospital_cm_fixed_pool_ratification_events
              WHERE pool_version_id = NEW.pool_version_id
              ORDER BY event_number DESC
              LIMIT 1
            ), '') <> 'RATIFIED')
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_DECISION_TRANSITION_INVALID'); END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_fixed_pool_idempotency_result_guard
      BEFORE INSERT ON hospital_cm_fixed_pool_idempotency
      WHEN (NEW.result_kind = 'VERSION' AND NOT EXISTS (
              SELECT 1 FROM hospital_cm_fixed_pool_versions WHERE id = NEW.result_id
            ))
        OR (NEW.result_kind = 'DECISION' AND NOT EXISTS (
              SELECT 1 FROM hospital_cm_fixed_pool_ratification_events WHERE id = NEW.result_id
            ))
      BEGIN SELECT RAISE(ABORT, 'FIXED_POOL_IDEMPOTENCY_RESULT_INVALID'); END;
  `)
}

function readOwner(db: HospitalCmFixedPoolDb): OwnerRow {
  const row = db.prepare(`
    SELECT owner_role AS ownerRole,
           owner_user_id AS ownerUserId,
           owner_name AS ownerName,
           owner_assignment_revision AS ownerAssignmentRevision
    FROM hospital_cm_readiness_milestones
    WHERE condition_key = 'denominator'
  `).get() as OwnerRow | undefined
  return row ?? { ownerRole: null, ownerUserId: null, ownerName: null, ownerAssignmentRevision: null }
}

function ownerIsActive(db: HospitalCmFixedPoolDb, ownerUserId: string | null): boolean {
  if (!ownerUserId) return false
  try {
    const row = db.prepare(`
      SELECT 1 AS ok
      FROM users
      WHERE id = ? AND status = 1 AND is_deleted = 0
    `).get(ownerUserId) as { ok?: number } | undefined
    return row?.ok === 1
  } catch {
    return false
  }
}

function readVersionById(db: HospitalCmFixedPoolDb, id: string): HospitalCmFixedPoolVersion | null {
  const row = db.prepare(`${VERSION_SELECT} WHERE id = ?`).get(id) as VersionRow | undefined
  return row ? versionFromRow(row) : null
}

function readDecisionById(db: HospitalCmFixedPoolDb, id: string): HospitalCmFixedPoolDecisionEvent | null {
  const row = db.prepare(`${DECISION_SELECT} WHERE event.id = ?`).get(id) as DecisionRow | undefined
  return row ? decisionFromRow(row) : null
}

function readIdempotentResult(
  db: HospitalCmFixedPoolDb,
  key: string,
  actorUserId: string,
  requestHash: string,
  resultKind: IdempotencyRow['resultKind'],
): HospitalCmFixedPoolVersion | HospitalCmFixedPoolDecisionEvent | null {
  const existing = db.prepare(`
    SELECT actor_user_id AS actorUserId,
           request_hash AS requestHash,
           result_kind AS resultKind,
           result_id AS resultId
    FROM hospital_cm_fixed_pool_idempotency
    WHERE idempotency_key = ?
  `).get(key) as IdempotencyRow | undefined
  if (!existing) return null
  if (
    existing.actorUserId !== actorUserId
    || existing.requestHash !== requestHash
    || existing.resultKind !== resultKind
  ) {
    throw new HospitalCmFixedPoolError(
      'FIXED_POOL_IDEMPOTENCY_CONFLICT',
      409,
      '该 Idempotency-Key 已绑定另一操作人或请求内容',
    )
  }
  const result = resultKind === 'VERSION'
    ? readVersionById(db, existing.resultId)
    : readDecisionById(db, existing.resultId)
  if (!result) {
    throw new HospitalCmFixedPoolError('FIXED_POOL_IDEMPOTENCY_RESULT_MISSING', 409, '幂等记录对应的业务事件缺失')
  }
  return result
}

function saveIdempotentResult(
  db: HospitalCmFixedPoolDb,
  input: {
    key: string
    actorUserId: string
    requestHash: string
    operation: string
    resultKind: IdempotencyRow['resultKind']
    resultId: string
    createdAt: string
  },
): void {
  db.prepare(`
    INSERT INTO hospital_cm_fixed_pool_idempotency
      (idempotency_key, actor_user_id, request_hash, operation, result_kind, result_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.key,
    input.actorUserId,
    input.requestHash,
    input.operation,
    input.resultKind,
    input.resultId,
    input.createdAt,
  )
}

function rollbackQuietly(db: HospitalCmFixedPoolDb): void {
  try { db.exec('ROLLBACK') } catch { /* transaction may already be closed */ }
}

export function createHospitalCmFixedPoolVersion(
  db: HospitalCmFixedPoolDb,
  raw: {
    serviceMonth: unknown
    amountMinor: unknown
    currency: unknown
    scopeAttestation: unknown
    sourceEvidenceRef: unknown
    sourceEvidenceHash: unknown
    changeReason: unknown
    actor: HospitalCmFixedPoolActor
    idempotencyKey: unknown
  },
): HospitalCmFixedPoolVersion {
  const serviceMonth = normalizeServiceMonth(raw.serviceMonth)
  if (!Number.isSafeInteger(raw.amountMinor) || Number(raw.amountMinor) <= 0) {
    throw new HospitalCmFixedPoolError('FIXED_POOL_AMOUNT_INVALID', 400, 'amountMinor 必须是正的 JavaScript 安全整数分')
  }
  if (raw.currency !== 'CNY') {
    throw new HospitalCmFixedPoolError('FIXED_POOL_CURRENCY_INVALID', 400, '固定成本池当前仅接受 CNY，不做隐式汇率换算')
  }
  if (raw.scopeAttestation !== FIXED_POOL_SCOPE_ATTESTATION) {
    throw new HospitalCmFixedPoolError(
      'FIXED_POOL_SCOPE_ATTESTATION_INVALID',
      400,
      '必须明确确认本池排除材料、外包/加班/计件人力及其他可变成本',
    )
  }
  const sourceEvidenceRef = requireText(raw.sourceEvidenceRef, {
    code: 'FIXED_POOL_SOURCE_EVIDENCE_INVALID', label: '来源 manifest 引用', max: 512, rejectCsvFormula: true,
  })
  const sourceEvidenceHash = normalizeHash(raw.sourceEvidenceHash, 'FIXED_POOL_SOURCE_EVIDENCE_INVALID', '来源 manifest hash')
  const changeReason = requireText(raw.changeReason, {
    code: 'FIXED_POOL_CHANGE_REASON_INVALID', label: '变更原因', max: 500, rejectCsvFormula: true,
  })
  const actor = normalizeActor(raw.actor)
  const idempotencyKey = normalizeIdempotencyKey(raw.idempotencyKey)
  const amountMinor = Number(raw.amountMinor)
  const requestHash = sha256({
    operation: 'CREATE_VERSION', actorUserId: actor.userId, serviceMonth, amountMinor,
    currency: 'CNY', scopeAttestation: FIXED_POOL_SCOPE_ATTESTATION,
    sourceEvidenceRef, sourceEvidenceHash, changeReason,
  })

  db.exec('BEGIN IMMEDIATE')
  try {
    const replay = readIdempotentResult(db, idempotencyKey, actor.userId, requestHash, 'VERSION')
    if (replay) {
      db.exec('COMMIT')
      return replay as HospitalCmFixedPoolVersion
    }

    const previousRow = db.prepare(`
      ${VERSION_SELECT}
      WHERE service_month = ?
      ORDER BY version_no DESC
      LIMIT 1
    `).get(serviceMonth) as VersionRow | undefined
    const previous = previousRow ? versionFromRow(previousRow) : null
    const versionNumber = (previous?.versionNumber ?? 0) + 1
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const contentHash = sha256({
      serviceMonth,
      versionNumber,
      amountMinor,
      currency: 'CNY',
      scopePolicyVersion: HOSPITAL_CM_FIXED_POOL_POLICY_VERSION,
      scopeAttestation: FIXED_POOL_SCOPE_ATTESTATION,
      sourceKind: FIXED_POOL_SOURCE_KIND,
      sourceEvidenceRef,
      sourceEvidenceHash,
      supersedesVersionId: previous?.id ?? null,
      changeReason,
    })

    db.prepare(`
      INSERT INTO hospital_cm_fixed_pool_versions
        (id, service_month, version_no, amount_minor, currency, scope_policy_version, scope_attestation,
         source_kind, source_evidence_ref, source_evidence_hash, content_hash, supersedes_version_id,
         change_reason, created_by_user_id, created_by_username, created_at)
      VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      serviceMonth,
      versionNumber,
      amountMinor,
      HOSPITAL_CM_FIXED_POOL_POLICY_VERSION,
      FIXED_POOL_SCOPE_ATTESTATION,
      FIXED_POOL_SOURCE_KIND,
      sourceEvidenceRef,
      sourceEvidenceHash,
      contentHash,
      previous?.id ?? null,
      changeReason,
      actor.userId,
      actor.username,
      createdAt,
    )

    writeAuditLog(db, 'hospital_cm_fixed_pool', 'version_create', id, {
      serviceMonth,
      before: previous == null ? null : {
        id: previous.id,
        version: previous.version,
        amountMinor: previous.amountMinor,
        currency: previous.currency,
        contentHash: previous.contentHash,
      },
      after: {
        id,
        version: versionLabel(serviceMonth, versionNumber),
        amountMinor,
        currency: 'CNY',
        contentHash,
        scopePolicyVersion: HOSPITAL_CM_FIXED_POOL_POLICY_VERSION,
        sourceEvidenceRef,
        sourceEvidenceHash,
      },
      changeReason,
    }, actor.username)
    saveIdempotentResult(db, {
      key: idempotencyKey,
      actorUserId: actor.userId,
      requestHash,
      operation: 'CREATE_VERSION',
      resultKind: 'VERSION',
      resultId: id,
      createdAt,
    })
    db.exec('COMMIT')
    const result = readVersionById(db, id)
    if (!result) throw new Error('fixed pool version disappeared after commit')
    return result
  } catch (cause) {
    rollbackQuietly(db)
    throw cause
  }
}

export function recordHospitalCmFixedPoolDecision(
  db: HospitalCmFixedPoolDb,
  raw: {
    versionId: unknown
    decision: unknown
    expectedContentHash: unknown
    evidenceRef: unknown
    evidenceHash: unknown
    reason: unknown
    actor: HospitalCmFixedPoolActor
    idempotencyKey: unknown
  },
): HospitalCmFixedPoolDecisionEvent {
  const versionId = requireText(raw.versionId, { code: 'FIXED_POOL_VERSION_ID_INVALID', label: '固定池版本 ID', max: 128 })
  if (raw.decision !== 'RATIFIED' && raw.decision !== 'REVOKED') {
    throw new HospitalCmFixedPoolError('FIXED_POOL_DECISION_INVALID', 400, '只允许 RATIFIED 或 REVOKED 追加式决策')
  }
  const decision = raw.decision
  const expectedContentHash = normalizeHash(raw.expectedContentHash, 'FIXED_POOL_CONTENT_HASH_INVALID', '预期 content hash')
  const evidenceRef = requireText(raw.evidenceRef, {
    code: 'FIXED_POOL_RATIFICATION_EVIDENCE_INVALID', label: '认账证据引用', max: 512, rejectCsvFormula: true,
  })
  const evidenceHash = normalizeHash(raw.evidenceHash, 'FIXED_POOL_RATIFICATION_EVIDENCE_INVALID', '认账证据 hash')
  const reason = requireText(raw.reason, {
    code: 'FIXED_POOL_DECISION_REASON_INVALID', label: '认账/撤销原因', max: 500, rejectCsvFormula: true,
  })
  const actor = normalizeActor(raw.actor)
  const idempotencyKey = normalizeIdempotencyKey(raw.idempotencyKey)
  const requestHash = sha256({
    operation: 'DECISION', actorUserId: actor.userId, versionId, decision,
    expectedContentHash, evidenceRef, evidenceHash, reason,
  })

  db.exec('BEGIN IMMEDIATE')
  try {
    const replay = readIdempotentResult(db, idempotencyKey, actor.userId, requestHash, 'DECISION')
    if (replay) {
      db.exec('COMMIT')
      return replay as HospitalCmFixedPoolDecisionEvent
    }

    const target = readVersionById(db, versionId)
    if (!target) throw new HospitalCmFixedPoolError('FIXED_POOL_VERSION_NOT_FOUND', 404, '固定成本池版本不存在')
    const currentRow = db.prepare(`
      ${VERSION_SELECT}
      WHERE service_month = ?
      ORDER BY version_no DESC
      LIMIT 1
    `).get(target.serviceMonth) as VersionRow | undefined
    const current = currentRow ? versionFromRow(currentRow) : null
    if (current?.id !== target.id) {
      throw new HospitalCmFixedPoolError('FIXED_POOL_VERSION_SUPERSEDED', 409, '只能对该月当前最新版本认账或撤销')
    }
    if (target.contentHash !== expectedContentHash) {
      throw new HospitalCmFixedPoolError('FIXED_POOL_CONTENT_CHANGED', 409, '版本内容已变化，请重新核对当前 content hash')
    }

    const owner = readOwner(db)
    if (!owner.ownerUserId || !owner.ownerName?.trim()) {
      throw new HospitalCmFixedPoolError('FIXED_POOL_OWNER_UNASSIGNED', 409, '财务业务 owner 尚未由 PM 具名指派')
    }
    if (owner.ownerRole !== 'business') {
      throw new HospitalCmFixedPoolError('FIXED_POOL_OWNER_ROLE_INVALID', 409, 'denominator owner 必须保持财务业务负责人角色')
    }
    const ownerAssignmentRevision = validOwnerAssignmentRevision(owner.ownerAssignmentRevision)
    if (ownerAssignmentRevision == null) {
      throw new HospitalCmFixedPoolError('FIXED_POOL_OWNER_ASSIGNMENT_INVALID', 409, '财务业务 owner 指派版本无效，必须重新走具名指派')
    }
    if (!ownerIsActive(db, owner.ownerUserId)) {
      throw new HospitalCmFixedPoolError('FIXED_POOL_OWNER_INACTIVE', 409, '当前具名财务业务 owner 账号不可用')
    }
    if (owner.ownerUserId !== actor.userId) {
      throw new HospitalCmFixedPoolError('FIXED_POOL_RATIFIER_NOT_OWNER', 403, '当前操作人不是 denominator 的具名业务 owner，不可代签')
    }

    const latest = db.prepare(`
      ${DECISION_SELECT}
      WHERE event.pool_version_id = ?
      ORDER BY event.event_number DESC
      LIMIT 1
    `).get(target.id) as DecisionRow | undefined
    if (
      decision === 'RATIFIED'
      && latest?.decision === 'RATIFIED'
      && latest.ownerAssignmentRevision === ownerAssignmentRevision
    ) {
      throw new HospitalCmFixedPoolError('FIXED_POOL_ALREADY_RATIFIED', 409, '当前版本已是 RATIFIED')
    }
    if (decision === 'REVOKED' && latest?.decision !== 'RATIFIED') {
      throw new HospitalCmFixedPoolError('FIXED_POOL_NOT_RATIFIED', 409, '只有当前 RATIFIED 版本才可撤销')
    }

    const id = randomUUID()
    const decidedAt = new Date().toISOString()
    db.prepare(`
      INSERT INTO hospital_cm_fixed_pool_ratification_events
        (id, pool_version_id, pool_content_hash, decision, evidence_ref, evidence_hash,
         decision_reason, decided_by_user_id, decided_by_username, owner_assignment_revision, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      target.id,
      target.contentHash,
      decision,
      evidenceRef,
      evidenceHash,
      reason,
      actor.userId,
      actor.username,
      ownerAssignmentRevision,
      decidedAt,
    )
    writeAuditLog(db, 'hospital_cm_fixed_pool', decision === 'RATIFIED' ? 'ratify' : 'revoke', target.id, {
      serviceMonth: target.serviceMonth,
      version: target.version,
      contentHash: target.contentHash,
      beforeDecision: latest?.decision ?? null,
      afterDecision: decision,
      evidenceRef,
      evidenceHash,
      reason,
      ownerAssignmentRevision,
    }, actor.username)
    saveIdempotentResult(db, {
      key: idempotencyKey,
      actorUserId: actor.userId,
      requestHash,
      operation: `DECISION:${decision}`,
      resultKind: 'DECISION',
      resultId: id,
      createdAt: decidedAt,
    })
    db.exec('COMMIT')
    const result = readDecisionById(db, id)
    if (!result) throw new Error('fixed pool decision disappeared after commit')
    return result
  } catch (cause) {
    rollbackQuietly(db)
    throw cause
  }
}

export function readHospitalCmFixedPoolState(
  db: HospitalCmFixedPoolDb,
  rawServiceMonth: unknown,
): HospitalCmFixedPoolRuntimeState {
  const serviceMonth = normalizeServiceMonth(rawServiceMonth)
  const owner = readOwner(db)
  const ownerAssigned = Boolean(owner.ownerUserId && owner.ownerName?.trim())
  const ownerRoleValid = owner.ownerRole === 'business'
  const ownerAssignmentRevision = validOwnerAssignmentRevision(owner.ownerAssignmentRevision)
  const active = ownerIsActive(db, owner.ownerUserId)
  const currentRow = db.prepare(`
    ${VERSION_SELECT}
    WHERE service_month = ?
    ORDER BY version_no DESC
    LIMIT 1
  `).get(serviceMonth) as VersionRow | undefined
  const current = currentRow ? versionFromRow(currentRow) : null

  if (!current) {
    const stateFingerprint = sha256({
      serviceMonth,
      current: null,
      ownerRole: owner.ownerRole,
      ownerUserId: owner.ownerUserId,
      ownerAssignmentRevision,
      ownerActive: active,
      requiredPolicy: {
        scopePolicyVersion: HOSPITAL_CM_FIXED_POOL_POLICY_VERSION,
        scopeAttestation: FIXED_POOL_SCOPE_ATTESTATION,
        sourceKind: FIXED_POOL_SOURCE_KIND,
      },
    })
    return {
      serviceMonth,
      configured: false,
      value: null,
      amountMinor: null,
      currency: null,
      versionId: null,
      versionNumber: null,
      version: null,
      ratifiedVersion: null,
      contentHash: null,
      currentDecision: null,
      currentDecisionEventId: null,
      invalidationCode: 'NOT_CONFIGURED',
      policyCurrent: false,
      ownerAssigned,
      ownerActive: active,
      ownerAssignmentRevision: ownerAssignmentRevision ?? 0,
      ratification: null,
      stateFingerprint,
    }
  }

  const latestCurrentRow = db.prepare(`
    ${DECISION_SELECT}
    WHERE event.pool_version_id = ?
    ORDER BY event.event_number DESC
    LIMIT 1
  `).get(current.id) as DecisionRow | undefined
  const latestCurrent = latestCurrentRow ? decisionFromRow(latestCurrentRow) : null
  const priorEffectiveRow = db.prepare(`
    ${DECISION_SELECT}
    WHERE version.service_month = ?
      AND event.event_number = (
        SELECT MAX(latest.event_number)
        FROM hospital_cm_fixed_pool_ratification_events AS latest
        WHERE latest.pool_version_id = event.pool_version_id
      )
      AND event.decision = 'RATIFIED'
    ORDER BY version.version_no DESC
    LIMIT 1
  `).get(serviceMonth) as DecisionRow | undefined
  const priorEffective = priorEffectiveRow ? decisionFromRow(priorEffectiveRow) : null
  const policyCurrent = current.scopePolicyVersion === HOSPITAL_CM_FIXED_POOL_POLICY_VERSION
    && current.scopeAttestation === FIXED_POOL_SCOPE_ATTESTATION
    && current.sourceKind === FIXED_POOL_SOURCE_KIND

  const priorEffectiveMatchesOwner = priorEffective != null
    && ownerRoleValid
    && ownerAssignmentRevision != null
    && priorEffective.decidedByUserId === owner.ownerUserId
    && priorEffective.ownerAssignmentRevision === ownerAssignmentRevision
  let ratifiedVersion: string | null = priorEffectiveMatchesOwner ? priorEffective.version : null
  let invalidationCode: HospitalCmFixedPoolRuntimeState['invalidationCode']
  if (!policyCurrent) {
    ratifiedVersion = null
    invalidationCode = 'POLICY_MISMATCH'
  } else if (!ownerAssigned) {
    ratifiedVersion = null
    invalidationCode = 'OWNER_UNASSIGNED'
  } else if (!ownerRoleValid) {
    ratifiedVersion = null
    invalidationCode = 'OWNER_ROLE_INVALID'
  } else if (ownerAssignmentRevision == null) {
    ratifiedVersion = null
    invalidationCode = 'OWNER_ASSIGNMENT_INVALID'
  } else if (!active) {
    ratifiedVersion = null
    invalidationCode = 'OWNER_INACTIVE'
  } else if (
    latestCurrent?.decision === 'RATIFIED'
    && (
      latestCurrent.decidedByUserId !== owner.ownerUserId
      || latestCurrent.ownerAssignmentRevision !== ownerAssignmentRevision
    )
  ) {
    ratifiedVersion = null
    invalidationCode = 'OWNER_CHANGED'
  } else if (latestCurrent?.decision === 'RATIFIED') {
    ratifiedVersion = current.version
    invalidationCode = null
  } else if (latestCurrent?.decision === 'REVOKED') {
    invalidationCode = 'RATIFICATION_REVOKED'
  } else if (priorEffective != null && !priorEffectiveMatchesOwner) {
    invalidationCode = 'OWNER_CHANGED'
  } else if (priorEffective != null) {
    invalidationCode = 'CURRENT_VERSION_UNRATIFIED'
  } else {
    invalidationCode = 'UNRATIFIED'
  }

  const stateFingerprint = sha256({
    serviceMonth,
    versionId: current.id,
    contentHash: current.contentHash,
    currentDecisionEventId: latestCurrent?.id ?? null,
    currentDecision: latestCurrent?.decision ?? null,
    currentDecisionActor: latestCurrent?.decidedByUserId ?? null,
    decisionOwnerAssignmentRevision: latestCurrent?.ownerAssignmentRevision ?? null,
    ownerRole: owner.ownerRole,
    ownerUserId: owner.ownerUserId,
    ownerAssignmentRevision,
    ownerActive: active,
    requiredPolicy: {
      scopePolicyVersion: HOSPITAL_CM_FIXED_POOL_POLICY_VERSION,
      scopeAttestation: FIXED_POOL_SCOPE_ATTESTATION,
      sourceKind: FIXED_POOL_SOURCE_KIND,
    },
    policyCurrent,
  })
  return {
    serviceMonth,
    configured: true,
    value: current.value,
    amountMinor: current.amountMinor,
    currency: current.currency,
    versionId: current.id,
    versionNumber: current.versionNumber,
    version: current.version,
    ratifiedVersion,
    contentHash: current.contentHash,
    currentDecision: latestCurrent?.decision ?? null,
    currentDecisionEventId: latestCurrent?.id ?? null,
    invalidationCode,
    policyCurrent,
    ownerAssigned,
    ownerActive: active,
    ownerAssignmentRevision: ownerAssignmentRevision ?? 0,
    ratification: latestCurrent == null ? null : {
      eventId: latestCurrent.id,
      version: latestCurrent.version,
      decision: latestCurrent.decision,
      evidenceRef: latestCurrent.evidenceRef,
      evidenceHash: latestCurrent.evidenceHash,
      reason: latestCurrent.reason,
      decidedByUsername: latestCurrent.decidedByUsername,
      ownerAssignmentRevision: latestCurrent.ownerAssignmentRevision,
      decidedAt: latestCurrent.decidedAt,
    },
    stateFingerprint,
  }
}

export function readHospitalCmFixedPoolControlFingerprint(
  db: HospitalCmFixedPoolDb,
  serviceMonth: string | null,
): string {
  if (serviceMonth != null) return readHospitalCmFixedPoolState(db, serviceMonth).stateFingerprint
  // 无目标月时 denominator 必为 false；只用一条聚合查询捕捉控制面变化，不读金额。
  const aggregate = db.prepare(`
    SELECT (SELECT COUNT(*) FROM hospital_cm_fixed_pool_versions) AS versionCount,
           (SELECT COALESCE(MAX(event_number), 0) FROM hospital_cm_fixed_pool_versions) AS maxVersionEvent,
           (SELECT COUNT(*) FROM hospital_cm_fixed_pool_ratification_events) AS decisionCount,
           (SELECT COALESCE(MAX(event_number), 0) FROM hospital_cm_fixed_pool_ratification_events) AS maxDecisionEvent,
           (SELECT owner_role FROM hospital_cm_readiness_milestones WHERE condition_key = 'denominator') AS ownerRole,
           (SELECT owner_user_id FROM hospital_cm_readiness_milestones WHERE condition_key = 'denominator') AS ownerUserId,
           (SELECT owner_assignment_revision FROM hospital_cm_readiness_milestones WHERE condition_key = 'denominator') AS ownerAssignmentRevision
  `).get() as {
    versionCount: number
    maxVersionEvent: number
    decisionCount: number
    maxDecisionEvent: number
    ownerRole: string | null
    ownerUserId: string | null
    ownerAssignmentRevision: number | null
  }
  return sha256({
    serviceMonth: null,
    versionCount: Number(aggregate.versionCount),
    maxVersionEvent: Number(aggregate.maxVersionEvent),
    decisionCount: Number(aggregate.decisionCount),
    maxDecisionEvent: Number(aggregate.maxDecisionEvent),
    ownerRole: aggregate.ownerRole,
    ownerUserId: aggregate.ownerUserId,
    ownerAssignmentRevision: Number(aggregate.ownerAssignmentRevision ?? 0),
  })
}

export function listHospitalCmFixedPoolVersions(
  db: HospitalCmFixedPoolDb,
  rawServiceMonth: unknown,
  opts: { limit?: unknown; beforeVersionEvent?: unknown; beforeDecisionEvent?: unknown } = {},
): {
  serviceMonth: string
  current: HospitalCmFixedPoolRuntimeState
  versions: HospitalCmFixedPoolVersion[]
  events: HospitalCmFixedPoolDecisionEvent[]
  pagination: {
    limit: number
    nextVersionCursor: number | null
    nextDecisionCursor: number | null
  }
} {
  const serviceMonth = normalizeServiceMonth(rawServiceMonth)
  const rawLimit = opts.limit == null || opts.limit === '' ? 50 : Number(opts.limit)
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw new HospitalCmFixedPoolError('FIXED_POOL_PAGE_INVALID', 400, 'limit 必须是 1~100 的整数')
  }
  const cursorOf = (value: unknown, label: string): number | null => {
    if (value == null || value === '') return null
    const cursor = Number(value)
    if (!Number.isSafeInteger(cursor) || cursor <= 0) {
      throw new HospitalCmFixedPoolError('FIXED_POOL_PAGE_INVALID', 400, `${label} 必须是正安全整数`)
    }
    return cursor
  }
  const limit = rawLimit
  const beforeVersionEvent = cursorOf(opts.beforeVersionEvent, 'beforeVersionEvent')
  const beforeDecisionEvent = cursorOf(opts.beforeDecisionEvent, 'beforeDecisionEvent')
  const versions = (db.prepare(`
    ${VERSION_SELECT}
    WHERE service_month = ? AND (? IS NULL OR event_number < ?)
    ORDER BY version_no DESC
    LIMIT ?
  `).all(serviceMonth, beforeVersionEvent, beforeVersionEvent, limit + 1) as VersionRow[]).map(versionFromRow)
  const events = (db.prepare(`
    ${DECISION_SELECT}
    WHERE version.service_month = ? AND (? IS NULL OR event.event_number < ?)
    ORDER BY event.event_number DESC
    LIMIT ?
  `).all(serviceMonth, beforeDecisionEvent, beforeDecisionEvent, limit + 1) as DecisionRow[]).map(decisionFromRow)
  const hasMoreVersions = versions.length > limit
  const hasMoreDecisions = events.length > limit
  const pageVersions = versions.slice(0, limit)
  const pageEvents = events.slice(0, limit)
  return {
    serviceMonth,
    current: readHospitalCmFixedPoolState(db, serviceMonth),
    versions: pageVersions,
    events: pageEvents,
    pagination: {
      limit,
      nextVersionCursor: hasMoreVersions ? pageVersions.at(-1)?.eventNumber ?? null : null,
      nextDecisionCursor: hasMoreDecisions ? pageEvents.at(-1)?.eventNumber ?? null : null,
    },
  }
}
