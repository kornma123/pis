/**
 * 收入归属「两层模型」—— 预埋骨架（2026-06-27）。
 *
 * ⛔ 已废弃（DEPRECATED，2026-06-28，P2）：本「业务线 × 归属方法(A/B/C)」seam **从未接入真实计算路径**，
 *    已被【配置驱动分类引擎】取代——`utils/classifier.ts`（逐院 config.lines 前缀/关键词分类 IN/OUT）+
 *    `utils/statement-revenue.ts`（实验室收入 = Σ(IN 结算)）。新代码一律走分类引擎，勿再用本模块。
 *    保留此文件仅作历史参考（BusinessLine 枚举尚被 lis_cases 列与少量类型引用），后续可整体删除。
 *
 * ⚠️ 原预埋说明（历史）：本模块只定义【模型骨架 + 类型 + 暂定映射 + 解析 seam】，
 *    **当前不被 computeCasePnl 等真实计算路径读取，零行为变更、零回归**。
 *
 * —— 背景（用户 2026-06-27 两轮纠正）——
 * 「实验室收入 = 哪部分钱算我们的」不是一条固定技术占比，而是【两层】：
 *   第一层 业务线（检测类别）→ 决定用哪种【归属方法】；
 *   第二层（仅方法 A）→ 该 case「我们实际做了哪几步」的步骤范围，实验室收入 = 我们做的步骤收费之和占比 × 实收。
 *
 * 归属方法（收敛为 3 种；原 D 会诊费已并入 A，因外院会诊实为「送蜡块来、我们加做免疫组化/分子」）：
 *   A bill_ratio  账单占比（走步骤范围）：组织学 / 细胞病理 / 宫颈液基 / 冰冻 / 外院会诊。
 *   B standalone  单项检测费·整笔（院内自做即整笔归我们）：院内分子 / FISH（若院内）。
 *   C resale      外送转销（售价 − 外包成本，已独立 ngs-pnl.ts）：NGS 大 panel / HPV-E6E7（外送）。
 *
 * 数据怎么定（用户点 2 两步校对）：① 业务线 + 医院协议预设默认 → ② 财务收费码/账单校正；
 *   账单只有统计数字、无逐码时退化为「估算」显式标注，不假装精确（增量纠错架构）。
 * 病例级覆盖（用户点 1）：合同（如包干）只是默认，单病例患者可能已在外院做过 → 只送蜡块/切片 → 退化为代送加做。
 */

/** 检测业务线（检测类别）。'unknown' = 未标注/历史数据；'outsourced_generic' = 泛指外送。 */
export type BusinessLine =
  | 'histology'        // 组织学
  | 'cytology'         // 细胞病理
  | 'cervical_lbc'     // 宫颈液基（TCT）
  | 'frozen'           // 冰冻手术（院内做，收费暂不在 LIS）
  | 'consultation'     // 外院会诊（送蜡块来，我们加做免疫组化/分子 → 实为 A 代送加做）
  | 'molecular_inhouse'// 分子病理·院内自做
  | 'fish'             // FISH（院内/外送待对账单确认）
  | 'ngs_outsourced'   // 分子·NGS 大 panel（外包转销，独立 ngs-pnl.ts）
  | 'hpv_e6e7'         // HPV-E6E7（外送转销）
  | 'unknown'

/** 收入归属方法。 */
export type AttributionMethod =
  | 'bill_ratio'  // A 账单占比（走步骤范围）
  | 'standalone'  // B 单项检测费·整笔（院内自做）
  | 'resale'      // C 外送转销（售价 − 外包成本）

/** 方法 A 的工艺步骤（步骤范围的元素）。组织学全链；其它线按需取子集。边界待用户确认/对账单校正。 */
export type ServiceStep =
  | 'grossing'      // 取材
  | 'embedding'     // 制片 · 蜡块
  | 'sectioning_he' // 切片 · HE 染色
  | 'special_ihc'   // 加做染色（特殊 / 免疫组化 / 原位）
  | 'molecular'     // 分子（院内加做，如外院会诊场景）
  | 'diagnosis'     // 诊断 · 报告

/**
 * 业务线 → 归属方法 暂定映射。
 * ⚠️ 暂定值（待 2026-06-28 对账单校正）。FISH 暂按外送转销保守处理，确认院内自做后改 'standalone'。
 */
export const LINE_ATTRIBUTION: Readonly<Record<BusinessLine, AttributionMethod>> = {
  histology: 'bill_ratio',
  cytology: 'bill_ratio',
  cervical_lbc: 'bill_ratio',
  frozen: 'bill_ratio',
  consultation: 'bill_ratio',
  molecular_inhouse: 'standalone',
  fish: 'resale',
  ngs_outsourced: 'resale',
  hpv_e6e7: 'resale',
  unknown: 'bill_ratio', // 未标注 → 沿用既有 computeCasePnl 行为（账单占比），保持零回归
}

/**
 * 解析 seam：给定业务线 → 归属方法。
 * 预埋期：未标注 business_line（null/undefined/unknown）一律回退 'bill_ratio'，
 * 即【完全等价于现状 computeCasePnl 路径】，确保零行为变更。明天接真实逻辑只需替换调用点。
 */
export function resolveAttribution(line: BusinessLine | null | undefined): AttributionMethod {
  if (!line) return LINE_ATTRIBUTION.unknown
  return LINE_ATTRIBUTION[line] ?? LINE_ATTRIBUTION.unknown
}

/** 该方法的实验室收入是否走「步骤范围」（仅 A）。供明天的计算分支与前端展示用。 */
export function usesStepScope(method: AttributionMethod): boolean {
  return method === 'bill_ratio'
}
