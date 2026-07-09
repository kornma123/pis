/**
 * 拆分口径认账 · 止损执法层（LEG-2 / 公理一）—— 纯口径，无 DB、无 express。
 *
 * 背景（`~/Desktop/方案-后续四项-实施计划(内部·真实标识符).md` §四）：
 *   政策分摊常量 `SPLIT_DIAG_FEE`（statement-revenue.ts）单方面决定「范围内(实验室) vs 范围外(诊断桶)」份额分界，
 *   其派生结论（在范围收入 / 院级贡献毛利 / 毛利率）**对外可能显著高估约 2 倍**、且**业务方尚未认账**。
 *   本文件是「止损」的**执法机制**（不只是通知）：让每一个消费该结论的**对外输出自带「口径未认账」水印**、
 *   让每一行**导出携带口径声明列**——防旧材料被当现状转发（传播算新增使用、生成时间不豁免）、
 *   防导出把免责声明剥离（导出是免责声明被剥离的头号通道·HON-3 条件②）。
 *
 * ⚠️ 边界（严格·见 §四）：本文件**只做水印/声明层**——
 *   - **不改** `SPLIT_DIAG_FEE` 本身、**不改**拆分公式、**不碰**认账状态机。
 *   - 认账状态字段本项目**尚无**（业务侧 LEG-2 登记 + 签字是 PM/业务的活，不在工程侧）→ 这里只放一个
 *     **只读占位**常量 `SPLIT_CALIBER_RATIFICATION`，恒 `'UNRATIFIED'`；**绝不在此发明签字流程/状态翻转**。
 *     将来 LEG-2 登记落地后，由那条独立工作流把此占位接到真实状态（本文件届时只读它、不产它）。
 */

import { SPLIT_DIAG_FEE, SPLIT_FORMULA_VERSION } from './statement-revenue.js'

/**
 * 认账状态（只读占位）。本项目尚无认账状态机 → 恒 `'UNRATIFIED'`（业务方未签字）。
 * `'RATIFIED'` 分支仅为将来真实状态接入预留形状；**当前工程侧无任何路径能把它置为 RATIFIED**（认账不可代签）。
 */
export type CaliberRatificationState = 'UNRATIFIED' | 'RATIFIED'
export const SPLIT_CALIBER_RATIFICATION: CaliberRatificationState = 'UNRATIFIED'

/** 来源标签（§三.11）：measured=实测 / derived=由口径/公式派生 / placeholder=占位待定。
 *  拆分结论 = 由政策分摊常量套公式**派生** → `'derived'`（诚实下限：即便底层实收是真值，份额分界仍是派生的）。 */
export type SourceTag = 'measured' | 'derived' | 'placeholder'
export const SPLIT_CALIBER_SOURCE_TAG: SourceTag = 'derived'

/** 口径声明正文（说人话·随水印/导出同行显示，与数字同视线）。 */
export const SPLIT_CALIBER_BASIS_NOTE =
  `拆分口径由政策分摊常量 SPLIT_DIAG_FEE(=${SPLIT_DIAG_FEE}) 套国标公式派生，非实测成本；` +
  `该「范围内收入 / 院级毛利」结论对外可能显著高估（约 2 倍），业务方尚未认账，不得单独支撑对外结论。`

/** 短徽标文案（与数字同视线的水印·LEG-2）。 */
export const SPLIT_CALIBER_WATERMARK_LABEL = '口径未经业务认账'
const RATIFIED_LABEL = '口径已认账'

/**
 * 认账水印对象——挂到**任何消费拆分结论的对外输出**响应上。
 * 前端据 `ratified===false` 在**与数字同视线**处强制渲染水印（不进 tooltip、不可被折叠隐藏）。
 * `ratified` 缺席时前端应 **fail-closed**（按未认账显示水印）——宁可多提示，不可漏提示。
 */
export interface CaliberRatification {
  /** true 才免水印；当前恒 false（UNRATIFIED）。 */
  ratified: boolean
  state: CaliberRatificationState
  /** 来源标签（derived）。 */
  sourceTag: SourceTag
  /** 口径版本 = SPLIT_FORMULA_VERSION（复用既有 drift-guard 版本，不另立）。 */
  basisVersion: string
  /** 短徽标文案（同视线水印）。 */
  label: string
  /** 完整口径声明正文。 */
  note: string
  /** 认账时间（只读占位：无状态机 → 恒 null，直到 LEG-2 登记落地）。 */
  ratifiedAt: string | null
}

/** 构造随响应透出的认账水印（恒 UNRATIFIED·纯常量派生·无副作用）。 */
export function splitCaliberRatification(): CaliberRatification {
  const ratified = SPLIT_CALIBER_RATIFICATION === 'RATIFIED' // 当前恒 false
  return {
    ratified,
    state: SPLIT_CALIBER_RATIFICATION,
    sourceTag: SPLIT_CALIBER_SOURCE_TAG,
    basisVersion: SPLIT_FORMULA_VERSION,
    label: ratified ? RATIFIED_LABEL : SPLIT_CALIBER_WATERMARK_LABEL,
    note: SPLIT_CALIBER_BASIS_NOTE,
    ratifiedAt: null,
  }
}

/**
 * 导出口径声明列（§三.11 + §四·执法点）——**每一行导出都带这几列**，让旧导出永生在邮件里时
 * **自己声明自己「未认账 + 过时」**，声明剥不掉（导出是免责声明被剥离的头号通道）。
 * `_exportedAt`/`_periodRange` 逐次导出给定；其余从口径常量派生。
 */
export interface ExportDeclaration {
  _sourceTag: SourceTag
  _basisNote: string
  _basisVersion: string
  _exportedAt: string
  _periodRange: string
  _ratified: boolean
}

/** 导出声明列的稳定列顺序（供 CSV/xlsx 表头拼接，避免各处各拍列序）。 */
export const EXPORT_DECLARATION_COLUMNS: (keyof ExportDeclaration)[] = [
  '_sourceTag', '_basisNote', '_basisVersion', '_exportedAt', '_periodRange', '_ratified',
]

/**
 * 构造一次导出的声明。
 * @param exportedAt 导出时刻（调用方给·ISO 串；工程侧用 `new Date().toISOString()`，前端用本地导出时刻）。
 * @param periodRange 期间范围（如 '2026-06' / '2026-01~2026-06' / '全部账期'）。
 *
 * ⚠️ **诚实天花板（§四.4）**：本声明只能覆盖**启用本机制之后**产生的导出；此前已流出的导出（邮件/表格里的旧文件）
 *   **无法追溯加签、无法枚举**。取证侧对存量导出通道的覆盖边界须在取证结论里写明——工程侧管不了历史副本。
 */
export function buildExportDeclaration(opts: { exportedAt: string; periodRange?: string | null }): ExportDeclaration {
  const r = splitCaliberRatification()
  return {
    _sourceTag: r.sourceTag,
    _basisNote: r.note,
    _basisVersion: r.basisVersion,
    _exportedAt: opts.exportedAt,
    _periodRange: (opts.periodRange && String(opts.periodRange).trim()) || '全部账期',
    _ratified: r.ratified,
  }
}

/**
 * 给导出行**逐行**追加声明列（返回新对象·不改入参）。声明随每行走 → 无论用户怎么裁剪/转发，
 * 单独一行也带着「未认账 + 口径版本 + 导出时刻 + 期间」，剥不掉。
 */
export function decorateExportRows<T extends Record<string, unknown>>(
  rows: T[],
  decl: ExportDeclaration,
): (T & ExportDeclaration)[] {
  return rows.map((row) => ({ ...row, ...decl }))
}
