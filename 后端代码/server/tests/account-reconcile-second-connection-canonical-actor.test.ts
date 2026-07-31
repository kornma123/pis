/**
 * Issue #98（LOC-005 follow-up）：医院月终态第二连接 canonical actor 硬闸。
 *
 * 冻结方向：所有受支持 SQLite 写连接使用同一 canonical actor UDF/语义
 * （coreone_canonical_actor + 原始 BLOB instr(x'00') 闸，即 canonicalActorSql）；
 * 未注册 UDF 的连接在写入点以稳定错误、零写入 fail-closed；
 * 禁止回退到 SQLite 默认 trim() 子集（trim 只剥 U+0020，tab/newline/C0/C1/NBSP/
 * em-space 会在第二连接冒充非空 actor）。
 *
 * RED 证明：本文件使用真实第二个 DatabaseSync 连接直接 DML；修复前
 * 不合规 actor（Tab、newline、C0、C1、NBSP、em-space 等）可写入
 * reconcile_hospital_months.completed_by/closed_by，以下断言全部变红。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'coreone-second-connection-actor-'))
const DB_FILE = join(TMP_DIR, 'second-actor.db')
const ORIGINAL_DATABASE_PATH = process.env.DATABASE_PATH
process.env.DATABASE_PATH = DB_FILE

const MONTH = '2026-06'
const COMPLETE_SQL = `
  UPDATE reconcile_hospital_months
     SET status = '复核完成', completed_at = CURRENT_TIMESTAMP,
         completed_by = ?, updated_at = CURRENT_TIMESTAMP
   WHERE id = ?
`
const CLOSE_SQL = `
  UPDATE reconcile_hospital_months
     SET status = '已关账', closed_at = CURRENT_TIMESTAMP,
         closed_by = ?, updated_at = CURRENT_TIMESTAMP
   WHERE id = ?
`

// 敌对方向：非 ASCII 空白/控制符（Tab、newline、CR、C0 1F、C1 NEL、
// NBSP-only、em-space-only、纯控制串）+ 既有回归负控（纯空格、空串、NULL、
// BLOB、INTEGER、NUL-tail）。NBSP/em-space 按仓库 canonical actor 契约只拒绝
// 纯空白串（JS trim 语义，与 isCanonicalActor/BAD_CANONICAL_ACTORS 同口径）。
// 注意：INTEGER 经 TEXT affinity 会落成合法文本（如 42 -> '42'），与 generation
// 侧既有语义一致，故不列入 actor 负控；BLOB/NULL 保持非 TEXT 负控。
const HOSTILE_ACTORS: ReadonlyArray<readonly [string, unknown]> = [
  ['tab', 'admin\t'],
  ['newline', 'admin\njunk'],
  ['cr', 'admin\rjunk'],
  ['c0-1f', 'admin\x1F'],
  ['c1-nel-85', 'admin\u0085'],
  ['nbsp-only', '\u00A0'],
  ['em-space-only', '\u2003'],
  ['control-only', '\x1F\x85'],
  ['space-only', '   '],
  ['empty', ''],
  ['null', null],
  ['blob', new Uint8Array([0x61, 0x62])],
  ['nul-tail', 'admin\0junk'],
] as const

let manager: typeof import('../src/database/DatabaseManager.js')
let managed: any
let unregistered: DatabaseSync
let registered: DatabaseSync
let sequence = 0

function seedPendingRow(id: string, partnerId: string) {
  managed.prepare(`
    INSERT INTO reconcile_hospital_months (id, partner_id, partner_name, service_month)
    VALUES (?, ?, ?, ?)
  `).run(id, partnerId, `第二连接测试院-${partnerId}`, MONTH)
}

function rowState(id: string) {
  return managed.prepare(`
    SELECT status, completed_at, completed_by, closed_at, closed_by
      FROM reconcile_hospital_months WHERE id = ?
  `).get(id) as {
    status: string
    completed_at: unknown
    completed_by: unknown
    closed_at: unknown
    closed_by: unknown
  }
}

const PENDING_ROW = {
  status: '待复核',
  completed_at: null,
  completed_by: null,
  closed_at: null,
  closed_by: null,
}

function attemptComplete(connection: DatabaseSync, id: string, actor: unknown) {
  connection.prepare(COMPLETE_SQL).run(actor as never, id)
}

function attemptClose(connection: DatabaseSync, id: string, actor: unknown) {
  connection.prepare(CLOSE_SQL).run(actor as never, id)
}

beforeAll(async () => {
  manager = await import('../src/database/DatabaseManager.js')
  manager.initializeDatabase()
  managed = manager.getDatabase()
  // 真实第二个连接：未注册任何应用 UDF（产品合同下的“不支持”写连接）。
  unregistered = new DatabaseSync(DB_FILE)
  // 受支持写连接：与 openManagedDatabase/upgradeAccountReconciliationSchema
  // 同入口注册 canonical actor UDF。
  registered = new DatabaseSync(DB_FILE)
  manager.registerCoreoneSqlFunctions(registered)
}, 120_000)

afterAll(() => {
  try { unregistered?.close() } catch { /* already closed */ }
  try { registered?.close() } catch { /* already closed */ }
  try { manager.resetDatabase() } catch { /* already closed */ }
  rmSync(TMP_DIR, { recursive: true, force: true })
  if (ORIGINAL_DATABASE_PATH === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = ORIGINAL_DATABASE_PATH
}, 120_000)

describe('未注册 UDF 的第二连接直接 DML：写入点稳定失败、零写入（Issue #98 负控）', () => {
  it.each(HOSTILE_ACTORS)(
    'pending -> 复核完成 completed_by=%s 必须被拒且零写',
    (_label, actor) => {
      const id = `HM-UNREG-COMPLETE-${++sequence}`
      seedPendingRow(id, `PT-UNREG-COMPLETE-${sequence}`)
      let err: unknown = null
      try {
        attemptComplete(unregistered, id, actor)
      } catch (e) {
        err = e
      }
      expect(err, '未注册连接 guarded 写入必须整体失败').not.toBeNull()
      expect(String((err as Error)?.message ?? err)).toMatch(/no such function: coreone_canonical_actor/)
      expect(rowState(id)).toMatchObject(PENDING_ROW)
    },
  )

  it.each(HOSTILE_ACTORS)(
    '复核完成 -> 已关账 closed_by=%s 必须被拒且零写',
    (_label, actor) => {
      const id = `HM-UNREG-CLOSE-${++sequence}`
      seedPendingRow(id, `PT-UNREG-CLOSE-${sequence}`)
      // 前置合法完成由受管连接写入（正控，actor='admin'）。
      attemptComplete(managed, id, 'admin')
      let err: unknown = null
      try {
        attemptClose(unregistered, id, actor)
      } catch (e) {
        err = e
      }
      expect(err, '未注册连接 guarded 写入必须整体失败').not.toBeNull()
      expect(String((err as Error)?.message ?? err)).toMatch(/no such function: coreone_canonical_actor/)
      expect(rowState(id)).toMatchObject({
        status: '复核完成',
        closed_at: null,
        closed_by: null,
      })
    },
  )

  it('未注册连接即使写入合法中英文 actor 也稳定失败、零写入（含合法写 fail-closed）', () => {
    const enId = `HM-UNREG-LEGAL-EN-${++sequence}`
    seedPendingRow(enId, `PT-UNREG-LEGAL-EN-${sequence}`)
    expect(() => attemptComplete(unregistered, enId, 'admin')).toThrow(
      /no such function: coreone_canonical_actor/,
    )
    expect(rowState(enId)).toMatchObject(PENDING_ROW)

    const cnId = `HM-UNREG-LEGAL-CN-${++sequence}`
    seedPendingRow(cnId, `PT-UNREG-LEGAL-CN-${sequence}`)
    attemptComplete(managed, cnId, '张医生')
    expect(() => attemptClose(unregistered, cnId, '李医生')).toThrow(
      /no such function: coreone_canonical_actor/,
    )
    expect(rowState(cnId)).toMatchObject({
      status: '复核完成',
      closed_at: null,
      closed_by: null,
    })
  })
})

describe('受支持（已注册 UDF）第二连接：同一 canonical actor 语义', () => {
  it('合法英文/中文 actor 正控照常通过（complete + close）', () => {
    const enId = `HM-REG-POS-EN-${++sequence}`
    seedPendingRow(enId, `PT-REG-POS-EN-${sequence}`)
    attemptComplete(registered, enId, 'admin')
    expect(rowState(enId)).toMatchObject({
      status: '复核完成',
      completed_by: 'admin',
      closed_by: null,
    })
    attemptClose(registered, enId, 'zhang-reviewer')
    expect(rowState(enId)).toMatchObject({
      status: '已关账',
      closed_by: 'zhang-reviewer',
    })

    const cnId = `HM-REG-POS-CN-${++sequence}`
    seedPendingRow(cnId, `PT-REG-POS-CN-${sequence}`)
    attemptComplete(registered, cnId, '张医生')
    attemptClose(registered, cnId, '李医生')
    expect(rowState(cnId)).toMatchObject({
      status: '已关账',
      completed_by: '张医生',
      closed_by: '李医生',
    })
  })

  it('非 ASCII 空白/控制符在已注册连接同样以既有稳定错误码拒绝、零写入', () => {
    for (const [label, actor] of HOSTILE_ACTORS) {
      const id = `HM-REG-NEG-${label}-${++sequence}`
      seedPendingRow(id, `PT-REG-NEG-${label}-${sequence}`)
      expect(
        () => attemptComplete(registered, id, actor),
        `registered complete with ${label} must be rejected`,
      ).toThrow(/PENDING_HOSPITAL_MONTH_COMPLETION_MALFORMED/)
      expect(rowState(id)).toMatchObject(PENDING_ROW)
    }
  })

  it('已注册连接 close 侧的既有稳定错误码保持（含 NUL-tail/空白负控）', () => {
    const id = `HM-REG-CLOSE-NEG-${++sequence}`
    seedPendingRow(id, `PT-REG-CLOSE-NEG-${sequence}`)
    attemptComplete(managed, id, 'admin')
    for (const [label, actor] of HOSTILE_ACTORS) {
      expect(
        () => attemptClose(registered, id, actor),
        `registered close with ${label} must be rejected`,
      ).toThrow(/COMPLETE_HOSPITAL_MONTH_FINAL/)
      expect(rowState(id)).toMatchObject({
        status: '复核完成',
        closed_at: null,
        closed_by: null,
      })
    }
  })
})

describe('真实重启 + 新鲜第二连接：注册恢复、未注册仍 fail-closed', () => {
  it('closeDatabase -> initializeDatabase 后受管连接正控恢复，新鲜未注册连接仍零写失败', () => {
    manager.closeDatabase()
    manager.initializeDatabase()
    managed = manager.getDatabase()

    const freshUnregistered = new DatabaseSync(DB_FILE)
    try {
      const id = `HM-RESTART-UNREG-${++sequence}`
      seedPendingRow(id, `PT-RESTART-UNREG-${sequence}`)
      expect(() => attemptComplete(freshUnregistered, id, 'admin\t')).toThrow(
        /no such function: coreone_canonical_actor/,
      )
      expect(() => attemptComplete(freshUnregistered, id, 'admin')).toThrow(
        /no such function: coreone_canonical_actor/,
      )
      expect(rowState(id)).toMatchObject(PENDING_ROW)

      // 受管连接（重启后重新注册 UDF）合法中文 actor 正控照常。
      const legalId = `HM-RESTART-LEGAL-${++sequence}`
      seedPendingRow(legalId, `PT-RESTART-LEGAL-${sequence}`)
      attemptComplete(managed, legalId, '张医生')
      attemptClose(managed, legalId, 'admin')
      expect(rowState(legalId)).toMatchObject({
        status: '已关账',
        completed_by: '张医生',
        closed_by: 'admin',
      })
      // startup 扫描（upgrade 路径）对合法终态零误伤。
      expect(() => manager.upgradeAccountReconciliationSchema(managed)).not.toThrow()
    } finally {
      freshUnregistered.close()
    }
  })
})
