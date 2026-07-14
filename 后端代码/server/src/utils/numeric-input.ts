/**
 * Parse an external numeric value without JavaScript's broad coercions.
 *
 * Accepted:
 * - finite numbers
 * - non-empty strings that Number() parses completely to a finite number
 *
 * Rejected:
 * - empty/whitespace-only strings
 * - booleans, arrays, objects and null/undefined
 * - NaN and +/-Infinity (including JSON 1e400 and their string forms)
 */
export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim() === '') return null

  const parsed = Number(typeof value === 'string' ? value.trim() : value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseFinitePositiveNumber(value: unknown): number | null {
  const parsed = parseFiniteNumber(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

export function parseFiniteNonNegativeNumber(value: unknown): number | null {
  const parsed = parseFiniteNumber(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

export function checkedAdd(left: number, right: number): number | null {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  const result = left + right
  return Number.isFinite(result) ? result : null
}

export function checkedSubtract(left: number, right: number): number | null {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  const result = left - right
  return Number.isFinite(result) ? result : null
}

export function checkedMultiply(left: number, right: number): number | null {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  const result = left * right
  return Number.isFinite(result) ? result : null
}
