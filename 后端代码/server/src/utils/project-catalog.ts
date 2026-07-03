/**
 * 统一检测项目目录（project catalog）—— D2 地基线 D。
 *
 * 背景：同一个检测项目在系统里有【四套/实为五套】叫法，彼此没有硬映射，全靠运行时关键词猜：
 *   1) 系统项目码  projects.code            例：IHC-042
 *   2) 新国标收费码 charge_codes.code(012…)  例：012100000120000
 *   2b) 老本地物价码（对账单上仍在用）        例：270300005      —— system='local_price_code'
 *   3) LIS 名（数量列 / markerName / adviceType） 例：免疫组化数 / Ki67 / Y000001
 *   4) 对账单名/码                          例：免疫组化检测（前八项）
 *
 * 本模块建一层【只读对照表】把这些叫法都对到同一个「标准项(真身)」：
 *   - project_catalog：一行 = 一个标准项（canonical_code = 新命名空间 PC-*，与现有码解耦）。
 *   - code_mappings  ：一行 = (某套叫法, 某别名值) → 指向哪个标准项（含置信度/复合数量/校对状态/来源留痕）。
 *
 * ⛔ 红线：这是【新增的只读翻译官】，**不改**任何现有分类逻辑（classifier.ts / case-charge-mapping.ts /
 *    statement-revenue.ts 一律不碰）。先并存、零行为改动 → 守黄金 ¥13,152 / ¥27,870 零回归。
 *    lookup 未命中一律返回 { matched:false }，**绝不抛错、绝不静默瞎猜**。
 *
 * 数据/PII 纪律：种子是从真数据（国标 81 码 / LIS 导出 / 19 院对账单）手工提炼的「映射知识」，
 *    写成代码常量提交；原始 xlsx 绝不进仓，只取项目名/码这类分析列，不碰患者信息。
 *
 * 落地口径（PM 拍板 2026-07-02）：全收真实项目词汇（变体靠 NFKC 归一）+ 复合行拆包（一名→多标准项+数量）
 *    + 自动分高/中/低三层：高置信直接锁(auto)、噪音自动剔除不映射、复合/中低置信进「待校对」队列(needs_review)。
 */

import type { DatabaseSync } from 'node:sqlite'
import { v4 as uuidv4 } from 'uuid'
import { CHARGE_CODE } from './case-charge-mapping.js'

// ───────────────────────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────────────────────

/** 标准项粗分类 */
export type CatalogCategory =
  | '诊断' | '制片' | '染色-免疫组化' | '染色-特殊' | '原位杂交'
  | '分子' | '细胞学' | '取材' | '切片复制' | '会诊' | '影像辅助' | '其他'

/** 别名来自哪套叫法 */
export type AliasSystem =
  | 'project_code' | 'guobiao_code' | 'local_price_code'
  | 'lis_name' | 'lis_advice_type' | 'statement_item'

export type Confidence = 'high' | 'medium' | 'low'
export type MatchType = 'exact' | 'keyword' | 'manual' | 'inferred'
/** 校对状态：auto=机器高置信可直接用 / needs_review=进待校对队列 / confirmed=人工确认 / rejected=人工否决 */
export type ReviewStatus = 'auto' | 'needs_review' | 'confirmed' | 'rejected'

export interface CatalogItem {
  canonicalCode: string
  canonicalName: string
  category: CatalogCategory
  physicalUnit: string | null
  note?: string
}

export interface CodeMappingRow {
  id: string
  system: AliasSystem
  aliasCode: string
  aliasNorm: string
  aliasLabel: string | null
  catalogCode: string // '' = 未映射（噪音/待确认）
  componentQty: number | null
  groupId: string | null
  confidence: Confidence
  matchType: MatchType
  reviewStatus: ReviewStatus
  source: string
  note: string | null
}

/** 一个别名分类后的结果分量（复合行会拆成多个分量） */
export interface ClassifiedComponent {
  catalogCode: string // '' = 未匹配
  componentQty: number | null
  confidence: Confidence
  matchType: MatchType
  reviewStatus: ReviewStatus
  reason?: 'noise' | 'no_match'
  note?: string
}

export interface LookupResult {
  matched: boolean
  input: string
  system?: AliasSystem
  catalog?: CatalogItem
  /** 命中/推断出的标准项（复合行可多个） */
  components?: Array<{ catalog: CatalogItem | null; catalogCode: string; componentQty: number | null; confidence: Confidence; reviewStatus: ReviewStatus }>
  reason?: 'no_mapping' | 'noise' | 'unmapped'
}

// ───────────────────────────────────────────────────────────────────────────
// 归一化 + 小工具
// ───────────────────────────────────────────────────────────────────────────

/** 匹配用归一：NFKC（全角→半角、兼容分解）+ 去空白 + 小写折叠。对齐 classifier.ts 的 fold 口径。 */
export function normalizeAlias(s: unknown): string {
  return (s == null ? '' : String(s)).normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase()
}

/** 稳定短哈希（djb2）——用于生成幂等 id，避免 Math.random 导致重跑漂移。 */
function stableHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** 从别名里抠出「数量」：前八项→8 / *16→16 / x20→20 / （前8项）→8 / 8项→8。抠不出返回 null。 */
export function parseComponentQty(raw: string): number | null {
  const s = String(raw ?? '').normalize('NFKC')
  // 前N项（阿拉伯或中文数字）
  let m = s.match(/前\s*([0-9]+)\s*项/)
  if (m) return Number(m[1])
  m = s.match(/前\s*([一二三四五六七八九十])\s*项/)
  if (m) return CN_NUM[m[1]] ?? null
  // *N / ×N / xN（如 免疫组化*16、147*10、182x20）
  m = s.match(/[*x×]\s*([0-9]+)/i)
  if (m) return Number(m[1])
  // N项（如 超过八项 → 无数字则跳过；16项 → 16）
  m = s.match(/([0-9]+)\s*项/)
  if (m) return Number(m[1])
  return null
}

// ───────────────────────────────────────────────────────────────────────────
// 标准项种子（project_catalog）
// ───────────────────────────────────────────────────────────────────────────

export const PROJECT_CATALOG_SEED: CatalogItem[] = [
  // 诊断线
  { canonicalCode: 'PC-DIAG-STD', canonicalName: '病理诊断', category: '诊断', physicalUnit: '次' },
  { canonicalCode: 'PC-DIAG-FROZEN', canonicalName: '术中冰冻诊断', category: '诊断', physicalUnit: '次' },
  { canonicalCode: 'PC-DIAG-REMOTE', canonicalName: '远程病理诊断', category: '诊断', physicalUnit: '次' },
  { canonicalCode: 'PC-CONSULT', canonicalName: '疑难病理会诊', category: '会诊', physicalUnit: '次' },
  { canonicalCode: 'PC-SPECIMEN-DIAG', canonicalName: '手术标本检查与诊断', category: '诊断', physicalUnit: '例', note: '含小/中/大标本，尺寸差异记 note' },
  { canonicalCode: 'PC-ENDO-BIOPSY-DIAG', canonicalName: '内镜组织活检检查与诊断', category: '诊断', physicalUnit: '例' },
  { canonicalCode: 'PC-CYTO-DIAG', canonicalName: '细胞学检查与诊断', category: '细胞学', physicalUnit: '例' },
  // 制片/标本处理线
  { canonicalCode: 'PC-PROC-TISSUE', canonicalName: '组织标本处理制片(常规)', category: '制片', physicalUnit: '蜡块' },
  { canonicalCode: 'PC-PROC-TISSUE-CX', canonicalName: '组织标本处理制片(复杂)', category: '制片', physicalUnit: '蜡块' },
  { canonicalCode: 'PC-PROC-CYTO', canonicalName: '细胞标本处理', category: '细胞学', physicalUnit: '玻片' },
  { canonicalCode: 'PC-PROC-CYTO-BLOCK', canonicalName: '细胞蜡块制作', category: '制片', physicalUnit: '蜡块' },
  { canonicalCode: 'PC-PROC-MOL', canonicalName: '分子病理标本处理', category: '分子', physicalUnit: '次' },
  { canonicalCode: 'PC-PROC-FROZEN', canonicalName: '冷冻标本处理', category: '制片', physicalUnit: '蜡块' },
  // 染色线
  { canonicalCode: 'PC-IHC-STD', canonicalName: '免疫组化染色(常规)', category: '染色-免疫组化', physicalUnit: '切片' },
  { canonicalCode: 'PC-IHC-ENH', canonicalName: '免疫组化染色(增强/PD-L1)', category: '染色-免疫组化', physicalUnit: '切片' },
  { canonicalCode: 'PC-IHC-MULTI', canonicalName: '多重染色(双染/三染)', category: '染色-免疫组化', physicalUnit: '切片' },
  { canonicalCode: 'PC-SS', canonicalName: '特殊染色', category: '染色-特殊', physicalUnit: '切片' },
  { canonicalCode: 'PC-ISH', canonicalName: '原位杂交(化学探针/EBER)', category: '原位杂交', physicalUnit: '切片' },
  { canonicalCode: 'PC-SLIDE-COPY', canonicalName: '切片复制/切白片', category: '切片复制', physicalUnit: '切片' },
  // 取材
  { canonicalCode: 'PC-BIOPSY', canonicalName: '活检取材', category: '取材', physicalUnit: '次' },
  // 细胞学/分子专项
  { canonicalCode: 'PC-TCT', canonicalName: '液基薄层细胞学(TCT)', category: '细胞学', physicalUnit: '次' },
  { canonicalCode: 'PC-HPV', canonicalName: 'HPV 检测', category: '分子', physicalUnit: '次' },
  { canonicalCode: 'PC-FISH', canonicalName: '荧光原位杂交(FISH)', category: '分子', physicalUnit: '次' },
  { canonicalCode: 'PC-NGS', canonicalName: '基因测序(NGS panel)', category: '分子', physicalUnit: '次', note: '多为外包转销，见 ngs-pnl' },
  { canonicalCode: 'PC-MOL-GENE', canonicalName: '分子基因检测(突变/融合/重排)', category: '分子', physicalUnit: '次', note: '单/寡基因 PCR 检测(K-RAS/EGFR/BRAF/ALK/BRCA…)，与 NGS panel 分列' },
  // 影像辅助
  { canonicalCode: 'PC-MICROPHOTO', canonicalName: '显微/大体摄影', category: '影像辅助', physicalUnit: '次' },
]

const CATALOG_CODES = new Set(PROJECT_CATALOG_SEED.map((c) => c.canonicalCode))

// ───────────────────────────────────────────────────────────────────────────
// 精确映射种子（高置信）：国标码 / LIS 数量列 / LIS advice type
// ───────────────────────────────────────────────────────────────────────────

/** 国标收费码 → 标准项（来源 charge-catalog.ts 的 CHARGE_CODE 常量，精确 exact/high）。 */
export const GUOBIAO_MAP: Record<string, string> = {
  [CHARGE_CODE.DIAGNOSIS]: 'PC-DIAG-STD',           // 012100000010000
  [CHARGE_CODE.PROC_TISSUE_STD]: 'PC-PROC-TISSUE',  // 012100000030000
  [CHARGE_CODE.PROC_TISSUE_CX]: 'PC-PROC-TISSUE-CX',// 012100000040000
  [CHARGE_CODE.PROC_CYTOLOGY]: 'PC-PROC-CYTO',      // 012100000050000
  [CHARGE_CODE.CYTOLOGY_BLOCK]: 'PC-PROC-CYTO-BLOCK',// 012100000090000
  [CHARGE_CODE.IHC_STD]: 'PC-IHC-STD',              // 012100000120000
  [CHARGE_CODE.IHC_ENHANCED]: 'PC-IHC-ENH',         // 012100000130000
  [CHARGE_CODE.SPECIAL_STAIN]: 'PC-SS',             // 012100000110000
  [CHARGE_CODE.ISH_CHEMICAL]: 'PC-ISH',             // 012100000140000
  [CHARGE_CODE.MULTIPLEX]: 'PC-IHC-MULTI',          // 012100000120001
  [CHARGE_CODE.FROZEN_PROC]: 'PC-PROC-FROZEN',      // 012100000080000
  '012100000060000': 'PC-PROC-MOL',                 // 分子病理处理（目录有效码）
  '012100000100000': 'PC-SLIDE-COPY',               // 切片复制
  // 活检取材各变体 → PC-BIOPSY
  '011201000010000': 'PC-BIOPSY', '011201000020000': 'PC-BIOPSY', '011201000030000': 'PC-BIOPSY',
  '011201000040000': 'PC-BIOPSY', '011201000050000': 'PC-BIOPSY', '011201000070000': 'PC-BIOPSY',
  '011201000080000': 'PC-BIOPSY',
}

/** LIS 数量列语义名 → 标准项（来源 case-charge-mapping.ts 的锁定口径，精确 exact/high）。 */
export const LIS_COUNT_MAP: Array<{ alias: string; catalogCode: string; label: string }> = [
  { alias: 'HE切片数', catalogCode: 'PC-DIAG-STD', label: 'HE 切片（驱动诊断费）' },
  { alias: 'HE切片', catalogCode: 'PC-DIAG-STD', label: 'HE 切片' },
  { alias: '蜡块数', catalogCode: 'PC-PROC-TISSUE', label: '蜡块（默认组织常规；细胞学另分流）' },
  { alias: '免疫组化数', catalogCode: 'PC-IHC-STD', label: '免疫组化数' },
  { alias: 'PD-L1数', catalogCode: 'PC-IHC-ENH', label: 'PD-L1 数（增强染色）' },
  { alias: '特染数', catalogCode: 'PC-SS', label: '特染数' },
  { alias: 'EBER数', catalogCode: 'PC-ISH', label: 'EBER 数（原位杂交）' },
]

/**
 * 常见 IHC 抗体 markerName → 免疫组化常规标准项（medium：账单不区分逐抗体，但明确属 IHC）。
 * 取 0702免组导出高频 markerName 子集；未列出的抗体在 lookup 时按关键词/白片规则兜底。
 */
export const IHC_MARKER_SEED = [
  'Ki67', 'P53', 'P16', 'P63', 'ER', 'PR', 'HER2', 'CK7', 'CK20', 'CK5/6', 'CK19', 'CK广',
  'CD3', 'CD10', 'CD20', 'CD56', 'CD117', 'CD138', 'S100', 'SMA', 'Desmin', 'Vimentin',
  'TTF1', 'PAX8', 'SYN', 'HMB45', 'Melan A', 'PRAME', 'BRAF', 'EGFR', 'AR', 'WT1',
  'calretinin', 'galectin3', 'beta-catenin', 'BerEP4', 'HP',
]

/** LIS 技术性行 markerName（非抗体）→ 标准项。 */
export const LIS_TECH_ROW_SEED: Array<{ alias: string; catalogCode: string }> = [
  { alias: '免组白片', catalogCode: 'PC-SLIDE-COPY' },
  { alias: '免疫组化白片', catalogCode: 'PC-SLIDE-COPY' },
  { alias: '普通白片', catalogCode: 'PC-SLIDE-COPY' },
  { alias: '分子白片', catalogCode: 'PC-SLIDE-COPY' },
  { alias: '深切', catalogCode: 'PC-SLIDE-COPY' },
  { alias: '重切', catalogCode: 'PC-SLIDE-COPY' },
  { alias: '免组HE', catalogCode: 'PC-DIAG-STD' },
  { alias: 'HE', catalogCode: 'PC-DIAG-STD' },
]

/** LIS adviceType 码 → 标准项（仅对已确认含义的码给映射，其余进待校对）。 */
export const LIS_ADVICE_TYPE_SEED: Array<{ alias: string; catalogCode: string; confidence: Confidence }> = [
  { alias: 'Y000001', catalogCode: 'PC-IHC-STD', confidence: 'medium' }, // 免组主类（占比最高，与 IHC 量级吻合）
  // Y000003 / Y000006 / Y000007 含义未确认 → 进待校对，不臆断
  { alias: 'Y000003', catalogCode: '', confidence: 'low' },
  { alias: 'Y000006', catalogCode: '', confidence: 'low' },
  { alias: 'Y000007', catalogCode: '', confidence: 'low' },
]

// ───────────────────────────────────────────────────────────────────────────
// 对账单项目名分类器（关键词，全收+拆包+分层）
// ───────────────────────────────────────────────────────────────────────────

/** 噪音判据：对账单里混进来的财务/成本/汇总/耗材/费用行，非检测项目 → 剔除不映射、进待校对留痕。 */
const NOISE_RE = /合计|小计|复核|收入|成本|水费|电费|燃气费|物业|管理费|折旧|房租|工资|押金|退款|结转|费用|耗材|卫生材料|材料费|药品|医保|绩效|应酬|会议费|代付|不计价|中药|保险|办公费|差旅|广告|维修|保养|租赁|洗涤|消毒|印花税|税金|税费|手续费|审计|诉讼|福利|工会|公积金|奖金|奖励|年终奖|学习班|科研经费|考核|风险金|纠纷|保底|利润|毛利|收益|结余|结算金额|应支付|协议给付|给付余额|提成|垃圾|后勤|物资|物料|消耗|审批|制表|负责人|科室确认|扣款|调整|保安|市场费|班车|就餐|节日|补助|支出|经费|余额|设备|运杂|通讯|网络|保证金|易耗|实际金额|科室部分/
// 注：故意不含「服务费」——「远程会诊服务费/病理诊断服务费」是真项目的写法，含它会误剔；「固定服务费」等纯行政行退化为 no_match、仍进待校对队列。
/** 纯数字/标点（无中文/字母）——如 "1652" —— 也当噪音。 */
const NUMERIC_ONLY_RE = /^[\d\s.,:：、+\-*x×%()（）]+$/

/**
 * 关键词规则集（有序，先具体后通用，首个命中为准）。
 * 命中 → catalogCode + 置信度。high 者 auto，其余进待校对。
 */
const STATEMENT_RULES: Array<{ kw: RegExp; catalogCode: string; confidence: Confidence }> = [
  { kw: /显微摄影|大体标本摄影|摄影/, catalogCode: 'PC-MICROPHOTO', confidence: 'high' },
  { kw: /tct|液基薄层|薄层细胞/i, catalogCode: 'PC-TCT', confidence: 'high' },
  { kw: /远程病理|远程/, catalogCode: 'PC-DIAG-REMOTE', confidence: 'high' }, // 须在「会诊」之前
  { kw: /疑难病理会诊|会诊/, catalogCode: 'PC-CONSULT', confidence: 'high' },
  { kw: /冰冻|术中快速/, catalogCode: 'PC-DIAG-FROZEN', confidence: 'high' },
  { kw: /fish|荧光.*原位杂交|荧光染色体/i, catalogCode: 'PC-FISH', confidence: 'high' }, // 须在「原位杂交」之前
  { kw: /hpv|人乳头瘤病毒/i, catalogCode: 'PC-HPV', confidence: 'high' },
  // 分子·单/寡基因检测（突变/融合/重排/表达；含常见基因名）——须在通用「基因检测」之前，且关键词避开「癌基因蛋白」(IHC)
  { kw: /基因突变|突变检测|突变检|融合基因|基因融合|基因重排|基因诊断|基因扩增|甲基化|基因表达|k-?ras|egfr|b-?raf|eml4|kras|brca|str检测/i, catalogCode: 'PC-MOL-GENE', confidence: 'medium' },
  { kw: /\d+\s*基因|基因检测|测序|ngs|panel/i, catalogCode: 'PC-NGS', confidence: 'medium' },
  // 白片/切白片/深切/重切 = 未染的空白片(供外送/后用)，走切片复制 PC-SLIDE-COPY，**非**染色。
  //   须在 IHC/特染/PD-L1 之前——否则「免组白片」被「免组」误吃成 IHC、「特染白片」被误吃成特染，且与 LIS_TECH_ROW_SEED 口径打架。
  { kw: /切白片|切白边|白片|切片复制|深切|重切/, catalogCode: 'PC-SLIDE-COPY', confidence: 'high' },
  { kw: /pd-?l1/i, catalogCode: 'PC-IHC-ENH', confidence: 'high' }, // 须在「免疫组化」之前（PD-L1 走增强）
  { kw: /单克隆抗体|癌基因蛋白|免疫组化|免疫组织化学|免疫细胞化学|细胞化学|免组|组化/, catalogCode: 'PC-IHC-STD', confidence: 'high' },
  { kw: /特殊染色|特染/, catalogCode: 'PC-SS', confidence: 'high' },
  { kw: /原位杂交|eber/i, catalogCode: 'PC-ISH', confidence: 'high' },
  { kw: /内镜|胃肠镜|宫腔镜/, catalogCode: 'PC-ENDO-BIOPSY-DIAG', confidence: 'high' },
  { kw: /脱落细胞|体液细胞|细胞学检查与诊断|细胞病理学|细针穿刺|膜式病变细胞/, catalogCode: 'PC-CYTO-DIAG', confidence: 'high' },
  { kw: /穿刺组织活检/, catalogCode: 'PC-SPECIMEN-DIAG', confidence: 'medium' },
  { kw: /手术标本|标本检查与诊断|小标本|中标本|大标本/, catalogCode: 'PC-SPECIMEN-DIAG', confidence: 'high' },
  { kw: /活检取材|取材|活检|诊刮/, catalogCode: 'PC-BIOPSY', confidence: 'medium' },
  { kw: /细胞蜡块/, catalogCode: 'PC-PROC-CYTO-BLOCK', confidence: 'medium' },
  { kw: /蜡块|标本处理|制片/, catalogCode: 'PC-PROC-TISSUE', confidence: 'medium' },
  { kw: /he切片|常规he|he染色/i, catalogCode: 'PC-DIAG-STD', confidence: 'medium' },
  { kw: /细胞学.*报告/, catalogCode: 'PC-CYTO-DIAG', confidence: 'medium' },
  { kw: /病理诊断|诊断费|组织学.*报告|中英文报告/, catalogCode: 'PC-DIAG-STD', confidence: 'medium' },
]

/**
 * 复合行分隔符（一格塞多个项目：顿号/逗号/分号）。
 * ⚠️ 不含斜杠 `/`：真实数据里 `/` 多在项目名内部（BRCA1/2、CK5/6、EWSR1/ATF1），拆开会误伤。
 */
const COMPOSITE_SPLIT = /[、，,;；]/

/**
 * 把一条对账单项目名分类成 1..N 个分量（复合行拆包）。
 * - 噪音 → 单分量 {catalogCode:'', reason:'noise', needs_review}
 * - 复合 → 按分隔符拆，逐段分类（任一分量都进 needs_review，供人工确认拆分对不对）
 * - 单段命中 high → auto；medium/low/未命中 → needs_review
 */
export function classifyStatementItem(raw: string): ClassifiedComponent[] {
  const norm = normalizeAlias(raw)
  if (!norm) return [{ catalogCode: '', componentQty: null, confidence: 'low', matchType: 'inferred', reviewStatus: 'needs_review', reason: 'no_match' }]
  // 先按分隔符拆段，再**逐段**判噪音/分类：避免「真项目、水费」这类混合行被整行误判成噪音而丢掉真项目段。
  const segments = String(raw).split(COMPOSITE_SPLIT).map((s) => s.trim()).filter((s) => normalizeAlias(s).length > 0)
  const segs = segments.length ? segments : [raw]
  const isComposite = segs.length > 1
  const out: ClassifiedComponent[] = []
  for (const seg of segs) {
    const segNorm = normalizeAlias(seg)
    if (NOISE_RE.test(segNorm) || NUMERIC_ONLY_RE.test(segNorm)) {
      out.push({ catalogCode: '', componentQty: null, confidence: 'low', matchType: 'inferred', reviewStatus: 'needs_review', reason: 'noise', note: '疑似非项目(费用/汇总/成本/耗材/纯数字行)' })
      continue
    }
    const qty = parseComponentQty(seg)
    const rule = STATEMENT_RULES.find((r) => r.kw.test(segNorm))
    if (rule) {
      const needsReview = isComposite || rule.confidence !== 'high'
      out.push({
        catalogCode: rule.catalogCode,
        componentQty: qty,
        confidence: rule.confidence,
        matchType: 'keyword',
        reviewStatus: needsReview ? 'needs_review' : 'auto',
      })
    } else {
      out.push({ catalogCode: '', componentQty: qty, confidence: 'low', matchType: 'inferred', reviewStatus: 'needs_review', reason: 'no_match' })
    }
  }
  return out
}

function worstConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }
  return rank[a] <= rank[b] ? a : b
}

/**
 * 把逐段分量按标准项**聚合**：同一标准项的多段合并、数量相加、取最低置信/待校对。
 * 用于入库与查询——避免复合行里同一标准项的多段被 UNIQUE(system,alias_norm,catalog_code) 键顶掉而**丢数量**
 * （如「免疫组化*10、免疫组化*6」应得 PC-IHC-STD=16，而非只留其一）。classifyStatementItem 仍返回逐段原样（透明可审）。
 */
export function aggregateComponents(comps: ClassifiedComponent[]): ClassifiedComponent[] {
  const byCat = new Map<string, ClassifiedComponent>()
  const order: string[] = []
  for (const c of comps) {
    const existing = byCat.get(c.catalogCode)
    if (!existing) { byCat.set(c.catalogCode, { ...c }); order.push(c.catalogCode); continue }
    if (c.componentQty != null || existing.componentQty != null) {
      existing.componentQty = (existing.componentQty ?? 0) + (c.componentQty ?? 0)
    }
    existing.confidence = worstConfidence(existing.confidence, c.confidence)
    if (c.reviewStatus === 'needs_review') existing.reviewStatus = 'needs_review'
  }
  return order.map((k) => byCat.get(k)!)
}

/**
 * 全收的对账单真实项目词汇（19 院 59 文件抽出的「项目名家族」；变体靠 NFKC 归一，不逐条列全角/半角）。
 * seed 时对每条跑 classifyStatementItem 物化成 code_mappings 行；含噪音行，用于「待校对」只读清单演示。
 */
export const STATEMENT_VOCAB: string[] = [
  '显微摄影术', '病理大体标本摄影',
  '妇科TCT检测', '液基薄层细胞制片术', '液基薄层细胞制片术超薄片技术加收', '膜式病变细胞采集术',
  '手术标本检查与诊断', '手术标本检查与诊断(小标本)', '手术标本检查与诊断(中标本)', '手术标本检查与诊断(大标本)',
  '手术标本检查与诊断（2个以上每个加收10元）', '穿刺组织活检检查与诊断',
  '内镜组织活检检查与诊断', '内镜组织活检检查与诊断-胃肠镜', '内镜组织活检检查与诊断-宫腔镜',
  '脱落细胞学检查与诊断', '体液细胞学检查与诊断', '细胞病理学检查与诊断加收', '细针穿刺细胞学检查与诊断',
  '免疫组化检测（前八项）', '免疫组化检测（超过八项）', '免疫组化*16', '免疫组化*17', '免疫组化', '免疫组织化学染色诊断',
  '病理单克隆抗体检测147*10', '病理单克隆抗体检测147*8', '病理癌基因蛋白检测182x10', '病理癌基因蛋白检测182x20', '病理癌基因蛋白检测160x10',
  '荧光染色体原位杂交检查（FISH）', '人乳头瘤病毒(HPV)23型', 'HPV-E6E7', '人乳头瘤病毒E6E7信使核糖核酸',
  '乳腺癌21基因检测', '子宫内膜癌9基因',
  '人类K-RAS基因突变检测', '人类EGFR基因突变检测', 'BRCA1/2基因检测', 'IGH基因重排', '人类检测EML4-ALK融合基因',
  '疑难病理会诊（市外）', '疑难病理会诊', '远程病理会诊',
  '术中快速（冰冻）诊断', '冰冻切片检查与诊断', '切白片', 'PD-L1',
  '组织学中英文报告-外籍人士',
  '小标本', '中标本', '大标本', '1类免组', '2类免组', '免组',
  // —— 复合行样例（一格多项目，验拆包）——
  '病理癌基因蛋白检测182x10、病理单克隆抗体检测147x6、疑难病理会诊（市外）182',
  // —— 噪音样例（非项目，验自动剔除+待校对队列）——
  '合计', '小计-分子检测', '复核：', '医技收入', '药品收入', '耗材收入', '其他收入', '科室成本',
  '水费', '电费', '燃气费', '物业管理费',
]

/** projects.type → 标准项（系统项目码按类型粗对，medium；逐条 code 在 seed 时读表动态生成）。 */
export const PROJECT_TYPE_MAP: Record<string, string> = {
  he: 'PC-DIAG-STD',
  ihc: 'PC-IHC-STD',
  ss: 'PC-SS',
  cyto: 'PC-CYTO-DIAG',
  mp: 'PC-NGS',
}

// ───────────────────────────────────────────────────────────────────────────
// 建表
// ───────────────────────────────────────────────────────────────────────────

export function ensureCatalogSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_catalog (
      id TEXT PRIMARY KEY,
      canonical_code TEXT NOT NULL UNIQUE,
      canonical_name TEXT NOT NULL,
      category TEXT NOT NULL,
      physical_unit TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_mappings (
      id TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      alias_code TEXT NOT NULL,
      alias_norm TEXT NOT NULL,
      alias_label TEXT,
      catalog_code TEXT NOT NULL DEFAULT '',
      component_qty INTEGER,
      group_id TEXT,
      confidence TEXT NOT NULL DEFAULT 'low',
      match_type TEXT NOT NULL DEFAULT 'inferred',
      review_status TEXT NOT NULL DEFAULT 'auto',
      source TEXT NOT NULL,
      note TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(system, alias_norm, catalog_code)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_mappings_lookup ON code_mappings(system, alias_norm)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_mappings_catalog ON code_mappings(catalog_code)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_mappings_review ON code_mappings(review_status)`)
}

// ───────────────────────────────────────────────────────────────────────────
// 种子（幂等：INSERT OR IGNORE on UNIQUE(system, alias_norm, catalog_code)）
// ───────────────────────────────────────────────────────────────────────────

interface MappingInput {
  system: AliasSystem
  aliasCode: string
  aliasLabel?: string | null
  catalogCode: string
  componentQty?: number | null
  groupId?: string | null
  confidence: Confidence
  matchType: MatchType
  reviewStatus: ReviewStatus
  source: string
  note?: string | null
}

function insertMappings(db: DatabaseSync, rows: MappingInput[]): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO code_mappings
      (id, system, alias_code, alias_norm, alias_label, catalog_code, component_qty, group_id, confidence, match_type, review_status, source, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const r of rows) {
    const aliasNorm = normalizeAlias(r.aliasCode)
    // id 用随机 uuid（非哈希）：幂等由 UNIQUE(system,alias_norm,catalog_code) 保证，不靠 id 稳定。
    // （曾用 32-bit djb2 哈希做 id → 不同别名哈希碰撞会被 PRIMARY KEY 顶掉、丢真实映射，codex 复核实测复现。）
    const id = `CM-${uuidv4()}`
    stmt.run(
      id, r.system, r.aliasCode, aliasNorm, r.aliasLabel ?? null, r.catalogCode,
      r.componentQty ?? null, r.groupId ?? null, r.confidence, r.matchType, r.reviewStatus, r.source, r.note ?? null,
    )
  }
}

/** 系统项目码映射：读 projects 表按 type 动态生成（幂等）。可单独调用（如测试插入项目后再同步）。 */
export function syncProjectCodeMappings(db: DatabaseSync): void {
  let rows: Array<{ code: string; type: string; name: string }> = []
  try {
    rows = db.prepare(`SELECT code, type, name FROM projects WHERE is_deleted = 0`).all() as Array<{ code: string; type: string; name: string }>
  } catch {
    return // projects 表不存在（极早期）——跳过
  }
  const inputs: MappingInput[] = []
  for (const p of rows) {
    const cc = PROJECT_TYPE_MAP[String(p.type ?? '').toLowerCase()]
    if (!cc) continue
    inputs.push({
      system: 'project_code', aliasCode: p.code, aliasLabel: p.name, catalogCode: cc,
      confidence: 'medium', matchType: 'inferred', reviewStatus: 'needs_review', source: 'projects_seed',
      note: `按 projects.type=${p.type} 粗对`,
    })
  }
  if (inputs.length) insertMappings(db, inputs)
}

/**
 * 幂等种子：建标准项 + 全部别名映射。重复调用不产生重复行。
 */
export function seedProjectCatalog(db: DatabaseSync): void {
  ensureCatalogSchema(db)

  // 1) 标准项
  const insCat = db.prepare(`
    INSERT OR IGNORE INTO project_catalog (id, canonical_code, canonical_name, category, physical_unit, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const c of PROJECT_CATALOG_SEED) {
    insCat.run(c.canonicalCode, c.canonicalCode, c.canonicalName, c.category, c.physicalUnit, c.note ?? null)
  }

  const inputs: MappingInput[] = []

  // 2) 国标码（exact/high/auto）
  for (const [code, cc] of Object.entries(GUOBIAO_MAP)) {
    inputs.push({ system: 'guobiao_code', aliasCode: code, catalogCode: cc, confidence: 'high', matchType: 'exact', reviewStatus: 'auto', source: 'charge_catalog' })
  }

  // 3) LIS 数量列（exact/high/auto）
  for (const m of LIS_COUNT_MAP) {
    inputs.push({ system: 'lis_name', aliasCode: m.alias, aliasLabel: m.label, catalogCode: m.catalogCode, confidence: 'high', matchType: 'exact', reviewStatus: 'auto', source: 'lis_map' })
  }
  // 3b) LIS 技术行（high/auto）
  for (const m of LIS_TECH_ROW_SEED) {
    inputs.push({ system: 'lis_name', aliasCode: m.alias, catalogCode: m.catalogCode, confidence: 'high', matchType: 'keyword', reviewStatus: 'auto', source: 'lis_map' })
  }
  // 3c) IHC 抗体 markerName → IHC 常规（medium/needs_review：账单不区分逐抗体）
  for (const marker of IHC_MARKER_SEED) {
    inputs.push({ system: 'lis_name', aliasCode: marker, catalogCode: 'PC-IHC-STD', confidence: 'medium', matchType: 'inferred', reviewStatus: 'needs_review', source: 'lis_map', note: 'IHC 抗体，账单不区分逐抗体' })
  }
  // 3d) LIS adviceType 码
  for (const m of LIS_ADVICE_TYPE_SEED) {
    inputs.push({
      system: 'lis_advice_type', aliasCode: m.alias, catalogCode: m.catalogCode,
      confidence: m.confidence, matchType: 'inferred',
      reviewStatus: m.catalogCode && m.confidence === 'high' ? 'auto' : 'needs_review',
      source: 'lis_map', note: m.catalogCode ? null : 'adviceType 含义未确认',
    })
  }

  // 4) 对账单项目名（全收 + 拆包 + 分层）：聚合同标准项分量后入库（防 UNIQUE 键丢数量）
  for (const raw of STATEMENT_VOCAB) {
    const comps = aggregateComponents(classifyStatementItem(raw))
    const groupId = comps.length > 1 ? `SG-${stableHash(normalizeAlias(raw))}` : null
    for (const c of comps) {
      inputs.push({
        system: 'statement_item', aliasCode: raw, aliasLabel: null, catalogCode: c.catalogCode,
        componentQty: c.componentQty, groupId, confidence: c.confidence, matchType: c.matchType,
        reviewStatus: c.reviewStatus, source: 'statement_2026', note: c.note ?? c.reason ?? null,
      })
    }
  }

  insertMappings(db, inputs)

  // 5) 系统项目码（读表动态）
  syncProjectCodeMappings(db)
}

// ───────────────────────────────────────────────────────────────────────────
// 查询 API（只读）
// ───────────────────────────────────────────────────────────────────────────

function rowToCatalog(r: any): CatalogItem {
  return { canonicalCode: r.canonical_code, canonicalName: r.canonical_name, category: r.category, physicalUnit: r.physical_unit, note: r.note ?? undefined }
}

export function getCatalogItem(db: DatabaseSync, canonicalCode: string): CatalogItem | null {
  const r = db.prepare(`SELECT * FROM project_catalog WHERE canonical_code = ?`).get(canonicalCode) as any
  return r ? rowToCatalog(r) : null
}

export function listCatalog(db: DatabaseSync): CatalogItem[] {
  const rows = db.prepare(`SELECT * FROM project_catalog WHERE status = 1 ORDER BY canonical_code`).all() as any[]
  return rows.map(rowToCatalog)
}

/**
 * 按任一叫法查规范项目。
 * - 先在 code_mappings 精确命中（归一后）；命中且已映射 → matched:true（复合行返回多个分量）。
 * - 未在库里 → 对 statement_item 类退回实时分类器做「尽力猜」（标低置信），仍无 → matched:false。
 * - 噪音/未映射 → matched:false，reason 说明，**绝不抛错、绝不静默当成命中**。
 */
export function lookupProject(db: DatabaseSync, alias: string, system?: AliasSystem): LookupResult {
  const input = String(alias ?? '')
  const norm = normalizeAlias(input)
  if (!norm) return { matched: false, input, system, reason: 'no_mapping' }

  const sql = system
    ? `SELECT * FROM code_mappings WHERE system = ? AND alias_norm = ?`
    : `SELECT * FROM code_mappings WHERE alias_norm = ?`
  const rows = (system ? db.prepare(sql).all(system, norm) : db.prepare(sql).all(norm)) as any[]

  if (rows.length) {
    const mapped = rows.filter((r) => r.catalog_code && r.catalog_code !== '')
    if (mapped.length) {
      const components = mapped.map((r) => ({
        catalog: getCatalogItem(db, r.catalog_code),
        catalogCode: r.catalog_code as string,
        componentQty: (r.component_qty ?? null) as number | null,
        confidence: r.confidence as Confidence,
        reviewStatus: r.review_status as ReviewStatus,
      }))
      return {
        matched: true, input, system: rows[0].system,
        catalog: components[0].catalog ?? undefined,
        components,
      }
    }
    // 命中但全是未映射（噪音/待确认）
    const noise = rows.some((r) => (r.note ?? '').includes('非项目'))
    return { matched: false, input, system: rows[0].system, reason: noise ? 'noise' : 'unmapped' }
  }

  // 库里没有 → statement_item 实时兜底猜（不落库、只回结果）
  if (!system || system === 'statement_item') {
    const all = classifyStatementItem(input)
    const comps = aggregateComponents(all).filter((c) => c.catalogCode)
    if (comps.length) {
      return {
        matched: true, input, system: 'statement_item',
        catalog: getCatalogItem(db, comps[0].catalogCode) ?? undefined,
        components: comps.map((c) => ({
          catalog: getCatalogItem(db, c.catalogCode), catalogCode: c.catalogCode,
          componentQty: c.componentQty, confidence: c.confidence, reviewStatus: c.reviewStatus,
        })),
      }
    }
    // 未匹配到任何标准项：若被判为噪音，如实告知 noise（否则 no_mapping）
    if (all.some((c) => c.reason === 'noise')) return { matched: false, input, system: 'statement_item', reason: 'noise' }
  }
  return { matched: false, input, system, reason: 'no_mapping' }
}

/** 反查：某标准项都有哪些别名。 */
export function getAliasesForCatalog(db: DatabaseSync, canonicalCode: string): CodeMappingRow[] {
  const rows = db.prepare(`SELECT * FROM code_mappings WHERE catalog_code = ? ORDER BY system, confidence`).all(canonicalCode) as any[]
  return rows.map(rowToMapping)
}

function rowToMapping(r: any): CodeMappingRow {
  return {
    id: r.id, system: r.system, aliasCode: r.alias_code, aliasNorm: r.alias_norm, aliasLabel: r.alias_label ?? null,
    catalogCode: r.catalog_code, componentQty: r.component_qty ?? null, groupId: r.group_id ?? null,
    confidence: r.confidence, matchType: r.match_type, reviewStatus: r.review_status, source: r.source, note: r.note ?? null,
  }
}

/**
 * 待校对只读清单（🔴 层）：needs_review / 未映射 / 低置信 的映射行。
 * 这就是 PM 要的「只读清单」——人只需过这一层，不用看全部。
 */
export function listReviewQueue(db: DatabaseSync, opts?: { system?: AliasSystem; limit?: number }): CodeMappingRow[] {
  const clauses = [`(review_status = 'needs_review' OR catalog_code = '' OR confidence = 'low')`]
  const params: unknown[] = []
  if (opts?.system) { clauses.push(`system = ?`); params.push(opts.system) }
  const limit = opts?.limit && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : ''
  const rows = db.prepare(
    `SELECT * FROM code_mappings WHERE ${clauses.join(' AND ')} ORDER BY confidence DESC, system, alias_code${limit}`,
  ).all(...params) as any[]
  return rows.map(rowToMapping)
}

/** 汇总：各标准项的别名条数、各置信度/校对状态计数（给只读概览页）。 */
export function catalogSummary(db: DatabaseSync): {
  catalogCount: number
  mappingCount: number
  byConfidence: Record<string, number>
  byReviewStatus: Record<string, number>
  unmapped: number
} {
  const catalogCount = (db.prepare(`SELECT COUNT(*) n FROM project_catalog`).get() as any).n
  const mappingCount = (db.prepare(`SELECT COUNT(*) n FROM code_mappings`).get() as any).n
  const byConfidence: Record<string, number> = {}
  for (const r of db.prepare(`SELECT confidence, COUNT(*) n FROM code_mappings GROUP BY confidence`).all() as any[]) byConfidence[r.confidence] = r.n
  const byReviewStatus: Record<string, number> = {}
  for (const r of db.prepare(`SELECT review_status, COUNT(*) n FROM code_mappings GROUP BY review_status`).all() as any[]) byReviewStatus[r.review_status] = r.n
  const unmapped = (db.prepare(`SELECT COUNT(*) n FROM code_mappings WHERE catalog_code = ''`).get() as any).n
  return { catalogCount, mappingCount, byConfidence, byReviewStatus, unmapped }
}

export { CATALOG_CODES }
