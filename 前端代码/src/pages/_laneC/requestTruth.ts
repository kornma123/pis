import type { LaneCStats } from '@/api/inventory'
import type { Location, Material } from '@/types'
import type { LaneCListPayload, LaneCRecord, LaneCPagination } from './types'

export type RequestFailureKind =
  | 'network'
  | 'forbidden'
  | 'not-found'
  | 'payload-invalid'
  | 'unexpected'

export interface RequestFailure {
  kind: RequestFailureKind
  status?: number
}

export type RequestTruth<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; failure: RequestFailure }
  | { status: 'stale'; data: T; failure: RequestFailure }

class PayloadInvalidError extends Error {
  constructor() {
    super('Lane C payload validation failed')
    this.name = 'PayloadInvalidError'
  }
}

export class LaneCRequestError extends Error {
  readonly failure: RequestFailure
  readonly original: unknown

  constructor(failure: RequestFailure, original: unknown) {
    super('Lane C request failed')
    this.name = 'LaneCRequestError'
    this.failure = failure
    this.original = original
  }
}

function invalidPayload(): never {
  throw new PayloadInvalidError()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function parsePagination(value: unknown): LaneCPagination {
  if (!isObject(value)) invalidPayload()
  if (!isPositiveInteger(value.page) || !isPositiveInteger(value.pageSize)) invalidPayload()
  if (!isNonNegativeInteger(value.total) || !isNonNegativeInteger(value.totalPages)) invalidPayload()
  return value as unknown as LaneCPagination
}

function isLaneCRecord(value: unknown): value is LaneCRecord {
  return isObject(value)
    && isString(value.id)
    && isString(value.materialId)
    && isFiniteNonNegative(value.quantity)
    && isString(value.operator)
    && isString(value.createdAt)
}

function parsePage(value: unknown): { list: unknown[]; pagination: LaneCPagination } {
  if (!isObject(value) || !Array.isArray(value.list)) invalidPayload()
  const pagination = parsePagination(value.pagination)
  return { list: value.list, pagination }
}

export function parseLaneCStatsPayload(value: unknown): LaneCStats {
  if (!isObject(value)) invalidPayload()
  const keys = ['total', 'monthCount', 'monthQty', 'materialKinds', 'todayCount'] as const
  if (!keys.every(key => isFiniteNonNegative(value[key]))) invalidPayload()
  return value as unknown as LaneCStats
}

export function parseLaneCListPayload(value: unknown): LaneCListPayload {
  const page = parsePage(value)
  if (!page.list.every(isLaneCRecord)) invalidPayload()
  return value as LaneCListPayload
}

export function parseMaterialsPayload(value: unknown): Material[] {
  const page = parsePage(value)
  if (!page.list.every(material => isObject(material)
    && isString(material.id)
    && isString(material.code)
    && isString(material.name)
    && isString(material.unit)
    && isFiniteNonNegative(material.stock))) invalidPayload()
  return page.list as Material[]
}

export function parseLocationsPayload(value: unknown): Location[] {
  const page = parsePage(value)
  if (!page.list.every(location => isObject(location)
    && isString(location.id)
    && isString(location.name))) invalidPayload()
  return page.list as Location[]
}

export function classifyRequestFailure(error: unknown): RequestFailure {
  if (error instanceof LaneCRequestError) return error.failure
  if (error instanceof PayloadInvalidError) return { kind: 'payload-invalid' }

  if (isObject(error)) {
    const response = isObject(error.response) ? error.response : undefined
    const status = typeof response?.status === 'number' ? response.status : undefined
    if (status === 403) return { kind: 'forbidden', status }
    if (status === 404) return { kind: 'not-found', status }

    const networkCodes = new Set(['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'])
    const isAxiosTransport = response === undefined
      && error.isAxiosError === true
      && typeof error.code === 'string'
      && networkCodes.has(error.code)
    if (isAxiosTransport) return { kind: 'network' }

    if (status !== undefined) return { kind: 'unexpected', status }
  }

  return { kind: 'unexpected' }
}

export function asLaneCRequestError(error: unknown): LaneCRequestError {
  return error instanceof LaneCRequestError
    ? error
    : new LaneCRequestError(classifyRequestFailure(error), error)
}

export function requestFailureMessage(failure: RequestFailure, resource: string): string {
  switch (failure.kind) {
    case 'network': return `${resource}网络连接中断，请检查连接后重试`
    case 'forbidden': return `没有权限读取${resource}`
    case 'not-found': return `${resource}服务入口不可用`
    case 'payload-invalid': return `${resource}返回的数据格式异常`
    default: return `${resource}暂时无法读取，请稍后重试`
  }
}
