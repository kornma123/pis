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
import type { PartnerConfig, PartnerConfigLine } from './partner-config.js'
import type { ParsedRow } from './statement-parser/index.js'
import { classify } from './classifier.js'

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const nfkc = (s: unknown): string => (s == null ? '' : String(s)).normalize('NFKC').trim()

export interface LineRevenue {
  key: string
  name: string
  scope: 'in' | 'out'
  count: number
  settle: number
}

export interface ClassifiedRow {
  no: string
  item: string
  bill: number
  rate: number
  settle: number
  status: 'in' | 'out' | 'unmatched' | 'ambiguous'
  lineKey?: string
  lineName?: string
  by?: string
}

export interface StatementRevenue {
  labRevenue: number // Σ(IN settle) —— 实验室收入
  outSettle: number // Σ(OUT settle) —— 移出（外送/远程/共建分成/科研）
  unmatchedSettle: number
  ambiguousSettle: number
  totalSettle: number // Σ全行 settle（守恒校验：= 上面四项之和）
  byLine: LineRevenue[]
  rows: ClassifiedRow[]
  counts: { total: number; in: number; out: number; unmatched: number; ambiguous: number }
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

/** 逐行分类 + 结算 + 归集。 */
export function computeStatementRevenue(rows: ParsedRow[], config: PartnerConfig): StatementRevenue {
  const byLineMap = new Map<string, LineRevenue>()
  const out: StatementRevenue = {
    labRevenue: 0,
    outSettle: 0,
    unmatchedSettle: 0,
    ambiguousSettle: 0,
    totalSettle: 0,
    byLine: [],
    rows: [],
    counts: { total: 0, in: 0, out: 0, unmatched: 0, ambiguous: 0 },
  }

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

    let status: ClassifiedRow['status']
    if (cls.kind === 'matched') {
      status = cls.scope
      if (cls.scope === 'in') out.labRevenue = round2(out.labRevenue + settle)
      else out.outSettle = round2(out.outSettle + settle)
      out.counts[cls.scope]++
      const k = cls.line.key
      let lr = byLineMap.get(k)
      if (!lr) {
        lr = { key: k, name: cls.line.name, scope: cls.line.scope, count: 0, settle: 0 }
        byLineMap.set(k, lr)
      }
      lr.count++
      lr.settle = round2(lr.settle + settle)
    } else if (cls.kind === 'ambiguous') {
      status = 'ambiguous'
      out.ambiguousSettle = round2(out.ambiguousSettle + settle)
      out.counts.ambiguous++
    } else {
      status = 'unmatched'
      out.unmatchedSettle = round2(out.unmatchedSettle + settle)
      out.counts.unmatched++
    }

    out.rows.push({
      no: row.no,
      item: row.item,
      bill: row.bill,
      rate: row.rate,
      settle,
      status,
      lineKey: matchedLine?.key,
      lineName: matchedLine?.name,
      by: cls.kind === 'matched' ? cls.by : undefined,
    })
  }

  out.byLine = [...byLineMap.values()]
  return out
}
