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
export interface LisImportResult {
  importBatch: string
  imported: number; inserted: number; updated: number; skipped: number
  partnersCreated: number; partnersMatched: number
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
}
