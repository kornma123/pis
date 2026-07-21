import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bridgeHospitalCmDirectoryScopeForMonth,
} from '../src/utils/hospital-cm-directory-scope-bridge.js'
import {
  HOSPITAL_CM_PROFILE_RECIPE_VERSION,
  cmSourceSubsetFingerprint,
  computeCmValueProfileFingerprint,
  currentCloseRevisionState,
  ensureHospitalCmPeriodEvidenceSchema,
  evaluatePeriodValidationRun,
  listPeriodValidationRuns,
  manifestSetFingerprint,
  readCurrentMonthScope,
  saveMonthScopeSnapshot,
  withdrawMonthScopeSnapshot,
} from '../src/utils/hospital-cm-period-evidence.js'
import {
  ensureHospitalCmDirectorySchema,
  getCurrentHospitalCmDirectory,
  projectHospitalCmDirectoryForMonth,
  saveHospitalCmDirectoryRevision,
} from '../src/utils/hospital-cm-directory.js'
import { ensureHospitalCmReadinessSchema } from '../src/utils/hospital-cm-readiness-runtime.js'

const NOW = '2026-07-20T08:00:00.000Z'
const ACTOR = { userId: 'U-BRIDGE-1', username: 'bridge.operator' }
const DIRECTORY_ADMIN = { userId: 'U-DIR-ADMIN', username: 'directory.admin' }
const MONTH = '2026-08'

let idempotencySequence = 0
function nextIdempotencyKey(): string {
  idempotencySequence += 1
  return `bridge-test-directory-${String(idempotencySequence).padStart(4, '0')}`
}

/** 桥接隔离库:period-evidence 全套依赖表 + partners(目录 FK)+ 目录 schema。 */
function createDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE partners (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
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
      he_slide_count INTEGER NOT NULL DEFAULT 0, block_count INTEGER NOT NULL DEFAULT 0,
      ihc_count INTEGER NOT NULL DEFAULT 0, special_stain_count INTEGER NOT NULL DEFAULT 0,
      eber_count INTEGER NOT NULL DEFAULT 0, pdl1_count INTEGER NOT NULL DEFAULT 0,
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
  db.exec(`
      CREATE TABLE abc_audit_logs (
        id TEXT PRIMARY KEY, module TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT,
        detail TEXT, operator TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
  const insertPartner = db.prepare('INSERT INTO partners (id, code, name, is_deleted) VALUES (?, ?, ?, 0)')
  insertPartner.run('PARTNER-001', 'LEGACY-001', '桥接测试医院甲')
  insertPartner.run('PARTNER-002', 'LEGACY-002', '桥接测试医院乙')
  insertPartner.run('PARTNER-003', 'LEGACY-003', '桥接测试医院丙')
  ensureHospitalCmDirectorySchema(db)
  ensureHospitalCmReadinessSchema(db)
  ensureHospitalCmPeriodEvidenceSchema(db)
  return db
}

function dirEntry(stablePartnerId: string, overrides: Record<string, unknown> = {}) {
  return {
    stablePartnerId,
    accountCode: `HCM-${stablePartnerId}`,
    canonicalDisplayName: `桥接测试医院-${stablePartnerId}`,
    aliases: [] as string[],
    hospitalCmIncluded: true,
    effectiveFromMonth: '2026-07',
    effectiveToMonth: null as string | null,
    ...overrides,
  }
}

function saveDirectory(
  db: DatabaseSync,
  entries: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
) {
  return saveHospitalCmDirectoryRevision(db, {
    entries,
    knownCompleteFromMonth: '2026-07',
    actor: DIRECTORY_ADMIN,
    reasonCode: 'BRIDGE_TEST_REVISION',
    idempotencyKey: nextIdempotencyKey(),
    ...overrides,
  })
}

function callBridge(db: DatabaseSync, month = MONTH, overrides: Record<string, unknown> = {}) {
  return bridgeHospitalCmDirectoryScopeForMonth(db, {
    serviceMonth: month,
    actor: ACTOR,
    reason: '桥接月度范围发布',
    ...overrides,
  })
}

function evidenceCounts(db: DatabaseSync): { scopes: number; scopeAudits: number } {
  const scopes = Number((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_month_scope_snapshots').get() as { n: number }).n)
  const scopeAudits = Number((db.prepare(`SELECT COUNT(*) AS n FROM abc_audit_logs WHERE module = 'hospital_cm_period_evidence'`).get() as { n: number }).n)
  return { scopes, scopeAudits }
}

function expectBridgeCode(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(expect.objectContaining({ code }))
}

/** 绑定当前 scope 造一条 validation run(C1 不导出写函数:测试用裸 INSERT + 生产指纹函数)。 */
function insertRunBoundToCurrentScope(db: DatabaseSync, month: string): void {
  const scope = readCurrentMonthScope(db, month)
  if (scope == null) throw new Error('test setup requires a current scope snapshot')
  const close = currentCloseRevisionState(db, month, scope.accounts)
  db.prepare(`
    INSERT INTO hospital_cm_period_validation_runs
      (id, service_month, scope_hash, scope_snapshot_event_number, close_revision_fingerprint,
       source_state_fingerprint, profile_fingerprint, manifest_set_fingerprint, profile_recipe_version,
       overall_status, started_at, completed_at, triggered_by_user_id, triggered_by_username, trigger_reason_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?, ?, ?, 'PERIOD_REVIEW')
  `).run(
    `RUN-BRIDGE-${Math.random().toString(36).slice(2, 10)}`,
    month,
    scope.scopeHash,
    scope.eventNumber,
    close.fingerprint,
    cmSourceSubsetFingerprint(db),
    computeCmValueProfileFingerprint(db, month),
    manifestSetFingerprint(db, month),
    HOSPITAL_CM_PROFILE_RECIPE_VERSION,
    NOW,
    NOW,
    ACTOR.userId,
    ACTOR.username,
  )
}

describe('#182/O-1 · 目录 → C1 scope 桥接:不可用投影', () => {
  it('无目录(投影 null)+ 无旧 scope → UNAVAILABLE,scope/audit 零写', () => {
    const db = createDb()
    const result = callBridge(db)
    expect(result.action).toBe('UNAVAILABLE')
    expect(result.scope).toBeNull()
    expect(result.directoryVersionId).toBeNull()
    expect(evidenceCounts(db)).toEqual({ scopes: 0, scopeAudits: 0 })
    expect(readCurrentMonthScope(db, MONTH)).toBeNull()
  })

  it('月份早于 knownCompleteFromMonth(投影 null)+ 无旧 scope → UNAVAILABLE 零写', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    const result = callBridge(db, '2026-06')
    expect(result.action).toBe('UNAVAILABLE')
    expect(result.scope).toBeNull()
    expect(evidenceCounts(db)).toEqual({ scopes: 0, scopeAudits: 0 })
  })

  it('空投影(当月无成员)+ 无旧 scope → 绝不 complete-empty,UNAVAILABLE 零写', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001', { effectiveToMonth: '2026-07' })])
    const projection = projectHospitalCmDirectoryForMonth(db, MONTH)
    expect(projection).not.toBeNull()
    expect(projection?.accounts).toEqual([])
    const result = callBridge(db, MONTH)
    expect(result.action).toBe('UNAVAILABLE')
    expect(result.scope).toBeNull()
    expect(result.directoryVersionId).toBe(projection?.directoryVersionId)
    expect(evidenceCounts(db)).toEqual({ scopes: 0, scopeAudits: 0 })
    expect(readCurrentMonthScope(db, MONTH)).toBeNull()
  })
})

describe('#182/O-1 · 目录 → C1 scope 桥接:发布与 no-op', () => {
  it('首次发布:非空投影 + 无 current → 追加 complete;accounts/hash/ref/actor/readback 全部正确', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-002'), dirEntry('PARTNER-001')])
    const projection = projectHospitalCmDirectoryForMonth(db, MONTH)
    expect(projection?.accounts).toEqual(['PARTNER-001', 'PARTNER-002'])

    const result = callBridge(db)
    expect(result.action).toBe('PUBLISHED')
    expect(result.directoryVersionId).toBe(projection?.directoryVersionId)
    const scope = result.scope!
    expect(scope.status).toBe('complete')
    expect(scope.versionNo).toBe(1)
    expect(scope.accounts).toEqual(projection?.accounts)
    expect(scope.rosterSourceHash).toBe(projection?.rosterSourceHash)
    expect(scope.rosterSourceRef).toBe(`roster://hospital-cm-directory/${projection?.directoryVersionId}`)
    expect(scope.recordedByUserId).toBe(ACTOR.userId)
    expect(scope.recordedByUsername).toBe(ACTOR.username)
    // readback:返回值必须与提交后读侧一致
    const reread = readCurrentMonthScope(db, MONTH)
    expect(reread?.id).toBe(scope.id)
    expect(reread?.eventNumber).toBe(scope.eventNumber)
    expect(reread?.scopeHash).toBe(scope.scopeHash)
    // scopeHash 只复用 C1 唯一公式:与 raw helper 同输入落库的结果逐位一致(生产函数交叉核对,不重算配方)
    const referenceDb = createDb()
    const reference = saveMonthScopeSnapshot(referenceDb, {
      serviceMonth: MONTH,
      accounts: projection!.accounts,
      rosterSourceRef: `roster://hospital-cm-directory/${projection!.directoryVersionId}`,
      rosterSourceHash: projection!.rosterSourceHash,
      status: 'complete',
      actor: ACTOR,
      reason: '参照保存',
    })
    expect(scope.scopeHash).toBe(reference.scopeHash)
    // 审计:一条 scope_snapshot_save,operator 为可信 actor
    const audits = db.prepare(`
      SELECT action, target_id AS targetId, operator FROM abc_audit_logs
      WHERE module = 'hospital_cm_period_evidence'
    `).all() as Array<{ action: string; targetId: string; operator: string }>
    expect(audits).toEqual([{ action: 'scope_snapshot_save', targetId: scope.id, operator: ACTOR.username }])
  })

  it('同一投影第二次调用 → UNCHANGED,scope/audit/event 数零变化', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001'), dirEntry('PARTNER-002')])
    const first = callBridge(db)
    expect(first.action).toBe('PUBLISHED')
    const before = evidenceCounts(db)
    const second = callBridge(db)
    expect(second.action).toBe('UNCHANGED')
    expect(second.scope?.id).toBe(first.scope?.id)
    expect(second.scope?.eventNumber).toBe(first.scope?.eventNumber)
    expect(evidenceCounts(db)).toEqual(before)
  })

  it('只改 display name 的目录新修订(contentHash 变、成员投影不变)→ UNCHANGED', () => {
    const db = createDb()
    const firstRevision = saveDirectory(db, [dirEntry('PARTNER-001'), dirEntry('PARTNER-002')])
    const first = callBridge(db)
    expect(first.action).toBe('PUBLISHED')
    const secondRevision = saveDirectory(db, [
      dirEntry('PARTNER-001', { canonicalDisplayName: '桥接测试医院-仅改名' }),
      dirEntry('PARTNER-002'),
    ], { reasonCode: 'DISPLAY_NAME_CORRECTION' })
    expect(secondRevision.contentHash).not.toBe(firstRevision.contentHash)
    expect(getCurrentHospitalCmDirectory(db)?.id).toBe(secondRevision.id)
    const before = evidenceCounts(db)
    const second = callBridge(db)
    expect(second.action).toBe('UNCHANGED')
    expect(second.scope?.eventNumber).toBe(first.scope?.eventNumber)
    expect(evidenceCounts(db)).toEqual(before)
  })

  it('只改 accountCode/alias 且成员不变 → UNCHANGED', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001'), dirEntry('PARTNER-002')])
    expect(callBridge(db).action).toBe('PUBLISHED')
    saveDirectory(db, [
      dirEntry('PARTNER-001', { accountCode: 'HCM-RECODE-001', aliases: ['新别名甲'] }),
      dirEntry('PARTNER-002'),
    ], { reasonCode: 'MAPPING_REVIEWED_RECODE' })
    const before = evidenceCounts(db)
    const result = callBridge(db)
    expect(result.action).toBe('UNCHANGED')
    expect(evidenceCounts(db)).toEqual(before)
  })

  it('成员变化(新增纳入医院)→ 追加新 complete,hash 跟随生产投影', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    const first = callBridge(db)
    expect(first.scope?.accounts).toEqual(['PARTNER-001'])
    saveDirectory(db, [dirEntry('PARTNER-001'), dirEntry('PARTNER-002')], { reasonCode: 'NEW_MEMBER_JOIN' })
    const projection = projectHospitalCmDirectoryForMonth(db, MONTH)
    const second = callBridge(db)
    expect(second.action).toBe('PUBLISHED')
    expect(second.scope?.versionNo).toBe(2)
    expect(second.scope?.accounts).toEqual(projection?.accounts)
    expect(second.scope?.rosterSourceHash).toBe(projection?.rosterSourceHash)
    expect(second.scope?.scopeHash).not.toBe(first.scope?.scopeHash)
  })

  it('included/effective 区间只影响对应月份', () => {
    const db = createDb()
    saveDirectory(db, [
      dirEntry('PARTNER-001', { effectiveFromMonth: '2026-07' }),
      dirEntry('PARTNER-002', { hospitalCmIncluded: false, effectiveFromMonth: null }),
      dirEntry('PARTNER-003', { effectiveFromMonth: '2026-06', effectiveToMonth: '2026-07' }),
    ], { knownCompleteFromMonth: '2026-06' })

    const june = callBridge(db, '2026-06')
    expect(june.action).toBe('PUBLISHED')
    expect(june.scope?.accounts).toEqual(projectHospitalCmDirectoryForMonth(db, '2026-06')?.accounts)
    expect(june.scope?.accounts).toEqual(['PARTNER-003'])

    const july = callBridge(db, '2026-07')
    expect(july.scope?.accounts).toEqual(['PARTNER-001', 'PARTNER-003'])

    const august = callBridge(db, '2026-08')
    expect(august.scope?.accounts).toEqual(['PARTNER-001'])
    // 未纳入的 PARTNER-002 任何月份都不得出现
    for (const month of ['2026-06', '2026-07', '2026-08']) {
      expect(readCurrentMonthScope(db, month)?.accounts).not.toContain('PARTNER-002')
    }
  })
})

describe('#182/O-1 · 目录 → C1 scope 桥接:current status 参与比较', () => {
  it('current incomplete/withdrawn + 相同非空投影 → 必须追加新 complete,不得因 hash 相同 no-op', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001'), dirEntry('PARTNER-002')])
    const first = callBridge(db)
    expect(first.action).toBe('PUBLISHED')
    const projection = projectHospitalCmDirectoryForMonth(db, MONTH)!

    // raw helper 把 current 改为 incomplete(内容相同)
    saveMonthScopeSnapshot(db, {
      serviceMonth: MONTH,
      accounts: projection.accounts,
      rosterSourceRef: first.scope!.rosterSourceRef,
      rosterSourceHash: projection.rosterSourceHash,
      status: 'incomplete',
      actor: ACTOR,
      reason: '人工标记范围不完整',
    })
    expect(readCurrentMonthScope(db, MONTH)?.status).toBe('incomplete')
    const republished = callBridge(db)
    expect(republished.action).toBe('PUBLISHED')
    expect(republished.scope?.status).toBe('complete')
    expect(republished.scope?.versionNo).toBe(3)
    expect(republished.scope?.scopeHash).toBe(first.scope?.scopeHash) // 内容 hash 相同,eventNumber 必须更新

    // 再撤回,桥接仍须发布新 complete
    const current = readCurrentMonthScope(db, MONTH)!
    withdrawMonthScopeSnapshot(db, {
      serviceMonth: MONTH,
      expectedEventNumber: current.eventNumber,
      actor: ACTOR,
      reason: '名册源作废',
    })
    expect(readCurrentMonthScope(db, MONTH)?.status).toBe('withdrawn')
    const revived = callBridge(db)
    expect(revived.action).toBe('PUBLISHED')
    expect(revived.scope?.status).toBe('complete')
    expect(revived.scope?.versionNo).toBe(5)
  })
})

describe('#182/O-1 · 目录 → C1 scope 桥接:投影消失与恢复', () => {
  it('投影变 null(完整边界前移)+ 旧 complete → WITHDRAWN,旧 validation run fail-closed;重复调用 UNAVAILABLE 零写', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')], { knownCompleteFromMonth: '2026-07' })
    const first = callBridge(db, '2026-07')
    expect(first.action).toBe('PUBLISHED')
    insertRunBoundToCurrentScope(db, '2026-07')

    saveDirectory(db, [dirEntry('PARTNER-001')], {
      knownCompleteFromMonth: '2026-08',
      reasonCode: 'HISTORICAL_COMPLETENESS_CORRECTION',
    })
    expect(projectHospitalCmDirectoryForMonth(db, '2026-07')).toBeNull()

    const withdrawn = callBridge(db, '2026-07')
    expect(withdrawn.action).toBe('WITHDRAWN')
    expect(withdrawn.scope?.status).toBe('withdrawn')
    expect(withdrawn.scope?.versionNo).toBe(2)
    expect(withdrawn.scope?.accounts).toEqual(['PARTNER-001']) // 复制当前视图留证
    expect(withdrawn.scope?.rosterSourceHash).toBe(first.scope?.rosterSourceHash)

    const run = listPeriodValidationRuns(db, '2026-07')[0]
    const verdict = evaluatePeriodValidationRun(db, run)
    expect(verdict.current).toBe(false)
    expect(verdict.invalidationCodes).toContain('SCOPE_SNAPSHOT_NOT_COMPLETE')

    // current 已非 complete 且投影仍不可用:不授权新状态/事件风暴,UNAVAILABLE 零写
    const before = evidenceCounts(db)
    const repeated = callBridge(db, '2026-07')
    expect(repeated.action).toBe('UNAVAILABLE')
    expect(repeated.scope?.status).toBe('withdrawn')
    expect(evidenceCounts(db)).toEqual(before)
  })

  it('投影变 empty(成员显式退出)+ 旧 complete → WITHDRAWN,旧 run fail-closed', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    expect(callBridge(db, MONTH).action).toBe('PUBLISHED')
    insertRunBoundToCurrentScope(db, MONTH)

    saveDirectory(db, [dirEntry('PARTNER-001', { effectiveToMonth: '2026-07' })], { reasonCode: 'EXPLICIT_MEMBERSHIP_END' })
    const projection = projectHospitalCmDirectoryForMonth(db, MONTH)
    expect(projection?.accounts).toEqual([])

    const withdrawn = callBridge(db, MONTH)
    expect(withdrawn.action).toBe('WITHDRAWN')
    expect(withdrawn.scope?.status).toBe('withdrawn')
    const verdict = evaluatePeriodValidationRun(db, listPeriodValidationRuns(db, MONTH)[0])
    expect(verdict.current).toBe(false)
    expect(verdict.invalidationCodes).toContain('SCOPE_SNAPSHOT_NOT_COMPLETE')
  })

  it('withdrawn 后投影恢复 → 追加新 complete(即使 hash 相同);紧接第二次调用 UNCHANGED', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    const first = callBridge(db, MONTH)
    expect(first.action).toBe('PUBLISHED')

    saveDirectory(db, [dirEntry('PARTNER-001', { effectiveToMonth: '2026-07' })], { reasonCode: 'EXPLICIT_MEMBERSHIP_END' })
    expect(callBridge(db, MONTH).action).toBe('WITHDRAWN')

    saveDirectory(db, [dirEntry('PARTNER-001', { effectiveToMonth: null })], { reasonCode: 'MEMBERSHIP_RESTORED' })
    const projection = projectHospitalCmDirectoryForMonth(db, MONTH)
    expect(projection?.accounts).toEqual(['PARTNER-001'])
    const restored = callBridge(db, MONTH)
    expect(restored.action).toBe('PUBLISHED')
    expect(restored.scope?.status).toBe('complete')
    expect(restored.scope?.versionNo).toBe(3)
    expect(restored.scope?.rosterSourceHash).toBe(first.scope?.rosterSourceHash) // 同月同成员 → 同 hash

    const before = evidenceCounts(db)
    const second = callBridge(db, MONTH)
    expect(second.action).toBe('UNCHANGED')
    expect(second.scope?.eventNumber).toBe(restored.scope?.eventNumber)
    expect(evidenceCounts(db)).toEqual(before)
  })
})

describe('#182/O-1 · 目录 → C1 scope 桥接:输入边界与可信 actor', () => {
  it('caller 不能提交 accounts/hash/revision/name/code/alias/status/recordedAt/operator 等任何字段', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    const forgedFields: Array<Record<string, unknown>> = [
      { accounts: ['PARTNER-001'] },
      { rosterSourceHash: 'a'.repeat(64) },
      { hash: 'a'.repeat(64) },
      { scopeHash: 'a'.repeat(64) },
      { directoryRevision: 1 },
      { directoryVersionId: '00000000-0000-4000-8000-000000000001' },
      { canonicalDisplayName: '伪造名称' },
      { accountCode: 'HCM-FORGED' },
      { aliases: ['伪造别名'] },
      { status: 'complete' },
      { recordedAt: NOW },
      { operator: 'forged-operator' },
      { username: 'forged-operator' },
      { mappingEvidenceHash: 'b'.repeat(64) },
      { ready: true },
      { finality: 'FINAL' },
      { amount: 12345 },
      { rosterSourceRef: 'roster://forged/v1' },
    ]
    for (const forged of forgedFields) {
      expectBridgeCode(() => callBridge(db, MONTH, forged), 'BRIDGE_INPUT_UNSUPPORTED_FIELD')
    }
    expectBridgeCode(() => bridgeHospitalCmDirectoryScopeForMonth(db, null as never), 'BRIDGE_INPUT_INVALID')
    expectBridgeCode(() => bridgeHospitalCmDirectoryScopeForMonth(db, [] as never), 'BRIDGE_INPUT_INVALID')
    expect(evidenceCounts(db)).toEqual({ scopes: 0, scopeAudits: 0 })
  })

  it('非法 serviceMonth / 缺 actor / 空 reason 一律稳定码拒绝且零写', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    expectBridgeCode(() => callBridge(db, '2026-13'), 'BRIDGE_SERVICE_MONTH_INVALID')
    expectBridgeCode(() => callBridge(db, '2026-5'), 'BRIDGE_SERVICE_MONTH_INVALID')
    expectBridgeCode(() => callBridge(db, MONTH, { actor: null }), 'BRIDGE_ACTOR_INVALID')
    expectBridgeCode(() => callBridge(db, MONTH, { actor: { userId: ACTOR.userId } }), 'BRIDGE_ACTOR_INVALID')
    expectBridgeCode(() => callBridge(db, MONTH, { actor: { userId: '', username: ACTOR.username } }), 'BRIDGE_ACTOR_INVALID')
    expectBridgeCode(() => callBridge(db, MONTH, { reason: '' }), 'BRIDGE_REASON_INVALID')
    expectBridgeCode(() => callBridge(db, MONTH, { reason: '   ' }), 'BRIDGE_REASON_INVALID')
    expect(evidenceCounts(db)).toEqual({ scopes: 0, scopeAudits: 0 })
  })

  it('actor 只来自 trusted input:审计与落库归属正确;unknown actor 在写路径被拒', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    const result = callBridge(db)
    expect(result.scope?.recordedByUserId).toBe(ACTOR.userId)
    expect(result.scope?.recordedByUsername).toBe(ACTOR.username)
    const audit = db.prepare(`
      SELECT operator FROM abc_audit_logs WHERE module = 'hospital_cm_period_evidence' AND target_id = ?
    `).get(result.scope!.id) as { operator: string }
    expect(audit.operator).toBe(ACTOR.username)
    expectBridgeCode(
      () => callBridge(db, '2026-09', { actor: { userId: 'unknown', username: 'unknown' } }),
      'PERIOD_EVIDENCE_ACTOR_REQUIRED',
    )
    expect(readCurrentMonthScope(db, '2026-09')).toBeNull()
  })
})

describe('#182/O-1 · 目录 → C1 scope 桥接:事务原子性与并发读取纪律', () => {
  it('第一次 ROLLBACK 命令故障后必须重试到事务结束，scope/audit 零 partial', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    db.exec(`
      CREATE TRIGGER test_bridge_transient_rollback_failure
      BEFORE INSERT ON hospital_cm_month_scope_snapshots
      BEGIN SELECT RAISE(ABORT, 'TEST_BRIDGE_TRANSIENT_ROLLBACK_FAILURE'); END;
    `)
    let rollbackAttempts = 0
    const faultDb = {
      prepare: (sql: string) => db.prepare(sql),
      exec: (sql: string) => {
        if (sql === 'ROLLBACK' && rollbackAttempts++ === 0) {
          throw new Error('TEST_FIRST_ROLLBACK_COMMAND_FAILURE')
        }
        return db.exec(sql)
      },
      get isTransaction() { return db.isTransaction },
    }
    try {
      expect(() => bridgeHospitalCmDirectoryScopeForMonth(faultDb as never, {
        serviceMonth: MONTH, actor: ACTOR, reason: '瞬时 rollback fault 演练',
      })).toThrow(/TEST_BRIDGE_TRANSIENT_ROLLBACK_FAILURE/)
      expect(rollbackAttempts).toBe(2)
      expect(db.isTransaction).toBe(false)
      expect(evidenceCounts(db)).toEqual({ scopes: 0, scopeAudits: 0 })
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK')
    }
  })

  it('ROLLBACK 持续故障时关闭不可复用连接，返回稳定码且磁盘无 committed partial', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-bridge-rollback-fault-'))
    const file = join(dir, 'rollback-fault.db')
    let db: DatabaseSync | null = null
    let checkDb: DatabaseSync | null = null
    try {
      db = createDb(file)
      saveDirectory(db, [dirEntry('PARTNER-001')])
      db.exec(`
        CREATE TRIGGER test_bridge_persistent_rollback_failure
        BEFORE INSERT ON hospital_cm_month_scope_snapshots
        BEGIN SELECT RAISE(ABORT, 'TEST_BRIDGE_PERSISTENT_ROLLBACK_FAILURE'); END;
      `)
      let closeCalled = false
      const faultDb = {
        prepare: (sql: string) => db!.prepare(sql),
        exec: (sql: string) => {
          if (sql === 'ROLLBACK') throw new Error('TEST_ROLLBACK_COMMAND_STILL_BROKEN')
          return db!.exec(sql)
        },
        close: () => {
          closeCalled = true
          db!.close()
        },
        get isTransaction() { return db!.isTransaction },
      }
      try {
        bridgeHospitalCmDirectoryScopeForMonth(faultDb as never, {
          serviceMonth: MONTH, actor: ACTOR, reason: '持续 rollback fault 演练',
        })
        throw new Error('expected rollback failure')
      } catch (error) {
        expect(error).toMatchObject({ code: 'BRIDGE_ROLLBACK_FAILED', status: 500 })
        expect((error as { cause?: Error }).cause?.message).toMatch(/TEST_BRIDGE_PERSISTENT_ROLLBACK_FAILURE/)
      }
      expect(closeCalled).toBe(true)
      db = null
      checkDb = new DatabaseSync(file)
      expect(evidenceCounts(checkDb)).toEqual({ scopes: 0, scopeAudits: 0 })
    } finally {
      try { checkDb?.close() } catch { /* test cleanup */ }
      try { db?.close() } catch { /* test cleanup */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('insert fault:整事务回滚,零 partial;故障解除后同连接可成功发布', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    db.exec(`
      CREATE TRIGGER test_bridge_scope_insert_failure
      BEFORE INSERT ON hospital_cm_month_scope_snapshots
      BEGIN SELECT RAISE(ABORT, 'TEST_BRIDGE_SCOPE_INSERT_FAILURE'); END;
    `)
    expect(() => callBridge(db)).toThrow(/TEST_BRIDGE_SCOPE_INSERT_FAILURE/)
    expect(evidenceCounts(db)).toEqual({ scopes: 0, scopeAudits: 0 })
    db.exec('DROP TRIGGER test_bridge_scope_insert_failure')
    const result = callBridge(db)
    expect(result.action).toBe('PUBLISHED')
    expect(evidenceCounts(db)).toEqual({ scopes: 1, scopeAudits: 1 })
  })

  it('audit fault:整事务回滚,scope 零 partial', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    // 目录修订落库后再拆审计表:桥接的 writeAuditLog 必失败,验证整事务回滚
    db.exec('DROP TABLE abc_audit_logs')
    expect(() => callBridge(db)).toThrow()
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_month_scope_snapshots').get() as { n: number }).n)).toBe(0)
    expect(readCurrentMonthScope(db, MONTH)).toBeNull()
  })

  it('readback fault:整事务回滚,零 scope/audit 残留', () => {
    const db = createDb()
    saveDirectory(db, [dirEntry('PARTNER-001')])
    const racedDb = {
      prepare: (sql: string) => {
        const statement = db.prepare(sql)
        if (sql.includes('FROM hospital_cm_month_scope_snapshots') && sql.includes('WHERE id = ?')) {
          return {
            get: () => undefined,
            all: (...args: unknown[]) => statement.all(...args),
            run: (...args: unknown[]) => statement.run(...args),
          }
        }
        return statement
      },
      exec: (sql: string) => db.exec(sql),
      get isTransaction() { return db.isTransaction },
    }
    expectBridgeCode(
      () => bridgeHospitalCmDirectoryScopeForMonth(racedDb as never, {
        serviceMonth: MONTH, actor: ACTOR, reason: 'readback 故障演练',
      }),
      'SCOPE_READBACK_FAILED',
    )
    expect(evidenceCounts(db)).toEqual({ scopes: 0, scopeAudits: 0 })
    expect(readCurrentMonthScope(db, MONTH)).toBeNull()
  })

  it('两连接 race:投影与 current 都在 BEGIN IMMEDIATE 之后读取,旧读取不得覆盖新事实', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-bridge-race-'))
    const file = join(dir, 'race.db')
    let dbA: DatabaseSync | null = null
    let dbB: DatabaseSync | null = null
    try {
      dbA = createDb(file)
      dbA.exec('PRAGMA journal_mode = WAL')
      saveDirectory(dbA, [dirEntry('PARTNER-001'), dirEntry('PARTNER-002')])
      dbB = new DatabaseSync(file)
      dbB.exec('PRAGMA busy_timeout = 5000')

      let injected = false
      const racedDb = {
        prepare: (sql: string) => dbA!.prepare(sql),
        exec: (sql: string) => {
          // 桥接获取写锁之前,对手连接先提交目录 v2(PARTNER-002 到 2026-07 退出)
          if (sql === 'BEGIN IMMEDIATE' && !injected) {
            injected = true
            saveDirectory(dbB!, [
              dirEntry('PARTNER-001'),
              dirEntry('PARTNER-002', { effectiveToMonth: '2026-07' }),
            ], { reasonCode: 'RIVAL_MEMBERSHIP_END' })
          }
          return dbA!.exec(sql)
        },
        get isTransaction() { return dbA!.isTransaction },
      }
      const result = bridgeHospitalCmDirectoryScopeForMonth(racedDb as never, {
        serviceMonth: MONTH, actor: ACTOR, reason: '竞态读取纪律演练',
      })
      expect(injected).toBe(true)
      // 桥接必须按拿锁后的活事实(v2)发布:PARTNER-002 不在 2026-08 成员内
      const projection = projectHospitalCmDirectoryForMonth(dbA, MONTH)!
      expect(projection.accounts).toEqual(['PARTNER-001'])
      expect(result.action).toBe('PUBLISHED')
      expect(result.scope?.accounts).toEqual(projection.accounts)
      expect(result.scope?.rosterSourceHash).toBe(projection.rosterSourceHash)
      expect(result.scope?.rosterSourceRef).toBe(`roster://hospital-cm-directory/${projection.directoryVersionId}`)
      expect(readCurrentMonthScope(dbA, MONTH)?.scopeHash).toBe(result.scope?.scopeHash)
    } finally {
      try { dbB?.close() } catch { /* already closed */ }
      try { dbA?.close() } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
