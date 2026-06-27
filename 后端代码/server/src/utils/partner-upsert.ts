/**
 * 合作医院（partner）按名称 upsert —— 供 LIS 导入(W3)/账单导入(W4) 把「送检医院」名落成 partner。
 * 纯 DB 帮手，无 express 依赖。名称匹配（trim）；不存在则建（生成 PT-xxxxx 码，service_scope 默认仅技术）。
 */

export interface PartnerRef {
  id: string
  code: string
  name: string
  created: boolean
}

export type ServiceScope = 'technical_only' | 'with_diagnosis'

interface DbLike {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }
}

function genPartnerCode(db: DbLike): string {
  const max = db.prepare("SELECT MAX(CAST(SUBSTR(code, 4) AS INTEGER)) AS m FROM partners WHERE code LIKE 'PT-%'").get() as { m: number } | undefined
  let num = (Number(max?.m) || 0) + 1
  let code = `PT-${String(num).padStart(5, '0')}`
  while (db.prepare('SELECT 1 FROM partners WHERE code = ?').get(code)) {
    num++
    code = `PT-${String(num).padStart(5, '0')}`
  }
  return code
}

/**
 * 按名称找或建 partner。返回 id/code/是否新建。
 * @param genId 注入 id 生成器（生产传 uuidv4；测试可注入确定值）
 */
export function findOrCreatePartner(
  db: DbLike,
  name: string,
  genId: () => string,
  opts: { serviceScope?: ServiceScope; createdBy?: string } = {},
): PartnerRef {
  const clean = (name || '').trim()
  if (!clean) throw new Error('partner name required')

  const existing = db.prepare('SELECT id, code, name FROM partners WHERE name = ? AND is_deleted = 0').get(clean) as
    | { id: string; code: string; name: string }
    | undefined
  if (existing) return { id: existing.id, code: existing.code, name: existing.name, created: false }

  const id = genId()
  const code = genPartnerCode(db)
  db.prepare(
    `INSERT INTO partners (id, code, name, service_scope, status, created_by) VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(id, code, clean, opts.serviceScope || 'technical_only', opts.createdBy || null)
  return { id, code, name: clean, created: true }
}
