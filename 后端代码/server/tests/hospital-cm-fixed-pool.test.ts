import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FIXED_POOL_SCOPE_ATTESTATION,
  FIXED_POOL_SOURCE_KIND,
  HOSPITAL_CM_FIXED_POOL_POLICY_VERSION,
  HospitalCmFixedPoolError,
  createHospitalCmFixedPoolVersion,
  ensureHospitalCmFixedPoolSchema,
  listHospitalCmFixedPoolVersions,
  readHospitalCmFixedPoolState,
  recordHospitalCmFixedPoolDecision,
} from '../src/utils/hospital-cm-fixed-pool.js'
import {
  EXPECTED_HOSPITAL_CM_CONSTANT_MANIFEST_FINGERPRINT,
  currentHospitalCmConstantManifest,
  sha256,
} from '../src/utils/hospital-cm-foundation-probes.js'

const OWNER = { userId: 'USER-FIN-OWNER', username: 'finance.owner' }
const MAKER = { userId: 'USER-FIN-MAKER', username: 'finance.maker' }
const OTHER_OWNER = { userId: 'USER-FIN-OTHER', username: 'finance.other' }
const SOURCE_HASH = 'a'.repeat(64)
const RATIFICATION_HASH = 'b'.repeat(64)
let idempotencySequence = 0

const nextIdempotencyKey = (scope: string): string => `hcm-${scope}-${++idempotencySequence}`

function createDb(opts: { withAuditTable?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE hospital_cm_readiness_milestones (
      condition_key TEXT PRIMARY KEY,
      owner_role TEXT NOT NULL,
      owner_user_id TEXT,
      owner_name TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      owner_assignment_revision INTEGER NOT NULL DEFAULT 0,
      due_date TEXT,
      projected_date TEXT,
      completion_evidence_ref TEXT,
      completion_evidence_hash TEXT
    );
    INSERT INTO hospital_cm_readiness_milestones
      (condition_key, owner_role, owner_user_id, owner_name, revision, owner_assignment_revision, due_date)
    VALUES ('denominator', 'business', '${OWNER.userId}', '${OWNER.username}', 2, 1, '2026-08-31');
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      status INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL
    );
    INSERT INTO users (id, username, status, is_deleted) VALUES
      ('${OWNER.userId}', '${OWNER.username}', 1, 0),
      ('${MAKER.userId}', '${MAKER.username}', 1, 0),
      ('${OTHER_OWNER.userId}', '${OTHER_OWNER.username}', 1, 0);
  `)
  if (opts.withAuditTable !== false) {
    db.exec(`
      CREATE TABLE abc_audit_logs (
        id TEXT PRIMARY KEY,
        module TEXT,
        action TEXT NOT NULL,
        target_id TEXT,
        detail TEXT,
        operator TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
  }
  ensureHospitalCmFixedPoolSchema(db)
  return db
}

function createV1(db: DatabaseSync, overrides: Record<string, unknown> = {}) {
  return createHospitalCmFixedPoolVersion(db, {
    serviceMonth: '2026-07',
    amountMinor: 1_234_567,
    currency: 'CNY',
    scopeAttestation: FIXED_POOL_SCOPE_ATTESTATION,
    sourceEvidenceRef: 'finance-manifest://2026-07/fixed-pool',
    sourceEvidenceHash: SOURCE_HASH,
    changeReason: '初次建立月度固定开销池',
    actor: MAKER,
    idempotencyKey: nextIdempotencyKey('version'),
    ...overrides,
  })
}

function ratify(db: DatabaseSync, version: ReturnType<typeof createV1>, overrides: Record<string, unknown> = {}) {
  return recordHospitalCmFixedPoolDecision(db, {
    versionId: version.id,
    decision: 'RATIFIED',
    expectedContentHash: version.contentHash,
    evidenceRef: 'approval://finance-owner/2026-07',
    evidenceHash: RATIFICATION_HASH,
    reason: '已核对该月固定开销台账与口径',
    actor: OWNER,
    idempotencyKey: nextIdempotencyKey('decision'),
    ...overrides,
  })
}

describe('hospital-cm fixed pool B · 逐月不可变版本与具名认账', () => {
  let db: DatabaseSync

  beforeEach(() => {
    idempotencySequence = 0
    db = createDb()
  })

  it('无该月配置时诚实返回未配置，不把空值渲染为 0', () => {
    const state = readHospitalCmFixedPoolState(db, '2026-07')
    expect(state).toMatchObject({
      serviceMonth: '2026-07',
      configured: false,
      value: null,
      amountMinor: null,
      version: null,
      ratifiedVersion: null,
      currentDecision: null,
      invalidationCode: 'NOT_CONFIGURED',
    })
  })

  it('v1 已配置但未认账时保持 UNRATIFIED；版本与实金额均由服务端派生', () => {
    const v1 = createV1(db)
    expect(v1).toMatchObject({
      serviceMonth: '2026-07',
      versionNumber: 1,
      version: '2026-07.v1',
      amountMinor: 1_234_567,
      value: 12_345.67,
      currency: 'CNY',
      scopePolicyVersion: HOSPITAL_CM_FIXED_POOL_POLICY_VERSION,
    })
    expect(v1.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      configured: true,
      version: '2026-07.v1',
      ratifiedVersion: null,
      currentDecision: null,
      invalidationCode: 'UNRATIFIED',
    })
  })

  it('只有 denominator 当前具名 owner 能对当前内容哈希写入 RATIFIED', () => {
    const v1 = createV1(db)
    expect(() => ratify(db, v1, { actor: MAKER })).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_RATIFIER_NOT_OWNER', status: 403 }),
    )

    const decision = ratify(db, v1)
    expect(decision).toMatchObject({
      poolVersionId: v1.id,
      version: '2026-07.v1',
      decision: 'RATIFIED',
      contentHash: v1.contentHash,
      decidedByUserId: OWNER.userId,
      decidedByUsername: OWNER.username,
    })
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      configured: true,
      version: '2026-07.v1',
      ratifiedVersion: '2026-07.v1',
      currentDecision: 'RATIFIED',
      invalidationCode: null,
    })
  })

  it('owner 未具名或账号停用时认账与读状态都 fail-closed', () => {
    const v1 = createV1(db)
    db.prepare("UPDATE users SET status = 0 WHERE id = ?").run(OWNER.userId)
    expect(() => ratify(db, v1)).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_OWNER_INACTIVE', status: 409 }),
    )
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: null,
      invalidationCode: 'OWNER_INACTIVE',
    })

    db.prepare("UPDATE users SET status = 1 WHERE id = ?").run(OWNER.userId)
    db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET owner_user_id = NULL, owner_name = NULL, revision = 3
      WHERE condition_key = 'denominator'
    `).run()
    expect(() => ratify(db, v1)).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_OWNER_UNASSIGNED', status: 409 }),
    )
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: null,
      invalidationCode: 'OWNER_UNASSIGNED',
    })
  })

  it('同月新增 v2 后旧 v1 认账保留但自动失效，旧版不能再签', () => {
    const v1 = createV1(db)
    ratify(db, v1)
    const v2 = createV1(db, {
      amountMinor: 1_300_000,
      sourceEvidenceRef: 'finance-manifest://2026-07/fixed-pool-revised',
      sourceEvidenceHash: 'c'.repeat(64),
      changeReason: '年度调薪后修订',
    })

    expect(v2).toMatchObject({ versionNumber: 2, version: '2026-07.v2', supersedesVersionId: v1.id })
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      configured: true,
      version: '2026-07.v2',
      ratifiedVersion: '2026-07.v1',
      currentDecision: null,
      invalidationCode: 'CURRENT_VERSION_UNRATIFIED',
    })
    expect(() => ratify(db, v1)).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_VERSION_SUPERSEDED', status: 409 }),
    )
  })

  it('认账必须回显并绑定服务端 content hash，旧页面/重放请求不得误签', () => {
    const v1 = createV1(db)
    expect(() => ratify(db, v1, { expectedContentHash: '0'.repeat(64) })).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_CONTENT_CHANGED', status: 409 }),
    )
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_ratification_events').get() as any).n).toBe(0)
  })

  it('owner A→B→A 往返后旧签字不得复活，必须绑定新 assignment revision 重新认账', () => {
    const v1 = createV1(db)
    const first = ratify(db, v1)
    expect(first.ownerAssignmentRevision).toBe(1)
    db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET owner_user_id = ?, owner_name = ?, revision = 3, owner_assignment_revision = 2
      WHERE condition_key = 'denominator'
    `).run(OTHER_OWNER.userId, OTHER_OWNER.username)
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: null,
      invalidationCode: 'OWNER_CHANGED',
    })
    db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET owner_user_id = ?, owner_name = ?, revision = 4, owner_assignment_revision = 3
      WHERE condition_key = 'denominator'
    `).run(OWNER.userId, OWNER.username)
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: null,
      invalidationCode: 'OWNER_CHANGED',
    })

    const renewed = ratify(db, v1)
    expect(renewed.ownerAssignmentRevision).toBe(3)
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: '2026-07.v1',
      invalidationCode: null,
    })
  })

  it('denominator owner 角色离开 business 后旧签字失效，当前人也不能以 tech 角色重签', () => {
    const v1 = createV1(db)
    ratify(db, v1)
    db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET owner_role = 'tech', revision = 3, owner_assignment_revision = 2
      WHERE condition_key = 'denominator'
    `).run()

    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: null,
      invalidationCode: 'OWNER_ROLE_INVALID',
      ownerAssignmentRevision: 2,
    })
    expect(() => ratify(db, v1)).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_OWNER_ROLE_INVALID', status: 409 }),
    )
  })

  it('固定池政策版本、范围声明与来源类型进入 constant-freeze，改口径必须显式更新签名', () => {
    const manifest = currentHospitalCmConstantManifest()
    expect(manifest.fixedPool).toEqual({
      policyVersion: HOSPITAL_CM_FIXED_POOL_POLICY_VERSION,
      scopeAttestation: FIXED_POOL_SCOPE_ATTESTATION,
      sourceKind: FIXED_POOL_SOURCE_KIND,
    })
    expect(sha256(manifest)).toBe(EXPECTED_HOSPITAL_CM_CONSTANT_MANIFEST_FINGERPRINT)
  })

  it('due / projected / 完成证据变更不冒充 owner 换人，也不误撤销当前值认账', () => {
    const v1 = createV1(db)
    ratify(db, v1)
    const assertStillRatified = () => expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: '2026-07.v1',
      invalidationCode: null,
      ownerAssignmentRevision: 1,
    })

    db.prepare(`UPDATE hospital_cm_readiness_milestones SET due_date = '2026-09-01', revision = revision + 1 WHERE condition_key = 'denominator'`).run()
    assertStillRatified()
    db.prepare(`UPDATE hospital_cm_readiness_milestones SET projected_date = '2026-08-25', revision = revision + 1 WHERE condition_key = 'denominator'`).run()
    assertStillRatified()
    db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET completion_evidence_ref = 'approval://milestone/B', completion_evidence_hash = ?, revision = revision + 1
      WHERE condition_key = 'denominator'
    `).run('9'.repeat(64))
    assertStillRatified()
  })

  it('存量值的政策版本/口径声明与运行时要求不一致时，旧 RATIFIED 必须自动失效', () => {
    db.prepare(`
      INSERT INTO hospital_cm_fixed_pool_versions
        (id, service_month, version_no, amount_minor, currency, scope_policy_version, scope_attestation,
         source_kind, source_evidence_ref, source_evidence_hash, content_hash, supersedes_version_id,
         change_reason, created_by_user_id, created_by_username, created_at)
      VALUES ('legacy-policy-v1', '2026-07', 1, 1234567, 'CNY', 'ADR-008.fixed-pool.v0',
              'LEGACY_FIXED_SCOPE', 'FINANCE_MONTHLY_FIXED_COST_LEDGER', 'legacy://fixed-pool', ?, ?, NULL,
              '模拟升级前已认账值', ?, ?, '2026-07-01T00:00:00.000Z')
    `).run(SOURCE_HASH, 'c'.repeat(64), MAKER.userId, MAKER.username)
    db.prepare(`
      INSERT INTO hospital_cm_fixed_pool_ratification_events
        (id, pool_version_id, pool_content_hash, decision, evidence_ref, evidence_hash,
         decision_reason, decided_by_user_id, decided_by_username, owner_assignment_revision, decided_at)
      VALUES ('legacy-policy-ratified', 'legacy-policy-v1', ?, 'RATIFIED', 'legacy://approval', ?,
              '模拟旧政策下的有效签字', ?, ?, 1, '2026-07-02T00:00:00.000Z')
    `).run('c'.repeat(64), RATIFICATION_HASH, OWNER.userId, OWNER.username)

    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      configured: true,
      ratifiedVersion: null,
      invalidationCode: 'POLICY_MISMATCH',
    })
  })

  it('旧候选表补出的 NULL assignment revision 与具名 rev0 都不得被强转为有效签字', () => {
    const legacy = createDb()
    const v1 = createV1(legacy)
    legacy.exec(`
      DROP TABLE hospital_cm_fixed_pool_ratification_events;
      CREATE TABLE hospital_cm_fixed_pool_ratification_events (
        event_number INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        pool_version_id TEXT NOT NULL,
        pool_content_hash TEXT NOT NULL,
        decision TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        decision_reason TEXT NOT NULL,
        decided_by_user_id TEXT NOT NULL,
        decided_by_username TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );
    `)
    legacy.prepare(`
      INSERT INTO hospital_cm_fixed_pool_ratification_events
        (id, pool_version_id, pool_content_hash, decision, evidence_ref, evidence_hash,
         decision_reason, decided_by_user_id, decided_by_username, decided_at)
      VALUES ('legacy-null-revision', ?, ?, 'RATIFIED', 'legacy://approval', ?,
              '迁移前候选签字', ?, ?, '2026-07-02T00:00:00.000Z')
    `).run(v1.id, v1.contentHash, RATIFICATION_HASH, OWNER.userId, OWNER.username)
    legacy.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET owner_assignment_revision = 0
      WHERE condition_key = 'denominator'
    `).run()

    ensureHospitalCmFixedPoolSchema(legacy)
    expect(legacy.prepare(`
      SELECT owner_assignment_revision AS revision
      FROM hospital_cm_fixed_pool_ratification_events
      WHERE id = 'legacy-null-revision'
    `).get()).toEqual({ revision: null })
    expect(readHospitalCmFixedPoolState(legacy, '2026-07')).toMatchObject({
      ratifiedVersion: null,
      invalidationCode: 'OWNER_ASSIGNMENT_INVALID',
      ratification: expect.objectContaining({ ownerAssignmentRevision: null }),
    })
    expect(() => ratify(legacy, v1)).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_OWNER_ASSIGNMENT_INVALID', status: 409 }),
    )
  })

  it('幂等键与 actor+请求指纹绑定：同键同体返原 ID，同键异体/跨用户 409', () => {
    const input = {
      serviceMonth: '2026-07',
      amountMinor: 1_234_567,
      currency: 'CNY' as const,
      scopeAttestation: FIXED_POOL_SCOPE_ATTESTATION,
      sourceEvidenceRef: 'finance-manifest://2026-07/fixed-pool',
      sourceEvidenceHash: SOURCE_HASH,
      changeReason: '初次建立月度固定开销池',
      actor: MAKER,
      idempotencyKey: 'hcm-fixed-pool-idem-001',
    }
    const first = createHospitalCmFixedPoolVersion(db, input)
    const replay = createHospitalCmFixedPoolVersion(db, input)
    expect(replay.id).toBe(first.id)
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_versions').get() as any).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM abc_audit_logs').get() as any).n).toBe(1)

    expect(() => createHospitalCmFixedPoolVersion(db, { ...input, amountMinor: input.amountMinor + 1 }))
      .toThrowError(expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_IDEMPOTENCY_CONFLICT', status: 409 }))
    expect(() => createHospitalCmFixedPoolVersion(db, { ...input, actor: OWNER }))
      .toThrowError(expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_IDEMPOTENCY_CONFLICT', status: 409 }))
  })

  it('RATIFIED 幂等重放只返原事件，不能让已出现 v2 的月份重新通过', () => {
    const v1 = createV1(db)
    const input = {
      versionId: v1.id,
      decision: 'RATIFIED' as const,
      expectedContentHash: v1.contentHash,
      evidenceRef: 'approval://finance-owner/2026-07/idempotent',
      evidenceHash: RATIFICATION_HASH,
      reason: '验证认账接口重试语义',
      actor: OWNER,
      idempotencyKey: 'hcm-decision-idempotent-001',
    }
    const first = recordHospitalCmFixedPoolDecision(db, input)
    expect(recordHospitalCmFixedPoolDecision(db, input).id).toBe(first.id)
    createV1(db, {
      amountMinor: 1_300_000,
      sourceEvidenceRef: 'finance-manifest://2026-07/v2-after-replay',
      sourceEvidenceHash: '8'.repeat(64),
      changeReason: '新增当前版本验证旧幂等事件不复活',
    })
    expect(recordHospitalCmFixedPoolDecision(db, input).id).toBe(first.id)
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      version: '2026-07.v2',
      ratifiedVersion: '2026-07.v1',
      invalidationCode: 'CURRENT_VERSION_UNRATIFIED',
    })
  })

  it('撤销是追加式决策，不覆盖旧签字，且立即恢复 fail-closed', () => {
    const v1 = createV1(db)
    ratify(db, v1)
    recordHospitalCmFixedPoolDecision(db, {
      versionId: v1.id,
      decision: 'REVOKED',
      expectedContentHash: v1.contentHash,
      evidenceRef: 'approval://finance-owner/2026-07/revocation',
      evidenceHash: 'd'.repeat(64),
      reason: '发现来源台账需重新核对',
      actor: OWNER,
      idempotencyKey: nextIdempotencyKey('revoke'),
    })
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      version: '2026-07.v1',
      ratifiedVersion: null,
      currentDecision: 'REVOKED',
      invalidationCode: 'RATIFICATION_REVOKED',
    })
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_ratification_events').get() as any).n).toBe(2)
  })

  it('版本、认账与幂等记录在数据库层 append-only，UPDATE/DELETE/OR REPLACE 均不可改写', () => {
    const v1 = createV1(db)
    ratify(db, v1)
    expect(() => db.prepare('UPDATE hospital_cm_fixed_pool_versions SET amount_minor = 1 WHERE id = ?').run(v1.id))
      .toThrow(/FIXED_POOL_VERSION_APPEND_ONLY/)
    expect(() => db.prepare('DELETE FROM hospital_cm_fixed_pool_versions WHERE id = ?').run(v1.id))
      .toThrow(/FIXED_POOL_VERSION_APPEND_ONLY/)
    expect(() => db.prepare("UPDATE hospital_cm_fixed_pool_ratification_events SET decision = 'REVOKED'").run())
      .toThrow(/FIXED_POOL_RATIFICATION_APPEND_ONLY/)
    expect(() => db.prepare('DELETE FROM hospital_cm_fixed_pool_ratification_events').run())
      .toThrow(/FIXED_POOL_RATIFICATION_APPEND_ONLY/)

    expect(() => db.prepare(`
      INSERT OR REPLACE INTO hospital_cm_fixed_pool_versions
        (event_number, id, service_month, version_no, amount_minor, currency, scope_policy_version,
         scope_attestation, source_kind, source_evidence_ref, source_evidence_hash, content_hash,
         supersedes_version_id, change_reason, created_by_user_id, created_by_username, created_at)
      SELECT event_number, id, service_month, version_no, amount_minor + 1, currency, scope_policy_version,
             scope_attestation, source_kind, source_evidence_ref, source_evidence_hash, content_hash,
             supersedes_version_id, change_reason, created_by_user_id, created_by_username, created_at
      FROM hospital_cm_fixed_pool_versions WHERE id = ?
    `).run(v1.id)).toThrow(/FIXED_POOL_VERSION_APPEND_ONLY/)
    expect(readHospitalCmFixedPoolState(db, '2026-07').amountMinor).toBe(1_234_567)

    expect(() => db.prepare(`
      INSERT OR REPLACE INTO hospital_cm_fixed_pool_ratification_events
        (event_number, id, pool_version_id, pool_content_hash, decision, evidence_ref, evidence_hash,
         decision_reason, decided_by_user_id, decided_by_username, owner_assignment_revision, decided_at)
      SELECT event_number, id, pool_version_id, pool_content_hash, 'REVOKED', evidence_ref, evidence_hash,
             decision_reason, decided_by_user_id, decided_by_username, owner_assignment_revision, decided_at
      FROM hospital_cm_fixed_pool_ratification_events
      WHERE pool_version_id = ? ORDER BY event_number DESC LIMIT 1
    `).run(v1.id)).toThrow(/FIXED_POOL_RATIFICATION_APPEND_ONLY/)
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: '2026-07.v1', invalidationCode: null,
    })

    const revoked = recordHospitalCmFixedPoolDecision(db, {
      versionId: v1.id,
      decision: 'REVOKED',
      expectedContentHash: v1.contentHash,
      evidenceRef: 'approval://finance-owner/2026-07/append-only-revoke',
      evidenceHash: 'd'.repeat(64),
      reason: '验证 REVOKED 不能被原地替换回 RATIFIED',
      actor: OWNER,
      idempotencyKey: nextIdempotencyKey('append-only-revoke'),
    })
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO hospital_cm_fixed_pool_ratification_events
        (event_number, id, pool_version_id, pool_content_hash, decision, evidence_ref, evidence_hash,
         decision_reason, decided_by_user_id, decided_by_username, owner_assignment_revision, decided_at)
      SELECT event_number, id, pool_version_id, pool_content_hash, 'RATIFIED', evidence_ref, evidence_hash,
             decision_reason, decided_by_user_id, decided_by_username, owner_assignment_revision, decided_at
      FROM hospital_cm_fixed_pool_ratification_events WHERE id = ?
    `).run(revoked.id)).toThrow(/FIXED_POOL_RATIFICATION_APPEND_ONLY/)
    expect(readHospitalCmFixedPoolState(db, '2026-07')).toMatchObject({
      ratifiedVersion: null, invalidationCode: 'RATIFICATION_REVOKED',
    })

    expect(() => db.prepare(`
      INSERT OR REPLACE INTO hospital_cm_fixed_pool_idempotency
      SELECT * FROM hospital_cm_fixed_pool_idempotency ORDER BY created_at LIMIT 1
    `).run()).toThrow(/FIXED_POOL_IDEMPOTENCY_APPEND_ONLY/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_ratification_events').get() as any).n).toBe(2)
  })

  it('严格拒绝非法月份、非 CNY、非正安全整数分、错误口径声明与不完整证据', () => {
    for (const overrides of [
      { serviceMonth: '2026-13' },
      { currency: 'USD' },
      { amountMinor: 0 },
      { amountMinor: 1.5 },
      { amountMinor: Number.POSITIVE_INFINITY },
      { scopeAttestation: 'INCLUDES_ALL_COSTS' },
      { sourceEvidenceHash: 'abc' },
      { sourceEvidenceRef: '' },
      { sourceEvidenceRef: '=HYPERLINK("bad")' },
      { sourceEvidenceRef: '+SUM(1,2)' },
      { sourceEvidenceRef: '-2+3' },
      { sourceEvidenceRef: '@cmd' },
      { sourceEvidenceRef: '\t=HYPERLINK("bad")' },
      { sourceEvidenceRef: 'finance-manifest://ok\rformula' },
      { changeReason: '   ' },
      { changeReason: '=HYPERLINK("bad")' },
      { idempotencyKey: '' },
    ]) {
      expect(() => createV1(db, overrides)).toThrowError(HospitalCmFixedPoolError)
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_versions').get() as any).n).toBe(0)

    const v1 = createV1(db)
    expect(() => ratify(db, v1, { reason: '=HYPERLINK("bad")' })).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_DECISION_REASON_INVALID', status: 400 }),
    )
  })

  it('各月独立选值，不会把一个已签值隐式复用到另一月', () => {
    const july = createV1(db)
    ratify(db, july)
    expect(readHospitalCmFixedPoolState(db, '2026-08')).toMatchObject({
      configured: false,
      value: null,
      version: null,
      ratifiedVersion: null,
    })
  })

  it('钱类写入与 abc_audit_logs 同事务：审计落库失败时不留半条版本', () => {
    const broken = createDb({ withAuditTable: false })
    expect(() => createV1(broken)).toThrow()
    expect((broken.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_versions').get() as any).n).toBe(0)
  })

  it('历史读模型按月返回完整 v1→v2 与签字事件，不产生 N+1', () => {
    const v1 = createV1(db)
    ratify(db, v1)
    createV1(db, {
      amountMinor: 1_300_000,
      sourceEvidenceHash: 'e'.repeat(64),
      sourceEvidenceRef: 'finance-manifest://2026-07/v2',
      changeReason: '修订固定间接费',
    })
    const history = listHospitalCmFixedPoolVersions(db, '2026-07')
    expect(history.versions.map((row) => row.version)).toEqual(['2026-07.v2', '2026-07.v1'])
    expect(history.events).toHaveLength(1)
    expect(history.events[0]).toMatchObject({ version: '2026-07.v1', decision: 'RATIFIED' })
  })

  it('审计历史默认 50/硬上限 100 并使用 cursor，查询数不随版本量增长', () => {
    for (let i = 0; i < 60; i += 1) {
      createV1(db, {
        amountMinor: 1_000_000 + i,
        sourceEvidenceRef: `finance-manifest://2026-07/version-${i + 1}`,
        sourceEvidenceHash: i.toString(16).padStart(64, '0'),
        changeReason: `历史分页压力样本 ${i + 1}`,
      })
    }
    let prepares = 0
    const counted = {
      prepare(sql: string) { prepares += 1; return db.prepare(sql) },
      exec(sql: string) { return db.exec(sql) },
    }
    const first = listHospitalCmFixedPoolVersions(counted, '2026-07')
    const firstQueryCount = prepares
    expect(first.versions).toHaveLength(50)
    expect(first.pagination).toMatchObject({ limit: 50 })
    expect(first.pagination.nextVersionCursor).toEqual(expect.any(Number))

    prepares = 0
    const second = listHospitalCmFixedPoolVersions(counted, '2026-07', {
      beforeVersionEvent: first.pagination.nextVersionCursor,
      limit: 50,
    })
    expect(second.versions).toHaveLength(10)
    expect(prepares).toBe(firstQueryCount)
    expect(() => listHospitalCmFixedPoolVersions(db, '2026-07', { limit: 101 })).toThrowError(
      expect.objectContaining<Partial<HospitalCmFixedPoolError>>({ code: 'FIXED_POOL_PAGE_INVALID', status: 400 }),
    )
  })

  it('幂等记录不能绕过应用层直接指向不存在的版本/决策', () => {
    expect(() => db.prepare(`
      INSERT INTO hospital_cm_fixed_pool_idempotency
        (idempotency_key, actor_user_id, request_hash, operation, result_kind, result_id, created_at)
      VALUES ('hcm-orphan-result-001', ?, ?, 'CREATE_VERSION', 'VERSION', 'missing', ?)
    `).run(MAKER.userId, 'f'.repeat(64), new Date().toISOString())).toThrow(/FIXED_POOL_IDEMPOTENCY_RESULT_INVALID/)
  })
})
