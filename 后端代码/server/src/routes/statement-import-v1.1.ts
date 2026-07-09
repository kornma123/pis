/**
 * 对账单导入 API（配置驱动导入器 P4）—— 测试台 & 月度向导共用。
 * RBAC：requireAnyRole('finance')（财务 + 管理员）。
 *
 * POST /preview        干跑：网格 → 解析(逐院 config) → 分类 → 评分 → 返回预览（**不落库**）。
 * POST /classify-rule  把某行归类写回**该院** config.lines（加识别词/新建线含 scope）→ 立即生效。
 *
 * ⏭️ POST /commit（落库 case_revenue + 回填 + 重算）与 P5 partner-pnl 收入侧持久化模型一并实现（同 sub-PR）。
 */
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireAnyRole } from '../middleware/permissions.js'
import { assertCaliberChangeAllowed } from '../middleware/authz-combinators.js'
import { loadConfig, peekConfig, saveConfig, normalizeConfig, caliberSignature, type PartnerConfigLine } from '../utils/partner-config.js'
import { parseStatement, type Grid, type ColMap } from '../utils/statement-parser/index.js'
import { computeStatementRevenue, type ClassifiedRow } from '../utils/statement-revenue.js'
import { canonicalCaseNo } from '../utils/classifier.js' // codex MEDIUM-3：落库分组用 NFKC 规范化病理号
import { scoreStatement } from '../utils/import-score.js'
import { backfillAbcPartnerIds } from '../utils/abc-partner-link.js'
import { buildImportAnchorReasons } from '../utils/import-gates.js'
import { recordOverride } from '../utils/override-log.js'

const router = Router()
const requireImport = requireAnyRole('finance')
const genId = (): string => `PC-${uuidv4()}`
const userId = (req: any): string | undefined => req.user?.userId // auth 挂载 userId 非 id（配置 changedBy 防恒 NULL）
// 拆分/诊断口径 = 领域决策，仅 admin 可改（财务只配 in/out + 扣率 + 识别词）——
// 口径门禁经具名守卫 assertCaliberChangeAllowed 表达（roles-aware isAdmin 在组合子内部，路由层不再裸读 req.user.role）。
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000
const fin = (n: number | undefined): number => (Number.isFinite(n) ? (n as number) : 0)

function partnerExists(db: any, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM partners WHERE id = ? AND is_deleted = 0').get(id)
}

/**
 * LIS 蜡块工作量（按病理号）：scope=split 且 splitWorkload='lis_blk' 的组织制片线，用 LIS 真蜡块拆分（对账单 × LIS join）。
 * 唯一键 (partner_id, case_no) → 每院每号一行。缺 LIS 的病理号 → computeStatementRevenue 内部降级账单数量。
 * 默认模板无 split 线 → 传了也不被读取（零回归）。
 */
function loadLisWorkload(db: any, partnerId: string): Map<string, { blk: number }> {
  const rows = db.prepare('SELECT case_no, block_count FROM lis_cases WHERE partner_id = ?').all(partnerId) as any[]
  const m = new Map<string, { blk: number }>()
  for (const r of rows) m.set(String(r.case_no), { blk: Number(r.block_count) || 0 })
  return m
}

/**
 * GET /lis-coverage?partnerId&month —— 向导预检：导对账单之前先看该院 LIS 覆盖。
 * total=0 → 前端提示"先让管理员导 LIS，不导也能算（拆分按账单数量估，偏下限）"。正确顺序引导：先 LIS 后对账单。
 */
router.get('/lis-coverage', authenticateToken, requireImport, (req, res) => {
  try {
    const db = getDatabase()
    const partnerId = String(req.query.partnerId || '')
    const month = String(req.query.month || '')
    if (!partnerId || !partnerExists(db, partnerId)) { error(res, '医院不存在', 'NOT_FOUND', 404); return }
    const agg = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN block_count > 0 THEN 1 ELSE 0 END) AS withBlocks FROM lis_cases WHERE partner_id = ?').get(partnerId) as any
    const inPeriod = month
      ? (db.prepare(`SELECT COUNT(*) AS n FROM lis_cases WHERE partner_id = ? AND replace(substr(COALESCE(operate_time, ''), 1, 7), '/', '-') = ?`).get(partnerId, month) as any).n
      : null
    success(res, { total: Number(agg?.total) || 0, withBlocks: Number(agg?.withBlocks) || 0, inPeriod: inPeriod == null ? null : Number(inPeriod) })
  } catch (e: any) { error(res, e.message) }
})

router.post('/preview', authenticateToken, requireImport, (req, res) => {
  try {
    const db = getDatabase()
    const { partnerId, grid, template, serviceMonth, goldenExpected } = req.body as any
    if (!partnerId || !Array.isArray(grid)) { error(res, '缺 partnerId 或 grid', 'BAD_REQUEST', 400); return }
    if (!partnerExists(db, partnerId)) { error(res, '医院不存在', 'NOT_FOUND', 404); return }

    const cfg = peekConfig(db, partnerId) // 只读：首访不 seed 写库（codex F4）
    const colMap = cfg.config.parse.colMap as Partial<ColMap>
    const parsed = parseStatement(grid as Grid, { template, colMap })

    // 汇总/利润表模板（无逐 case）→ 返回专用解析结果，不做逐行分类
    if (parsed.template === 'category_summary' || parsed.template === 'joint_venture') {
      success(res, { partnerId, configVersion: cfg.version, template: parsed.template, parsed, note: '该模板为类别汇总/共建利润表，按专用解析返回（逐 case 分类不适用）' }, '预览（未落库）')
      return
    }

    const rev = computeStatementRevenue(parsed.rows, cfg.config, { lisWorkload: loadLisWorkload(db, partnerId) })
    // 两把尺分开（口径修正）：正向存在性 = 该院【全量】LIS（与拆分 join 同尺——结算月≠登记月，按月过滤会漏配跨月登记病例）；
    // 反向缺口 = 【本期】LIS（按登记月过滤，缺口检查天然按期；未选账期则跳过）。
    const lisAllRows = db.prepare('SELECT case_no FROM lis_cases WHERE partner_id = ?').all(partnerId) as any[]
    const lisPeriodRows = (serviceMonth
      ? db.prepare(`SELECT case_no FROM lis_cases WHERE partner_id = ? AND replace(substr(COALESCE(operate_time, ''), 1, 7), '/', '-') = ?`).all(partnerId, serviceMonth)
      : []) as any[]
    const score = scoreStatement(rev, {
      declaredTotal: parsed.declaredTotal,
      lisAllCaseNos: lisAllRows.map((r) => r.case_no),
      lisInPeriodCaseNos: lisPeriodRows.map((r) => r.case_no),
      goldenExpected: Number.isFinite(Number(goldenExpected)) ? Number(goldenExpected) : undefined,
    })

    success(res, {
      partnerId, configVersion: cfg.version, template: parsed.template, serviceMonth: serviceMonth ?? null,
      declaredTotal: parsed.declaredTotal,
      revenue: {
        labRevenue: rev.labRevenue, diagnosisSettle: rev.diagnosisSettle, outSettle: rev.outSettle, unmatchedSettle: rev.unmatchedSettle,
        ambiguousSettle: rev.ambiguousSettle, totalSettle: rev.totalSettle, byLine: rev.byLine, counts: rev.counts,
        splitLisExpected: rev.splitLisExpected, splitLisMissing: rev.splitLisMissing,
      },
      score,
      // 待人工归类的行（未匹配/歧义）供测试台内联建规则
      needsAttention: rev.rows.filter((r) => r.status === 'unmatched' || r.status === 'ambiguous')
        .slice(0, 100).map((r) => ({ no: r.no, item: r.item, settle: r.settle, status: r.status })),
    }, '预览（未落库）')
  } catch (e: any) { error(res, e.message) }
})

/**
 * POST /commit —— 落库：解析(逐院 config) → 分类 → 逐 case 聚合 → 写 case_revenue（带 lab_revenue=Σ(IN结算) +
 * out_revenue + revenue_source='statement' + config_version + service_month）+ 逐行 case_revenue_lines（带 scope）
 * → 回填 abc partner_id。幂等（UNIQUE case_no+service_month upsert，整批事务）。
 * 仅支持逐 case 模板（line_item 家族）；类别汇总/共建利润表用专用流程。无病理号的行（外送）跳过并计数。
 */
router.post('/commit', authenticateToken, requireImport, (req, res) => {
  try {
    const db = getDatabase()
    const { partnerId, grid, serviceMonth, template, docNo, confirm } = req.body as any
    if (!partnerId || !Array.isArray(grid)) { error(res, '缺 partnerId 或 grid', 'BAD_REQUEST', 400); return }
    if (!serviceMonth || !/^\d{4}-\d{2}$/.test(String(serviceMonth))) { error(res, 'serviceMonth 必填（格式 YYYY-MM）', 'BAD_REQUEST', 400); return }
    const partner = db.prepare('SELECT id, name FROM partners WHERE id = ? AND is_deleted = 0').get(partnerId) as any
    if (!partner) { error(res, '医院不存在', 'NOT_FOUND', 404); return }

    const cfg = loadConfig(db, partnerId, genId)
    const parsed = parseStatement(grid as Grid, { template, colMap: cfg.config.parse.colMap as Partial<ColMap> })
    if (parsed.template === 'category_summary' || parsed.template === 'joint_venture') {
      error(res, '类别汇总/共建利润表模板暂不支持逐 case 落库（用专用流程）', 'UNSUPPORTED', 400); return
    }
    const rev = computeStatementRevenue(parsed.rows, cfg.config, { lisWorkload: loadLisWorkload(db, partnerId) })

    // codex F5（+verify H1/H2）：未匹配/歧义 或 对账不平 或【无独立合计行无法核对闭合】→ 需财务显式 confirm===true 才落库。
    const confirmed = confirm === true // 严格布尔：'false'/'0'/1 等一律不算确认（H1）
    const closureVerifiable = parsed.declaredTotal != null
    const closureDiff = closureVerifiable ? round2(rev.totalSettle - (parsed.declaredTotal as number)) : null
    const closureOk = closureVerifiable && Math.abs(closureDiff as number) <= 0.01 // 无合计行 → 不可核对 → 非 OK（H2）
    const unclassified = rev.counts.unmatched + rev.counts.ambiguous
    // 项B：把两个不依赖当期口径的独立软锚（在范围份额中位数 + 台账期间键）并入同一 NEEDS_CONFIRM。
    //   —— 闭合闸是自指的（totalSettle vs declaredTotal 同源），抓不住「拆分口径本身被改坏、平账落库」；
    //      独立锚 + 期间键补这道盲区。无历史锚/无台账命中时自动跳过（向后兼容，不误拦首次/新院）。
    // 与历史锚同口径：只用**可落库（有病理号）行**算当期 labShare——历史 net_amount 也只含有 case_no 的行
    //   （commit 跳过无病理号外送行）；否则外送占比高的院当期分母含外送、与锚不对称（对抗复核 B-分母）。
    const committable = rev.rows.filter((r: ClassifiedRow) => canonicalCaseNo(r.no))
    const caseNos = [...new Set(committable.map((r: ClassifiedRow) => canonicalCaseNo(r.no)) as string[])]
    const curLab = round2(committable.reduce((s, r) => s + fin(r.labPortion), 0))
    const curSettle = round2(committable.reduce((s, r) => s + fin(r.settle), 0))
    const anchorReasons = buildImportAnchorReasons(db, partnerId, String(serviceMonth), curLab, curSettle, caseNos)
    // 汇总本次触发的核对闸理由（无论是否 confirm）
    const gateReasons: string[] = []
    if (unclassified > 0) gateReasons.push(`未匹配 ${rev.counts.unmatched} 行 / 歧义 ${rev.counts.ambiguous} 行`)
    if (!closureOk) gateReasons.push(!closureVerifiable ? '对账单无独立合计行，无法核对闭合'
      : `逐行结算 ${rev.totalSettle} 与对账单合计 ${parsed.declaredTotal} 差 ${closureDiff}`)
    gateReasons.push(...anchorReasons)
    const overrideReason = String((req.body as any)?.overrideReason ?? '').trim()
    if (gateReasons.length > 0) {
      if (!confirmed) {
        error(res,
          `对账单未通过落库前核对，未确认不落库：${gateReasons.join('；')}。请先归类/核对，或重发带 confirm:true 显式确认。`,
          'NEEDS_CONFIRM', 409)
        return
      }
      // 项⑦ 统一旁路台账：confirm 强制越过核对闸 = 人工旁路 → **必须填 overrideReason** 留痕（防旁路无声搬家）。
      if (!overrideReason) {
        error(res,
          `确认落库越过了核对闸，必须在 overrideReason 填写旁路理由后重发：${gateReasons.join('；')}。`,
          'OVERRIDE_REASON_REQUIRED', 400)
        return
      }
    }

    // 逐病理号聚合（无病理号行跳过计数）
    const linesByCase = new Map<string, ClassifiedRow[]>()
    let skippedNoCase = 0
    for (const r of rev.rows) {
      const no = canonicalCaseNo(r.no)
      if (!no) { skippedNoCase++; continue }
      const arr = linesByCase.get(no) || []
      arr.push(r)
      linesByCase.set(no, arr)
    }
    if (linesByCase.size === 0) { error(res, '无可逐 case 落库的明细行（缺病理号）', 'BAD_REQUEST', 400); return }

    const importBatch = `STMT-${Date.now()}`
    // codex CRITICAL：唯一键含 partner_id，删插/冲突都按院隔离，防跨院同号同月串账。
    const upsert = db.prepare(`
      INSERT INTO case_revenue (id, case_no, partner_id, partner_name, doc_no, gross_amount, net_amount, lab_revenue, diagnosis_revenue, out_revenue, unallocated_amount, discount_rate, revenue_source, service_month, config_version, line_count, import_batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'statement', ?, ?, ?, ?)
      ON CONFLICT(partner_id, case_no, service_month) DO UPDATE SET
        partner_name = excluded.partner_name, doc_no = excluded.doc_no,
        gross_amount = excluded.gross_amount, net_amount = excluded.net_amount, lab_revenue = excluded.lab_revenue,
        diagnosis_revenue = excluded.diagnosis_revenue,
        out_revenue = excluded.out_revenue, unallocated_amount = excluded.unallocated_amount, discount_rate = excluded.discount_rate, revenue_source = 'statement',
        config_version = excluded.config_version, line_count = excluded.line_count, import_batch = excluded.import_batch, updated_at = CURRENT_TIMESTAMP
    `)
    const delLines = db.prepare('DELETE FROM case_revenue_lines WHERE partner_id = ? AND case_no = ? AND service_month = ?')
    const insLine = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, partner_name, seq, charge_item, gross_amount, discount_rate, net_amount, scope, service_month, import_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

    let labTotal = 0, diagTotal = 0, outTotal = 0, unallocTotal = 0, caseCount = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [no, lines] of linesByCase) {
        let gross = 0, net = 0, lab = 0, diag = 0, out = 0, unalloc = 0
        for (const r of lines) {
          gross = round2(gross + fin(r.bill)); net = round2(net + fin(r.settle))
          // in=labPortion(=settle) / split=分摊后的制片份额；diagnosis=diagPortion(=settle) / split=诊断份额；out=整条
          lab = round2(lab + fin(r.labPortion)); diag = round2(diag + fin(r.diagPortion))
          if (r.status === 'out') out = round2(out + fin(r.settle))
          // confirm 强制落库的 未匹配/歧义 行：settle 进 net 却无桶承接 → 显式落 unallocated，维持守恒 net=lab+diag+out+unalloc
          else if (r.status === 'unmatched' || r.status === 'ambiguous') unalloc = round2(unalloc + fin(r.settle))
        }
        const dr = gross > 0 ? round4(net / gross) : 0
        upsert.run(`CR-${uuidv4()}`, no, partnerId, partner.name, docNo || null, gross, net, lab, diag, out, unalloc, dr, serviceMonth, cfg.version, lines.length, importBatch)
        delLines.run(partnerId, no, serviceMonth)
        lines.forEach((r, i) => insLine.run(`CRL-${uuidv4()}`, no, partnerId, partner.name, i + 1, r.item, fin(r.bill), fin(r.rate), fin(r.settle), r.status, serviceMonth, importBatch))
        labTotal = round2(labTotal + lab); diagTotal = round2(diagTotal + diag); outTotal = round2(outTotal + out); unallocTotal = round2(unallocTotal + unalloc); caseCount++
      }
      backfillAbcPartnerIds(db)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }

    // 项⑦：confirm 强制越过了核对闸 → 落一条旁路台账（operator + overrideReason + 前后快照），供旁路频率体检。
    if (gateReasons.length > 0 && confirmed) {
      recordOverride(db, {
        gateType: 'import_confirm', module: 'statement_import', targetId: `${partnerId}:${serviceMonth}`,
        operator: (req as any).user?.username ?? (req as any).user?.userId ?? 'system',
        reason: overrideReason,
        before: { gateReasons },
        after: { caseCount, labRevenue: labTotal, serviceMonth },
      })
    }

    success(res, {
      partnerId, serviceMonth, configVersion: cfg.version, importBatch,
      caseCount, labRevenue: labTotal, diagnosisSettle: diagTotal, outSettle: outTotal, unallocatedSettle: unallocTotal,
      unmatchedSettle: rev.unmatchedSettle, ambiguousSettle: rev.ambiguousSettle, skippedNoCase,
      splitLisExpected: rev.splitLisExpected, splitLisMissing: rev.splitLisMissing,
    }, `已入库 ${caseCount} case·实验室收入 ¥${labTotal}（诊断桶 ¥${diagTotal}，移出 ¥${outTotal}，未匹配 ¥${rev.unmatchedSettle}）`)
  } catch (e: any) { error(res, e.message) }
})

router.post('/classify-rule', authenticateToken, requireImport, (req, res) => {
  try {
    const db = getDatabase()
    const { partnerId, lineKey, newLine, ruleType, value, expectedVersion } = req.body as any
    if (!partnerId || !value || !['prefix', 'keyword', 'remark'].includes(ruleType)) { error(res, '参数无效（需 partnerId / ruleType[prefix|keyword|remark] / value）', 'BAD_REQUEST', 400); return }
    if (!partnerExists(db, partnerId)) { error(res, '医院不存在', 'NOT_FOUND', 404); return }

    const cur = loadConfig(db, partnerId, genId)
    const config = JSON.parse(JSON.stringify(cur.config))
    const field: keyof Pick<PartnerConfigLine, 'prefixes' | 'keywords' | 'remarks'> =
      ruleType === 'prefix' ? 'prefixes' : ruleType === 'keyword' ? 'keywords' : 'remarks'

    let target: PartnerConfigLine | undefined
    if (lineKey) {
      target = config.lines.find((l: PartnerConfigLine) => l.key === lineKey)
      if (!target) { error(res, '业务线不存在', 'NOT_FOUND', 404); return }
    } else if (newLine && newLine.name) {
      // scope 支持四态：in(计入实验室) / out(移出) / split(制片拆) / diagnosis(诊断桶)。split 需 splitProcRate（normalizeConfig 校验>0）。
      const scope: PartnerConfigLine['scope'] = ['in', 'out', 'split', 'diagnosis'].includes(newLine.scope) ? newLine.scope : 'in'
      target = { key: `l-${uuidv4().slice(0, 8)}`, name: String(newLine.name), on: true, scope, prefixes: [], keywords: [], remarks: [] }
      if (scope === 'split') {
        target.splitProcRate = Number(newLine.splitProcRate)
        target.splitWorkload = newLine.splitWorkload === 'lis_blk' ? 'lis_blk' : 'qty'
      }
      config.lines.push(target)
    } else {
      error(res, '需指定 lineKey 或 newLine.name', 'BAD_REQUEST', 400); return
    }

    // 拆词加入（逗号/空格/顿号分隔，去重）
    const words = String(value).split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean)
    for (const w of words) if (!target[field].includes(w)) target[field].push(w)

    // PRD-0 T2 补漏：写回前严格归一（与 PUT 路由一致）。坏历史配置（含无法归一字段）经 row2config best-effort
    //   会整体回退原值（坏扣率/坏 line 未治理）→ 这里拒绝在坏配置上叠加新版本，不把坏值再次持久化。
    let normalized
    try { normalized = normalizeConfig(config) } catch (ve: any) { error(res, ve?.message || '配置格式无效', 'BAD_REQUEST', 400); return }

    // 拆分/诊断口径门禁：本次改动了 split/diagnosis 线（新建/改率/改识别词）→ 仅 admin 可写（财务只读拆分线）。
    if (!assertCaliberChangeAllowed(req, res, caliberSignature(normalized) !== caliberSignature(cur.config), '拆分/诊断口径仅管理员可改（国标费率与工艺拆分是口径决策，财务侧只读）')) return

    // codex MEDIUM-2：测试台基于某版预览归类时传 expectedVersion → 乐观锁防并发覆盖（配置页已改到更新版时 409，要求重新预览）。
    const r = saveConfig(db, partnerId, normalized, { changedBy: userId(req), tab: '业务分类', genId, expectedVersion })
    success(res, { partnerId, version: r.version, lineKey: target.key, scope: target.scope }, `已写入 ${partnerId} 配置（v${r.version}·业务分类），立即生效`)
  } catch (e: any) {
    if (/版本冲突/.test(e.message)) { error(res, e.message, 'CONFLICT', 409); return }
    error(res, e.message)
  }
})

export default router
