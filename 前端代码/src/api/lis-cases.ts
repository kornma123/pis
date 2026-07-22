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
  incomingMonth?: string | null // CROSS_MONTH_CONFLICT：导入行月锚；无日期显式为 null
  value?: string // INVALID_OPERATE_TIME：非法值的截断安全摘要
}
export interface LisImportResult {
  importBatch: string
  imported: number; inserted: number; updated: number; skipped: number
  partnersCreated: number; partnersMatched: number
  rejectedCrossMonth?: number; rejectedInvalidDate?: number
  rejections?: RejectionItem[]; rejectedTotal?: number; rejectionsTruncated?: boolean
}
export interface VerifiedLisImportResult extends LisImportResult {
  rejectedCrossMonth: number; rejectedInvalidDate: number
  rejections: RejectionItem[]; rejectedTotal: number; rejectionsTruncated: boolean
}
// #179 登记月带留痕更正：expected=当前值 CAS；confirm 必须显式 true。
export interface CorrectionPayload {
  partnerId: string; caseNo: string; expectedOperateTime: string; newOperateTime: string; reason: string; confirm: true
}
export interface CorrectionResult {
  caseNo: string; partnerId: string; oldOperateTime: string | null; newOperateTime: string; reason: string
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

const CANONICAL_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('LIS 回执格式不可验证')
  return value as Record<string, unknown>
}

function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('LIS 回执计数不可验证')
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('LIS 回执文本不可验证')
  return value
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('LIS 回执字段不可验证')
  }
}

function canonicalDate(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string') throw new Error('LIS 更正回执时间不可验证')
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01])(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?)?$/.exec(value)
  if (!match) throw new Error('LIS 更正回执时间不可验证')
  if (match[3]) {
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    if (day > days) throw new Error('LIS 更正回执时间不可验证')
    if (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59 || (match[6] !== undefined && Number(match[6]) > 59))) {
      throw new Error('LIS 更正回执时间不可验证')
    }
    const zone = match[8]
    if (zone && zone !== 'Z') {
      const zoneHour = Number(zone.slice(1, 3)), zoneMinute = Number(zone.slice(4, 6))
      if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) {
        throw new Error('LIS 更正回执时间不可验证')
      }
    }
  }
  return value
}

function historicalOperateTime(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 128) {
    throw new Error('LIS 更正回执旧时间不可验证')
  }
  return value
}

function parseRejection(value: unknown): RejectionItem {
  const item = recordOf(value)
  if (item.code === 'CROSS_MONTH_CONFLICT') {
    exactKeys(item, ['code', 'caseNo', 'partnerName', 'existingMonth', 'incomingMonth'])
    if (!CANONICAL_MONTH.test(requiredString(item.existingMonth))) throw new Error('LIS 拒收月份不可验证')
    if (item.incomingMonth !== null && !CANONICAL_MONTH.test(requiredString(item.incomingMonth))) throw new Error('LIS 拒收月份不可验证')
    return { code: item.code, caseNo: requiredString(item.caseNo), partnerName: requiredString(item.partnerName), existingMonth: item.existingMonth as string, incomingMonth: item.incomingMonth as string | null }
  }
  if (item.code === 'INVALID_OPERATE_TIME') {
    exactKeys(item, ['code', 'caseNo', 'partnerName', 'value'])
    const digest = requiredString(item.value)
    if (digest.length > 40) throw new Error('LIS 拒收摘要不可验证')
    return { code: item.code, caseNo: requiredString(item.caseNo), partnerName: requiredString(item.partnerName), value: digest }
  }
  if (item.code === 'ROW_SHAPE_INVALID') {
    exactKeys(item, ['code', 'caseNo', 'partnerName'])
    if (typeof item.caseNo !== 'string' || typeof item.partnerName !== 'string') throw new Error('LIS 拒收标识不可验证')
    return { code: item.code, caseNo: item.caseNo, partnerName: item.partnerName }
  }
  throw new Error('LIS 拒收类型不可验证')
}

export function parseLisImportResult(raw: unknown, expectedRowCount: number): VerifiedLisImportResult {
  const value = recordOf(raw)
  const expected = safeCount(expectedRowCount)
  const imported = safeCount(value.imported), inserted = safeCount(value.inserted), updated = safeCount(value.updated)
  const skipped = safeCount(value.skipped), rejectedCrossMonth = safeCount(value.rejectedCrossMonth)
  const rejectedInvalidDate = safeCount(value.rejectedInvalidDate), rejectedTotal = safeCount(value.rejectedTotal)
  const partnersCreated = safeCount(value.partnersCreated), partnersMatched = safeCount(value.partnersMatched)
  if (imported !== inserted + updated) throw new Error('LIS 导入计数互相矛盾')
  if (rejectedTotal !== skipped + rejectedCrossMonth + rejectedInvalidDate) throw new Error('LIS 拒收计数互相矛盾')
  if (imported + rejectedTotal !== expected) throw new Error('LIS 导入回执与请求行数不守恒')
  if (!Array.isArray(value.rejections) || typeof value.rejectionsTruncated !== 'boolean') throw new Error('LIS 拒收回执不可验证')
  const rejections = value.rejections.map(parseRejection)
  if (rejections.length > rejectedTotal || value.rejectionsTruncated !== (rejections.length < rejectedTotal)) {
    throw new Error('LIS 拒收截断状态互相矛盾')
  }
  const observed = rejections.reduce((counts, item) => {
    if (item.code === 'ROW_SHAPE_INVALID') counts.skipped++
    else if (item.code === 'CROSS_MONTH_CONFLICT') counts.crossMonth++
    else counts.invalidDate++
    return counts
  }, { skipped: 0, crossMonth: 0, invalidDate: 0 })
  const declared = { skipped, crossMonth: rejectedCrossMonth, invalidDate: rejectedInvalidDate }
  const categoryMismatch = value.rejectionsTruncated
    ? observed.skipped > declared.skipped || observed.crossMonth > declared.crossMonth || observed.invalidDate > declared.invalidDate
    : observed.skipped !== declared.skipped || observed.crossMonth !== declared.crossMonth || observed.invalidDate !== declared.invalidDate
  if (categoryMismatch) throw new Error('LIS 拒收类型与分类计数互相矛盾')
  return {
    importBatch: requiredString(value.importBatch), imported, inserted, updated, skipped,
    partnersCreated, partnersMatched, rejectedCrossMonth, rejectedInvalidDate,
    rejections, rejectedTotal, rejectionsTruncated: value.rejectionsTruncated,
  }
}

export function parseCorrectionResult(raw: unknown): CorrectionResult {
  const value = recordOf(raw)
  exactKeys(value, ['caseNo', 'partnerId', 'oldOperateTime', 'newOperateTime', 'reason'])
  return {
    caseNo: requiredString(value.caseNo),
    partnerId: requiredString(value.partnerId),
    oldOperateTime: historicalOperateTime(value.oldOperateTime),
    newOperateTime: canonicalDate(value.newOperateTime, false) as string,
    reason: requiredString(value.reason),
  }
}

type ImportLisCases = {
  (cases: LisRow[], contract: 'verified'): Promise<VerifiedLisImportResult>
  /** @deprecated 旧测试/调用兼容；新消费者必须显式请求 verified contract。 */
  (cases: LisRow[]): Promise<LisImportResult>
}

const importLisCases = (async (cases: LisRow[]) => (
  parseLisImportResult(await request.post('/lis-cases/import', { cases }), cases.length)
)) as ImportLisCases

export const lisCasesApi = {
  list: (params: LisListParams) => request.get('/lis-cases', { params }) as unknown as Promise<Paginated<LisCaseItem>>,
  preview: (cases: LisRow[]) => request.post('/lis-cases/preview', { cases }) as unknown as Promise<LisPreview>,
  import: importLisCases,
  importMarkers: (markers: LisRow[]) => request.post('/lis-cases/import-markers', { markers }) as unknown as Promise<MarkerImportResult>,
  batches: (limit = 3) => request.get('/lis-cases/batches', { params: { limit } }) as unknown as Promise<LisBatch[]>,
  markers: (partnerId: string, caseNo: string) => request.get('/lis-cases/markers', { params: { partnerId, caseNo } }) as unknown as Promise<CaseMarker[]>,
  setSpecimen: (caseNo: string, specimenType: string, partnerId: string) =>
    request.put(`/lis-cases/${encodeURIComponent(caseNo)}/specimen-type`, { specimenType, partnerId }) as unknown as Promise<{ caseNo: string; specimenType: string; source: string }>,
  correct: async (payload: CorrectionPayload) => parseCorrectionResult(await request.post('/lis-cases/correction', payload)),
}
