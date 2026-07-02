/**
 * 对账单收入归集（配置驱动导入器 P2）—— 逐行分类 → 结算 → 实验室收入 = Σ(IN 结算)。
 *
 * 红线（口径）：
 *  - 结算(实收) settle = 医院收费(开单/gross) × 扣率 rate。**绝不把开单当结算**。
 *  - 实验室收入 labRevenue = Σ(IN 业务线行的 settle)。移出(out)行进 outSettle，不进实验室收入。
 *  - 扣率三级（细盖粗）：按项目(byItem) > 按业务线(byLine) > 默认(def)。**仅当对账单未给结算/扣率时用作估算**；
 *    对账单已有 结算金额 列（解析层 row.settle 已填）→ 直接采信（真实优先于估算）。
 *  - **守恒**：labRevenue + outSettle + unmatchedSettle + ambiguousSettle == Σ全行 settle（不静默吞）。
 *
 * 完整度诚实标注：未匹配/歧义行的 settle 单列出来（P3 评分 + 看板「待人工归类」）。
 */
import type { PartnerConfig, PartnerConfigLine, LineScope } from './partner-config.js'
import type { ParsedRow } from './statement-parser/index.js'
import { classify } from './classifier.js'

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const nfkc = (s: unknown): string => (s == null ? '' : String(s)).normalize('NFKC').trim()
const nfkcUpper = (s: unknown): string => nfkc(s).toUpperCase()

/** 国标诊断费（元/病例）：一病例判读一次，split 拆分公式的固定分母项（G1 §2）。 */
export const SPLIT_DIAG_FEE = 105

/** split 病例桶 key 的字段分隔符（可见双冒号 ::）：不会出现在病理号/业务线 key 里。
 *  用转义常量而非字面 NUL，否则源码含 NUL → Git 判为 binary、坏 diff/搜索/工具链（codex 10 LOW）。 */
const SPLIT_GROUP_SEP = '::'

export interface LineRevenue {
  key: string
  name: string
  scope: LineScope
  count: number
  settle: number // 该线全部行结算额（split 线=拆分前总额）
  labShare?: number // scope=split：其中计入实验室的制片份额
  diagShare?: number // scope=split：其中落诊断桶的诊断份额
}

export interface ClassifiedRow {
  no: string
  item: string
  bill: number
  rate: number
  settle: number
  status: 'in' | 'out' | 'split' | 'diagnosis' | 'unmatched' | 'ambiguous'
  lineKey?: string
  lineName?: string
  by?: string
  labPortion?: number // 该行计入实验室的额：in=settle / split=按病例拆后分摊到本行的制片份额 / 其余=0（落库逐病例 lab_revenue 用）
  diagPortion?: number // 该行落诊断桶的额：diagnosis=settle / split=分摊到本行的诊断份额 / 其余=0
}

export interface StatementRevenue {
  labRevenue: number // Σ(IN settle) + Σ(split 制片份额) —— 实验室收入
  diagnosisSettle: number // 诊断桶：Σ(diagnosis 整条) + Σ(split 诊断份额) —— 我们的钱但非实验室工序
  outSettle: number // Σ(OUT settle) —— 移出（外送/远程/共建分成/科研）
  unmatchedSettle: number
  ambiguousSettle: number
  totalSettle: number // Σ全行 settle（守恒：= lab + diagnosis + out + unmatched + ambiguous）
  splitLisExpected: number // scope=split & splitWorkload=lis_blk 的病例组数（应按 LIS 蜡块拆）
  splitLisMissing: number // 其中缺 LIS 蜡块、已降级账单数量估算的组数（完整度信号：>0 说明拆分口径为下限估算）
  byLine: LineRevenue[]
  rows: ClassifiedRow[]
  counts: { total: number; in: number; out: number; split: number; diagnosis: number; unmatched: number; ambiguous: number }
}

/** 逐病例 split 累积桶：同一 (病理号, 业务线) 的结算与数量归并，pass 2 一次拆分（诊断费按病例计一次）。 */
interface SplitGroup {
  line: PartnerConfigLine
  no: string
  settle: number
  qty: number
  rows: ClassifiedRow[] // 组内各行引用，pass 2 把拆出的制片/诊断份额按结算额分摊回 labPortion/diagPortion
}

export interface StatementRevenueOpts {
  /**
   * LIS 工作量（按病理号）：scope=split 且 splitWorkload='lis_blk' 的线（组织检诊制片）用**真蜡块**拆，
   * 制片份额 = rate×蜡块 / (rate×蜡块 + 105)。无此 map 或病理号缺失 → 降级用账单数量（qty）。
   * key 会按 NFKC+大写归一后匹配（调用方可传原始病理号为键）。
   */
  lisWorkload?: Map<string, { blk: number }>
}

/** 扣率三级解析（估算用；仅当行无结算时）。 */
export function resolveRate(config: PartnerConfig, line: PartnerConfigLine | null, item: string): number {
  const byItem = config.discount.byItem.find((d) => nfkc(item).includes(nfkc(d.item)) && nfkc(d.item).length > 0)
  if (byItem) return byItem.rate
  if (line) {
    const byLine = config.discount.byLine.find((d) => d.key === line.key)
    if (byLine) return byLine.rate
  }
  return config.discount.def
}

/**
 * 逐行分类 + 结算 + 归集。
 *
 * scope 归集：in→实验室收入 / out→移出 / diagnosis→诊断桶 / split→逐病例按国标比例拆（制片入实验室、诊断入诊断桶）。
 * split 需**两趟**：第一趟按 (病理号, 业务线) 累积结算+数量（诊断费按病例计一次，不能逐行拆）；
 * 第二趟按工作量（LIS 真蜡块优先，无则账单数量）算制片份额。**默认模板全 in/out → split/diagnosis 恒 0，零回归。**
 */
export function computeStatementRevenue(
  rows: ParsedRow[],
  config: PartnerConfig,
  opts: StatementRevenueOpts = {},
): StatementRevenue {
  const byLineMap = new Map<string, LineRevenue>()
  const splitGroups = new Map<string, SplitGroup>()
  // LIS 工作量按归一病理号重建索引（调用方可传原始键）
  const lisNorm = new Map<string, { blk: number }>()
  if (opts.lisWorkload) for (const [k, v] of opts.lisWorkload) lisNorm.set(nfkcUpper(k), v)

  const out: StatementRevenue = {
    labRevenue: 0,
    diagnosisSettle: 0,
    outSettle: 0,
    unmatchedSettle: 0,
    ambiguousSettle: 0,
    totalSettle: 0,
    splitLisExpected: 0,
    splitLisMissing: 0,
    byLine: [],
    rows: [],
    counts: { total: 0, in: 0, out: 0, split: 0, diagnosis: 0, unmatched: 0, ambiguous: 0 },
  }

  const lineEntry = (line: PartnerConfigLine): LineRevenue => {
    let lr = byLineMap.get(line.key)
    if (!lr) {
      lr = { key: line.key, name: line.name, scope: line.scope, count: 0, settle: 0 }
      byLineMap.set(line.key, lr)
    }
    return lr
  }

  // —— 第一趟：分类 + 结算；in/out/diagnosis 即时归集，split 累积到病例桶 ——
  for (const row of rows) {
    const cls = classify(config.lines, { no: row.no, item: row.item, remark: row.remark })
    const matchedLine = cls.kind === 'matched' ? cls.line : null

    // 结算优先级：对账单结算列(row.settle) > 开单×行扣率(解析层已回退) > 开单×配置三级扣率(估算)
    let settle = row.settle
    if (!Number.isFinite(settle)) {
      settle = Number.isFinite(row.bill) ? round2(row.bill * resolveRate(config, matchedLine, row.item)) : 0
    }
    settle = round2(settle)
    out.totalSettle = round2(out.totalSettle + settle)
    out.counts.total++

    const cr: ClassifiedRow = {
      no: row.no, item: row.item, bill: row.bill, rate: row.rate, settle,
      status: 'unmatched', lineKey: matchedLine?.key, lineName: matchedLine?.name,
      by: cls.kind === 'matched' ? cls.by : undefined,
    }
    if (cls.kind === 'matched') {
      const scope = cls.scope
      cr.status = scope
      out.counts[scope]++
      const lr = lineEntry(cls.line)
      lr.count++
      lr.settle = round2(lr.settle + settle)
      if (scope === 'in') {
        out.labRevenue = round2(out.labRevenue + settle)
        cr.labPortion = settle
      } else if (scope === 'out') {
        out.outSettle = round2(out.outSettle + settle)
      } else if (scope === 'diagnosis') {
        out.diagnosisSettle = round2(out.diagnosisSettle + settle)
        cr.diagPortion = settle
      } else {
        // split：诊断费按病例计一次 → 必须先按 (病理号,业务线) 归并，第二趟再拆
        const gk = `${nfkcUpper(row.no)}${SPLIT_GROUP_SEP}${cls.line.key}`
        const g = splitGroups.get(gk) ?? { line: cls.line, no: row.no, settle: 0, qty: 0, rows: [] }
        g.settle = round2(g.settle + settle)
        g.qty += Number.isFinite(row.qty as number) && (row.qty as number) > 0 ? (row.qty as number) : 1
        g.rows.push(cr)
        splitGroups.set(gk, g)
      }
    } else if (cls.kind === 'ambiguous') {
      cr.status = 'ambiguous'
      out.ambiguousSettle = round2(out.ambiguousSettle + settle)
      out.counts.ambiguous++
    } else {
      cr.status = 'unmatched'
      out.unmatchedSettle = round2(out.unmatchedSettle + settle)
      out.counts.unmatched++
    }

    out.rows.push(cr)
  }

  // —— 第二趟：逐病例 split 拆分（制片份额 = rate×工作量 / (rate×工作量 + 105)）——
  for (const g of splitGroups.values()) {
    const rate = Number.isFinite(g.line.splitProcRate as number) ? (g.line.splitProcRate as number) : 0
    const wantsLis = g.line.splitWorkload === 'lis_blk'
    const useLis = wantsLis && lisNorm.has(nfkcUpper(g.no))
    if (wantsLis) { out.splitLisExpected++; if (!useLis) out.splitLisMissing++ } // 完整度：缺蜡块→降级估算
    const workload = useLis ? lisNorm.get(nfkcUpper(g.no))!.blk : g.qty
    const denom = rate * workload + SPLIT_DIAG_FEE
    const f = denom > 0 ? (rate * workload) / denom : 0
    const inShare = round2(g.settle * f)
    const diagShare = round2(g.settle - inShare) // 用减法保证 per-group 守恒到分（inShare+diagShare==settle）
    out.labRevenue = round2(out.labRevenue + inShare)
    out.diagnosisSettle = round2(out.diagnosisSettle + diagShare)
    const lr = lineEntry(g.line)
    lr.labShare = round2((lr.labShare ?? 0) + inShare)
    lr.diagShare = round2((lr.diagShare ?? 0) + diagShare)
    // 把制片/诊断份额按结算额分摊回组内各行（末行取余，保证 Σ labPortion==inShare、Σ diagPortion==diagShare 到分）
    let accIn = 0, accDiag = 0
    g.rows.forEach((r, i) => {
      if (i === g.rows.length - 1) {
        r.labPortion = round2(inShare - accIn)
        r.diagPortion = round2(diagShare - accDiag)
      } else {
        const w = g.settle > 0 ? r.settle / g.settle : 0
        r.labPortion = round2(inShare * w)
        r.diagPortion = round2(diagShare * w)
        accIn = round2(accIn + r.labPortion)
        accDiag = round2(accDiag + r.diagPortion)
      }
    })
  }

  out.byLine = [...byLineMap.values()]
  return out
}
