/**
 * 逐抗体成本地基 API（Phase 0）—— 抗体库主数据 + 每片成本派生 + 二抗/显色共享项 + G2 估参数 + 特染盒。
 *
 * 权限：挂载层 requirePermission('antibody_cost','R')（财务/管理员/实验室主任可读）；写端点再要 'W'（财务/管理员）。
 * 成本口径见 utils/antibody-cost.ts（每片一抗成本直接取台账已换算每人份价·勿再除换算率；算全含 G2 估工时/设备）。
 * 全站写审计由 app.ts 的 auditWrite 中间件自动落 operation_logs（本文件无需手写通用日志）。
 */
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { requirePermission } from '../middleware/permissions.js'
import {
  computeFullSlideCost,
  perSlidePrimaryCost,
  fallbackAveragePrimary,
  specialStainPerTestCost,
  DEFAULT_IHC_COST_PARAMS,
  type IhcCostParams,
} from '../utils/antibody-cost.js'
import {
  buildLedgerIndex,
  resolveAntibodyName,
  normalizeAntibodyName,
  type LedgerIndex,
  type LedgerRow,
} from '../utils/antibody-name-map.js'

const router = Router()

/** 从 antibodies 表构建台账索引（抗体名↔价+剂型 解析用）。 */
function buildDbLedgerIndex(db: any): LedgerIndex {
  const rows = db
    .prepare('SELECT name, form, per_test_price, category FROM antibodies WHERE is_deleted = 0')
    .all() as Array<{ name: string; form: string | null; per_test_price: number | null; category: string | null }>
  const ledger: LedgerRow[] = rows.map((r) => ({ name: r.name, form: r.form, perTestPrice: r.per_test_price, category: r.category }))
  return buildLedgerIndex(ledger)
}

/** 从 antibody_aliases 表构建 规范化(LIS名)→台账名 映射（DB=权威源，含 ops 新增）。 */
function buildSynonymMapFromDb(db: any): Map<string, string> {
  const m = new Map<string, string>()
  try {
    const rows = db.prepare('SELECT lis_name, canonical_name FROM antibody_aliases WHERE status = 1').all() as Array<{ lis_name: string; canonical_name: string }>
    for (const r of rows) m.set(normalizeAntibodyName(r.lis_name), r.canonical_name)
  } catch {
    /* 表未建 → 空映射（仅靠规范化） */
  }
  return m
}

interface AntibodyRow {
  id: string
  name: string
  clone_no: string | null
  supplier: string | null
  category: string
  form: string | null
  spec: string | null
  bottle_price: number | null
  per_test_price: number | null
  price_status: string
  source_ledger: string | null
}

/** 从 ihc_cost_params 表读「算全」参数（缺失回退默认 G2 估）。 */
function loadIhcParams(db: any): IhcCostParams {
  const p = { ...DEFAULT_IHC_COST_PARAMS }
  try {
    const rows = db.prepare('SELECT param_key, value FROM ihc_cost_params').all() as Array<{ param_key: string; value: number }>
    for (const r of rows) {
      if (r.param_key === 'secondary_per_slide') p.secondaryPerSlide = Number(r.value)
      else if (r.param_key === 'labor_per_slide') p.laborPerSlide = Number(r.value)
      else if (r.param_key === 'equipment_per_slide') p.equipmentPerSlide = Number(r.value)
    }
  } catch {
    /* 表未建 → 默认 */
  }
  return p
}

function toCostInput(row: AntibodyRow) {
  return { name: row.name, form: row.form, perTestPrice: row.per_test_price, category: row.category }
}

// GET /antibodies —— 抗体库列表（含每片一抗成本 perSlideCost + 完整度）
router.get('/antibodies', (req, res) => {
  try {
    const db = getDatabase()
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1)
    const pageSize = Math.min(1000, Math.max(1, parseInt(String(req.query.pageSize ?? '50'), 10) || 50))
    const keyword = String(req.query.keyword ?? '').trim()
    const category = String(req.query.category ?? '').trim()
    const where: string[] = ['is_deleted = 0']
    const params: any[] = []
    if (keyword) {
      where.push('(name LIKE ? OR supplier LIKE ?)')
      params.push(`%${keyword}%`, `%${keyword}%`)
    }
    if (category) {
      where.push('category = ?')
      params.push(category)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM antibodies ${whereSql}`).get(...params) as { n: number }).n
    const rows = db
      .prepare(`SELECT * FROM antibodies ${whereSql} ORDER BY name ASC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as AntibodyRow[]
    const list = rows.map((row) => {
      const primary = perSlidePrimaryCost(toCostInput(row))
      return {
        id: row.id,
        name: row.name,
        cloneNo: row.clone_no,
        supplier: row.supplier,
        category: row.category,
        form: row.form,
        spec: row.spec,
        perTestPrice: row.per_test_price,
        perSlideCost: primary, // 每片一抗成本（台账已换算真价；缺价=null）
        priceStatus: row.price_status,
        completeness: primary !== null ? '精算' : '粗估',
        sourceLedger: row.source_ledger,
      }
    })
    successList(res, list, page, pageSize, total)
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /antibodies/resolve —— 把 LIS 抗体名解析成台账（价 + 剂型）。供 LIS/对账侧对上台账价用。
//   ?name=（必填）&form=（可选，LIS 有剂型时传）。返回 matchKind(exact/alias/missing/non_antibody) + canonicalName + form + formAssumed + perTestPrice + priceStatus。
//   注册在 /antibodies 之后、:id 路由之前，避免 'resolve' 被当成 id。
router.get('/antibodies/resolve', (req, res) => {
  try {
    const db = getDatabase()
    const nameQ = String(req.query.name ?? '').trim()
    if (!nameQ) return error(res, '需提供 name', 'BAD_REQUEST', 400)
    const formQ = String(req.query.form ?? '').trim()
    const rr = resolveAntibodyName(nameQ, buildDbLedgerIndex(db), buildSynonymMapFromDb(db), formQ ? { form: formQ } : {})
    success(res, rr)
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /cost-preview —— 每片「算全」成本派生（一抗 + 二抗/显色 + 工时G2 + 设备G2 + 完整度分档）
//   入参：?id= 或 ?name=（可加 &form=）从库取；或 ?perTestPrice= 直接试算。
router.get('/cost-preview', (req, res) => {
  try {
    const db = getDatabase()
    const params = loadIhcParams(db)
    const avg = fallbackAveragePrimary()
    const idQ = String(req.query.id ?? '').trim()
    const nameQ = String(req.query.name ?? '').trim()
    const formQ = String(req.query.form ?? '').trim()
    const priceQ = req.query.perTestPrice

    let costInput: { name?: string; form?: string | null; perTestPrice?: number | null; category?: string | null }
    let resolution: ReturnType<typeof resolveAntibodyName> | null = null
    if (idQ) {
      const row = db.prepare('SELECT * FROM antibodies WHERE id = ? AND is_deleted = 0').get(idQ) as AntibodyRow | undefined
      if (!row) return error(res, '抗体不存在', 'NOT_FOUND', 404)
      costInput = toCostInput(row)
    } else if (nameQ) {
      // A1+A3 名称映射：先经 resolver 把 LIS 写法（Ecad/Ki67/…）对上台账（价+剂型）。
      //   同名多剂型 + 无剂型 → 保守取高价 + 剂型待确认；台账真缺 → 走降级(粗估) + 行级标注（不再直接 404）。
      resolution = resolveAntibodyName(nameQ, buildDbLedgerIndex(db), buildSynonymMapFromDb(db), formQ ? { form: formQ } : {})
      if (resolution.matchKind === 'non_antibody') {
        return error(res, `「${nameQ}」是${resolution.category ?? '非抗体'}，不是抗体，无法算每片抗体成本`, 'BAD_REQUEST', 400)
      }
      costInput = { name: resolution.canonicalName ?? nameQ, form: resolution.form, perTestPrice: resolution.perTestPrice, category: '一抗' }
    } else if (priceQ !== undefined) {
      costInput = { perTestPrice: Number(priceQ), category: '一抗' }
    } else {
      return error(res, '需提供 id / name / perTestPrice 之一', 'BAD_REQUEST', 400)
    }

    const breakdown = computeFullSlideCost(costInput, params, { fallbackAvg: avg })
    success(res, { ...breakdown, params, fallbackAvg: avg, resolution })
  } catch (err: any) {
    error(res, err.message)
  }
})

// POST /antibodies —— 新增抗体（写）
router.post('/antibodies', requirePermission('antibody_cost', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const b = req.body ?? {}
    const name = String(b.name ?? '').trim()
    if (!name) return error(res, '抗体名称必填', 'BAD_REQUEST', 400)
    const form = b.form != null ? String(b.form).trim() : null
    const perTestPrice = b.perTestPrice != null && b.perTestPrice !== '' ? Number(b.perTestPrice) : null
    const priceStatus = typeof perTestPrice === 'number' && perTestPrice > 0 ? 'has_price' : 'missing'
    const id = uuidv4()
    try {
      db.prepare(`
        INSERT INTO antibodies (id, name, clone_no, supplier, category, form, spec, bottle_price, conv_rate, per_test_price, dilution, usage_per_slide, price_status, source_ledger, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        id, name, b.cloneNo ?? null, b.supplier ?? null, String(b.category ?? '一抗'), form, b.spec ?? null,
        b.bottlePrice ?? 0, b.convRate ?? null, perTestPrice, b.dilution ?? null, b.usagePerSlide ?? null,
        priceStatus, b.sourceLedger ?? '手工录入', (req as any).user?.username ?? null,
      )
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) return error(res, `抗体已存在（${name} / ${form ?? '未指定剂型'}）`, 'CONFLICT', 409)
      throw e
    }
    success(res, { id }, '抗体已新增', 201)
  } catch (err: any) {
    error(res, err.message)
  }
})

// PUT /antibodies/:id —— 更新抗体（写）
router.put('/antibodies/:id', requirePermission('antibody_cost', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params
    const existing = db.prepare('SELECT * FROM antibodies WHERE id = ? AND is_deleted = 0').get(id) as AntibodyRow | undefined
    if (!existing) return error(res, '抗体不存在', 'NOT_FOUND', 404)
    const b = req.body ?? {}
    const perTestPrice = b.perTestPrice !== undefined ? (b.perTestPrice === '' || b.perTestPrice == null ? null : Number(b.perTestPrice)) : existing.per_test_price
    const priceStatus = typeof perTestPrice === 'number' && perTestPrice > 0 ? 'has_price' : 'missing'
    db.prepare(`
      UPDATE antibodies
      SET clone_no = ?, supplier = ?, category = ?, form = ?, spec = ?, bottle_price = ?, conv_rate = ?, per_test_price = ?, dilution = ?, usage_per_slide = ?, price_status = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
      WHERE id = ?
    `).run(
      b.cloneNo ?? existing.clone_no, b.supplier ?? existing.supplier, String(b.category ?? existing.category),
      b.form ?? existing.form, b.spec ?? existing.spec, b.bottlePrice ?? existing.bottle_price,
      b.convRate ?? null, perTestPrice, b.dilution ?? null, b.usagePerSlide ?? null, priceStatus,
      (req as any).user?.username ?? null, id,
    )
    success(res, { id }, '抗体已更新')
  } catch (err: any) {
    error(res, err.message)
  }
})

// DELETE /antibodies/:id —— 软删除（写）
router.delete('/antibodies/:id', requirePermission('antibody_cost', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params
    const existing = db.prepare('SELECT id FROM antibodies WHERE id = ? AND is_deleted = 0').get(id)
    if (!existing) return error(res, '抗体不存在', 'NOT_FOUND', 404)
    db.prepare('UPDATE antibodies SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?').run((req as any).user?.username ?? null, id)
    success(res, { id }, '抗体已删除')
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /detection-systems —— 二抗/显色/辅料 共享项
router.get('/detection-systems', (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM detection_systems WHERE is_deleted = 0 ORDER BY type, name').all() as Array<any>
    const list = rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, form: r.form, spec: r.spec,
      perSlideCost: r.per_slide_cost, isDefault: !!r.is_default, sourceLedger: r.source_ledger,
    }))
    success(res, list)
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /cost-params —— 算全参数（二抗/工时/设备，含 G2 估来源标注）
router.get('/cost-params', (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT param_key, value, source, confidence, remark FROM ihc_cost_params ORDER BY param_key').all()
    success(res, { params: loadIhcParams(db), rows })
  } catch (err: any) {
    error(res, err.message)
  }
})

// PUT /cost-params/:key —— 调整算全参数（写；碰成本口径）
router.put('/cost-params/:key', requirePermission('antibody_cost', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const key = req.params.key
    const allowed = ['secondary_per_slide', 'labor_per_slide', 'equipment_per_slide']
    if (!allowed.includes(key)) return error(res, '未知参数', 'BAD_REQUEST', 400)
    const value = Number(req.body?.value)
    if (!Number.isFinite(value) || value < 0) return error(res, '参数值非法', 'BAD_REQUEST', 400)
    const exists = db.prepare('SELECT id FROM ihc_cost_params WHERE param_key = ?').get(key) as { id: string } | undefined
    if (exists) {
      db.prepare('UPDATE ihc_cost_params SET value = ?, source = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE param_key = ?')
        .run(value, String(req.body?.source ?? '手工'), (req as any).user?.username ?? null, key)
    } else {
      db.prepare('INSERT INTO ihc_cost_params (id, param_key, value, source, updated_by) VALUES (?, ?, ?, ?, ?)')
        .run(uuidv4(), key, value, String(req.body?.source ?? '手工'), (req as any).user?.username ?? null)
    }
    success(res, { key, value }, '参数已更新')
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /special-stains —— 特染盒（每次成本 = 盒价÷标称次数 + 工时）
router.get('/special-stains', (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM special_stain_kits WHERE is_deleted = 0 ORDER BY name').all() as Array<any>
    const list = rows.map((r) => ({
      id: r.id, name: r.name, kitPrice: r.kit_price, nominalTests: r.nominal_tests, actualYield: r.actual_yield,
      laborPerTest: r.labor_per_test,
      perTestCost: specialStainPerTestCost({ kitPrice: Number(r.kit_price), nominalTests: Number(r.nominal_tests), actualYield: r.actual_yield, laborPerTest: Number(r.labor_per_test) }),
      remark: r.remark, sourceLedger: r.source_ledger,
    }))
    success(res, list)
  } catch (err: any) {
    error(res, err.message)
  }
})

// GET /antibody-aliases —— 别名表（LIS 名 → 台账名），ops 可读/加/删。
router.get('/antibody-aliases', (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT id, lis_name, canonical_name, note, source, status FROM antibody_aliases ORDER BY lis_name').all() as Array<any>
    const list = rows.map((r) => ({ id: r.id, lisName: r.lis_name, canonicalName: r.canonical_name, note: r.note, source: r.source, status: r.status }))
    success(res, list)
  } catch (err: any) {
    error(res, err.message)
  }
})

// POST /antibody-aliases —— 新增别名（写）。canonical_name 必须是已存在的台账抗体名，否则拒绝（防映射到不存在的名）。
router.post('/antibody-aliases', requirePermission('antibody_cost', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const b = req.body ?? {}
    const lisName = String(b.lisName ?? '').trim()
    const canonicalName = String(b.canonicalName ?? '').trim()
    if (!lisName || !canonicalName) return error(res, 'lisName / canonicalName 必填', 'BAD_REQUEST', 400)
    const target = db.prepare('SELECT 1 FROM antibodies WHERE name = ? AND is_deleted = 0 LIMIT 1').get(canonicalName)
    if (!target) return error(res, `台账无抗体「${canonicalName}」，不能作为别名目标`, 'BAD_REQUEST', 400)
    try {
      db.prepare(`
        INSERT INTO antibody_aliases (id, lis_name, canonical_name, note, source, status, created_by)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(uuidv4(), lisName, canonicalName, b.note ?? null, '手工录入', (req as any).user?.username ?? null)
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) return error(res, `别名已存在（${lisName}）`, 'CONFLICT', 409)
      throw e
    }
    success(res, { lisName, canonicalName }, '别名已新增', 201)
  } catch (err: any) {
    error(res, err.message)
  }
})

// DELETE /antibody-aliases/:id —— 删除别名（写）。
router.delete('/antibody-aliases/:id', requirePermission('antibody_cost', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const existing = db.prepare('SELECT id FROM antibody_aliases WHERE id = ?').get(req.params.id)
    if (!existing) return error(res, '别名不存在', 'NOT_FOUND', 404)
    db.prepare('DELETE FROM antibody_aliases WHERE id = ?').run(req.params.id)
    success(res, { id: req.params.id }, '别名已删除')
  } catch (err: any) {
    error(res, err.message)
  }
})

export default router
