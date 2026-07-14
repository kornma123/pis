import { DatabaseSync } from 'node:sqlite'
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'
import {
  HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE,
  HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION,
  HospitalCmAccountRosterError,
  createHospitalCmAccountRosterCandidate,
  ensureHospitalCmAccountRosterSchema,
  getHospitalCmAccountRosterCandidate,
  listHospitalCmAccountRosterCandidates,
} from '../src/utils/hospital-cm-account-roster.js'

const MAKER = { userId: 'USER-FIN-MAKER', username: 'finance.maker' }
const OTHER = { userId: 'USER-FIN-OTHER', username: 'finance.other' }
const SOURCE_HASH = 'a'.repeat(64)
let idempotencySequence = 0

function nextIdempotencyKey(): string {
  idempotencySequence += 1
  return `hcm-roster-candidate-${idempotencySequence}`
}

function createDb(opts: { withAuditTable?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
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
  ensureHospitalCmAccountRosterSchema(db)
  return db
}

function entries(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    accountKey: `ACCOUNT-${String(index + 1).padStart(4, '0')}`,
    partnerId: index % 2 === 0 ? `PARTNER-${String(index + 1).padStart(4, '0')}` : null,
    sourceCooperationCode: index % 2 === 0 ? 'SOURCE_FULL_PROCESS' : 'SOURCE_PURE_DELIVERY',
    sourceActivityCode: index % 3 === 0 ? 'SOURCE_ACTIVE' : 'SOURCE_UNKNOWN',
  }))
}

function candidateInput(overrides: Record<string, unknown> = {}) {
  return {
    serviceMonth: '2026-07',
    claimedSourceKind: 'FINANCE_SETTLEMENT_ROSTER',
    sourceVersion: 'finance-export-2026-07-r1',
    sourceEvidenceRef: 'manifest://finance/settlement-roster/2026-07/r1',
    sourceEvidenceHash: SOURCE_HASH,
    changeReason: '首次保存候选月度账户名册，不声明其权威性',
    entries: entries(),
    actor: MAKER,
    idempotencyKey: nextIdempotencyKey(),
    ...overrides,
  }
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
}

describe('hospital-cm D2 B0 · candidate-only 版本化账户名册控制面', () => {
  let db: DatabaseSync

  beforeEach(() => {
    idempotencySequence = 0
    db = createDb()
  })

  it('初始化只建空控制面，不 seed 名册，也没有 authority/complete/measured/ready 结论列', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_versions').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_entries').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_idempotency').get()).toEqual({ n: 0 })

    const forbidden = /authority|complete|measured|ready/i
    for (const table of [
      'hospital_cm_account_roster_candidate_versions',
      'hospital_cm_account_roster_candidate_entries',
      'hospital_cm_account_roster_candidate_idempotency',
    ]) {
      expect(tableColumns(db, table).filter(column => forbidden.test(column))).toEqual([])
    }

    expect(listHospitalCmAccountRosterCandidates(db, '2026-07', 'FINANCE_SETTLEMENT_ROSTER')).toEqual({
      serviceMonth: '2026-07',
      claimedSourceKind: 'FINANCE_SETTLEMENT_ROSTER',
      usage: HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE,
      current: null,
      versions: [],
      pagination: { limit: 50, nextCursor: null },
    })
    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
    expect(tableNames.some(name => name.startsWith('hospital_cm_readiness'))).toBe(false)
  })

  it('schema 初始化可重复执行，且不会改写调用方的 foreign_keys 连接语义', () => {
    const isolated = new DatabaseSync(':memory:')
    isolated.exec('PRAGMA foreign_keys = OFF')
    ensureHospitalCmAccountRosterSchema(isolated)
    ensureHospitalCmAccountRosterSchema(isolated)
    expect(isolated.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 })
    const objects = isolated.prepare(`
      SELECT type, name, COUNT(*) AS n
      FROM sqlite_master
      WHERE name LIKE 'hospital_cm_account_roster_candidate_%'
         OR name LIKE 'trg_hcm_account_roster_candidate_%'
      GROUP BY type, name
      HAVING COUNT(*) > 1
    `).all()
    expect(objects).toEqual([])
    expect(() => isolated.prepare(`
      INSERT INTO hospital_cm_account_roster_candidate_idempotency
        (idempotency_key, operation, actor_user_id, request_hash, result_id, created_at)
      VALUES ('missing-result-0001', 'CREATE_CANDIDATE', 'USER-X', ?,
        '00000000-0000-4000-8000-000000000000', '2026-07-14T00:00:00.000Z')
    `).run('a'.repeat(64))).toThrow(/ACCOUNT_ROSTER_CANDIDATE_RESULT_MISSING/)
    expect(() => isolated.prepare(`
      INSERT INTO hospital_cm_account_roster_candidate_entries
        (roster_version_id, account_key, partner_id, source_cooperation_code,
         source_activity_code, row_hash)
      VALUES ('00000000-0000-4000-8000-000000000000', 'ACCOUNT-ORPHAN', NULL,
        'SOURCE_UNKNOWN', 'SOURCE_UNKNOWN', ?)
    `).run('b'.repeat(64))).toThrow(/ACCOUNT_ROSTER_CANDIDATE_HEADER_MISSING/)
  })

  it('服务器派生版本号、逐行 hash 与内容 hash；输入顺序变化的幂等重放仍返回原版本', () => {
    const idempotencyKey = nextIdempotencyKey()
    const input = candidateInput({ idempotencyKey })
    const created = createHospitalCmAccountRosterCandidate(db, input)

    expect(created).toMatchObject({
      serviceMonth: '2026-07',
      versionNumber: 1,
      version: '2026-07.FINANCE_SETTLEMENT_ROSTER.candidate.v1',
      usage: HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE,
      rowCount: 2,
      supersedesVersionId: null,
      createdByUserId: MAKER.userId,
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(created.entries.map(entry => entry.accountKey)).toEqual(['ACCOUNT-0001', 'ACCOUNT-0002'])
    expect(created.entries.every(entry => /^[0-9a-f]{64}$/.test(entry.rowHash))).toBe(true)

    const replayed = createHospitalCmAccountRosterCandidate(db, {
      ...input,
      entries: [...(input.entries as ReturnType<typeof entries>)].reverse(),
    })
    expect(replayed).toEqual(created)
    expect(db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_versions').get()).toEqual({ n: 1 })
  })

  it('稳定内容身份不含随机 id、事件版本、理由、操作人或时间；新幂等键不会制造假 v2', () => {
    const first = createHospitalCmAccountRosterCandidate(db, candidateInput())
    const sameContent = createHospitalCmAccountRosterCandidate(db, candidateInput({
      changeReason: '同一来源内容的重复业务提交，不应制造新版本',
      actor: OTHER,
      sourceEvidenceRef: 'manifest://finance/settlement-roster/2026-07/mirrored-location',
    }))
    expect(sameContent).toEqual(first)
    expect(db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_versions').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_idempotency').get()).toEqual({ n: 2 })
  })

  it('拒绝调用者提交任何结论字段、医院名或未批准的行字段', () => {
    for (const forged of [
      { ready: true },
      { authority: 'RATIFIED' },
      { complete: true },
      { measured: true },
      { versionNumber: 99 },
      { contentHash: 'b'.repeat(64) },
    ]) {
      expect(() => createHospitalCmAccountRosterCandidate(db, candidateInput(forged))).toThrowError(
        expect.objectContaining({ code: 'ACCOUNT_ROSTER_RESULT_INPUT_FORBIDDEN' }),
      )
    }

    expect(() => createHospitalCmAccountRosterCandidate(db, candidateInput({
      entries: [{
        ...entries(1)[0],
        hospitalName: '不应进入候选控制面的名称',
      }],
    }))).toThrowError(expect.objectContaining({ code: 'ACCOUNT_ROSTER_ENTRY_FIELD_FORBIDDEN' }))
    expect(db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_versions').get()).toEqual({ n: 0 })
  })

  it('同月只追加 v2 并指向 v1；版本、行与幂等记录均拒绝 UPDATE/DELETE/OR REPLACE', () => {
    const v1 = createHospitalCmAccountRosterCandidate(db, candidateInput())
    const v2 = createHospitalCmAccountRosterCandidate(db, candidateInput({
      sourceVersion: 'finance-export-2026-07-r2',
      sourceEvidenceHash: 'b'.repeat(64),
      changeReason: '来源导出修订，追加候选版本',
    }))
    expect(v2.versionNumber).toBe(2)
    expect(v2.supersedesVersionId).toBe(v1.id)

    expect(() => db.prepare('UPDATE hospital_cm_account_roster_candidate_versions SET change_reason = ? WHERE id = ?').run('改写', v1.id))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_VERSION_APPEND_ONLY/)
    expect(() => db.prepare('DELETE FROM hospital_cm_account_roster_candidate_versions WHERE id = ?').run(v1.id))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_VERSION_APPEND_ONLY/)
    expect(() => db.prepare('INSERT OR REPLACE INTO hospital_cm_account_roster_candidate_versions SELECT * FROM hospital_cm_account_roster_candidate_versions WHERE id = ?').run(v1.id))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_VERSION_APPEND_ONLY/)

    expect(() => db.prepare('UPDATE hospital_cm_account_roster_candidate_entries SET source_activity_code = ? WHERE roster_version_id = ?').run('SOURCE_INACTIVE', v1.id))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_ENTRY_APPEND_ONLY/)
    expect(() => db.prepare('DELETE FROM hospital_cm_account_roster_candidate_entries WHERE roster_version_id = ?').run(v1.id))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_ENTRY_APPEND_ONLY/)
    expect(() => db.prepare('INSERT OR REPLACE INTO hospital_cm_account_roster_candidate_entries SELECT * FROM hospital_cm_account_roster_candidate_entries WHERE roster_version_id = ? LIMIT 1').run(v1.id))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_ENTRY_APPEND_ONLY|ACCOUNT_ROSTER_CANDIDATE_VERSION_SEALED/)

    const key = db.prepare('SELECT idempotency_key AS key FROM hospital_cm_account_roster_candidate_idempotency LIMIT 1').get() as { key: string }
    expect(() => db.prepare('UPDATE hospital_cm_account_roster_candidate_idempotency SET operation = ? WHERE idempotency_key = ?').run('改写', key.key))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_IDEMPOTENCY_APPEND_ONLY/)
    expect(() => db.prepare('DELETE FROM hospital_cm_account_roster_candidate_idempotency WHERE idempotency_key = ?').run(key.key))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_IDEMPOTENCY_APPEND_ONLY/)
    expect(() => db.prepare('INSERT OR REPLACE INTO hospital_cm_account_roster_candidate_idempotency SELECT * FROM hospital_cm_account_roster_candidate_idempotency WHERE idempotency_key = ?').run(key.key))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_IDEMPOTENCY_APPEND_ONLY/)
  })

  it('同月不同 sourceKind 各自从 v1 起步，互不 supersede，也不争抢 current', () => {
    const settlement = createHospitalCmAccountRosterCandidate(db, candidateInput())
    const contract = createHospitalCmAccountRosterCandidate(db, candidateInput({
      claimedSourceKind: 'CONTRACT_ACCOUNT_ROSTER',
      sourceVersion: 'contract-register-2026-07-r1',
      sourceEvidenceRef: 'manifest://contracts/account-roster/2026-07/r1',
      changeReason: '合同来源的独立候选快照，不替代结算来源',
    }))
    expect(settlement).toMatchObject({ versionNumber: 1, supersedesVersionId: null })
    expect(contract).toMatchObject({ versionNumber: 1, supersedesVersionId: null })
    expect(contract.version).toBe('2026-07.CONTRACT_ACCOUNT_ROSTER.candidate.v1')
    expect(listHospitalCmAccountRosterCandidates(
      db,
      '2026-07',
      'FINANCE_SETTLEMENT_ROSTER',
    ).current?.id).toBe(settlement.id)
    expect(listHospitalCmAccountRosterCandidates(
      db,
      '2026-07',
      'CONTRACT_ACCOUNT_ROSTER',
    ).current?.id).toBe(contract.id)
  })

  it('foreign_keys 关闭时也拒绝伪造 supersedesVersionId，版本链不依赖 FK 才可信', () => {
    const isolated = createDb()
    isolated.exec('PRAGMA foreign_keys = OFF')
    createHospitalCmAccountRosterCandidate(isolated, candidateInput())
    expect(() => isolated.prepare(`
      INSERT INTO hospital_cm_account_roster_candidate_versions (
        id, service_month, version_number, contract_version, claimed_source_kind,
        source_version, source_evidence_ref, source_evidence_hash, row_count,
        content_hash, supersedes_version_id, change_reason, created_by_user_id,
        created_by_username, created_at
      ) VALUES (?, '2026-07', 2, ?, 'FINANCE_SETTLEMENT_ROSTER',
        'finance-export-2026-07-forged', 'manifest://finance/settlement-roster/2026-07/forged',
        ?, 1, ?, ?, '伪造替代链', 'USER-FORGER', 'forger', '2026-07-14T00:00:00.000Z')
    `).run(
      '11111111-1111-4111-8111-111111111111',
      HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION,
      'b'.repeat(64),
      'c'.repeat(64),
      '00000000-0000-4000-8000-000000000000',
    )).toThrow(/ACCOUNT_ROSTER_CANDIDATE_VERSION_SEQUENCE_INVALID/)
  })

  it('FK/recursive triggers 都关闭时，旧 event_number 也不能用 OR REPLACE 换成全新 header', () => {
    const isolated = createDb()
    const original = createHospitalCmAccountRosterCandidate(isolated, candidateInput())
    isolated.exec('PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = OFF;')
    const snapshot = () => ({
      versions: isolated.prepare('SELECT * FROM hospital_cm_account_roster_candidate_versions ORDER BY event_number').all(),
      entries: isolated.prepare('SELECT * FROM hospital_cm_account_roster_candidate_entries ORDER BY event_number').all(),
      idempotency: isolated.prepare('SELECT * FROM hospital_cm_account_roster_candidate_idempotency ORDER BY idempotency_key').all(),
    })
    const before = snapshot()
    expect(() => isolated.prepare(`
      INSERT OR REPLACE INTO hospital_cm_account_roster_candidate_versions (
        event_number, id, service_month, version_number, contract_version,
        claimed_source_kind, source_version, source_evidence_ref, source_evidence_hash,
        row_count, content_hash, supersedes_version_id, change_reason,
        created_by_user_id, created_by_username, created_at
      ) VALUES (?, '22222222-2222-4222-8222-222222222222', '2026-08', 1, ?,
        'CONTRACT_ACCOUNT_ROSTER', 'contract-register-2026-08-r1',
        'manifest://contracts/account-roster/2026-08/r1', ?, 1, ?, NULL,
        '试图复用旧 event number', 'USER-FORGER', 'forger', '2026-07-14T00:00:00.000Z')
    `).run(
      original.eventNumber,
      HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION,
      'e'.repeat(64),
      'd'.repeat(64),
    )).toThrow(/ACCOUNT_ROSTER_CANDIDATE_VERSION_APPEND_ONLY/)
    expect(snapshot()).toEqual(before)
  })

  it('FK/recursive triggers 都关闭时，idempotency 旧事件号也不能被 OR REPLACE 换 key', () => {
    const isolated = createDb()
    const original = createHospitalCmAccountRosterCandidate(isolated, candidateInput())
    isolated.exec('PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = OFF;')
    const oldIdempotency = isolated.prepare(`
      SELECT event_number AS eventNumber
      FROM hospital_cm_account_roster_candidate_idempotency LIMIT 1
    `).get() as { eventNumber: number }
    const snapshot = () => ({
      versions: isolated.prepare('SELECT * FROM hospital_cm_account_roster_candidate_versions ORDER BY event_number').all(),
      entries: isolated.prepare('SELECT * FROM hospital_cm_account_roster_candidate_entries ORDER BY event_number').all(),
      idempotency: isolated.prepare('SELECT * FROM hospital_cm_account_roster_candidate_idempotency ORDER BY event_number').all(),
    })
    const before = snapshot()
    expect(() => isolated.prepare(`
      INSERT OR REPLACE INTO hospital_cm_account_roster_candidate_idempotency (
        rowid, idempotency_key, operation, actor_user_id, request_hash, result_id, created_at
      ) VALUES (?, 'replacement-idempotency-0001', 'CREATE_CANDIDATE',
        'USER-FORGER', ?, ?, '2026-07-14T00:00:00.000Z')
    `).run(oldIdempotency.eventNumber, 'f'.repeat(64), original.id))
      .toThrow(/ACCOUNT_ROSTER_CANDIDATE_IDEMPOTENCY_APPEND_ONLY/)
    expect(snapshot()).toEqual(before)
  })

  it('版本封存后不能偷偷追加账户行，旧 content hash 不会继续冒充当前内容', () => {
    const version = createHospitalCmAccountRosterCandidate(db, candidateInput())
    expect(() => db.prepare(`
      INSERT INTO hospital_cm_account_roster_candidate_entries
        (roster_version_id, account_key, partner_id, source_cooperation_code, source_activity_code, row_hash)
      VALUES (?, 'ACCOUNT-LATE', NULL, 'SOURCE_UNKNOWN', 'SOURCE_UNKNOWN', ?)
    `).run(version.id, 'c'.repeat(64))).toThrow(/ACCOUNT_ROSTER_CANDIDATE_VERSION_SEALED/)
    expect(getHospitalCmAccountRosterCandidate(db, version.id)).toEqual(version)
  })

  it('幂等键绑定 actor 与规范化请求：同键异体或跨用户均 409，不能覆盖旧结果', () => {
    const idempotencyKey = nextIdempotencyKey()
    const input = candidateInput({ idempotencyKey })
    const first = createHospitalCmAccountRosterCandidate(db, input)

    const renamedActorReplay = createHospitalCmAccountRosterCandidate(db, {
      ...input,
      actor: { userId: MAKER.userId, username: 'finance.maker.renamed' },
    })
    expect(renamedActorReplay).toEqual(first)

    for (const changed of [
      { ...input, sourceVersion: 'changed' },
      { ...input, sourceEvidenceRef: 'manifest://finance/settlement-roster/2026-07/other-location' },
      { ...input, actor: OTHER },
    ]) {
      expect(() => createHospitalCmAccountRosterCandidate(db, changed)).toThrowError(
        expect.objectContaining({ code: 'ACCOUNT_ROSTER_IDEMPOTENCY_CONFLICT', status: 409 }),
      )
    }
    expect(getHospitalCmAccountRosterCandidate(db, first.id)).toEqual(first)
  })

  it('名册、审计和幂等写入同一事务；审计表缺失时整批不留半写', () => {
    const isolated = createDb({ withAuditTable: false })
    expect(() => createHospitalCmAccountRosterCandidate(isolated, candidateInput())).toThrow()
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_versions').get()).toEqual({ n: 0 })
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_entries').get()).toEqual({ n: 0 })
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_idempotency').get()).toEqual({ n: 0 })
  })

  it('第二行落库失败时，header、第一行、审计与幂等全部回滚', () => {
    const isolated = createDb()
    isolated.exec(`
      CREATE TRIGGER reject_second_candidate_row
      BEFORE INSERT ON hospital_cm_account_roster_candidate_entries
      WHEN NEW.account_key = 'ACCOUNT-0002'
      BEGIN SELECT RAISE(ABORT, 'TEST_SECOND_ROW_FAILURE'); END;
    `)
    expect(() => createHospitalCmAccountRosterCandidate(isolated, candidateInput())).toThrow(/TEST_SECOND_ROW_FAILURE/)
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_versions').get()).toEqual({ n: 0 })
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_entries').get()).toEqual({ n: 0 })
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_idempotency').get()).toEqual({ n: 0 })
    expect(isolated.prepare("SELECT COUNT(*) AS n FROM abc_audit_logs WHERE module = 'hospital_cm_account_roster'").get()).toEqual({ n: 0 })
  })

  it('事务内回读发现 hash 被篡改时整批回滚，不会先提交再报错', () => {
    const isolated = createDb()
    isolated.exec(`
      DROP TRIGGER trg_hcm_account_roster_candidate_entries_no_update;
      CREATE TRIGGER corrupt_candidate_row_for_test
      AFTER INSERT ON hospital_cm_account_roster_candidate_entries
      WHEN NEW.account_key = 'ACCOUNT-0002'
      BEGIN
        UPDATE hospital_cm_account_roster_candidate_entries
        SET row_hash = '${'0'.repeat(64)}'
        WHERE event_number = NEW.event_number;
      END;
    `)
    expect(() => createHospitalCmAccountRosterCandidate(isolated, candidateInput())).toThrowError(
      expect.objectContaining({ code: 'ACCOUNT_ROSTER_CANDIDATE_CORRUPT' }),
    )
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_versions').get()).toEqual({ n: 0 })
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_entries').get()).toEqual({ n: 0 })
    expect(isolated.prepare('SELECT COUNT(*) AS n FROM hospital_cm_account_roster_candidate_idempotency').get()).toEqual({ n: 0 })
    expect(isolated.prepare("SELECT COUNT(*) AS n FROM abc_audit_logs WHERE module = 'hospital_cm_account_roster'").get()).toEqual({ n: 0 })
  })

  it('已提交候选被离线篡改后，读取会 fail-closed 报完整性错误', () => {
    const version = createHospitalCmAccountRosterCandidate(db, candidateInput())
    db.exec('DROP TRIGGER trg_hcm_account_roster_candidate_entries_no_update')
    db.prepare(`
      UPDATE hospital_cm_account_roster_candidate_entries
      SET row_hash = ? WHERE roster_version_id = ? AND account_key = 'ACCOUNT-0001'
    `).run('f'.repeat(64), version.id)
    expect(() => getHospitalCmAccountRosterCandidate(db, version.id)).toThrowError(
      expect.objectContaining({ code: 'ACCOUNT_ROSTER_CANDIDATE_CORRUPT' }),
    )
  })

  it('成本专属审计只写候选版本元数据，不把账户 key/partnerId 逐行复制进日志', () => {
    const version = createHospitalCmAccountRosterCandidate(db, candidateInput())
    const row = db.prepare(`
      SELECT detail FROM abc_audit_logs
      WHERE module = 'hospital_cm_account_roster' AND target_id = ?
    `).get(version.id) as { detail: string }
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    expect(detail).toEqual({
      candidateOnly: true,
      claimedSourceKind: 'FINANCE_SETTLEMENT_ROSTER',
      sourceEvidenceHash: SOURCE_HASH,
      rowCount: 2,
      contentHash: version.contentHash,
    })
    expect(row.detail).not.toContain('ACCOUNT-0001')
    expect(row.detail).not.toContain('PARTNER-0001')
    expect(row.detail).not.toContain('manifest://')
    expect(row.detail).not.toContain('finance-export')
    expect(row.detail).not.toContain('首次保存')
    expect(row.detail).not.toContain('2026-07')
  })

  it('严格拒绝非法月份、hash、空/重复账户或 partner，以及不安全的来源原始代码', () => {
    const duplicatePartner = entries()
    duplicatePartner[1] = { ...duplicatePartner[1], partnerId: duplicatePartner[0]?.partnerId }
    const invalidInputs: Array<{ overrides: Record<string, unknown>; code: string }> = [
      { overrides: { serviceMonth: '2026-13' }, code: 'ACCOUNT_ROSTER_SERVICE_MONTH_INVALID' },
      { overrides: { claimedSourceKind: 'finance_settlement_roster' }, code: 'ACCOUNT_ROSTER_SOURCE_KIND_INVALID' },
      { overrides: { sourceEvidenceHash: 'not-a-hash' }, code: 'ACCOUNT_ROSTER_SOURCE_EVIDENCE_INVALID' },
      { overrides: { entries: [] }, code: 'ACCOUNT_ROSTER_ENTRIES_INVALID' },
      { overrides: { entries: [entries(1)[0], entries(1)[0]] }, code: 'ACCOUNT_ROSTER_ACCOUNT_DUPLICATE' },
      { overrides: { entries: duplicatePartner }, code: 'ACCOUNT_ROSTER_PARTNER_DUPLICATE' },
      { overrides: { entries: [{ ...entries(1)[0], partnerId: 123 }] }, code: 'ACCOUNT_ROSTER_PARTNER_ID_INVALID' },
      { overrides: { entries: [{ ...entries(1)[0], partnerId: true }] }, code: 'ACCOUNT_ROSTER_PARTNER_ID_INVALID' },
      { overrides: { entries: [{ ...entries(1)[0], partnerId: { id: 'P-1' } }] }, code: 'ACCOUNT_ROSTER_PARTNER_ID_INVALID' },
      { overrides: { entries: [{ ...entries(1)[0], sourceCooperationCode: '=formula' }] }, code: 'ACCOUNT_ROSTER_SOURCE_COOPERATION_CODE_INVALID' },
      { overrides: { entries: [{ ...entries(1)[0], sourceActivityCode: 'HAS SPACE' }] }, code: 'ACCOUNT_ROSTER_SOURCE_ACTIVITY_CODE_INVALID' },
      { overrides: { entries: [{ ...entries(1)[0], accountKey: '=cmd' }] }, code: 'ACCOUNT_ROSTER_ACCOUNT_KEY_INVALID' },
    ]
    for (const { overrides, code } of invalidInputs) {
      expect(() => createHospitalCmAccountRosterCandidate(db, candidateInput(overrides))).toThrowError(
        expect.objectContaining({ code }),
      )
    }
    expect(() => listHospitalCmAccountRosterCandidates(db, '2026-00', 'FINANCE_SETTLEMENT_ROSTER')).toThrowError(
      expect.objectContaining({ code: 'ACCOUNT_ROSTER_SERVICE_MONTH_INVALID' }),
    )
  })

  it('来源证据只接受安全 manifest:// 引用；拒绝本机路径、网络 URL、查询、片段和控制字符', () => {
    const invalidRefs = [
      'file://C:/finance/roster.csv',
      'C:\\finance\\roster.csv',
      '/tmp/roster.csv',
      'https://example.test/roster.csv',
      'manifest://finance/roster?r=1',
      'manifest://finance/roster#fragment',
      'manifest://finance/../secret',
      'manifest://finance/roster\nnext',
    ]
    for (const sourceEvidenceRef of invalidRefs) {
      expect(() => createHospitalCmAccountRosterCandidate(db, candidateInput({ sourceEvidenceRef }))).toThrowError(
        expect.objectContaining({ code: 'ACCOUNT_ROSTER_SOURCE_EVIDENCE_REF_INVALID' }),
      )
    }
  })

  it('来源版本、幂等键与原始代码执行 ASCII/长度/控制字符边界，不把业务枚举伪装成终态分类', () => {
    for (const sourceVersion of ['版本一', `r1\u0000tail`, 'x'.repeat(129)]) {
      expect(() => createHospitalCmAccountRosterCandidate(db, candidateInput({ sourceVersion }))).toThrowError(
        expect.objectContaining({ code: 'ACCOUNT_ROSTER_SOURCE_VERSION_INVALID' }),
      )
    }
    expect(() => createHospitalCmAccountRosterCandidate(db, candidateInput({ idempotencyKey: 'short' }))).toThrowError(
      expect.objectContaining({ code: 'ACCOUNT_ROSTER_IDEMPOTENCY_KEY_INVALID' }),
    )
    const created = createHospitalCmAccountRosterCandidate(db, candidateInput())
    expect(created.entries[0]).toHaveProperty('sourceCooperationCode')
    expect(created.entries[0]).toHaveProperty('sourceActivityCode')
    expect(created.entries[0]).not.toHaveProperty('cooperationType')
    expect(created.entries[0]).not.toHaveProperty('activityState')
  })

  it('重复错误不回显敏感 accountKey 或 partnerId', () => {
    const secretAccount = 'ACCOUNT-SECRET-9988'
    const secretPartner = 'PARTNER-SECRET-9988'
    for (const duplicateEntries of [
      [
        { ...entries(1)[0], accountKey: secretAccount },
        { ...entries(1)[0], accountKey: secretAccount, partnerId: null },
      ],
      [
        { ...entries(1)[0], accountKey: 'ACCOUNT-A', partnerId: secretPartner },
        { ...entries(1)[0], accountKey: 'ACCOUNT-B', partnerId: secretPartner },
      ],
    ]) {
      try {
        createHospitalCmAccountRosterCandidate(db, candidateInput({ entries: duplicateEntries }))
        throw new Error('expected duplicate rejection')
      } catch (error) {
        expect(String((error as Error).message)).not.toContain('SECRET-9988')
      }
    }
  })

  it('当前候选与历史分页均为固定查询数，不随账户行数增长形成 N+1', () => {
    const version = createHospitalCmAccountRosterCandidate(db, candidateInput({ entries: entries(300) }))
    let queryCount = 0
    const countedDb = {
      prepare(sql: string) {
        queryCount += 1
        return db.prepare(sql)
      },
      exec(sql: string) {
        return db.exec(sql)
      },
    }

    const full = getHospitalCmAccountRosterCandidate(countedDb, version.id)
    expect(full?.entries).toHaveLength(300)
    expect(queryCount).toBe(2)

    queryCount = 0
    const history = listHospitalCmAccountRosterCandidates(
      countedDb,
      '2026-07',
      'FINANCE_SETTLEMENT_ROSTER',
      { limit: 20 },
    )
    expect(history.current?.id).toBe(version.id)
    expect(history.versions).toHaveLength(1)
    expect(queryCount).toBe(1)
  })

  it('分页参数和找不到的候选均给稳定、诚实结果', () => {
    expect(getHospitalCmAccountRosterCandidate(db, 'missing')).toBeNull()
    expect(() => listHospitalCmAccountRosterCandidates(
      db,
      '2026-07',
      'FINANCE_SETTLEMENT_ROSTER',
      { limit: 0 },
    )).toThrowError(HospitalCmAccountRosterError)
    expect(() => listHospitalCmAccountRosterCandidates(
      db,
      '2026-07',
      'FINANCE_SETTLEMENT_ROSTER',
      { beforeEvent: -1 },
    )).toThrowError(
      expect.objectContaining({ code: 'ACCOUNT_ROSTER_PAGE_INVALID' }),
    )
  })
})

describe('hospital-cm D2 B0 · 真实应用初始化与双层防误解锁', () => {
  let app: any
  let runtimeDb: any
  let token = ''

  beforeAll(async () => {
    runtimeDb = await getDb()
    const hospitalRoutes = (await import('../src/routes/hospital-pnl-v1.1.js')).default
    app = await buildTestApp([
      { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
      { path: '/api/v1/hospital-pnl', router: hospitalRoutes },
    ])
    token = await loginAdmin(app)
  })

  const auth = () => ({ Authorization: `Bearer ${token}` })

  it('DatabaseManager 只初始化三张空 candidate 表，不 seed 账户或结论', () => {
    const tables = (runtimeDb.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'hospital_cm_account_roster_candidate_versions',
        'hospital_cm_account_roster_candidate_entries',
        'hospital_cm_account_roster_candidate_idempotency'
      ) ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual([
      'hospital_cm_account_roster_candidate_entries',
      'hospital_cm_account_roster_candidate_idempotency',
      'hospital_cm_account_roster_candidate_versions',
    ])
    for (const table of tables) {
      expect(runtimeDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
  })

  it('候选写入前后 readiness 不变，full-health 始终 403 且不泄漏完整经营数值', async () => {
    const readinessBefore = await request(app).get('/api/v1/hospital-pnl/readiness').set(auth())
    const fullHealthBefore = await request(app)
      .get('/api/v1/hospital-pnl/full-health?serviceMonth=2026-07')
      .set(auth())
    expect(readinessBefore.status).toBe(200)
    expect(readinessBefore.body.data.ready).toBe(false)
    expect(fullHealthBefore.status).toBe(403)
    expect(JSON.stringify(fullHealthBefore.body)).not.toMatch(/"totalCm"|"coverageMultiple"/)

    const revisionsBefore = runtimeDb.prepare(`
      SELECT source_key AS sourceKey, revision, updated_at AS updatedAt
      FROM hospital_cm_readiness_source_revisions ORDER BY source_key
    `).all()

    const candidate = createHospitalCmAccountRosterCandidate(runtimeDb, candidateInput({
      idempotencyKey: 'hcm-roster-p0-negative-0001',
      changeReason: '真实路由负向验收：仅保存候选，不进入 readiness',
    }))
    expect(candidate.usage).toBe(HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE)

    const revisionsAfter = runtimeDb.prepare(`
      SELECT source_key AS sourceKey, revision, updated_at AS updatedAt
      FROM hospital_cm_readiness_source_revisions ORDER BY source_key
    `).all()
    expect(revisionsAfter).toEqual(revisionsBefore)
    expect(revisionsAfter.some((row: any) => String(row.sourceKey).includes('account_roster'))).toBe(false)

    const readinessAfter = await request(app).get('/api/v1/hospital-pnl/readiness').set(auth())
    expect(readinessAfter.status).toBe(200)
    expect(readinessAfter.body.data.ready).toBe(false)
    expect(readinessAfter.body.data.sourceStateFingerprint).toBe(
      readinessBefore.body.data.sourceStateFingerprint,
    )

    const fullHealthAfter = await request(app)
      .get('/api/v1/hospital-pnl/full-health?serviceMonth=2026-07&mode=full')
      .set(auth())
    expect(fullHealthAfter.status).toBe(403)
    const serialized = JSON.stringify(fullHealthAfter.body)
    expect(fullHealthAfter.body.data).toBeUndefined()
    expect(serialized).not.toMatch(/"totalCm"|"coverageMultiple"|"fullState"/)
  })
})
