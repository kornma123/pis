import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { v4 as uuidv4 } from 'uuid'

const REDACTED = '[REDACTED]'
const OMITTED = '[OMITTED]'
const MAX_DEPTH = 6
const MAX_KEYS = 64
const MAX_SCALAR = 512
const MAX_SERIALIZED = 4000
const MAX_HASH_DEPTH = 32
const MAX_HASH_NODES = 100_000

const CREDENTIAL_KEY = /pass|pwd|token|secret|credential|authorization/i
const CHINESE_PATIENT_KEY = /患者|病人|姓名|证件|身份证|手机号|手机|电话|联系方式|诊断|疾病|病历|病例|住院号|门诊号|病理号/
const PATIENT_KEYS = new Set([
  'patient', 'patientid', 'patientno', 'patientname',
  'fullname', 'realname', 'personname',
  'idcard', 'idcardno', 'identitycard', 'identityno', 'identitynumber',
  'certificateno', 'certificatenumber', 'passportno', 'passportnumber',
  'phone', 'phonenumber', 'mobile', 'mobilenumber', 'telephone', 'tel',
  'email', 'address', 'contact', 'contactname', 'contactphone', 'contactmobile',
  'diagnosis', 'diagnostic', 'diagnosiscode', 'disease', 'diseasecode', 'icd', 'icdcode',
  'caseid', 'caseno', 'medicalrecord', 'medicalrecordid', 'medicalrecordno', 'mrn',
  'admissionno', 'inpatientno', 'outpatientno', 'pathologyno', 'specimenno',
])
const BULK_KEYS = new Set([
  'grid', 'rawgrid', 'table', 'tabledata', 'sheet', 'sheetdata', 'worksheet',
  'rows', 'rowdata', 'lines', 'linedata', 'cases', 'orders', 'items', 'records',
  'cells', 'rawpayload', 'payloadrows', 'dataset',
])
const STATEMENT_TEMPLATES = new Set([
  'line_item', 'service_fee_mixed', 'consult_remote', 'diagnostic_fee',
  'category_summary', 'joint_venture', 'outsourced_detail', 'unknown',
])

interface BatchSummary {
  status: 'summarized' | 'unavailable'
  sha256: string | null
  rowCount: number | null
  columnCount: number | null
  cellCount: number | null
}

interface StatementMetadata {
  requestId: string
  business: {
    partnerId: string | null
    serviceMonth: string | null
    template: string | null
    confirm: boolean | null
  }
  batch: BatchSummary
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasToJSONInPrototypeChain(value: object): boolean {
  try {
    let current: object | null = value
    while (current !== null) {
      if (utilTypes.isProxy(current) || Object.prototype.hasOwnProperty.call(current, 'toJSON')) return true
      current = Object.getPrototypeOf(current)
    }
    return false
  } catch {
    return true
  }
}

function isDigestSafe(
  value: unknown,
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || utilTypes.isProxy(value)) return false
  if (depth > MAX_HASH_DEPTH || state.nodes >= MAX_HASH_NODES || state.seen.has(value)) return false

  state.nodes += 1
  state.seen.add(value)
  try {
    if (hasToJSONInPrototypeChain(value)) return false
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor) || !isDigestSafe(descriptor.value, depth + 1, state)) return false
      }
      return true
    }
    if (!isPlainRecord(value)) return false
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || !isDigestSafe(descriptor.value, depth + 1, state)) return false
    }
    return true
  } catch {
    return false
  } finally {
    state.seen.delete(value)
  }
}

function isPatientKey(key: string): boolean {
  const normalized = normalizeKey(key)
  return CHINESE_PATIENT_KEY.test(key) || normalized.startsWith('patient') || PATIENT_KEYS.has(normalized)
}

function digest(value: unknown): string | null {
  try {
    if (!isDigestSafe(value, 0, { nodes: 0, seen: new WeakSet<object>() })) return null
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') return null
    return createHash('sha256').update(serialized).digest('hex')
  } catch {
    return null
  }
}

function summarizeBulk(value: unknown): { count: number | null; sha256: string | null } {
  try {
    if (value !== null && typeof value === 'object' && utilTypes.isProxy(value)) {
      return { count: null, sha256: null }
    }
    let count: number | null = null
    if (Array.isArray(value)) count = value.length
    else if (isPlainRecord(value)) count = Object.keys(value).length
    else if (value === null || value === undefined) count = 0
    return { count, sha256: digest(value) }
  } catch {
    return { count: null, sha256: null }
  }
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return OMITTED
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : OMITTED
  if (typeof value === 'string') return value.length <= MAX_SCALAR ? value : OMITTED
  if (typeof value === 'object' && utilTypes.isProxy(value)) return OMITTED
  if (Array.isArray(value)) return summarizeBulk(value)
  if (!isPlainRecord(value)) return OMITTED
  if (seen.has(value)) return OMITTED

  seen.add(value)
  const output: Record<string, unknown> = Object.create(null)
  try {
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
      if (CREDENTIAL_KEY.test(key) || isPatientKey(key)) {
        output[key] = REDACTED
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        output[key] = OMITTED
        continue
      }
      output[key] = BULK_KEYS.has(normalizeKey(key))
        ? summarizeBulk(descriptor.value)
        : sanitizeValue(descriptor.value, depth + 1, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function unavailableBatch(): BatchSummary {
  return { status: 'unavailable', sha256: null, rowCount: null, columnCount: null, cellCount: null }
}

function unavailableStatement(requestId: string): StatementMetadata {
  return {
    requestId,
    business: { partnerId: null, serviceMonth: null, template: null, confirm: null },
    batch: unavailableBatch(),
  }
}

function dataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function summarizeGrid(grid: unknown): BatchSummary {
  if (grid !== null && typeof grid === 'object' && utilTypes.isProxy(grid)) return unavailableBatch()
  if (!Array.isArray(grid)) return unavailableBatch()
  try {
    let columnCount = 0
    let cellCount = 0
    for (const row of grid) {
      if (row !== null && typeof row === 'object' && utilTypes.isProxy(row)) return unavailableBatch()
      if (!Array.isArray(row)) return unavailableBatch()
      columnCount = Math.max(columnCount, row.length)
      cellCount += row.length
    }
    const sha256 = digest(grid)
    if (!sha256) return unavailableBatch()
    return { status: 'summarized', sha256, rowCount: grid.length, columnCount, cellCount }
  } catch {
    return unavailableBatch()
  }
}

function buildStatementMetadata(body: unknown, requestId: string): StatementMetadata {
  const fallback = unavailableStatement(requestId)
  try {
    if (!isPlainRecord(body)) return fallback
    const partnerId = dataProperty(body, 'partnerId')
    const serviceMonth = dataProperty(body, 'serviceMonth')
    const template = dataProperty(body, 'template')
    const confirm = dataProperty(body, 'confirm')
    return {
      requestId,
      business: {
        partnerId: typeof partnerId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(partnerId) ? partnerId : null,
        serviceMonth: typeof serviceMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(serviceMonth) ? serviceMonth : null,
        template: typeof template === 'string' && STATEMENT_TEMPLATES.has(template) ? template : null,
        confirm: typeof confirm === 'boolean' ? confirm : null,
      },
      batch: summarizeGrid(dataProperty(body, 'grid')),
    }
  } catch {
    return fallback
  }
}

function requestId(): string {
  try {
    return uuidv4()
  } catch {
    return 'AUDIT_REQUEST_ID_UNAVAILABLE'
  }
}

function toHookFreeTree(
  value: unknown,
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || utilTypes.isProxy(value)) throw new Error('Unsafe audit metadata')
  if (depth > MAX_HASH_DEPTH || state.nodes >= MAX_HASH_NODES || state.seen.has(value)) {
    throw new Error('Unbounded audit metadata')
  }

  state.nodes += 1
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = []
      Object.setPrototypeOf(output, null)
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) throw new Error('Unsafe audit metadata')
        output[index] = toHookFreeTree(descriptor.value, depth + 1, state)
      }
      return output
    }
    if (!isPlainRecord(value)) throw new Error('Unsafe audit metadata')
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('Unsafe audit metadata')
      output[key] = toHookFreeTree(descriptor.value, depth + 1, state)
    }
    return output
  } finally {
    state.seen.delete(value)
  }
}

function hookFreeJSONString(value: unknown): string {
  const safe = toHookFreeTree(value, 0, { nodes: 0, seen: new WeakSet<object>() })
  const serialized = JSON.stringify(safe)
  if (typeof serialized !== 'string') throw new Error('Audit metadata is not serializable')
  return serialized
}

function serializeBounded(value: unknown, fallback: unknown): string {
  try {
    const serialized = hookFreeJSONString(value)
    if (typeof serialized === 'string' && serialized.length <= MAX_SERIALIZED) return serialized
  } catch {
    // Fall through to fixed server-owned metadata.
  }
  try {
    return hookFreeJSONString(fallback)
  } catch {
    return '{"requestId":"AUDIT_REQUEST_ID_UNAVAILABLE"}'
  }
}

/** Never falls back to serializing the original request body. */
export function serializeSuccessfulAuditRequest(body: unknown, requestPath: string): string {
  const serverRequestId = requestId()
  if (/^\/api\/v1\/statement-import(?:\/|$)/i.test(requestPath)) {
    const fallback = unavailableStatement(serverRequestId)
    try {
      return serializeBounded(buildStatementMetadata(body, serverRequestId), fallback)
    } catch {
      return serializeBounded(fallback, fallback)
    }
  }

  const fallback = { requestId: serverRequestId }
  try {
    if (!isPlainRecord(body)) return serializeBounded(fallback, fallback)
    const sanitized = sanitizeValue(body, 0, new WeakSet<object>())
    if (!isPlainRecord(sanitized)) return serializeBounded(fallback, fallback)
    sanitized.requestId = serverRequestId
    return serializeBounded(sanitized, fallback)
  } catch {
    return serializeBounded(fallback, fallback)
  }
}
