type TextGuardOptions = {
  required?: boolean
  maxLength?: number
}

type TextGuardSuccess = {
  ok: true
  value: string | null
}

type TextGuardFailure = {
  ok: false
  message: string
  code: string
  status: number
}

export type TextGuardResult = TextGuardSuccess | TextGuardFailure

const htmlTagPattern = /<\s*\/?\s*[a-z][^>]*>/i
const sqlTautologyPattern = /(^|[\s'"`])(?:or|and)\s+['"`]?[a-z0-9_]+['"`]?\s*=\s*['"`]?[a-z0-9_]+['"`]?/i
const controlCharPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

export function normalizeDisplayText(
  value: unknown,
  label: string,
  options: TextGuardOptions = {},
): TextGuardResult {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : ''
  const maxLength = options.maxLength || 120

  if (!normalized) {
    if (options.required) {
      return { ok: false, message: `${label}不能为空`, code: 'INVALID_PARAMETER', status: 400 }
    }
    return { ok: true, value: null }
  }

  if (normalized.length > maxLength) {
    return { ok: false, message: `${label}不能超过${maxLength}个字符`, code: 'INVALID_PARAMETER', status: 400 }
  }

  if (controlCharPattern.test(normalized) || htmlTagPattern.test(normalized) || sqlTautologyPattern.test(normalized)) {
    return { ok: false, message: `${label}包含危险字符，不能保存`, code: 'INVALID_TEXT', status: 400 }
  }

  return { ok: true, value: normalized }
}

export function requireValidText(value: unknown, label: string, maxLength?: number): TextGuardResult {
  return normalizeDisplayText(value, label, { required: true, maxLength })
}
