/**
 * 抗体名称映射 —— 让 LIS 只给「抗体名」时也能对上台账的 **价 + 剂型**（未决 A1 + A3，Phase 0 成本地基）。
 *
 * 背景（真数据手核 2026-07-02，源台账 `免疫组化相关耗材2025年.xlsx·2025(2)` + LIS `0702免组.xlsx`）：
 *  · LIS 的 markerName 写法与台账抗体名**经常对不上**（Ki67 vs 台账 Ki-67、S100 vs S-100、Ecad vs E-cadherin…），
 *    纯精确匹配会把台账**明明有价**的抗体误判成「缺价」。A1「缺 10 种」里 5 种其实是别名、台账已有价。
 *  · 台账 `UNIQUE(name, form)`：同名可有原液/即用两档，每片成本差约 6 倍（A3 剂型歧义）。LIS 不给剂型。
 *
 * 口径（PM 拍板 2026-07-02）：
 *  1) 别名落地 = **代码规范化规则**（去括号克隆号 / 空格 / 连字符 / 点 / 大小写）自动对上大多数写法差异
 *     ＋ **可扩展的别名种子**（生物学同义词，规范化也撞不到的，如 Ecad→E-cadherin）。
 *     规范化对台账**几乎单射**：极少数真撞键（如去克隆号后 `TCR(a/b)` 与 `TCR(G/D)` 都→`TCR`，是两种不同抗体）
 *     由 `buildLedgerIndex` 标 `ambiguousNorm`、**不自动解析**（返回缺价、要求精确名/剂型/别名消歧），防跨抗体误价。
 *  2) 剂型歧义（同名多剂型、LIS 无剂型）→ **保守取高价**（成本更高 = 不高估毛利，与 antibody-cost-v1.1 `/cost-preview` 一致）
 *     ＋ 标 `formAssumed=true`（行级「剂型待确认」），后续可逐个订正。
 *  3) 台账真缺（PD-1 / cathepsinK / GPNMB / TROP-2 / HP）→ 解析为 priceStatus='missing'，成本走降级（fallbackAveragePrimary）＋行级标注，
 *     并产出缺价清单交 PM 补采购价（见 `docs/COREONE-缺价抗体清单-…`）。
 *
 * ⛔ 边界：本文件只做**抗体名↔台账**解析。特染（PAS/GMS/W-S…）的**权威分类**归对账域 A4（`classifyChargeItem`），
 *    这里只对物理片型（白片/HE/深切重切/分子）与特染做**轻量识别**，防止它们污染抗体缺价清单——非权威成本分类。
 */
import { ANTIBODY_LEDGER_SEED, type AntibodyLedgerDef } from './antibody-catalog.js'

// —— 生物学同义词种子（LIS 临床写法 → 台账规范名）——
//   仅收「规范化也撞不到台账」的真·异名（已验证这 5 个规范化后在台账无命中，故必须人工登记）。
//   ops 可在 `antibody_aliases` 表继续加，无需改代码发版。
export interface AntibodySynonymDef {
  lisName: string // LIS/临床常见写法
  canonicalName: string // 台账规范名（antibodies.name）
  note: string
}
export const ANTIBODY_SYNONYM_SEED: AntibodySynonymDef[] = [
  { lisName: 'Ecad', canonicalName: 'E-cadherin', note: 'E-钙黏蛋白：LIS 缩写 Ecad = 台账 E-cadherin' },
  { lisName: 'Vimentin', canonicalName: 'VIM', note: '波形蛋白：LIS 全称 Vimentin = 台账缩写 VIM' },
  { lisName: 'cyclinD1', canonicalName: 'CYCD-1', note: 'Cyclin D1：LIS cyclinD1 = 台账 CYCD-1' },
  { lisName: 'SMARCA4', canonicalName: 'SMARC4', note: 'SMARCA4(=BRG1)：LIS 常带克隆号 SMARCA4(BRG1) = 台账 SMARC4' },
  { lisName: 'Melan A', canonicalName: 'MART-1/melan-A', note: 'Melan-A(=MART-1)：LIS Melan A = 台账 MART-1/melan-A' },
]

// —— 台账真缺（LIS 用到、台账无价，待 PM 补采购价，A1）——
//   注：PD-1(CD279) 与台账 PD-L1(CD274) 是**不同抗体**，绝不映射到 PD-L1。
export interface MissingAntibodyDef {
  name: string
  category: string
  note: string
}
export const ANTIBODY_MISSING_PRICE_SEED: MissingAntibodyDef[] = [
  { name: 'HP', category: '一抗', note: '幽门螺杆菌免疫组化抗体（PM 拍板按抗体处理）·待补采购价' },
  { name: 'GPNMB', category: '一抗', note: 'LIS 用到·台账缺价·待补采购价' },
  { name: 'cathepsinK', category: '一抗', note: '组织蛋白酶K·台账缺价·待补采购价' },
  { name: 'PD-1', category: '一抗', note: 'PD-1(CD279)·与 PD-L1 不同·台账缺价·待补采购价' },
  { name: 'TROP-2', category: '一抗', note: 'LIS 用到·台账缺价·待补采购价' },
]

/**
 * 规范化抗体名：去括号克隆号（如 (22C3)/(BRG1)）→ 去空格/连字符/下划线/点 → 大写。
 * 用于把 LIS 写法与台账名对齐。⚠️ 规范化会去掉括号内克隆号/链型，故**并非绝对单射**（TCR(a/b) 与 TCR(G/D) 都→TCR）——
 * 真撞键的消歧由 `buildLedgerIndex` 的 `ambiguousNorm` 兜底（不自动解析），本函数只负责生成键。
 */
export function normalizeAntibodyName(raw: string): string {
  return String(raw ?? '')
    .replace(/\([^)]*\)/g, '') // 去括号内克隆号/注释
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
}

export type MarkerCategory = '抗体' | '白片' | 'HE' | '重切深切' | '分子' | '特染(疑)'

/**
 * 轻量识别非抗体行（防止白片/HE/深切重切/分子/特染污染抗体缺价清单）。
 * ⚠️ 特染仅返回「特染(疑)」提示——**权威特染分类在对账域 A4**，这里不做成本分类。
 */
export function classifyMarker(raw: string): MarkerCategory {
  const s = String(raw ?? '').trim()
  const u = s.toUpperCase()
  if (s.includes('分子')) return '分子' // 分子白片
  if (s.includes('白片')) return '白片'
  if (s.includes('深切') || s.includes('重切')) return '重切深切'
  // HE 染色：仅精确匹配 HE / 免组HE（别误伤 HER2 / HGAL / hepatocyte 等含 "HE" 的抗体）
  if (s === 'HE' || s === '免组HE') return 'HE'
  // 特染提示（非权威）：染色/银染 关键词或常见特染名
  if (
    s.includes('染色') ||
    s.includes('银染') ||
    /^PAS(-?D)?$/.test(u) ||
    u === 'GMS' ||
    u.includes('MASSON') ||
    s.includes('网状') ||
    s.includes('抗酸') ||
    /^W-?S$/.test(u)
  ) {
    return '特染(疑)'
  }
  return '抗体'
}

// —— 台账索引 ——
export interface LedgerRow {
  name: string
  form: string | null
  perTestPrice: number | null
  category?: string | null
}
export interface LedgerIndex {
  byName: Map<string, LedgerRow[]> // 台账名 → 该名下各剂型行
  byNorm: Map<string, string> // 规范化键 → 台账名（仅收单射键；碰撞键不收，见 ambiguousNorm）
  ambiguousNorm: Set<string> // 规范化后**多个不同台账名相撞**的键（如 TCR：TCRαβ vs TCRγδ）→ 不自动解析，防跨抗体误价
}

/**
 * 从台账行构建索引（供 resolver 用）。
 * ⚠️ 碰撞防护：若两个**不同**台账名规范化成同一键（去括号克隆号后 `TCR(a/b)` 与 `TCR(G/D)` 都→`TCR`），
 *    则该键不进 byNorm、改入 ambiguousNorm——resolver 遇之返回缺价而非静默取第一个（否则会把 TCRγδ 误价成 TCRαβ）。
 *    精确名 / 剂型限定 / 显式别名 仍可解析，只是 bare「TCR」这种歧义输入被强制消歧。
 */
export function buildLedgerIndex(rows: LedgerRow[]): LedgerIndex {
  const byName = new Map<string, LedgerRow[]>()
  const normOwners = new Map<string, Set<string>>() // 规范化键 → 落到它的**不同台账名**集合
  for (const r of rows) {
    const list = byName.get(r.name) ?? []
    list.push(r)
    byName.set(r.name, list)
    const key = normalizeAntibodyName(r.name)
    const owners = normOwners.get(key) ?? new Set<string>()
    owners.add(r.name)
    normOwners.set(key, owners)
  }
  const byNorm = new Map<string, string>()
  const ambiguousNorm = new Set<string>()
  for (const [key, owners] of normOwners) {
    if (owners.size === 1) byNorm.set(key, [...owners][0])
    else ambiguousNorm.add(key) // 多个不同抗体撞键 → 歧义，不自动解析
  }
  return { byName, byNorm, ambiguousNorm }
}

/** 从种子构建默认台账索引（纯函数测试用；DB 路由用真实 antibodies 表构建）。 */
export function buildSeedLedgerIndex(seed: AntibodyLedgerDef[] = ANTIBODY_LEDGER_SEED): LedgerIndex {
  return buildLedgerIndex(seed.map((a) => ({ name: a.name, form: a.form, perTestPrice: a.perTestPrice, category: a.category })))
}

/** 从别名种子构建 规范化(LIS名) → 台账名 映射（DB 别名可 merge 进来）。 */
export function buildSynonymMap(seed: AntibodySynonymDef[] = ANTIBODY_SYNONYM_SEED): Map<string, string> {
  const m = new Map<string, string>()
  for (const s of seed) m.set(normalizeAntibodyName(s.lisName), s.canonicalName)
  return m
}

/**
 * 剂型解析：LIS 无剂型 + 台账同名多剂型 → **保守取高价**（perTestPrice 最大 = 成本最高 = 不高估毛利），标 formAssumed。
 * 若指定 requestedForm 且台账有该剂型 → 精确取，formAssumed=false。
 */
export function resolveForm(rows: LedgerRow[], requestedForm?: string | null): { row: LedgerRow; formAssumed: boolean } {
  if (requestedForm) {
    const hit = rows.find((r) => (r.form ?? '') === requestedForm)
    if (hit) return { row: hit, formAssumed: false }
  }
  if (rows.length === 1) return { row: rows[0], formAssumed: false }
  // 多剂型（或 requestedForm 未命中）：保守取每人份价最高者
  const sorted = [...rows].sort((a, b) => (Number(b.perTestPrice ?? 0)) - (Number(a.perTestPrice ?? 0)))
  return { row: sorted[0], formAssumed: rows.length > 1 }
}

export type MatchKind = 'exact' | 'alias' | 'missing' | 'non_antibody'

export interface ResolveResult {
  input: string
  matchKind: MatchKind
  canonicalName: string | null
  form: string | null
  formAssumed: boolean // 多剂型保守取高价时 true（行级「剂型待确认」）
  perTestPrice: number | null
  priceStatus: 'has_price' | 'missing'
  via?: 'synonym' | 'normalized' // alias 命中方式
  category?: MarkerCategory // non_antibody 时的子类（白片/HE/重切深切/分子/特染(疑)）
  note?: string
}

/**
 * 把 LIS 抗体名解析成台账（价 + 剂型）。
 * 解析顺序：非抗体识别 → 精确名 → 别名种子 → 规范化命中 → 真缺(missing)。
 *
 * @param synonymMap 规范化(LIS名) → 台账名（由 buildSynonymMap(种子) 与 DB 别名 merge 而来）
 */
export function resolveAntibodyName(
  lisName: string,
  index: LedgerIndex,
  synonymMap: Map<string, string> = buildSynonymMap(),
  opts: { form?: string | null } = {},
): ResolveResult {
  const input = String(lisName ?? '').trim()
  const base = (): ResolveResult => ({
    input,
    matchKind: 'missing',
    canonicalName: null,
    form: null,
    formAssumed: false,
    perTestPrice: null,
    priceStatus: 'missing',
  })

  if (!input) return base()

  // 0) 非抗体（白片/HE/深切重切/分子/特染疑）——不进抗体缺价清单
  const cat = classifyMarker(input)
  if (cat !== '抗体') {
    return { ...base(), matchKind: 'non_antibody', category: cat, note: `非抗体行（${cat}）` }
  }

  const pack = (canonical: string, via?: 'synonym' | 'normalized'): ResolveResult => {
    const rows = index.byName.get(canonical) ?? []
    if (!rows.length) {
      return { ...base(), canonicalName: canonical, via, note: '别名指向的台账名不存在' }
    }
    const { row, formAssumed } = resolveForm(rows, opts.form)
    const price = typeof row.perTestPrice === 'number' && Number.isFinite(row.perTestPrice) && row.perTestPrice > 0 ? row.perTestPrice : null
    return {
      input,
      matchKind: via ? 'alias' : 'exact',
      canonicalName: canonical,
      form: row.form ?? null,
      formAssumed,
      perTestPrice: price,
      priceStatus: price !== null ? 'has_price' : 'missing',
      via,
      note: formAssumed ? '剂型待确认（多剂型保守取高价）' : undefined,
    }
  }

  // 1) 精确台账名
  if (index.byName.has(input)) return pack(input)

  const norm = normalizeAntibodyName(input)

  // 2) 别名种子（生物学同义词）——**显式别名优先于歧义防护**（登记了别名即视为已消歧）
  const syn = synonymMap.get(norm)
  if (syn) return pack(syn, 'synonym')

  // 3) 规范化歧义防护：该键对应多个不同台账名（如 TCR）→ 不猜，返回缺价 + 要求消歧（防跨抗体误价）
  if (index.ambiguousNorm.has(norm)) {
    return { ...base(), note: `「${input}」规范化后在台账对应多个不同抗体（需精确名/剂型限定或登记别名消歧）·不自动解析防误价` }
  }

  // 4) 规范化命中（去连字符/空格/大小写等写法差异；仅单射键，安全）
  const canon = index.byNorm.get(norm)
  if (canon) return pack(canon, 'normalized')

  // 5) 台账真缺
  return { ...base(), note: '台账无此抗体·成本缺价·毛利待定（需 PM 补采购价）' }
}
