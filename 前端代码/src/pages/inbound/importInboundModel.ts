import type { InboundFormData, Location, Material, Supplier } from '@/types'

export const INBOUND_IMPORT_HEADERS = [
  '物料编码',
  '入库数量',
  '库位编码',
  '批号',
  '单价',
  '供应商编码',
  '生产日期',
  '有效期至',
  '备注',
] as const

export const MAX_INBOUND_IMPORT_ROWS = 1000

export type InboundImportStatus =
  | 'ready'
  | 'validation_error'
  | 'succeeded'
  | 'failed'

export interface InboundImportRow {
  rowNumber: number
  raw: Record<string, string>
  status: InboundImportStatus
  issues: string[]
  idempotencyKey: string
  payload: InboundFormData | null
  resultInboundNo?: string
  errorMessage?: string
}

export interface InboundImportReferences {
  materials: Material[]
  locations: Location[]
  suppliers?: Supplier[]
}

export interface InboundImportValidation {
  fileError: string | null
  rows: InboundImportRow[]
}

export interface InboundImportSummary {
  total: number
  succeeded: number
  failed: number
  validationRejected: number
  pending: number
}

type CreateInbound = (
  payload: InboundFormData,
  idempotencyKey: string,
) => Promise<unknown>

interface ExecuteOptions {
  retryFailedOnly?: boolean
}

interface ParsedCsv {
  headers: string[]
  rows: string[][]
  fileError: string | null
}

function normalizeCode(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLocaleUpperCase('en-US')
}

function normalizeCell(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim()
}

function buildUniqueCodeMap<T extends { code?: string; status?: string }>(items: T[]) {
  const map = new Map<string, T | null>()
  items
    .filter(item => item.status === undefined || item.status === 'active')
    .forEach(item => {
      const code = normalizeCode(item.code)
      if (!code) return
      map.set(code, map.has(code) ? null : item)
    })
  return map
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function parseFiniteNumber(value: string): number | null {
  if (value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isBlankRow(row: unknown[]): boolean {
  return row.every(cell => normalizeCell(cell) === '')
}

function readResultInboundNo(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const inboundNo = (result as { inboundNo?: unknown }).inboundNo
  return typeof inboundNo === 'string' && inboundNo.trim() ? inboundNo : undefined
}

function readErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      message?: unknown
      response?: { data?: { error?: { message?: unknown } } }
    }
    const responseMessage = candidate.response?.data?.error?.message
    if (typeof responseMessage === 'string' && responseMessage.trim()) return responseMessage
    if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message
  }
  return '提交失败，请重试'
}

/**
 * Parse RFC-4180-style CSV text locally. No workbook or server-side preview is implied.
 */
export function parseInboundCsv(text: string): ParsedCsv {
  const records: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }

    if (char === '"' && cell === '') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell)
      records.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  if (quoted) return { headers: [], rows: [], fileError: 'CSV 存在未闭合的引号' }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    records.push(row)
  }

  while (records.length > 0 && isBlankRow(records[records.length - 1])) records.pop()
  if (records.length < 2) return { headers: [], rows: [], fileError: 'CSV 没有可导入的数据行' }

  const headers = records[0].map((header, index) => {
    const normalized = normalizeCell(header)
    return index === 0 ? normalized.replace(/^\uFEFF/, '') : normalized
  })
  return { headers, rows: records.slice(1), fileError: null }
}

export function validateInboundImportRows(
  headers: string[],
  sourceRows: unknown[][],
  references: InboundImportReferences,
  createIdempotencyKey: () => string,
): InboundImportValidation {
  const normalizedHeaders = headers.map((header, index) => {
    const normalized = normalizeCell(header)
    return index === 0 ? normalized.replace(/^\uFEFF/, '') : normalized
  })
  const duplicateHeaders = normalizedHeaders.filter(
    (header, index) => normalizedHeaders.indexOf(header) !== index,
  )
  if (duplicateHeaders.length > 0) {
    return { fileError: `CSV 表头重复：${[...new Set(duplicateHeaders)].join('、')}`, rows: [] }
  }

  const requiredHeaders = [...INBOUND_IMPORT_HEADERS]
  const missingHeaders = requiredHeaders.filter(header => !normalizedHeaders.includes(header))
  const unknownHeaders = normalizedHeaders.filter(header => header && !requiredHeaders.includes(header as typeof INBOUND_IMPORT_HEADERS[number]))
  if (missingHeaders.length > 0 || unknownHeaders.length > 0) {
    const messages = []
    if (missingHeaders.length > 0) messages.push(`缺少列：${missingHeaders.join('、')}`)
    if (unknownHeaders.length > 0) messages.push(`未知列：${unknownHeaders.join('、')}`)
    return { fileError: `CSV 表头不符合直接入库模板（${messages.join('；')}）`, rows: [] }
  }

  const nonBlankRows = sourceRows
    .map((cells, sourceIndex) => ({ cells, rowNumber: sourceIndex + 2 }))
    .filter(({ cells }) => !isBlankRow(cells))
  if (nonBlankRows.length === 0) return { fileError: 'CSV 没有可导入的数据行', rows: [] }
  if (nonBlankRows.length > MAX_INBOUND_IMPORT_ROWS) {
    return { fileError: `单次最多导入 ${MAX_INBOUND_IMPORT_ROWS} 行；当前为 ${nonBlankRows.length} 行`, rows: [] }
  }

  if (references.materials.length === 0 || references.locations.length === 0) {
    return { fileError: '物料或库位基础数据尚未加载，当前不能安全匹配导入行', rows: [] }
  }

  const materialByCode = buildUniqueCodeMap(references.materials)
  const locationByCode = buildUniqueCodeMap(references.locations)
  const supplierByCode = buildUniqueCodeMap(references.suppliers ?? [])

  const rows = nonBlankRows.map(({ cells, rowNumber }): InboundImportRow => {
    const raw = Object.fromEntries(
      normalizedHeaders.map((header, index) => [header, normalizeCell(cells[index])]),
    )
    const issues: string[] = []
    const materialCode = normalizeCode(raw['物料编码'])
    const locationCode = normalizeCode(raw['库位编码'])
    const supplierCode = normalizeCode(raw['供应商编码'])
    const material = materialCode ? materialByCode.get(materialCode) : undefined
    const location = locationCode ? locationByCode.get(locationCode) : undefined
    const supplier = supplierCode ? supplierByCode.get(supplierCode) : undefined

    if (!materialCode || !material) issues.push('物料编码未匹配到启用物料')
    if (!locationCode || !location) issues.push('库位编码未匹配到启用库位')
    if (supplierCode && !supplier) issues.push('供应商编码未匹配到启用供应商')

    const quantityText = raw['入库数量']
    const quantity = parseFiniteNumber(quantityText)
    if (quantity === null || quantity <= 0) issues.push('入库数量必须是有限正数')

    const priceText = raw['单价']
    const price = parseFiniteNumber(priceText)
    if (priceText === '') {
      issues.push('单价为空；0 只允许由文件明确填写')
    } else if (price === null || price < 0) {
      issues.push('单价必须是有限非负数')
    }

    const productionDate = raw['生产日期']
    const expiryDate = raw['有效期至']
    if (productionDate && !isValidDate(productionDate)) issues.push('生产日期不是有效的 YYYY-MM-DD 日期')
    if (expiryDate && !isValidDate(expiryDate)) issues.push('有效期至不是有效的 YYYY-MM-DD 日期')
    if (
      productionDate
      && expiryDate
      && isValidDate(productionDate)
      && isValidDate(expiryDate)
      && expiryDate < productionDate
    ) {
      issues.push('有效期至不能早于生产日期')
    }

    const idempotencyKey = createIdempotencyKey()
    const ready = issues.length === 0 && material && location && quantity !== null && price !== null
    const payload: InboundFormData | null = ready
      ? {
          type: 'direct',
          materialId: material.id,
          locationId: location.id,
          quantity,
          price,
          batchNo: raw['批号'] || undefined,
          supplierId: supplier?.id,
          productionDate: productionDate || undefined,
          expiryDate: expiryDate || undefined,
          remark: raw['备注'] || undefined,
        }
      : null

    return {
      rowNumber,
      raw,
      status: ready ? 'ready' : 'validation_error',
      issues,
      idempotencyKey,
      payload,
    }
  })

  return { fileError: null, rows }
}

export async function executeInboundImport(
  sourceRows: InboundImportRow[],
  createInbound: CreateInbound,
  options: ExecuteOptions = {},
): Promise<InboundImportRow[]> {
  const rows = sourceRows.map(row => ({ ...row, issues: [...row.issues] }))
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const shouldRun = options.retryFailedOnly ? row.status === 'failed' : row.status === 'ready'
    if (!shouldRun || !row.payload) continue

    try {
      const result = await createInbound(row.payload, row.idempotencyKey)
      rows[index] = {
        ...row,
        status: 'succeeded',
        errorMessage: undefined,
        resultInboundNo: readResultInboundNo(result),
      }
    } catch (error) {
      rows[index] = {
        ...row,
        status: 'failed',
        errorMessage: readErrorMessage(error),
      }
    }
  }
  return rows
}

export function summarizeInboundImport(rows: InboundImportRow[]): InboundImportSummary {
  const succeeded = rows.filter(row => row.status === 'succeeded').length
  const failed = rows.filter(row => row.status === 'failed').length
  const validationRejected = rows.filter(row => row.status === 'validation_error').length
  const pending = rows.filter(row => row.status === 'ready').length
  return {
    total: rows.length,
    succeeded,
    failed,
    validationRejected,
    pending,
  }
}
