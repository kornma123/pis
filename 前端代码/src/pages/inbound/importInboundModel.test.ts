import { describe, expect, it, vi } from 'vitest'
import {
  executeInboundImport,
  parseInboundCsv,
  summarizeInboundImport,
  validateInboundImportRows,
} from './importInboundModel'
import type { Location, Material, Supplier } from '@/types'

const materials: Material[] = [{
  id: 'mat-1', code: 'M001', name: '试剂 A', spec: '', unit: '盒', price: 0,
  stock: 0, minStock: 0, maxStock: 0, safetyStock: 0, categoryId: 'cat-1',
  status: 'active', createdAt: '', updatedAt: '',
}]
const locations: Location[] = [{
  id: 'loc-1', code: 'L001', name: '冷藏一号', type: 'fridge', zone: 'A',
  capacity: 100, used: 0, status: 'active', createdAt: '',
}]
const suppliers: Supplier[] = [{
  id: 'sup-1', code: 'S001', name: '供应商 A', status: 'active', cooperationCount: 0,
  totalAmount: 0, rating: 0, createdAt: '', updatedAt: '',
}]

const headers = ['物料编码', '入库数量', '库位编码', '批号', '单价', '供应商编码', '生产日期', '有效期至', '备注']

describe('importInboundModel', () => {
  it('parses UTF-8 CSV with a BOM, quoted commas, and embedded line breaks locally', () => {
    const parsed = parseInboundCsv(`\uFEFF${headers.join(',')}\r\nM001,2,L001,B-1,0,,,2027-01-01,"首批,需复核\n第二行"`)

    expect(parsed.fileError).toBeNull()
    expect(parsed.headers).toEqual(headers)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0][8]).toBe('首批,需复核\n第二行')
  })

  it('validates the real direct-inbound object and preserves an explicit zero price', () => {
    const result = validateInboundImportRows(headers, [
      ['ｍ００１', '2', 'ｌ００１', 'B-001', '0', 'ｓ００１', '2026-07-01', '2027-07-01', '首批'],
    ], { materials, locations, suppliers }, () => 'idem-row-1')

    expect(result.fileError).toBeNull()
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      status: 'ready',
      idempotencyKey: 'idem-row-1',
      payload: {
        type: 'direct', materialId: 'mat-1', locationId: 'loc-1', supplierId: 'sup-1',
        quantity: 2, price: 0, batchNo: 'B-001',
      },
    })
  })

  it('does not silently default unknown material, location, blank price, or invalid dates', () => {
    const result = validateInboundImportRows(headers, [
      ['UNKNOWN', '2', 'MISSING', '', '', '', '2026-02-31', '', ''],
    ], { materials, locations, suppliers }, () => 'idem-row-1')

    expect(result.rows[0].status).toBe('validation_error')
    expect(result.rows[0].issues).toEqual(expect.arrayContaining([
      '物料编码未匹配到启用物料',
      '库位编码未匹配到启用库位',
      '单价为空；0 只允许由文件明确填写',
      '生产日期不是有效的 YYYY-MM-DD 日期',
    ]))
  })

  it('reports a partial result honestly and retries only failed rows with the same idempotency key', async () => {
    const validated = validateInboundImportRows(headers, [
      ['M001', '1', 'L001', 'B-1', '1', '', '', '', ''],
      ['M001', '1', 'L001', 'B-2', '1', '', '', '', ''],
    ], { materials, locations, suppliers }, (() => {
      let n = 0
      return () => `idem-${++n}`
    })())
    const create = vi.fn()
      .mockResolvedValueOnce({ inboundNo: 'IB-1' })
      .mockRejectedValueOnce(Object.assign(new Error('network down'), { code: 'ERR_NETWORK' }))

    const firstRun = await executeInboundImport(validated.rows, create)
    expect(summarizeInboundImport(firstRun)).toEqual({ total: 2, succeeded: 1, failed: 1, validationRejected: 0, pending: 0 })
    expect(firstRun[1]).toMatchObject({ status: 'failed', idempotencyKey: 'idem-2' })

    create.mockResolvedValueOnce({ inboundNo: 'IB-2' })
    const retry = await executeInboundImport(firstRun, create, { retryFailedOnly: true })

    expect(create).toHaveBeenCalledTimes(3)
    expect(create.mock.calls[2][1]).toBe('idem-2')
    expect(summarizeInboundImport(retry)).toEqual({ total: 2, succeeded: 2, failed: 0, validationRejected: 0, pending: 0 })

    await executeInboundImport(retry, create)
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('keeps validation rejects separate from runnable and service-failed rows', async () => {
    const validated = validateInboundImportRows(headers, [
      ['M001', '1', 'L001', 'B-1', '1', '', '', '', ''],
      ['UNKNOWN', '1', 'L001', 'B-2', '1', '', '', '', ''],
      ['M001', '1', 'L001', 'B-3', '1', '', '', '', ''],
    ], { materials, locations, suppliers }, (() => {
      let n = 0
      return () => `idem-mixed-${++n}`
    })())

    expect(summarizeInboundImport(validated.rows)).toEqual({
      total: 3,
      succeeded: 0,
      failed: 0,
      validationRejected: 1,
      pending: 2,
    })

    const submitted = await executeInboundImport(
      validated.rows,
      vi.fn().mockResolvedValueOnce({ inboundNo: 'IB-1' }).mockRejectedValueOnce(new Error('服务不可用')),
    )
    expect(summarizeInboundImport(submitted)).toEqual({
      total: 3,
      succeeded: 1,
      failed: 1,
      validationRejected: 1,
      pending: 0,
    })
  })
})
