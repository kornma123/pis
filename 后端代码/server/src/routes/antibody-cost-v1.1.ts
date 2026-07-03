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
  deriveCalibrationState,
  deriveLaborEquipmentPerSlide,
  isParamCalibrated,
  DEFAULT_IHC_COST_PARAMS,
  type IhcCostParams,
} from '../utils/antibody-cost.js'
import { writeAuditLog } from '../utils/cost-runs.js'

const router = Router()

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

/** 从 ihc_cost_params 表读「算全」参数（缺失回退默认 G2 估）；顺带把工时/设备的校准状态读进来（B4 诚实透出）。 */
function loadIhcParams(db: any): IhcCostParams {
  const p = { ...DEFAULT_IHC_COST_PARAMS }
  try {
    const rows = db
      .prepare('SELECT param_key, value, source, confidence FROM ihc_cost_params')
      .all() as Array<{ param_key: string; value: number; source: string | null; confidence: string | null }>
    for (const r of rows) {
      if (r.param_key === 'secondary_per_slide') p.secondaryPerSlide = Number(r.value)
      else if (r.param_key === 'labor_per_slide') {
        p.laborPerSlide = Number(r.value)
        p.laborCalibrated = isParamCalibrated(r)
      } else if (r.param_key === 'equipment_per_slide') {
        p.equipmentPerSlide = Number(r.value)
        p.equipmentCalibrated = isParamCalibrated(r)
      }
    }
  } catch {
    /* 表未建 → 默认 */
  }
  return p
}

/** 每参数来源/置信/备注（B4 诚实透出：供前端如实标注「G2 估·待校准」而非冒充精确）。 */
function loadIhcParamMeta(db: any): Record<string, { source: string | null; confidence: string | null; remark: string | null }> {
  const out: Record<string, { source: string | null; confidence: string | null; remark: string | null }> = {}
  try {
    const rows = db.prepare('SELECT param_key, source, confidence, remark FROM ihc_cost_params').all() as Array<{
      param_key: string
      source: string | null
      confidence: string | null
      remark: string | null
    }>
    for (const r of rows) out[r.param_key] = { source: r.source ?? null, confidence: r.confidence ?? null, remark: r.remark ?? null }
  } catch {
    /* 表未建 */
  }
  return out
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
    if (idQ) {
      const row = db.prepare('SELECT * FROM antibodies WHERE id = ? AND is_deleted = 0').get(idQ) as AntibodyRow | undefined
      if (!row) return error(res, '抗体不存在', 'NOT_FOUND', 404)
      costInput = toCostInput(row)
    } else if (nameQ) {
      // 同名多剂型（如 CK19/CK20 有 原液+即用，价差 ~6 倍）：只给 name 时取**每人份价更高者**（保守=不高估毛利）；
      // 需精确按剂型请带 &form=。
      const row = (formQ
        ? db.prepare('SELECT * FROM antibodies WHERE name = ? AND form = ? AND is_deleted = 0').get(nameQ, formQ)
        : db.prepare('SELECT * FROM antibodies WHERE name = ? AND is_deleted = 0 ORDER BY per_test_price DESC').get(nameQ)) as AntibodyRow | undefined
      if (!row) return error(res, '抗体不存在', 'NOT_FOUND', 404)
      costInput = toCostInput(row)
    } else if (priceQ !== undefined) {
      costInput = { perTestPrice: Number(priceQ), category: '一抗' }
    } else {
      return error(res, '需提供 id / name / perTestPrice 之一', 'BAD_REQUEST', 400)
    }

    const breakdown = computeFullSlideCost(costInput, params, { fallbackAvg: avg })
    // meta：透出工时/设备等每参数的 source/confidence/remark，供前端如实标注「G2 估·待校准」而非冒充精确（B4）
    success(res, { ...breakdown, params, fallbackAvg: avg, meta: loadIhcParamMeta(db) })
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

// GET /cost-params —— 算全参数（二抗/工时/设备，含 G2 估来源标注 + 整体校准状态）
router.get('/cost-params', (_req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare('SELECT param_key, value, source, confidence, remark FROM ihc_cost_params ORDER BY param_key').all()
    const params = loadIhcParams(db)
    // calibrationState：工时/设备两半的整体校准状态（G2估/部分校准/已校准），诚实透出弱锚（B4）
    success(res, { params, rows, calibrationState: deriveCalibrationState(!!params.laborCalibrated, !!params.equipmentCalibrated) })
  } catch (err: any) {
    error(res, err.message)
  }
})

// PUT /cost-params/:key —— 手工调整算全参数（写；碰成本口径）。持久化 confidence/remark，并落 before/after 留痕。
router.put('/cost-params/:key', requirePermission('antibody_cost', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const key = req.params.key
    const allowed = ['secondary_per_slide', 'labor_per_slide', 'equipment_per_slide']
    if (!allowed.includes(key)) return error(res, '未知参数', 'BAD_REQUEST', 400)
    const value = Number(req.body?.value)
    if (!Number.isFinite(value) || value < 0) return error(res, '参数值非法', 'BAD_REQUEST', 400)
    const operator = (req as any).user?.username || 'system'
    const before = db.prepare('SELECT value, source, confidence, remark FROM ihc_cost_params WHERE param_key = ?').get(key) as
      | { value: number; source: string | null; confidence: string | null; remark: string | null }
      | undefined
    const source = req.body?.source != null ? String(req.body.source) : '手工'
    // 持久化 confidence/remark（此前被丢弃 → 手工校准后置信永远卡在初始值的 bug）；未给则沿用旧值
    let confidence = req.body?.confidence != null ? String(req.body.confidence) : before?.confidence ?? null
    let remark = req.body?.remark != null ? String(req.body.remark) : before?.remark ?? null
    // 诚实透出不变式（B4）之一：手工 PUT 不得冒用「实测/校准」来源标签——那是 calibrate 专属，
    //   否则 /cost-params 会显示成像被真实数据校准过（哪怕置信仍是粗估，来源标签本身就误导）。
    if (req.body?.source != null && (String(req.body.source).includes('实测') || String(req.body.source).includes('校准'))) {
      return error(res, '「实测/校准」来源标签只能经 POST /cost-params/calibrate 写入；手工调整请用其他来源标注', 'BAD_REQUEST', 400)
    }
    // 之二：手工 PUT 不得把参数写成「读起来像已校准」——「已校准」态只能经 calibrate 写回（附真实数据 + before/after 留痕）。
    //   把写门禁直接绑到读判定 isParamCalibrated，确保「能读成已校准」的状态只有一条合法来路。
    if (isParamCalibrated({ source, confidence })) {
      if (req.body?.confidence != null || req.body?.source != null) {
        return error(res, '「已校准」等校准态只能经 POST /cost-params/calibrate 写回（附真实数据+留痕）；手工调整请用非校准置信（如 粗估/手工核定）', 'BAD_REQUEST', 400)
      }
      // 未显式给 source/confidence、但继承到的旧值是校准态：手工改值即脱离校准 → 如实降级留痕，不再冒充精确
      confidence = '手工核定'
      if (req.body?.remark == null) remark = '手工改值·已脱离校准（原校准值被覆盖）'
    }
    if (before) {
      db.prepare('UPDATE ihc_cost_params SET value = ?, source = ?, confidence = ?, remark = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE param_key = ?')
        .run(value, source, confidence, remark, operator, key)
    } else {
      db.prepare('INSERT INTO ihc_cost_params (id, param_key, value, source, confidence, remark, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), key, value, source, confidence, remark, operator)
    }
    // 碰口径的写：abc_audit_logs 落 before/after 明细（全站 operation_logs 另由 auditWrite 自动落，不重复）
    writeAuditLog(db, 'antibody_cost', 'param_update', key, { key, before: before ?? null, after: { value, source, confidence, remark } }, operator)
    success(res, { key, value }, '参数已更新')
  } catch (err: any) {
    error(res, err.message)
  }
})

// POST /cost-params/calibrate —— B4 弱锚校准写回入口（写；碰成本口径）。
//   喂康湾真实（月人力/月折旧/月房租/月产片量）→ 摊算每片工时/设备 → 写回并翻牌「已校准」+ before/after 留痕。
//   真值待 PM 补，见 docs/COREONE-B4弱锚校准-需康湾数据清单-2026-07-02.md。
router.post('/cost-params/calibrate', requirePermission('antibody_cost', 'W'), (req, res) => {
  try {
    const db = getDatabase()
    const b = req.body ?? {}
    let derived
    try {
      derived = deriveLaborEquipmentPerSlide({
        monthlyTechnicianCost: Number(b.monthlyTechnicianCost),
        monthlyEquipmentDepreciation: Number(b.monthlyEquipmentDepreciation),
        monthlyFacilityCost: b.monthlyFacilityCost != null ? Number(b.monthlyFacilityCost) : 0,
        monthlySlideVolume: Number(b.monthlySlideVolume),
        facilityToLaborRatio: b.facilityToLaborRatio != null ? Number(b.facilityToLaborRatio) : undefined,
      })
    } catch (e: any) {
      return error(res, e.message || '校准输入非法', 'BAD_REQUEST', 400)
    }
    const operator = (req as any).user?.username || 'system'
    const before = {
      labor: db.prepare("SELECT value, source, confidence FROM ihc_cost_params WHERE param_key = 'labor_per_slide'").get() ?? null,
      equipment: db.prepare("SELECT value, source, confidence FROM ihc_cost_params WHERE param_key = 'equipment_per_slide'").get() ?? null,
    }
    const remark = `康湾实测校准 ${JSON.stringify(derived.inputs)}`
    const upsertCalibrated = (key: string, value: number) => {
      const exists = db.prepare('SELECT id FROM ihc_cost_params WHERE param_key = ?').get(key) as { id: string } | undefined
      if (exists) {
        db.prepare("UPDATE ihc_cost_params SET value = ?, source = '康湾实测校准', confidence = '已校准', remark = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE param_key = ?")
          .run(value, remark, operator, key)
      } else {
        db.prepare("INSERT INTO ihc_cost_params (id, param_key, value, source, confidence, remark, updated_by) VALUES (?, ?, ?, '康湾实测校准', '已校准', ?, ?)")
          .run(uuidv4(), key, value, remark, operator)
      }
    }
    // 事务包裹：两个参数 + 审计要么全落、要么全回滚——防止「工时已翻已校准、设备没翻」的半截口径状态。
    db.exec('BEGIN IMMEDIATE')
    try {
      upsertCalibrated('labor_per_slide', derived.laborPerSlide)
      upsertCalibrated('equipment_per_slide', derived.equipmentPerSlide)
      writeAuditLog(
        db,
        'antibody_cost',
        'calibrate',
        'labor_equipment', // 非 null 复合 targetId：校准事件可按 target 索引查
        { inputs: derived.inputs, method: derived.method, before, after: { laborPerSlide: derived.laborPerSlide, equipmentPerSlide: derived.equipmentPerSlide } },
        operator,
      )
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    success(res, { laborPerSlide: derived.laborPerSlide, equipmentPerSlide: derived.equipmentPerSlide, inputs: derived.inputs, method: derived.method }, '工时/设备参数已按真实数据校准')
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

export default router
