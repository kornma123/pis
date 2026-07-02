import request from './request'

// LIS 病例导入（admin）——喂拆分口径要的真蜡块数。后端 POST /lis-cases/{preview,import}。
// request 拦截器已解包 → 直接返回 data 层。

export type LisCaseRow = Record<string, string | number | null>

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
  imported: number
  skipped: number
  partnersCreated: number
  partnersMatched: number
}

export const lisCasesApi = {
  preview: (cases: LisCaseRow[]) => request.post('/lis-cases/preview', { cases }) as unknown as Promise<LisPreview>,
  import: (cases: LisCaseRow[]) => request.post('/lis-cases/import', { cases }) as unknown as Promise<LisImportResult>,
}
