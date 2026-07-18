import { describe, expect, it } from 'vitest'
import { normalizeDisplayText, requireValidText } from '../src/utils/text-guard.js'

describe('text guard', () => {
  it('保留合法中文并把允许的空白控制符折叠为普通空格', () => {
    expect(normalizeDisplayText('  设备\t型号\nA\r\u000B\u000C  ', '设备名称')).toEqual({
      ok: true,
      value: '设备 型号 A',
    })
  })

  it.each([
    ['U+0000', '\u0000'],
    ['U+0008', '\u0008'],
    ['U+000E', '\u000E'],
    ['U+001F', '\u001F'],
    ['U+007F', '\u007F'],
  ])(
    '拒绝不可见控制字符 %s',
    (_codePoint, controlChar) => {
      expect(requireValidText(`安全${controlChar}文本`, '设备名称')).toEqual({
        ok: false,
        message: '设备名称包含危险字符，不能保存',
        code: 'INVALID_TEXT',
        status: 400,
      })
    },
  )

  it.each(['<script>alert(1)</script>', "name' OR 'x'='x"])(
    '继续拒绝既有危险文本：%s',
    (value) => {
      expect(requireValidText(value, '设备名称')).toMatchObject({ ok: false, code: 'INVALID_TEXT' })
    },
  )
})
