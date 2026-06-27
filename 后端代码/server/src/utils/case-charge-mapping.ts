/**
 * LIS case「基础数量列」→ 收费项组合（CaseChargeItem[]）。
 *
 * 真实 LIS 导出（病例导出文档）每 case 只给基础数量列，无「检测项目名」，
 * 所以模板是【数量列 → 收费码】的全局映射（非「项目名→码」）。下游 computeCaseSplit 据此算技术占比。
 *
 * 映射口径已与用户锁定（2026-06-27，见 docs/COREONE-按医院成本盈利-真实样例数据分析-2026-06-27.md §F）：
 *  - 病理诊断费 ← HE切片数（tiered_increment）
 *  - 蜡块处理费 ← 蜡块数，按样本类型分流：细胞学(关键词判)→细胞蜡块制作+细胞处理；组织→组织常规
 *  - IHC常规 ← 免疫组化数；IHC增强 ← PD-L1数；特殊染色 ← 特染数；原位杂交(化学探针) ← EBER数
 */

import { CaseChargeItem } from './charge-engine.js'

// tissue=组织常规 / tissue_complex=组织复杂(大器官切除·恶性肿瘤根治，需人工指定) / cytology=细胞学
export type SpecimenType = 'tissue' | 'tissue_complex' | 'cytology'

/** LIS case 的基础数量（字段名对齐导出列语义） */
export interface LisCaseQty {
  heSlideCount: number      // HE切片数
  blockCount: number        // 蜡块数
  ihcCount: number          // 免疫组化数
  specialStainCount: number // 特染数
  eberCount: number         // EBER数
  pdl1Count: number         // PD-L1数
  /** 若已知/人工指定则直接用；否则由 detectSpecimenType 推断 */
  specimenType?: SpecimenType
}

// 收费码常量（与 charge-catalog.ts 种子一致）
export const CHARGE_CODE = {
  DIAGNOSIS: '012100000010000',
  PROC_TISSUE_STD: '012100000030000',
  PROC_TISSUE_CX: '012100000040000',
  PROC_CYTOLOGY: '012100000050000',
  CYTOLOGY_BLOCK: '012100000090000',
  IHC_STD: '012100000120000',
  IHC_ENHANCED: '012100000130000',
  SPECIAL_STAIN: '012100000110000',
  ISH_CHEMICAL: '012100000140000',
} as const

/**
 * 细胞学样本关键词（送检部位/大体描述/亚专科任一命中 → 细胞学）。
 * ⚠️ 故意用「积液/胸水/腹水/细胞蜡块/涂片」等**强指示**词，避免裸「胸腔/腹腔」误杀
 * 「腹腔镜活检/胸壁穿刺」等实体组织（对抗审查 HIGH 项修复，2026-06-27）。
 */
export const CYTOLOGY_KEYWORDS = [
  '胸水', '腹水', '积液', '脑脊液', '心包积液', '盆腔积液',
  '细胞蜡块', '涂片', '液基', '灌洗液', '囊液', '穿刺液', '细胞学', '痰液',
]

/** 关键词推断样本类型（用户锁定：自动判 + 可人工改）。无命中默认组织常规。复杂组织(tissue_complex)需人工指定。 */
export function detectSpecimenType(fields: { 送检部位?: string | null; 大体描述?: string | null; 亚专科?: string | null }): SpecimenType {
  const hay = [fields.送检部位, fields.大体描述, fields.亚专科].filter(Boolean).join(' ')
  return CYTOLOGY_KEYWORDS.some((k) => hay.includes(k)) ? 'cytology' : 'tissue'
}

/**
 * 把 case 基础数量映射成收费项组合。仅对 >0 的数量产出收费项（计数为 0 不计费）。
 * 注：细胞学处理费(¥75/玻片) v1 以「玻片≈蜡块数」近似，待用户用真实玻片数校正（软边界）。
 */
export function mapCaseToCharges(q: LisCaseQty): CaseChargeItem[] {
  const items: CaseChargeItem[] = []

  // 诊断：HE切片数
  if (q.heSlideCount > 0) items.push({ code: CHARGE_CODE.DIAGNOSIS, qty: q.heSlideCount })

  // 标本处理：蜡块数，按样本类型分流
  if (q.blockCount > 0) {
    const specimen = q.specimenType ?? 'tissue'
    if (specimen === 'cytology') {
      items.push({ code: CHARGE_CODE.CYTOLOGY_BLOCK, qty: q.blockCount }) // 细胞蜡块制作 ¥40/块
      items.push({ code: CHARGE_CODE.PROC_CYTOLOGY, qty: q.blockCount })  // 细胞处理 ¥75/玻片（≈块，待校正）
    } else if (specimen === 'tissue_complex') {
      items.push({ code: CHARGE_CODE.PROC_TISSUE_CX, qty: q.blockCount })  // 组织复杂 ¥72/5块…（人工指定）
    } else {
      items.push({ code: CHARGE_CODE.PROC_TISSUE_STD, qty: q.blockCount }) // 组织常规 ¥36/3块…
    }
  }

  // 染色 / 杂交
  if (q.ihcCount > 0) items.push({ code: CHARGE_CODE.IHC_STD, qty: q.ihcCount })
  if (q.pdl1Count > 0) items.push({ code: CHARGE_CODE.IHC_ENHANCED, qty: q.pdl1Count })
  if (q.specialStainCount > 0) items.push({ code: CHARGE_CODE.SPECIAL_STAIN, qty: q.specialStainCount })
  if (q.eberCount > 0) items.push({ code: CHARGE_CODE.ISH_CHEMICAL, qty: q.eberCount })

  return items
}
