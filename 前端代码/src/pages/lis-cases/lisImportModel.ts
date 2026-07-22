import type { LisPreview, LisRow } from '@/api/lis-cases'
import type { Grid } from '@/api/statement-import'

// 只保留流程所需列；患者姓名、证件、诊断、病史和任意额外列在本机解析时即丢弃。
export const CASE_COLS = ['病理号', '送检医院', '缴费方式', '病例状态', '登记时间', '接收时间', 'HE切片数', '蜡块数', '免疫组化数', '特染数', 'EBER数', 'PD-L1数', '送检部位', '亚专科']
export const MARKER_COLS = ['病理号', 'caseNo', 'markerName', '抗体名', 'adviceType', 'waxNo', 'sectionNo']
const CHUNK_SIZE = 150

export type FileKind = 'case' | 'marker' | 'unknown'
export type Outcome = 'complete' | 'partial' | 'unknown'

export interface ParsedFile {
  name: string
  kind: FileKind
  rows: LisRow[]
}

export interface ExtendedImportResult {
  importBatch: string
  imported: number
  inserted: number
  updated: number
  skipped: number
  partnersCreated: number
  partnersMatched: number
  rejectedCrossMonth?: number
  rejectedInvalidDate?: number
}

export interface ImportSummary {
  caseImported: number
  caseInserted: number
  caseUpdated: number
  caseSkipped: number
  rejectedCrossMonth: number
  rejectedInvalidDate: number
  markerImported: number
  markerSkipped: number
  markerCases: number
  markerUnmatched: number
  verifiedCaseChunks: number
  verifiedMarkerChunks: number
}

export interface ImportEvidence {
  outcome: Outcome
  summary: ImportSummary
  markerBlocked: boolean
  message: string
}

export const EMPTY_SUMMARY: ImportSummary = {
  caseImported: 0,
  caseInserted: 0,
  caseUpdated: 0,
  caseSkipped: 0,
  rejectedCrossMonth: 0,
  rejectedInvalidDate: 0,
  markerImported: 0,
  markerSkipped: 0,
  markerCases: 0,
  markerUnmatched: 0,
  verifiedCaseChunks: 0,
  verifiedMarkerChunks: 0,
}

export function extract(grid: Grid, columns: string[], keyColumn: string): LisRow[] {
  if (!grid.length) return []
  const header = grid[0].map((cell) => String(cell ?? '').trim())
  const indices: Record<string, number> = {}
  for (const column of columns) {
    const index = header.indexOf(column)
    if (index >= 0) indices[column] = index
  }
  const keyIndex = indices[keyColumn]
  if (keyIndex == null) return []

  const rows: LisRow[] = []
  for (let rowIndex = 1; rowIndex < grid.length; rowIndex += 1) {
    const source = grid[rowIndex]
    if (!String(source[keyIndex] ?? '').trim()) continue
    const sanitized: LisRow = {}
    for (const [column, index] of Object.entries(indices)) {
      sanitized[column] = source[index] as string | number | null
    }
    rows.push(sanitized)
  }
  return rows
}

export function detect(grid: Grid): FileKind {
  const header = new Set((grid[0] || []).map((cell) => String(cell ?? '').trim()))
  if (header.has('markerName') || header.has('抗体名')) return 'marker'
  if (header.has('病理号') && (header.has('蜡块数') || header.has('免疫组化数') || header.has('HE切片数'))) return 'case'
  return 'unknown'
}

export function chunks<T>(items: T[]) {
  const output: T[][] = []
  for (let index = 0; index < items.length; index += CHUNK_SIZE) output.push(items.slice(index, index + CHUNK_SIZE))
  return output
}

export function publicError(_error: unknown, fallback: string) {
  return fallback
}

export function aggregatePreview(current: LisPreview, next: LisPreview): LisPreview {
  return {
    valid: current.valid + next.valid,
    skipped: current.skipped + next.skipped,
    hospitalCount: current.hospitalCount + next.hospitalCount,
    newHospitals: [...new Set([...current.newHospitals, ...next.newHospitals])],
    specimenDistribution: {
      tissue: current.specimenDistribution.tissue + next.specimenDistribution.tissue,
      tissue_complex: current.specimenDistribution.tissue_complex + next.specimenDistribution.tissue_complex,
      cytology: current.specimenDistribution.cytology + next.specimenDistribution.cytology,
    },
    warnings: [...current.warnings, ...next.warnings],
  }
}
