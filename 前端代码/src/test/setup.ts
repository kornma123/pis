import '@testing-library/jest-dom'

// matchMedia mock
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// localStorage / sessionStorage mock with automatic cleanup
const storageMock = () => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
}

Object.defineProperty(window, 'localStorage', {
  writable: true,
  value: storageMock(),
})

Object.defineProperty(window, 'sessionStorage', {
  writable: true,
  value: storageMock(),
})

// IntersectionObserver mock
class IntersectionObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: IntersectionObserverMock,
})

// Suppress known React / testing-library warnings in test output
const originalConsoleError = console.error
beforeAll(() => {
  console.error = (...args: any[]) => {
    const msg = args[0]?.toString?.() || ''
    if (
      msg.includes('Warning: ReactDOMTestUtils.act') ||
      msg.includes('Warning: An update to') ||
      msg.includes('not wrapped in act')
    ) {
      return
    }
    originalConsoleError.apply(console, args)
  }
})

afterAll(() => {
  console.error = originalConsoleError
})

// Clean up storage after each test
afterEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})
