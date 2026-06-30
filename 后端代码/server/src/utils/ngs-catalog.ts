/**
 * NGS 基因检测【外购转销】产品目录 —— 参考种子 + DB 落库/读取。
 *
 * 配套 ngs-pnl.ts（外购转销 P&L）。本目录主要用于：①展示/分组产品；②为订单提供默认参考价。
 * ⚠️ 来自产品截图，仅作【参考/默认值】；实际每单售价/外包成本以 ngs_orders 落库真实值为准（截图与实际可能有差异）。
 * ⚠️ 本种子是截图中可见的 NGS 子集，非全量；「非NGS项目」页签 + 滚动外的行待补（可后续导入/补编）。
 * ⛔ 红线：与院内 charge-catalog（占比估算）、ABC 成本引擎 完全独立，互不读写。
 */

export interface NgsProductDef {
  productName: string
  category: 'NGS' | '非NGS'
  geneCount: string // '119基因'（保留文本，含"加强版,25基因"等变体）
  sampleType: string // 组织 / 组织/血液
  clinicalMeaning: string // 靶向+化疗+MSI+MMR
  turnaroundDays: number // 周期（天）
  guidePrice: number // 指导价（零售参考）
  agreementPrice: number // 协议价 = 外包成本（参考默认；实际以订单为准）
}

/** NGS 产品参考种子（取自 20260627 产品截图 NGS 项目页签可见行；价格照截图）。 */
export const NGS_PRODUCT_SEED: NgsProductDef[] = [
  { productName: '结直肠癌个性化用药套餐（119基因）', category: 'NGS', geneCount: '119基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '胃癌个性化用药套餐（112基因）', category: 'NGS', geneCount: '112基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '食管癌个性化用药套餐（107基因）', category: 'NGS', geneCount: '107基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '甲状腺癌核心用药基因检测（15基因）', category: 'NGS', geneCount: '15基因', sampleType: '组织', clinicalMeaning: '靶向+预后', turnaroundDays: 8, guidePrice: 4500, agreementPrice: 850 },
  { productName: '甲状腺癌个性化用药套餐（92基因）', category: 'NGS', geneCount: '92基因', sampleType: '组织', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '乳腺癌个性化用药套餐（135基因）', category: 'NGS', geneCount: '135基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '卵巢癌个性化用药套餐（118基因）', category: 'NGS', geneCount: '118基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '宫颈癌个性化用药套餐（96基因）', category: 'NGS', geneCount: '96基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '子宫内膜癌分型评估套餐（9基因）', category: 'NGS', geneCount: '9基因', sampleType: '组织/血液', clinicalMeaning: '靶向+分型+MSI', turnaroundDays: 8, guidePrice: 4500, agreementPrice: 850 },
  { productName: '子宫内膜癌分型评估套餐（加强版,25基因）', category: 'NGS', geneCount: '25基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+分型+MSI', turnaroundDays: 8, guidePrice: 5000, agreementPrice: 950 },
  { productName: '子宫内膜癌个性化用药套餐（96基因）', category: 'NGS', geneCount: '96基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+分型+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '黑色素瘤个性化用药套餐（107基因）', category: 'NGS', geneCount: '107基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '前列腺癌个性化用药套餐（119基因）', category: 'NGS', geneCount: '119基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '膀胱癌个性化用药套餐（103基因）', category: 'NGS', geneCount: '103基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '肾癌个性化用药套餐（102基因）', category: 'NGS', geneCount: '102基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '胆系肿瘤个性化用药套餐（94基因）', category: 'NGS', geneCount: '94基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '肝癌个性化用药套餐（103基因）', category: 'NGS', geneCount: '103基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '胰腺癌个性化用药套餐（117基因）', category: 'NGS', geneCount: '117基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
  { productName: '胃肠间质瘤个性化用药套餐（80基因）', category: 'NGS', geneCount: '80基因', sampleType: '组织/血液', clinicalMeaning: '靶向+化疗+MSI+MMR', turnaroundDays: 8, guidePrice: 8500, agreementPrice: 1350 },
]

export interface NgsProductRow {
  product_name: string
  category: string
  gene_count: string
  sample_type: string
  clinical_meaning: string
  turnaround_days: number
  guide_price: number
  agreement_price: number
}

export function ngsProductToRow(def: NgsProductDef): NgsProductRow {
  return {
    product_name: def.productName, category: def.category, gene_count: def.geneCount,
    sample_type: def.sampleType, clinical_meaning: def.clinicalMeaning,
    turnaround_days: def.turnaroundDays, guide_price: def.guidePrice, agreement_price: def.agreementPrice,
  }
}

/** 从 DB 读启用中的 NGS 产品目录 → Map<productName, def>。 */
export function loadNgsCatalog(db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } }): Map<string, NgsProductDef> {
  const rows = db.prepare(
    `SELECT product_name, category, gene_count, sample_type, clinical_meaning, turnaround_days, guide_price, agreement_price
     FROM ngs_products WHERE status = 'active'`,
  ).all() as NgsProductRow[]
  const map = new Map<string, NgsProductDef>()
  for (const r of rows) {
    map.set(r.product_name, {
      productName: r.product_name, category: (r.category as NgsProductDef['category']) || 'NGS',
      geneCount: r.gene_count, sampleType: r.sample_type, clinicalMeaning: r.clinical_meaning,
      turnaroundDays: Number(r.turnaround_days) || 0, guidePrice: Number(r.guide_price) || 0, agreementPrice: Number(r.agreement_price) || 0,
    })
  }
  return map
}
