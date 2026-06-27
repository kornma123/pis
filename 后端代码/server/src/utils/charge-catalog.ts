/**
 * 收费目录（charge catalog）—— v1「常见档」种子 + DB 落库/读取。
 *
 * 数据来源：上海·申康《20260605 病理类项目收费代码-YZ.xlsx》新增 81 码 → 33 服务项目，
 * 本文件取其中真实数据（LIS 数量列）会驱动的「常见档」子集，价格逐条照抄目录。
 *
 * ⛔ 红线：本目录服务【收入侧】(实验室收入 = 财务实收 × 引擎技术占比)，
 *    与【成本侧】(`fee_standards` / `cost-calculator.ts` / ABC 引擎) **完全独立**，互不读写。
 *
 * 全量 33 目录（含分子/测序/FISH 多探针/电镜/远程/术中冷冻/AI 扩展）待真实出现时增量补编，
 * 其中 FISH 多探针「每切片·每探针 + 多探针加收封顶」需引擎 multi_driver 扩展（v2，本期不在 LIS 数量列）。
 */

import { ChargeCodeDef, ChargeRule, buildCatalog } from './charge-engine.js'

/** v1 收费目录种子。code = 国家码（与目录一致）；rule 价格逐条取自目录。 */
export const CHARGE_CODE_SEED: ChargeCodeDef[] = [
  // —— 诊断（按 HE 切片数计价；同蜡块多切片按1张已由上游计数；≤10张¥105，每+10张+¥42，最高+¥84）——
  { code: '012100000010000', name: '病理诊断费', unit: '次', category: '诊断',
    rule: { kind: 'tiered_increment', baseQty: 10, basePrice: 105, stepQty: 10, stepPrice: 42, capAddon: 84 } },

  // —— 技术·标本处理（组织/细胞分流）——
  { code: '012100000030000', name: '病理标本处理费(组织病理-常规)', unit: '每蜡块', category: '技术',
    rule: { kind: 'tiered_increment', baseQty: 3, basePrice: 36, stepQty: 1, stepPrice: 7, capAddon: 72 } },
  { code: '012100000040000', name: '病理标本处理费(组织病理-复杂)', unit: '每蜡块', category: '技术',
    rule: { kind: 'tiered_increment', baseQty: 5, basePrice: 72, stepQty: 1, stepPrice: 14, capAddon: 144 } },
  { code: '012100000050000', name: '病理标本处理费(细胞病理)', unit: '每玻片', category: '技术',
    rule: { kind: 'flat', unitPrice: 75 } },
  { code: '012100000090000', name: '细胞病理蜡块制作费', unit: '每蜡块', category: '技术',
    rule: { kind: 'flat', unitPrice: 40 } },

  // —— 技术·染色 / 杂交 ——
  { code: '012100000120000', name: '病理样本免疫组织化学染色检查费(常规)', unit: '每切片', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 205 }, { from: 4, to: 12, unitPrice: 210 }, { from: 13, to: null, unitPrice: 105 }] } },
  { code: '012100000130000', name: '病理样本免疫组织化学染色检查费(增强)', unit: '每切片', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 650 }, { from: 4, to: null, unitPrice: 655 }] } },
  { code: '012100000110000', name: '病理样本化学染色检查费(特殊染色及酶组织化学染色诊断)', unit: '每切片', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 80 }, { from: 4, to: null, unitPrice: 85 }] } },
  // 原位核酸杂交·化学探针（CISH，如 EBER）：单位「每切片·每探针」；v1 单探针 → qty = 切片数（探针数=1，由上游相乘）
  { code: '012100000140000', name: '原位核酸杂交检测费(化学探针)', unit: '每切片·每探针', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 223 }, { from: 4, to: null, unitPrice: 228 }] } },

  // —— 技术·切片复制（第1-3 ¥7 / 第4起 ¥12 / 同患者每次最高 ¥165）——
  { code: '012100000100000', name: '病理标本切片复制费', unit: '每切片', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 7 }, { from: 4, to: null, unitPrice: 12 }], capTotal: 165 } },

  // —— 取材（不在 LIS 数量列；仅含诊断/取材范围的医院按 service_scope 取用，价格 flat 按部位变体）——
  { code: '011201000010000', name: '活检取材费(钳夹)', unit: '次', category: '取材', rule: { kind: 'flat', unitPrice: 113 } },
  { code: '011201000020000', name: '活检取材费(Ⅰ类穿刺)', unit: '次', category: '取材', rule: { kind: 'flat', unitPrice: 50 } },
  { code: '011201000030000', name: '活检取材费(Ⅱ类穿刺)', unit: '次', category: '取材', rule: { kind: 'flat', unitPrice: 124 } },
  { code: '011201000040000', name: '活检取材费(Ⅲ类穿刺)', unit: '次', category: '取材', rule: { kind: 'flat', unitPrice: 360 } },
  { code: '011201000050000', name: '活检取材费(Ⅳ类穿刺)', unit: '次', category: '取材', rule: { kind: 'flat', unitPrice: 140 } },
  { code: '011201000070000', name: '活检取材费(经皮介入)', unit: '次', category: '取材', rule: { kind: 'flat', unitPrice: 250 } },
  { code: '011201000080000', name: '活检取材费(内镜下)', unit: '次', category: '取材', rule: { kind: 'flat', unitPrice: 200 } },
]

/** charge_codes 表行结构（rule 以 JSON 持久化，type 冗余存便于查询/校验） */
export interface ChargeCodeRow {
  code: string
  name: string
  unit: string
  category: string
  rule_type: string
  rule_json: string
}

export function chargeDefToRow(def: ChargeCodeDef): ChargeCodeRow {
  return { code: def.code, name: def.name, unit: def.unit, category: def.category, rule_type: def.rule.kind, rule_json: JSON.stringify(def.rule) }
}

export function rowToChargeDef(row: ChargeCodeRow): ChargeCodeDef {
  return { code: row.code, name: row.name, unit: row.unit, category: row.category as ChargeCodeDef['category'], rule: JSON.parse(row.rule_json) as ChargeRule }
}

/**
 * 从 DB 读取启用中的收费目录 → 引擎可用的 Map。
 * db 为 node:sqlite DatabaseSync（或任何有 prepare().all() 的兼容对象）。
 */
export function loadChargeCatalog(db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } }): Map<string, ChargeCodeDef> {
  const rows = db
    .prepare(`SELECT code, name, unit, category, rule_type, rule_json FROM charge_codes WHERE status = 'active'`)
    .all() as ChargeCodeRow[]
  return buildCatalog(rows.map(rowToChargeDef))
}

/** 引擎用内存目录（不连 DB 时的回退/单测用）：直接从种子构建。 */
export function buildSeedCatalog(): Map<string, ChargeCodeDef> {
  return buildCatalog(CHARGE_CODE_SEED)
}
