/**
 * 收费引擎（charge engine）—— 按收费代码规则 + case 实际数量，计算每个收费项的金额，
 * 再分类(诊断/技术/取材)求和 → 得"技术(实验室)占比"，用于把财务实收拆给实验室。
 *
 * 依据真实目录：上海·申康 病理类收费目录（新增81项 → 33 个国家码服务项目）。
 * 设计要点（用户确认）：
 *  - 价不是一个数，是按数量算的【规则】：基础量+基础价 / 增量步进+封顶 / 分段单价 / 多动因。
 *  - 比例永远用"新目录引擎 + LIS 数量"算 → 适用于任何医院(含旧码/私立，因只需 LIS 数量)。
 *  - 财务实收为金额真值；实验室收入 = 技术占比 × 实收。
 *
 * 纯函数、无 DB/express 依赖：目录(规则)由调用方传入（v1 内置 archetype 子集，全量经导入落 DB）。
 */

export type ChargeCategory = '诊断' | '技术' | '取材'

/** 一个收费项的计价规则 */
export type ChargeRule =
  // 固定单价：金额 = unitPrice × qty（如 细胞病理/电镜/蜡块制作/取材费）
  | { kind: 'flat'; unitPrice: number }
  // 基础量+增量步进+封顶：≤baseQty 收 basePrice；超出每 stepQty 加 stepPrice，加收封顶 capAddon
  //   （如 病理诊断费 ≤10张¥105/每+10张+¥42/最高+¥84；标本处理费 ≤3蜡块¥36/每+1+¥7/最高+¥72）
  | { kind: 'tiered_increment'; baseQty: number; basePrice: number; stepQty: number; stepPrice: number; capAddon?: number }
  // 分段单价：不同数量区间每单位价不同，逐单位累加，可选总额封顶 capTotal
  //   （如 IHC 第1-3片¥205/第4-12¥210/第13起¥105；切片复制 第1-3¥7/第4起¥12/最高¥165）
  | { kind: 'stepped'; tiers: Array<{ from: number; to: number | null; unitPrice: number }>; capTotal?: number }

export interface ChargeCodeDef {
  code: string            // 收费码（国家码 + 后缀归并后的"服务项目"键，或具体码）
  name: string
  unit: string            // 计价单位/动因（次/每蜡块/每切片/每玻片/每位点…）
  category: ChargeCategory
  rule: ChargeRule
}

/** 计算单个收费项金额：rule × 数量 qty（qty 为该计价单位的实际数量，计数规则由调用方在入参前处理，如"同蜡块多切片按1张"） */
export function computeCharge(rule: ChargeRule, qty: number): number {
  if (qty <= 0) return 0
  switch (rule.kind) {
    case 'flat':
      return round2(rule.unitPrice * qty)
    case 'tiered_increment': {
      if (qty <= rule.baseQty) return round2(rule.basePrice)
      const steps = Math.ceil((qty - rule.baseQty) / rule.stepQty)
      let addon = steps * rule.stepPrice
      if (rule.capAddon != null) addon = Math.min(addon, rule.capAddon)
      return round2(rule.basePrice + addon)
    }
    case 'stepped': {
      let total = 0
      for (let i = 1; i <= qty; i++) {
        const t = rule.tiers.find((t) => i >= t.from && (t.to == null || i <= t.to))
        if (t) total += t.unitPrice
      }
      if (rule.capTotal != null) total = Math.min(total, rule.capTotal)
      return round2(total)
    }
  }
}

/** case 内一个收费项的实际发生（哪个收费码 + 数量） */
export interface CaseChargeItem {
  code: string
  qty: number
}

export interface CaseSplit {
  byCategory: Record<ChargeCategory, number>
  total: number
  /** 未在目录命中的收费项数（>0 → 占比被低估，调用方应标数据缺口，不可静默） */
  unmatchedCount: number
  /** 技术(实验室)占比 = 技术 / total（total=0 时为 0） */
  techRatio: number
  /** 诊断占比、取材占比（供含诊断/取材的医院取对应组分） */
  diagnosisRatio: number
  grossingRatio: number
  /** 命中的收费码（调试/可解释） */
  resolved: Array<{ code: string; category: ChargeCategory; qty: number; amount: number; matched: boolean }>
}

/**
 * 对一个 case 的收费项组合：逐项按引擎算理论金额 → 分类求和 → 得各组分占比。
 * 用法：实验室收入 = techRatio × 财务实收（仅技术医院）；含诊断的医院再加 diagnosisRatio×实收。
 */
export function computeCaseSplit(items: CaseChargeItem[], catalog: Map<string, ChargeCodeDef>): CaseSplit {
  const byCategory: Record<ChargeCategory, number> = { 诊断: 0, 技术: 0, 取材: 0 }
  const resolved: CaseSplit['resolved'] = []
  for (const it of items) {
    const def = catalog.get(it.code)
    if (!def) {
      resolved.push({ code: it.code, category: '技术', qty: it.qty, amount: 0, matched: false })
      continue
    }
    const amount = computeCharge(def.rule, it.qty)
    byCategory[def.category] += amount
    resolved.push({ code: it.code, category: def.category, qty: it.qty, amount, matched: true })
  }
  const total = byCategory.诊断 + byCategory.技术 + byCategory.取材
  const ratio = (n: number) => (total > 0 ? n / total : 0)
  return {
    byCategory,
    total: round2(total),
    unmatchedCount: resolved.filter((r) => !r.matched).length,
    techRatio: ratio(byCategory.技术),
    diagnosisRatio: ratio(byCategory.诊断),
    grossingRatio: ratio(byCategory.取材),
    resolved,
  }
}

/** 按名称分类（诊断费→诊断；取材费→取材；其余技术）。供目录导入时给每个码打分类。 */
export function classifyByName(name: string): ChargeCategory {
  if (name.includes('取材费')) return '取材'
  if (name.includes('诊断费')) return '诊断'
  return '技术'
}

export function buildCatalog(defs: ChargeCodeDef[]): Map<string, ChargeCodeDef> {
  return new Map(defs.map((d) => [d.code, d]))
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
