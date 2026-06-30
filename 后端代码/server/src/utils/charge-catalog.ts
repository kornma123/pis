/**
 * 收费目录（charge catalog）—— v1「常见档」种子 + DB 落库/读取。
 *
 * 数据来源：上海·申康《20260605 病理类项目收费代码-YZ.xlsx》新增 81 码 → 33 服务项目，
 * 本文件取其中真实数据（LIS 数量列）会驱动的「常见档」子集，价格逐条照抄目录。
 *
 * ⛔ 红线：本目录服务【收入侧】(实验室收入 = 财务实收 × 引擎技术占比)，
 *    与【成本侧】(`fee_standards` / `cost-calculator.ts` / ABC 引擎) **完全独立**，互不读写。
 *
 * v1 常见档已含：诊断 / 组织·细胞·分子·冷冻 标本处理 / IHC 常规·增强 / 多重染色 / 特染 / 原位杂交(化学探针) / 切片复制 / 取材。
 *   （冷冻处理 080000 / 多重染色 120001 按用户 2026-06-27 确认"该院做且占比不小"补入，院内、走 LIS，价格照 v5.2 附录。）
 *   （分子病理处理 060000 = 院内分子受理/处理费，留作目录有效码 + v2 账单码分类用，不由 LIS 数量列驱动。）
 * 🚫 NGS 基因检测大 panel（结直肠/胃/肺癌等个性化用药套餐，¥1350+/单）= 【外包第三方的外购转销业务、独立渠道、不经 LIS】，
 *    既不在本收费目录(占比估算)、也不在 ABC 内部成本引擎 → 见独立模块 `ngs-pnl.ts`（毛利 = 售价 − 外包成本/协议价）。
 * 仍待 v2 增量补编：FISH 多探针·分子测序【检测费】(若有院内自做部分)、电镜、远程诊断、AI 辅助扩展。
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
    // ⚠️ capAddon:144 为【待核对的假定值】(=basePrice 72×2，沿用常规费 cap=base×2 范式)：
    //    v5.2 附录与沟通记录均未注明复杂处理费封顶，需回原始《YZ.xlsx》核对（确认无封顶则删 capAddon）。
    rule: { kind: 'tiered_increment', baseQty: 5, basePrice: 72, stepQty: 1, stepPrice: 14, capAddon: 144 } },
  { code: '012100000050000', name: '病理标本处理费(细胞病理)', unit: '每玻片', category: '技术',
    rule: { kind: 'flat', unitPrice: 75 } },
  { code: '012100000090000', name: '细胞病理蜡块制作费', unit: '每蜡块', category: '技术',
    rule: { kind: 'flat', unitPrice: 40 } },
  // 院内分子病理受理/处理费（¥100/次，固定）。仅院内自做处理时适用；不由 LIS 数量列驱动。
  //   ⚠️ NGS 基因检测大 panel（¥1350+/单）是外包转销，走独立模块 ngs-pnl.ts，与此 ¥100 处理费无关。
  { code: '012100000060000', name: '分子病理标本处理费', unit: '次', category: '技术',
    rule: { kind: 'flat', unitPrice: 100 } },
  // 术中冷冻标本处理费（≤5块¥94/块，>5块每增1块+¥18）。封顶待核：v5.2 附录未注明，回原始《YZ.xlsx》确认（确有则补 capAddon）。
  { code: '012100000080000', name: '冷冻标本处理费', unit: '每蜡块', category: '技术',
    rule: { kind: 'tiered_increment', baseQty: 5, basePrice: 94, stepQty: 1, stepPrice: 18 } },

  // —— 技术·染色 / 杂交 ——
  { code: '012100000120000', name: '病理样本免疫组织化学染色检查费(常规)', unit: '每切片', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 205 }, { from: 4, to: 12, unitPrice: 210 }, { from: 13, to: null, unitPrice: 105 }] } },
  // 多重染色（双染/三染：单张切片≥2 抗体，按"片"计；镜像 IHC 常规价×2 阶梯）。
  //   ⚠️ 判据=「单条免组记录抗体数≥2」，qty=多重染色【切片数】(双染通常 1 片/记录)，非抗体数；上游须把多重染色切片从 ihcCount 剔除（替换非叠加）。
  { code: '012100000120001', name: '多重染色费', unit: '每切片', category: '技术',
    rule: { kind: 'stepped', tiers: [{ from: 1, to: 3, unitPrice: 410 }, { from: 4, to: 12, unitPrice: 420 }, { from: 13, to: null, unitPrice: 210 }] } },
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
  // rule_json 坏行（人工误改/脏迁移）逐条跳过，不让一行坏数据使整个 P&L 接口 500
  const defs: ChargeCodeDef[] = []
  for (const r of rows) {
    try {
      defs.push(rowToChargeDef(r))
    } catch {
      console.warn(`charge_codes: 跳过无法解析的 rule_json，code=${r.code}`)
    }
  }
  return buildCatalog(defs)
}

/** 引擎用内存目录（不连 DB 时的回退/单测用）：直接从种子构建。 */
export function buildSeedCatalog(): Map<string, ChargeCodeDef> {
  return buildCatalog(CHARGE_CODE_SEED)
}
