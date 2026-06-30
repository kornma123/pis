/**
 * PRD-0 T1.0 — 跨院同号审计报告。
 *
 * lis_cases/outbound_abc_details 的 case_no 是否跨多个 partner_id？据此决定 ABC 回填口径（精确复合键 vs 兼容单键）。
 * 纯只读，不改任何数据。供迁移前审计 + 路由 /audit 调用 + TC1.0 测试。
 *
 * gate 语义（§7.1）：abcCaseNoAmbiguousCount > 0 → 不得走单键回填，只能精确 (partner_id, case_no) 或保持未回填。
 */

interface DbLike {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }
}

export interface CrossPartnerAudit {
  /** lis_cases 中同一 case_no 对应 >1 个 partner_id 的 case_no 数（跨院撞号） */
  lisDuplicateCaseNoAcrossPartnerCount: number
  /** lis_cases 中 partner_id IS NULL 的行数（迁移不得自动并入任意医院） */
  lisNullPartnerCount: number
  /** outbound_abc_details 的 case_no 在 lis_cases 中精确对应单一 partner 的 case_no 数（可精确回填） */
  abcCaseNoMatchedSinglePartnerCount: number
  /** outbound_abc_details 的 case_no 在 lis_cases 中对应 >1 partner 的 case_no 数（歧义→不得单键回填） */
  abcCaseNoAmbiguousCount: number
  /** outbound_abc_details 的 case_no 在 lis_cases 无任何非空 partner 匹配的 case_no 数（无法回填） */
  abcCaseNoNoLisMatchCount: number
  lisHasPartnerIdColumn: boolean
  abcTableExists: boolean
  abcHasPartnerIdColumn: boolean
}

function tableExists(db: DbLike, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
}
function hasColumn(db: DbLike, table: string, col: string): boolean {
  if (!tableExists(db, table)) return false
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === col)
}
function count(db: DbLike, sql: string): number {
  return Number((db.prepare(sql).get() as { n?: number } | undefined)?.n) || 0
}

export function auditCrossPartnerCaseNos(db: DbLike): CrossPartnerAudit {
  const lisHasPartnerId = hasColumn(db, 'lis_cases', 'partner_id')
  const abcExists = tableExists(db, 'outbound_abc_details')
  const abcHasPartnerId = hasColumn(db, 'outbound_abc_details', 'partner_id')

  const lisDuplicateCaseNoAcrossPartnerCount = lisHasPartnerId
    ? count(db, `SELECT COUNT(*) n FROM (
        SELECT case_no FROM lis_cases WHERE partner_id IS NOT NULL
        GROUP BY case_no HAVING COUNT(DISTINCT partner_id) > 1)`)
    : 0
  const lisNullPartnerCount = lisHasPartnerId
    ? count(db, `SELECT COUNT(*) n FROM lis_cases WHERE partner_id IS NULL`)
    : (tableExists(db, 'lis_cases') ? count(db, `SELECT COUNT(*) n FROM lis_cases`) : 0)

  // ABC case_no → lis_cases 非空 partner 的 distinct 计数，按 0 / 1 / >1 分桶
  const abcBucket = (op: '=0' | '=1' | '>1'): number =>
    abcExists && lisHasPartnerId
      ? count(db, `SELECT COUNT(*) n FROM (
          SELECT d.case_no FROM outbound_abc_details d WHERE d.case_no IS NOT NULL
          GROUP BY d.case_no
          HAVING (SELECT COUNT(DISTINCT lc.partner_id) FROM lis_cases lc
                  WHERE lc.case_no = d.case_no AND lc.partner_id IS NOT NULL) ${op})`)
      : 0

  return {
    lisDuplicateCaseNoAcrossPartnerCount,
    lisNullPartnerCount,
    abcCaseNoMatchedSinglePartnerCount: abcBucket('=1'),
    abcCaseNoAmbiguousCount: abcBucket('>1'),
    abcCaseNoNoLisMatchCount: abcBucket('=0'),
    lisHasPartnerIdColumn: lisHasPartnerId,
    abcTableExists: abcExists,
    abcHasPartnerIdColumn: abcHasPartnerId,
  }
}
