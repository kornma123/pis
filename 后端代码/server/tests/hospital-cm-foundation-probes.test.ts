import { describe, expect, it } from 'vitest'
import {
  combinedFoundationFingerprint,
  inspectHospitalCmFoundation,
} from '../src/utils/hospital-cm-foundation-probes.js'

describe('hospital-cm foundation probes · fail-closed', () => {
  it('源表缺失时不抛 500，而是把依赖数据库的门标为 error', () => {
    const missingDb = {
      prepare() {
        throw new Error('no such table')
      },
    }
    const checks = inspectHospitalCmFoundation(missingDb)
    expect(checks.find((check) => check.key === 'inventory_conservation')).toMatchObject({
      met: false,
      status: 'error',
      resultCode: 'SOURCE_TABLE_MISSING',
    })
    expect(checks.find((check) => check.key === 'period_key')).toMatchObject({
      met: false,
      status: 'error',
      resultCode: 'SOURCE_TABLE_MISSING',
    })
    expect(checks.find((check) => check.key === 'constant_freeze')).toMatchObject({
      met: false,
      status: 'error',
      resultCode: 'SOURCE_TABLE_MISSING',
    })
  })

  it('组合输入指纹与检查返回顺序无关', () => {
    const missingDb = { prepare() { throw new Error('no such table') } }
    const checks = inspectHospitalCmFoundation(missingDb)
    expect(combinedFoundationFingerprint(checks)).toBe(combinedFoundationFingerprint([...checks].reverse()))
  })
})
