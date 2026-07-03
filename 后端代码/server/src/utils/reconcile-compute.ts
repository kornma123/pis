/**
 * 账实核对 —— DB 编排层（读账单/LIS → 跑引擎 → 落库），Phase 1。
 *
 * 账单侧 = case_revenue_lines（收入侧导入的对账单明细，按 charge_item 分类免疫组化/特染，逐 case 聚合片数）。
 * LIS 侧 = lis_cases 物理计数（ihc_count / special_stain_count），按 operate_time 月份过滤。
 * 纯口径见 reconcile-account.ts；本层只做取数 + 落 reconcile_hospital_months / reconcile_diffs。
 */
import { v4 as uuidv4 } from 'uuid'
import {
  classifyChargeItem,
  computeReconcile,
  type BillCase,
  type LisCase,
} from './reconcile-account.js'

export interface ReconcileInputs {
  bills: BillCase[]
  lis: LisCase[]
  statementReady: boolean
  lisReady: boolean
}

/**
 * 某院某月「收费→实收」全票扣率 = Σnet / Σgross（只读 case_revenue；无数据回退 1）。
 * 仅作 partnerMonthLabRate 的回退——补收折实收不直接用它（见下）。
 */
export function partnerMonthDiscountRate(db: any, partnerId: string, serviceMonth: string): number {
  const r = db
    .prepare('SELECT COALESCE(SUM(gross_amount),0) g, COALESCE(SUM(net_amount),0) n FROM case_revenue WHERE partner_id = ? AND service_month = ?')
    .get(partnerId, serviceMonth) as { g: number; n: number }
  const g = Number(r?.g) || 0
  const n = Number(r?.n) || 0
  return g > 0 ? n / g : 1
}

/**
 * 实验室工序（免疫组化/特染）行的扣率 = Σ(其 net) / Σ(其 gross)。
 *
 * 补收折实收专用。为什么不用全票 Σnet/Σgross：补收是漏收的**免疫组化/特染片**（§1.2 整条计入实验室=实验室工序），
 * 折出的实收要和「确认实收 = Σlab_revenue（纯实验室，已剔诊断桶/移出）」同口径。全票扣率把**诊断/移出行**的扣率混了进来
 * （合作方可按业务线设不同扣率），会污染免疫组化扣率；故只取免疫组化/特染行自己的 net/gross。
 * 回退：无实验室工序行 → 全票扣率；再无数据 → 1。
 */
export function partnerMonthLabRate(db: any, partnerId: string, serviceMonth: string): number {
  const rows = db
    .prepare('SELECT charge_item, gross_amount, net_amount FROM case_revenue_lines WHERE partner_id = ? AND service_month = ?')
    .all(partnerId, serviceMonth) as Array<{ charge_item: string; gross_amount: number; net_amount: number }>
  let g = 0
  let n = 0
  for (const r of rows) {
    const t = classifyChargeItem(r.charge_item)
    if (t === '免疫组化' || t === '特染') {
      g += Number(r.gross_amount) || 0
      n += Number(r.net_amount) || 0
    }
  }
  if (g > 0) return n / g
  return partnerMonthDiscountRate(db, partnerId, serviceMonth)
}

/** 读某院某月的账单聚合（按 case，免疫组化/特染片数 + 单价）+ LIS 物理计数。 */
export function buildReconcileInputs(db: any, partnerId: string, serviceMonth: string): ReconcileInputs {
  const billRows = db
    .prepare(
      `SELECT case_no, charge_item, qty, unit_price, gross_amount
       FROM case_revenue_lines
       WHERE partner_id = ? AND service_month = ?`,
    )
    .all(partnerId, serviceMonth) as Array<{ case_no: string; charge_item: string; qty: number; unit_price: number; gross_amount: number }>

  // 账单片数 = 逐 case 的免疫组化/特染「片数」。
  //   片数取每行 qty（对账单带数量列时为真数量）；qty 缺/为 0（对账单常按每抗体一行、不填数量）→ **每计费行按 1 片计**（floor，永不为 0）。
  //   ⚠️ 边界（未决 A4-邻）：若对账单把免疫组化聚合成一行且数量写在项名里（如「免疫组化*16」），此处按 1 片会低估——待 qty 解析增强；
  //   现按 line-count 出的「疑似漏收」= 线索非定论、由财务终判（设计基线 §1.4）。单价取行 unit_price，缺则用 gross_amount/片数 反推。
  const agg = new Map<string, { ihc: number; ss: number; ihcGross: number; ssGross: number }>()
  for (const r of billRows) {
    const lineType = classifyChargeItem(r.charge_item)
    if (!lineType) continue // 组织学/诊断类不在本轮核对
    const key = r.case_no
    if (!key) continue
    const slides = Number(r.qty) > 0 ? Number(r.qty) : 1
    const unit = Number(r.unit_price) || 0
    const gross = Number(r.gross_amount) || (unit > 0 ? unit * slides : 0)
    const cur = agg.get(key) ?? { ihc: 0, ss: 0, ihcGross: 0, ssGross: 0 }
    if (lineType === '免疫组化') { cur.ihc += slides; cur.ihcGross += gross }
    else { cur.ss += slides; cur.ssGross += gross }
    agg.set(key, cur)
  }
  const billByCase = new Map<string, BillCase>()
  for (const [key, a] of agg) {
    billByCase.set(key, {
      caseNo: key,
      ihc: a.ihc,
      ss: a.ss,
      ihcUnitPrice: a.ihc > 0 && a.ihcGross > 0 ? a.ihcGross / a.ihc : undefined,
      ssUnitPrice: a.ss > 0 && a.ssGross > 0 ? a.ssGross / a.ss : undefined,
    })
  }

  // LIS 月份来自 operate_time（兼容 '/' 分隔）；过滤该院该月。
  const lisRows = db
    .prepare(
      `SELECT case_no, ihc_count, special_stain_count
       FROM lis_cases
       WHERE partner_id = ? AND substr(replace(COALESCE(operate_time, ''), '/', '-'), 1, 7) = ?`,
    )
    .all(partnerId, serviceMonth) as Array<{ case_no: string; ihc_count: number; special_stain_count: number }>

  const lisByCase = new Map<string, LisCase>()
  for (const r of lisRows) {
    if (!r.case_no) continue
    const cur = lisByCase.get(r.case_no) ?? { caseNo: r.case_no, ihc: 0, ss: 0 }
    cur.ihc += Number(r.ihc_count) || 0
    cur.ss += Number(r.special_stain_count) || 0
    lisByCase.set(r.case_no, cur)
  }

  return {
    bills: [...billByCase.values()],
    lis: [...lisByCase.values()],
    statementReady: billRows.length > 0,
    lisReady: lisRows.length > 0,
  }
}

export interface RunReconcileResult {
  hospitalMonthId: string
  matchRate: number
  matchStatus: string
  diffCount: number
  pendingCount: number
  unmatchedCount: number
  statementReady: boolean
  lisReady: boolean
}

/**
 * 跑某院某月账实核对并落库（幂等重算：清旧 diffs 重建）。
 * 关账后（定版）拒绝重算——迟到数据记次月，不改定版（§1.5）。
 * ⚠️ 重算会清空未关账院·月的已填认定（设计取舍：待复核态重跑=重置认定；正式改判请走「重新打开」）。
 */
export function runReconcile(db: any, partnerId: string, serviceMonth: string, operator: string | null): RunReconcileResult {
  const partner = db.prepare('SELECT id, name FROM partners WHERE id = ?').get(partnerId) as { id: string; name: string } | undefined
  const existing = db
    .prepare('SELECT * FROM reconcile_hospital_months WHERE partner_id = ? AND service_month = ?')
    .get(partnerId, serviceMonth) as any
  if (existing && existing.status === '已关账') {
    throw Object.assign(new Error('该院该月已关账·定版不可改（迟到数据记次月）'), { code: 'PERIOD_CLOSED' })
  }

  const { bills, lis, statementReady, lisReady } = buildReconcileInputs(db, partnerId, serviceMonth)
  const result = computeReconcile(bills, lis)

  const hmId = existing?.id ?? uuidv4()
  const nowExpr = 'CURRENT_TIMESTAMP'
  if (existing) {
    db.prepare(
      `UPDATE reconcile_hospital_months
       SET partner_name = ?, name_aligned = 1, match_rate = ?, match_status = ?, statement_ready = ?, lis_ready = ?,
           diff_count = ?, pending_count = ?, unmatched_count = ?, computed_at = ${nowExpr}, updated_at = ${nowExpr},
           status = CASE WHEN status = '复核完成' THEN '待复核' ELSE status END
       WHERE id = ?`,
    ).run(partner?.name ?? existing.partner_name ?? null, result.matchRate, result.matchStatus,
      statementReady ? 1 : 0, lisReady ? 1 : 0, result.diffs.length, result.diffs.length, result.unmatched.length, hmId)
  } else {
    db.prepare(
      `INSERT INTO reconcile_hospital_months
        (id, partner_id, partner_name, service_month, status, name_aligned, match_rate, match_status,
         statement_ready, lis_ready, diff_count, pending_count, unmatched_count, computed_at)
       VALUES (?, ?, ?, ?, '待复核', 1, ?, ?, ?, ?, ?, ?, ?, ${nowExpr})`,
    ).run(hmId, partnerId, partner?.name ?? null, serviceMonth, result.matchRate, result.matchStatus,
      statementReady ? 1 : 0, lisReady ? 1 : 0, result.diffs.length, result.diffs.length, result.unmatched.length)
  }

  db.prepare('DELETE FROM reconcile_diffs WHERE hospital_month_id = ?').run(hmId)
  // 重算清旧 diffs（含其认定）→ 同步清本院月「待补收」单（认定重置，避免 source_diff_id 悬空孤儿；已补收/已放弃保留）。
  db.prepare("DELETE FROM supplement_orders WHERE partner_id = ? AND service_month = ? AND status = '待补收'").run(partnerId, serviceMonth)
  const insertDiff = db.prepare(
    `INSERT INTO reconcile_diffs
      (id, hospital_month_id, partner_id, service_month, case_no, line_type, bill_count, lis_count, delta, amount_impact, system_hint, low_confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const d of result.diffs) {
    insertDiff.run(uuidv4(), hmId, partnerId, serviceMonth, d.caseNo, d.lineType, d.billCount, d.lisCount, d.delta,
      d.amountImpact, d.systemHint, d.lowConfidence ? 1 : 0)
  }

  return {
    hospitalMonthId: hmId,
    matchRate: result.matchRate,
    matchStatus: result.matchStatus,
    diffCount: result.diffs.length,
    pendingCount: result.diffs.length,
    unmatchedCount: result.unmatched.length,
    statementReady,
    lisReady,
  }
}
