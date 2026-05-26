import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUrlParams } from './useUrlParams'

describe('useUrlParams', () => {
  let replaceStateSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Reset URL to clean state
    window.history.replaceState(null, '', '/')
    replaceStateSpy = vi.spyOn(window.history, 'replaceState')
  })

  afterEach(() => {
    replaceStateSpy.mockRestore()
  })

  it('should read existing param with get', () => {
    window.history.replaceState(null, '', '?page=2&keyword=test')
    const { result } = renderHook(() => useUrlParams())

    expect(result.current.get('page')).toBe('2')
    expect(result.current.get('keyword')).toBe('test')
  })

  it('should return defaultValue for missing param', () => {
    const { result } = renderHook(() => useUrlParams())

    expect(result.current.get('missing')).toBe('')
    expect(result.current.get('missing', 'default')).toBe('default')
  })

  it('should read number with getNumber', () => {
    window.history.replaceState(null, '', '?page=5')
    const { result } = renderHook(() => useUrlParams())

    expect(result.current.getNumber('page')).toBe(5)
  })

  it('should return defaultValue for missing number param', () => {
    const { result } = renderHook(() => useUrlParams())

    expect(result.current.getNumber('missing')).toBe(0)
    expect(result.current.getNumber('missing', 10)).toBe(10)
  })

  it('should return defaultValue for non-numeric param', () => {
    window.history.replaceState(null, '', '?page=abc')
    const { result } = renderHook(() => useUrlParams())

    expect(result.current.getNumber('page')).toBe(0)
    expect(result.current.getNumber('page', 1)).toBe(1)
  })

  it('should set param and update URL', () => {
    const { result } = renderHook(() => useUrlParams())

    act(() => {
      result.current.set('page', '3')
    })

    expect(replaceStateSpy).toHaveBeenCalled()
    expect(result.current.get('page')).toBe('3')
  })

  it('should delete param when setting null', () => {
    window.history.replaceState(null, '', '?page=3&keyword=test')
    const { result } = renderHook(() => useUrlParams())

    act(() => {
      result.current.set('page', null)
    })

    expect(result.current.get('page')).toBe('')
    expect(result.current.get('keyword')).toBe('test')
  })

  it('should delete param when setting empty string', () => {
    window.history.replaceState(null, '', '?page=3')
    const { result } = renderHook(() => useUrlParams())

    act(() => {
      result.current.set('page', '')
    })

    expect(result.current.get('page')).toBe('')
  })

  it('should delete param when setting undefined', () => {
    window.history.replaceState(null, '', '?page=3')
    const { result } = renderHook(() => useUrlParams())

    act(() => {
      result.current.set('page', undefined)
    })

    expect(result.current.get('page')).toBe('')
  })

  it('should set multiple params at once', () => {
    const { result } = renderHook(() => useUrlParams())

    act(() => {
      result.current.setMultiple({ page: '2', size: '50' })
    })

    expect(result.current.get('page')).toBe('2')
    expect(result.current.get('size')).toBe('50')
  })

  it('should remove a param', () => {
    window.history.replaceState(null, '', '?page=2&keyword=test')
    const { result } = renderHook(() => useUrlParams())

    act(() => {
      result.current.remove('page')
    })

    expect(result.current.get('page')).toBe('')
    expect(result.current.get('keyword')).toBe('test')
  })

  it('should clear all params', () => {
    window.history.replaceState(null, '', '?page=2&keyword=test')
    const { result } = renderHook(() => useUrlParams())

    act(() => {
      result.current.clear()
    })

    expect(result.current.get('page')).toBe('')
    expect(result.current.get('keyword')).toBe('')
  })

  it('should sync params on popstate event', () => {
    window.history.replaceState(null, '', '?page=2')
    const { result } = renderHook(() => useUrlParams())

    expect(result.current.get('page')).toBe('2')

    // Simulate browser back button changing URL
    window.history.replaceState(null, '', '?page=5')
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    expect(result.current.get('page')).toBe('5')
  })
})
