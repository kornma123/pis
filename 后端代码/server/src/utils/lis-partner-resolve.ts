/**
 * PRD-0 T1 全链路补漏 —— LIS 病例号 → 规范 partner 解析（精确优先、拒绝歧义）。
 *
 * 账单/NGS 订单导入会用 LIS 的 partner 规范化收入归属（治医院名别名/错字）。但跨院同号下
 * `WHERE case_no=?` 会命中多院 → 取第一行=随机选院（违反 §7.1）。这里仅当精确对应【单一】非空
 * partner 时才返回；歧义/无匹配 → undefined，调用方退回账单/订单自带的医院名解析。
 */

interface DbLike {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] }
}

export function resolveLisCanonicalPartner(db: DbLike, caseNo: string): string | undefined {
  const rows = db.prepare(
    'SELECT DISTINCT partner_id FROM lis_cases WHERE case_no = ? AND partner_id IS NOT NULL',
  ).all(caseNo) as Array<{ partner_id: string }>
  return rows.length === 1 ? rows[0].partner_id : undefined
}
