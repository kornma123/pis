import { describe, it, expect } from 'vitest'
import { cn, formatDate, formatDateTime, formatNumber, formatCurrency } from './utils'

describe('utils', () => {
  describe('cn', () => {
    it('should merge tailwind classes', () => {
      expect(cn('px-2', 'px-4')).toBe('px-4')
    })

    it.each([
      { condition: true, expected: 'base hidden' },
      { condition: false, expected: 'base' },
    ])('should handle conditional classes when condition is $condition', ({ condition, expected }) => {
      expect(cn('base', condition && 'hidden')).toBe(expected)
    })

    it('should handle empty input', () => {
      expect(cn()).toBe('')
    })

    it('should handle undefined values', () => {
      expect(cn('base', undefined, 'block')).toBe('base block')
    })

    it('should handle array input', () => {
      expect(cn(['px-2', 'py-4'])).toBe('px-2 py-4')
    })
  })

  describe('formatDate', () => {
    it('should format date string to zh-CN', () => {
      expect(formatDate('2024-01-15')).toBe('2024/01/15')
    })

    it('should return dash for empty input', () => {
      expect(formatDate('')).toBe('-')
    })

    it('should handle Date object input', () => {
      expect(formatDate(new Date('2024-06-01'))).toBe('2024/06/01')
    })

    it('should return dash for invalid date string', () => {
      expect(formatDate('not-a-date')).toBe('Invalid Date')
    })
  })

  describe('formatDateTime', () => {
    it('should format datetime to zh-CN', () => {
      const result = formatDateTime('2024-01-15T08:30:00')
      expect(result).toContain('2024/01/15')
      expect(result).toContain(':')
    })

    it('should return dash for empty input', () => {
      expect(formatDateTime('')).toBe('-')
    })

    it('should handle Date object input', () => {
      const result = formatDateTime(new Date('2024-06-01T14:30:00'))
      expect(result).toContain('2024/06/01')
    })
  })

  describe('formatNumber', () => {
    it('should format number with decimals', () => {
      expect(formatNumber(1234.5)).toBe('1,234.50')
    })

    it('should return dash for undefined', () => {
      expect(formatNumber(undefined)).toBe('-')
    })

    it('should handle negative numbers', () => {
      expect(formatNumber(-1234.5)).toBe('-1,234.50')
    })

    it('should handle zero', () => {
      expect(formatNumber(0)).toBe('0.00')
    })

    it('should handle decimals=0', () => {
      expect(formatNumber(1234.5, 0)).toBe('1,235')
    })

    it('should handle large numbers', () => {
      expect(formatNumber(1234567890.12)).toBe('1,234,567,890.12')
    })
  })

  describe('formatCurrency', () => {
    it('should format number as currency', () => {
      expect(formatCurrency(1234.5)).toBe('¥1,234.50')
    })

    it('should return dash for null', () => {
      expect(formatCurrency(null as any)).toBe('-')
    })

    it('should round to 2 decimal places', () => {
      expect(formatCurrency(1234.555)).toBe('¥1,234.56')
    })

    it('should handle zero', () => {
      expect(formatCurrency(0)).toBe('¥0.00')
    })
  })
})
