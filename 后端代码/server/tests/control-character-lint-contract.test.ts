import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { registerCoreoneSqlFunctions } from '../src/database/DatabaseManager.js'
import { normalizeDisplayText, requireValidText } from '../src/utils/text-guard.js'

describe('control-character contracts remain lint-safe', () => {
  const database = new DatabaseSync(':memory:')
  registerCoreoneSqlFunctions(database)

  afterAll(() => database.close())

  it('preserves canonical actor acceptance while rejecting C0, DEL, and C1 controls', () => {
    const actorValidity = (actor: string) => (
      database.prepare('SELECT coreone_canonical_actor(?) AS valid').get(actor) as { valid: number }
    ).valid

    expect(actorValidity('张医生')).toBe(1)
    expect(actorValidity('USER-001')).toBe(1)

    for (const actor of [
      '',
      '   ',
      '\t\t',
      String.fromCodePoint(0x00A0),
      `USER${String.fromCodePoint(0x0001)}`,
      `USER${String.fromCodePoint(0x001F)}`,
      `USER${String.fromCodePoint(0x007F)}`,
      `USER${String.fromCodePoint(0x0080)}`,
      `USER${String.fromCodePoint(0x009F)}`,
    ]) {
      expect(actorValidity(actor)).toBe(0)
    }
  })

  it('preserves display text normalization and rejects forbidden invisible controls', () => {
    expect(normalizeDisplayText('  设备\t型号\nA\r\u000B\u000C  ', '设备名称')).toEqual({
      ok: true,
      value: '设备 型号 A',
    })

    for (const controlChar of ['\u0000', '\u0008', '\u000E', '\u001F', '\u007F']) {
      expect(requireValidText(`安全${controlChar}文本`, '设备名称')).toEqual({
        ok: false,
        message: '设备名称包含危险字符，不能保存',
        code: 'INVALID_TEXT',
        status: 400,
      })
    }
  })

  it.each(['<script>alert(1)</script>', "name' OR 'x'='x"])(
    'continues to reject existing dangerous text: %s',
    (value) => {
      expect(requireValidText(value, '设备名称')).toMatchObject({ ok: false, code: 'INVALID_TEXT' })
    },
  )
})
