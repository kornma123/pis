// 对账单导入（测试台 / 月度向导）—— 与后端 statement-import-v1.1 路由响应对应。

export type ImportStatus = 'todo' | 'review' | 'ready'

export interface ImportScore {
  recognition: { total: number; matched: number; unmatched: number; ambiguous: number; rate: number; pass: boolean }
  closure: { declaredTotal: number | null; computed: number; diff: number | null; pass: boolean | null }
  caseMatch: {
    forward: { withCaseNo: number; matched: number; rate: number; pass: boolean | null }
    backward: { lisInPeriod: number; missingFromStatement: number; missingCaseNos: string[]; pass: boolean | null }
  }
  golden: { expected: number | null; computed: number; diff: number | null; pass: boolean | null }
  status: ImportStatus
  failures: string[]
}

export type LineScope = 'in' | 'out' | 'split' | 'diagnosis'
export interface LineRevenue {
  key: string; name: string; scope: LineScope; count: number; settle: number
  labShare?: number // scope=split：其中计入实验室的制片份额
  diagShare?: number // scope=split：其中落诊断桶的诊断份额
}

export interface PreviewRevenue {
  labRevenue: number // 实验室收入（整条 in + 拆分制片份额）
  diagnosisSettle: number // 诊断与报告（诊断桶：我们的钱但非实验室工序）
  outSettle: number // 外送转出（NGS/FISH/远程/共建）
  unmatchedSettle: number
  ambiguousSettle: number
  totalSettle: number
  splitLisExpected: number // 应按 LIS 蜡块拆的病例组数
  splitLisMissing: number // 其中缺蜡块、已按账单数量降级估算的组数（完整度提示）
  byLine: LineRevenue[]
  counts: { total: number; in: number; out: number; split: number; diagnosis: number; unmatched: number; ambiguous: number }
}

export interface AttentionRow { no: string; item: string; settle: number; status: 'unmatched' | 'ambiguous' }

export interface PreviewResult {
  partnerId: string
  configVersion: number
  template: string
  serviceMonth: string | null
  declaredTotal: number | null
  revenue: PreviewRevenue
  score: ImportScore
  needsAttention: AttentionRow[]
  // 汇总/利润表模板时（无逐 case）
  note?: string
  parsed?: unknown
}

export interface CommitResult {
  partnerId: string
  serviceMonth: string
  configVersion: number
  importBatch: string
  caseCount: number
  labRevenue: number
  diagnosisSettle: number
  outSettle: number
  unmatchedSettle: number
  ambiguousSettle: number
  skippedNoCase: number
  splitLisExpected: number
  splitLisMissing: number
}
