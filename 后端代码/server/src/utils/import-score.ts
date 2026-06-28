/**
 * 导入体检卡（配置驱动导入器 P3）—— 把导入测试台 v2 的四项体检做成后端可信判定。
 *
 * 四项（都基于【独立】证据，避免 self-fulfilling）：
 *  1. 识别率 = (行数 − 未匹配 − 歧义) / 行数。
 *  2. 对账闭合 = |Σ逐行结算 − declaredTotal| ≤ 阈值（declaredTotal 来自对账单【独立声明的合计行】，抓漏读行）。
 *  3. 病例匹配（双向）：正向 = 有病理号的行命中本期该院 LIS 的比率；反向 = LIS 计入病例中对账单【未覆盖】的数。
 *  4. 黄金值 = 算出实验室收入 vs 财务录入的期望实收（外部值；不符=纠错信号，不是 self-fulfilling）。
 *
 * status：ready（已人工核对设基线）> review（四项硬闸全过、待人工核对）> todo（任一未过）。
 * 纯函数（无 DB）；P4 路由层负责从 DB 取本期该院 LIS 病理号后调用。
 */
import type { StatementRevenue } from './statement-revenue.js'

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export interface ScoreCtx {
  declaredTotal: number | null // 对账单独立声明结算合计
  lisCaseNos?: string[] // 本期该院 LIS 计入病例的病理号（双向匹配用）
  goldenExpected?: number // 财务录入的期望实收（黄金值）
  closureTolerance?: number // 对账闭合阈值，默认 0.01
  goldenTolerance?: number // 黄金阈值，默认 0.01
  humanReviewed?: boolean // 人工核对过 → ready
}

export interface ImportScore {
  recognition: { total: number; matched: number; unmatched: number; ambiguous: number; rate: number; pass: boolean }
  closure: { declaredTotal: number | null; computed: number; diff: number | null; pass: boolean | null }
  caseMatch: {
    forward: { withCaseNo: number; matched: number; rate: number; pass: boolean | null }
    backward: { lisInPeriod: number; missingFromStatement: number; missingCaseNos: string[]; pass: boolean | null }
  }
  golden: { expected: number | null; computed: number; diff: number | null; pass: boolean | null }
  status: 'todo' | 'review' | 'ready'
  failures: string[] // 未过项的人话说明
}

export function scoreStatement(rev: StatementRevenue, ctx: ScoreCtx): ImportScore {
  const tol = ctx.closureTolerance ?? 0.01
  const gtol = ctx.goldenTolerance ?? 0.01
  const failures: string[] = []

  // 1. 识别率
  const total = rev.counts.total
  const badRows = rev.counts.unmatched + rev.counts.ambiguous
  const matched = total - badRows
  const rate = total > 0 ? round2((matched / total) * 100) / 100 : 1
  const recognitionPass = badRows === 0
  if (!recognitionPass) failures.push(`${rev.counts.unmatched} 行未匹配、${rev.counts.ambiguous} 行歧义，需人工归类`)

  // 2. 对账闭合（独立合计）
  let closurePass: boolean | null = null
  let closureDiff: number | null = null
  if (ctx.declaredTotal != null) {
    closureDiff = round2(rev.totalSettle - ctx.declaredTotal)
    closurePass = Math.abs(closureDiff) <= tol
    if (!closurePass) failures.push(`对账不平：逐行结算合计 ${rev.totalSettle} 与对账单声明合计 ${ctx.declaredTotal} 差 ${closureDiff}`)
  } else {
    failures.push('对账单无独立合计行，无法做对账闭合校验')
  }

  // 3. 病例匹配（双向）
  const lisSet = new Set((ctx.lisCaseNos ?? []).map((s) => s.trim()).filter(Boolean))
  const caseRows = rev.rows.filter((r) => r.no && r.no.trim())
  const stmtCaseSet = new Set(caseRows.map((r) => r.no.trim()))
  let fwdMatched = 0
  for (const c of stmtCaseSet) if (lisSet.has(c)) fwdMatched++
  const fwdRate = stmtCaseSet.size > 0 ? round2((fwdMatched / stmtCaseSet.size) * 100) / 100 : 1
  // 有 LIS 数据才判正向（无 lisCaseNos → null 跳过）
  const fwdPass: boolean | null = ctx.lisCaseNos == null ? null : stmtCaseSet.size === 0 ? null : fwdMatched === stmtCaseSet.size
  if (fwdPass === false) failures.push(`${stmtCaseSet.size - fwdMatched} 个对账单病理号在 LIS 查无（医院名/病理号对不上）`)

  const missingCaseNos: string[] = []
  if (ctx.lisCaseNos != null) for (const c of lisSet) if (!stmtCaseSet.has(c)) missingCaseNos.push(c)
  const bwdPass: boolean | null = ctx.lisCaseNos == null ? null : missingCaseNos.length === 0
  if (bwdPass === false) failures.push(`${missingCaseNos.length} 例 LIS 计入病例对账单未覆盖（待对账/估算）`)

  // 4. 黄金值
  let goldenPass: boolean | null = null
  let goldenDiff: number | null = null
  if (ctx.goldenExpected != null) {
    goldenDiff = round2(rev.labRevenue - ctx.goldenExpected)
    goldenPass = Math.abs(goldenDiff) <= gtol
    if (!goldenPass) failures.push(`黄金不符：算出实验室收入 ${rev.labRevenue} 与期望 ${ctx.goldenExpected} 差 ${goldenDiff}`)
  }

  // status：硬闸 = 识别率 + 对账闭合(必须 pass；null=无合计行 保守判未过) + 黄金(若有) + 正向病例(若有)。
  // 反向缺口=信息项，不阻断 status（LIS 可能尚未全部计费）。
  const allPass = recognitionPass && closurePass === true && goldenPass !== false && fwdPass !== false
  const status: ImportScore['status'] = ctx.humanReviewed ? 'ready' : allPass ? 'review' : 'todo'

  return {
    recognition: { total, matched, unmatched: rev.counts.unmatched, ambiguous: rev.counts.ambiguous, rate, pass: recognitionPass },
    closure: { declaredTotal: ctx.declaredTotal, computed: rev.totalSettle, diff: closureDiff, pass: closurePass },
    caseMatch: {
      forward: { withCaseNo: stmtCaseSet.size, matched: fwdMatched, rate: fwdRate, pass: fwdPass },
      backward: { lisInPeriod: lisSet.size, missingFromStatement: missingCaseNos.length, missingCaseNos, pass: bwdPass },
    },
    golden: { expected: ctx.goldenExpected ?? null, computed: rev.labRevenue, diff: goldenDiff, pass: goldenPass },
    status,
    failures,
  }
}
