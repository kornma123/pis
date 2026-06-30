/**
 * 业务线分类引擎（配置驱动导入器 P2）—— 替换 revenue-attribution 的 A/B/C「两层模型」seam。
 *
 * 逐院 config.lines → 给一行对账单（病理号/项目名/备注）判：命中哪条业务线、计入(in)/移出(out)、命中依据。
 * 直接移植定稿 mockup（config_v11/v12）的 classify（已多轮对抗审）：
 *   1) **前缀优先**：按 line 顺序，病理号以某 line 的某前缀开头 → 命中该线（首条命中即返回）。
 *   2) 否则 **关键词/备注**：收集所有 enabled line 中 项目名含关键词 或 备注含备注词 的命中（按 line 去重）。
 *      0 命中 = 未匹配(none)；1 命中 = 命中；>1 = 歧义(ambiguous，需人工归类)。
 *
 * 归一（v3 修的地基坑）：NFKC 全角→半角；空前缀/空关键词【不匹配一切】（防 '' 静默吞全部）；空值跳过。
 * 只有 line.on=true 的业务线参与。
 */
import type { PartnerConfigLine } from './partner-config.js'

export interface ClassifyInput {
  no: string // 病理号 / 编号（可空，如外送明细）
  item: string // 项目名称 / 服务项目
  remark?: string // 备注（仅配置映射了备注列时有意义）
}

export type ClassifyResult =
  | { kind: 'matched'; line: PartnerConfigLine; scope: 'in' | 'out'; by: string }
  | { kind: 'ambiguous'; lines: PartnerConfigLine[] }
  | { kind: 'none' }

/** NFKC 归一 + trim（全角字母/数字→半角）。 */
function nfkc(s: unknown): string {
  return (s == null ? '' : String(s)).normalize('NFKC').trim()
}
/** 匹配用归一：NFKC + 大小写折叠（codex F6：'Panel'≈'panel'、'h'≈'H'，否则金额被推进 unmatched）。 */
function fold(s: unknown): string {
  return nfkc(s).toLowerCase()
}

/** 病理号以前缀开头（前缀/号均归一+大小写折叠；空串不匹配——v3 修：空前缀曾匹配一切）。 */
export function startsWithPrefix(no: string, prefix: string): boolean {
  const n = fold(no)
  const p = fold(prefix)
  return p.length > 0 && n.length > 0 && n.startsWith(p)
}

/** 文本含关键词（均归一+大小写折叠；空关键词不匹配）。 */
export function containsKeyword(text: string, kw: string): boolean {
  const t = fold(text)
  const k = fold(kw)
  return k.length > 0 && t.length > 0 && t.includes(k)
}

/**
 * 分类一行。lines = 该院配置的业务线（内部按 on 过滤）。
 */
export function classify(lines: PartnerConfigLine[], input: ClassifyInput): ClassifyResult {
  const enabled = lines.filter((l) => l.on)
  const no = input.no ?? ''
  const item = input.item ?? ''
  const remark = input.remark ?? ''

  // 1) 前缀优先：命中多个前缀时取【最长】前缀（更具体），并列取 line 顺序靠前。
  //    codex F7：原「按 line 顺序首条命中即返回」会让短前缀 'H' 吃掉长前缀 'HE' → 误分类。
  let bestPrefix: { line: PartnerConfigLine; prefix: string; len: number } | null = null
  for (const l of enabled) {
    for (const p of l.prefixes) {
      if (startsWithPrefix(no, p)) {
        const len = fold(p).length
        if (!bestPrefix || len > bestPrefix.len) bestPrefix = { line: l, prefix: p, len }
      }
    }
  }
  if (bestPrefix) return { kind: 'matched', line: bestPrefix.line, scope: bestPrefix.line.scope, by: `前缀 ${nfkc(bestPrefix.prefix)}` }

  // 2) 关键词（项目名）/备注，收集命中（按 line 去重）
  const hits: PartnerConfigLine[] = []
  for (const l of enabled) {
    if (hits.includes(l)) continue
    const kw = l.keywords.find((k) => containsKeyword(item, k))
    if (kw) {
      hits.push(l)
      continue
    }
    const rm = l.remarks.find((r) => containsKeyword(remark, r))
    if (rm) hits.push(l)
  }

  if (hits.length === 0) return { kind: 'none' }
  if (hits.length === 1) {
    const l = hits[0]
    const byKw = l.keywords.find((k) => containsKeyword(item, k))
    const by = byKw ? `项目名「${nfkc(byKw)}」` : `备注「${nfkc(l.remarks.find((r) => containsKeyword(remark, r)) || '')}」`
    return { kind: 'matched', line: l, scope: l.scope, by }
  }
  return { kind: 'ambiguous', lines: hits }
}
