import { describe, expect, it } from 'vitest'
import {
  classifyRequestFailure,
  parseLaneCListPayload,
  parseLaneCStatsPayload,
  parseLocationsPayload,
  parseMaterialsPayload,
} from './requestTruth'

const validRecord = {
  id: 'record-1',
  materialId: 'material-1',
  quantity: 2,
  operator: 'tester',
  createdAt: '2026-07-19T08:00:00.000Z',
}

const validMaterial = {
  id: 'material-1',
  code: 'MAT-001',
  name: '苏木素染液',
  spec: '500ml',
  unit: '瓶',
  price: 10,
  stock: 5,
  minStock: 1,
  maxStock: 20,
  safetyStock: 2,
  categoryId: 'category-1',
  status: 'active',
  createdAt: '2026-07-19T08:00:00.000Z',
  updatedAt: '2026-07-19T08:00:00.000Z',
}

const validLocation = {
  id: 'location-1',
  code: 'LOC-001',
  name: 'A 区常温库',
  type: 'shelf',
  zone: 'A 区',
  capacity: 100,
  used: 10,
  status: 'active',
  createdAt: '2026-07-19T08:00:00.000Z',
}

const page = (list: unknown[]) => ({
  list,
  pagination: { page: 1, pageSize: 20, total: list.length, totalPages: list.length ? 1 : 0 },
})

function httpError(status: number) {
  return Object.assign(new Error(`internal http ${status} detail`), {
    response: { status },
  })
}

function networkError() {
  return Object.assign(new Error('internal network detail'), {
    name: 'AxiosError',
    code: 'ERR_NETWORK',
    isAxiosError: true,
  })
}

describe('Lane C request truth parsing', () => {
  it('keeps a valid all-zero stats payload as verified zero', () => {
    expect(parseLaneCStatsPayload({
      total: 0,
      monthCount: 0,
      monthQty: 0,
      materialKinds: 0,
      todayCount: 0,
    })).toEqual({
      total: 0,
      monthCount: 0,
      monthQty: 0,
      materialKinds: 0,
      todayCount: 0,
    })
  })

  it.each([
    undefined,
    null,
    {},
    { monthCount: 0, monthQty: 0, materialKinds: 0, todayCount: 0 },
    { total: 0, monthCount: '0', monthQty: 0, materialKinds: 0, todayCount: 0 },
    { total: 0, monthCount: 0, monthQty: -1, materialKinds: 0, todayCount: 0 },
    { total: 0, monthCount: 0, monthQty: Number.NaN, materialKinds: 0, todayCount: 0 },
  ])('rejects malformed stats instead of filling missing fields with zero: %j', payload => {
    expect(() => parseLaneCStatsPayload(payload)).toThrow()
  })

  it('keeps a valid empty list as verified empty', () => {
    expect(parseLaneCListPayload(page([]))).toEqual(page([]))
  })

  it('accepts a valid Lane C record and pagination payload', () => {
    expect(parseLaneCListPayload(page([validRecord]))).toEqual(page([validRecord]))
  })

  it.each([
    undefined,
    null,
    {},
    { list: null, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } },
    { list: [], pagination: undefined },
    { list: [], pagination: { page: 0, pageSize: 20, total: 0, totalPages: 0 } },
    { list: [], pagination: { page: 1, pageSize: 20, total: -1, totalPages: 0 } },
    page([{ ...validRecord, quantity: '2' }]),
    page([{ ...validRecord, operator: undefined }]),
  ])('rejects malformed list payloads instead of turning them into empty success: %j', payload => {
    expect(() => parseLaneCListPayload(payload)).toThrow()
  })

  it('keeps valid empty material and location references as verified empty', () => {
    expect(parseMaterialsPayload(page([]))).toEqual([])
    expect(parseLocationsPayload(page([]))).toEqual([])
  })

  it('accepts reference payloads containing the fields consumed by Lane C', () => {
    expect(parseMaterialsPayload(page([validMaterial]))).toEqual([validMaterial])
    expect(parseLocationsPayload(page([validLocation]))).toEqual([validLocation])
  })

  it.each([
    () => parseMaterialsPayload({ list: null }),
    () => parseMaterialsPayload(page([{ ...validMaterial, stock: '5' }])),
    () => parseLocationsPayload({ list: [] }),
    () => parseLocationsPayload(page([{ ...validLocation, name: undefined }])),
  ])('fails closed when a reference payload is malformed', parse => {
    expect(parse).toThrow()
  })
})

describe('Lane C request failure classification', () => {
  it('keeps 403 and 404 distinct', () => {
    expect(classifyRequestFailure(httpError(403))).toMatchObject({ kind: 'forbidden', status: 403 })
    expect(classifyRequestFailure(httpError(404))).toMatchObject({ kind: 'not-found', status: 404 })
  })

  it('classifies an allowlisted Axios transport failure as network', () => {
    expect(classifyRequestFailure(networkError())).toMatchObject({ kind: 'network' })
  })

  it('does not guess that an arbitrary Error is a network failure', () => {
    expect(classifyRequestFailure(new Error('internal detail'))).toMatchObject({ kind: 'unexpected' })
  })

  it('classifies parser rejection as payload-invalid', () => {
    let caught: unknown
    try {
      parseLaneCStatsPayload({ monthCount: 0 })
    } catch (error) {
      caught = error
    }
    expect(classifyRequestFailure(caught)).toMatchObject({ kind: 'payload-invalid' })
  })
})
