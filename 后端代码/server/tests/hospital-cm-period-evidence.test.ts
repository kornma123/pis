import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  HOSPITAL_CM_PROFILE_RECIPE_VERSION,
  HospitalCmPeriodEvidenceError,
  RECONCILE_ROW_HASH_COLUMNS,
  computePeriodProfileFingerprint,
  computeSourceBatchFacts,
  cmSourceSubsetFingerprint,
  currentCloseRevisionState,
  ensureHospitalCmPeriodEvidenceSchema,
  evaluatePeriodValidationRun,
  listPeriodCandidates,
  listPeriodValidationRuns,
  manifestSetFingerprint,
  readCurrentMonthScope,
  readCurrentSourceBatchManifest,
  registerSourceBatchManifest,
  saveMonthScopeSnapshot,
  withdrawMonthScopeSnapshot,
} from '../src/utils/hospital-cm-period-evidence.js'
import { ensureHospitalCmReadinessSchema } from '../src/utils/hospital-cm-readiness-runtime.js'

const NOW = '2026-07-14T08:00:00.000Z'
const ACTOR = { userId: 'U-EVIDENCE', username: 'evidence-owner' }
const HEX64 = 'a'.repeat(64)

/** C1 隔离库:10 张 A 源表(A 的 revision 触发器要求在场)+ reconcile_hospital_months + abc_audit_logs。 */
function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE materials (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
      category_id TEXT, status INTEGER NOT NULL DEFAULT 1, is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE inventory (
      id TEXT PRIMARY KEY, material_id TEXT NOT NULL, stock REAL NOT NULL DEFAULT 0,
      locked_stock REAL NOT NULL DEFAULT 0, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE batches (
      id TEXT PRIMARY KEY, material_id TEXT NOT NULL, batch_no TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0, remaining REAL NOT NULL DEFAULT 0,
      inbound_id TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE case_revenue (
      id TEXT PRIMARY KEY, case_no TEXT NOT NULL, partner_id TEXT, partner_name TEXT, doc_no TEXT,
      gross_amount REAL NOT NULL DEFAULT 0, net_amount REAL NOT NULL DEFAULT 0,
      discount_rate REAL NOT NULL DEFAULT 0, service_month TEXT, line_count INTEGER NOT NULL DEFAULT 0,
      import_batch TEXT, config_version INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE lis_cases (
      id TEXT PRIMARY KEY, case_no TEXT NOT NULL, partner_id TEXT, project_id TEXT, project_name TEXT,
      operator TEXT, operate_time TEXT, status TEXT NOT NULL DEFAULT 'normal', import_batch TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE lis_case_markers (
      id TEXT PRIMARY KEY, case_no TEXT NOT NULL, partner_id TEXT, marker_name TEXT NOT NULL,
      advice_type TEXT, wax_no TEXT, section_no TEXT, import_batch TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE antibodies (id TEXT PRIMARY KEY);
    CREATE TABLE antibody_aliases (id TEXT PRIMARY KEY);
    CREATE TABLE ihc_cost_params (param_key TEXT PRIMARY KEY, value REAL);
    CREATE TABLE special_stain_kits (id TEXT PRIMARY KEY);
    CREATE TABLE abc_audit_logs (
      id TEXT PRIMARY KEY, module TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT,
      detail TEXT, operator TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE reconcile_hospital_months (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      partner_name TEXT,
      service_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '待复核',
      name_aligned INTEGER NOT NULL DEFAULT 0,
      match_rate DECIMAL(10, 6) DEFAULT 0,
      match_status TEXT,
      statement_ready INTEGER NOT NULL DEFAULT 0,
      lis_ready INTEGER NOT NULL DEFAULT 0,
      diff_count INTEGER NOT NULL DEFAULT 0,
      pending_count INTEGER NOT NULL DEFAULT 0,
      unmatched_count INTEGER NOT NULL DEFAULT 0,
      confirmed_lab_revenue DECIMAL(18, 4),
      computed_at DATETIME,
      completed_at DATETIME,
      completed_by TEXT,
      closed_at DATETIME,
      closed_by TEXT,
      reopened_at DATETIME,
      reopen_reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(partner_id, service_month)
    );
  `)
  ensureHospitalCmReadinessSchema(db)
  ensureHospitalCmPeriodEvidenceSchema(db)
  return db
}

function seedRevenueBatch(db: DatabaseSync, batchRef: string, opts: { month?: string; partnerId?: string; rows?: number } = {}) {
  const month = opts.month ?? '2026-05'
  const partnerId = opts.partnerId ?? 'P-1'
  const rows = opts.rows ?? 2
  const insert = db.prepare(`
    INSERT INTO case_revenue (id, case_no, partner_id, partner_name, doc_no, gross_amount, net_amount, discount_rate, service_month, line_count, import_batch, config_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (let index = 0; index < rows; index += 1) {
    insert.run(`${batchRef}-ROW-${index}`, `C${index}`, partnerId, '测试院', `DOC-${index}`, 100 + index, 90 + index, 0.9, month, 1, batchRef, 1)
  }
}

function insertReconcileRow(db: DatabaseSync, id: string, partnerId: string, month: string, status = '待复核') {
  db.prepare(`
    INSERT INTO reconcile_hospital_months (id, partner_id, partner_name, service_month, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, partnerId, '测试院', month, status)
}

function closeMonth(db: DatabaseSync, id: string, closedBy = 'finance-a') {
  db.prepare(`
    UPDATE reconcile_hospital_months
    SET status = '已关账', closed_at = CURRENT_TIMESTAMP, closed_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(closedBy, id)
}

function reopenMonth(db: DatabaseSync, id: string) {
  db.prepare(`
    UPDATE reconcile_hospital_months
    SET status = '复核完成', reopened_at = CURRENT_TIMESTAMP, reopen_reason = '补片重算', closed_at = NULL, closed_by = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id)
}

function closeEvents(db: DatabaseSync, partnerId: string, month: string) {
  return db.prepare(`
    SELECT action, revision, status_snapshot AS statusSnapshot, closed_by AS closedBy
    FROM hospital_cm_close_revision_events
    WHERE partner_id = ? AND service_month = ?
    ORDER BY revision
  `).all(partnerId, month) as Array<{ action: string; revision: number; statusSnapshot: string | null; closedBy: string | null }>
}

function saveScope(db: DatabaseSync, month = '2026-05', accounts: string[] = ['P-1'], status: 'complete' | 'incomplete' = 'complete') {
  return saveMonthScopeSnapshot(db, {
    serviceMonth: month,
    accounts,
    rosterSourceRef: 'roster://finance/2026-05/v1',
    rosterSourceHash: HEX64,
    status,
    actor: ACTOR,
    reason: '测试登记',
    now: NOW,
  })
}

/** 造一条 run(C1 不导出写函数:结论只能由 C3 检查器产生;测试用裸 INSERT 验 DDL 与读侧)。 */
function insertRun(db: DatabaseSync, month = '2026-05', overrides: Record<string, unknown> = {}) {
  const scope = readCurrentMonthScope(db, month)
  if (scope == null) throw new Error('test setup requires scope snapshot')
  const close = currentCloseRevisionState(db, month, scope.accounts)
  const row = {
    id: `RUN-${Math.random().toString(36).slice(2, 10)}`,
    service_month: month,
    scope_hash: scope.scopeHash,
    scope_snapshot_event_number: scope.eventNumber,
    close_revision_fingerprint: close.fingerprint,
    source_state_fingerprint: cmSourceSubsetFingerprint(db),
    profile_fingerprint: computePeriodProfileFingerprint(db, month),
    manifest_set_fingerprint: manifestSetFingerprint(db, month),
    profile_recipe_version: HOSPITAL_CM_PROFILE_RECIPE_VERSION,
    overall_status: 'passed',
    started_at: NOW,
    completed_at: NOW,
    triggered_by_user_id: ACTOR.userId,
    triggered_by_username: ACTOR.username,
    trigger_reason_code: 'PERIOD_REVIEW',
    ...overrides,
  }
  db.prepare(`
    INSERT INTO hospital_cm_period_validation_runs
      (id, service_month, scope_hash, scope_snapshot_event_number, close_revision_fingerprint,
       source_state_fingerprint, profile_fingerprint, manifest_set_fingerprint, profile_recipe_version,
       overall_status, started_at, completed_at, triggered_by_user_id, triggered_by_username, trigger_reason_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.service_month, row.scope_hash, row.scope_snapshot_event_number, row.close_revision_fingerprint,
    row.source_state_fingerprint, row.profile_fingerprint, row.manifest_set_fingerprint, row.profile_recipe_version,
    row.overall_status, row.started_at, row.completed_at, row.triggered_by_user_id, row.triggered_by_username, row.trigger_reason_code,
  )
  return row
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(HospitalCmPeriodEvidenceError)
    expect((error as HospitalCmPeriodEvidenceError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code} but call succeeded`)
}

describe('C1 · append-only 硬化(每表 × 每 UNIQUE 键 REPLACE 探针)', () => {
  it('五张证据表 UPDATE/DELETE 全拒', () => {
    const db = createDb()
    seedRevenueBatch(db, 'STMT-1')
    registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '登记', now: NOW })
    saveScope(db)
    insertReconcileRow(db, 'RHM-1', 'P-1', '2026-05')
    closeMonth(db, 'RHM-1')
    insertRun(db)
    db.prepare(`
      INSERT INTO hospital_cm_period_validation_checks (run_id, check_key, status, result_code, summary_json, input_fingerprint, observed_at)
      SELECT id, 'scope_complete', 'passed', 'OK', '{"evidenceScope":"aggregate_only"}', ?, ? FROM hospital_cm_period_validation_runs LIMIT 1
    `).run(HEX64, NOW)

    const probes: Array<[string, string]> = [
      ['hospital_cm_source_batch_manifests', `UPDATE hospital_cm_source_batch_manifests SET reason = 'x'`],
      ['hospital_cm_source_batch_manifests', `DELETE FROM hospital_cm_source_batch_manifests`],
      ['hospital_cm_month_scope_snapshots', `UPDATE hospital_cm_month_scope_snapshots SET reason = 'x'`],
      ['hospital_cm_month_scope_snapshots', `DELETE FROM hospital_cm_month_scope_snapshots`],
      ['hospital_cm_close_revision_events', `UPDATE hospital_cm_close_revision_events SET status_snapshot = 'x'`],
      ['hospital_cm_close_revision_events', `DELETE FROM hospital_cm_close_revision_events`],
      ['hospital_cm_period_validation_runs', `UPDATE hospital_cm_period_validation_runs SET overall_status = 'failed'`],
      ['hospital_cm_period_validation_runs', `DELETE FROM hospital_cm_period_validation_runs`],
      ['hospital_cm_period_validation_checks', `UPDATE hospital_cm_period_validation_checks SET status = 'failed'`],
      ['hospital_cm_period_validation_checks', `DELETE FROM hospital_cm_period_validation_checks`],
    ]
    for (const [table, sql] of probes) {
      expect(() => db.exec(sql), `${table}: ${sql}`).toThrow(/APPEND_ONLY|EVIDENCE/)
    }
  })

  it('INSERT OR REPLACE 经每一个 UNIQUE 键都被 duplicate guard 拒绝(漏键=静默改写)', () => {
    const db = createDb()
    seedRevenueBatch(db, 'STMT-1')
    const manifest = registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '登记', now: NOW })
    const scope = saveScope(db)
    insertReconcileRow(db, 'RHM-1', 'P-1', '2026-05')
    closeMonth(db, 'RHM-1')
    const run = insertRun(db)
    db.prepare(`
      INSERT INTO hospital_cm_period_validation_checks (run_id, check_key, status, result_code, summary_json, input_fingerprint, observed_at)
      VALUES (?, 'scope_complete', 'passed', 'OK', '{}', ?, ?)
    `).run(run.id, HEX64, NOW)

    const replaceProbes: Array<[string, string, unknown[]]> = [
      // manifests: id 键 / (source_kind,batch_ref,version_no) 键
      ['manifests.id', `INSERT OR REPLACE INTO hospital_cm_source_batch_manifests
        (id, source_kind, batch_ref, version_no, rows_sha256, row_count, service_months_json, partner_ids_json, manifest_hash, recorded_by_user_id, recorded_by_username, reason, recorded_at)
        VALUES (?, 'case_revenue', 'OTHER', 1, ?, 0, '[]', '[]', ?, 'u', 'n', 'r', ?)`, [manifest.id, HEX64, HEX64, NOW]],
      ['manifests.natural', `INSERT OR REPLACE INTO hospital_cm_source_batch_manifests
        (id, source_kind, batch_ref, version_no, rows_sha256, row_count, service_months_json, partner_ids_json, manifest_hash, recorded_by_user_id, recorded_by_username, reason, recorded_at)
        VALUES ('M-NEW', 'case_revenue', 'STMT-1', 1, ?, 0, '[]', '[]', ?, 'u', 'n', 'r', ?)`, [HEX64, HEX64, NOW]],
      ['scope.id', `INSERT OR REPLACE INTO hospital_cm_month_scope_snapshots
        (id, service_month, version_no, status, roster_source_ref, roster_source_hash, accounts_json, scope_hash, recorded_by_user_id, recorded_by_username, reason, recorded_at)
        VALUES (?, '2026-06', 1, 'complete', 'r', ?, '["P-9"]', ?, 'u', 'n', 'r', ?)`, [scope.id, HEX64, HEX64, NOW]],
      ['scope.natural', `INSERT OR REPLACE INTO hospital_cm_month_scope_snapshots
        (id, service_month, version_no, status, roster_source_ref, roster_source_hash, accounts_json, scope_hash, recorded_by_user_id, recorded_by_username, reason, recorded_at)
        VALUES ('S-NEW', '2026-05', 1, 'complete', 'r', ?, '["P-9"]', ?, 'u', 'n', 'r', ?)`, [HEX64, HEX64, NOW]],
      ['close_events.natural', `INSERT OR REPLACE INTO hospital_cm_close_revision_events
        (partner_id, service_month, action, revision, row_id, status_snapshot, closed_at, closed_by, occurred_at)
        VALUES ('P-1', '2026-05', 'close', 1, 'RHM-1', '已关账', NULL, 'attacker', ?)`, [NOW]],
      ['runs.id', `INSERT OR REPLACE INTO hospital_cm_period_validation_runs
        (id, service_month, scope_hash, scope_snapshot_event_number, close_revision_fingerprint, source_state_fingerprint, profile_fingerprint, manifest_set_fingerprint, profile_recipe_version, overall_status, started_at, completed_at, triggered_by_user_id, triggered_by_username, trigger_reason_code)
        VALUES (?, '2026-05', ?, 1, ?, ?, ?, ?, 'v', 'passed', ?, ?, 'u', 'n', 'PERIOD_REVIEW')`, [run.id, HEX64, HEX64, HEX64, HEX64, HEX64, NOW, NOW]],
      ['checks.pk', `INSERT OR REPLACE INTO hospital_cm_period_validation_checks
        (run_id, check_key, status, result_code, summary_json, input_fingerprint, observed_at)
        VALUES (?, 'scope_complete', 'failed', 'TAMPERED', '{}', ?, ?)`, [run.id, HEX64, NOW]],
      // PK(AUTOINCREMENT)腿:显式给已存在的 event_number/run_number、natural 键取不存在组合,
      // 确保只有 PK 子句能拦(否则探针被 natural 子句代偿,测不到目标子句)。
      ['manifests.event_number', `INSERT OR REPLACE INTO hospital_cm_source_batch_manifests
        (event_number, id, source_kind, batch_ref, version_no, rows_sha256, row_count, service_months_json, partner_ids_json, manifest_hash, recorded_by_user_id, recorded_by_username, reason, recorded_at)
        VALUES (?, 'M-EVIL', 'lis_cases', 'OTHER-REF', 1, ?, 1, '[]', '[]', ?, 'u', 'n', 'r', ?)`, [manifest.eventNumber, HEX64, HEX64, NOW]],
      ['scope.event_number', `INSERT OR REPLACE INTO hospital_cm_month_scope_snapshots
        (event_number, id, service_month, version_no, status, roster_source_ref, roster_source_hash, accounts_json, scope_hash, recorded_by_user_id, recorded_by_username, reason, recorded_at)
        VALUES (?, 'S-EVIL', '2026-09', 1, 'complete', 'r', ?, '["P-9"]', ?, 'u', 'n', 'r', ?)`, [scope.eventNumber, HEX64, HEX64, NOW]],
      ['close_events.event_number', `INSERT OR REPLACE INTO hospital_cm_close_revision_events
        (event_number, partner_id, service_month, action, revision, row_id, status_snapshot, closed_at, closed_by, occurred_at)
        VALUES ((SELECT MIN(event_number) FROM hospital_cm_close_revision_events), 'P-EVIL', '2026-09', 'close', 7, 'X', '已关账', NULL, 'attacker', ?)`, [NOW]],
      ['runs.run_number', `INSERT OR REPLACE INTO hospital_cm_period_validation_runs
        (run_number, id, service_month, scope_hash, scope_snapshot_event_number, close_revision_fingerprint, source_state_fingerprint, profile_fingerprint, manifest_set_fingerprint, profile_recipe_version, overall_status, started_at, completed_at, triggered_by_user_id, triggered_by_username, trigger_reason_code)
        VALUES ((SELECT MIN(run_number) FROM hospital_cm_period_validation_runs), 'RUN-EVIL', '2026-09', ?, 1, ?, ?, ?, ?, 'v', 'passed', ?, ?, 'u', 'n', 'PERIOD_REVIEW')`, [HEX64, HEX64, HEX64, HEX64, HEX64, NOW, NOW]],
    ]
    for (const [label, sql, params] of replaceProbes) {
      expect(() => db.prepare(sql).run(...(params as never[])), label).toThrow(/APPEND_ONLY|EVIDENCE|SEQUENCE/)
    }
    // checks 表是 WITHOUT ROWID:隐藏 rowid 不存在,面板实证过的 rowid-REPLACE 改写向量结构性消失
    expect(() => db.prepare(`INSERT OR REPLACE INTO hospital_cm_period_validation_checks
      (rowid, run_id, check_key, status, result_code, summary_json, input_fingerprint, observed_at)
      VALUES (1, ?, 'k-tampered', 'failed', 'TAMPERED', '{}', ?, ?)`).run(run.id, HEX64, NOW)).toThrow()
    const checkRow = db.prepare(`SELECT status, result_code FROM hospital_cm_period_validation_checks WHERE run_id = ? AND check_key = 'scope_complete'`).get(run.id) as { status: string; result_code: string }
    expect(checkRow).toEqual({ status: 'passed', result_code: 'OK' })
  })

  it('版本链序守卫:裸 INSERT 越号 / v1 带 supersedes / 伪 supersedes 一律 DB 级拒绝', () => {
    const db = createDb()
    seedRevenueBatch(db, 'STMT-1')
    const v1 = registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '首登', now: NOW })
    saveScope(db)
    // manifests:越号
    expect(() => db.prepare(`INSERT INTO hospital_cm_source_batch_manifests
      (id, source_kind, batch_ref, version_no, rows_sha256, row_count, service_months_json, partner_ids_json, manifest_hash, recorded_by_user_id, recorded_by_username, reason, recorded_at)
      VALUES ('M-FORGE', 'case_revenue', 'STMT-1', 99, ?, 1, '[]', '[]', ?, 'u', 'n', 'r', ?)`).run(HEX64, HEX64, NOW)).toThrow(/SEQUENCE_INVALID/)
    // manifests:v>1 但 supersedes 不指向现任
    expect(() => db.prepare(`INSERT INTO hospital_cm_source_batch_manifests
      (id, source_kind, batch_ref, version_no, rows_sha256, row_count, service_months_json, partner_ids_json, manifest_hash, supersedes_manifest_id, recorded_by_user_id, recorded_by_username, reason, recorded_at)
      VALUES ('M-FORGE2', 'case_revenue', 'STMT-1', 2, ?, 1, '[]', '[]', ?, 'M-NOT-EXIST', 'u', 'n', 'r', ?)`).run(HEX64, HEX64, NOW)).toThrow(/SEQUENCE_INVALID/)
    // manifests:v1 带 supersedes
    expect(() => db.prepare(`INSERT INTO hospital_cm_source_batch_manifests
      (id, source_kind, batch_ref, version_no, rows_sha256, row_count, service_months_json, partner_ids_json, manifest_hash, supersedes_manifest_id, recorded_by_user_id, recorded_by_username, reason, recorded_at)
      VALUES ('M-FORGE3', 'case_revenue', 'NEW-REF', 1, ?, 1, '[]', '[]', ?, ?, 'u', 'n', 'r', ?)`).run(HEX64, HEX64, v1.id, NOW)).toThrow(/SEQUENCE_INVALID/)
    // scope:越号
    expect(() => db.prepare(`INSERT INTO hospital_cm_month_scope_snapshots
      (id, service_month, version_no, status, roster_source_ref, roster_source_hash, accounts_json, scope_hash, recorded_by_user_id, recorded_by_username, reason, recorded_at)
      VALUES ('S-FORGE', '2026-05', 50, 'complete', 'r', ?, '["P-FORGE"]', ?, 'u', 'n', 'r', ?)`).run(HEX64, HEX64, NOW)).toThrow(/SEQUENCE_INVALID/)
  })
})

describe('C1 · manifest:服务器现算、版本链、外部声明', () => {
  it('rows_sha256/统计由服务器对已落库行现算;结论/哈希没有入参位', () => {
    const db = createDb()
    seedRevenueBatch(db, 'STMT-1', { rows: 3, month: '2026-05', partnerId: 'P-1' })
    const manifest = registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '导入后登记', now: NOW })
    const facts = computeSourceBatchFacts(db, 'case_revenue', 'STMT-1')
    expect(manifest.rowsSha256).toBe(facts.rowsSha256)
    expect(manifest.rowCount).toBe(3)
    expect(manifest.serviceMonths).toEqual(['2026-05'])
    expect(manifest.partnerIds).toEqual(['P-1'])
    expect(manifest.versionNo).toBe(1)
    // 伪造字段直接拒绝(合同:调用者不得提交结论字段)
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: 'x', rowsSha256: HEX64 } as never), 'PERIOD_EVIDENCE_UNSUPPORTED_FIELD')
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: 'x', passed: true } as never), 'PERIOD_EVIDENCE_UNSUPPORTED_FIELD')
  })

  it('0 行 batch 拒;非法 sourceKind 拒;external ref/hash 必须成对且 64hex;actor 拒 unknown;CSV 公式前缀拒', () => {
    const db = createDb()
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'NOPE', actor: ACTOR, reason: 'x', now: NOW }), 'MANIFEST_BATCH_NOT_FOUND')
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'materials' as never, batchRef: 'B', actor: ACTOR, reason: 'x', now: NOW }), 'MANIFEST_SOURCE_KIND_INVALID')
    seedRevenueBatch(db, 'STMT-1')
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: 'x', externalSourceRef: 'file://x', now: NOW }), 'MANIFEST_EXTERNAL_EVIDENCE_UNPAIRED')
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: 'x', externalSourceRef: 'file://x', externalSourceHash: 'zz', now: NOW }), 'MANIFEST_EXTERNAL_HASH_INVALID')
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: { userId: 'unknown', username: 'unknown' }, reason: 'x', now: NOW }), 'PERIOD_EVIDENCE_ACTOR_REQUIRED')
    // 公式前缀与其余文本拒因走同一字段稳定码(guardrails:稳定错误码契约)
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '=cmd()', now: NOW }), 'MANIFEST_REASON_INVALID')
  })

  it('同 batch 重复登记 → 版本链 supersede(旧行不可改,外部声明可在新版本更正)', () => {
    const db = createDb()
    seedRevenueBatch(db, 'STMT-1')
    const v1 = registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '首登', now: NOW })
    const v2 = registerSourceBatchManifest(db, {
      sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '更正外部声明',
      externalSourceRef: 'sanitized://statement/2026-05', externalSourceHash: 'b'.repeat(64), now: NOW,
    })
    expect(v2.versionNo).toBe(2)
    expect(v2.supersedesManifestId).toBe(v1.id)
    expect(readCurrentSourceBatchManifest(db, 'case_revenue', 'STMT-1')?.id).toBe(v2.id)
    // 审计留痕(对齐 B):两次登记各一条
    const audits = db.prepare(`SELECT COUNT(*) AS n FROM abc_audit_logs WHERE module = 'hospital_cm_period_evidence'`).get() as { n: number }
    expect(Number(audits.n)).toBeGreaterThanOrEqual(2)
  })

  it('底层行变化后:manifest 現算比对失配(computeSourceBatchFacts),VACUUM/REINDEX 不改变 hash(确定性)', () => {
    const db = createDb()
    seedRevenueBatch(db, 'STMT-1', { rows: 2 })
    const manifest = registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '登记', now: NOW })
    db.exec('VACUUM')
    db.exec('REINDEX')
    expect(computeSourceBatchFacts(db, 'case_revenue', 'STMT-1').rowsSha256).toBe(manifest.rowsSha256)
    db.prepare(`UPDATE case_revenue SET net_amount = 999 WHERE import_batch = 'STMT-1' AND id LIKE '%ROW-0'`).run()
    expect(computeSourceBatchFacts(db, 'case_revenue', 'STMT-1').rowsSha256).not.toBe(manifest.rowsSha256)
  })

  it('脏 service_month(2026-5)补零归一进月归属;事务失败(NOPE)后同一连接可继续成功写', () => {
    const db = createDb()
    db.prepare(`
      INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, discount_rate, service_month, line_count, import_batch)
      VALUES ('DIRTY-1', 'C1', 'P-1', 100, 90, 0.9, '2026-5', 1, 'STMT-DIRTY')
    `).run()
    const facts = computeSourceBatchFacts(db, 'case_revenue', 'STMT-DIRTY')
    expect(facts.serviceMonths).toEqual(['2026-05'])
    // 事务恢复:失败登记(0 行 batch)回滚后,同连接的后续登记必须成功
    expectCode(() => registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'NOPE', actor: ACTOR, reason: 'x', now: NOW }), 'MANIFEST_BATCH_NOT_FOUND')
    const manifest = registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-DIRTY', actor: ACTOR, reason: '登记', now: NOW })
    expect(manifest.versionNo).toBe(1)
  })
})

describe('C1 · 月度范围快照:三态、版本单调、fail-closed', () => {
  it('无快照 → null;complete 可读;incomplete/withdrawn → 读侧 fail-closed 状态', () => {
    const db = createDb()
    expect(readCurrentMonthScope(db, '2026-05')).toBeNull()
    saveScope(db, '2026-05', ['P-1', 'P-2'])
    const scope = readCurrentMonthScope(db, '2026-05')
    expect(scope?.status).toBe('complete')
    expect(scope?.accounts).toEqual(['P-1', 'P-2'])
    saveScope(db, '2026-06', ['P-1'], 'incomplete')
    expect(readCurrentMonthScope(db, '2026-06')?.status).toBe('incomplete')
    const withdrawn = withdrawMonthScopeSnapshot(db, { serviceMonth: '2026-06', actor: ACTOR, reason: '名册源作废', now: NOW })
    expect(withdrawn.versionNo).toBe(2)
    expect(readCurrentMonthScope(db, '2026-06')?.status).toBe('withdrawn')
  })

  it('输入面:空 accounts 拒;非法月份(2026-99/2026-5/注入)拒;roster hash 非 64hex 拒;账户重复去重排序;伪造 scope_hash 字段拒', () => {
    const db = createDb()
    expectCode(() => saveScope(db, '2026-05', []), 'SCOPE_ACCOUNTS_REQUIRED')
    expectCode(() => saveScope(db, '2026-99'), 'PERIOD_EVIDENCE_SERVICE_MONTH_INVALID')
    expectCode(() => saveScope(db, '2026-5' as never), 'PERIOD_EVIDENCE_SERVICE_MONTH_INVALID')
    expectCode(() => saveMonthScopeSnapshot(db, { serviceMonth: '2026-05', accounts: ['P-1'], rosterSourceRef: 'r', rosterSourceHash: 'nothex', status: 'complete', actor: ACTOR, reason: 'x', now: NOW }), 'SCOPE_ROSTER_HASH_INVALID')
    expectCode(() => saveMonthScopeSnapshot(db, { serviceMonth: '2026-05', accounts: ['P-1'], rosterSourceRef: 'r', rosterSourceHash: HEX64, status: 'complete', actor: ACTOR, reason: 'x', scopeHash: HEX64, now: NOW } as never), 'PERIOD_EVIDENCE_UNSUPPORTED_FIELD')
    const scope = saveMonthScopeSnapshot(db, { serviceMonth: '2026-05', accounts: ['P-2', 'P-1', 'P-2'], rosterSourceRef: 'r', rosterSourceHash: HEX64, status: 'complete', actor: ACTOR, reason: 'x', now: NOW })
    expect(scope.accounts).toEqual(['P-1', 'P-2'])
    expect(scope.versionNo).toBe(1)
    expect(saveScope(db, '2026-05').versionNo).toBe(2)
  })
})

describe('C1 · close/reopen revision 触发器矩阵', () => {
  it('close→rev1;reopen→rev2;再 close→rev3;快照 closed_by;不含已关账的迁移不产事件', () => {
    const db = createDb()
    insertReconcileRow(db, 'RHM-1', 'P-1', '2026-05')
    // 待复核→复核完成(complete)不产事件
    db.prepare(`UPDATE reconcile_hospital_months SET status = '复核完成', completed_at = CURRENT_TIMESTAMP, completed_by = 'ops' WHERE id = 'RHM-1'`).run()
    expect(closeEvents(db, 'P-1', '2026-05')).toEqual([])
    closeMonth(db, 'RHM-1', 'finance-a')
    reopenMonth(db, 'RHM-1')
    // 复核完成→待复核(compute 重置)不产事件
    db.prepare(`UPDATE reconcile_hospital_months SET status = '待复核' WHERE id = 'RHM-1'`).run()
    db.prepare(`UPDATE reconcile_hospital_months SET status = '复核完成' WHERE id = 'RHM-1'`).run()
    closeMonth(db, 'RHM-1', 'finance-b')
    const events = closeEvents(db, 'P-1', '2026-05')
    expect(events.map((event) => [event.action, event.revision, event.closedBy])).toEqual([
      ['close', 1, 'finance-a'],
      ['reopen', 2, null],
      ['close', 3, 'finance-b'],
    ])
  })

  it('直插已关账行也产 close 事件;DELETE 已关账行产 delete 事件;identity(partner/month)改写被 ABORT', () => {
    const db = createDb()
    db.prepare(`
      INSERT INTO reconcile_hospital_months (id, partner_id, service_month, status, closed_at, closed_by)
      VALUES ('RHM-X', 'P-9', '2026-04', '已关账', CURRENT_TIMESTAMP, 'importer')
    `).run()
    expect(closeEvents(db, 'P-9', '2026-04').map((event) => [event.action, event.revision])).toEqual([['close', 1]])
    expect(() => db.prepare(`UPDATE reconcile_hospital_months SET service_month = '2026-05' WHERE id = 'RHM-X'`).run())
      .toThrow(/RECONCILE_MONTH_IDENTITY_IMMUTABLE/)
    expect(() => db.prepare(`UPDATE reconcile_hospital_months SET partner_id = 'P-8' WHERE id = 'RHM-X'`).run())
      .toThrow(/RECONCILE_MONTH_IDENTITY_IMMUTABLE/)
    db.prepare(`DELETE FROM reconcile_hospital_months WHERE id = 'RHM-X'`).run()
    expect(closeEvents(db, 'P-9', '2026-04').map((event) => [event.action, event.revision])).toEqual([
      ['close', 1],
      ['delete', 2],
    ])
  })

  it('legacy 已关账行(触发器前存在,零事件)→ 经 reopen(rev1)→close(rev2) 毕业属预期路径', () => {
    const db = new DatabaseSync(':memory:')
    // 先建 reconcile 表并放入 legacy 已关账行,再建触发器(模拟升级库)
    db.exec(`
      CREATE TABLE materials (id TEXT PRIMARY KEY, code TEXT, name TEXT, unit TEXT, category_id TEXT, status INTEGER DEFAULT 1, is_deleted INTEGER DEFAULT 0);
      CREATE TABLE inventory (id TEXT PRIMARY KEY, material_id TEXT, stock REAL DEFAULT 0, locked_stock REAL DEFAULT 0);
      CREATE TABLE batches (id TEXT PRIMARY KEY, material_id TEXT, batch_no TEXT, quantity REAL DEFAULT 0, remaining REAL DEFAULT 0, inbound_id TEXT, status INTEGER DEFAULT 1);
      CREATE TABLE case_revenue (id TEXT PRIMARY KEY, case_no TEXT, partner_id TEXT, partner_name TEXT, doc_no TEXT, gross_amount REAL DEFAULT 0, net_amount REAL DEFAULT 0, discount_rate REAL DEFAULT 0, service_month TEXT, line_count INTEGER DEFAULT 0, import_batch TEXT, config_version INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE lis_cases (id TEXT PRIMARY KEY, case_no TEXT, partner_id TEXT, project_id TEXT, project_name TEXT, operator TEXT, operate_time TEXT, status TEXT DEFAULT 'normal', import_batch TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE lis_case_markers (id TEXT PRIMARY KEY, case_no TEXT, partner_id TEXT, marker_name TEXT, advice_type TEXT, wax_no TEXT, section_no TEXT, import_batch TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE antibodies (id TEXT PRIMARY KEY);
      CREATE TABLE antibody_aliases (id TEXT PRIMARY KEY);
      CREATE TABLE ihc_cost_params (param_key TEXT PRIMARY KEY, value REAL);
      CREATE TABLE special_stain_kits (id TEXT PRIMARY KEY);
      CREATE TABLE abc_audit_logs (id TEXT PRIMARY KEY, module TEXT, action TEXT, target_id TEXT, detail TEXT, operator TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE reconcile_hospital_months (
        id TEXT PRIMARY KEY, partner_id TEXT NOT NULL, partner_name TEXT, service_month TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '待复核', name_aligned INTEGER NOT NULL DEFAULT 0, match_rate DECIMAL(10,6) DEFAULT 0,
        match_status TEXT, statement_ready INTEGER NOT NULL DEFAULT 0, lis_ready INTEGER NOT NULL DEFAULT 0,
        diff_count INTEGER NOT NULL DEFAULT 0, pending_count INTEGER NOT NULL DEFAULT 0, unmatched_count INTEGER NOT NULL DEFAULT 0,
        confirmed_lab_revenue DECIMAL(18,4), computed_at DATETIME, completed_at DATETIME, completed_by TEXT,
        closed_at DATETIME, closed_by TEXT, reopened_at DATETIME, reopen_reason TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(partner_id, service_month)
      );
      INSERT INTO reconcile_hospital_months (id, partner_id, service_month, status, closed_at, closed_by)
      VALUES ('RHM-LEGACY', 'P-L', '2026-01', '已关账', '2026-02-01 00:00:00', 'legacy-user');
    `)
    ensureHospitalCmReadinessSchema(db)
    ensureHospitalCmPeriodEvidenceSchema(db)
    expect(closeEvents(db, 'P-L', '2026-01')).toEqual([])
    // legacy 行在镜像制度下反关账 → 首事件是 reopen rev1(语义成立,禁加 close 先行序守卫)
    reopenMonth(db, 'RHM-LEGACY')
    closeMonth(db, 'RHM-LEGACY', 'finance-new')
    expect(closeEvents(db, 'P-L', '2026-01').map((event) => [event.action, event.revision])).toEqual([
      ['reopen', 1],
      ['close', 2],
    ])
  })
})

describe('C1 · 指纹与读侧失效判定', () => {
  function preparedScene() {
    const db = createDb()
    seedRevenueBatch(db, 'STMT-1', { month: '2026-05', partnerId: 'P-1' })
    registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '登记', now: NOW })
    saveScope(db, '2026-05', ['P-1'])
    insertReconcileRow(db, 'RHM-1', 'P-1', '2026-05')
    closeMonth(db, 'RHM-1')
    return db
  }

  it('基线:全指纹一致 → current=true,零失效码', () => {
    const db = preparedScene()
    const run = insertRun(db)
    const verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(run.id).toBeTruthy()
    expect(verdict.invalidationCodes).toEqual([])
    expect(verdict.current).toBe(true)
  })

  it('CM 七表子集:改 case_revenue → SOURCE_STATE_CHANGED;改 inventory/batches(库存)→ 不失效', () => {
    const db = preparedScene()
    insertRun(db)
    // 库存变动(负向:库存三表不是 CM 输入,不得灭周期证据)
    db.prepare(`INSERT INTO materials (id, code, name, unit) VALUES ('M-1', 'M-1', '物料', '盒')`).run()
    db.prepare(`INSERT INTO inventory (id, material_id, stock) VALUES ('I-1', 'M-1', 5)`).run()
    db.prepare(`INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id) VALUES ('B-1', 'M-1', 'B', 5, 5, 'IN')`).run()
    let verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toEqual([])
    // CM 事实变动
    db.prepare(`UPDATE case_revenue SET net_amount = 1 WHERE id LIKE 'STMT-1%'`).run()
    verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('SOURCE_STATE_CHANGED')
    expect(verdict.current).toBe(false)
  })

  it('scope:新版本(即使内容相同)→ SCOPE_SNAPSHOT_CHANGED;withdrawn → SCOPE_SNAPSHOT_NOT_COMPLETE;缺失月 → SCOPE_SNAPSHOT_MISSING', () => {
    const db = preparedScene()
    insertRun(db)
    saveScope(db, '2026-05', ['P-1']) // 同内容重发新版本 → 严格失效(宁严勿宽)
    let verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('SCOPE_SNAPSHOT_CHANGED')
    withdrawMonthScopeSnapshot(db, { serviceMonth: '2026-05', actor: ACTOR, reason: '作废', now: NOW })
    verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('SCOPE_SNAPSHOT_NOT_COMPLETE')
    const orphan = { ...listPeriodValidationRuns(db, '2026-05')[0], serviceMonth: '2026-07' }
    expect(evaluatePeriodValidationRun(db, orphan).invalidationCodes).toContain('SCOPE_SNAPSHOT_MISSING')
  })

  it('close:reopen → CLOSE_REVISION_CHANGED;已关账行非 status 列改写(closed_by/match_rate)→ 行内容哈希失配;scope 外 partner 关账 → 并集域失效', () => {
    const db = preparedScene()
    insertRun(db)
    // 非 status 列带外改写(反指纹复活:元数据/业务数值都编入行哈希)
    db.prepare(`UPDATE reconcile_hospital_months SET closed_by = 'attacker' WHERE id = 'RHM-1'`).run()
    let verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('CLOSE_REVISION_CHANGED')

    const db2 = preparedScene()
    insertRun(db2)
    db2.prepare(`UPDATE reconcile_hospital_months SET match_rate = 0.5 WHERE id = 'RHM-1'`).run()
    verdict = evaluatePeriodValidationRun(db2, listPeriodValidationRuns(db2, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('CLOSE_REVISION_CHANGED')

    const db3 = preparedScene()
    insertRun(db3)
    reopenMonth(db3, 'RHM-1')
    verdict = evaluatePeriodValidationRun(db3, listPeriodValidationRuns(db3, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('CLOSE_REVISION_CHANGED')

    const db4 = preparedScene()
    insertRun(db4)
    // scope 外 partner 同月关账(被剔出申报 scope 的账户不再隐形)
    insertReconcileRow(db4, 'RHM-2', 'P-OUT', '2026-05')
    closeMonth(db4, 'RHM-2')
    verdict = evaluatePeriodValidationRun(db4, listPeriodValidationRuns(db4, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('CLOSE_REVISION_CHANGED')
  })

  it('legacy 执法:scope 内已关账 partner 无镜像事件 → CLOSE_REVISION_MISSING(candidate 永不可被读干净)', () => {
    const db = preparedScene()
    // 直接把事件删不掉(append-only);另造 legacy:新库直插已关账会产事件,
    // 故用"快照含无行 partner→补关账行"以外的路径:把 scope 指向另一个 legacy 建库(见 legacy 测试)。
    // 这里用最小等价:scope 含 P-2,P-2 有已关账行但其事件被 append-only 挡住无法伪造删除,
    // 于是通过"先建行后建触发器"的隔离库模拟(与上面 legacy 测试同構)。
    const legacy = new DatabaseSync(':memory:')
    legacy.exec(`
      CREATE TABLE materials (id TEXT PRIMARY KEY, code TEXT, name TEXT, unit TEXT, category_id TEXT, status INTEGER DEFAULT 1, is_deleted INTEGER DEFAULT 0);
      CREATE TABLE inventory (id TEXT PRIMARY KEY, material_id TEXT, stock REAL DEFAULT 0, locked_stock REAL DEFAULT 0);
      CREATE TABLE batches (id TEXT PRIMARY KEY, material_id TEXT, batch_no TEXT, quantity REAL DEFAULT 0, remaining REAL DEFAULT 0, inbound_id TEXT, status INTEGER DEFAULT 1);
      CREATE TABLE case_revenue (id TEXT PRIMARY KEY, case_no TEXT, partner_id TEXT, partner_name TEXT, doc_no TEXT, gross_amount REAL DEFAULT 0, net_amount REAL DEFAULT 0, discount_rate REAL DEFAULT 0, service_month TEXT, line_count INTEGER DEFAULT 0, import_batch TEXT, config_version INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE lis_cases (id TEXT PRIMARY KEY, case_no TEXT, partner_id TEXT, project_id TEXT, project_name TEXT, operator TEXT, operate_time TEXT, status TEXT DEFAULT 'normal', import_batch TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE lis_case_markers (id TEXT PRIMARY KEY, case_no TEXT, partner_id TEXT, marker_name TEXT, advice_type TEXT, wax_no TEXT, section_no TEXT, import_batch TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE antibodies (id TEXT PRIMARY KEY);
      CREATE TABLE antibody_aliases (id TEXT PRIMARY KEY);
      CREATE TABLE ihc_cost_params (param_key TEXT PRIMARY KEY, value REAL);
      CREATE TABLE special_stain_kits (id TEXT PRIMARY KEY);
      CREATE TABLE abc_audit_logs (id TEXT PRIMARY KEY, module TEXT, action TEXT, target_id TEXT, detail TEXT, operator TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE reconcile_hospital_months (
        id TEXT PRIMARY KEY, partner_id TEXT NOT NULL, partner_name TEXT, service_month TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '待复核', name_aligned INTEGER NOT NULL DEFAULT 0, match_rate DECIMAL(10,6) DEFAULT 0,
        match_status TEXT, statement_ready INTEGER NOT NULL DEFAULT 0, lis_ready INTEGER NOT NULL DEFAULT 0,
        diff_count INTEGER NOT NULL DEFAULT 0, pending_count INTEGER NOT NULL DEFAULT 0, unmatched_count INTEGER NOT NULL DEFAULT 0,
        confirmed_lab_revenue DECIMAL(18,4), computed_at DATETIME, completed_at DATETIME, completed_by TEXT,
        closed_at DATETIME, closed_by TEXT, reopened_at DATETIME, reopen_reason TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(partner_id, service_month)
      );
      INSERT INTO reconcile_hospital_months (id, partner_id, service_month, status, closed_at, closed_by)
      VALUES ('RHM-LEG', 'P-LEG', '2026-05', '已关账', '2026-06-01 00:00:00', 'legacy');
    `)
    ensureHospitalCmReadinessSchema(legacy)
    ensureHospitalCmPeriodEvidenceSchema(legacy)
    saveMonthScopeSnapshot(legacy, { serviceMonth: '2026-05', accounts: ['P-LEG'], rosterSourceRef: 'r', rosterSourceHash: HEX64, status: 'complete', actor: ACTOR, reason: 'x', now: NOW })
    const close = currentCloseRevisionState(legacy, '2026-05', ['P-LEG'])
    expect(close.missingCloseEventPartnerIds).toEqual(['P-LEG'])
    insertRun(legacy)
    const verdict = evaluatePeriodValidationRun(legacy, listPeriodValidationRuns(legacy, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('CLOSE_REVISION_MISSING')
    expect(verdict.current).toBe(false)
    // 主库 sanity:有事件的关账不报 MISSING
    expect(currentCloseRevisionState(db, '2026-05', ['P-1']).missingCloseEventPartnerIds).toEqual([])
  })

  it('manifest 集变化 → MANIFEST_SET_CHANGED;recipe 版本不同 → PROFILE_RECIPE_UPGRADED(不再叠报 PROFILE_CHANGED)', () => {
    const db = preparedScene()
    insertRun(db)
    registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-1', actor: ACTOR, reason: '新版本', now: NOW })
    let verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('MANIFEST_SET_CHANGED')

    const db2 = preparedScene()
    insertRun(db2, '2026-05', { profile_recipe_version: 'C0.legacy-recipe.v0' })
    verdict = evaluatePeriodValidationRun(db2, listPeriodValidationRuns(db2, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('PROFILE_RECIPE_UPGRADED')
    expect(verdict.invalidationCodes).not.toContain('PROFILE_CHANGED')
  })

  it('lis 类 manifest 无月归属 → 全局并入每月集合:登记/更正 lis manifest 必翻 MANIFEST_SET_CHANGED', () => {
    const db = preparedScene()
    db.prepare(`
      INSERT INTO lis_cases (id, case_no, partner_id, operate_time, status, import_batch)
      VALUES ('LIS-1', 'C-L1', 'P-1', '2026-05-09', 'normal', 'LIS-B1')
    `).run()
    const lisManifest = registerSourceBatchManifest(db, { sourceKind: 'lis_cases', batchRef: 'LIS-B1', actor: ACTOR, reason: '登记', now: NOW })
    expect(lisManifest.serviceMonths).toEqual([]) // 生产 lis 表无 service_month 列,月键派生归 #163/#168,C1 不另造
    insertRun(db)
    expect(evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0]).invalidationCodes).toEqual([])
    // lis manifest 更正(新版本)→ 无月归属全局并入 → 该月指纹必变(fail-closed,待 C3 按同源月键收窄)
    registerSourceBatchManifest(db, { sourceKind: 'lis_cases', batchRef: 'LIS-B1', actor: ACTOR, reason: '更正声明', externalSourceRef: 'sanitized://lis/b1', externalSourceHash: 'c'.repeat(64), now: NOW })
    const verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('MANIFEST_SET_CHANGED')
  })

  it('PROFILE_CHANGED 正向:denominator owner 合规改派(fixed-pool owner 轴)翻 profile 指纹', () => {
    const db = preparedScene()
    insertRun(db)
    db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET revision = revision + 1, previous_due_date = due_date, previous_projected_date = projected_date,
          owner_user_id = 'U-NEW-OWNER', owner_name = '新财务owner',
          owner_assignment_revision = owner_assignment_revision + 1,
          change_reason = '测试改派', updated_by = 'tester'
      WHERE condition_key = 'denominator'
    `).run()
    const verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('PROFILE_CHANGED')
    expect(verdict.current).toBe(false)
  })

  it('SOURCE_STATE_UNAVAILABLE:source revision 控制面缺行时 fail-closed 而非误判干净', () => {
    const db = preparedScene()
    insertRun(db)
    db.exec('DROP TRIGGER trg_hcm_readiness_source_revision_no_delete')
    db.prepare(`DELETE FROM hospital_cm_readiness_source_revisions WHERE source_key = 'case_revenue'`).run()
    const verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('SOURCE_STATE_UNAVAILABLE')
    expect(verdict.current).toBe(false)
  })

  it('缺 scope 月不豁免 close 执法:无快照但有已关账行的月,SCOPE_SNAPSHOT_MISSING 与 close 维度失配同报', () => {
    const db = preparedScene()
    insertRun(db)
    insertReconcileRow(db, 'RHM-ORPHAN', 'P-7', '2026-07')
    closeMonth(db, 'RHM-ORPHAN')
    const orphan = { ...listPeriodValidationRuns(db, '2026-05')[0], serviceMonth: '2026-07' }
    const verdict = evaluatePeriodValidationRun(db, orphan)
    expect(verdict.invalidationCodes).toContain('SCOPE_SNAPSHOT_MISSING')
    expect(verdict.invalidationCodes).toContain('CLOSE_REVISION_CHANGED')
  })

  it('基表 INSERT OR REPLACE 兜底:闭→待复核换血无事件但读侧必失效;闭→闭 REPLACE 经 INSERT 触发器产新 revision', () => {
    const db = preparedScene()
    insertRun(db)
    const eventsBefore = closeEvents(db, 'P-1', '2026-05')
    // 变体 1:REPLACE 把已关账行换血为待复核(隐式 DELETE 不触发 delete 镜像 → 无新事件),读侧行哈希兜底必失效
    db.prepare(`
      INSERT OR REPLACE INTO reconcile_hospital_months (id, partner_id, service_month, status)
      VALUES ('RHM-EVIL', 'P-1', '2026-05', '待复核')
    `).run()
    expect(closeEvents(db, 'P-1', '2026-05')).toEqual(eventsBefore)
    const verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('CLOSE_REVISION_CHANGED')
    expect(verdict.current).toBe(false)
    // 变体 2:REPLACE 直插已关账(INSERT 触发器对 REPLACE 仍触发)→ 产新 close revision
    db.prepare(`
      INSERT OR REPLACE INTO reconcile_hospital_months (id, partner_id, service_month, status, closed_at, closed_by)
      VALUES ('RHM-EVIL2', 'P-1', '2026-05', '已关账', CURRENT_TIMESTAMP, 'replacer')
    `).run()
    const after = closeEvents(db, 'P-1', '2026-05')
    expect(after.length).toBe(eventsBefore.length + 1)
    expect(after[after.length - 1].action).toBe('close')
  })

  it('列集漂移守卫:reconcile 加列而不同步行哈希清单 → close 维度 fail-closed(不炸启动,旧库兼容)', () => {
    const db = preparedScene()
    insertRun(db)
    db.exec(`ALTER TABLE reconcile_hospital_months ADD COLUMN adjustment_note TEXT`)
    // ensure 幂等重跑不抛错(旧库兼容:漂移不阻断启动,只告警)
    expect(() => ensureHospitalCmPeriodEvidenceSchema(db)).not.toThrow()
    const close = currentCloseRevisionState(db, '2026-05', ['P-1'])
    expect(close.schemaDrift).toBe(true)
    const verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, '2026-05')[0])
    expect(verdict.invalidationCodes).toContain('RECONCILE_SCHEMA_DRIFT')
    expect(verdict.current).toBe(false)
  })

  it('同步锚:真 initializeDatabase 库的 reconcile 列集 == 行哈希清单(生产 DDL 变化时此测必红)', async () => {
    const { getDb } = await import('./p0-harness.js')
    const realDb = await getDb()
    const actual = (realDb.prepare('PRAGMA table_info(reconcile_hospital_months)').all() as Array<{ name: string }>)
      .map((column) => column.name)
      .sort()
    expect(actual).toEqual([...RECONCILE_ROW_HASH_COLUMNS, 'created_at', 'updated_at'].sort())
  })

  it('runs 表 error 列组:裸 INSERT 可落 error_code/error_summary 并读回(C3 落错误 run 的槽位)', () => {
    const db = preparedScene()
    const scope = readCurrentMonthScope(db, '2026-05')!
    db.prepare(`
      INSERT INTO hospital_cm_period_validation_runs
        (id, service_month, scope_hash, scope_snapshot_event_number, close_revision_fingerprint,
         source_state_fingerprint, profile_fingerprint, manifest_set_fingerprint, profile_recipe_version,
         overall_status, started_at, completed_at, triggered_by_user_id, triggered_by_username, trigger_reason_code,
         error_code, error_summary)
      VALUES (?, '2026-05', ?, ?, ?, ?, ?, ?, ?, 'error', ?, ?, ?, ?, 'PERIOD_REVIEW', ?, ?)
    `).run(
      'RUN-ERR', scope.scopeHash, scope.eventNumber, HEX64, HEX64, HEX64, HEX64,
      HOSPITAL_CM_PROFILE_RECIPE_VERSION, NOW, NOW, ACTOR.userId, ACTOR.username,
      'PERIOD_CHECK_READ_FAILED', '周期检查读取失败;未保存原始数据库错误或业务明细',
    )
    const run = listPeriodValidationRuns(db, '2026-05').find((row) => row.id === 'RUN-ERR')
    expect(run?.overallStatus).toBe('error')
    expect(run?.errorCode).toBe('PERIOD_CHECK_READ_FAILED')
    expect(run?.errorSummary).toContain('未保存原始数据库错误')
  })

  it('runs/checks DDL:非法 overall_status、超长 summary_json、非法月份被 CHECK 拒;checks append-only 已在上组覆盖', () => {
    const db = preparedScene()
    const run = insertRun(db)
    expect(() => insertRun(db, '2026-05', { id: 'RUN-BAD', overall_status: 'maybe' })).toThrow(/CHECK constraint/)
    expect(() => insertRun(db, '2026-05', { id: 'RUN-BAD2', service_month: '2026-99' })).toThrow(/CHECK constraint/)
    expect(() => db.prepare(`
      INSERT INTO hospital_cm_period_validation_checks (run_id, check_key, status, result_code, summary_json, input_fingerprint, observed_at)
      VALUES (?, 'k', 'passed', 'OK', ?, ?, ?)
    `).run(run.id, `{"pad":"${'x'.repeat(2100)}"}`, HEX64, NOW)).toThrow(/CHECK constraint/)
  })
})

describe('C1 · candidate、查询预算与行为面不变', () => {
  it('listPeriodCandidates:已关账月列出、revision 现状、verified 恒 false(C1 无 VERIFIED 概念)', () => {
    const db = createDb()
    insertReconcileRow(db, 'RHM-1', 'P-1', '2026-05')
    closeMonth(db, 'RHM-1')
    insertReconcileRow(db, 'RHM-2', 'P-2', '2026-05')
    const candidates = listPeriodCandidates(db)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ partnerId: 'P-1', serviceMonth: '2026-05', verified: false })
    expect(candidates[0].revision).toBe(1)
  })

  it('查询预算:多院多月(8 院 × 3 月)下 evaluate/指纹函数 prepare 次数与院数无关(禁 N+1)', () => {
    const db = createDb()
    const months = ['2026-03', '2026-04', '2026-05']
    const partners = Array.from({ length: 8 }, (_, index) => `P-${index + 1}`)
    for (const month of months) {
      for (const partner of partners) {
        insertReconcileRow(db, `RHM-${partner}-${month}`, partner, month)
        closeMonth(db, `RHM-${partner}-${month}`)
      }
    }
    saveScope(db, '2026-05', partners)
    seedRevenueBatch(db, 'STMT-BIG', { month: '2026-05', partnerId: 'P-1', rows: 4 })
    registerSourceBatchManifest(db, { sourceKind: 'case_revenue', batchRef: 'STMT-BIG', actor: ACTOR, reason: '登记', now: NOW })
    insertRun(db)

    // 计 prepare 与 statement 执行(get/all/run)两个维度:防"语句提升 + 循环执行"型 N+1 逃过 prepare 计数
    let prepareCount = 0
    let statementCalls = 0
    const wrapStatement = (statement: { get: Function; all: Function; run: Function }) => new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === 'get' || prop === 'all' || prop === 'run') {
          return (...args: unknown[]) => {
            statementCalls += 1
            return (target as never)[prop](...args)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            prepareCount += 1
            return wrapStatement(target.prepare(sql) as never)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const run = listPeriodValidationRuns(db, '2026-05')[0]
    prepareCount = 0
    statementCalls = 0
    evaluatePeriodValidationRun(counting as never, run)
    const with8 = prepareCount
    const with8Calls = statementCalls
    expect(with8).toBeGreaterThan(0) // Proxy 拦截自检:计数失效时 0===0 不许空转绿

    // 扩到 16 院重登 scope 后再次评估:查询数与语句执行数都不得随院数增长
    const morePartners = [...partners, ...Array.from({ length: 8 }, (_, index) => `P-${index + 9}`)]
    for (const partner of morePartners.slice(8)) {
      insertReconcileRow(db, `RHM-${partner}-2026-05`, partner, '2026-05')
      closeMonth(db, `RHM-${partner}-2026-05`)
    }
    saveScope(db, '2026-05', morePartners)
    insertRun(db)
    const run16 = listPeriodValidationRuns(db, '2026-05')[1]
    prepareCount = 0
    statementCalls = 0
    evaluatePeriodValidationRun(counting as never, run16)
    expect(prepareCount).toBe(with8)
    expect(statementCalls).toBe(with8Calls)
  })

  it('回滚演练:DROP C1 触发器后,关账/反关账路径行为不变(仅证据镜像停止)', () => {
    const db = createDb()
    db.exec(`
      DROP TRIGGER trg_hcm_close_rev_close;
      DROP TRIGGER trg_hcm_close_rev_reopen;
      DROP TRIGGER trg_hcm_close_rev_insert_closed;
      DROP TRIGGER trg_hcm_close_rev_delete_closed;
      DROP TRIGGER trg_hcm_reconcile_identity_immutable;
    `)
    insertReconcileRow(db, 'RHM-1', 'P-1', '2026-05')
    closeMonth(db, 'RHM-1')
    reopenMonth(db, 'RHM-1')
    const row = db.prepare(`SELECT status FROM reconcile_hospital_months WHERE id = 'RHM-1'`).get() as { status: string }
    expect(row.status).toBe('复核完成')
    expect(closeEvents(db, 'P-1', '2026-05')).toEqual([])
  })
})
