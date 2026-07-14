import { randomUUID } from 'node:crypto'
import { writeAuditLog } from './cost-runs.js'
import {
  readHospitalCmReadinessSourceState,
  sha256,
  type FoundationProbeDb,
} from './hospital-cm-foundation-probes.js'
import { readHospitalCmFixedPoolControlFingerprint } from './hospital-cm-fixed-pool.js'
import { HOSPITAL_CM_FORMULA_VERSION } from './hospital-cm.js'
import { SPLIT_FORMULA_VERSION } from './statement-revenue.js'
import { splitCaliberRatification } from './caliber-ratification.js'

/**
 * C1 · hospital-cm 周期证据底座(issue #183 增量 C 第一子交付)。
 *
 * 只提供存储 / 哈希 / 读侧失效判定;不实现 C3 的周期质量状态机与检查器,不动 C4 readiness 合同。
 * 结论(checks 的 status/result_code、run 的 overall_status)只能由 C3 检查器在服务器内产生——
 * 因此本模块**不导出 validation run 写函数**(闭环文档:调用者不能提交 ready/met/passed/checks;
 * A 范式 recordHospitalCmFoundationProbeRun 也是函数内自算 checks)。
 *
 * 失效语义 = 读侧现算比对(evaluatePeriodValidationRun):证据 append-only 永不删除,
 * 是否仍然有效由"当时指纹 vs 现算指纹"逐维判定,与 A 的 persistedEvidenceMatchesCurrentSource 同范式。
 */

interface PeriodEvidenceStatement {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => unknown
}

export interface HospitalCmPeriodEvidenceDb extends FoundationProbeDb {
  prepare: (sql: string) => PeriodEvidenceStatement
  exec: (sql: string) => unknown
}

export class HospitalCmPeriodEvidenceError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
    this.name = 'HospitalCmPeriodEvidenceError'
  }
}

/** profile 指纹配方版本:C2 把拆分口径占位槽换成版本化内容/行为 hash 时必须 bump,
 *  使 evaluate 报 PROFILE_RECIPE_UPGRADED(机制升级)而非 PROFILE_CHANGED(口径真变了)。 */
export const HOSPITAL_CM_PROFILE_RECIPE_VERSION = 'C1.profile-recipe.v1'

/** 周期证据绑定的 CM 相关源表子集:hospital-cm 计算只消费这 7 张(hospital-cm-service 输入面);
 *  库存三表(materials/inventory/batches)不是 CM 输入,编进指纹会让每次出入库灭掉全部周期证据、
 *  三期门构造性不可达——库存绿灯由 foundation gate 单独把守(C4 消费)。 */
export const HOSPITAL_CM_CM_SOURCE_TABLES = [
  'case_revenue',
  'lis_cases',
  'lis_case_markers',
  'antibodies',
  'antibody_aliases',
  'ihc_cost_params',
  'special_stain_kits',
] as const

export const PERIOD_EVIDENCE_SOURCE_KINDS = ['case_revenue', 'lis_cases', 'lis_case_markers'] as const
export type PeriodEvidenceSourceKind = (typeof PERIOD_EVIDENCE_SOURCE_KINDS)[number]

/** batch 行内容指纹的列 allowlist = 原始导入事实列(稳定、不含 PII 之外原文落库)。
 *  派生/拆分列(lab_revenue 等)会被重算刷新,进指纹会把"重算"误报成"导入内容变了";
 *  allowlist 外任何列变化仍被 A 的 source revision 触发器抓住(SOURCE_STATE_CHANGED 兜底)。 */
const SOURCE_ROW_COLUMNS: Record<PeriodEvidenceSourceKind, readonly string[]> = {
  case_revenue: ['id', 'case_no', 'partner_id', 'partner_name', 'doc_no', 'gross_amount', 'net_amount', 'discount_rate', 'service_month', 'line_count', 'import_batch', 'config_version'],
  lis_cases: ['id', 'case_no', 'partner_id', 'project_id', 'project_name', 'operator', 'operate_time', 'status', 'import_batch'],
  lis_case_markers: ['id', 'case_no', 'partner_id', 'marker_name', 'advice_type', 'wax_no', 'section_no', 'import_batch'],
}

const SERVICE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const SHA256_RE = /^[a-fA-F0-9]{64}$/
const CSV_FORMULA_PREFIX_RE = /^[\s]*[=+\-@]/

export type MonthScopeStatus = 'complete' | 'incomplete' | 'withdrawn'

export interface PeriodEvidenceActor {
  userId: string
  username: string
}

export interface SourceBatchManifest {
  id: string
  eventNumber: number
  sourceKind: PeriodEvidenceSourceKind
  batchRef: string
  versionNo: number
  rowsSha256: string
  rowCount: number
  serviceMonths: string[]
  partnerIds: string[]
  externalSourceRef: string | null
  externalSourceHash: string | null
  manifestHash: string
  supersedesManifestId: string | null
  recordedByUserId: string
  recordedByUsername: string
  reason: string
  recordedAt: string
}

export interface MonthScopeSnapshot {
  id: string
  eventNumber: number
  serviceMonth: string
  versionNo: number
  status: MonthScopeStatus
  rosterSourceRef: string
  rosterSourceHash: string
  accounts: string[]
  scopeHash: string
  recordedByUserId: string
  recordedByUsername: string
  reason: string
  recordedAt: string
}

export interface PeriodValidationRunRow {
  runNumber: number
  id: string
  serviceMonth: string
  scopeHash: string
  scopeSnapshotEventNumber: number
  closeRevisionFingerprint: string
  sourceStateFingerprint: string
  profileFingerprint: string
  manifestSetFingerprint: string
  profileRecipeVersion: string
  overallStatus: 'passed' | 'failed' | 'error'
  startedAt: string
  completedAt: string
  triggeredByUserId: string
  triggeredByUsername: string
  triggerReasonCode: string
  errorCode: string | null
  errorSummary: string | null
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function requireText(value: unknown, code: string, fieldLabel: string, maxLength = 200): string {
  if (typeof value !== 'string') throw new HospitalCmPeriodEvidenceError(code, 400, `${fieldLabel} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) throw new HospitalCmPeriodEvidenceError(code, 400, `${fieldLabel} 不能为空`)
  if (trimmed.length > maxLength) throw new HospitalCmPeriodEvidenceError(code, 400, `${fieldLabel} 超过 ${maxLength} 字符上限`)
  if (containsControlCharacter(trimmed)) throw new HospitalCmPeriodEvidenceError(code, 400, `${fieldLabel} 含控制字符`)
  // 同一字段的全部拒因走同一稳定错误码(guardrails:稳定错误码是可执行契约),公式前缀不例外
  if (CSV_FORMULA_PREFIX_RE.test(trimmed)) throw new HospitalCmPeriodEvidenceError(code, 400, `${fieldLabel} 不允许以公式前缀开头`)
  return trimmed
}

function normalizeActor(actor: unknown): PeriodEvidenceActor {
  const candidate = (actor ?? {}) as Partial<PeriodEvidenceActor>
  const userId = typeof candidate.userId === 'string' ? candidate.userId.trim() : ''
  const username = typeof candidate.username === 'string' ? candidate.username.trim() : ''
  if (!userId || !username || userId.toLowerCase() === 'unknown' || username.toLowerCase() === 'unknown') {
    throw new HospitalCmPeriodEvidenceError('PERIOD_EVIDENCE_ACTOR_REQUIRED', 400, '证据写入必须绑定已认证操作者(拒绝空值与 unknown 占位)')
  }
  return { userId, username }
}

function normalizeServiceMonth(value: unknown): string {
  if (typeof value !== 'string' || !SERVICE_MONTH_RE.test(value)) {
    throw new HospitalCmPeriodEvidenceError('PERIOD_EVIDENCE_SERVICE_MONTH_INVALID', 400, 'serviceMonth 必须是合法 YYYY-MM')
  }
  return value
}

function rejectUnsupportedKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unsupported.length > 0) {
    // 不回显调用者提交的键名(错误消息回显输入是注入/泄漏通道);只报计数与允许清单。
    throw new HospitalCmPeriodEvidenceError(
      'PERIOD_EVIDENCE_UNSUPPORTED_FIELD',
      400,
      `存在 ${unsupported.length} 个不支持的输入字段;仅接受:${allowed.join('、')}——manifest/scope/profile hash 与一切结论字段只能由服务器根据已保存事实计算`,
    )
  }
}

function nowIso(explicit?: string): string {
  if (explicit != null) {
    if (typeof explicit !== 'string' || Number.isNaN(Date.parse(explicit))) {
      throw new HospitalCmPeriodEvidenceError('PERIOD_EVIDENCE_TIMESTAMP_INVALID', 400, 'now 必须是可解析的 ISO 时间串')
    }
    return explicit
  }
  return new Date().toISOString()
}

function rollbackQuietly(db: HospitalCmPeriodEvidenceDb): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // 事务已被 SQLite 自动回滚时忽略
  }
}

/** 行值规范化:BigInt 显式转字符串(node:sqlite 大整数防线),其余原样(依赖 ECMA-262 Number→String 确定性)。 */
function normalizeCell(value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export function ensureHospitalCmPeriodEvidenceSchema(db: HospitalCmPeriodEvidenceDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hospital_cm_source_batch_manifests (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('case_revenue','lis_cases','lis_case_markers')),
      batch_ref TEXT NOT NULL CHECK (LENGTH(TRIM(batch_ref)) > 0),
      version_no INTEGER NOT NULL CHECK (version_no >= 1),
      rows_sha256 TEXT NOT NULL CHECK (LENGTH(rows_sha256) = 64 AND rows_sha256 NOT GLOB '*[^0-9A-Fa-f]*'),
      row_count INTEGER NOT NULL CHECK (row_count >= 1),
      service_months_json TEXT NOT NULL,
      partner_ids_json TEXT NOT NULL,
      external_source_ref TEXT,
      external_source_hash TEXT,
      manifest_hash TEXT NOT NULL CHECK (LENGTH(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9A-Fa-f]*'),
      supersedes_manifest_id TEXT,
      recorded_by_user_id TEXT NOT NULL CHECK (LENGTH(TRIM(recorded_by_user_id)) > 0),
      recorded_by_username TEXT NOT NULL CHECK (LENGTH(TRIM(recorded_by_username)) > 0),
      reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) > 0),
      recorded_at TEXT NOT NULL,
      UNIQUE (source_kind, batch_ref, version_no),
      FOREIGN KEY (supersedes_manifest_id) REFERENCES hospital_cm_source_batch_manifests(id),
      CHECK ((external_source_ref IS NULL) = (external_source_hash IS NULL)),
      CHECK (external_source_hash IS NULL OR (LENGTH(external_source_hash) = 64 AND external_source_hash NOT GLOB '*[^0-9A-Fa-f]*'))
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_month_scope_snapshots (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      service_month TEXT NOT NULL CHECK (
        LENGTH(service_month) = 7
        AND service_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
        AND CAST(SUBSTR(service_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      ),
      version_no INTEGER NOT NULL CHECK (version_no >= 1),
      status TEXT NOT NULL CHECK (status IN ('complete','incomplete','withdrawn')),
      roster_source_ref TEXT NOT NULL CHECK (LENGTH(TRIM(roster_source_ref)) > 0),
      roster_source_hash TEXT NOT NULL CHECK (LENGTH(roster_source_hash) = 64 AND roster_source_hash NOT GLOB '*[^0-9A-Fa-f]*'),
      accounts_json TEXT NOT NULL CHECK (accounts_json <> '[]'),
      scope_hash TEXT NOT NULL CHECK (LENGTH(scope_hash) = 64 AND scope_hash NOT GLOB '*[^0-9A-Fa-f]*'),
      recorded_by_user_id TEXT NOT NULL CHECK (LENGTH(TRIM(recorded_by_user_id)) > 0),
      recorded_by_username TEXT NOT NULL CHECK (LENGTH(TRIM(recorded_by_username)) > 0),
      reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) > 0),
      recorded_at TEXT NOT NULL,
      UNIQUE (service_month, version_no)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_close_revision_events (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      partner_id TEXT NOT NULL,
      service_month TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('close','reopen','delete')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      row_id TEXT,
      status_snapshot TEXT,
      closed_at TEXT,
      closed_by TEXT,
      occurred_at TEXT NOT NULL,
      UNIQUE (partner_id, service_month, revision)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_period_validation_runs (
      run_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      service_month TEXT NOT NULL CHECK (
        LENGTH(service_month) = 7
        AND service_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
        AND CAST(SUBSTR(service_month, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      ),
      scope_hash TEXT NOT NULL CHECK (LENGTH(scope_hash) = 64 AND scope_hash NOT GLOB '*[^0-9A-Fa-f]*'),
      scope_snapshot_event_number INTEGER NOT NULL CHECK (scope_snapshot_event_number >= 1),
      close_revision_fingerprint TEXT NOT NULL CHECK (LENGTH(close_revision_fingerprint) = 64 AND close_revision_fingerprint NOT GLOB '*[^0-9A-Fa-f]*'),
      source_state_fingerprint TEXT NOT NULL CHECK (LENGTH(source_state_fingerprint) = 64 AND source_state_fingerprint NOT GLOB '*[^0-9A-Fa-f]*'),
      profile_fingerprint TEXT NOT NULL CHECK (LENGTH(profile_fingerprint) = 64 AND profile_fingerprint NOT GLOB '*[^0-9A-Fa-f]*'),
      manifest_set_fingerprint TEXT NOT NULL CHECK (LENGTH(manifest_set_fingerprint) = 64 AND manifest_set_fingerprint NOT GLOB '*[^0-9A-Fa-f]*'),
      profile_recipe_version TEXT NOT NULL CHECK (LENGTH(TRIM(profile_recipe_version)) > 0),
      overall_status TEXT NOT NULL CHECK (overall_status IN ('passed','failed','error')),
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      triggered_by_user_id TEXT NOT NULL CHECK (LENGTH(TRIM(triggered_by_user_id)) > 0),
      triggered_by_username TEXT NOT NULL CHECK (LENGTH(TRIM(triggered_by_username)) > 0),
      trigger_reason_code TEXT NOT NULL CHECK (trigger_reason_code IN ('PERIOD_REVIEW','DATA_REPAIR_RECHECK','RELEASE_ACCEPTANCE')),
      -- error_summary 只允许定串(照 A 线 runtime 先例):不落原始数据库错误或业务明细
      error_code TEXT,
      error_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_period_validation_checks (
      run_id TEXT NOT NULL,
      check_key TEXT NOT NULL CHECK (LENGTH(TRIM(check_key)) > 0),
      status TEXT NOT NULL CHECK (status IN ('passed','failed','error')),
      result_code TEXT NOT NULL CHECK (LENGTH(TRIM(result_code)) > 0),
      -- 聚合形状红线:只装计数/码/指纹,禁病例号、患者字段与原始业务行(超长即拒,C3 写入侧再加内容纪律)
      summary_json TEXT NOT NULL CHECK (LENGTH(summary_json) <= 2048),
      input_fingerprint TEXT NOT NULL CHECK (LENGTH(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9A-Fa-f]*'),
      observed_at TEXT NOT NULL,
      PRIMARY KEY (run_id, check_key),
      FOREIGN KEY (run_id) REFERENCES hospital_cm_period_validation_runs(id)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_hcm_manifests_batch
      ON hospital_cm_source_batch_manifests(source_kind, batch_ref, version_no DESC);
    CREATE INDEX IF NOT EXISTS idx_hcm_scope_snapshots_month
      ON hospital_cm_month_scope_snapshots(service_month, version_no DESC);
    CREATE INDEX IF NOT EXISTS idx_hcm_close_events_key
      ON hospital_cm_close_revision_events(partner_id, service_month, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_hcm_close_events_month
      ON hospital_cm_close_revision_events(service_month);
    CREATE INDEX IF NOT EXISTS idx_hcm_validation_runs_month
      ON hospital_cm_period_validation_runs(service_month, run_number DESC);
  `)

  // append-only:UPDATE/DELETE 全拒
  const appendOnlyTables: Array<[string, string]> = [
    ['hospital_cm_source_batch_manifests', 'PERIOD_EVIDENCE_MANIFEST_APPEND_ONLY'],
    ['hospital_cm_month_scope_snapshots', 'PERIOD_EVIDENCE_SCOPE_APPEND_ONLY'],
    ['hospital_cm_close_revision_events', 'PERIOD_EVIDENCE_CLOSE_EVENT_APPEND_ONLY'],
    ['hospital_cm_period_validation_runs', 'PERIOD_EVIDENCE_RUN_APPEND_ONLY'],
    ['hospital_cm_period_validation_checks', 'PERIOD_EVIDENCE_CHECK_APPEND_ONLY'],
  ]
  for (const [table, code] of appendOnlyTables) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_no_update
        BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${code}'); END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_no_delete
        BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${code}'); END;
    `)
  }

  // INSERT OR REPLACE 走隐式 DELETE(recursive_triggers=OFF 时不触发 DELETE guard)——
  // duplicate guard 必须逐表枚举**全部** UNIQUE 键在 INSERT 阶段拒绝;漏一键即静默改写(对抗面板实证)。
  // AUTOINCREMENT 键 INSERT 时为 NULL,天然放行。
  db.exec(`
    DROP TRIGGER IF EXISTS trg_hcm_manifests_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_scope_snapshots_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_close_events_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_validation_runs_duplicate_guard;
    DROP TRIGGER IF EXISTS trg_hcm_validation_checks_duplicate_guard;
    CREATE TRIGGER trg_hcm_manifests_duplicate_guard
      BEFORE INSERT ON hospital_cm_source_batch_manifests
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_source_batch_manifests
             WHERE id = NEW.id
                OR (NEW.event_number IS NOT NULL AND event_number = NEW.event_number)
                OR (source_kind = NEW.source_kind AND batch_ref = NEW.batch_ref AND version_no = NEW.version_no)
           )
      BEGIN SELECT RAISE(ABORT, 'PERIOD_EVIDENCE_MANIFEST_APPEND_ONLY'); END;
    CREATE TRIGGER trg_hcm_scope_snapshots_duplicate_guard
      BEFORE INSERT ON hospital_cm_month_scope_snapshots
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_month_scope_snapshots
             WHERE id = NEW.id
                OR (NEW.event_number IS NOT NULL AND event_number = NEW.event_number)
                OR (service_month = NEW.service_month AND version_no = NEW.version_no)
           )
      BEGIN SELECT RAISE(ABORT, 'PERIOD_EVIDENCE_SCOPE_APPEND_ONLY'); END;
    CREATE TRIGGER trg_hcm_close_events_duplicate_guard
      BEFORE INSERT ON hospital_cm_close_revision_events
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_close_revision_events
             WHERE (NEW.event_number IS NOT NULL AND event_number = NEW.event_number)
                OR (partner_id = NEW.partner_id AND service_month = NEW.service_month AND revision = NEW.revision)
           )
      BEGIN SELECT RAISE(ABORT, 'PERIOD_EVIDENCE_CLOSE_EVENT_APPEND_ONLY'); END;
    CREATE TRIGGER trg_hcm_validation_runs_duplicate_guard
      BEFORE INSERT ON hospital_cm_period_validation_runs
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_period_validation_runs
             WHERE id = NEW.id
                OR (NEW.run_number IS NOT NULL AND run_number = NEW.run_number)
           )
      BEGIN SELECT RAISE(ABORT, 'PERIOD_EVIDENCE_RUN_APPEND_ONLY'); END;
    CREATE TRIGGER trg_hcm_validation_checks_duplicate_guard
      BEFORE INSERT ON hospital_cm_period_validation_checks
      WHEN EXISTS (
             SELECT 1 FROM hospital_cm_period_validation_checks
             WHERE run_id = NEW.run_id AND check_key = NEW.check_key
           )
      BEGIN SELECT RAISE(ABORT, 'PERIOD_EVIDENCE_CHECK_APPEND_ONLY'); END;
  `)

  // 版本链序守卫(照 fixed-pool trg_hcm_fixed_pool_version_sequence_guard):
  // 越号、v1 带 supersedes、supersedes 不指向同键现任最新版,一律 DB 级拒绝——
  // 「现任 manifest/scope」的出处不允许被绕过写函数的进程内 SQL 伪造。
  db.exec(`
    DROP TRIGGER IF EXISTS trg_hcm_manifests_sequence_guard;
    DROP TRIGGER IF EXISTS trg_hcm_scope_snapshots_sequence_guard;
    CREATE TRIGGER trg_hcm_manifests_sequence_guard
      BEFORE INSERT ON hospital_cm_source_batch_manifests
      WHEN NEW.version_no <> COALESCE((
             SELECT MAX(version_no) + 1
             FROM hospital_cm_source_batch_manifests
             WHERE source_kind = NEW.source_kind AND batch_ref = NEW.batch_ref
           ), 1)
        OR (NEW.version_no = 1 AND NEW.supersedes_manifest_id IS NOT NULL)
        OR (NEW.version_no > 1 AND NEW.supersedes_manifest_id IS NOT (
             SELECT id
             FROM hospital_cm_source_batch_manifests
             WHERE source_kind = NEW.source_kind AND batch_ref = NEW.batch_ref
             ORDER BY version_no DESC
             LIMIT 1
           ))
      BEGIN SELECT RAISE(ABORT, 'PERIOD_EVIDENCE_MANIFEST_SEQUENCE_INVALID'); END;
    CREATE TRIGGER trg_hcm_scope_snapshots_sequence_guard
      BEFORE INSERT ON hospital_cm_month_scope_snapshots
      WHEN NEW.version_no <> COALESCE((
             SELECT MAX(version_no) + 1
             FROM hospital_cm_month_scope_snapshots
             WHERE service_month = NEW.service_month
           ), 1)
      BEGIN SELECT RAISE(ABORT, 'PERIOD_EVIDENCE_SCOPE_SEQUENCE_INVALID'); END;
  `)

  // 行内容哈希列集漂移:未来给 reconcile_hospital_months 加列而不同步 RECONCILE_ROW_HASH_COLUMNS,
  // 会把闭环文档「关账行任何业务列变化都失效」静默收窄。处置分两层(不炸启动——旧库兼容 guardrail,
  // 与 A 线「控制面缺行 → 全门 fail-closed 而非拒启动」同姿势):
  // 1. 这里只响亮告警;2. currentCloseRevisionState 现查列集,漂移时 close 维度整体 fail-closed
  //    (RECONCILE_SCHEMA_DRIFT),周期证据全部失效,不可能静默放行。
  // 生产 DDL 与清单的同步锚在测试:真 initializeDatabase 库的列集 == 清单,漂移时 CI 必红。
  if (detectReconcileSchemaDrift(db) != null) {
    console.warn('[hospital-cm-period-evidence] reconcile_hospital_months 列集与 RECONCILE_ROW_HASH_COLUMNS 不一致——周期证据 close 维度将 fail-closed;请同步行哈希清单')
  }

  // reconcile_hospital_months 状态迁移镜像(生产链路该表先于本 ensure 建;缺表则 loud fail)。
  // 完备性诚实口径:UPDATE/INSERT/DELETE 迁移由触发器镜像;INSERT OR REPLACE 的隐式 DELETE 不触发
  // 触发器(且不可全局翻 recursive_triggers——bom-version.ts 依赖现行 REPLACE 语义),该残余向量由
  // evaluate 读侧现算行内容哈希 fail-closed 兜底。C3 不得假设事件序完备;也不得对本事件表加
  // "close 必须先行"的序守卫——legacy 已关账行(触发器前存在)的首事件可以是 reopen(revision=1),
  // 经镜像制度下完整 reopen→close 后获得 revision 属预期毕业路径。
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_hcm_reconcile_identity_immutable
      BEFORE UPDATE ON reconcile_hospital_months
      WHEN NEW.partner_id <> OLD.partner_id OR NEW.service_month <> OLD.service_month
      BEGIN SELECT RAISE(ABORT, 'RECONCILE_MONTH_IDENTITY_IMMUTABLE'); END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_close_rev_close
      AFTER UPDATE ON reconcile_hospital_months
      WHEN NEW.status = '已关账' AND OLD.status IS NOT '已关账'
      BEGIN
        INSERT INTO hospital_cm_close_revision_events
          (partner_id, service_month, action, revision, row_id, status_snapshot, closed_at, closed_by, occurred_at)
        VALUES (
          NEW.partner_id, NEW.service_month, 'close',
          COALESCE((SELECT MAX(revision) FROM hospital_cm_close_revision_events
                    WHERE partner_id = NEW.partner_id AND service_month = NEW.service_month), 0) + 1,
          NEW.id, NEW.status, NEW.closed_at, NEW.closed_by, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_close_rev_reopen
      AFTER UPDATE ON reconcile_hospital_months
      WHEN OLD.status = '已关账' AND NEW.status IS NOT '已关账'
      BEGIN
        INSERT INTO hospital_cm_close_revision_events
          (partner_id, service_month, action, revision, row_id, status_snapshot, closed_at, closed_by, occurred_at)
        VALUES (
          NEW.partner_id, NEW.service_month, 'reopen',
          COALESCE((SELECT MAX(revision) FROM hospital_cm_close_revision_events
                    WHERE partner_id = NEW.partner_id AND service_month = NEW.service_month), 0) + 1,
          NEW.id, NEW.status, NEW.closed_at, NEW.closed_by, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_close_rev_insert_closed
      AFTER INSERT ON reconcile_hospital_months
      WHEN NEW.status = '已关账'
      BEGIN
        INSERT INTO hospital_cm_close_revision_events
          (partner_id, service_month, action, revision, row_id, status_snapshot, closed_at, closed_by, occurred_at)
        VALUES (
          NEW.partner_id, NEW.service_month, 'close',
          COALESCE((SELECT MAX(revision) FROM hospital_cm_close_revision_events
                    WHERE partner_id = NEW.partner_id AND service_month = NEW.service_month), 0) + 1,
          NEW.id, NEW.status, NEW.closed_at, NEW.closed_by, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_close_rev_delete_closed
      AFTER DELETE ON reconcile_hospital_months
      WHEN OLD.status = '已关账'
      BEGIN
        INSERT INTO hospital_cm_close_revision_events
          (partner_id, service_month, action, revision, row_id, status_snapshot, closed_at, closed_by, occurred_at)
        VALUES (
          OLD.partner_id, OLD.service_month, 'delete',
          COALESCE((SELECT MAX(revision) FROM hospital_cm_close_revision_events
                    WHERE partner_id = OLD.partner_id AND service_month = OLD.service_month), 0) + 1,
          OLD.id, OLD.status, OLD.closed_at, OLD.closed_by, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;
  `)
}

// ---------------------------------------------------------------------------
// source batch manifest
// ---------------------------------------------------------------------------

export interface SourceBatchFacts {
  rowsSha256: string
  rowCount: number
  serviceMonths: string[]
  partnerIds: string[]
}

/** 服务器对已落库 batch 行现算内容指纹(合同:"manifest hash 由服务器根据已保存事实计算")。
 *  ORDER BY 稳定业务键 id、显式列 allowlist、逐行数组序列化 → VACUUM/REINDEX 不改变结果。 */
export function computeSourceBatchFacts(db: HospitalCmPeriodEvidenceDb, sourceKind: PeriodEvidenceSourceKind, batchRef: string): SourceBatchFacts {
  if (!PERIOD_EVIDENCE_SOURCE_KINDS.includes(sourceKind)) {
    throw new HospitalCmPeriodEvidenceError('MANIFEST_SOURCE_KIND_INVALID', 400, `sourceKind 必须是 ${PERIOD_EVIDENCE_SOURCE_KINDS.join(' / ')}`)
  }
  const columns = SOURCE_ROW_COLUMNS[sourceKind]
  const rows = db.prepare(`
    SELECT ${columns.join(', ')}
    FROM ${sourceKind}
    WHERE import_batch = ?
    ORDER BY id
  `).all(batchRef) as Array<Record<string, unknown>>
  const serviceMonths = new Set<string>()
  const partnerIds = new Set<string>()
  const normalizedRows = rows.map((row) => {
    const month = row.service_month
    // 月归属采集只做无歧义补零归一('2026-5'→'2026-05',#168 同精神);
    // 归不进合法 YYYY-MM 的脏值原样保留——它进不了任何合法月的集合,行为等同无归属。
    if (typeof month === 'string' && month) {
      const padded = month.slice(0, 7).replace(/^(\d{4})-(\d)$/, '$1-0$2')
      serviceMonths.add(SERVICE_MONTH_RE.test(padded) ? padded : month.slice(0, 7))
    }
    const partner = row.partner_id
    if (typeof partner === 'string' && partner) partnerIds.add(partner)
    return columns.map((column) => normalizeCell(row[column]))
  })
  return {
    rowsSha256: sha256({ sourceKind, batchRef, columns, rows: normalizedRows }),
    rowCount: rows.length,
    serviceMonths: [...serviceMonths].sort(),
    partnerIds: [...partnerIds].sort(),
  }
}

const MANIFEST_INPUT_KEYS = ['sourceKind', 'batchRef', 'actor', 'reason', 'externalSourceRef', 'externalSourceHash', 'now'] as const

export function registerSourceBatchManifest(
  db: HospitalCmPeriodEvidenceDb,
  input: {
    sourceKind: PeriodEvidenceSourceKind
    batchRef: string
    actor: PeriodEvidenceActor
    reason: string
    externalSourceRef?: string | null
    externalSourceHash?: string | null
    now?: string
  },
): SourceBatchManifest {
  rejectUnsupportedKeys(input as Record<string, unknown>, MANIFEST_INPUT_KEYS)
  if (!PERIOD_EVIDENCE_SOURCE_KINDS.includes(input.sourceKind)) {
    throw new HospitalCmPeriodEvidenceError('MANIFEST_SOURCE_KIND_INVALID', 400, `sourceKind 必须是 ${PERIOD_EVIDENCE_SOURCE_KINDS.join(' / ')}`)
  }
  const sourceKind = input.sourceKind
  const batchRef = requireText(input.batchRef, 'MANIFEST_BATCH_REF_INVALID', 'batchRef', 120)
  const actor = normalizeActor(input.actor)
  const reason = requireText(input.reason, 'MANIFEST_REASON_INVALID', 'reason', 300)
  const hasRef = input.externalSourceRef != null
  const hasHash = input.externalSourceHash != null
  if (hasRef !== hasHash) {
    throw new HospitalCmPeriodEvidenceError('MANIFEST_EXTERNAL_EVIDENCE_UNPAIRED', 400, 'externalSourceRef 与 externalSourceHash 必须成对出现(操作者声明,机器未核验)')
  }
  const externalSourceRef = hasRef
    ? requireText(input.externalSourceRef, 'MANIFEST_EXTERNAL_REF_INVALID', 'externalSourceRef(使用脱敏引用,不落原始文件名/路径)', 200)
    : null
  const externalSourceHash = hasHash
    ? (() => {
        const value = String(input.externalSourceHash).trim()
        if (!SHA256_RE.test(value)) throw new HospitalCmPeriodEvidenceError('MANIFEST_EXTERNAL_HASH_INVALID', 400, 'externalSourceHash 必须是 64 位十六进制')
        return value.toLowerCase()
      })()
    : null
  const recordedAt = nowIso(input.now)

  db.exec('BEGIN IMMEDIATE')
  try {
    // 拿到写锁后才现算事实并复核来源稳定:防并发导入把 manifest 生在"读到一半"的快照上。
    const stateBefore = readCmSourceRevisions(db)
    const facts = computeSourceBatchFacts(db, sourceKind, batchRef)
    if (facts.rowCount === 0) {
      throw new HospitalCmPeriodEvidenceError('MANIFEST_BATCH_NOT_FOUND', 404, '该 batch 在源表中没有任何行,无事实可登记')
    }
    const stateAfter = readCmSourceRevisions(db)
    if (sha256(stateBefore) !== sha256(stateAfter)) {
      throw new HospitalCmPeriodEvidenceError('MANIFEST_SOURCE_CHANGED_DURING_REGISTER', 409, '登记期间源数据发生变化,本次未落 manifest;请重试')
    }
    const current = db.prepare(`
      SELECT id, version_no AS versionNo
      FROM hospital_cm_source_batch_manifests
      WHERE source_kind = ? AND batch_ref = ?
      ORDER BY version_no DESC
      LIMIT 1
    `).get(sourceKind, batchRef) as { id: string; versionNo: number } | undefined
    const versionNo = (current?.versionNo ?? 0) + 1
    const supersedesManifestId = current?.id ?? null
    const id = randomUUID()
    const serviceMonthsJson = JSON.stringify(facts.serviceMonths)
    const partnerIdsJson = JSON.stringify(facts.partnerIds)
    const manifestHash = sha256({
      sourceKind,
      batchRef,
      versionNo,
      rowsSha256: facts.rowsSha256,
      rowCount: facts.rowCount,
      serviceMonths: facts.serviceMonths,
      partnerIds: facts.partnerIds,
      externalSourceRef,
      externalSourceHash,
    })
    db.prepare(`
      INSERT INTO hospital_cm_source_batch_manifests
        (id, source_kind, batch_ref, version_no, rows_sha256, row_count, service_months_json, partner_ids_json,
         external_source_ref, external_source_hash, manifest_hash, supersedes_manifest_id,
         recorded_by_user_id, recorded_by_username, reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, sourceKind, batchRef, versionNo, facts.rowsSha256, facts.rowCount, serviceMonthsJson, partnerIdsJson,
      externalSourceRef, externalSourceHash, manifestHash, supersedesManifestId,
      actor.userId, actor.username, reason, recordedAt,
    )
    writeAuditLog(db, 'hospital_cm_period_evidence', 'manifest_register', id, {
      sourceKind,
      batchRef,
      versionNo,
      rowCount: facts.rowCount,
      rowsSha256: facts.rowsSha256,
      manifestHash,
      supersedesManifestId,
    }, actor.username)
    db.exec('COMMIT')
    const row = readManifestById(db, id)
    if (row == null) throw new HospitalCmPeriodEvidenceError('MANIFEST_READBACK_FAILED', 500, 'manifest 落库后读回失败')
    return row
  } catch (cause) {
    rollbackQuietly(db)
    throw cause
  }
}

function manifestFromRow(row: Record<string, unknown>): SourceBatchManifest {
  return {
    id: String(row.id),
    eventNumber: Number(row.event_number),
    sourceKind: row.source_kind as PeriodEvidenceSourceKind,
    batchRef: String(row.batch_ref),
    versionNo: Number(row.version_no),
    rowsSha256: String(row.rows_sha256),
    rowCount: Number(row.row_count),
    serviceMonths: JSON.parse(String(row.service_months_json)) as string[],
    partnerIds: JSON.parse(String(row.partner_ids_json)) as string[],
    externalSourceRef: row.external_source_ref == null ? null : String(row.external_source_ref),
    externalSourceHash: row.external_source_hash == null ? null : String(row.external_source_hash),
    manifestHash: String(row.manifest_hash),
    supersedesManifestId: row.supersedes_manifest_id == null ? null : String(row.supersedes_manifest_id),
    recordedByUserId: String(row.recorded_by_user_id),
    recordedByUsername: String(row.recorded_by_username),
    reason: String(row.reason),
    recordedAt: String(row.recorded_at),
  }
}

function readManifestById(db: HospitalCmPeriodEvidenceDb, id: string): SourceBatchManifest | null {
  const row = db.prepare('SELECT * FROM hospital_cm_source_batch_manifests WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row == null ? null : manifestFromRow(row)
}

export function readCurrentSourceBatchManifest(
  db: HospitalCmPeriodEvidenceDb,
  sourceKind: PeriodEvidenceSourceKind,
  batchRef: string,
): SourceBatchManifest | null {
  const row = db.prepare(`
    SELECT * FROM hospital_cm_source_batch_manifests
    WHERE source_kind = ? AND batch_ref = ?
    ORDER BY version_no DESC
    LIMIT 1
  `).get(sourceKind, batchRef) as Record<string, unknown> | undefined
  return row == null ? null : manifestFromRow(row)
}

// ---------------------------------------------------------------------------
// month scope snapshot(#182 共用合同)
// ---------------------------------------------------------------------------

const SCOPE_INPUT_KEYS = ['serviceMonth', 'accounts', 'rosterSourceRef', 'rosterSourceHash', 'status', 'actor', 'reason', 'now'] as const

/**
 * 登记月度账户范围快照。合同(与 #182 D2 共用,双方不得各建范围模型):
 * - accounts 元素 = partners.id 稳定标识(禁医院名称);财务侧编码→partner 映射归 D2 名册数据链,映射内容进 roster_source_hash。
 * - roster_source_hash = 版本化**名册内容** hash(账户标识+合作形态+当月活跃+金额完整度+证据状态的规范化序列)——
 *   上述任一内容变化 D2 必须发布新版本快照,否则旧周期证据不失效即为 D2 违约。
 * - #182 落地前本快照是调用者未核验声明;C3 消费必须显式携带该限定。
 */
export function saveMonthScopeSnapshot(
  db: HospitalCmPeriodEvidenceDb,
  input: {
    serviceMonth: string
    accounts: string[]
    rosterSourceRef: string
    rosterSourceHash: string
    status: Exclude<MonthScopeStatus, 'withdrawn'>
    actor: PeriodEvidenceActor
    reason: string
    now?: string
  },
): MonthScopeSnapshot {
  rejectUnsupportedKeys(input as Record<string, unknown>, SCOPE_INPUT_KEYS)
  const serviceMonth = normalizeServiceMonth(input.serviceMonth)
  if (input.status !== 'complete' && input.status !== 'incomplete') {
    throw new HospitalCmPeriodEvidenceError('SCOPE_STATUS_INVALID', 400, 'status 只能是 complete / incomplete(撤回走 withdrawMonthScopeSnapshot)')
  }
  if (!Array.isArray(input.accounts)) {
    throw new HospitalCmPeriodEvidenceError('SCOPE_ACCOUNTS_REQUIRED', 400, 'accounts 必须是账户稳定标识数组')
  }
  const accounts = [...new Set(input.accounts.map((account) => requireText(account, 'SCOPE_ACCOUNT_ID_INVALID', '账户标识', 80)))].sort()
  if (accounts.length === 0) {
    throw new HospitalCmPeriodEvidenceError('SCOPE_ACCOUNTS_REQUIRED', 400, 'accounts 不能为空(无名册月份不登记,读侧按缺失 fail-closed)')
  }
  const rosterSourceRef = requireText(input.rosterSourceRef, 'SCOPE_ROSTER_REF_INVALID', 'rosterSourceRef', 200)
  const rosterSourceHash = String(input.rosterSourceHash ?? '').trim().toLowerCase()
  if (!SHA256_RE.test(rosterSourceHash)) {
    throw new HospitalCmPeriodEvidenceError('SCOPE_ROSTER_HASH_INVALID', 400, 'rosterSourceHash 必须是 64 位十六进制(版本化名册内容 hash)')
  }
  const actor = normalizeActor(input.actor)
  const reason = requireText(input.reason, 'SCOPE_REASON_INVALID', 'reason', 300)
  return insertScopeVersion(db, { serviceMonth, accounts, rosterSourceRef, rosterSourceHash, status: input.status, actor, reason, recordedAt: nowIso(input.now) })
}

/** 撤回月度范围(名册源作废等):落一个 status=withdrawn 的新版本(accounts 复制当前视图留证),读侧一律 fail-closed。 */
export function withdrawMonthScopeSnapshot(
  db: HospitalCmPeriodEvidenceDb,
  input: { serviceMonth: string; actor: PeriodEvidenceActor; reason: string; now?: string },
): MonthScopeSnapshot {
  rejectUnsupportedKeys(input as Record<string, unknown>, ['serviceMonth', 'actor', 'reason', 'now'])
  const serviceMonth = normalizeServiceMonth(input.serviceMonth)
  const actor = normalizeActor(input.actor)
  const reason = requireText(input.reason, 'SCOPE_REASON_INVALID', 'reason', 300)
  const current = readCurrentMonthScope(db, serviceMonth)
  if (current == null) {
    throw new HospitalCmPeriodEvidenceError('SCOPE_SNAPSHOT_MISSING', 404, '该月尚无范围快照,无需撤回(缺失本身就是 fail-closed)')
  }
  return insertScopeVersion(db, {
    serviceMonth,
    accounts: current.accounts,
    rosterSourceRef: current.rosterSourceRef,
    rosterSourceHash: current.rosterSourceHash,
    status: 'withdrawn',
    actor,
    reason,
    recordedAt: nowIso(input.now),
  })
}

function insertScopeVersion(
  db: HospitalCmPeriodEvidenceDb,
  input: {
    serviceMonth: string
    accounts: string[]
    rosterSourceRef: string
    rosterSourceHash: string
    status: MonthScopeStatus
    actor: PeriodEvidenceActor
    reason: string
    recordedAt: string
  },
): MonthScopeSnapshot {
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = db.prepare(`
      SELECT version_no AS versionNo FROM hospital_cm_month_scope_snapshots
      WHERE service_month = ?
      ORDER BY version_no DESC
      LIMIT 1
    `).get(input.serviceMonth) as { versionNo: number } | undefined
    const versionNo = (current?.versionNo ?? 0) + 1
    const id = randomUUID()
    const scopeHash = sha256({ serviceMonth: input.serviceMonth, accounts: input.accounts, rosterSourceHash: input.rosterSourceHash })
    db.prepare(`
      INSERT INTO hospital_cm_month_scope_snapshots
        (id, service_month, version_no, status, roster_source_ref, roster_source_hash, accounts_json, scope_hash,
         recorded_by_user_id, recorded_by_username, reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.serviceMonth, versionNo, input.status, input.rosterSourceRef, input.rosterSourceHash,
      JSON.stringify(input.accounts), scopeHash, input.actor.userId, input.actor.username, input.reason, input.recordedAt,
    )
    writeAuditLog(db, 'hospital_cm_period_evidence', 'scope_snapshot_save', id, {
      serviceMonth: input.serviceMonth,
      versionNo,
      status: input.status,
      accountCount: input.accounts.length,
      scopeHash,
    }, input.actor.username)
    db.exec('COMMIT')
  } catch (cause) {
    rollbackQuietly(db)
    throw cause
  }
  const saved = readCurrentMonthScope(db, input.serviceMonth)
  if (saved == null) throw new HospitalCmPeriodEvidenceError('SCOPE_READBACK_FAILED', 500, '范围快照落库后读回失败')
  return saved
}

export function readCurrentMonthScope(db: HospitalCmPeriodEvidenceDb, serviceMonth: string): MonthScopeSnapshot | null {
  const month = normalizeServiceMonth(serviceMonth)
  const row = db.prepare(`
    SELECT * FROM hospital_cm_month_scope_snapshots
    WHERE service_month = ?
    ORDER BY version_no DESC
    LIMIT 1
  `).get(month) as Record<string, unknown> | undefined
  if (row == null) return null
  return {
    id: String(row.id),
    eventNumber: Number(row.event_number),
    serviceMonth: String(row.service_month),
    versionNo: Number(row.version_no),
    status: row.status as MonthScopeStatus,
    rosterSourceRef: String(row.roster_source_ref),
    rosterSourceHash: String(row.roster_source_hash),
    accounts: JSON.parse(String(row.accounts_json)) as string[],
    scopeHash: String(row.scope_hash),
    recordedByUserId: String(row.recorded_by_user_id),
    recordedByUsername: String(row.recorded_by_username),
    reason: String(row.reason),
    recordedAt: String(row.recorded_at),
  }
}

// ---------------------------------------------------------------------------
// close revision 读侧
// ---------------------------------------------------------------------------

/** reconcile 行内容哈希的列(除 created_at/updated_at 时间噪声外全部业务列):
 *  落实闭环文档"关账元数据变化"自动失效,并把"已关账行非 status 列改写"
 *  (含 reconcile-compute 事务外检查竞态的既有路径)兜进失效面。
 *  ⚠️ 给 reconcile_hospital_months 增删列必须同步本清单(同步锚测试对真 initializeDatabase 库断言)。 */
export const RECONCILE_ROW_HASH_COLUMNS = [
  'id', 'partner_id', 'partner_name', 'service_month', 'status', 'name_aligned', 'match_rate', 'match_status',
  'statement_ready', 'lis_ready', 'diff_count', 'pending_count', 'unmatched_count', 'confirmed_lab_revenue',
  'computed_at', 'completed_at', 'completed_by', 'closed_at', 'closed_by', 'reopened_at', 'reopen_reason',
] as const

export interface CloseRevisionState {
  fingerprint: string
  /** 求值域内"当前已关账但无任何镜像事件"的 partner(legacy)——读侧执法点:有它在场即不干净。 */
  missingCloseEventPartnerIds: string[]
  /** reconcile 列集与行哈希清单漂移(加列未同步/旧库缺列)→ close 维度整体不可信,evaluate 必 fail-closed。 */
  schemaDrift: boolean
}

/** 返回 null=列集一致;否则返回实际列集(排序)供告警。固定 1 条 PRAGMA,不随院数变化。 */
function detectReconcileSchemaDrift(db: HospitalCmPeriodEvidenceDb): string[] | null {
  const actual = (db.prepare('PRAGMA table_info(reconcile_hospital_months)').all() as Array<{ name: string }>)
    .map((column) => column.name)
    .sort()
  const expected = [...RECONCILE_ROW_HASH_COLUMNS, 'created_at', 'updated_at'].sort()
  return JSON.stringify(actual) === JSON.stringify(expected) ? null : actual
}

/** 当月关账 revision 组合指纹。求值域 = 申报 scope ∪ 该月所有实际有行的 partner
 *  (被剔出申报 scope 的账户 close/reopen 不再对证据隐形)。固定 2 条查询,与院数无关。 */
export function currentCloseRevisionState(
  db: HospitalCmPeriodEvidenceDb,
  serviceMonth: string,
  scopeAccounts: readonly string[],
): CloseRevisionState {
  const month = normalizeServiceMonth(serviceMonth)
  // 列集漂移(加列未同步清单/旧库缺列)时不读行(缺列 SELECT 会炸)、不装懂:
  // 指纹退化为漂移标记 → 与任何 run 冻结值都失配 → 周期证据整体 fail-closed。
  const driftColumns = detectReconcileSchemaDrift(db)
  if (driftColumns != null) {
    return {
      fingerprint: sha256({ serviceMonth: month, schemaDrift: true, columns: driftColumns }),
      missingCloseEventPartnerIds: [],
      schemaDrift: true,
    }
  }
  const rows = db.prepare(`
    SELECT ${RECONCILE_ROW_HASH_COLUMNS.join(', ')}
    FROM reconcile_hospital_months
    WHERE service_month = ?
    ORDER BY partner_id
  `).all(month) as Array<Record<string, unknown>>
  const latestEvents = db.prepare(`
    SELECT partner_id AS partnerId, MAX(revision) AS revision
    FROM hospital_cm_close_revision_events
    WHERE service_month = ?
    GROUP BY partner_id
  `).all(month) as Array<{ partnerId: string; revision: number }>
  const revisionByPartner = new Map(latestEvents.map((event) => [event.partnerId, Number(event.revision)]))
  const rowByPartner = new Map(rows.map((row) => [String(row.partner_id), row]))
  const domain = [...new Set([...scopeAccounts, ...rowByPartner.keys()])].sort()
  const missingCloseEventPartnerIds: string[] = []
  const tuples = domain.map((partnerId) => {
    const row = rowByPartner.get(partnerId)
    const revision = revisionByPartner.get(partnerId) ?? null
    const status = row == null ? null : String(row.status)
    if (row != null && status === '已关账' && revision == null) missingCloseEventPartnerIds.push(partnerId)
    return {
      partnerId,
      hasRow: row != null,
      status,
      revision,
      rowContentHash: row == null ? null : sha256(RECONCILE_ROW_HASH_COLUMNS.map((column) => normalizeCell(row[column]))),
    }
  })
  return {
    fingerprint: sha256({ serviceMonth: month, tuples }),
    missingCloseEventPartnerIds,
    schemaDrift: false,
  }
}

// ---------------------------------------------------------------------------
// 指纹派生
// ---------------------------------------------------------------------------

function readCmSourceRevisions(db: HospitalCmPeriodEvidenceDb): Record<string, number> {
  const state = readHospitalCmReadinessSourceState(db)
  return Object.fromEntries(HOSPITAL_CM_CM_SOURCE_TABLES.map((table) => [table, state.revisions[table]]))
}

/** CM 相关 7 表子集指纹(表级全局跨月 = 有意 fail-closed:后继月新增收入撤销旧周期证据;
 *  C3 须配自动重跑策略。库存三表见 HOSPITAL_CM_CM_SOURCE_TABLES 注释)。 */
export function cmSourceSubsetFingerprint(db: HospitalCmPeriodEvidenceDb): string {
  const state = readHospitalCmReadinessSourceState(db)
  return sha256({
    revisions: Object.fromEntries(HOSPITAL_CM_CM_SOURCE_TABLES.map((table) => [table, state.revisions[table]])),
    periodSchemaFingerprint: state.periodSchemaFingerprint,
    costDataSchemaFingerprint: state.costDataSchemaFingerprint,
  })
}

/**
 * 周期 profile 指纹:成本/公式/拆分/固定池口径的组合签名。
 * - 常量/行为签名取 **live** 值(state.constantFingerprint = sha256(currentHospitalCmConstantManifest());
 *   公式代码漂移即使不 bump 版本也会翻 manifest)。
 * - 拆分口径槽只绑内容版本代理(SPLIT_FORMULA_VERSION + basisVersion),**不绑认账 state**——
 *   issue C2 明文"绑内容/行为 hash 而非认账状态位";认账状态由 C2 做 readiness 硬门,不是周期失效维度。
 *   C2 把本槽换成版本化内容/行为 hash 时必须 bump HOSPITAL_CM_PROFILE_RECIPE_VERSION。
 * - 已知盲窗(C2 职责):拆分公式函数体变更且不 bump 版本、不改常量时本指纹不动。
 * - fixed-pool 月度指纹内嵌 denominator owner 轴:owner 改派/停用翻全月 profile,属有意 fail-closed。
 */
export function computePeriodProfileFingerprint(db: HospitalCmPeriodEvidenceDb, serviceMonth: string): string {
  const month = normalizeServiceMonth(serviceMonth)
  const state = readHospitalCmReadinessSourceState(db)
  const caliber = splitCaliberRatification()
  return sha256({
    recipeVersion: HOSPITAL_CM_PROFILE_RECIPE_VERSION,
    hospitalCmFormulaVersion: HOSPITAL_CM_FORMULA_VERSION,
    constantManifestFingerprint: state.constantFingerprint,
    splitFormulaVersion: SPLIT_FORMULA_VERSION,
    splitCaliberBasisVersion: caliber.basisVersion,
    fixedPoolControlFingerprint: readHospitalCmFixedPoolControlFingerprint(db, month),
  })
}

/**
 * 该月相关 manifest(每 batch 取最新版本)的组合指纹。单条查询 + JS 过滤(manifest 行数 = batch 链数,量级小)。
 *
 * 月归属口径:case_revenue 行自带 service_month,可精确按月过滤;lis_cases/lis_case_markers 的生产表
 * **没有 service_month 列**(月份语义在 operate_time / 经病例 join),而月键派生正是 #163/#168 的战场——
 * C1 不得另造第三种提取逻辑。因此**无月归属(serviceMonths 为空)的 manifest 一律计入每个月的集合**:
 * lis 类 manifest 的任何新版本都会翻所有月的 MANIFEST_SET_CHANGED(有意过度失效,与 source_state
 * 表级全局跨月的 fail-closed 立场一致);待 #163 阶段 2 的同源月键落地后由 C3 收窄为按月归属。
 */
export function manifestSetFingerprint(db: HospitalCmPeriodEvidenceDb, serviceMonth: string): string {
  const month = normalizeServiceMonth(serviceMonth)
  const rows = db.prepare(`
    SELECT source_kind AS sourceKind, batch_ref AS batchRef, version_no AS versionNo,
           manifest_hash AS manifestHash, service_months_json AS serviceMonthsJson
    FROM hospital_cm_source_batch_manifests AS manifest
    WHERE version_no = (
      SELECT MAX(newer.version_no)
      FROM hospital_cm_source_batch_manifests AS newer
      WHERE newer.source_kind = manifest.source_kind AND newer.batch_ref = manifest.batch_ref
    )
    ORDER BY source_kind, batch_ref
  `).all() as Array<{ sourceKind: string; batchRef: string; versionNo: number; manifestHash: string; serviceMonthsJson: string }>
  const relevant = rows
    .filter((row) => {
      try {
        const months = JSON.parse(row.serviceMonthsJson) as string[]
        return months.length === 0 || months.includes(month)
      } catch {
        // 解析失败的 manifest 行按"无月归属"处理 → 计入每个月(fail-closed,不静默丢证据)
        return true
      }
    })
    .map((row) => ({ sourceKind: row.sourceKind, batchRef: row.batchRef, versionNo: Number(row.versionNo), manifestHash: row.manifestHash }))
  return sha256({ serviceMonth: month, manifests: relevant })
}

// ---------------------------------------------------------------------------
// validation run 读侧(写函数归 C3——结论只能由服务器检查器产生)
// ---------------------------------------------------------------------------

export function listPeriodValidationRuns(db: HospitalCmPeriodEvidenceDb, serviceMonth?: string): PeriodValidationRunRow[] {
  const rows = (serviceMonth == null
    ? db.prepare('SELECT * FROM hospital_cm_period_validation_runs ORDER BY run_number').all()
    : db.prepare('SELECT * FROM hospital_cm_period_validation_runs WHERE service_month = ? ORDER BY run_number').all(normalizeServiceMonth(serviceMonth))
  ) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    runNumber: Number(row.run_number),
    id: String(row.id),
    serviceMonth: String(row.service_month),
    scopeHash: String(row.scope_hash),
    scopeSnapshotEventNumber: Number(row.scope_snapshot_event_number),
    closeRevisionFingerprint: String(row.close_revision_fingerprint),
    sourceStateFingerprint: String(row.source_state_fingerprint),
    profileFingerprint: String(row.profile_fingerprint),
    manifestSetFingerprint: String(row.manifest_set_fingerprint),
    profileRecipeVersion: String(row.profile_recipe_version),
    overallStatus: row.overall_status as PeriodValidationRunRow['overallStatus'],
    startedAt: String(row.started_at),
    completedAt: String(row.completed_at),
    triggeredByUserId: String(row.triggered_by_user_id),
    triggeredByUsername: String(row.triggered_by_username),
    triggerReasonCode: String(row.trigger_reason_code),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorSummary: row.error_summary == null ? null : String(row.error_summary),
  }))
}

export interface PeriodValidationVerdict {
  current: boolean
  invalidationCodes: string[]
}

/**
 * 读侧失效判定:证据永不删除,逐维现算比对。任一维度失配 → run 失效(fail-closed)。
 * 固定查询数,与院数/月数无关(查询预算测试锁定)。
 */
export function evaluatePeriodValidationRun(db: HospitalCmPeriodEvidenceDb, run: PeriodValidationRunRow): PeriodValidationVerdict {
  const codes: string[] = []
  const scope = readCurrentMonthScope(db, run.serviceMonth)
  if (scope == null) {
    codes.push('SCOPE_SNAPSHOT_MISSING')
  } else {
    if (scope.status !== 'complete') codes.push('SCOPE_SNAPSHOT_NOT_COMPLETE')
    if (scope.eventNumber !== run.scopeSnapshotEventNumber || scope.scopeHash !== run.scopeHash) {
      // 严格失效:绑具体版本(event_number),内容相同的重发同样使旧证据失效(宁严勿宽)
      codes.push('SCOPE_SNAPSHOT_CHANGED')
    }
  }
  const evaluationAccounts = scope?.accounts ?? []
  const close = currentCloseRevisionState(db, run.serviceMonth, evaluationAccounts)
  if (close.schemaDrift) codes.push('RECONCILE_SCHEMA_DRIFT')
  if (close.missingCloseEventPartnerIds.length > 0) codes.push('CLOSE_REVISION_MISSING')
  if (close.fingerprint !== run.closeRevisionFingerprint) codes.push('CLOSE_REVISION_CHANGED')
  try {
    if (cmSourceSubsetFingerprint(db) !== run.sourceStateFingerprint) codes.push('SOURCE_STATE_CHANGED')
  } catch {
    codes.push('SOURCE_STATE_UNAVAILABLE')
  }
  if (run.profileRecipeVersion !== HOSPITAL_CM_PROFILE_RECIPE_VERSION) {
    // 配方升级与"口径真变了"分开报告,不叠报 PROFILE_CHANGED(两种失效语义不可混淆)
    codes.push('PROFILE_RECIPE_UPGRADED')
  } else {
    try {
      if (computePeriodProfileFingerprint(db, run.serviceMonth) !== run.profileFingerprint) codes.push('PROFILE_CHANGED')
    } catch {
      codes.push('PROFILE_UNAVAILABLE')
    }
  }
  if (manifestSetFingerprint(db, run.serviceMonth) !== run.manifestSetFingerprint) codes.push('MANIFEST_SET_CHANGED')
  return { current: codes.length === 0, invalidationCodes: codes }
}

export interface PeriodCandidate {
  partnerId: string
  serviceMonth: string
  status: string
  revision: number | null
  /** C1 没有 VERIFIED 概念:legacy 与新关账月都只是待验证 candidate;状态机归 C3。 */
  verified: false
}

export function listPeriodCandidates(db: HospitalCmPeriodEvidenceDb): PeriodCandidate[] {
  const rows = db.prepare(`
    SELECT months.partner_id AS partnerId, months.service_month AS serviceMonth, months.status AS status,
           (SELECT MAX(events.revision)
            FROM hospital_cm_close_revision_events AS events
            WHERE events.partner_id = months.partner_id AND events.service_month = months.service_month) AS revision
    FROM reconcile_hospital_months AS months
    WHERE months.status = '已关账'
    ORDER BY months.service_month, months.partner_id
  `).all() as Array<{ partnerId: string; serviceMonth: string; status: string; revision: number | null }>
  return rows.map((row) => ({
    partnerId: row.partnerId,
    serviceMonth: row.serviceMonth,
    status: row.status,
    revision: row.revision == null ? null : Number(row.revision),
    verified: false,
  }))
}
