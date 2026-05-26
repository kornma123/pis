import { useState, useEffect, useCallback } from 'react'

export function useUrlParams() {
  const getParams = useCallback(() => {
    return new URLSearchParams(window.location.search)
  }, [])

  const [params, setParams] = useState(getParams)

  useEffect(() => {
    const handlePopState = () => setParams(getParams())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [getParams])

  const get = useCallback(
    (key: string, defaultValue = '') => {
      return params.get(key) || defaultValue
    },
    [params]
  )

  const getNumber = useCallback(
    (key: string, defaultValue = 0) => {
      const val = params.get(key)
      const num = val ? Number(val) : defaultValue
      return Number.isNaN(num) ? defaultValue : num
    },
    [params]
  )

  const set = useCallback(
    (key: string, value: string | number | null) => {
      const newParams = new URLSearchParams(window.location.search)
      if (value === null || value === '' || value === undefined) {
        newParams.delete(key)
      } else {
        newParams.set(key, String(value))
      }
      window.history.replaceState(null, '', `?${newParams.toString()}`)
      setParams(newParams)
    },
    []
  )

  const setMultiple = useCallback(
    (entries: Record<string, string | number | null>) => {
      const newParams = new URLSearchParams(window.location.search)
      Object.entries(entries).forEach(([key, value]) => {
        if (value === null || value === '' || value === undefined) {
          newParams.delete(key)
        } else {
          newParams.set(key, String(value))
        }
      })
      window.history.replaceState(null, '', `?${newParams.toString()}`)
      setParams(newParams)
    },
    []
  )

  const remove = useCallback(
    (key: string) => {
      const newParams = new URLSearchParams(window.location.search)
      newParams.delete(key)
      window.history.replaceState(null, '', `?${newParams.toString()}`)
      setParams(newParams)
    },
    []
  )

  const clear = useCallback(() => {
    window.history.replaceState(null, '', window.location.pathname)
    setParams(new URLSearchParams())
  }, [])

  return { params, get, getNumber, set, setMultiple, remove, clear }
}
