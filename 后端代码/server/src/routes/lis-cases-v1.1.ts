/**
 * LIS 病例（lis_cases）批量导入 + 列表 + 样本类型人工覆盖（W3）。
 * RBAC：读 reconciliation R（挂载层）。写分两档：
 *  - 导入/预览（/import、/preview）= 口径与工作量数据源输入 → requireAnyRole('admin','finance')
 *    （与前端「LIS 病例导入」页管理员+财务一致；口径同 ngs-v1.1 收窄，不放开给技术员/主任）。
 *  - 样本类型人工覆盖（PUT /:caseNo/specimen-type）= 单例技术更正、留痕 → reconciliation W（技术员可录入）。
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
import { requirePermission, requireAnyRole } from '../middleware/permissions.js'
import { findOrCreatePartner } from '../utils/partner-upsert.js'
import { normalizeLisRow, isValidLisRow, normalizeMarkerRow, isValidMarkerRow, type NormalizedMarker } from '../utils/lis-import.js'
import { backfillAbcPartnerIds } from '../utils/abc-partner-link.js'

const router = Router()
const requireWrite = requirePermission('reconciliation', 'W') // 样本类型覆盖（技术员可录入）
const requireImport = requireAnyRole('admin', 'finance') // 导入/预览=口径数据源输入，收窄到管理员+财务
const SPECIMEN_TYPES = ['tissue', 'tissue_complex', 'cytology']

// 单次导入行数上限。node:sqlite 是同步接口：/import 在单个 BEGIN IMMEDIATE 事务里逐行
// INSERT、每行还做医院 upsert，/preview 也逐行同步查库 —— 行数过大会长时间阻塞整个 Node
// 事件循环，令登录/库存等所有请求一起挂起（误传一个几万行文件即可触发）。超限即拒、提示分批。
const MAX_LIS_IMPORT_ROWS = 1000

/** POST /import —— 批量导入 LIS 病例（含医院 upsert + 数量 + 自动样本判定） */
router.post('/import', authenticateToken, requireImport, (req, res) => {
  try {
    const db = getDatabase()
    const { cases } = req.body as { cases: Record<string, unknown>[] }
    if (!Array.isArray(cases) || cases.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }
    if (cases.length > MAX_LIS_IMPORT_ROWS) { error(res, `单次导入最多支持 ${MAX_LIS_IMPORT_ROWS} 条，请分批导入`, 'INVALID_PARAMETER', 400); return }

    const importBatch = `LIS-${Date.now()}`
    const operator = (req as any).user?.userId || null // auth 挂载的是 userId，非 id（否则审计 operator 恒 NULL）
    const partnerCache = new Map<string, string>() // name -> partner_id
    let partnersCreated = 0

    const upsert = db.prepare(`
      INSERT INTO lis_cases
        (id, case_no, partner_id, operator, status, operate_time, import_batch,
         he_slide_count, block_count, ihc_count, special_stain_count, eber_count, pdl1_count,
         specimen_type, specimen_type_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')
      ON CONFLICT(partner_id, case_no) DO UPDATE SET
        operator = excluded.operator,
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

    const existsStmt = db.prepare('SELECT 1 FROM lis_cases WHERE partner_id = ? AND case_no = ?')
    let imported = 0, inserted = 0, updated = 0 // imported=inserted+updated；补传时拆开报，让人知道更新了多少、新增了多少
    let skipped = 0
    // 整批事务：任一行 SQL 失败则整体回滚，避免半批落库
    db.exec('BEGIN IMMEDIATE')
    try {
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
        const existed = !!existsStmt.get(partnerId, c.caseNo) // upsert 前查存在性 → 拆新增/更新
        upsert.run(
          `LC-${uuidv4()}`, c.caseNo, partnerId, operator, c.status || 'normal', c.operateTime || null, importBatch,
          c.heSlideCount, c.blockCount, c.ihcCount, c.specialStainCount, c.eberCount, c.pdl1Count,
          c.autoSpecimenType,
        )
        imported++
        if (existed) updated++; else inserted++
      }
      backfillAbcPartnerIds(db) // LIS 落库后顺带把成本维度回填到位，减少手动 /backfill 遗漏
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    success(res, {
      importBatch,
      imported,
      inserted,
      updated,
      skipped,
      partnersCreated,
      partnersMatched: partnerCache.size,
    }, `导入 ${imported} 例（新增 ${inserted}·更新 ${updated}，${partnerCache.size} 家医院，新建 ${partnersCreated} 家）`)
  } catch (e: any) {
    error(res, e.message || '导入失败')
  }
})

/** POST /preview —— 干跑：解析 LIS 行，不落库，返回汇总 + 医院新建预判 + 样本分布（导入向导第1步） */
router.post('/preview', authenticateToken, requireImport, (req, res) => {
  try {
    const db = getDatabase()
    const { cases } = req.body as { cases: Record<string, unknown>[] }
    if (!Array.isArray(cases) || cases.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }
    if (cases.length > MAX_LIS_IMPORT_ROWS) { error(res, `单次导入最多支持 ${MAX_LIS_IMPORT_ROWS} 条，请分批导入`, 'INVALID_PARAMETER', 400); return }
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
    const { specimenType, partnerId } = req.body as { specimenType?: string; partnerId?: string }
    const pid = partnerId || (req.query.partnerId as string | undefined)
    if (!SPECIMEN_TYPES.includes(specimenType as string)) { error(res, 'specimenType 非法', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    // 跨院同号（T1.3）：精确定位行。带 partnerId 优先；不带且 case_no 跨多院 → 歧义 400，不得随机选院串改。
    const rows = (pid
      ? db.prepare('SELECT id, partner_id, specimen_type FROM lis_cases WHERE case_no = ? AND partner_id = ?').all(caseNo, pid)
      : db.prepare('SELECT id, partner_id, specimen_type FROM lis_cases WHERE case_no = ?').all(caseNo)
    ) as Array<{ id: string; partner_id: string | null; specimen_type: string | null }>
    if (rows.length === 0) { error(res, '病例不存在', 'NOT_FOUND', 404); return }
    if (rows.length > 1) { error(res, '该病理号在多家医院存在，请指定 partnerId 以避免跨院串改', 'AMBIGUOUS_PARTNER', 400); return }
    const target = rows[0]
    // 覆盖 + 留痕同一事务：日志写失败则覆盖回滚，不留无审计的变更。按 id 精确更新，绝不波及他院同号行。
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`UPDATE lis_cases SET specimen_type = ?, specimen_type_source = 'manual' WHERE id = ?`).run(specimenType, target.id)
      db.prepare(`INSERT INTO reconciliation_logs (id, type, target_id, target_name, field, old_value, new_value, reason, operator)
                  VALUES (?, 'specimen_type_override', ?, ?, 'specimen_type', ?, ?, ?, ?)`)
        .run(uuidv4(), caseNo, caseNo, target.specimen_type || null, specimenType, '人工覆盖样本类型', (req as any).user?.userId || null)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    success(res, { caseNo, partnerId: target.partner_id, specimenType, source: 'manual' }, '已覆盖样本类型')
  } catch (e: any) { error(res, e.message) }
})

/**
 * POST /import-markers —— 导入抗体清单（0702免组类：每例每抗体一行）。
 * 该表无送检医院列 → 病理号 join lis_cases 定医院；查无 / 跨院撞号 → 认不出，单列不落。
 * 幂等：按 (partner_id, case_no) 整例删插（补传 = 该例抗体全量刷新，不残留旧行）。
 */
router.post('/import-markers', authenticateToken, requireImport, (req, res) => {
  try {
    const db = getDatabase()
    const { markers } = req.body as { markers: Record<string, unknown>[] }
    if (!Array.isArray(markers) || markers.length === 0) { error(res, '导入数据为空', 'BAD_REQUEST', 400); return }
    if (markers.length > MAX_LIS_IMPORT_ROWS) { error(res, `单次导入最多支持 ${MAX_LIS_IMPORT_ROWS} 条，请分批导入`, 'INVALID_PARAMETER', 400); return }

    const importBatch = `MK-${Date.now()}`
    // 病理号 → partner_id：唯一命中才用；0 命中=查无、>1=跨院撞号 → 都归"认不出"，不落。
    const partnerStmt = db.prepare('SELECT DISTINCT partner_id FROM lis_cases WHERE case_no = ?')
    const partnerCache = new Map<string, string | null>() // caseNo -> pid（null=认不出）
    const groups = new Map<string, { pid: string; caseNo: string; rows: NormalizedMarker[] }>()
    let skipped = 0
    const unmatchedCases = new Set<string>()
    for (const raw of markers) {
      const m = normalizeMarkerRow(raw)
      if (!isValidMarkerRow(m)) { skipped++; continue }
      let pid = partnerCache.get(m.caseNo)
      if (pid === undefined) {
        const rows = partnerStmt.all(m.caseNo) as Array<{ partner_id: string | null }>
        pid = rows.length === 1 && rows[0].partner_id ? rows[0].partner_id : null
        partnerCache.set(m.caseNo, pid)
      }
      if (!pid) { unmatchedCases.add(m.caseNo); continue }
      const gk = `${pid}::${m.caseNo}`
      const g = groups.get(gk) ?? { pid, caseNo: m.caseNo, rows: [] }
      g.rows.push(m)
      groups.set(gk, g)
    }

    const del = db.prepare('DELETE FROM lis_case_markers WHERE partner_id = ? AND case_no = ?')
    const ins = db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type, wax_no, section_no, import_batch)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    let imported = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const g of groups.values()) {
        del.run(g.pid, g.caseNo) // 整例刷新
        for (const m of g.rows) { ins.run(`MK-${uuidv4()}`, m.caseNo, g.pid, m.markerName, m.adviceType || null, m.waxNo || null, m.sectionNo || null, importBatch); imported++ }
      }
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }

    success(res, {
      importBatch, imported, skipped,
      casesAffected: groups.size,
      unmatched: unmatchedCases.size,
      unmatchedCases: [...unmatchedCases].slice(0, 50),
    }, `导入 ${imported} 条抗体（${groups.size} 例）${unmatchedCases.size ? `；${unmatchedCases.size} 例病理号在工作量表里查无、未落（先导工作量表）` : ''}`)
  } catch (e: any) { error(res, e.message || '导入失败') }
})

/** GET /batches?limit=3 —— 最近 N 次工作量导入批次（导入弹窗底部展示补传历史）。 */
router.get('/batches', authenticateToken, requireImport, (req, res) => {
  try {
    const db = getDatabase()
    const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 3))
    const rows = db.prepare(`
      SELECT lc.import_batch AS importBatch, COUNT(*) AS caseCount,
             COUNT(DISTINCT lc.partner_id) AS hospitalCount, MIN(lc.created_at) AS importedAt,
             MAX(u.real_name) AS operatorName
      FROM lis_cases lc LEFT JOIN users u ON u.id = lc.operator
      WHERE lc.import_batch IS NOT NULL
      GROUP BY lc.import_batch ORDER BY importedAt DESC LIMIT ?
    `).all(limit) as any[]
    success(res, rows.map((r) => ({
      importBatch: r.importBatch, caseCount: r.caseCount, hospitalCount: r.hospitalCount,
      importedAt: r.importedAt, operatorName: r.operatorName || null,
    })))
  } catch (e: any) { error(res, e.message) }
})

export default router
