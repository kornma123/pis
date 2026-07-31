/**
 * LOC-015 runtime input contract matrix（Issue #15 最小交付合同 1/2/5）：
 *
 * 只接受类型正确、有限、安全、非负且精度合法的数值；合法显式 0 保持 0；
 * missing / null / blank / text / container / NaN / Infinity / unsafe number
 * 一律返回具名 typed unavailable，绝不折零。
 *
 * RED 姿势：本文件 import 的 `../src/utils/evidence-fact.js` 在 base 666ce6d 上尚不存在，
 * 编译期即失败（RED）；实现后全量断言转 GREEN。
 */
import { describe, expect, it } from 'vitest'
import {
  EvidenceUnavailableError,
  readEvidenceAmount,
  readEvidenceCount,
  readEvidenceNumber,
} from '../src/utils/evidence-fact.js'

describe('LOC-015 evidence-fact 运行时输入合同', () => {
  it('readEvidenceNumber 行为矩阵：missing/null/blank/text/container/NaN/Infinity/unsafe/合法0/合法正数', () => {
    const matrix: Array<[string, unknown, { status: 'ok' } | { status: 'unavailable'; reason: string }]> = [
      ['missing undefined', undefined, { status: 'unavailable', reason: 'missing' }],
      ['missing null', null, { status: 'unavailable', reason: 'missing' }],
      ['blank empty string', '', { status: 'unavailable', reason: 'blank' }],
      ['blank whitespace-only', '   ', { status: 'unavailable', reason: 'blank' }],
      ['text numeric-looking', '12.5', { status: 'unavailable', reason: 'malformed' }],
      ['text junk', 'abc', { status: 'unavailable', reason: 'malformed' }],
      ['container plain object', {}, { status: 'unavailable', reason: 'malformed' }],
      ['container array', [1], { status: 'unavailable', reason: 'malformed' }],
      ['boolean', true, { status: 'unavailable', reason: 'malformed' }],
      ['NaN', Number.NaN, { status: 'unavailable', reason: 'non_finite' }],
      ['Infinity', Number.POSITIVE_INFINITY, { status: 'unavailable', reason: 'non_finite' }],
      ['-Infinity', Number.NEGATIVE_INFINITY, { status: 'unavailable', reason: 'non_finite' }],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 1, { status: 'unavailable', reason: 'unsafe' }],
      ['legal explicit zero', 0, { status: 'ok' }],
      ['legal positive integer', 3, { status: 'ok' }],
      ['legal decimal', 13.25, { status: 'ok' }],
    ]
    for (const [label, input, expected] of matrix) {
      const actual = readEvidenceNumber(input)
      if (expected.status === 'unavailable') {
        expect(actual, label).toEqual(expected)
      } else {
        expect(actual, label).toEqual({ status: 'ok', value: input as number })
      }
    }
  })

  it('readEvidenceCount：只接受有限、安全、非负整数；合法 0 保真', () => {
    expect(readEvidenceCount(0)).toEqual({ status: 'ok', value: 0 })
    expect(readEvidenceCount(12)).toEqual({ status: 'ok', value: 12 })
    expect(readEvidenceCount(-1)).toEqual({ status: 'unavailable', reason: 'out_of_range' })
    expect(readEvidenceCount(1.5)).toEqual({ status: 'unavailable', reason: 'unsafe' })
    expect(readEvidenceCount(Number.MAX_SAFE_INTEGER)).toEqual({ status: 'ok', value: Number.MAX_SAFE_INTEGER })
    expect(readEvidenceCount(Number.MAX_SAFE_INTEGER + 1)).toEqual({ status: 'unavailable', reason: 'unsafe' })
  })

  it('readEvidenceAmount：只接受有限、安全、非负且精度合法的金额；超精度拒绝', () => {
    expect(readEvidenceAmount(0)).toEqual({ status: 'ok', value: 0 })
    expect(readEvidenceAmount(13.25)).toEqual({ status: 'ok', value: 13.25 })
    expect(readEvidenceAmount(-0.01)).toEqual({ status: 'unavailable', reason: 'out_of_range' })
    expect(readEvidenceAmount(1.23456)).toEqual({ status: 'unavailable', reason: 'precision' })
    expect(readEvidenceAmount(1e15)).toEqual({ status: 'unavailable', reason: 'unsafe' })
    expect(readEvidenceAmount(13.25, { scale: 4 })).toEqual({ status: 'ok', value: 13.25 })
  })

  it('EvidenceUnavailableError：具名 code/status/issues，可被路由识别为不可用而非 0', () => {
    const err = new EvidenceUnavailableError([
      { caseNo: 'C-1', field: 'ihc_count', reason: 'malformed' },
      { field: 'net_amount', reason: 'missing' },
    ])
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('EVIDENCE_UNAVAILABLE')
    expect(err.status).toBe(422)
    expect(err.issues).toHaveLength(2)
    expect(err.issues[0]).toEqual({ caseNo: 'C-1', field: 'ihc_count', reason: 'malformed' })
    expect(err.message).toContain('数据不可用')
  })
})
