/**
 * NGS 基因检测【外购转销】P&L —— 纯函数。
 *
 * 业务模型（用户 2026-06-27 确认）：分子病理 NGS 大 panel 外包给第三方做：
 *  - 成本 = 外包采购价（目录"协议价"，如 ¥1350）= 【外购直接成本】，**不在 ABC 内部成本引擎**。
 *  - 收入 = 卖给合作医院的售价，走【独立渠道】（非 LIS、非院内对账单）。
 *  - 单单毛利 = 售价 − 外包成本；院级 NGS 毛利 = Σ 单单毛利。
 *
 * ⚠️ 截图目录仅作参考，实际每单售价/外包成本可能不同 → 以导入的真实订单值为准（本模块只认订单行）。
 * ⛔ 红线：与 charge-catalog（院内占比估算）、ABC 成本引擎 完全独立，互不读写。纯函数、无 DB/express 依赖。
 */

export interface NgsOrderRaw {
  [key: string]: unknown
}

/** 规范化后的一条 NGS 订单 */
export interface NgsOrder {
  orderNo: string
  partnerName: string
  productName: string
  sellPrice: number // 给医院售价（收入）
  outsourceCost: number // 外包成本（协议价/实际）
  margin: number // 售价 − 外包成本
  orderMonth: string // YYYY-MM
}

/** 按医院上卷的 NGS P&L */
export interface NgsPartnerRollup {
  partnerName: string
  orderCount: number
  revenueTotal: number
  costTotal: number
  marginTotal: number
  marginRate: number // marginTotal / revenueTotal
}

export interface NgsAggregate {
  orders: NgsOrder[]
  partners: NgsPartnerRollup[]
  summary: {
    orderCount: number
    revenueTotal: number
    costTotal: number
    marginTotal: number
    marginRate: number
    partnerNames: string[]
    orderMonths: string[]
    skippedRows: number
    /** 售价 < 外包成本（亏本单）的条数，诚实暴露不静默 */
    negativeMarginCount: number
    /** 外包成本缺失(≤0)的订单数：毛利会被错误高估为售价，需补成本（Codex 审查 HIGH） */
    missingCostCount: number
    /** 售价缺失(≤0)的订单数 */
    missingPriceCount: number
    /** 缺订单号或产品名的订单数（无法幂等 upsert，导入时会跳过；Codex 审查 HIGH） */
    missingKeyCount: number
  }
}

// —— 容忍中文表头 / 英文键的字段别名 —— //
const FIELD: Record<string, string[]> = {
  orderNo: ['订单号', '病理号', '样本编号', '检测编号', 'orderNo', 'order_no'],
  partnerName: ['送检医院', '合作医院', '医院', 'partnerName', 'hospital'],
  productName: ['产品名称', '检测项目', '套餐', '项目名称', 'productName'],
  // 收入：医院付给我们的售价（开单/销售）
  sellPrice: ['销售价', '售价', '开单金额', '收入', '医院价', 'sellPrice'],
  // 成本：付给第三方的外包价（协议价）
  outsourceCost: ['外包成本', '协议价', '采购价', '成本', 'outsourceCost'],
  orderMonth: ['月份', '计费时间', '报告时间', '送检日期', '日期', 'orderMonth', 'order_month'],
}

function raw(row: NgsOrderRaw, key: string): unknown {
  for (const k of FIELD[key] || [key]) if (row[k] != null && row[k] !== '') return row[k]
  return undefined
}
function str(row: NgsOrderRaw, key: string): string {
  const v = raw(row, key)
  return v == null ? '' : String(v).trim()
}
function num(row: NgsOrderRaw, key: string): number {
  const v = raw(row, key)
  if (v == null) return 0
  const n = parseFloat(String(v).replace(/[¥,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000

/** 服务月解析：容忍 'YYYY-M(-D)'/'YYYY/M/D'/Date/Excel 序列号；无法识别返回 ''。 */
function monthOf(v: unknown): string {
  if (v == null || v === '') return ''
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`
  const s = String(v).trim()
  const m = s.match(/(\d{4})[-/](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`
  const serial = Number(s)
  if (Number.isFinite(serial) && serial > 30000 && serial < 90000) {
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }
  return ''
}

/** 明细行判定：有医院 + (有产品名 或 有售价/成本金额)。过滤表头/小计/空行。 */
function isOrderRow(row: NgsOrderRaw): boolean {
  if (str(row, 'partnerName') === '') return false
  return str(row, 'productName') !== '' || num(row, 'sellPrice') > 0 || num(row, 'outsourceCost') > 0
}

export function normalizeNgsOrder(row: NgsOrderRaw): NgsOrder {
  const sellPrice = round2(num(row, 'sellPrice'))
  const outsourceCost = round2(num(row, 'outsourceCost'))
  return {
    orderNo: str(row, 'orderNo'),
    partnerName: str(row, 'partnerName'),
    productName: str(row, 'productName'),
    sellPrice,
    outsourceCost,
    margin: round2(sellPrice - outsourceCost),
    orderMonth: monthOf(raw(row, 'orderMonth')),
  }
}

/** 解析 + 聚合：返回逐单、按医院上卷、汇总。纯函数，不碰 DB。 */
export function aggregateNgsOrders(rows: NgsOrderRaw[]): NgsAggregate {
  const orders: NgsOrder[] = []
  let skipped = 0
  for (const row of rows) {
    if (isOrderRow(row)) orders.push(normalizeNgsOrder(row))
    else skipped++
  }

  const byPartner = new Map<string, NgsPartnerRollup>()
  for (const o of orders) {
    let p = byPartner.get(o.partnerName)
    if (!p) {
      p = { partnerName: o.partnerName, orderCount: 0, revenueTotal: 0, costTotal: 0, marginTotal: 0, marginRate: 0 }
      byPartner.set(o.partnerName, p)
    }
    p.orderCount++
    p.revenueTotal = round2(p.revenueTotal + o.sellPrice)
    p.costTotal = round2(p.costTotal + o.outsourceCost)
    p.marginTotal = round2(p.marginTotal + o.margin)
  }
  const partners = [...byPartner.values()].map((p) => ({
    ...p,
    marginRate: p.revenueTotal > 0 ? round4(p.marginTotal / p.revenueTotal) : 0,
  }))

  const revenueTotal = round2(orders.reduce((s, o) => s + o.sellPrice, 0))
  const costTotal = round2(orders.reduce((s, o) => s + o.outsourceCost, 0))
  const marginTotal = round2(revenueTotal - costTotal)
  return {
    orders,
    partners,
    summary: {
      orderCount: orders.length,
      revenueTotal,
      costTotal,
      marginTotal,
      marginRate: revenueTotal > 0 ? round4(marginTotal / revenueTotal) : 0,
      partnerNames: [...new Set(orders.map((o) => o.partnerName).filter(Boolean))],
      orderMonths: [...new Set(orders.map((o) => o.orderMonth).filter(Boolean))],
      skippedRows: skipped,
      negativeMarginCount: orders.filter((o) => o.margin < 0).length,
      missingCostCount: orders.filter((o) => o.outsourceCost <= 0).length,
      missingPriceCount: orders.filter((o) => o.sellPrice <= 0).length,
      missingKeyCount: orders.filter((o) => !o.orderNo || !o.productName).length,
    },
  }
}
