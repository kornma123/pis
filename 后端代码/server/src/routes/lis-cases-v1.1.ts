/**
 * LIS 病例（lis_cases）批量导入 + 列表 + 样本类型人工覆盖（W3）。
 * RBAC：读 reconciliation R（挂载层）。写分两档：
 *  - 导入/预览（/import、/preview）= 口径与工作量数据源输入 → requireAnyRole('admin','finance')
 *    （与前端「LIS 病例导入」页管理员+财务一致；口径同 ngs-v1.1 收窄，不放开给技术员/主任）。
 *  - 样本类型人工覆盖（PUT /:caseNo/specimen-type）= 单例技术更正、留痕 → reconciliation W（技术员可录入）。
 *
 * 增量纠错架构：
 *  - 原始事实层：6 数量列 + partner，幂等 upsert（同月重传覆盖；跨月同号硬拒——「病理号唯一」执法闸，#163 阶段1；阶段2=读侧收入占比配月，无 schema 变更）。
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
import { canonicalCaseNo } from '../utils/classifier.js' // 读侧按 case_no 精确查库须与落库同一 canonical（否则全角/异体横线号 raw 输入查不到已归一的库行）
import { backfillAbcPartnerIds } from '../utils/abc-partner-link.js'

const router = Router()
const requireWrite = requirePermission('reconciliation', 'W') // 样本类型覆盖（技术员可录入）
const requireImport = requireAnyRole('admin', 'finance') // 导入/预览=口径数据源输入，收窄到管理员+财务
const SPECIMEN_TYPES = ['tissue', 'tissue_complex', 'cytology']

// 单次导入行数上限。node:sqlite 是同步接口：/import 在单个 BEGIN IMMEDIATE 事务里逐行
// INSERT、每行还做医院 upsert，/preview 也逐行同步查库 —— 行数过大会长时间阻塞整个 Node
// 事件循环，令登录/库存等所有请求一起挂起（误传一个几万行文件即可触发）。超限即拒、提示分批。
const MAX_LIS_IMPORT_ROWS = 1000

// —— #163 阶段1：跨月同号导入硬拒（「病理号唯一」业务规则的写端执法闸）——
// PM 2026-07-13 拍板：同一病理号唯一、可跨结算月、不可能两人共号 → 身份键 (partner_id, case_no)
// 维持不变（「键加月/方案A」整体退役、无 schema 变更、无迁移）。据此本闸语义转正：同院同号但登记
// 月冲突 = 数据更正或上游错误，硬拒＋回执待人工，绝不静默改写早月原始事实行（数量标量覆盖不可逆）。
// 阶段2（待 #168 合并后开）= 读侧按各结算月收入占比分摊单份物料成本（Q2'=A）+ 读侧
// loadCrossMonthReuseKeys 收窄为异常兜底 + #151 探针「跨月复用即禁出」不变量重定义；同样无 schema、无迁移。
const CROSS_MONTH_SAMPLE_LIMIT = 50 // 回执样例上限，与 /import-markers 的 unmatchedCases 同款
const VALID_YM = /^\d{4}-(0[1-9]|1[0-2])$/ // 合法 'YYYY-MM'（月补零 01–12），与下游 service_month 形态一致

/** 结构化提取 {年, 月(1–12), 日?}（**宽松·不锚定结尾**，只喂 existing 侧 monthOf 读历史脏行派生月），失败回 null。 */
function parseYmd(dateish: unknown): { y: string; mo: number; d?: string } | null {
  if (dateish == null || dateish === '') return null
  const m = /^\s*(\d{4})[-/](\d{1,2})(?!\d)(?:[-/](\d{1,2})(?!\d))?/.exec(String(dateish))
  if (!m) return null
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  return { y: m[1], mo, d: m[3] }
}

/**
 * incoming 侧**严格**校验（codex 三/四次复核 · 与 existing 宽松策略分离）：operateTime 必须是**日历上真实存在**的
 * 日期串——`YYYY[-/]M[-/]D`（日按月大小 + 闰年校验，如 2026-02-31 / 2025-02-29 / 2026-04-31 一律拒）或纯
 * `YYYY[-/]M`，可带空格/T 引导的 `HH:MM[:SS]` 时间尾部（时 0–23 / 分秒 0–59，`Tfoo`/`99:99:99` 一律拒）；否则
 * `valid=false`（调用方拒收进回执、不 upsert）。防「合法年月前缀 + 垃圾尾部/越界日/日历不存在日/非法时间」被当成
 * 同月放行、静默覆盖有效登记日与数量。归一日期段到补零 canonical、**保留合法时间尾部并补零时分秒**（MEDIUM：
 * operate_time 在详情页作「登记时间」展示，不得丢时分）。existing 侧不用它（仍走宽松 monthOf 保护历史脏行）。
 */
function parseStrictDate(dateish: string): { valid: true; canonical: string } | { valid: false } {
  const m = /^\s*(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?(?:([ T])(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(dateish)
  if (!m) return { valid: false }
  const year = Number(m[1]), mo = Number(m[2])
  if (mo < 1 || mo > 12) return { valid: false }
  const ym = `${m[1]}-${String(mo).padStart(2, '0')}`
  if (m[3] === undefined) return m[4] === undefined ? { valid: true, canonical: ym } : { valid: false } // 纯年月不许带时间
  const d = Number(m[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
  if (d < 1 || d > daysInMonth) return { valid: false } // 真实日历日（含闰年/月大小），拒 2026-02-31 之类
  const datePart = `${ym}-${String(d).padStart(2, '0')}`
  if (m[4] === undefined) return { valid: true, canonical: datePart } // 无时间尾部
  const hh = Number(m[5]), mi = Number(m[6]), ss = m[7] === undefined ? undefined : Number(m[7])
  if (hh > 23 || mi > 59 || (ss !== undefined && ss > 59)) return { valid: false } // 时分秒范围
  const hms = `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}${ss !== undefined ? ':' + String(ss).padStart(2, '0') : ''}`
  return { valid: true, canonical: `${datePart}${m[4]}${hms}` } // 保留原分隔符（空格/T）+ 补零时分秒
}

/**
 * **existing 侧**月锚宽松归一（供 monthOf 读库行/历史脏行派生月；**非 incoming 落库路径**——incoming 走
 * parseStrictDate 严格校验+补零）：把「下游 substr(前7位) 认不出月、但结构化能解析」的斜杠非补零形态
 * （'2026/5/9' → 下游 slice 得 '2026-5-'）补零，使 monthOf 能锚定历史非补零脏行、保护其不被跨月覆盖。
 * **下游已能认出月的形态一律原样保留**（'2026/05/20'/'2026-05-10'/带时间戳、日非法 '2026-05-99'——它们
 * replace('/','-').slice(0,7) 已是合法 YYYY-MM）。仅供月派生，返回值只需月正确（不追求日/时间保真）；乱码等
 * 结构化也解析不了的原样保留（下游同盲）。空/NULL 保留。
 */
function canonicalOperateTime(dateish: string | null): string | null {
  if (dateish == null || dateish === '') return dateish
  if (VALID_YM.test(dateish.replace(/\//g, '-').slice(0, 7))) return dateish // 下游 substr 已能认出月 → 原样（含日/时间）
  const p = parseYmd(dateish)
  if (!p) return dateish // 下游认不出且结构化也解析不了（乱码/'2026-13'）→ 原样，下游同盲
  const ym = `${p.y}-${String(p.mo).padStart(2, '0')}`
  return p.d === undefined ? ym : `${ym}-${String(Number(p.d)).padStart(2, '0')}` // 斜杠非补零 → 补零 canonical
}

/**
 * operate_time → 'YYYY-MM'。先 canonicalOperateTime 归一，再 replace('/','-').slice(0,7)——与下游**结算/对账
 * substr 读者族**（reconcile-compute / statement-import / import-gates；substr 与 replace 两种可交换书写、结果
 * 恒等）等价，保证守卫月判定恒 ⊇ 该族可见性（不再有「monthOf 结构化比 slice 聪明」的背离：'2026-059' 两侧都
 * 得 '2026-05'、'2026/5/9' 归一后两侧都得 '2026-05'）。注：reconciliation-v1.1 的字典序区间读者是另一口径（非
 * slash-tolerant），本不变量不覆盖它，但落库归一对它只改善不回归（project_id 分支、与本守卫正交）。不可解析回 ''。
 */
function monthOf(dateish: unknown): string {
  const canon = canonicalOperateTime(dateish == null ? null : String(dateish))
  const head = String(canon ?? '').replace(/\//g, '-').slice(0, 7)
  return VALID_YM.test(head) ? head : ''
}

/** POST /import —— 批量导入 LIS 病例（含医院 upsert + 数量 + 自动样本判定；跨月同号硬拒 #163 阶段1） */
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

    const existsStmt = db.prepare('SELECT operate_time FROM lis_cases WHERE partner_id = ? AND case_no = ?')
    let imported = 0, inserted = 0, updated = 0 // imported=inserted+updated；补传时拆开报，让人知道更新了多少、新增了多少
    let skipped = 0
    let rejectedCrossMonth = 0 // #163 阶段1：同 (partner_id, case_no) 但派生月冲突 → 硬拒不覆盖
    const rejectedCrossMonthSamples: Array<{ caseNo: string; partnerName: string; existingMonth: string; incomingMonth: string }> = []
    let rejectedInvalidDate = 0 // incoming 登记时间畸形（垃圾尾部/日越界/日历不存在日/非法时间）→ 拒收不 upsert（防静默覆盖有效登记日·codex 三/四次复核）
    const rejectedInvalidDateSamples: Array<{ caseNo: string; partnerName: string; value: string }> = []
    // 整批事务：任一行 SQL 失败则整体回滚，避免半批落库；拒收/跳行是正常分支、不触发回滚（回执分项计数）
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of cases) {
        const c = normalizeLisRow(row)
        if (!isValidLisRow(c)) { skipped++; continue }
        // incoming 严格校验（codex 三/四次复核 · existing 宽松/incoming 严格分离）：登记时间非空但畸形
        // （'2026/5/foo' 垃圾尾部 / '2026-05-99' 日越界 / '2026-02-31' 日历不存在 / '99:99:99' 非法时间）→
        // 拒收、不 upsert，进回执。防它被当同月放行、把有效登记日与数量静默覆盖。空登记时间视为「无日期」放行
        // （补日期修复通道，canonicalOp=null）。**在建院前校验**（codex 四次 MEDIUM）：非法日期行不建医院、不污染
        // partnersCreated/partnersMatched 计数，回执「未落库」才完整。
        const opRaw = c.operateTime || ''
        let canonicalOp: string | null = null
        if (opRaw !== '') {
          const strict = parseStrictDate(opRaw)
          if (!strict.valid) {
            rejectedInvalidDate++
            if (rejectedInvalidDateSamples.length < CROSS_MONTH_SAMPLE_LIMIT) {
              rejectedInvalidDateSamples.push({ caseNo: c.caseNo, partnerName: c.partnerName, value: opRaw })
            }
            continue
          }
          canonicalOp = strict.canonical // 已补零、保留时间尾部
        }
        // 医院 upsert（缓存避免重复查）
        let partnerId = partnerCache.get(c.partnerName)
        if (!partnerId) {
          const ref = findOrCreatePartner(db, c.partnerName, uuidv4, { createdBy: operator })
          partnerId = ref.id
          partnerCache.set(c.partnerName, partnerId)
          if (ref.created) partnersCreated++
        }
        const existingRow = existsStmt.get(partnerId, c.caseNo) as { operate_time: string | null } | undefined // upsert 前查存在性 → 拆新增/更新
        // #163 阶段1硬拒：库行已有可解析月锚时，只放行「同月重传」（可重传语义不变）。导入月不同 → 拒（跨月
        // 覆盖 = 不可逆销毁早月事实行）；导入月不可解析('') 也拒（放行会把 operate_time 覆盖成空 = 抹掉月锚）。
        // 库行无月锚('') 不拦：给旧无日期行留补日期的修复通道。existing 侧 monthOf 先宽松归一再取前7位 → 与
        // 下游结算/对账 substr 读者族等价，且能锚定历史非补零脏行（'2026/5/9'）保护其不被跨月覆盖。incoming 侧
        // canonicalOp 已经 parseStrictDate 严格校验+补零，落库后下游按月核对必命中（不再从月度消失）。
        if (existingRow) {
          const existingMonth = monthOf(existingRow.operate_time)
          const incomingMonth = monthOf(canonicalOp)
          if (existingMonth !== '' && incomingMonth !== existingMonth) {
            rejectedCrossMonth++
            if (rejectedCrossMonthSamples.length < CROSS_MONTH_SAMPLE_LIMIT) {
              rejectedCrossMonthSamples.push({ caseNo: c.caseNo, partnerName: c.partnerName, existingMonth, incomingMonth })
            }
            continue
          }
        }
        upsert.run(
          `LC-${uuidv4()}`, c.caseNo, partnerId, operator, c.status || 'normal', canonicalOp, importBatch,
          c.heSlideCount, c.blockCount, c.ihcCount, c.specialStainCount, c.eberCount, c.pdl1Count,
          c.autoSpecimenType,
        )
        imported++
        if (existingRow) updated++; else inserted++
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
      rejectedCrossMonth,
      rejectedCrossMonthSamples,
      rejectedInvalidDate,
      rejectedInvalidDateSamples,
      partnersCreated,
      partnersMatched: partnerCache.size,
    }, `导入 ${imported} 例（新增 ${inserted}·更新 ${updated}，${partnerCache.size} 家医院，新建 ${partnersCreated} 家）`
      + `${rejectedCrossMonth ? `；${rejectedCrossMonth} 例与库中既有病例同号但登记月份不一致（同号跨月冲突），已拒收、未覆盖原数据` : ''}`
      + `${rejectedInvalidDate ? `；${rejectedInvalidDate} 例登记时间格式非法（无法解析），已拒收、未落库` : ''}`)
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
    let invalidDate = 0 // 与 /import 同口径（codex 四次 MEDIUM）：登记时间非法的行预览即计非法，不计 valid、不列 newHospitals
    for (const row of cases) {
      const c = normalizeLisRow(row)
      if (!isValidLisRow(c)) { skipped++; continue }
      const opRaw = c.operateTime || ''
      if (opRaw !== '' && !parseStrictDate(opRaw).valid) { invalidDate++; continue } // 与 /import 严格校验同源
      valid++
      if (!hospitals.has(c.partnerName)) hospitals.set(c.partnerName, !!partnerExists.get(c.partnerName))
      specimen[c.autoSpecimenType]++
    }
    const newHospitals = [...hospitals.entries()].filter(([, ex]) => !ex).map(([n]) => n)
    success(res, {
      valid, skipped, invalidDate,
      hospitalCount: hospitals.size,
      newHospitals,
      specimenDistribution: specimen,
      warnings: [
        ...(skipped ? [`${skipped} 行缺病理号/医院将被跳过`] : []),
        ...(invalidDate ? [`${invalidDate} 行登记时间格式非法，将被拒收（不落库、不新建医院）`] : []),
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
      status: r.status, operateTime: r.operate_time, importBatch: r.import_batch,
    })), page, pageSize, total)
  } catch (e: any) { error(res, e.message) }
})

/** PUT /:caseNo/specimen-type —— 人工覆盖样本类型（manual 永远赢 + 留痕） */
router.put('/:caseNo/specimen-type', authenticateToken, requireWrite, (req, res) => {
  try {
    // 归一 URL 传入的病理号，与 lis_cases.case_no 落库侧同一 canonical（否则 raw 全角/异体横线号精确查不到已归一行 → 误 404）。
    const caseNo = canonicalCaseNo(req.params.caseNo)
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
 * ⚠️ #163 阶段1已知残留：抗体清单源表无任何日期列 → 本端点无法为导入行派生月，跨月同号的
 *   整例删插在此层不可检测（晚月清单会覆盖早月抗体行）。勿在无月信号下猜月（属新记账约定，
 *   按「约定不下沉」须 PM 拍板）。/import 回执的冲突号仅对直接读 JSON 的调用方可见——现行导入
 *   向导不显示拒收、且同一次点击内自动连导抗体清单（L1 面板 CONFIRMED），故此残留在 UI 主流程
 *   当前无有效缓解；收口 = 前端展示拒收并按被拒号过滤 markers（#163 comment 已登记遗留跟进）。
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

/** GET /markers?partnerId&caseNo —— 某例的抗体清单（详情页"本例抗体"块）。真抗体在前，白片/深切随后。 */
router.get('/markers', authenticateToken, (req, res) => {
  try {
    const db = getDatabase()
    const partnerId = String(req.query.partnerId || '')
    const caseNo = canonicalCaseNo(req.query.caseNo) // 与 lis_case_markers.case_no 落库侧同一 canonical（raw 全角/异体横线号否则查不到）
    if (!caseNo) { error(res, '缺 caseNo', 'BAD_REQUEST', 400); return }
    const where = partnerId ? 'partner_id = ? AND case_no = ?' : 'case_no = ?'
    const params = partnerId ? [partnerId, caseNo] : [caseNo]
    const rows = db.prepare(`SELECT marker_name, advice_type, wax_no, section_no FROM lis_case_markers WHERE ${where} ORDER BY section_no`).all(...params) as any[]
    // adviceType 归类：真抗体(Y000001/Y000003) / 白片(Y000007) / HE深切重切(Y000006) / 其他
    const kind = (t: string): string => t === 'Y000007' ? 'white' : t === 'Y000006' ? 'recut' : (t === 'Y000001' || t === 'Y000003') ? 'antibody' : 'other'
    success(res, rows.map((r) => ({ markerName: r.marker_name, adviceType: r.advice_type, kind: kind(String(r.advice_type || '')), waxNo: r.wax_no, sectionNo: r.section_no })))
  } catch (e: any) { error(res, e.message) }
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
