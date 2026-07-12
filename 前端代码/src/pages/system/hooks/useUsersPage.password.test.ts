import { describe, expect, it } from 'vitest'
import { generateStrongInitialPassword } from './useUsersPage'

const SEQUENCES = [
  '0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
  'qwertyuiop', 'poiuytrewq', 'asdfghjkl', 'lkjhgfdsa',
]
const COMMON_WEAK_FRAGMENTS = ['password', 'qwerty', 'letmein', 'welcome', 'changeme', 'admin']

describe('generateStrongInitialPassword', () => {
  it('generates bounded, diverse values without four-character weak sequences', () => {
    const generated = Array.from({ length: 100 }, () => generateStrongInitialPassword())

    for (const password of generated) {
      expect(password).toHaveLength(20)
      expect(new TextEncoder().encode(password).byteLength).toBeLessThanOrEqual(72)
      expect(new Set(password).size).toBe(20)
      expect(new Set(password.toLowerCase()).size).toBe(20)
      expect(password).not.toBe('admin123')
      expect(password).not.toBe('CoreOne2026!')
      const normalized = password.toLowerCase()
      const canonicalWords = normalized
        .replace(/[@4]/gu, 'a')
        .replace(/0/gu, 'o')
        .replace(/[1!|]/gu, 'i')
        .replace(/3/gu, 'e')
        .replace(/[$5]/gu, 's')
        .replace(/7/gu, 't')
        .replace(/[^a-z0-9]/gu, '')
      for (const fragment of COMMON_WEAK_FRAGMENTS) expect(canonicalWords).not.toContain(fragment)
      for (const sequence of SEQUENCES) {
        for (let index = 0; index <= sequence.length - 4; index += 1) {
          expect(normalized).not.toContain(sequence.slice(index, index + 4))
        }
      }
    }
  })
})
