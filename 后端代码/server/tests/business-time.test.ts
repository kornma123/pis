import { describe, expect, it } from 'vitest'
import { shanghaiBusinessMonth } from '../src/utils/business-time.js'

describe('Asia/Shanghai business month', () => {
  it.each([
    ['上海月界前最后一分钟', '2026-08-31T15:59:00.000Z', '2026-08'],
    ['上海月界后第一分钟', '2026-08-31T16:00:00.000Z', '2026-09'],
    ['上海月界后半小时（UTC 仍在上月）', '2026-08-31T16:30:00.000Z', '2026-09'],
    ['上海年界前最后一分钟', '2026-12-31T15:59:00.000Z', '2026-12'],
    ['上海年界后第一分钟', '2026-12-31T16:00:00.000Z', '2027-01'],
    ['普通日对照', '2026-08-15T12:00:00.000Z', '2026-08'],
  ])('%s：%s → %s', (_label, instant, expected) => {
    expect(shanghaiBusinessMonth(new Date(instant))).toBe(expected)
  })

  it('非法时钟输入 fail-closed，不生成可写月份', () => {
    expect(() => shanghaiBusinessMonth(new Date(Number.NaN))).toThrow(
      'invalid date for Shanghai business month',
    )
  })
})
