/**
 * LIS 病例（lis_cases）批量导入 + 列表 + 样本类型人工覆盖（W3）。
 * RBAC：读 reconciliation R（挂载层）；写 reconciliation W（技术员可录入，与对账同域）。
 *
 * 增量纠错架构：
 *  - 原始事实层：6 数量列 + partner，幂等 upsert（重传覆盖）。
 *  - 派生推断：specimen_type 导入自动判(source=auto)；人工覆盖 → source=manual，重传**不覆盖** manual；改动留痕 reconciliation_logs。
 */
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { findOrCreatePartner } from '../utils/partner-upsert.js'
import { normalizeLisRow, isValidLisRow } from '../utils/lis-import.js'

const router = Router()
const requireWrite = requirePermission('reconciliation', 'W')
const SPECIMEN_TYPES = ['tissue', 'tissue_complex', 'cytology']

/** POST /import —— 批量导入 LIS 病例（含医院 upsert + 数量 + 自动样本判定） */
router.post('/import', authenticateToken, requireWrite, (req, res) => {
  try {
    const db = getDatabase()
    const { cases } = req.body as { cases: Record<string, unknown>[] }
    if (!Array.isArray(cases) || cases.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }

    const importBatch = `LIS-${Date.now()}`
    const operator = (req as any).user?.id || null
    const partnerCache = new Map<string, string>() // name -> partner_id
    let partnersCreated = 0

    const upsert = db.prepare(`
      INSERT INTO lis_cases
        (id, case_no, partner_id, status, operate_time, import_batch,
         he_slide_count, block_count, ihc_count, special_stain_count, eber_count, pdl1_count,
         specimen_type, specimen_type_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')
      ON CONFLICT(case_no) DO UPDATE SET
        partner_id = excluded.partner_id,
        status = excluded.status,
        operate_time = excluded.operate_time,
        he_slide_count = excluded.he_slide_count,
        block_count = excluded.block_count,
        ihc_count = excluded.ihc_count,
        special_stain_count = excluded.special_stain_count,
        eber_count = excluded.eber_count,
        pdl1_count = excluded.pdl1_count,
        specimen_type = CASE WHEN specimen_type_source = 'manual' THEN specimen_type ELSE excluded.specimen_type END,
        specimen_type_source = CASE WHEN specimen_type_source = 'manual' THEN 'manual' ELSE 'auto' END
    `)

    let imported = 0
    let skipped = 0
    for (const row of cases) {
      const c = normalizeLisRow(row)
      if (!isValidLisRow(c)) { skipped++; continue }
      // 医院 upsert（缓存避免重复查）
      let partnerId = partnerCache.get(c.partnerName)
      if (!partnerId) {
        const ref = findOrCreatePartner(db, c.partnerName, uuidv4, { createdBy: operator })
        partnerId = ref.id
        partnerCache.set(c.partnerName, partnerId)
        if (ref.created) partnersCreated++
      }
      upsert.run(
        `LC-${uuidv4()}`, c.caseNo, partnerId, c.status || 'normal', c.operateTime || null, importBatch,
        c.heSlideCount, c.blockCount, c.ihcCount, c.specialStainCount, c.eberCount, c.pdl1Count,
        c.autoSpecimenType,
      )
      imported++
    }

    success(res, {
      importBatch,
      imported,
      skipped,
      partnersCreated,
      partnersMatched: partnerCache.size,
    }, `导入 ${imported} 例（${partnerCache.size} 家医院，新建 ${partnersCreated} 家）`)
  } catch (e: any) {
    error(res, e.message || '导入失败')
  }
})

/** POST /preview —— 干跑：解析 LIS 行，不落库，返回汇总 + 医院新建预判 + 样本分布（导入向导第1步） */
router.post('/preview', authenticateToken, requireWrite, (req, res) => {
  try {
    const db = getDatabase()
    const { cases } = req.body as { cases: Record<string, unknown>[] }
    if (!Array.isArray(cases) || cases.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }
    const partnerExists = db.prepare('SELECT 1 FROM partners WHERE name = ? AND is_deleted = 0')
    const hospitals = new Map<string, boolean>() // name -> existing
    const specimen = { tissue: 0, tissue_complex: 0, cytology: 0 }
    let valid = 0, skipped = 0
    for (const row of cases) {
      const c = normalizeLisRow(row)
      if (!isValidLisRow(c)) { skipped++; continue }
      valid++
      if (!hospitals.has(c.partnerName)) hospitals.set(c.partnerName, !!partnerExists.get(c.partnerName))
      specimen[c.autoSpecimenType]++
    }
    const newHospitals = [...hospitals.entries()].filter(([, ex]) => !ex).map(([n]) => n)
    success(res, {
      valid, skipped,
      hospitalCount: hospitals.size,
      newHospitals,
      specimenDistribution: specimen,
      warnings: [
        ...(skipped ? [`${skipped} 行缺病理号/医院将被跳过`] : []),
        ...(newHospitals.length ? [`将新建 ${newHospitals.length} 家医院（默认仅技术，service_scope 后续可在合作医院页设置）`] : []),
      ],
    }, '预览（未落库）')
  } catch (e: any) { error(res, e.message) }
})

/** GET / —— LIS 病例列表（含医院名 + 数量 + 样本类型），供核对/覆盖 */
router.get('/', authenticateToken, (req, res) => {
  try {
    let { page = 1, pageSize = 20, partnerId, keyword, specimenType } = req.query as any
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(200, Number(pageSize) || 20))
    const db = getDatabase()
    let where = '1=1'
    const params: any[] = []
    if (partnerId) { where += ' AND lc.partner_id = ?'; params.push(partnerId) }
    if (specimenType) { where += ' AND lc.specimen_type = ?'; params.push(specimenType) }
    if (keyword) { where += ' AND lc.case_no LIKE ?'; params.push(`%${keyword}%`) }

    const total = (db.prepare(`SELECT COUNT(*) AS t FROM lis_cases lc WHERE ${where}`).get(...params) as any)?.t || 0
    const offset = (page - 1) * pageSize
    const rows = db.prepare(`
      SELECT lc.*, p.name AS partner_name FROM lis_cases lc
      LEFT JOIN partners p ON p.id = lc.partner_id
      WHERE ${where} ORDER BY lc.case_no DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[]

    successList(res, rows.map((r) => ({
      id: r.id, caseNo: r.case_no, partnerId: r.partner_id, partnerName: r.partner_name,
      specimenType: r.specimen_type, specimenTypeSource: r.specimen_type_source,
      quantities: { heSlide: r.he_slide_count, block: r.block_count, ihc: r.ihc_count, specialStain: r.special_stain_count, eber: r.eber_count, pdl1: r.pdl1_count },
      status: r.status,
    })), page, pageSize, total)
  } catch (e: any) { error(res, e.message) }
})

/** PUT /:caseNo/specimen-type —— 人工覆盖样本类型（manual 永远赢 + 留痕） */
router.put('/:caseNo/specimen-type', authenticateToken, requireWrite, (req, res) => {
  try {
    const { caseNo } = req.params
    const { specimenType } = req.body
    if (!SPECIMEN_TYPES.includes(specimenType)) { error(res, 'specimenType 非法', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const existing = db.prepare('SELECT specimen_type FROM lis_cases WHERE case_no = ?').get(caseNo) as { specimen_type: string } | undefined
    if (!existing) { error(res, '病例不存在', 'NOT_FOUND', 404); return }
    db.prepare(`UPDATE lis_cases SET specimen_type = ?, specimen_type_source = 'manual' WHERE case_no = ?`).run(specimenType, caseNo)
    // 留痕
    db.prepare(`INSERT INTO reconciliation_logs (id, type, target_id, target_name, field, old_value, new_value, reason, operator)
                VALUES (?, 'specimen_type_override', ?, ?, 'specimen_type', ?, ?, ?, ?)`)
      .run(uuidv4(), caseNo, caseNo, existing.specimen_type || null, specimenType, '人工覆盖样本类型', (req as any).user?.id || null)
    success(res, { caseNo, specimenType, source: 'manual' }, '已覆盖样本类型')
  } catch (e: any) { error(res, e.message) }
})

export default router
