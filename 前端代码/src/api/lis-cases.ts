import request from './request'

// LIS 病例（admin/财务）。后端 /lis-cases/*。request 拦截器已解包 → 直接返回 data 层。
export type LisRow = Record<string, string | number | null>

export interface LisPreview {
  valid: number
  skipped: number
  hospitalCount: number
  newHospitals: string[]
  specimenDistribution: { tissue: number; tissue_complex: number; cytology: number }
  warnings: string[]
}
// #178 typed rejection item：机器合同是 code 字段；每项只含安全识别字段，不回显整行/患者信息。
export type RejectionCode = 'CROSS_MONTH_CONFLICT' | 'INVALID_OPERATE_TIME' | 'ROW_SHAPE_INVALID'
export interface RejectionItem {
  code: RejectionCode
  caseNo: string
  partnerName: string
  existingMonth?: string // CROSS_MONTH_CONFLICT：库中月锚
  incomingMonth?: string // CROSS_MONTH_CONFLICT：导入行月锚
  value?: string // INVALID_OPERATE_TIME：非法值的截断安全摘要
}
export interface LisImportResult {
  importBatch: string
  imported: number; inserted: number; updated: number; skipped: number
  partnersCreated: number; partnersMatched: number
  rejectedCrossMonth?: number; rejectedInvalidDate?: number
  rejections?: RejectionItem[]; rejectedTotal?: number; rejectionsTruncated?: boolean
}
// #179 登记月带留痕更正：expected=当前值 CAS；confirm 必须显式 true。
export interface CorrectionPayload {
  partnerId: string; caseNo: string; expectedOperateTime: string; newOperateTime: string; reason: string; confirm: true
}
export interface CorrectionResult {
  caseNo: string; partnerId: string; oldOperateTime: string | null; newOperateTime: string | null; reason: string
}
export interface MarkerImportResult {
  importBatch: string
  imported: number; skipped: number; casesAffected: number; unmatched: number; unmatchedCases: string[]
}
export interface LisCaseItem {
  id: string; caseNo: string; partnerId: string | null; partnerName: string | null
  specimenType: string | null; specimenTypeSource: string
  quantities: { heSlide: number; block: number; ihc: number; specialStain: number; eber: number; pdl1: number }
  status: string; operateTime: string | null; importBatch: string | null
}
export interface LisBatch { importBatch: string; caseCount: number; hospitalCount: number; importedAt: string; operatorName: string | null }
export interface CaseMarker { markerName: string; adviceType: string | null; kind: 'antibody' | 'white' | 'recut' | 'other'; waxNo: string | null; sectionNo: string | null }
export interface Paginated<T> { list: T[]; page: number; pageSize: number; total: number }

export interface LisListParams { page?: number; pageSize?: number; partnerId?: string; keyword?: string; specimenType?: string }

export const lisCasesApi = {
  list: (params: LisListParams) => request.get('/lis-cases', { params }) as unknown as Promise<Paginated<LisCaseItem>>,
  preview: (cases: LisRow[]) => request.post('/lis-cases/preview', { cases }) as unknown as Promise<LisPreview>,
  import: (cases: LisRow[]) => request.post('/lis-cases/import', { cases }) as unknown as Promise<LisImportResult>,
  importMarkers: (markers: LisRow[]) => request.post('/lis-cases/import-markers', { markers }) as unknown as Promise<MarkerImportResult>,
  batches: (limit = 3) => request.get('/lis-cases/batches', { params: { limit } }) as unknown as Promise<LisBatch[]>,
  markers: (partnerId: string, caseNo: string) => request.get('/lis-cases/markers', { params: { partnerId, caseNo } }) as unknown as Promise<CaseMarker[]>,
  setSpecimen: (caseNo: string, specimenType: string, partnerId: string) =>
    request.put(`/lis-cases/${encodeURIComponent(caseNo)}/specimen-type`, { specimenType, partnerId }) as unknown as Promise<{ caseNo: string; specimenType: string; source: string }>,
  correct: (payload: CorrectionPayload) => request.post('/lis-cases/correction', payload) as unknown as Promise<CorrectionResult>,
}
