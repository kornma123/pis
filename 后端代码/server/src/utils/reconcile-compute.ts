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
  classifyCaseHints,
  type BillCase,
  type LisCase,
  type MarkerRow,
} from './reconcile-account.js'

export interface ReconcileInputs {
  bills: BillCase[]
  lis: LisCase[]
  statementReady: boolean
  lisReady: boolean
  /** 账单件数解析不可靠的 case+线（聚合行 floor-to-1、抽不出真实件数）→ 其差异落库时标 low_confidence，分流待人工。 */
  billCountLowConf: Map<string, { ihc: boolean; ss: boolean }>
}

/**
 * 账单聚合行「件数」解析（根因修复 floor-to-1，本文件旧「qty 缺一律按 1 片」）。
 *
 * 病灶：真实对账单（温州中心医院等，全部月份）把一 case 的免疫组化聚合成一行、真实件数以**乘号**写在服务
 *   项目文本里（`免疫组化*16` = 16 片），且配置驱动导入器（statement-import）不落 qty 列（默认 0）→ 旧逻辑
 *   一律按 1 片 → 系统性低估账单件数 → billCount(1) < lisCount(16) → 量产假的「疑似漏收，需补收」。
 *
 * 解析口径（碰钱·宁保守漏放也别 over-count；规则经 60 份真对账单实证 + 双引擎对抗复核加固）：
 *  · qty>0（对账单带数量列 / 收费单据 path）→ 直接用 qty，不动（高置信）。
 *  · qty 缺/0/负 → 从文本抽「件数乘法」`线名×N`：乘号（`*`/`×`/`✕`/`╳`，**不认 Latin x/X**——真数据只用 `*`、
 *      且 `X100` 类编码会误吞）前须**紧贴免疫组化/特染线名尾**（`免疫组化`/`组化`/`染色`/`特染`…，见 LINE_NAME_TAIL），
 *      而非任意 CJK 字——否则中文费率语法 `FISH检测*2/项`、`会诊×2`、`2次*18元` 会把测/诊/次×价当件数；数字后**不得**
 *      紧跟价/率单位（元/¥/%/折 或 `/`）。命中唯一干净件数（1..上界）→ `免疫组化*16`→16、`61基因检测+免疫组化*2`→2、
 *      `刚果红染色组化*1`→1（高置信）。经 NFKC 归一容全角 `＊１６`。
 *  · **绝不**把价格/费率当件数（双引擎复核实证的真陷阱）：`免疫组化2次*18元`（量×单价）、`每片×85元`（每×价）、
 *      `工资*2%`（百分率）、`FISH检测*2/项`（乘号贴在非线名「检测」上）、`FISH750*2`（乘号前是数字）、
 *      `基础诊断费…免疫组化144`（无乘号）——一律不取。
 *  · 抽不出干净件数但有费率/聚合信号（脏乘法 / `/个`·`/项` / 残缺乘号）→ 按 1、**confident=false**（低置信分流）。
 *  · 多值冲突 / 件数越界（疑似价格误填）→ 按 1、confident=false。
 *  · 无任何聚合/费率信号的普通单行（`免疫组化`）→ 按 1、confident=true（设计基线，不泛滥标低置信）。
 */
export const MAX_PARSED_SLIDES = 60 // 单 case 单行件数合理上界（真数据最大 20）；超过疑似价格/编码 → 不硬信、标低置信
// 件数乘号前须紧贴的免疫组化/特染线名尾（真数据 `免疫组化*N`/`染色组化*1`/`特殊染色*3` 的名尾）；防把 检测/会诊/次×价 当件数。
const LINE_NAME_TAIL = /(?:免疫组化|免疫组织化学|免组|组化|特殊染色|特染|染色)$/
const PRICE_TAIL = /[元¥％%折/]/ // 数字后紧跟货币/百分/折扣/斜杠（`/项`·`/月` 费率）= 单价/费率，非件数
// 抽不出干净件数但存在费率/聚合信号：CJK 紧跟乘号无合法件数、`每…×`、或 `/个`·`/项`·`/片` 费用明细单位。
const AGG_SIGNAL = /[一-鿿][ \t]*[*×✕╳]|每[一-鿿]{0,2}[ \t]*[*×✕╳]|\/\s*[个项片]/

export function parseSlideCount(chargeItem: string, qty: unknown): { count: number; confident: boolean } {
  const q = Number(qty)
  if (Number.isFinite(q) && q > 0) return { count: q, confident: true }
  // NFKC 归一：全角乘号/全角数字（`免疫组化＊１６`）→ 半角（`免疫组化*16`），与项目 canonicalCaseNo 同哲学。
  const text = String(chargeItem ?? '').normalize('NFKC')
  const counts: number[] = []
  let dirty = false // 命中费率乘法（量×价 / 每×价 / ×价元）= 费用明细，非件数
  const re = /[*×✕╳][ \t]*0*(\d+)/g
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const n = Number(m[1])
    const pre = text.slice(0, m.index).replace(/[ \t]+$/, '') // 乘号前（去尾空白）
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1) // 数字后一字
    // 件数 = 乘号须紧贴免疫组化/特染线名尾，且数字后非价/率单位；否则是费率乘法（检测/会诊/次×价）→ 脏，不计件数。
    if (!LINE_NAME_TAIL.test(pre) || PRICE_TAIL.test(after)) { dirty = true; continue }
    counts.push(n)
  }
  const distinct = [...new Set(counts)]
  if (distinct.length === 1) {
    const n = distinct[0]
    if (Number.isInteger(n) && n >= 1 && n <= MAX_PARSED_SLIDES) return { count: n, confident: true }
    return { count: 1, confident: false } // 件数=0 或超上界（疑似价格误填）→ 低置信
  }
  if (distinct.length > 1) return { count: 1, confident: false } // 多个冲突计数 → 歧义低置信
  // 无干净件数：有费率/聚合信号 → 低置信分流；否则普通单行 → 高置信按 1（基线）。
  return { count: 1, confident: !(dirty || AGG_SIGNAL.test(text)) }
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
  //   片数取每行 qty（对账单带数量列时为真数量）；qty 缺/为 0 时经 parseSlideCount 从项名文本解析真实件数
  //   （聚合行 `免疫组化*16`→16，根因修复 floor-to-1）；解析不出的聚合行标 lowConf（差异分流待人工，不当高置信漏收）。
  //   普通单行（每抗体一行、无聚合信号）仍按 1 片、高置信（设计基线 §1.4）。单价取行 unit_price，缺则用 gross_amount/片数 反推。
  const agg = new Map<string, { ihc: number; ss: number; ihcGross: number; ssGross: number; ihcLowConf: boolean; ssLowConf: boolean }>()
  for (const r of billRows) {
    const lineType = classifyChargeItem(r.charge_item)
    if (!lineType) continue // 组织学/诊断类不在本轮核对
    const key = r.case_no
    if (!key) continue
    const { count: slides, confident } = parseSlideCount(r.charge_item, r.qty)
    const unit = Number(r.unit_price) || 0
    const gross = Number(r.gross_amount) || (unit > 0 ? unit * slides : 0)
    const cur = agg.get(key) ?? { ihc: 0, ss: 0, ihcGross: 0, ssGross: 0, ihcLowConf: false, ssLowConf: false }
    if (lineType === '免疫组化') { cur.ihc += slides; cur.ihcGross += gross; if (!confident) cur.ihcLowConf = true }
    else { cur.ss += slides; cur.ssGross += gross; if (!confident) cur.ssLowConf = true }
    agg.set(key, cur)
  }
  const billByCase = new Map<string, BillCase>()
  const billCountLowConf = new Map<string, { ihc: boolean; ss: boolean }>()
  for (const [key, a] of agg) {
    billByCase.set(key, {
      caseNo: key,
      ihc: a.ihc,
      ss: a.ss,
      ihcUnitPrice: a.ihc > 0 && a.ihcGross > 0 ? a.ihcGross / a.ihc : undefined,
      ssUnitPrice: a.ss > 0 && a.ssGross > 0 ? a.ssGross / a.ss : undefined,
    })
    if (a.ihcLowConf || a.ssLowConf) billCountLowConf.set(key, { ihc: a.ihcLowConf, ss: a.ssLowConf })
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
    billCountLowConf,
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
 * ③ 读某院某月逐抗体明细（lis_case_markers），按 case 聚成 MarkerRow[]。
 * marker 表本身无月份列 → join lis_cases 用 operate_time 过滤月份（与差异引擎同月份口径）。
 */
export function buildCaseMarkers(db: any, partnerId: string, serviceMonth: string): Map<string, MarkerRow[]> {
  const rows = db
    .prepare(
      `SELECT m.case_no, m.marker_name, m.wax_no, m.section_no, m.advice_type
       FROM lis_case_markers m
       JOIN lis_cases c ON c.partner_id = m.partner_id AND c.case_no = m.case_no
       WHERE m.partner_id = ? AND substr(replace(COALESCE(c.operate_time, ''), '/', '-'), 1, 7) = ?
       ORDER BY m.case_no, m.wax_no, m.section_no, m.id`,
    )
    .all(partnerId, serviceMonth) as Array<{ case_no: string; marker_name: string; wax_no: string | null; section_no: string | null; advice_type: string | null }>
  const byCase = new Map<string, MarkerRow[]>()
  for (const r of rows) {
    if (!r.case_no) continue
    const arr = byCase.get(r.case_no) ?? []
    arr.push({ markerName: r.marker_name, waxNo: r.wax_no, sectionNo: r.section_no, adviceType: r.advice_type })
    byCase.set(r.case_no, arr)
  }
  return byCase
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

  const { bills, lis, statementReady, lisReady, billCountLowConf } = buildReconcileInputs(db, partnerId, serviceMonth)
  const result = computeReconcile(bills, lis)

  const hmId = existing?.id ?? uuidv4()
  const nowExpr = 'CURRENT_TIMESTAMP'
  // 一个事务原子写入：院·月 + diffs + 清待补收 + 细粒度线索——任一步失败整体回滚，不留半截快照。
  db.exec('BEGIN IMMEDIATE')
  try {
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
    // 差异 low_confidence = 院级匹配偏低(computeReconcile) ∨ 账单件数解析不可靠(该 case+线聚合行 floor-to-1)。
    const lc = billCountLowConf.get(d.caseNo)
    const countUnreliable = d.lineType === '免疫组化' ? !!lc?.ihc : !!lc?.ss
    insertDiff.run(uuidv4(), hmId, partnerId, serviceMonth, d.caseNo, d.lineType, d.billCount, d.lisCount, d.delta,
      d.amountImpact, d.systemHint, d.lowConfidence || countUnreliable ? 1 : 0)
  }

  // ③ 逐抗体细粒度初判（返工/多病灶）：读逐抗体明细 → 每 case 分组 → 落 reconcile_case_hints（与 diffs 同事务清建）。
  //   附加线索、正交于计数级差异：某院月无 marker 明细 → 无线索、差异照常。
  db.prepare('DELETE FROM reconcile_case_hints WHERE hospital_month_id = ?').run(hmId)
  const insertHint = db.prepare(
    `INSERT INTO reconcile_case_hints (id, hospital_month_id, partner_id, service_month, case_no, hint_type, marker_name, wax_no, occurrences)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const [caseNo, markers] of buildCaseMarkers(db, partnerId, serviceMonth)) {
    for (const h of classifyCaseHints(markers)) {
      insertHint.run(uuidv4(), hmId, partnerId, serviceMonth, caseNo, h.hintType, h.markerName,
        h.waxNo ?? (h.waxNos ? h.waxNos.join('、') : null), h.occurrences)
    }
  }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
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
