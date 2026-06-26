import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Search, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SearchableSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  inputClassName?: string
  dropdownClassName?: string
  testId?: string
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  className,
  inputClassName,
  dropdownClassName,
  testId,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedLabel = useMemo(() => {
    const found = options.find(o => o.value === value)
    return found?.label || ''
  }, [options, value])

  const filtered = useMemo(() => {
    if (!query.trim()) return options
    const q = query.toLowerCase()
    return options.filter(o => o.label.toLowerCase().includes(q))
  }, [options, query])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [filtered.length])

  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlightedIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }
  }, [open])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex(i => (i + 1) % filtered.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex(i => (i - 1 + filtered.length) % filtered.length)
        break
      case 'Enter':
        e.preventDefault()
        if (filtered[highlightedIndex] && !filtered[highlightedIndex].disabled) {
          onChange(filtered[highlightedIndex].value)
          setOpen(false)
          setQuery('')
        }
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        setQuery('')
        break
    }
  }, [open, filtered, highlightedIndex, onChange])

  const handleSelect = (opt: SelectOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    setOpen(false)
    setQuery('')
  }

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    onChange('')
    setQuery('')
  }

  return (
    <div ref={containerRef} data-testid={testId} className={cn('relative', className)}>
      <div
        className={cn(
          'flex items-center w-full h-10 px-3 border rounded-md bg-white transition-all cursor-text max-w-full',
          open
            ? 'border-blue-500 ring-[3px] ring-blue-500/10'
            : 'border-gray-300 hover:border-gray-400',
          disabled && 'bg-gray-50 cursor-not-allowed opacity-60',
          inputClassName
        )}
        onClick={() => {
          if (!disabled) {
            setOpen(true)
            inputRef.current?.focus()
          }
        }}
      >
        <Search className="w-4 h-4 text-gray-400 flex-shrink-0 mr-2" />
        {open ? (
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={selectedLabel || placeholder}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400 min-w-0"
            disabled={disabled}
          />
        ) : (
          <span className={cn(
            'flex-1 text-sm truncate min-w-0',
            selectedLabel ? 'text-gray-900' : 'text-gray-400'
          )}>
            {selectedLabel || placeholder}
          </span>
        )}
        {value && !open && !disabled && (
          <button
            onClick={handleClear}
            className="p-0.5 hover:bg-gray-100 rounded-full mr-1 flex-shrink-0"
            tabIndex={-1}
          >
            <X className="w-3.5 h-3.5 text-gray-400" />
          </button>
        )}
        <ChevronDown className={cn(
          'w-4 h-4 text-gray-400 flex-shrink-0 transition-transform',
          open && 'rotate-180'
        )} />
      </div>

      {open && (
        <div className={cn(
          'absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-md overflow-hidden',
          dropdownClassName
        )}>
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-gray-400 text-center">
              无匹配结果
            </div>
          ) : (
            <ul className="max-h-60 overflow-y-auto py-1">
              {filtered.map((opt, idx) => (
                <li
                  key={`${opt.value}-${idx}`}
                  data-testid={`option-${opt.value}`}
                  onClick={() => handleSelect(opt)}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  className={cn(
                    'px-3 py-2 text-sm cursor-pointer truncate transition-colors',
                    opt.value === value
                      ? 'bg-blue-50 text-blue-700 font-medium'
                      : idx === highlightedIndex
                        ? 'bg-gray-50 text-gray-900'
                        : 'text-gray-700 hover:bg-gray-50',
                    opt.disabled && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {opt.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
