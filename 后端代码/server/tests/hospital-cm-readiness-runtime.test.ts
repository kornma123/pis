import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { getDb } from './p0-harness.js'
import {
  ensureHospitalCmReadinessSchema,
  currentHospitalCmReadinessSourceFingerprint,
  getHospitalCmReadinessSnapshot,
  recordHospitalCmFoundationProbeRun,
  shanghaiBusinessDate,
} from '../src/utils/hospital-cm-readiness-runtime.js'
import { combinedFoundationFingerprint } from '../src/utils/hospital-cm-foundation-probes.js'

const NOW = '2026-07-12T08:00:00.000Z'

async function cleanReadinessFacts() {
  const db = await getDb()
  db.exec(`
    DELETE FROM batches;
    DELETE FROM inventory;
    DELETE FROM case_revenue_lines;
    DELETE FROM case_revenue;
    DELETE FROM lis_case_markers;
    DELETE FROM lis_cases;
    UPDATE materials SET status = 0;
  `)
  return db
}

function seedBalancedInventory(db: any) {
  db.prepare(`
    INSERT OR IGNORE INTO material_categories (id, code, name, level)
    VALUES ('CAT-HCM-READY', 'CAT-HCM-READY', '就绪探针测试', 1)
  `).run()
  db.prepare(`
    INSERT OR IGNORE INTO materials (id, code, name, unit, category_id, status, is_deleted)
    VALUES ('MAT-HCM-READY', 'MAT-HCM-READY', '就绪探针物料', '盒', 'CAT-HCM-READY', 1, 0)
  `).run()
  db.prepare(`UPDATE materials SET status = 1, is_deleted = 0 WHERE id = 'MAT-HCM-READY'`).run()
  db.prepare(`
    INSERT INTO inventory (id, material_id, stock, locked_stock)
    VALUES ('INV-HCM-READY', 'MAT-HCM-READY', 12, 0)
  `).run()
  db.prepare(`
    INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
    VALUES ('BAT-HCM-READY', 'MAT-HCM-READY', 'B-HCM-READY', 12, 12, 'IN-HCM-READY', 1)
  `).run()
}

function createIsolatedProbeBaseDb(): DatabaseSync {
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
      inbound_id TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE case_revenue (
      id TEXT PRIMARY KEY, case_no TEXT NOT NULL, partner_id TEXT, gross_amount REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL DEFAULT 0, lab_revenue REAL, out_revenue REAL,
      discount_rate REAL NOT NULL DEFAULT 0, revenue_source TEXT, service_month TEXT, line_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE lis_cases (id TEXT PRIMARY KEY, case_no TEXT NOT NULL, partner_id TEXT);
    CREATE TABLE lis_case_markers (
      id TEXT PRIMARY KEY, case_no TEXT NOT NULL, partner_id TEXT, marker_name TEXT NOT NULL, advice_type TEXT
    );
    CREATE TABLE antibodies (id TEXT PRIMARY KEY);
    CREATE TABLE antibody_aliases (id TEXT PRIMARY KEY);
    CREATE TABLE ihc_cost_params (param_key TEXT PRIMARY KEY, value REAL);
    CREATE TABLE special_stain_kits (id TEXT PRIMARY KEY);
  `)
  return db
}

function createIsolatedProbePerformanceDb(): DatabaseSync {
  const db = createIsolatedProbeBaseDb()
  ensureHospitalCmReadinessSchema(db)
  return db
}

describe('hospital-cm readiness A · 持久证据与自动失效', () => {
  beforeEach(async () => {
    await cleanReadinessFacts()
  })

  it('新表没有 writable ready 字段，初始化只有四条机器可读里程碑', async () => {
    const db = await getDb()
    for (const table of [
      'hospital_cm_readiness_milestones',
      'hospital_cm_readiness_milestone_events',
      'hospital_cm_readiness_probe_runs',
      'hospital_cm_readiness_probe_checks',
      'hospital_cm_readiness_source_revisions',
      'hospital_cm_fixed_pool_versions',
      'hospital_cm_fixed_pool_ratification_events',
      'hospital_cm_fixed_pool_idempotency',
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      expect(columns.length).toBeGreaterThan(0)
      expect(columns.map((column) => column.name)).not.toContain('ready')
    }

    const milestones = db.prepare(`
      SELECT condition_key AS conditionKey, owner_role AS ownerRole, owner_name AS ownerName, due_date AS due
      FROM hospital_cm_readiness_milestones
      ORDER BY condition_key
    `).all()
    expect(milestones).toEqual([
      { conditionKey: 'denominator', ownerRole: 'business', ownerName: null, due: '2026-08-31' },
      { conditionKey: 'first_period', ownerRole: 'tech', ownerName: null, due: '2026-10-31' },
      { conditionKey: 'foundation', ownerRole: 'tech', ownerName: null, due: '2026-09-30' },
      { conditionKey: 'history', ownerRole: 'pm', ownerName: null, due: '2026-10-31' },
    ])
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_milestone_events').get() as any).n).toBe(4)
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_runs').get() as any).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_versions').get() as any).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_ratification_events').get() as any).n).toBe(0)

    const snapshot = getHospitalCmReadinessSnapshot(db, '2026-07-13')
    expect(snapshot.ready).toBe(false)
    expect(snapshot.checklist.every((condition) => condition.met === false && condition.assignmentError === true)).toBe(true)
    expect(snapshot.findings.filter((finding: any) => finding.type === 'milestone_owner_unassigned')).toHaveLength(4)
    expect(snapshot.findings.filter((finding: any) => finding.type === 'milestone_reviewer_unassigned')).toHaveLength(1)
  })

  it('已有 A 候选库可幂等前向补完成证据列与事件账，不需删库或伪造通过', () => {
    const db = createIsolatedProbeBaseDb()
    try {
      db.exec(`
        CREATE TABLE hospital_cm_readiness_milestones (
          condition_key TEXT PRIMARY KEY CHECK (condition_key IN ('foundation','denominator','history','first_period')),
          owner_role TEXT NOT NULL CHECK (owner_role IN ('tech','business','pm')),
          owner_name TEXT,
          reviewer_role TEXT CHECK (reviewer_role IS NULL OR reviewer_role = 'independent_reviewer'),
          reviewer_name TEXT,
          due_date TEXT NOT NULL,
          previous_due_date TEXT,
          projected_date TEXT,
          previous_projected_date TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          change_reason TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO hospital_cm_readiness_milestones
          (condition_key, owner_role, due_date, previous_due_date, revision, change_reason, updated_by)
        VALUES
          ('foundation', 'tech', '2026-09-30', '2026-09-30', 1, '旧 A 候选基线', 'migration:A'),
          ('first_period', 'tech', '2026-10-31', '2026-10-31', 1, '旧库缺少独立复核角色', 'migration:A');
      `)

      ensureHospitalCmReadinessSchema(db)
      ensureHospitalCmReadinessSchema(db)

      const columns = db.prepare('PRAGMA table_info(hospital_cm_readiness_milestones)').all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'owner_user_id',
        'owner_assignment_revision',
        'reviewer_user_id',
        'completion_evidence_ref',
        'completion_evidence_hash',
      ]))
      const eventColumns = db.prepare('PRAGMA table_info(hospital_cm_readiness_milestone_events)').all() as Array<{ name: string }>
      expect(eventColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'owner_user_id',
        'owner_assignment_revision',
        'reviewer_user_id',
        'completion_evidence_ref',
        'completion_evidence_hash',
      ]))
      expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_milestones').get() as any).n).toBe(4)
      expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_milestone_events').get() as any).n).toBe(4)
      expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_versions').get() as any).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_ratification_events').get() as any).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_fixed_pool_idempotency').get() as any).n).toBe(0)
      expect((db.prepare(`
        SELECT completion_evidence_ref AS ref, completion_evidence_hash AS hash
        FROM hospital_cm_readiness_milestones
        WHERE condition_key = 'foundation'
      `).get())).toEqual({ ref: null, hash: null })
      const migratedSnapshot = getHospitalCmReadinessSnapshot(db, '2026-07-13')
      expect(migratedSnapshot.ready).toBe(false)
      expect(migratedSnapshot.findings).toContainEqual(expect.objectContaining({
        type: 'milestone_reviewer_role_invalid',
        conditionKey: 'first_period',
      }))
    } finally {
      db.close()
    }
  })

  it('新库在数据库 CHECK 层也拒绝首周期 reviewer role 为 NULL', () => {
    const db = createIsolatedProbePerformanceDb()
    try {
      db.exec('DROP TRIGGER trg_hcm_readiness_milestones_no_delete')
      db.prepare(`DELETE FROM hospital_cm_readiness_milestones WHERE condition_key = 'first_period'`).run()
      expect(() => db.prepare(`
        INSERT INTO hospital_cm_readiness_milestones
          (condition_key, owner_role, reviewer_role, due_date, revision, change_reason, updated_by)
        VALUES ('first_period', 'tech', NULL, '2026-10-31', 1, '试图写入空复核角色', 'SECURITY-TEST')
      `).run()).toThrow(/CHECK constraint failed/)
    } finally {
      db.close()
    }
  })

  it('空业务库重跑只会留下一条 failed 证据，不能真空通过', async () => {
    const db = await getDb()
    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001',
      triggeredByUsername: 'admin',
      reasonCode: 'MONTHLY_REVIEW',
      now: NOW,
    })

    expect(run.overallStatus).toBe('failed')
    expect(run.checks.find((check) => check.key === 'inventory_conservation')).toMatchObject({
      met: false,
      resultCode: 'EMPTY_INVENTORY_BASELINE',
    })
    expect(run.checks.find((check) => check.key === 'period_key')).toMatchObject({
      met: false,
      resultCode: 'EMPTY_PERIOD_BASELINE',
    })
    expect(run.checks.find((check) => check.key === 'constant_freeze')?.met).toBe(true)

    const snapshot = getHospitalCmReadinessSnapshot(db, '2026-07-12')
    expect(snapshot.ready).toBe(false)
    expect(snapshot.foundationGatesGreen.inventory_conservation).toBe(false)
    expect(snapshot.foundationGatesGreen.period_key).toBe(false)
    expect(snapshot.foundationGatesGreen.constant_freeze).toBe(true)
  })

  it('缺失或 unknown 操作者时拒绝留验收证据', async () => {
    const db = await getDb()
    const before = (db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_runs').get() as any).n
    for (const actor of [
      { triggeredByUserId: '', triggeredByUsername: 'admin' },
      { triggeredByUserId: 'USER-001', triggeredByUsername: '' },
      { triggeredByUserId: 'unknown', triggeredByUsername: 'admin' },
      { triggeredByUserId: 'USER-001', triggeredByUsername: 'unknown' },
    ]) {
      expect(() => recordHospitalCmFoundationProbeRun(db, {
        ...actor,
        reasonCode: 'RELEASE_ACCEPTANCE',
        now: NOW,
      })).toThrow(/必须绑定已认证的操作者/)
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_runs').get() as any).n).toBe(before)
  })

  it('库存守恒可由真实账本通过；任一输入变化后旧证据立即失效', async () => {
    const db = await getDb()
    seedBalancedInventory(db)

    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001',
      triggeredByUsername: 'admin',
      reasonCode: 'MONTHLY_REVIEW',
      now: NOW,
    })
    expect(JSON.stringify(run.checks)).not.toContain('MAT-HCM-READY')
    expect(JSON.stringify(run.checks)).not.toContain('B-HCM-READY')
    const before = getHospitalCmReadinessSnapshot(db, '2026-07-12')
    expect(before.foundationGatesGreen.inventory_conservation).toBe(true)

    db.prepare(`UPDATE inventory SET stock = 13, updated_at = '2026-07-12 16:01:00' WHERE id = 'INV-HCM-READY'`).run()
    const after = getHospitalCmReadinessSnapshot(db, '2026-07-12')
    expect(after.foundationGatesGreen.inventory_conservation).toBe(false)
    expect(after.foundationEvidence?.currentFingerprintMatches).toBe(false)
    expect(after.foundationEvidence?.checks.find((check) => check.key === 'inventory_conservation')?.currentResultCode).toBe('SOURCE_CHANGED_REQUIRES_RERUN')

    const rerun = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001',
      triggeredByUsername: 'admin',
      reasonCode: 'DATA_REPAIR_RECHECK',
      now: '2026-07-12T08:02:00.000Z',
    })
    expect(rerun.overallStatus).toBe('failed')
    const latest = getHospitalCmReadinessSnapshot(db, '2026-07-12')
    expect(latest.foundationGatesGreen.inventory_conservation).toBe(false)
  })

  it('库存与活跃批次同时为正无穷时也必须 fail-closed', async () => {
    const db = await getDb()
    seedBalancedInventory(db)
    db.prepare(`UPDATE inventory SET stock = ? WHERE id = 'INV-HCM-READY'`).run(Number.POSITIVE_INFINITY)
    db.prepare(`UPDATE batches SET remaining = ? WHERE id = 'BAT-HCM-READY'`).run(Number.POSITIVE_INFINITY)

    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001',
      triggeredByUsername: 'admin',
      reasonCode: 'DATA_REPAIR_RECHECK',
      now: '2026-07-12T08:03:00.000Z',
    })

    expect(run.checks.find((check) => check.key === 'inventory_conservation')).toMatchObject({
      met: false,
      status: 'failed',
      resultCode: 'NON_FINITE_INVENTORY_FACT',
      summary: {
        nonFiniteInventoryRows: 1,
        nonFiniteBatchRows: 1,
      },
    })
    expect(getHospitalCmReadinessSnapshot(db, '2026-07-12').foundationGatesGreen.inventory_conservation).toBe(false)
  })

  it('库存总量不变且探针仍通过的等量调拨，也会因 source revision 使旧证据失效', async () => {
    const db = await getDb()
    seedBalancedInventory(db)
    db.prepare(`
      INSERT INTO materials (id, code, name, unit, category_id, status, is_deleted)
      VALUES ('MAT-HCM-READY-2', 'MAT-HCM-READY-2', '就绪探针物料二', '盒', 'CAT-HCM-READY', 1, 0)
    `).run()
    db.prepare(`
      INSERT INTO inventory (id, material_id, stock, locked_stock)
      VALUES ('INV-HCM-READY-2', 'MAT-HCM-READY-2', 12, 0)
    `).run()
    db.prepare(`
      INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
      VALUES ('BAT-HCM-READY-2', 'MAT-HCM-READY-2', 'B-HCM-READY-2', 12, 12, 'IN-HCM-READY-2', 1)
    `).run()
    recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    expect(getHospitalCmReadinessSnapshot(db, '2026-07-12').foundationGatesGreen.inventory_conservation).toBe(true)

    db.prepare(`UPDATE inventory SET stock = 11 WHERE id = 'INV-HCM-READY'`).run()
    db.prepare(`UPDATE batches SET remaining = 11 WHERE id = 'BAT-HCM-READY'`).run()
    db.prepare(`UPDATE inventory SET stock = 13 WHERE id = 'INV-HCM-READY-2'`).run()
    db.prepare(`UPDATE batches SET remaining = 13 WHERE id = 'BAT-HCM-READY-2'`).run()

    const after = getHospitalCmReadinessSnapshot(db, '2026-07-12')
    const check = after.foundationEvidence?.checks.find((item) => item.key === 'inventory_conservation')
    expect(check?.currentResultCode).toBe('SOURCE_CHANGED_REQUIRES_RERUN')
    expect(check?.currentFingerprintMatches).toBe(false)
    expect(after.foundationGatesGreen.inventory_conservation).toBe(false)
  })

  it('活跃物料缺库存基线时不得因“已有一条正常账”而通过', async () => {
    const db = await getDb()
    seedBalancedInventory(db)
    db.prepare(`
      INSERT INTO materials (id, code, name, unit, category_id, status, is_deleted)
      VALUES ('MAT-HCM-NO-LEDGER', 'MAT-HCM-NO-LEDGER', '缺库存基线物料', '盒', 'CAT-HCM-READY', 1, 0)
    `).run()
    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    expect(run.checks.find((check) => check.key === 'inventory_conservation')).toMatchObject({
      met: false,
      resultCode: 'MISSING_INVENTORY_BASELINE',
    })
  })

  it('无有效物料的库存或活跃批次任一存在都算孤儿事实', async () => {
    const db = await getDb()
    seedBalancedInventory(db)
    db.prepare(`
      INSERT INTO inventory (id, material_id, stock, locked_stock)
      VALUES ('INV-HCM-ORPHAN', 'MAT-NOT-EXISTS', 7, 0)
    `).run()
    db.prepare(`
      INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
      VALUES ('BAT-HCM-ORPHAN', 'MAT-NOT-EXISTS', 'B-HCM-ORPHAN', 5, 5, 'IN-HCM-ORPHAN', 1)
    `).run()
    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    expect(run.checks.find((check) => check.key === 'inventory_conservation')).toMatchObject({
      met: false,
      resultCode: 'ORPHAN_INVENTORY_FACT',
    })
  })

  it('最新证据按单调 run_number 选择，不受服务器时钟回拨影响', async () => {
    const db = await getDb()
    recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: '2026-07-12T08:10:00.000Z',
    })
    seedBalancedInventory(db)
    recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'DATA_REPAIR_RECHECK', now: '2026-07-12T08:09:00.000Z',
    })
    expect(getHospitalCmReadinessSnapshot(db, '2026-07-12').foundationGatesGreen.inventory_conservation).toBe(true)
  })

  it('GET 所需快照是纯读：不会偷偷新增或修改探针证据', async () => {
    const db = await getDb()
    recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    const before = (db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_runs').get() as any).n
    getHospitalCmReadinessSnapshot(db, '2026-07-12')
    getHospitalCmReadinessSnapshot(db, '2026-07-12')
    const after = (db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_runs').get() as any).n
    expect(after).toBe(before)
  })

  it('探针证据 append-only：UPDATE / DELETE / OR REPLACE 均被数据库拒绝', async () => {
    const db = await getDb()
    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'RELEASE_ACCEPTANCE', now: NOW,
    })

    expect(() => db.prepare('UPDATE hospital_cm_readiness_probe_runs SET triggered_by_username = ? WHERE id = ?').run('attacker', run.id))
      .toThrow(/READINESS_EVIDENCE_APPEND_ONLY/)
    expect(() => db.prepare('DELETE FROM hospital_cm_readiness_probe_checks WHERE run_id = ?').run(run.id))
      .toThrow(/READINESS_EVIDENCE_APPEND_ONLY/)
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO hospital_cm_readiness_probe_runs
      SELECT * FROM hospital_cm_readiness_probe_runs WHERE id = ?
    `).run(run.id)).toThrow(/READINESS_EVIDENCE_APPEND_ONLY/)
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO hospital_cm_readiness_probe_checks
      SELECT * FROM hospital_cm_readiness_probe_checks WHERE run_id = ? LIMIT 1
    `).run(run.id)).toThrow(/READINESS_EVIDENCE_APPEND_ONLY/)
  })

  it('探针 run 与三项 check 是原子写入：任一 check 失败则整批回滚', async () => {
    const db = await getDb()
    const beforeRuns = (db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_runs').get() as any).n
    const beforeChecks = (db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_checks').get() as any).n
    db.exec(`
      CREATE TEMP TRIGGER fail_second_readiness_check
      BEFORE INSERT ON hospital_cm_readiness_probe_checks
      WHEN NEW.gate_key = 'period_key'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_CHECK_INSERT_FAILED');
      END;
    `)
    try {
      expect(() => recordHospitalCmFoundationProbeRun(db, {
        triggeredByUserId: 'USER-001',
        triggeredByUsername: 'admin',
        reasonCode: 'RELEASE_ACCEPTANCE',
        now: NOW,
      })).toThrow(/TEST_CHECK_INSERT_FAILED/)
      expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_runs').get() as any).n).toBe(beforeRuns)
      expect((db.prepare('SELECT COUNT(*) AS n FROM hospital_cm_readiness_probe_checks').get() as any).n).toBe(beforeChecks)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_second_readiness_check')
    }
  })

  it('GET 快照查询数固定，不随医院/病例数增长', async () => {
    const db = await getDb()
    let prepares = 0
    const countedDb = {
      prepare(sql: string) {
        prepares += 1
        return db.prepare(sql)
      },
      exec(sql: string) {
        return db.exec(sql)
      },
    }

    getHospitalCmReadinessSnapshot(countedDb, '2026-07-12')
    expect(prepares).toBeLessThanOrEqual(7)
  })

  it('真实 recorder 在 120 组库存与病例事实下仍使用固定查询数（批量、无 N+1）', async () => {
    const db = createIsolatedProbePerformanceDb()
    const countRecorder = (now: string) => {
      let prepares = 0
      let execs = 0
      const countedDb = {
        prepare(sql: string) {
          prepares += 1
          return db.prepare(sql)
        },
        exec(sql: string) {
          execs += 1
          return db.exec(sql)
        },
      }
      const run = recordHospitalCmFoundationProbeRun(countedDb, {
        triggeredByUserId: 'USER-001',
        triggeredByUsername: 'admin',
        reasonCode: 'RELEASE_ACCEPTANCE',
        now,
      })
      return { prepares, execs, run }
    }

    try {
      const empty = countRecorder('2026-07-12T08:00:00.000Z')
      expect(empty.run.overallStatus).toBe('failed')

      const trackedRevisionBefore = Number((db.prepare(`
        SELECT COALESCE(SUM(revision), 0) AS n
        FROM hospital_cm_readiness_source_revisions
        WHERE source_key IN ('materials','inventory','batches','case_revenue','lis_cases','lis_case_markers')
      `).get() as any).n)
      const bulkWriteStartedAt = Date.now()
      db.exec('BEGIN')
      try {
        const insertMaterial = db.prepare(`
          INSERT INTO materials (id, code, name, unit, category_id, status, is_deleted)
          VALUES (?, ?, ?, '盒', 'CAT-HCM-BULK', 1, 0)
        `)
        const insertInventory = db.prepare(`
          INSERT INTO inventory (id, material_id, stock, locked_stock) VALUES (?, ?, 10, 0)
        `)
        const insertBatch = db.prepare(`
          INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, status)
          VALUES (?, ?, ?, 10, 10, ?, 1)
        `)
        const insertRevenue = db.prepare(`
          INSERT INTO case_revenue
            (id, case_no, partner_id, gross_amount, net_amount, lab_revenue,
             out_revenue, discount_rate, revenue_source, service_month, line_count)
          VALUES (?, ?, 'P-HCM-BULK', 100, 80, 80, 0, 0.8, 'statement', '2026-06', 1)
        `)
        const insertLisCase = db.prepare(`
          INSERT INTO lis_cases (id, case_no, partner_id) VALUES (?, ?, 'P-HCM-BULK')
        `)
        const insertMarker = db.prepare(`
          INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type)
          VALUES (?, ?, 'P-HCM-BULK', 'CK7', 'Y000001')
        `)
        for (let index = 0; index < 120; index += 1) {
          const suffix = String(index).padStart(3, '0')
          const materialId = `MAT-HCM-BULK-${suffix}`
          const caseNo = `CASE-HCM-BULK-${suffix}`
          insertMaterial.run(materialId, materialId, `批量物料 ${suffix}`)
          insertInventory.run(`INV-HCM-BULK-${suffix}`, materialId)
          insertBatch.run(`BAT-HCM-BULK-${suffix}`, materialId, `LOT-HCM-BULK-${suffix}`, `IN-HCM-BULK-${suffix}`)
          insertRevenue.run(`CR-HCM-BULK-${suffix}`, caseNo)
          insertLisCase.run(`LC-HCM-BULK-${suffix}`, caseNo)
          insertMarker.run(`LM-HCM-BULK-${suffix}`, caseNo)
        }
        db.exec('COMMIT')
      } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }
      const bulkWriteMs = Date.now() - bulkWriteStartedAt
      const trackedRevisionAfter = Number((db.prepare(`
        SELECT COALESCE(SUM(revision), 0) AS n
        FROM hospital_cm_readiness_source_revisions
        WHERE source_key IN ('materials','inventory','batches','case_revenue','lis_cases','lis_case_markers')
      `).get() as any).n)
      expect(trackedRevisionAfter - trackedRevisionBefore).toBe(120 * 6)
      expect(bulkWriteMs).toBeLessThan(5_000)

      const bulk = countRecorder('2026-07-12T08:20:00.000Z')
      expect(bulk.run.overallStatus).toBe('passed')
      expect(bulk.prepares).toBe(empty.prepares)
      expect(bulk.execs).toBe(empty.execs)
      expect(bulk.prepares).toBeLessThanOrEqual(20)
    } finally {
      db.close()
    }
  })

  it('逾期业务日固定使用 Asia/Shanghai，而不是服务器本地时区或 URL', () => {
    expect(shanghaiBusinessDate(new Date('2026-07-11T16:01:00.000Z'))).toBe('2026-07-12')
  })

  it('经审批迁移后的 due 后移会同时产生 slipped 与 overdue 机器告警', async () => {
    const db = await getDb()
    db.exec('SAVEPOINT milestone_due_slip_test')
    try {
      db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            due_date = '2026-10-15', revision = revision + 1,
            change_reason = '测试：经审批后移', updated_by = 'PM-APPROVAL-TEST'
        WHERE condition_key = 'foundation'
      `).run()
      const snapshot = getHospitalCmReadinessSnapshot(db, '2026-10-16')
      const milestone = snapshot.milestones.find((item: any) => item.conditionKey === 'foundation') as any
      expect(milestone.slipped).toBe(true)
      expect(milestone.overdue).toBe(true)
      expect(snapshot.findings.some((finding: any) => finding.type === 'milestone_due_slipped')).toBe(true)
      expect(snapshot.findings.some((finding: any) => finding.type === 'overdue' && finding.conditionKey === 'foundation')).toBe(true)
    } finally {
      db.exec('ROLLBACK TO milestone_due_slip_test')
      db.exec('RELEASE milestone_due_slip_test')
    }
  })

  it('预计完成日后移也会产生独立机器告警，不等同于静默改计划', async () => {
    const db = await getDb()
    db.exec('SAVEPOINT milestone_projected_slip_test')
    try {
      db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            projected_date = '2026-11-30', revision = revision + 1,
            change_reason = '测试：预计完成日经审批后移', updated_by = 'PM-APPROVAL-TEST'
        WHERE condition_key = 'first_period'
      `).run()
      const snapshot = getHospitalCmReadinessSnapshot(db, '2026-10-01')
      const milestone = snapshot.milestones.find((item: any) => item.conditionKey === 'first_period') as any
      expect(milestone.dueSlipped).toBe(false)
      expect(milestone.projectedSlipped).toBe(true)
      expect(milestone.slipped).toBe(true)
      expect(snapshot.findings).toContainEqual(expect.objectContaining({
        type: 'milestone_projected_slipped',
        conditionKey: 'first_period',
        from: '2026-10-31',
        to: '2026-11-30',
      }))
    } finally {
      db.exec('ROLLBACK TO milestone_projected_slip_test')
      db.exec('RELEASE milestone_projected_slip_test')
    }
  })

  it('里程碑更新不能伪造 previous 日期或跳过 revision/原因/操作者', async () => {
    const db = await getDb()
    expect(() => db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET due_date = '2026-11-30', previous_due_date = '2026-11-30', revision = revision + 1,
          change_reason = '试图隐藏后移', updated_by = 'tester'
      WHERE condition_key = 'foundation'
    `).run()).toThrow(/READINESS_MILESTONE_REVISION_INVALID/)
    expect(() => db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET previous_due_date = due_date, previous_projected_date = projected_date,
          due_date = '2026-11-30', change_reason = '', updated_by = ''
      WHERE condition_key = 'foundation'
    `).run()).toThrow(/READINESS_MILESTONE_REVISION_INVALID/)
    expect(() => db.prepare(`DELETE FROM hospital_cm_readiness_milestones WHERE condition_key = 'foundation'`).run())
      .toThrow(/READINESS_MILESTONE_REQUIRED/)
  })

  it('owner_role 变化属于新指派，必须同步递增 assignment revision', async () => {
    const db = await getDb()
    db.exec('SAVEPOINT milestone_owner_role_revision_test')
    try {
      expect(() => db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            revision = revision + 1, owner_role = 'tech',
            change_reason = '测试角色变化必须换指派版本', updated_by = 'SECURITY-TEST'
        WHERE condition_key = 'denominator'
      `).run()).toThrow(/READINESS_MILESTONE_OWNER_ASSIGNMENT_REVISION_INVALID/)

      db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            revision = revision + 1, owner_assignment_revision = owner_assignment_revision + 1,
            owner_role = 'tech', change_reason = '测试角色变化同步换指派版本', updated_by = 'SECURITY-TEST'
        WHERE condition_key = 'denominator'
      `).run()
      expect(db.prepare(`
        SELECT owner_role AS ownerRole, owner_assignment_revision AS assignmentRevision
        FROM hospital_cm_readiness_milestones WHERE condition_key = 'denominator'
      `).get()).toEqual({ ownerRole: 'tech', assignmentRevision: 1 })
    } finally {
      db.exec('ROLLBACK TO milestone_owner_role_revision_test')
      db.exec('RELEASE milestone_owner_role_revision_test')
    }
  })

  it('首周期独立复核角色不可清空，责任人与复核人不能同人或用大小写空白变体兼任', async () => {
    const db = await getDb()
    const attemptedRevision = (assignment: string) => db.prepare(`
      UPDATE hospital_cm_readiness_milestones
      SET previous_due_date = due_date, previous_projected_date = projected_date,
          revision = revision + 1, change_reason = '测试独立复核硬门', updated_by = 'SECURITY-TEST',
          ${assignment}
      WHERE condition_key = 'first_period'
    `).run()

    expect(() => attemptedRevision('reviewer_role = NULL, reviewer_name = NULL'))
      .toThrow(/READINESS_MILESTONE_REVIEWER_INVALID/)
    expect(() => attemptedRevision("owner_assignment_revision = owner_assignment_revision + 1, owner_user_id = 'USER-SAME', owner_name = 'Reviewer One', reviewer_user_id = 'USER-SAME', reviewer_name = 'Reviewer One'"))
      .toThrow(/READINESS_MILESTONE_REVIEWER_INVALID/)
    expect(() => attemptedRevision("owner_assignment_revision = owner_assignment_revision + 1, owner_user_id = 'USER-SAME', owner_name = '  Reviewer.One  ', reviewer_user_id = 'USER-SAME', reviewer_name = 'reviewer.one'"))
      .toThrow(/READINESS_MILESTONE_REVIEWER_INVALID/)

    const milestone = getHospitalCmReadinessSnapshot(db, '2026-07-13').milestones
      .find((item: any) => item.conditionKey === 'first_period') as any
    expect(milestone).toMatchObject({
      revision: 1,
      reviewerRole: 'independent_reviewer',
      ownerAssigned: false,
      reviewerAssigned: false,
    })
  })

  it('连续后移再调回也保留每一版事件，事件本身不可改写或删除', async () => {
    const db = await getDb()
    db.exec('SAVEPOINT milestone_event_history_test')
    try {
      const update = db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            due_date = ?, revision = revision + 1,
            change_reason = ?, updated_by = ?
        WHERE condition_key = 'foundation'
      `)
      update.run('2026-10-15', '第一次经审批后移', 'PM-APPROVAL-1')
      update.run('2026-11-15', '第二次经审批后移', 'PM-APPROVAL-2')
      update.run('2026-09-30', '数据清理提前完成，恢复基线', 'PM-APPROVAL-3')

      const events = db.prepare(`
        SELECT revision, previous_due_date AS previousDue, due_date AS due,
               change_reason AS reason, changed_by AS changedBy, changed_at AS changedAt
        FROM hospital_cm_readiness_milestone_events
        WHERE condition_key = 'foundation'
        ORDER BY revision
      `).all()
      expect(events).toEqual([
        expect.objectContaining({ revision: 1, previousDue: '2026-09-30', due: '2026-09-30' }),
        expect.objectContaining({ revision: 2, previousDue: '2026-09-30', due: '2026-10-15', reason: '第一次经审批后移', changedBy: 'PM-APPROVAL-1' }),
        expect.objectContaining({ revision: 3, previousDue: '2026-10-15', due: '2026-11-15', reason: '第二次经审批后移', changedBy: 'PM-APPROVAL-2' }),
        expect.objectContaining({ revision: 4, previousDue: '2026-11-15', due: '2026-09-30', reason: '数据清理提前完成，恢复基线', changedBy: 'PM-APPROVAL-3' }),
      ])
      for (const event of events.slice(1) as Array<{ changedAt: string }>) {
        expect(event.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        expect(event.changedAt).not.toBe((events[0] as any).changedAt)
      }
      const currentMilestone = getHospitalCmReadinessSnapshot(db, '2026-10-01').milestones
        .find((item: any) => item.conditionKey === 'foundation') as any
      expect(currentMilestone.dueSlipped).toBe(false)
      expect(currentMilestone.updatedAt).toBe((events[3] as any).changedAt)
      expect(() => db.prepare(`
        UPDATE hospital_cm_readiness_milestone_events
        SET change_reason = '试图改写'
        WHERE condition_key = 'foundation' AND revision = 2
      `).run()).toThrow(/READINESS_MILESTONE_EVENT_APPEND_ONLY/)
      expect(() => db.prepare(`
        DELETE FROM hospital_cm_readiness_milestone_events
        WHERE condition_key = 'foundation' AND revision = 2
      `).run()).toThrow(/READINESS_MILESTONE_EVENT_APPEND_ONLY/)
      expect(() => db.prepare(`
        INSERT OR REPLACE INTO hospital_cm_readiness_milestone_events
        SELECT * FROM hospital_cm_readiness_milestone_events
        WHERE condition_key = 'foundation' AND revision = 2
      `).run()).toThrow(/READINESS_MILESTONE_EVENT_APPEND_ONLY/)
      expect(() => db.prepare(`
        INSERT OR REPLACE INTO hospital_cm_readiness_milestones
        SELECT * FROM hospital_cm_readiness_milestones WHERE condition_key = 'denominator'
      `).run()).toThrow(/READINESS_MILESTONE_REQUIRED/)
    } finally {
      db.exec('ROLLBACK TO milestone_event_history_test')
      db.exec('RELEASE milestone_event_history_test')
    }
  })

  it('完成证据必须成对提供引用与 SHA-256，更新后同时进入当前态与不可变事件', async () => {
    const db = await getDb()
    db.exec('SAVEPOINT milestone_completion_evidence_test')
    try {
      expect(() => db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            revision = revision + 1, change_reason = '缺少证据摘要', updated_by = 'tester',
            completion_evidence_ref = 'probe:RUN-1'
        WHERE condition_key = 'foundation'
      `).run()).toThrow(/READINESS_MILESTONE_EVIDENCE_INVALID/)

      const hash = 'a'.repeat(64)
      db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            revision = revision + 1, change_reason = '登记完成证据', updated_by = 'TECH-OWNER-1',
            owner_assignment_revision = owner_assignment_revision + 1,
            owner_user_id = 'USER-TECH-OWNER-1', owner_name = 'TECH-OWNER-1', completion_evidence_ref = 'probe:RUN-1',
            completion_evidence_hash = ?
        WHERE condition_key = 'foundation'
      `).run(hash)
      const milestone = getHospitalCmReadinessSnapshot(db, '2026-07-13').milestones
        .find((item: any) => item.conditionKey === 'foundation') as any
      expect(milestone).toMatchObject({
        ownerAssigned: true,
        completionEvidenceRef: 'probe:RUN-1',
        completionEvidenceHash: hash,
      })
      expect(db.prepare(`
        SELECT completion_evidence_ref AS ref, completion_evidence_hash AS hash
        FROM hospital_cm_readiness_milestone_events
        WHERE condition_key = 'foundation' AND revision = 2
      `).get()).toEqual({ ref: 'probe:RUN-1', hash })
    } finally {
      db.exec('ROLLBACK TO milestone_completion_evidence_test')
      db.exec('RELEASE milestone_completion_evidence_test')
    }
  })

  it('最终防竞态指纹覆盖全部里程碑稳定身份与独立复核门', () => {
    const db = createIsolatedProbePerformanceDb()
    try {
      const month = '2026-07'
      const initial = getHospitalCmReadinessSnapshot(db, '2026-07-13', { serviceMonth: month })
      db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            revision = revision + 1, owner_assignment_revision = owner_assignment_revision + 1,
            owner_user_id = 'USER-PM-1', owner_name = 'PM-1',
            change_reason = '测试：具名 history owner', updated_by = 'SECURITY-TEST'
        WHERE condition_key = 'history'
      `).run()
      expect(currentHospitalCmReadinessSourceFingerprint(db, month)).not.toBe(initial.sourceStateFingerprint)

      db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            revision = revision + 1, owner_assignment_revision = owner_assignment_revision + 1,
            owner_user_id = 'USER-TECH-1', owner_name = 'TECH-1',
            reviewer_user_id = 'USER-REVIEW-1', reviewer_name = 'REVIEW-1',
            change_reason = '测试：具名首周期责任人与复核人', updated_by = 'SECURITY-TEST'
        WHERE condition_key = 'first_period'
      `).run()
      const beforeIndependenceBreak = getHospitalCmReadinessSnapshot(db, '2026-07-13', { serviceMonth: month })
      db.prepare(`
        UPDATE hospital_cm_readiness_milestones
        SET previous_due_date = due_date, previous_projected_date = projected_date,
            revision = revision + 1, reviewer_user_id = owner_user_id, reviewer_name = 'DIFFERENT-DISPLAY-NAME',
            change_reason = '测试：稳定 ID 相同但显示名不同', updated_by = 'SECURITY-TEST'
        WHERE condition_key = 'first_period'
      `).run()
      expect(currentHospitalCmReadinessSourceFingerprint(db, month)).not.toBe(beforeIndependenceBreak.sourceStateFingerprint)
      expect(getHospitalCmReadinessSnapshot(db, '2026-07-13', { serviceMonth: month }).findings)
        .toContainEqual(expect.objectContaining({ type: 'milestone_reviewer_not_independent', conditionKey: 'first_period' }))
    } finally {
      db.close()
    }
  })

  it('期间键等长月份变化即使仍通过质量门，也会自动使旧证据失效', async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES ('P-HCM-KEY', 'P-HCM-KEY', '期间键测试院', 1)`).run()
    db.prepare(`
      INSERT INTO case_revenue
        (id, case_no, partner_id, gross_amount, net_amount, lab_revenue,
         out_revenue, discount_rate, revenue_source, service_month, line_count)
      VALUES ('CR-HCM-KEY', 'CASE-HCM-KEY', 'P-HCM-KEY', 100, 80, 80,
              0, 0.8, 'statement', '2026-06', 1)
    `).run()
    db.prepare(`
      INSERT INTO lis_cases (id, case_no, partner_id)
      VALUES ('LC-HCM-KEY', 'CASE-HCM-KEY', 'P-HCM-KEY')
    `).run()
    db.prepare(`
      INSERT INTO lis_case_markers
        (id, case_no, partner_id, marker_name, advice_type)
      VALUES ('LM-HCM-KEY', 'CASE-HCM-KEY', 'P-HCM-KEY', 'CK7', 'Y000001')
    `).run()
    recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    expect(getHospitalCmReadinessSnapshot(db, '2026-07-12').foundationGatesGreen.period_key).toBe(true)

    db.prepare(`UPDATE case_revenue SET service_month = '2026-07' WHERE id = 'CR-HCM-KEY'`).run()

    const after = getHospitalCmReadinessSnapshot(db, '2026-07-12')
    const check = after.foundationEvidence?.checks.find((item) => item.key === 'period_key')
    expect(check?.currentResultCode).toBe('SOURCE_CHANGED_REQUIRES_RERUN')
    expect(check?.currentFingerprintMatches).toBe(false)
    expect(after.foundationGatesGreen.period_key).toBe(false)
  })

  it('期间键允许同一 partner_id + case_no 跨合法月份，并保留跨月审计计数', async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES ('P-HCM-XMKEY', 'P-HCM-XMKEY', '跨月期间键测试院', 1)`).run()
    db.prepare(`
      INSERT INTO case_revenue
        (id, case_no, partner_id, gross_amount, net_amount, lab_revenue,
         out_revenue, discount_rate, revenue_source, service_month, line_count)
      VALUES
        ('CR-HCM-XMKEY-06', 'CASE-HCM-XMKEY', 'P-HCM-XMKEY', 100, 80, 80,
         0, 0.8, 'statement', '2026-06', 1),
        ('CR-HCM-XMKEY-07', 'CASE-HCM-XMKEY', 'P-HCM-XMKEY', 200, 160, 160,
         0, 0.8, 'statement', '2026-07', 1)
    `).run()
    db.prepare(`
      INSERT INTO lis_cases (id, case_no, partner_id)
      VALUES ('LC-HCM-XMKEY', 'CASE-HCM-XMKEY', 'P-HCM-XMKEY')
    `).run()
    db.prepare(`
      INSERT INTO lis_case_markers
        (id, case_no, partner_id, marker_name, advice_type)
      VALUES ('LM-HCM-XMKEY', 'CASE-HCM-XMKEY', 'P-HCM-XMKEY', 'CK7', 'Y000001')
    `).run()

    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    expect(run.checks.find((check) => check.key === 'period_key')).toMatchObject({
      met: true,
      resultCode: 'PASSED',
      summary: { crossMonthReuseRows: 1 },
    })
  })

  it('期间键显式拒绝 NULL 月份', async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES ('P-HCM-BADKEY', 'P-HCM-BADKEY', '坏期间键测试院', 1)`).run()
    db.prepare(`
      INSERT INTO case_revenue
        (id, case_no, partner_id, gross_amount, net_amount, lab_revenue,
         out_revenue, discount_rate, revenue_source, service_month, line_count)
      VALUES ('CR-HCM-BADKEY', 'CASE-REVENUE', 'P-HCM-BADKEY', 100, 80, 80,
              0, 0.8, 'statement', NULL, 1)
    `).run()
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id) VALUES ('LC-HCM-BADKEY', 'CASE-LIS', 'P-HCM-BADKEY')`).run()
    db.prepare(`
      INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type)
      VALUES ('LM-HCM-BADKEY', 'CASE-LIS', 'P-HCM-BADKEY', 'CK7', 'Y000001')
    `).run()
    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    expect(run.checks.find((check) => check.key === 'period_key')).toMatchObject({
      met: false,
      resultCode: 'INVALID_PERIOD_KEY',
    })
  })

  it('期间键以已拍板的 partner_id + case_no 为身份，跨表 case_no 不一致即 orphan', async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES ('P-HCM-MISMATCH', 'P-HCM-MISMATCH', '错配测试院', 1)`).run()
    db.prepare(`
      INSERT INTO case_revenue
        (id, case_no, partner_id, gross_amount, net_amount, lab_revenue,
         out_revenue, discount_rate, revenue_source, service_month, line_count)
      VALUES ('CR-HCM-MISMATCH', 'CASE-REVENUE', 'P-HCM-MISMATCH', 100, 80, 80,
              0, 0.8, 'statement', '2026-06', 1)
    `).run()
    db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id) VALUES ('LC-HCM-MISMATCH', 'CASE-LIS', 'P-HCM-MISMATCH')`).run()
    db.prepare(`
      INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type)
      VALUES ('LM-HCM-MISMATCH', 'CASE-LIS', 'P-HCM-MISMATCH', 'CK7', 'Y000001')
    `).run()
    const run = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    expect(run.checks.find((check) => check.key === 'period_key')).toMatchObject({
      met: false,
      resultCode: 'PERIOD_KEY_ORPHAN',
    })
  })

  it('活库成本主数据变化会使 constant_freeze 旧证据失效', async () => {
    const db = await getDb()
    recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001', triggeredByUsername: 'admin', reasonCode: 'MONTHLY_REVIEW', now: NOW,
    })
    expect(getHospitalCmReadinessSnapshot(db, '2026-07-12').foundationGatesGreen.constant_freeze).toBe(true)

    const beforeValue = Number((db.prepare(`SELECT value FROM ihc_cost_params WHERE param_key = 'secondary_per_slide'`).get() as any).value)
    db.prepare(`UPDATE ihc_cost_params SET value = value + 0.01 WHERE param_key = 'secondary_per_slide'`).run()
    try {
      const after = getHospitalCmReadinessSnapshot(db, '2026-07-12')
      expect(after.foundationGatesGreen.constant_freeze).toBe(false)
      expect(after.foundationEvidence?.checks.find((check) => check.key === 'constant_freeze')?.currentResultCode)
        .toBe('SOURCE_CHANGED_REQUIRES_RERUN')
    } finally {
      db.prepare(`UPDATE ihc_cost_params SET value = ? WHERE param_key = 'secondary_per_slide'`).run(beforeValue)
    }
  })

  it('source revision 行受保护；控制面缺行时 GET 仍 200 但地基全部 fail-closed', async () => {
    const db = await getDb()
    expect(() => db.prepare(`DELETE FROM hospital_cm_readiness_source_revisions WHERE source_key = 'inventory'`).run())
      .toThrow(/READINESS_SOURCE_REVISION_REQUIRED/)
    db.exec('DROP TRIGGER trg_hcm_readiness_source_revision_no_delete')
    try {
      db.prepare(`DELETE FROM hospital_cm_readiness_source_revisions WHERE source_key = 'inventory'`).run()
      const snapshot = getHospitalCmReadinessSnapshot(db, '2026-07-12')
      expect(Object.values(snapshot.foundationGatesGreen)).toEqual([false, false, false])
      expect(snapshot.findings.some((finding: any) => finding.type === 'source_revision_incomplete')).toBe(true)
    } finally {
      ensureHospitalCmReadinessSchema(db)
    }
  })

  it('异常或手工插入的 run 总状态/组合指纹与 checks 不一致时全部 fail-closed', async () => {
    const db = await getDb()
    const sourceRun = recordHospitalCmFoundationProbeRun(db, {
      triggeredByUserId: 'USER-001',
      triggeredByUsername: 'admin',
      reasonCode: 'RELEASE_ACCEPTANCE',
      now: NOW,
    })
    const sourceChecks = db.prepare(`
      SELECT gate_key AS key, result_code AS resultCode, summary_json AS summaryJson,
             input_fingerprint AS inputFingerprint, observed_at AS observedAt
      FROM hospital_cm_readiness_probe_checks
      WHERE run_id = ?
      ORDER BY gate_key
    `).all(sourceRun.id) as Array<{
      key: 'inventory_conservation' | 'period_key' | 'constant_freeze'
      resultCode: string
      summaryJson: string
      inputFingerprint: string
      observedAt: string
    }>

    const insertSyntheticRun = (id: string, overallStatus: string, inputFingerprint: string) => {
      db.prepare(`
        INSERT INTO hospital_cm_readiness_probe_runs
          (id, probe_version, overall_status, input_fingerprint, started_at, completed_at,
           triggered_by_user_id, triggered_by_username, trigger_reason_code)
        VALUES (?, ?, ?, ?, ?, ?, 'USER-DB-AUDIT', 'db-auditor', 'RELEASE_ACCEPTANCE')
      `).run(id, sourceRun.probeVersion, overallStatus, inputFingerprint, NOW, NOW)
      const insertCheck = db.prepare(`
        INSERT INTO hospital_cm_readiness_probe_checks
          (run_id, gate_key, status, result_code, summary_json, input_fingerprint, observed_at)
        VALUES (?, ?, 'passed', 'PASSED', ?, ?, ?)
      `)
      for (const check of sourceChecks) {
        insertCheck.run(id, check.key, check.summaryJson, check.inputFingerprint, check.observedAt)
      }
    }

    insertSyntheticRun('RUN-HCM-TAMPER-FINGERPRINT', 'passed', 'not-the-combined-fingerprint')
    let snapshot = getHospitalCmReadinessSnapshot(db, '2026-07-12')
    expect(Object.values(snapshot.foundationGatesGreen)).toEqual([false, false, false])
    expect(snapshot.findings.some((finding: any) => finding.type === 'probe_run_integrity_mismatch')).toBe(true)
    expect(snapshot.foundationEvidence?.checks.every((check) => check.currentMet === false)).toBe(true)
    expect(snapshot.foundationEvidence?.checks.every((check) => check.currentFingerprintMatches === false)).toBe(true)

    const correctCombined = combinedFoundationFingerprint(sourceChecks)
    insertSyntheticRun('RUN-HCM-TAMPER-STATUS', 'failed', correctCombined)
    snapshot = getHospitalCmReadinessSnapshot(db, '2026-07-12')
    expect(Object.values(snapshot.foundationGatesGreen)).toEqual([false, false, false])
    expect(snapshot.foundationEvidence?.checks.every((check) => check.currentResultCode === 'PROBE_RUN_INTEGRITY_MISMATCH')).toBe(true)
    expect(snapshot.foundationEvidence?.checks.every((check) => check.currentMet === false)).toBe(true)
    expect(snapshot.foundationEvidence?.checks.every((check) => check.currentFingerprintMatches === false)).toBe(true)
  })
})
