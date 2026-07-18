/**
 * 第 2 层对照表导出（元素⑪·HON-3 条件②·§四执法点）——导出是免责声明被剥离的头号通道。
 *
 * **每一行**都带口径声明列（来源标签 + 未认账 + 口径版本 + 导出时刻 + 期间），
 *   让旧导出永生在邮件里时**自己声明自己「未认账 + 过时」**，剥不掉（裁剪/转发单独一行也带着）。
 * 列顺序镜像后端 `caliber-ratification.ts` 的 `EXPORT_DECLARATION_COLUMNS`（避免各处各拍列序）。
 */
import { downloadTextFile } from '@/lib/utils'
import type { ComparisonRow, CaliberRatification } from '@/types/hospital-cm'

/** 口径声明列（稳定列顺序·与后端 EXPORT_DECLARATION_COLUMNS 一致）。 */
export const EXPORT_DECLARATION_COLUMNS = [
  '_sourceTag',
  '_basisNote',
  '_basisVersion',
  '_exportedAt',
  '_periodRange',
  '_ratified',
] as const

export interface ExportDeclaration {
  _sourceTag: string
  _basisNote: string
  _basisVersion: string
  _exportedAt: string
  _periodRange: string
  _ratified: boolean
}

/** 构造一次导出的声明（fail-closed：缺 caliberRatification → 按未认账 + derived 声明·宁可多提示）。 */
export function buildExportDeclaration(
  caliber: CaliberRatification | null | undefined,
  opts: { exportedAt: string; periodRange?: string | null },
): ExportDeclaration {
  return {
    _sourceTag: caliber?.sourceTag ?? 'derived',
    _basisNote:
      caliber?.note ??
      '拆分口径由政策分摊常量派生，非实测成本；对外可能显著高估，业务方尚未认账，不得单独支撑对外结论。',
    _basisVersion: caliber?.basisVersion ?? '未知',
    _exportedAt: opts.exportedAt,
    _periodRange: (opts.periodRange && String(opts.periodRange).trim()) || '全部账期',
    _ratified: caliber?.ratified === true, // fail-closed：仅明确 true 才算认账
  }
}

const CELL_HEADERS: { key: string; label: string }[] = [
  { key: 'partnerName', label: '医院' },
  { key: 'cm', label: '贡献毛利' },
  { key: 'cmRate', label: '率' },
  { key: 'fixedCoverageShare', label: '占全组固定成本覆盖份额' },
  { key: 'caliber', label: '口径' },
  { key: 'state', label: '状态' },
  { key: 'measurable', label: '是否可测量' },
]

const DECL_LABELS: Record<string, string> = {
  _sourceTag: '来源标签',
  _basisNote: '口径声明',
  _basisVersion: '口径版本',
  _exportedAt: '导出时刻',
  _periodRange: '期间',
  _ratified: '是否已认账',
}

function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v)
  // 公式注入中和：=+-@·Tab·CR 开头的值在 Excel/WPS 打开会被当公式执行（DDE/函数）→ 前置单引号钝化。
  //   导出是外流通道（元素⑪本意就是治理导出），医院名/状态/口径声明列含人工录入文本，必须防注入。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  // CSV 转义：含逗号/引号/换行 → 包裹双引号并转义内部引号。
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * 导出对照表为 CSV（含逐行口径声明列）。exportedAt 由调用方给（前端本地导出时刻·允许读时钟）。
 * @returns 生成的 CSV 文本（供测试断言；同时触发下载）。
 */
export function exportComparisonCsv(
  rows: ComparisonRow[],
  caliber: CaliberRatification | null | undefined,
  opts: { periodRange?: string | null; exportedAt: string; download?: boolean } = { exportedAt: new Date().toISOString() },
): string {
  const decl = buildExportDeclaration(caliber, { exportedAt: opts.exportedAt, periodRange: opts.periodRange })
  const header = [...CELL_HEADERS.map((h) => h.label), ...EXPORT_DECLARATION_COLUMNS.map((c) => DECL_LABELS[c])]
  const lines = [header.map(csvCell).join(',')]
  for (const r of rows) {
    const cells = [
      r.partnerName || r.partnerId,
      r.measurable ? r.cm : null,
      r.measurable ? r.cmRate : null,
      r.measurable ? r.fixedCoverageShare : null,
      r.detail?.caliber ?? '',
      r.detail?.state ?? '',
      r.measurable ? '可测量' : 'UNMEASURED（代送/会诊/外送·未测量）',
    ]
    const declCells = EXPORT_DECLARATION_COLUMNS.map((c) => decl[c])
    lines.push([...cells, ...declCells].map(csvCell).join(','))
  }
  const csv = lines.join('\n')
  if (opts.download !== false) {
    const stamp = opts.exportedAt.slice(0, 10)
    downloadTextFile(`院级贡献毛利对照表_${opts.periodRange || '全部账期'}_${stamp}.csv`, csv, 'text/csv;charset=utf-8')
  }
  return csv
}
