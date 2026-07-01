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
import { loadConfig, peekConfig, saveConfig, normalizeConfig, type PartnerConfigLine } from '../utils/partner-config.js'
import { parseStatement, type Grid, type ColMap } from '../utils/statement-parser/index.js'
import { computeStatementRevenue, type ClassifiedRow } from '../utils/statement-revenue.js'
import { canonicalCaseNo } from '../utils/classifier.js' // codex MEDIUM-3：落库分组用 NFKC 规范化病理号
import { scoreStatement } from '../utils/import-score.js'
import { backfillAbcPartnerIds } from '../utils/abc-partner-link.js'

const router = Router()
const requireImport = requireAnyRole('finance')
const genId = (): string => `PC-${uuidv4()}`
const userId = (req: any): string | undefined => req.user?.id
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
    // codex verify-M1：传了 serviceMonth 就按 LIS 登记月过滤本期病例，否则全院（无日期 LIS 不计入本期 backward 缺口）
    const lisRows = (serviceMonth
      ? db.prepare(`SELECT case_no FROM lis_cases WHERE partner_id = ? AND replace(substr(COALESCE(operate_time, ''), 1, 7), '/', '-') = ?`).all(partnerId, serviceMonth)
      : db.prepare('SELECT case_no FROM lis_cases WHERE partner_id = ?').all(partnerId)) as any[]
    const lisCaseNos = lisRows.map((r) => r.case_no)
    const score = scoreStatement(rev, {
      declaredTotal: parsed.declaredTotal,
      lisCaseNos,
      goldenExpected: Number.isFinite(Number(goldenExpected)) ? Number(goldenExpected) : undefined,
    })

    success(res, {
      partnerId, configVersion: cfg.version, template: parsed.template, serviceMonth: serviceMonth ?? null,
      declaredTotal: parsed.declaredTotal,
      revenue: {
        labRevenue: rev.labRevenue, diagnosisSettle: rev.diagnosisSettle, outSettle: rev.outSettle, unmatchedSettle: rev.unmatchedSettle,
        ambiguousSettle: rev.ambiguousSettle, totalSettle: rev.totalSettle, byLine: rev.byLine, counts: rev.counts,
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
    if (!confirmed && (unclassified > 0 || !closureOk)) {
      const reason = !closureVerifiable ? '对账单无独立合计行，无法核对闭合'
        : closureOk ? '' : `逐行结算 ${rev.totalSettle} 与对账单合计 ${parsed.declaredTotal} 差 ${closureDiff}`
      error(res,
        `对账单未完全识别或未对平，未确认不落库：未匹配 ${rev.counts.unmatched} 行 / 歧义 ${rev.counts.ambiguous} 行${reason ? '，' + reason : ''}。请先归类/核对，或重发带 confirm:true 显式确认。`,
        'NEEDS_CONFIRM', 409)
      return
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
      INSERT INTO case_revenue (id, case_no, partner_id, partner_name, doc_no, gross_amount, net_amount, lab_revenue, diagnosis_revenue, out_revenue, discount_rate, revenue_source, service_month, config_version, line_count, import_batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'statement', ?, ?, ?, ?)
      ON CONFLICT(partner_id, case_no, service_month) DO UPDATE SET
        partner_name = excluded.partner_name, doc_no = excluded.doc_no,
        gross_amount = excluded.gross_amount, net_amount = excluded.net_amount, lab_revenue = excluded.lab_revenue,
        diagnosis_revenue = excluded.diagnosis_revenue,
        out_revenue = excluded.out_revenue, discount_rate = excluded.discount_rate, revenue_source = 'statement',
        config_version = excluded.config_version, line_count = excluded.line_count, import_batch = excluded.import_batch, updated_at = CURRENT_TIMESTAMP
    `)
    const delLines = db.prepare('DELETE FROM case_revenue_lines WHERE partner_id = ? AND case_no = ? AND service_month = ?')
    const insLine = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, partner_name, seq, charge_item, gross_amount, discount_rate, net_amount, scope, service_month, import_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

    let labTotal = 0, diagTotal = 0, outTotal = 0, caseCount = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [no, lines] of linesByCase) {
        let gross = 0, net = 0, lab = 0, diag = 0, out = 0
        for (const r of lines) {
          gross = round2(gross + fin(r.bill)); net = round2(net + fin(r.settle))
          // in=labPortion(=settle) / split=分摊后的制片份额；diagnosis=diagPortion(=settle) / split=诊断份额；out=整条
          lab = round2(lab + fin(r.labPortion)); diag = round2(diag + fin(r.diagPortion))
          if (r.status === 'out') out = round2(out + fin(r.settle))
        }
        const dr = gross > 0 ? round4(net / gross) : 0
        upsert.run(`CR-${uuidv4()}`, no, partnerId, partner.name, docNo || null, gross, net, lab, diag, out, dr, serviceMonth, cfg.version, lines.length, importBatch)
        delLines.run(partnerId, no, serviceMonth)
        lines.forEach((r, i) => insLine.run(`CRL-${uuidv4()}`, no, partnerId, partner.name, i + 1, r.item, fin(r.bill), fin(r.rate), fin(r.settle), r.status, serviceMonth, importBatch))
        labTotal = round2(labTotal + lab); diagTotal = round2(diagTotal + diag); outTotal = round2(outTotal + out); caseCount++
      }
      backfillAbcPartnerIds(db)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }

    success(res, {
      partnerId, serviceMonth, configVersion: cfg.version, importBatch,
      caseCount, labRevenue: labTotal, diagnosisSettle: diagTotal, outSettle: outTotal,
      unmatchedSettle: rev.unmatchedSettle, ambiguousSettle: rev.ambiguousSettle, skippedNoCase,
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
      target = { key: `l-${uuidv4().slice(0, 8)}`, name: String(newLine.name), on: true, scope: newLine.scope === 'out' ? 'out' : 'in', prefixes: [], keywords: [], remarks: [] }
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

    // codex MEDIUM-2：测试台基于某版预览归类时传 expectedVersion → 乐观锁防并发覆盖（配置页已改到更新版时 409，要求重新预览）。
    const r = saveConfig(db, partnerId, normalized, { changedBy: userId(req), tab: '业务分类', genId, expectedVersion })
    success(res, { partnerId, version: r.version, lineKey: target.key, scope: target.scope }, `已写入 ${partnerId} 配置（v${r.version}·业务分类），立即生效`)
  } catch (e: any) {
    if (/版本冲突/.test(e.message)) { error(res, e.message, 'CONFLICT', 409); return }
    error(res, e.message)
  }
})

export default router
