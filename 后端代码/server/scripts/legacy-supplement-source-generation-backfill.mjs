#!/usr/bin/env node
/**
 * Issue #83（LOC-005-FUP）— master 形状旧库（带漏收补收单、无对账代）的受治理 backfill 工具
 *
 * 冻结方向（benchmark task card DS-C1-ISSUE83，方案 B）：
 * - 一次性离线 backfill：显式 --database / --actor / --reason；默认 dry-run，--apply 才写；
 * - 正常 boot 对目标 legacy shape 继续 fail-closed（本工具不修改 DatabaseManager 的启动校验）；
 * - 工具只处理 Issue 精确定义形状：supplement_orders.source_diff_id 非空，且所属院·月在
 *   account_reconcile_generations 无 current 代（与 ensureSupplementGenerationForeignKeys
 *   的 legacy 探针同一条件）；
 * - 额外 drift、partial schema、事实不足或 lineage 不可证 → 零写停止；
 * - 处置语义：目标行 source_diff_id 置 NULL（legacy 无 reconcile_generation_id 列），
 *   金额/单量/状态等补收事实原样保留；审计表逐行保存 who / when / reason / original facts；
 * - 检查与写入在同一 BEGIN IMMEDIATE 事务内；validation / audit / write 任一 fault 全量
 *   ROLLBACK，禁止 partial write；--apply 重跑幂等（已处置则零目标稳定成功，boot 后为
 *   稳定拒绝）。
 *
 * 用法（Node 22，与仓库 CI 同运行时）：
 *   node --experimental-sqlite scripts/legacy-supplement-source-generation-backfill.mjs \
 *     --database <绝对路径> --actor <操作者> --reason <原因> [--apply] [--json]
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TOOL_VERSION = '1.0.0'
export const AUDIT_TABLE = 'supplement_source_generation_backfill_audit'

const REQUIRED_LEGACY_TABLES = [
  'reconcile_hospital_months',
  'reconcile_diffs',
  'account_reconcile_generations',
  'supplement_orders',
]

// LOC-005 之后新增/改写的对象；任一出现即说明不是「Issue 精确定义的 master 形状」。
const LOC005_ADDED_TABLES = [
  'account_reconcile_hospital_month_bindings',
  'account_reconcile_completion_legacy_provenance',
]
const LOC005_ADDED_COLUMNS = {
  supplement_orders: ['reconcile_generation_id'],
  reconcile_diffs: ['reconcile_generation_id'],
  account_reconcile_generations: [
    'statement_artifact_hash',
    'completion_artifact_json',
    'completion_artifact_hash',
  ],
}

const SUPPLEMENT_REQUIRED_LEGACY_COLUMNS = [
  'id', 'partner_id', 'service_month', 'source_diff_id', 'case_no', 'amount',
  'case_count', 'status', 'collected_at', 'collected_month', 'collected_revenue',
  'give_up_reason', 'operator', 'review_status', 'submitted_by', 'reviewed_by',
  'reviewed_at', 'created_at', 'updated_at',
]
const DIFF_REQUIRED_LEGACY_COLUMNS = [
  'id', 'hospital_month_id', 'partner_id', 'service_month',
]
const GENERATION_REQUIRED_LEGACY_COLUMNS = [
  'reconcile_generation_id', 'partner_id', 'settlement_month',
  'statement_generation_id', 'hospital_month_id', 'is_current', 'status',
]

export const AUDIT_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplement_id TEXT NOT NULL UNIQUE,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    original_source_diff_id TEXT NOT NULL,
    original_partner_id TEXT NOT NULL,
    original_service_month TEXT NOT NULL,
    original_amount DECIMAL(18, 4) NOT NULL,
    original_case_count INTEGER NOT NULL,
    original_status TEXT NOT NULL,
    handled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tool_version TEXT NOT NULL
  )
`

const AUDIT_EXPECTED_COLUMNS = new Set([
  'id', 'supplement_id', 'actor', 'reason', 'original_source_diff_id',
  'original_partner_id', 'original_service_month', 'original_amount',
  'original_case_count', 'original_status', 'handled_at', 'tool_version',
])

export class BackfillError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BackfillError'
    this.code = code
  }
}

function tableNames(connection) {
  return new Set(
    connection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => row.name),
  )
}

function columnNames(connection, table) {
  return new Set(
    connection.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  )
}

function missingColumns(connection, table, required) {
  const columns = columnNames(connection, table)
  return required.filter((column) => !columns.has(column))
}

function validateAuditSchema(connection) {
  const table = connection.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(AUDIT_TABLE)
  if (!table) return 'absent'
  const columns = columnNames(connection, AUDIT_TABLE)
  if (
    columns.size !== AUDIT_EXPECTED_COLUMNS.size
    || [...AUDIT_EXPECTED_COLUMNS].some((column) => !columns.has(column))
  ) {
    throw new BackfillError(
      'AUDIT_SCHEMA_DRIFT',
      `audit table ${AUDIT_TABLE} schema differs from the governed contract`,
    )
  }
  const indexes = connection.prepare(`PRAGMA index_list(${AUDIT_TABLE})`).all()
  const uniqueSupplementIndex = indexes.some((index) => {
    if (index.unique !== 1) return false
    const info = connection.prepare(`PRAGMA index_info(${index.name})`).all()
    return info.length === 1 && info[0].name === 'supplement_id'
  })
  if (!uniqueSupplementIndex) {
    throw new BackfillError(
      'AUDIT_SCHEMA_DRIFT',
      `audit table ${AUDIT_TABLE} must keep UNIQUE(supplement_id)`,
    )
  }
  return 'exact'
}

/**
 * 形状守卫：仅接受 Issue #83 精确定义的 master 形状旧库。
 * 任一 LOC-005 新增列/表出现（含 audit 表 schema 漂移）→ 抛错，零写。
 */
export function describeLegacyShape(connection) {
  const tables = tableNames(connection)
  const missingTables = REQUIRED_LEGACY_TABLES.filter((table) => !tables.has(table))
  if (missingTables.length > 0) {
    throw new BackfillError(
      'DB_NOT_LEGACY_SHAPE',
      `required reconciliation tables missing: ${missingTables.join(', ')}`,
    )
  }
  const driftedTables = LOC005_ADDED_TABLES.filter((table) => tables.has(table))
  if (driftedTables.length > 0) {
    throw new BackfillError(
      'DB_PARTIAL_SCHEMA',
      `LOC-005 added table(s) already present: ${driftedTables.join(', ')}`,
    )
  }
  for (const [table, columns] of Object.entries(LOC005_ADDED_COLUMNS)) {
    const present = columns.filter((column) => columnNames(connection, table).has(column))
    if (present.length > 0) {
      throw new BackfillError(
        'DB_PARTIAL_SCHEMA',
        `LOC-005 added column(s) already present on ${table}: ${present.join(', ')}`,
      )
    }
  }
  const supplementMissing = missingColumns(
    connection,
    'supplement_orders',
    SUPPLEMENT_REQUIRED_LEGACY_COLUMNS,
  )
  if (supplementMissing.length > 0) {
    throw new BackfillError(
      'DB_SUPPLEMENT_SCHEMA_INCOMPLETE',
      `supplement_orders missing legacy columns: ${supplementMissing.join(', ')}`,
    )
  }
  const diffMissing = missingColumns(connection, 'reconcile_diffs', DIFF_REQUIRED_LEGACY_COLUMNS)
  if (diffMissing.length > 0) {
    throw new BackfillError(
      'DB_DIFF_SCHEMA_INCOMPLETE',
      `reconcile_diffs missing legacy columns: ${diffMissing.join(', ')}`,
    )
  }
  const generationMissing = missingColumns(
    connection,
    'account_reconcile_generations',
    GENERATION_REQUIRED_LEGACY_COLUMNS,
  )
  if (generationMissing.length > 0) {
    throw new BackfillError(
      'DB_GENERATION_SCHEMA_INCOMPLETE',
      `account_reconcile_generations missing legacy columns: ${generationMissing.join(', ')}`,
    )
  }
  const auditTableState = validateAuditSchema(connection)
  return { shape: 'legacy-issue83', auditTableState }
}

/**
 * 目标行 = ensureSupplementGenerationForeignKeys（legacy 探针，hasGenerationColumn=false
 * 分支）会 fail-closed 命中的行；另加 lineage 可证性：diff 行必须存在、院·月键必须与
 * 补收单一致、hospital_month 行必须存在，否则零写停止。
 */
export function findTargetRows(connection) {
  describeLegacyShape(connection)
  const candidates = connection.prepare(`
    SELECT supplement.id AS id,
           supplement.source_diff_id AS sourceDiffId,
           diff.hospital_month_id AS hospitalMonthId
      FROM supplement_orders supplement
      LEFT JOIN reconcile_diffs diff ON diff.id = supplement.source_diff_id
     WHERE supplement.source_diff_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM account_reconcile_generations generation
          WHERE generation.hospital_month_id = diff.hospital_month_id
            AND generation.is_current = 1
       )
     ORDER BY supplement.id
  `).all()
  const targets = []
  for (const candidate of candidates) {
    if (candidate.sourceDiffId === null || candidate.sourceDiffId === '') {
      throw new BackfillError(
        'LINEAGE_UNPROVABLE',
        `supplement ${String(candidate.id)} has an empty source_diff_id`,
      )
    }
    const diff = connection.prepare(`
      SELECT id, hospital_month_id, partner_id, service_month
        FROM reconcile_diffs WHERE id = ?
    `).get(candidate.sourceDiffId)
    if (!diff) {
      throw new BackfillError(
        'LINEAGE_UNPROVABLE',
        `supplement ${String(candidate.id)} references missing diff ${candidate.sourceDiffId}`,
      )
    }
    const supplement = connection.prepare(`
      SELECT partner_id, service_month FROM supplement_orders WHERE id = ?
    `).get(candidate.id)
    if (
      !supplement
      || diff.partner_id !== supplement.partner_id
      || diff.service_month !== supplement.service_month
    ) {
      throw new BackfillError(
        'LINEAGE_MISMATCH',
        `supplement ${String(candidate.id)} and diff ${candidate.sourceDiffId} disagree on partner/month`,
      )
    }
    const hospitalMonth = connection.prepare(
      'SELECT id FROM reconcile_hospital_months WHERE id = ?',
    ).get(diff.hospital_month_id)
    if (!hospitalMonth) {
      throw new BackfillError(
        'FACTS_INSUFFICIENT',
        `supplement ${String(candidate.id)}: hospital month ${String(diff.hospital_month_id)} is missing`,
      )
    }
    targets.push({
      id: String(candidate.id),
      sourceDiffId: String(candidate.sourceDiffId),
      hospitalMonthId: String(diff.hospital_month_id),
    })
  }
  return targets
}

function findAlreadyHandled(connection, targets) {
  if (targets.length === 0) return []
  const placeholders = targets.map(() => '?').join(',')
  return connection.prepare(`
    SELECT supplement_id FROM ${AUDIT_TABLE}
     WHERE supplement_id IN (${placeholders})
     ORDER BY supplement_id
  `).all(...targets.map((target) => target.id)).map((row) => row.supplement_id)
}

/** 只读规划：形状 + 目标行 + 已处置冲突检查；不写任何字节。 */
export function planBackfill(connection) {
  const shape = describeLegacyShape(connection)
  const targets = findTargetRows(connection)
  const alreadyHandled = targets.length > 0 && shape.auditTableState === 'exact'
    ? findAlreadyHandled(connection, targets)
    : []
  if (alreadyHandled.length > 0) {
    throw new BackfillError(
      'ALREADY_HANDLED_TAMPERED',
      `supplement(s) already have audit facts but still carry source_diff_id: ${alreadyHandled.join(', ')}`,
    )
  }
  return {
    shape: shape.shape,
    auditTableState: shape.auditTableState,
    targets,
  }
}

function assertAuditInputs(actor, reason) {
  if (typeof actor !== 'string' || actor.trim() === '' || /[\u0000-\u001F\u007F]/.test(actor)) {
    throw new BackfillError('BACKFILL_USAGE', '--actor must be a non-empty visible string without control characters')
  }
  if (typeof reason !== 'string' || reason.trim() === '' || /[\u0000-\u001F\u007F]/.test(reason)) {
    throw new BackfillError('BACKFILL_USAGE', '--reason must be a non-empty visible string without control characters')
  }
}

/**
 * 文件身份守卫：目标路径的 dev/ino 必须始终等于打开前取证值；
 * 用于拦截「DB 路径或对象在运行中被替换」。
 */
export function assertFileIdentity(databasePath, expectedStat) {
  let current
  try {
    current = statSync(databasePath, { bigint: true })
  } catch {
    throw new BackfillError(
      'DB_FILE_REPLACED',
      `DB_FILE_REPLACED: database file disappeared or is unreadable: ${databasePath}`,
    )
  }
  if (
    !current.isFile()
    || current.dev !== expectedStat.dev
    || current.ino !== expectedStat.ino
  ) {
    throw new BackfillError(
      'DB_FILE_REPLACED',
      `DB_FILE_REPLACED: database file at ${databasePath} was replaced while the backfill was running`,
    )
  }
}

/**
 * 应用 backfill：形状守卫 → BEGIN IMMEDIATE → 目标行 + 审计同一事务写入 →
 * 事务内 post-check → COMMIT；任何 fault 全量 ROLLBACK。
 * faultAt 仅供测试注入（afterAuditWrite / beforeCommit），CLI 永不传入。
 */
export function applyBackfill(connection, options) {
  const actor = options?.actor
  const reason = options?.reason
  const faultAt = options?.faultAt ?? null
  const databasePath = options?.databasePath
  const expectedFileStat = options?.expectedFileStat
  assertAuditInputs(actor, reason)
  if (faultAt !== null && faultAt !== 'afterAuditWrite' && faultAt !== 'beforeCommit') {
    throw new BackfillError('BACKFILL_USAGE', `unknown faultAt: ${String(faultAt)}`)
  }
  connection.exec('PRAGMA foreign_keys = ON')
  try {
    connection.exec('BEGIN IMMEDIATE')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/locked|busy/i.test(message)) {
      throw new BackfillError('DB_LOCKED', `DB_LOCKED: ${message}`)
    }
    throw new BackfillError('BEGIN_FAILED', `BEGIN_FAILED: ${message}`)
  }
  try {
    const plan = planBackfill(connection)
    if (plan.targets.length === 0) {
      connection.exec('COMMIT')
      return { applied: 0, auditRowsWritten: 0, dryRun: false, shape: plan.shape }
    }
    if (databasePath && expectedFileStat) {
      assertFileIdentity(databasePath, expectedFileStat)
    }
    if (plan.auditTableState === 'absent') {
      connection.exec(AUDIT_TABLE_DDL)
    }
    const selectRow = connection.prepare(`
      SELECT id, partner_id, service_month, source_diff_id, amount, case_count, status
        FROM supplement_orders WHERE id = ?
    `)
    const updateRow = connection.prepare(`
      UPDATE supplement_orders
         SET source_diff_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND source_diff_id = ?
    `)
    const insertAudit = connection.prepare(`
      INSERT INTO ${AUDIT_TABLE}
        (supplement_id, actor, reason, original_source_diff_id, original_partner_id,
         original_service_month, original_amount, original_case_count, original_status,
         handled_at, tool_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    `)
    let applied = 0
    for (const target of plan.targets) {
      const row = selectRow.get(target.id)
      if (!row || row.source_diff_id !== target.sourceDiffId) {
        throw new BackfillError(
          'TARGET_ROW_MUTATED',
          `supplement ${target.id} changed between plan and write`,
        )
      }
      const updateResult = updateRow.run(target.id, target.sourceDiffId)
      if (updateResult.changes !== 1) {
        throw new BackfillError(
          'TARGET_ROW_UPDATE_FAILED',
          `supplement ${target.id} update affected ${String(updateResult.changes)} rows`,
        )
      }
      insertAudit.run(
        target.id,
        actor,
        reason,
        row.source_diff_id,
        row.partner_id,
        row.service_month,
        row.amount,
        row.case_count,
        row.status,
        TOOL_VERSION,
      )
      applied += 1
    }
    if (faultAt === 'afterAuditWrite') {
      throw new BackfillError(
        'INJECTED_BACKFILL_FAULT:afterAuditWrite',
        'INJECTED_BACKFILL_FAULT:afterAuditWrite: injected audit-write fault',
      )
    }
    const remaining = findTargetRows(connection)
    if (remaining.length > 0) {
      throw new BackfillError(
        'BACKFILL_POSTCHECK_FAILED',
        `post-check still finds ${remaining.length} target row(s)`,
      )
    }
    const auditCount = connection.prepare(`
      SELECT COUNT(*) AS n FROM ${AUDIT_TABLE}
       WHERE supplement_id IN (${plan.targets.map(() => '?').join(',')})
    `).get(...plan.targets.map((target) => target.id))
    if (auditCount.n !== plan.targets.length) {
      throw new BackfillError(
        'AUDIT_POSTCHECK_FAILED',
        `audit post-check expected ${plan.targets.length} rows, found ${String(auditCount.n)}`,
      )
    }
    if (faultAt === 'beforeCommit') {
      throw new BackfillError(
        'INJECTED_BACKFILL_FAULT:beforeCommit',
        'INJECTED_BACKFILL_FAULT:beforeCommit: injected pre-commit fault',
      )
    }
    if (databasePath && expectedFileStat) {
      assertFileIdentity(databasePath, expectedFileStat)
    }
    connection.exec('COMMIT')
    return { applied, auditRowsWritten: applied, dryRun: false, shape: plan.shape }
  } catch (error) {
    try {
      connection.exec('ROLLBACK')
    } catch {
      // ROLLBACK 失败不遮蔽原始错误；连接关闭时未提交事务同样回滚。
    }
    throw error
  }
}

function usage() {
  return [
    'Usage:',
    '  node --experimental-sqlite scripts/legacy-supplement-source-generation-backfill.mjs \\',
    '    --database <绝对路径> --actor <操作者> --reason <原因> [--apply] [--json]',
    '',
    'Options:',
    '  --database <path>  目标 SQLite 数据库文件（必须已存在；默认拒绝创建）',
    '  --actor <name>     处置操作者（审计必填）',
    '  --reason <text>    处置原因（审计必填）',
    '  --apply            执行写入；缺省为只读 dry-run（不写任何字节）',
    '  --json             输出机器可读 JSON',
    '  --help             显示本帮助',
    '',
    'Exit codes: 0 = success / no-op; 1 = backfill error (see BACKFILL_ERROR <code>);',
    '            2 = usage error.',
  ].join('\n')
}

function parseArgs(argv) {
  const args = { database: null, actor: null, reason: null, apply: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') {
      args.help = true
    } else if (arg === '--apply') {
      args.apply = true
    } else if (arg === '--json') {
      args.json = true
    } else if (arg === '--database' || arg === '--actor' || arg === '--reason') {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new Error(`${arg} requires a value`)
      }
      if (arg === '--database') args.database = value
      if (arg === '--actor') args.actor = value
      if (arg === '--reason') args.reason = value
      index += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function databasePathFor(args) {
  if (args.database === ':memory:') {
    throw new BackfillError('BACKFILL_USAGE', '--database must be a real file path, not :memory:')
  }
  return resolve(process.cwd(), args.database)
}

function verifyDatabaseFile(databasePath) {
  let stat
  try {
    stat = statSync(databasePath, { bigint: true })
  } catch {
    throw new BackfillError(
      'DB_FILE_MISSING',
      `database file does not exist: ${databasePath}`,
    )
  }
  if (!stat.isFile()) {
    throw new BackfillError('DB_PATH_NOT_FILE', `database path is not a file: ${databasePath}`)
  }
  return stat
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const lines = [
    `SUPPLEMENT_BACKFILL ${result.dryRun ? 'dry-run' : 'applied'}`,
    `  database: ${result.database}`,
    `  shape: ${result.shape}`,
    `  targetRows: ${result.targetRows?.length ?? 0}`,
  ]
  for (const target of result.targetRows ?? []) {
    lines.push(`    - ${target.id} sourceDiffId=${target.sourceDiffId} hospitalMonthId=${target.hospitalMonthId}`)
  }
  lines.push(`  applied: ${result.applied}`)
  lines.push(`  auditRowsWritten: ${result.auditRowsWritten}`)
  if (result.dryRun) {
    lines.push('  no writes performed (read-only dry-run)')
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

export function runBackfill(args) {
  assertAuditInputs(args.actor, args.reason)
  const databasePath = databasePathFor(args)
  const expectedStat = verifyDatabaseFile(databasePath)
  if (!args.apply) {
    const connection = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const plan = planBackfill(connection)
      return {
        ok: true,
        dryRun: true,
        database: databasePath,
        shape: plan.shape,
        targetRows: plan.targets,
        applied: 0,
        auditRowsWritten: 0,
      }
    } finally {
      connection.close()
    }
  }

  const existedBeforeOpen = existsSync(databasePath)
  let createdEmptyArtifact = false
  let connection
  try {
    connection = new DatabaseSync(databasePath)
    const afterOpen = statSync(databasePath, { bigint: true })
    createdEmptyArtifact = !existedBeforeOpen && afterOpen.size === 0n
    const databaseList = connection.prepare('PRAGMA database_list').all()
    const mainPath = databaseList.find((row) => row.seq === 0)?.['file']
    if (
      typeof mainPath !== 'string'
      || mainPath.replace(/\\/g, '/').toLowerCase()
        !== databasePath.replace(/\\/g, '/').toLowerCase()
    ) {
      throw new BackfillError(
        'DB_PATH_REPLACED',
        `opened database main file ${String(mainPath)} does not match --database ${databasePath}`,
      )
    }
    assertFileIdentity(databasePath, expectedStat)
    const result = applyBackfill(connection, {
      actor: args.actor,
      reason: args.reason,
      databasePath,
      expectedFileStat: expectedStat,
    })
    return {
      ok: true,
      dryRun: false,
      database: databasePath,
      shape: result.shape,
      targetRows: [],
      applied: result.applied,
      auditRowsWritten: result.auditRowsWritten,
    }
  } finally {
    if (connection) {
      try {
        connection.close()
      } catch {
        // 关闭失败不覆盖原始结果
      }
    }
    if (createdEmptyArtifact) {
      try {
        unlinkSync(databasePath)
      } catch {
        // 清理本进程误建的空文件失败时保留现场供诊断
      }
    }
  }
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`BACKFILL_ERROR BACKFILL_USAGE: ${error.message}\n`)
    process.stderr.write(`${usage()}\n`)
    process.exitCode = 2
    return
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (!args.database || !args.actor || !args.reason) {
    process.stderr.write(
      'BACKFILL_ERROR BACKFILL_USAGE: --database, --actor and --reason are all required\n',
    )
    process.stderr.write(`${usage()}\n`)
    process.exitCode = 2
    return
  }
  try {
    const result = runBackfill(args)
    printResult(result, args.json)
  } catch (error) {
    const code = error instanceof BackfillError ? error.code : 'BACKFILL_INTERNAL'
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`BACKFILL_ERROR ${code}: ${message}\n`)
    process.exitCode = 1
  }
}

if (isMain()) {
  main()
}
