/**
 * 财务收费单据（对账单）→ 逐 case 实收聚合。W4 收入金额真值导入器（code-agnostic）。
 *
 * 真实文件：`单据…号收费单据.xls`（HTML 伪 .xls，前端 SheetJS 解析成 JSON 行后 POST）。
 * 列：序号|病理号|送检医院|登记类型|标本名称|收费项目|收费代码|单价|数量|单位|计费金额|扣率|开单金额|计费时间。
 *
 * 锁定口径（2026-06-27，见 docs/…真实样例数据分析…§B）：
 *  - **开单金额 = 计费金额 × 扣率 = 折后实收** → 逐 case 实收 = Σ 明细行开单金额。
 *  - **code-agnostic**：收费代码是旧码/院定制码，**不解析其语义**；原始明细行原样存(备 v2 逐码核对)。
 *  - 病理号为 join key；服务月取计费时间 YYYY-MM；扣率 per 行存下(v2 扣率分析)。
 *  - 跳过「小计」「未收金额」等非明细噪声行（序号非数字 / 病理号='小计'）。
 */

export interface BillingRawRow {
  [key: string]: unknown
}

/** 规范化后的一条收费明细行 */
export interface BillingLine {
  caseNo: string
  partnerName: string
  registrationType: string
  specimenName: string
  chargeItem: string
  chargeCode: string
  unitPrice: number
  qty: number
  unit: string
  grossAmount: number // 计费金额（折前）
  discountRate: number // 0..1（开单金额/计费金额）
  netAmount: number // 开单金额（折后实收）
  chargeTime: string
  serviceMonth: string // YYYY-MM
}

/** 逐 case 聚合实收 */
export interface CaseRevenue {
  caseNo: string
  partnerName: string
  grossAmount: number
  netAmount: number
  discountRate: number // netAmount / grossAmount
  serviceMonth: string
  lineCount: number
}

export interface BillingAggregate {
  lines: BillingLine[]
  cases: CaseRevenue[]
  summary: {
    caseCount: number
    lineCount: number
    grossTotal: number
    netTotal: number
    discountRate: number
    partnerNames: string[]
    serviceMonths: string[]
    skippedRows: number
  }
}

// —— 取值帮手：容忍中文表头 / 规范化英文键，容忍 ¥ 千分位 % —— //
const FIELD: Record<string, string[]> = {
  seq: ['序号', 'seq'],
  caseNo: ['病理号', 'caseNo', 'case_no'],
  partnerName: ['送检医院', 'partnerName', 'hospital'],
  registrationType: ['登记类型', 'registrationType'],
  specimenName: ['标本名称', 'specimenName'],
  chargeItem: ['收费项目', 'chargeItem'],
  chargeCode: ['收费代码', 'chargeCode', 'code'],
  unitPrice: ['单价', 'unitPrice'],
  qty: ['数量', 'qty'],
  unit: ['单位', 'unit'],
  grossAmount: ['计费金额', 'grossAmount'],
  discount: ['扣率', 'discount', 'discountRate'],
  netAmount: ['开单金额', 'netAmount'],
  chargeTime: ['计费时间', 'chargeTime'],
}

function raw(row: BillingRawRow, key: string): unknown {
  for (const k of FIELD[key] || [key]) {
    if (row[k] != null && row[k] !== '') return row[k]
  }
  return undefined
}
function str(row: BillingRawRow, key: string): string {
  const v = raw(row, key)
  return v == null ? '' : String(v).trim()
}
function num(row: BillingRawRow, key: string): number {
  const v = raw(row, key)
  if (v == null) return 0
  const n = parseFloat(String(v).replace(/[¥,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}
/** 扣率：'80%'→0.8 / 0.8→0.8 / 80→0.8 / 空→NaN */
function parseDiscount(row: BillingRawRow): number {
  const v = raw(row, 'discount')
  if (v == null) return NaN
  const s = String(v).trim()
  if (!/[0-9]/.test(s)) return NaN
  const n = parseFloat(s.replace(/[%\s]/g, ''))
  if (!Number.isFinite(n)) return NaN
  return s.includes('%') || n > 1 ? n / 100 : n
}
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000
}

/**
 * 明细行判定：序号为数字 + 病理号非空非"小计" + (有收费代码 或 有金额)。
 * code-agnostic：允许无收费代码但有金额的人工调整/折扣/补退费行（否则会漏计 case 实收）。
 */
function isDetailRow(row: BillingRawRow): boolean {
  const seq = raw(row, 'seq')
  const caseNo = str(row, 'caseNo')
  if (!(seq != null && Number.isFinite(Number(seq))) || caseNo === '' || caseNo === '小计') return false
  return str(row, 'chargeCode') !== '' || num(row, 'grossAmount') > 0 || num(row, 'netAmount') > 0
}

/** 服务月解析：容忍 'YYYY-M(-D)'/'YYYY/M/D'/Date 对象/Excel 序列号；无法识别返回 ''。 */
function monthOf(v: unknown): string {
  if (v == null || v === '') return ''
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`
  const s = String(v).trim()
  const m = s.match(/(\d{4})[-/](\d{1,2})/) // 含单数字月
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`
  const serial = Number(s) // Excel 序列号（1899-12-30 起的天数）
  if (Number.isFinite(serial) && serial > 30000 && serial < 90000) {
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }
  return ''
}

export function normalizeLine(row: BillingRawRow): BillingLine {
  const gross = num(row, 'grossAmount')
  const net = num(row, 'netAmount')
  let discount = parseDiscount(row)
  if (!Number.isFinite(discount)) discount = gross > 0 ? round4(net / gross) : 0
  const chargeTime = str(row, 'chargeTime')
  return {
    caseNo: str(row, 'caseNo'),
    partnerName: str(row, 'partnerName'),
    registrationType: str(row, 'registrationType'),
    specimenName: str(row, 'specimenName'),
    chargeItem: str(row, 'chargeItem'),
    chargeCode: str(row, 'chargeCode'),
    unitPrice: num(row, 'unitPrice'),
    qty: num(row, 'qty'),
    unit: str(row, 'unit'),
    grossAmount: gross,
    discountRate: round4(discount),
    netAmount: net,
    chargeTime,
    serviceMonth: monthOf(raw(row, 'chargeTime') ?? chargeTime), // 用原值，支持 Date/Excel 序列号
  }
}

/** 解析 + 聚合：返回明细行、逐 case 实收、汇总。纯函数，不碰 DB。 */
export function aggregateBilling(rows: BillingRawRow[]): BillingAggregate {
  const lines: BillingLine[] = []
  let skipped = 0
  for (const row of rows) {
    if (isDetailRow(row)) lines.push(normalizeLine(row))
    else skipped++
  }

  // 聚合键 = (病理号, 服务月)，与 case_revenue UNIQUE(case_no, service_month) 一致；
  // 同一 case 跨月补收费/冲销不会被合并成一行、月份不会被首行吞掉。
  const byCase = new Map<string, CaseRevenue>()
  for (const ln of lines) {
    const key = `${ln.caseNo}|${ln.serviceMonth}`
    let c = byCase.get(key)
    if (!c) {
      c = { caseNo: ln.caseNo, partnerName: ln.partnerName, grossAmount: 0, netAmount: 0, discountRate: 0, serviceMonth: ln.serviceMonth, lineCount: 0 }
      byCase.set(key, c)
    }
    c.grossAmount = round2(c.grossAmount + ln.grossAmount)
    c.netAmount = round2(c.netAmount + ln.netAmount)
    c.lineCount++
    if (!c.serviceMonth && ln.serviceMonth) c.serviceMonth = ln.serviceMonth
  }
  const cases = [...byCase.values()].map((c) => ({ ...c, discountRate: c.grossAmount > 0 ? round4(c.netAmount / c.grossAmount) : 0 }))

  const grossTotal = round2(cases.reduce((s, c) => s + c.grossAmount, 0))
  const netTotal = round2(cases.reduce((s, c) => s + c.netAmount, 0))
  return {
    lines,
    cases,
    summary: {
      caseCount: cases.length,
      lineCount: lines.length,
      grossTotal,
      netTotal,
      discountRate: grossTotal > 0 ? round4(netTotal / grossTotal) : 0,
      partnerNames: [...new Set(lines.map((l) => l.partnerName).filter(Boolean))],
      serviceMonths: [...new Set(lines.map((l) => l.serviceMonth).filter(Boolean))],
      skippedRows: skipped,
    },
  }
}
