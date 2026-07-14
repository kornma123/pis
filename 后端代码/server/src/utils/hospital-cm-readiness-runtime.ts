import { createHash, randomUUID } from 'node:crypto'
import {
  computeReadiness,
  CURRENT_KNOWN_READINESS_INPUT,
  READINESS_FOUNDATION_GATES,
  READINESS_PARAM_VERSION,
  type FoundationGate,
  type ReadinessConditionKey,
  type ReadinessOwnerRole,
} from './portfolio-health.js'
import {
  combinedFoundationFingerprint,
  HOSPITAL_CM_FOUNDATION_PROBE_VERSION,
  HOSPITAL_CM_READINESS_SOURCE_TABLES,
  inspectHospitalCmFoundation,
  readHospitalCmReadinessSourceState,
  type FoundationProbeDb,
  type HospitalCmFoundationProbeCheck,
  type HospitalCmReadinessSourceState,
} from './hospital-cm-foundation-probes.js'
import {
  ensureHospitalCmFixedPoolSchema,
  readHospitalCmFixedPoolControlFingerprint,
  readHospitalCmFixedPoolState,
  type HospitalCmFixedPoolRuntimeState,
} from './hospital-cm-fixed-pool.js'

interface ReadinessStatement {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => unknown
}

export interface HospitalCmReadinessDb extends FoundationProbeDb {
  prepare: (sql: string) => ReadinessStatement
  exec: (sql: string) => unknown
}

const MILESTONE_SEED: Array<{
  conditionKey: ReadinessConditionKey
  ownerRole: ReadinessOwnerRole
  reviewerRole: 'independent_reviewer' | null
  due: string
  projectedDate: string | null
}> = [
  { conditionKey: 'denominator', ownerRole: 'business', reviewerRole: null, due: '2026-08-31', projectedDate: null },
  { conditionKey: 'foundation', ownerRole: 'tech', reviewerRole: null, due: '2026-09-30', projectedDate: null },
  { conditionKey: 'history', ownerRole: 'pm', reviewerRole: null, due: '2026-10-31', projectedDate: '2026-10-31' },
  { conditionKey: 'first_period', ownerRole: 'tech', reviewerRole: 'independent_reviewer', due: '2026-10-31', projectedDate: '2026-10-31' },
]

const OWNER_LABEL: Record<ReadinessOwnerRole, string> = {
  tech: '技术/数据负责人',
  business: '财务业务负责人',
  pm: '产品推进负责人',
}

export function ensureHospitalCmReadinessSchema(db: HospitalCmReadinessDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hospital_cm_readiness_milestones (
      condition_key TEXT PRIMARY KEY CHECK (condition_key IN ('foundation','denominator','history','first_period')),
      owner_role TEXT NOT NULL CHECK (owner_role IN ('tech','business','pm')),
      owner_user_id TEXT,
      owner_assignment_revision INTEGER NOT NULL DEFAULT 0 CHECK (owner_assignment_revision >= 0),
      owner_name TEXT,
      reviewer_role TEXT CHECK (reviewer_role IS NULL OR reviewer_role = 'independent_reviewer'),
      reviewer_user_id TEXT,
      reviewer_name TEXT,
      due_date TEXT NOT NULL,
      previous_due_date TEXT,
      projected_date TEXT,
      previous_projected_date TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      change_reason TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      completion_evidence_ref TEXT,
      completion_evidence_hash TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (condition_key <> 'first_period' OR reviewer_role IS 'independent_reviewer')
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_readiness_probe_runs (
      run_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      probe_version TEXT NOT NULL,
      overall_status TEXT NOT NULL CHECK (overall_status IN ('passed','failed','error')),
      input_fingerprint TEXT NOT NULL,
      started_at DATETIME NOT NULL,
      completed_at DATETIME NOT NULL,
      triggered_by_user_id TEXT NOT NULL,
      triggered_by_username TEXT NOT NULL,
      trigger_reason_code TEXT NOT NULL CHECK (trigger_reason_code IN ('MONTHLY_REVIEW','DATA_REPAIR_RECHECK','RELEASE_ACCEPTANCE')),
      ticket_ref TEXT,
      error_code TEXT,
      error_summary TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_readiness_probe_checks (
      run_id TEXT NOT NULL,
      gate_key TEXT NOT NULL CHECK (gate_key IN ('inventory_conservation','period_key','constant_freeze')),
      status TEXT NOT NULL CHECK (status IN ('passed','failed','error')),
      result_code TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      observed_at DATETIME NOT NULL,
      PRIMARY KEY (run_id, gate_key),
      FOREIGN KEY (run_id) REFERENCES hospital_cm_readiness_probe_runs(id)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_readiness_source_revisions (
      source_key TEXT PRIMARY KEY CHECK (source_key IN ('materials','inventory','batches','case_revenue','lis_cases','lis_case_markers','antibodies','antibody_aliases','ihc_cost_params','special_stain_kits')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_hcm_readiness_probe_checks_run
      ON hospital_cm_readiness_probe_checks(run_id);

    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_probe_runs_no_update
      BEFORE UPDATE ON hospital_cm_readiness_probe_runs
      BEGIN SELECT RAISE(ABORT, 'READINESS_EVIDENCE_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_probe_runs_no_delete
      BEFORE DELETE ON hospital_cm_readiness_probe_runs
      BEGIN SELECT RAISE(ABORT, 'READINESS_EVIDENCE_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_probe_checks_no_update
      BEFORE UPDATE ON hospital_cm_readiness_probe_checks
      BEGIN SELECT RAISE(ABORT, 'READINESS_EVIDENCE_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_probe_checks_no_delete
      BEFORE DELETE ON hospital_cm_readiness_probe_checks
      BEGIN SELECT RAISE(ABORT, 'READINESS_EVIDENCE_APPEND_ONLY'); END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_milestones_no_delete
      BEFORE DELETE ON hospital_cm_readiness_milestones
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_REQUIRED'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_milestones_revision_guard
      BEFORE UPDATE ON hospital_cm_readiness_milestones
      WHEN NEW.revision <> OLD.revision + 1
        OR NEW.previous_due_date IS NOT OLD.due_date
        OR NEW.previous_projected_date IS NOT OLD.projected_date
        OR LENGTH(TRIM(NEW.change_reason)) = 0
        OR LENGTH(TRIM(NEW.updated_by)) = 0
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_REVISION_INVALID'); END;
  `)

  // CREATE TABLE IF NOT EXISTS 不会给已存在的 A 候选库补列；只做幂等前向迁移，不回写任何完成状态。
  const milestoneColumns = db.prepare('PRAGMA table_info(hospital_cm_readiness_milestones)').all() as Array<{ name: string }>
  const milestoneColumnNames = new Set(milestoneColumns.map((column) => column.name))
  if (!milestoneColumnNames.has('completion_evidence_ref')) {
    db.exec('ALTER TABLE hospital_cm_readiness_milestones ADD COLUMN completion_evidence_ref TEXT')
  }
  if (!milestoneColumnNames.has('completion_evidence_hash')) {
    db.exec('ALTER TABLE hospital_cm_readiness_milestones ADD COLUMN completion_evidence_hash TEXT')
  }
  if (!milestoneColumnNames.has('owner_user_id')) {
    db.exec('ALTER TABLE hospital_cm_readiness_milestones ADD COLUMN owner_user_id TEXT')
  }
  if (!milestoneColumnNames.has('owner_assignment_revision')) {
    db.exec('ALTER TABLE hospital_cm_readiness_milestones ADD COLUMN owner_assignment_revision INTEGER NOT NULL DEFAULT 0')
  }
  if (!milestoneColumnNames.has('reviewer_user_id')) {
    db.exec('ALTER TABLE hospital_cm_readiness_milestones ADD COLUMN reviewer_user_id TEXT')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS hospital_cm_readiness_milestone_events (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_key TEXT NOT NULL CHECK (condition_key IN ('foundation','denominator','history','first_period')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      owner_role TEXT NOT NULL CHECK (owner_role IN ('tech','business','pm')),
      owner_user_id TEXT,
      owner_assignment_revision INTEGER NOT NULL DEFAULT 0 CHECK (owner_assignment_revision >= 0),
      owner_name TEXT,
      reviewer_role TEXT CHECK (reviewer_role IS NULL OR reviewer_role = 'independent_reviewer'),
      reviewer_user_id TEXT,
      reviewer_name TEXT,
      previous_due_date TEXT,
      due_date TEXT NOT NULL,
      previous_projected_date TEXT,
      projected_date TEXT,
      change_reason TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_at DATETIME NOT NULL,
      completion_evidence_ref TEXT,
      completion_evidence_hash TEXT,
      UNIQUE (condition_key, revision)
    );

    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_milestone_events_no_update
      BEFORE UPDATE ON hospital_cm_readiness_milestone_events
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_EVENT_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_milestone_events_no_delete
      BEFORE DELETE ON hospital_cm_readiness_milestone_events
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_EVENT_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_milestones_evidence_guard
      BEFORE UPDATE ON hospital_cm_readiness_milestones
      WHEN (NEW.completion_evidence_ref IS NULL) <> (NEW.completion_evidence_hash IS NULL)
        OR (NEW.completion_evidence_ref IS NOT NULL AND LENGTH(TRIM(NEW.completion_evidence_ref)) = 0)
        OR (NEW.completion_evidence_hash IS NOT NULL AND (
          LENGTH(NEW.completion_evidence_hash) <> 64
          OR NEW.completion_evidence_hash GLOB '*[^0-9A-Fa-f]*'
        ))
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_EVIDENCE_INVALID'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_milestones_reviewer_guard
      BEFORE UPDATE ON hospital_cm_readiness_milestones
      WHEN NEW.condition_key = 'first_period' AND (
        NEW.reviewer_role IS NOT 'independent_reviewer'
        OR (
          LENGTH(TRIM(COALESCE(NEW.owner_name, ''))) > 0
          AND LENGTH(TRIM(COALESCE(NEW.reviewer_name, ''))) > 0
          AND LOWER(TRIM(NEW.owner_name)) = LOWER(TRIM(NEW.reviewer_name))
        )
      )
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_REVIEWER_INVALID'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_milestones_identity_guard
      BEFORE UPDATE ON hospital_cm_readiness_milestones
      WHEN (NEW.owner_user_id IS NULL) <> (NEW.owner_name IS NULL)
        OR (NEW.reviewer_user_id IS NULL) <> (NEW.reviewer_name IS NULL)
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_IDENTITY_INCOMPLETE'); END;
    DROP TRIGGER IF EXISTS trg_hcm_readiness_milestones_owner_assignment_guard;
    CREATE TRIGGER trg_hcm_readiness_milestones_owner_assignment_guard
      BEFORE UPDATE ON hospital_cm_readiness_milestones
      WHEN NEW.owner_assignment_revision <> OLD.owner_assignment_revision + CASE
        WHEN NEW.owner_role IS NOT OLD.owner_role
          OR NEW.owner_user_id IS NOT OLD.owner_user_id
          OR NEW.owner_name IS NOT OLD.owner_name THEN 1
        ELSE 0
      END
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_OWNER_ASSIGNMENT_REVISION_INVALID'); END;
  `)

  const milestoneEventColumns = db.prepare('PRAGMA table_info(hospital_cm_readiness_milestone_events)').all() as Array<{ name: string }>
  const milestoneEventColumnNames = new Set(milestoneEventColumns.map((column) => column.name))
  if (!milestoneEventColumnNames.has('owner_user_id')) {
    db.exec('ALTER TABLE hospital_cm_readiness_milestone_events ADD COLUMN owner_user_id TEXT')
  }
  if (!milestoneEventColumnNames.has('owner_assignment_revision')) {
    db.exec('ALTER TABLE hospital_cm_readiness_milestone_events ADD COLUMN owner_assignment_revision INTEGER NOT NULL DEFAULT 0')
  }
  if (!milestoneEventColumnNames.has('reviewer_user_id')) {
    db.exec('ALTER TABLE hospital_cm_readiness_milestone_events ADD COLUMN reviewer_user_id TEXT')
  }

  // A 旧库的 trigger 不会被 CREATE IF NOT EXISTS 更新；前向重建以便事件同步快照稳定 userId。
  db.exec(`
    DROP TRIGGER IF EXISTS trg_hcm_readiness_milestones_append_event;
    CREATE TRIGGER trg_hcm_readiness_milestones_append_event
      AFTER UPDATE ON hospital_cm_readiness_milestones
      BEGIN
        INSERT INTO hospital_cm_readiness_milestone_events
          (condition_key, revision, owner_role, owner_user_id, owner_assignment_revision, owner_name,
           reviewer_role, reviewer_user_id, reviewer_name,
           previous_due_date, due_date, previous_projected_date, projected_date,
           change_reason, changed_by, changed_at, completion_evidence_ref, completion_evidence_hash)
        VALUES
          (NEW.condition_key, NEW.revision, NEW.owner_role, NEW.owner_user_id, NEW.owner_assignment_revision, NEW.owner_name,
           NEW.reviewer_role, NEW.reviewer_user_id, NEW.reviewer_name,
           NEW.previous_due_date, NEW.due_date, NEW.previous_projected_date, NEW.projected_date,
           NEW.change_reason, NEW.updated_by, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
           NEW.completion_evidence_ref, NEW.completion_evidence_hash);
      END;
  `)

  const insertRevision = db.prepare(`
    INSERT INTO hospital_cm_readiness_source_revisions (source_key, revision)
    SELECT ?, 0
    WHERE NOT EXISTS (
      SELECT 1 FROM hospital_cm_readiness_source_revisions WHERE source_key = ?
    )
  `)
  for (const sourceTable of HOSPITAL_CM_READINESS_SOURCE_TABLES) insertRevision.run(sourceTable, sourceTable)

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_source_revision_no_delete
      BEFORE DELETE ON hospital_cm_readiness_source_revisions
      BEGIN SELECT RAISE(ABORT, 'READINESS_SOURCE_REVISION_REQUIRED'); END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_source_revision_monotonic
      BEFORE UPDATE ON hospital_cm_readiness_source_revisions
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'READINESS_SOURCE_REVISION_NOT_MONOTONIC'); END;
  `)

  // 任一相关事实 INSERT/UPDATE/DELETE 都递增单调 revision；即使值改后又改回，也必须重新跑探针。
  // revision 与聚合证据一起进入 input fingerprint，避免“等长替换/总量不变”碰撞让旧证据继续放行。
  for (const sourceTable of HOSPITAL_CM_READINESS_SOURCE_TABLES) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_hcm_readiness_rev_${sourceTable}_${operation.toLowerCase()}
        AFTER ${operation} ON ${sourceTable}
        BEGIN
          UPDATE hospital_cm_readiness_source_revisions
          SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE source_key = '${sourceTable}';
        END;
      `)
    }
  }

  const insert = db.prepare(`
    INSERT INTO hospital_cm_readiness_milestones
      (condition_key, owner_role, owner_name, reviewer_role, reviewer_name, due_date, previous_due_date,
       projected_date, previous_projected_date, revision, change_reason, updated_by)
    SELECT ?, ?, NULL, ?, NULL, ?, ?, ?, ?, 1, ?, 'migration:A'
    WHERE NOT EXISTS (
      SELECT 1 FROM hospital_cm_readiness_milestones WHERE condition_key = ?
    )
  `)
  for (const milestone of MILESTONE_SEED) {
    insert.run(
      milestone.conditionKey,
      milestone.ownerRole,
      milestone.reviewerRole,
      milestone.due,
      milestone.due,
      milestone.projectedDate,
      milestone.projectedDate,
      'PM 已登记基线节点；日期调整须走独立审批增量',
      milestone.conditionKey,
    )
  }

  db.exec(`
    INSERT INTO hospital_cm_readiness_milestone_events
      (condition_key, revision, owner_role, owner_user_id, owner_assignment_revision, owner_name,
       reviewer_role, reviewer_user_id, reviewer_name,
       previous_due_date, due_date, previous_projected_date, projected_date,
       change_reason, changed_by, changed_at, completion_evidence_ref, completion_evidence_hash)
    SELECT condition_key, revision, owner_role, owner_user_id, owner_assignment_revision, owner_name,
           reviewer_role, reviewer_user_id, reviewer_name,
           previous_due_date, due_date, previous_projected_date, projected_date,
           change_reason, updated_by, updated_at, completion_evidence_ref, completion_evidence_hash
    FROM hospital_cm_readiness_milestones AS milestone
    WHERE NOT EXISTS (
      SELECT 1
      FROM hospital_cm_readiness_milestone_events AS event
      WHERE event.condition_key = milestone.condition_key
        AND event.revision = milestone.revision
    );
  `)

  // SQLite 默认 recursive_triggers=OFF，INSERT OR REPLACE 可能绕过 UPDATE/DELETE guard。
  // readiness 的稳定键全部在 INSERT 阶段拒绝冲突，避免旧 owner/旧探针证据被原地复活。
  db.exec(`
    DROP TRIGGER IF EXISTS trg_hcm_readiness_probe_runs_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_readiness_probe_checks_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_readiness_source_revisions_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_readiness_milestones_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_readiness_milestone_events_duplicate_guard;
    CREATE TRIGGER trg_hcm_readiness_probe_runs_duplicate_guard
      BEFORE INSERT ON hospital_cm_readiness_probe_runs
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_readiness_probe_runs
             WHERE id = NEW.id OR run_number = NEW.run_number
           )
      BEGIN SELECT RAISE(ABORT, 'READINESS_EVIDENCE_APPEND_ONLY'); END;
    CREATE TRIGGER trg_hcm_readiness_probe_checks_duplicate_guard
      BEFORE INSERT ON hospital_cm_readiness_probe_checks
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_readiness_probe_checks
             WHERE run_id = NEW.run_id AND gate_key = NEW.gate_key
           )
      BEGIN SELECT RAISE(ABORT, 'READINESS_EVIDENCE_APPEND_ONLY'); END;
    CREATE TRIGGER trg_hcm_readiness_source_revisions_duplicate_guard
      BEFORE INSERT ON hospital_cm_readiness_source_revisions
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_readiness_source_revisions
             WHERE source_key = NEW.source_key
           )
      BEGIN SELECT RAISE(ABORT, 'READINESS_SOURCE_REVISION_REQUIRED'); END;
    CREATE TRIGGER trg_hcm_readiness_milestones_duplicate_guard
      BEFORE INSERT ON hospital_cm_readiness_milestones
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_readiness_milestones
             WHERE condition_key = NEW.condition_key
           )
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_REQUIRED'); END;
    CREATE TRIGGER trg_hcm_readiness_milestone_events_duplicate_guard
      BEFORE INSERT ON hospital_cm_readiness_milestone_events
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_readiness_milestone_events
             WHERE event_number = NEW.event_number
                OR (condition_key = NEW.condition_key AND revision = NEW.revision)
           )
      BEGIN SELECT RAISE(ABORT, 'READINESS_MILESTONE_EVENT_APPEND_ONLY'); END;
  `)

  // B 只建空的月度版本/认账控制面；绝不 seed 金额、owner 或 RATIFIED。
  ensureHospitalCmFixedPoolSchema(db)
}

export const FOUNDATION_PROBE_REASON_CODES = ['MONTHLY_REVIEW', 'DATA_REPAIR_RECHECK', 'RELEASE_ACCEPTANCE'] as const
export type FoundationProbeReasonCode = (typeof FOUNDATION_PROBE_REASON_CODES)[number]

export class HospitalCmReadinessProbeError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
    this.name = 'HospitalCmReadinessProbeError'
  }
}

export interface RecordedFoundationProbeRun {
  id: string
  probeVersion: string
  overallStatus: 'passed' | 'failed' | 'error'
  inputFingerprint: string
  startedAt: string
  completedAt: string
  checks: HospitalCmFoundationProbeCheck[]
}

function enforceProbeCooldown(db: HospitalCmReadinessDb, now: string, cooldownSeconds: number): void {
  if (cooldownSeconds <= 0) return
  const latest = db.prepare(`
    SELECT completed_at AS completedAt
    FROM hospital_cm_readiness_probe_runs
    ORDER BY run_number DESC
    LIMIT 1
  `).get() as { completedAt?: string } | undefined
  if (!latest?.completedAt) return
  const elapsedSeconds = (Date.parse(now) - Date.parse(latest.completedAt)) / 1000
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < cooldownSeconds) {
    const retryAfter = Number.isFinite(elapsedSeconds)
      ? Math.max(1, Math.ceil(cooldownSeconds - elapsedSeconds))
      : cooldownSeconds
    throw new HospitalCmReadinessProbeError(
      'READINESS_PROBE_COOLDOWN',
      429,
      `真实地基探针刚运行过，请 ${retryAfter} 秒后再试`,
    )
  }
}

function requireProbeSourceState(db: HospitalCmReadinessDb): HospitalCmReadinessSourceState {
  try {
    return readHospitalCmReadinessSourceState(db)
  } catch {
    throw new HospitalCmReadinessProbeError(
      'READINESS_SOURCE_REVISION_INCOMPLETE',
      409,
      'readiness 数据源 revision 控制面不完整，本次未运行探针',
    )
  }
}

export function recordHospitalCmFoundationProbeRun(
  db: HospitalCmReadinessDb,
  input: {
    triggeredByUserId: string
    triggeredByUsername: string
    reasonCode: FoundationProbeReasonCode
    ticketRef?: string | null
    now?: string
    cooldownSeconds?: number
  },
): RecordedFoundationProbeRun {
  const triggeredByUserId = String(input.triggeredByUserId ?? '').trim()
  const triggeredByUsername = String(input.triggeredByUsername ?? '').trim()
  if (
    !triggeredByUserId
    || !triggeredByUsername
    || triggeredByUserId.toLowerCase() === 'unknown'
    || triggeredByUsername.toLowerCase() === 'unknown'
  ) {
    throw new HospitalCmReadinessProbeError(
      'READINESS_PROBE_ACTOR_REQUIRED',
      400,
      '探针验收证据必须绑定已认证的操作者 ID 与用户名',
    )
  }
  const reasonCode = input.reasonCode
  if (!FOUNDATION_PROBE_REASON_CODES.includes(reasonCode)) {
    throw new HospitalCmReadinessProbeError('READINESS_PROBE_REASON_INVALID', 400, 'reasonCode 不在允许集合中')
  }
  const ticketRef = input.ticketRef == null ? null : String(input.ticketRef).trim()
  if (ticketRef != null && !/^[A-Za-z0-9._:/#-]{1,80}$/.test(ticketRef)) {
    throw new HospitalCmReadinessProbeError(
      'READINESS_PROBE_TICKET_REF_INVALID',
      400,
      'ticketRef 仅允许 1-80 位字母、数字及 . _ : / # -',
    )
  }
  const startedAt = input.now ?? new Date().toISOString()
  const id = randomUUID()
  const cooldownSeconds = Math.max(0, Number(input.cooldownSeconds) || 0)
  enforceProbeCooldown(db, startedAt, cooldownSeconds)

  // 重查询在写事务之外完成，避免同步全表探针长期持有 SQLite 写锁。
  const sourceBefore = requireProbeSourceState(db)
  const checks = inspectHospitalCmFoundation(db, sourceBefore)
  const sourceAfter = requireProbeSourceState(db)
  if (sourceBefore.stateFingerprint !== sourceAfter.stateFingerprint) {
    throw new HospitalCmReadinessProbeError(
      'READINESS_SOURCE_CHANGED_DURING_PROBE',
      409,
      '探针运行期间数据源发生变化，本次结果未留证；请稍后重试',
    )
  }
  const overallStatus: RecordedFoundationProbeRun['overallStatus'] = checks.some((check) => check.status === 'error')
    ? 'error'
    : checks.every((check) => check.met)
      ? 'passed'
      : 'failed'
  const inputFingerprint = combinedFoundationFingerprint(checks)
  const firstError = checks.find((check) => check.status === 'error')

  db.exec('BEGIN IMMEDIATE')
  try {
    // 多进程下在拿到写锁后再核一次；窗口内有任何写入即 fail-closed，不保存陈旧 pass。
    const sourceLocked = requireProbeSourceState(db)
    if (sourceLocked.stateFingerprint !== sourceAfter.stateFingerprint) {
      throw new HospitalCmReadinessProbeError(
        'READINESS_SOURCE_CHANGED_DURING_PROBE',
        409,
        '探针完成后数据源又发生变化，本次结果未留证；请稍后重试',
      )
    }
    enforceProbeCooldown(db, startedAt, cooldownSeconds)
    const completedAt = input.now ?? new Date().toISOString()
    db.prepare(`
      INSERT INTO hospital_cm_readiness_probe_runs
        (id, probe_version, overall_status, input_fingerprint, started_at, completed_at,
         triggered_by_user_id, triggered_by_username, trigger_reason_code, ticket_ref,
         error_code, error_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      HOSPITAL_CM_FOUNDATION_PROBE_VERSION,
      overallStatus,
      inputFingerprint,
      startedAt,
      completedAt,
      triggeredByUserId,
      triggeredByUsername,
      reasonCode,
      ticketRef,
      firstError?.resultCode ?? null,
      firstError ? '地基探针读取失败；未保存原始数据库错误或业务明细' : null,
    )
    const insertCheck = db.prepare(`
      INSERT INTO hospital_cm_readiness_probe_checks
        (run_id, gate_key, status, result_code, summary_json, input_fingerprint, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const check of checks) {
      insertCheck.run(
        id,
        check.key,
        check.status,
        check.resultCode,
        JSON.stringify(check.summary),
        check.inputFingerprint,
        completedAt,
      )
    }
    db.exec('COMMIT')
    return {
      id,
      probeVersion: HOSPITAL_CM_FOUNDATION_PROBE_VERSION,
      overallStatus,
      inputFingerprint,
      startedAt,
      completedAt,
      checks,
    }
  } catch (cause) {
    db.exec('ROLLBACK')
    throw cause
  }
}

interface MilestoneRow {
  conditionKey: ReadinessConditionKey
  ownerRole: ReadinessOwnerRole
  ownerUserId: string | null
  ownerAssignmentRevision: number
  ownerName: string | null
  reviewerRole: 'independent_reviewer' | null
  reviewerUserId: string | null
  reviewerName: string | null
  due: string
  previousDue: string | null
  projectedDate: string | null
  previousProjectedDate: string | null
  revision: number
  changeReason: string
  completionEvidenceRef: string | null
  completionEvidenceHash: string | null
  updatedAt: string
}

function readMilestones(db: HospitalCmReadinessDb): MilestoneRow[] {
  return db.prepare(`
    SELECT condition_key AS conditionKey,
           owner_role AS ownerRole,
           owner_user_id AS ownerUserId,
           owner_assignment_revision AS ownerAssignmentRevision,
           owner_name AS ownerName,
           reviewer_role AS reviewerRole,
           reviewer_user_id AS reviewerUserId,
           reviewer_name AS reviewerName,
           due_date AS due,
           previous_due_date AS previousDue,
           projected_date AS projectedDate,
           previous_projected_date AS previousProjectedDate,
           revision,
           change_reason AS changeReason,
           completion_evidence_ref AS completionEvidenceRef,
           completion_evidence_hash AS completionEvidenceHash,
           COALESCE((
             SELECT event.changed_at
             FROM hospital_cm_readiness_milestone_events AS event
             WHERE event.condition_key = milestone.condition_key
               AND event.revision = milestone.revision
           ), updated_at) AS updatedAt
    FROM hospital_cm_readiness_milestones AS milestone
    ORDER BY condition_key
  `).all() as MilestoneRow[]
}

interface PersistedRunRow {
  id: string
  probeVersion: string
  overallStatus: 'passed' | 'failed' | 'error'
  inputFingerprint: string
  completedAt: string
}

interface PersistedCheckRow {
  key: FoundationGate
  status: 'passed' | 'failed' | 'error'
  resultCode: string
  summaryJson: string
  inputFingerprint: string
  observedAt: string
}

function readLatestRun(db: HospitalCmReadinessDb): { run: PersistedRunRow; checks: PersistedCheckRow[] } | null {
  const run = db.prepare(`
    SELECT id,
           probe_version AS probeVersion,
           overall_status AS overallStatus,
           input_fingerprint AS inputFingerprint,
           completed_at AS completedAt
    FROM hospital_cm_readiness_probe_runs
    ORDER BY run_number DESC
    LIMIT 1
  `).get() as PersistedRunRow | undefined
  if (!run) return null
  const checks = db.prepare(`
    SELECT gate_key AS key,
           status,
           result_code AS resultCode,
           summary_json AS summaryJson,
           input_fingerprint AS inputFingerprint,
           observed_at AS observedAt
    FROM hospital_cm_readiness_probe_checks
    WHERE run_id = ?
    ORDER BY gate_key
  `).all(run.id) as PersistedCheckRow[]
  return { run, checks }
}

function parseSummary(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function persistedEvidenceMatchesCurrentSource(
  gate: FoundationGate,
  persisted: PersistedCheckRow,
  source: HospitalCmReadinessSourceState,
): boolean {
  const summary = parseSummary(persisted.summaryJson)
  if (gate === 'constant_freeze') {
    const costRevisions = objectOf(summary.costSourceRevisions)
    return summary.runtimeFingerprint === source.constantFingerprint
      && summary.costDataSchemaFingerprint === source.costDataSchemaFingerprint
      && Number(costRevisions.antibodies) === source.revisions.antibodies
      && Number(costRevisions.antibodyAliases) === source.revisions.antibody_aliases
      && Number(costRevisions.ihcCostParams) === source.revisions.ihc_cost_params
      && Number(costRevisions.specialStainKits) === source.revisions.special_stain_kits
  }
  const revisions = objectOf(summary.sourceRevisions)
  if (gate === 'inventory_conservation') {
    return summary.schemaFingerprint === source.inventorySchemaFingerprint
      && Number(revisions.materials) === source.revisions.materials
      && Number(revisions.inventory) === source.revisions.inventory
      && Number(revisions.batches) === source.revisions.batches
  }
  return summary.schemaFingerprint === source.periodSchemaFingerprint
    && Number(revisions.caseRevenue) === source.revisions.case_revenue
    && Number(revisions.lisCases) === source.revisions.lis_cases
    && Number(revisions.lisMarkers) === source.revisions.lis_case_markers
}

function currentSourceSummary(gate: FoundationGate, source: HospitalCmReadinessSourceState): Record<string, unknown> {
  if (gate === 'inventory_conservation') {
    return {
      schemaFingerprint: source.inventorySchemaFingerprint,
      sourceRevisions: {
        materials: source.revisions.materials,
        inventory: source.revisions.inventory,
        batches: source.revisions.batches,
      },
    }
  }
  if (gate === 'period_key') {
    return {
      schemaFingerprint: source.periodSchemaFingerprint,
      sourceRevisions: {
        caseRevenue: source.revisions.case_revenue,
        lisCases: source.revisions.lis_cases,
        lisMarkers: source.revisions.lis_case_markers,
      },
    }
  }
  return {
    runtimeFingerprint: source.constantFingerprint,
    costDataSchemaFingerprint: source.costDataSchemaFingerprint,
    costSourceRevisions: {
      antibodies: source.revisions.antibodies,
      antibodyAliases: source.revisions.antibody_aliases,
      ihcCostParams: source.revisions.ihc_cost_params,
      specialStainKits: source.revisions.special_stain_kits,
    },
  }
}

function unavailableSourceState(): HospitalCmReadinessSourceState {
  const revisions = Object.fromEntries(HOSPITAL_CM_READINESS_SOURCE_TABLES.map((source) => [source, -1])) as HospitalCmReadinessSourceState['revisions']
  const schemaSql = Object.fromEntries(HOSPITAL_CM_READINESS_SOURCE_TABLES.map((source) => [source, ''])) as HospitalCmReadinessSourceState['schemaSql']
  return {
    revisions,
    schemaSql,
    inventorySchemaFingerprint: 'unavailable',
    periodSchemaFingerprint: 'unavailable',
    costDataSchemaFingerprint: 'unavailable',
    constantFingerprint: 'unavailable',
    stateFingerprint: 'unavailable',
  }
}

export interface HospitalCmReadinessSnapshot {
  ready: boolean
  checklist: ReturnType<typeof computeReadiness>['checklist']
  findings: Array<ReturnType<typeof computeReadiness>['findings'][number] | Record<string, unknown>>
  asOf: string
  asOfSource: 'server'
  policyVersion: string
  sourceStateFingerprint: string
  foundationGatesGreen: Record<FoundationGate, boolean>
  foundationEvidence: null | {
    runId: string
    observedAt: string
    probeVersion: string
    overallStatus: string
    currentFingerprintMatches: boolean
    checks: Array<Record<string, unknown>>
  }
  milestones: Array<Record<string, unknown>>
  sources: Record<ReadinessConditionKey, Record<string, unknown>>
}

function compositeReadinessFingerprint(
  foundationFingerprint: string,
  fixedPoolFingerprint: string,
  serviceMonth: string | null,
  milestoneFingerprint: string,
): string {
  return createHash('sha256').update(JSON.stringify({
    foundationFingerprint,
    fixedPoolFingerprint,
    serviceMonth,
    milestoneFingerprint,
  })).digest('hex')
}

function milestoneControlFingerprint(milestones: MilestoneRow[]): string {
  return createHash('sha256').update(JSON.stringify(milestones.map((milestone) => ({
    conditionKey: milestone.conditionKey,
    revision: Number(milestone.revision),
    ownerRole: milestone.ownerRole,
    ownerUserId: milestone.ownerUserId,
    ownerAssignmentRevision: Number(milestone.ownerAssignmentRevision),
    ownerName: milestone.ownerName,
    reviewerRole: milestone.reviewerRole,
    reviewerUserId: milestone.reviewerUserId,
    reviewerName: milestone.reviewerName,
    due: milestone.due,
    previousDue: milestone.previousDue,
    projectedDate: milestone.projectedDate,
    previousProjectedDate: milestone.previousProjectedDate,
    completionEvidenceRef: milestone.completionEvidenceRef,
    completionEvidenceHash: milestone.completionEvidenceHash,
  })))).digest('hex')
}

function unavailableFixedPoolState(serviceMonth: string): HospitalCmFixedPoolRuntimeState {
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
    ownerAssigned: false,
    ownerActive: false,
    ownerAssignmentRevision: 0,
    ratification: null,
    stateFingerprint: 'UNAVAILABLE',
  }
}

export function getHospitalCmReadinessSnapshot(
  db: HospitalCmReadinessDb,
  asOf: string,
  opts: { serviceMonth?: string } = {},
): HospitalCmReadinessSnapshot {
  const targetServiceMonth = opts.serviceMonth ?? null
  let sourceBefore: HospitalCmReadinessSourceState
  let sourceStateAvailable = true
  try {
    sourceBefore = readHospitalCmReadinessSourceState(db)
  } catch {
    sourceBefore = unavailableSourceState()
    sourceStateAvailable = false
  }
  let fixedPoolFingerprintBefore = targetServiceMonth == null ? 'NO_TARGET_SERVICE_MONTH' : 'UNAVAILABLE'
  let fixedPoolSourceAvailable = true
  if (targetServiceMonth != null) {
    try {
      fixedPoolFingerprintBefore = readHospitalCmFixedPoolControlFingerprint(db, targetServiceMonth)
    } catch {
      fixedPoolSourceAvailable = false
    }
  }
  const milestones = readMilestones(db)
  const latest = readLatestRun(db)
  let sourceAfter: HospitalCmReadinessSourceState
  try {
    sourceAfter = readHospitalCmReadinessSourceState(db)
  } catch {
    sourceAfter = unavailableSourceState()
    sourceStateAvailable = false
  }
  const sourceStable = sourceStateAvailable && sourceBefore.stateFingerprint === sourceAfter.stateFingerprint
  let fixedPoolState: HospitalCmFixedPoolRuntimeState | null = null
  let fixedPoolFingerprintAfter = targetServiceMonth == null ? 'NO_TARGET_SERVICE_MONTH' : 'UNAVAILABLE'
  if (targetServiceMonth != null) {
    try {
      fixedPoolState = readHospitalCmFixedPoolState(db, targetServiceMonth)
      fixedPoolFingerprintAfter = fixedPoolState.stateFingerprint
    } catch {
      fixedPoolSourceAvailable = false
      fixedPoolState = unavailableFixedPoolState(targetServiceMonth)
    }
  }
  const fixedPoolSourceStable = fixedPoolSourceAvailable && fixedPoolFingerprintBefore === fixedPoolFingerprintAfter
  const persistedByKey = new Map((latest?.checks ?? []).map((check) => [check.key, check]))
  const versionMatches = latest?.run.probeVersion === HOSPITAL_CM_FOUNDATION_PROBE_VERSION
  const latestCheckKeys = latest?.checks.map((check) => check.key) ?? []
  const latestCheckSetComplete = latest != null
    && latest.checks.length === READINESS_FOUNDATION_GATES.length
    && new Set(latestCheckKeys).size === READINESS_FOUNDATION_GATES.length
    && READINESS_FOUNDATION_GATES.every((gate) => latestCheckKeys.includes(gate))
  const derivedOverallStatus = latest == null
    ? null
    : latest.checks.some((check) => check.status === 'error')
      ? 'error'
      : latest.checks.every((check) => check.status === 'passed')
        ? 'passed'
        : 'failed'
  const latestRunEvidenceConsistent = Boolean(
    latestCheckSetComplete
    && latest != null
    && latest.run.overallStatus === derivedOverallStatus
    && latest.run.inputFingerprint === combinedFoundationFingerprint(latest.checks),
  )
  const foundationGatesGreen = Object.fromEntries(
    READINESS_FOUNDATION_GATES.map((gate) => {
      const persisted = persistedByKey.get(gate)
      const met = Boolean(
        sourceStable
        && versionMatches
        && latestRunEvidenceConsistent
        && persisted?.status === 'passed'
        && persistedEvidenceMatchesCurrentSource(gate, persisted, sourceAfter),
      )
      return [gate, met]
    }),
  ) as Record<FoundationGate, boolean>

  const milestoneByKey = new Map(milestones.map((milestone) => [milestone.conditionKey, milestone]))
  const schedule = Object.fromEntries(milestones.map((milestone) => [
    milestone.conditionKey,
    { owner: milestone.ownerRole, due: milestone.due },
  ]))
  const history = milestoneByKey.get('history')
  const fixedPoolForReadiness = targetServiceMonth != null && fixedPoolSourceStable && fixedPoolState != null
    ? fixedPoolState
    : { configured: false, value: null, version: null, ratifiedVersion: null }
  const computed = computeReadiness({
    ...CURRENT_KNOWN_READINESS_INPUT,
    foundationGatesGreen,
    fixedPool: fixedPoolForReadiness,
    verifiedClosedPeriods: 0,
    firstRealPeriodValidated: false,
    schedule,
    projectedReadyDate: history?.projectedDate ?? history?.due ?? null,
    previousProjectedReadyDate: history?.previousProjectedDate ?? history?.previousDue ?? null,
    asOf,
  })

  const extraFindings: Array<Record<string, unknown>> = []
  const assignmentErrors = new Map<ReadinessConditionKey, string[]>()
  for (const milestone of milestones) {
    const missingAssignments: string[] = []
    if (!milestone.ownerUserId?.trim() || !milestone.ownerName?.trim()) {
      missingAssignments.push('具名责任人未指派')
      extraFindings.push({
        type: 'milestone_owner_unassigned',
        conditionKey: milestone.conditionKey,
        ownerRole: milestone.ownerRole,
        message: `里程碑 ${milestone.conditionKey} 只有责任角色、尚无具名责任人 → fail-closed`,
      })
    }
    if (milestone.conditionKey === 'first_period' && milestone.reviewerRole !== 'independent_reviewer') {
      missingAssignments.push('独立复核角色缺失')
      extraFindings.push({
        type: 'milestone_reviewer_role_invalid',
        conditionKey: milestone.conditionKey,
        reviewerRole: milestone.reviewerRole,
        message: `里程碑 ${milestone.conditionKey} 必须保留 independent_reviewer 角色 → fail-closed`,
      })
    } else if (milestone.reviewerRole != null && (!milestone.reviewerUserId?.trim() || !milestone.reviewerName?.trim())) {
      missingAssignments.push('具名独立复核人未指派')
      extraFindings.push({
        type: 'milestone_reviewer_unassigned',
        conditionKey: milestone.conditionKey,
        reviewerRole: milestone.reviewerRole,
        message: `里程碑 ${milestone.conditionKey} 尚无具名独立复核人 → fail-closed`,
      })
    }
    if (
      milestone.conditionKey === 'first_period'
      && milestone.ownerUserId?.trim()
      && milestone.reviewerUserId?.trim()
      && milestone.ownerUserId.trim() === milestone.reviewerUserId.trim()
    ) {
      missingAssignments.push('责任人与独立复核人不得为同一人')
      extraFindings.push({
        type: 'milestone_reviewer_not_independent',
        conditionKey: milestone.conditionKey,
        message: `里程碑 ${milestone.conditionKey} 的责任人与独立复核人为同一稳定用户身份 → fail-closed`,
      })
    } else if (
      milestone.conditionKey === 'first_period'
      && milestone.ownerName?.trim()
      && milestone.reviewerName?.trim()
      && milestone.ownerName.trim().toLocaleLowerCase() === milestone.reviewerName.trim().toLocaleLowerCase()
    ) {
      missingAssignments.push('责任人与独立复核人不得为同一人')
      extraFindings.push({
        type: 'milestone_reviewer_not_independent',
        conditionKey: milestone.conditionKey,
        message: `里程碑 ${milestone.conditionKey} 的责任人与独立复核人为同一身份 → fail-closed`,
      })
    }
    if (missingAssignments.length > 0) assignmentErrors.set(milestone.conditionKey, missingAssignments)
    if (milestone.previousDue != null && milestone.due > milestone.previousDue) {
      extraFindings.push({
        type: 'milestone_due_slipped',
        conditionKey: milestone.conditionKey,
        from: milestone.previousDue,
        to: milestone.due,
        revision: milestone.revision,
        message: `里程碑 ${milestone.conditionKey} 截止日后移：${milestone.previousDue} → ${milestone.due}`,
      })
    }
    if (
      milestone.previousProjectedDate != null
      && milestone.projectedDate != null
      && milestone.projectedDate > milestone.previousProjectedDate
    ) {
      extraFindings.push({
        type: 'milestone_projected_slipped',
        conditionKey: milestone.conditionKey,
        from: milestone.previousProjectedDate,
        to: milestone.projectedDate,
        revision: milestone.revision,
        message: `里程碑 ${milestone.conditionKey} 预计完成日后移：${milestone.previousProjectedDate} → ${milestone.projectedDate}`,
      })
    }
  }
  if (!sourceStateAvailable) {
    extraFindings.push({
      type: 'source_revision_incomplete',
      conditionKey: 'foundation',
      message: 'readiness 数据源 revision 控制面不完整 → 全部地基门 fail-closed',
    })
  }
  if (!fixedPoolSourceAvailable) {
    extraFindings.push({
      type: 'fixed_pool_source_unavailable',
      conditionKey: 'denominator',
      serviceMonth: targetServiceMonth,
      message: '固定成本池版本/认账控制面不可用 → denominator fail-closed',
    })
  } else if (!fixedPoolSourceStable) {
    extraFindings.push({
      type: 'fixed_pool_source_changed_during_read',
      conditionKey: 'denominator',
      serviceMonth: targetServiceMonth,
      message: '固定成本池在 readiness 读取期间发生变化 → denominator fail-closed',
    })
  }
  if (latest != null && !latestRunEvidenceConsistent) {
    extraFindings.push({
      type: 'probe_run_integrity_mismatch',
      conditionKey: 'foundation',
      runId: latest.run.id,
      message: '最新地基探针 run 总状态或组合指纹与三项 check 不一致 → 全部门 fail-closed',
    })
  }

  const foundationEvidence = latest == null ? null : {
    runId: latest.run.id,
    observedAt: latest.run.completedAt,
    probeVersion: latest.run.probeVersion,
    overallStatus: latest.run.overallStatus,
    currentFingerprintMatches: Boolean(
      sourceStable
      && versionMatches
      && latestRunEvidenceConsistent
      && READINESS_FOUNDATION_GATES.every((gate) => {
        const persisted = persistedByKey.get(gate)
        return persisted != null && persistedEvidenceMatchesCurrentSource(gate, persisted, sourceAfter)
      }),
    ),
    checks: READINESS_FOUNDATION_GATES.map((gate) => {
      const persisted = persistedByKey.get(gate)
      const evidenceMatches = Boolean(
        sourceStable
        && versionMatches
        && latestRunEvidenceConsistent
        && persisted != null
        && persistedEvidenceMatchesCurrentSource(gate, persisted, sourceAfter),
      )
      const currentResultCode = persisted == null
        ? 'NO_PERSISTED_RUN'
        : !sourceStateAvailable
          ? 'SOURCE_REVISION_STATE_INCOMPLETE'
          : !latestRunEvidenceConsistent
            ? 'PROBE_RUN_INTEGRITY_MISMATCH'
          : !sourceStable
          ? 'SOURCE_CHANGED_DURING_READ'
          : !versionMatches
            ? 'PROBE_VERSION_CHANGED'
            : !evidenceMatches
              ? 'SOURCE_CHANGED_REQUIRES_RERUN'
              : persisted.resultCode
      return {
        key: gate,
        met: foundationGatesGreen[gate],
        persistedStatus: persisted?.status ?? null,
        persistedResultCode: persisted?.resultCode ?? null,
        currentMet: evidenceMatches && persisted?.status === 'passed',
        currentResultCode,
        currentFingerprintMatches: evidenceMatches,
        observedAt: persisted?.observedAt ?? null,
        summary: persisted == null ? null : parseSummary(persisted.summaryJson),
        currentSummary: currentSourceSummary(gate, sourceAfter),
      }
    }),
  }

  const checklist = computed.checklist.map((condition) => {
    const missingAssignments = assignmentErrors.get(condition.key)
    if (missingAssignments == null) return condition
    return {
      ...condition,
      met: false,
      assignmentError: true,
      detail: `${condition.detail ?? '业务证据待接入'}；${missingAssignments.join('、')}`,
    }
  })
  const checklistByKey = new Map(checklist.map((condition) => [condition.key, condition]))
  const milestoneView = milestones.map((milestone) => {
    const condition = checklistByKey.get(milestone.conditionKey)
    return {
      conditionKey: milestone.conditionKey,
      ownerRole: milestone.ownerRole,
      ownerLabel: OWNER_LABEL[milestone.ownerRole],
      ownerName: milestone.ownerName,
      ownerAssignmentRevision: Number(milestone.ownerAssignmentRevision),
      ownerAssigned: Boolean(milestone.ownerUserId?.trim() && milestone.ownerName?.trim()),
      reviewerRole: milestone.reviewerRole,
      reviewerName: milestone.reviewerName,
      reviewerAssigned: Boolean(milestone.reviewerUserId?.trim() && milestone.reviewerName?.trim()),
      due: milestone.due,
      previousDue: milestone.previousDue,
      projectedDate: milestone.projectedDate,
      previousProjectedDate: milestone.previousProjectedDate,
      revision: milestone.revision,
      changeReason: milestone.changeReason,
      updatedAt: milestone.updatedAt,
      met: condition?.met ?? false,
      overdue: condition?.overdue === true,
      dueSlipped: milestone.previousDue != null && milestone.due > milestone.previousDue,
      projectedSlipped: milestone.previousProjectedDate != null
        && milestone.projectedDate != null
        && milestone.projectedDate > milestone.previousProjectedDate,
      slipped: (milestone.previousDue != null && milestone.due > milestone.previousDue)
        || (milestone.previousProjectedDate != null
          && milestone.projectedDate != null
          && milestone.projectedDate > milestone.previousProjectedDate),
      evidenceRunId: milestone.conditionKey === 'foundation' ? foundationEvidence?.runId ?? null : null,
      completionEvidenceRef: milestone.completionEvidenceRef,
      completionEvidenceHash: milestone.completionEvidenceHash,
    }
  })

  const denominatorSource: Record<string, unknown> = targetServiceMonth == null
    ? {
        state: 'connected',
        table: 'hospital_cm_fixed_pool_versions',
        targetPhase: 'B',
        targetServiceMonth: null,
        configured: false,
        value: null,
        currentVersion: null,
        currentContentHash: null,
        ratifiedVersion: null,
        ratification: null,
        invalidationCode: 'TARGET_SERVICE_MONTH_REQUIRED',
        note: '不隐式选取全局最新值；C 必须从已关账且质量通过的目标周期派生月份',
      }
    : {
        state: 'connected',
        table: 'hospital_cm_fixed_pool_versions',
        targetPhase: 'B',
        targetServiceMonth,
        configured: fixedPoolState?.configured === true,
        value: null, // readiness 公共载荷只露版本/证据，不泄漏分母金额。
        currency: fixedPoolState?.currency ?? null,
        currentVersionId: fixedPoolState?.versionId ?? null,
        currentVersion: fixedPoolState?.version ?? null,
        currentContentHash: fixedPoolState?.contentHash ?? null,
        ratifiedVersion: fixedPoolState?.ratifiedVersion ?? null,
        currentDecision: fixedPoolState?.currentDecision ?? null,
        invalidationCode: fixedPoolState?.invalidationCode ?? 'NOT_CONFIGURED',
        policyCurrent: fixedPoolState?.policyCurrent === true,
        ownerAssigned: fixedPoolState?.ownerAssigned === true,
        ownerActive: fixedPoolState?.ownerActive === true,
        ownerAssignmentRevision: fixedPoolState?.ownerAssignmentRevision ?? 0,
        ratification: fixedPoolState?.ratification == null ? null : {
          eventId: fixedPoolState.ratification.eventId,
          version: fixedPoolState.ratification.version,
          decision: fixedPoolState.ratification.decision,
          evidenceRef: fixedPoolState.ratification.evidenceRef,
          evidenceHash: fixedPoolState.ratification.evidenceHash,
          decidedByUsername: fixedPoolState.ratification.decidedByUsername,
          decidedAt: fixedPoolState.ratification.decidedAt,
        },
      }

  const sourceStateFingerprint = compositeReadinessFingerprint(
    sourceAfter.stateFingerprint,
    fixedPoolFingerprintAfter,
    targetServiceMonth,
    milestoneControlFingerprint(milestones),
  )

  return {
    ...computed,
    ready: computed.ready && assignmentErrors.size === 0,
    checklist,
    findings: [...computed.findings, ...extraFindings],
    asOf,
    asOfSource: 'server',
    policyVersion: READINESS_PARAM_VERSION,
    sourceStateFingerprint,
    foundationGatesGreen,
    foundationEvidence,
    milestones: milestoneView,
    sources: {
      foundation: { state: 'connected', table: 'hospital_cm_readiness_probe_runs', probeVersion: HOSPITAL_CM_FOUNDATION_PROBE_VERSION },
      denominator: denominatorSource,
      history: { state: 'not_connected', targetPhase: 'C', verifiedClosedPeriods: 0 },
      first_period: { state: 'not_connected', targetPhase: 'C', independentlyValidated: false },
    },
  }
}

export function shanghaiBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

/** full-health 在真正回数前复核一次，防多进程写入造成“旧 readiness + 新金额”的混合快照。 */
export function currentHospitalCmReadinessSourceFingerprint(
  db: HospitalCmReadinessDb,
  serviceMonth: string | null = null,
): string {
  return compositeReadinessFingerprint(
    readHospitalCmReadinessSourceState(db).stateFingerprint,
    readHospitalCmFixedPoolControlFingerprint(db, serviceMonth),
    serviceMonth,
    milestoneControlFingerprint(readMilestones(db)),
  )
}
