import { describe, it, expect } from 'vitest'
import { decodeBase64Url, getUserRole, ROLE_MENU_MAP } from './permissions'

describe('permissions', () => {
  describe('decodeBase64Url', () => {
    it('should decode standard base64url', () => {
      const encoded = btoa('{"role":"admin"}').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
      expect(decodeBase64Url(encoded)).toBe('{"role":"admin"}')
    })

    it('should handle base64url with - and _ characters', () => {
      const encoded = 'eyJyb2xlIjoiYWRtaW4ifQ'
      expect(decodeBase64Url(encoded)).toBe('{"role":"admin"}')
    })

    it('should add padding when needed', () => {
      const encoded = 'eyJyb2xlIjoiYWRtaW4ifQ'
      expect(() => decodeBase64Url(encoded)).not.toThrow()
    })

    it('should decode payload with unicode escapes', () => {
      const original = '{"name":"\\u6d4b\\u8bd5"}'
      const encoded = btoa(original)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
      expect(decodeBase64Url(encoded)).toBe(original)
    })
  })

  describe('getUserRole', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    it('should read role from localStorage user object', () => {
      localStorage.setItem('user', JSON.stringify({ role: 'admin', username: 'test' }))
      expect(getUserRole()).toBe('admin')
    })

    it('should read role from JWT token payload', () => {
      const payload = btoa('{"role":"warehouse_manager"}')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
      localStorage.setItem('token', `header.${payload}.signature`)
      expect(getUserRole()).toBe('warehouse_manager')
    })

    it('should prefer localStorage user over JWT token', () => {
      localStorage.setItem('user', JSON.stringify({ role: 'admin' }))
      const payload = btoa('{"role":"technician"}')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
      localStorage.setItem('token', `header.${payload}.signature`)
      expect(getUserRole()).toBe('admin')
    })

    it('should return null when no token or user', () => {
      expect(getUserRole()).toBeNull()
    })

    it('should return null for invalid JSON in localStorage', () => {
      localStorage.setItem('user', 'not-json')
      expect(getUserRole()).toBeNull()
    })

    it('should return null for malformed JWT', () => {
      localStorage.setItem('token', 'not.a.valid.jwt')
      expect(getUserRole()).toBeNull()
    })

    it('should return null for JWT without role claim', () => {
      const payload = btoa('{"sub":"123"}')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
      localStorage.setItem('token', `header.${payload}.signature`)
      expect(getUserRole()).toBeNull()
    })
  })

  describe('ROLE_MENU_MAP', () => {
    it('should have routes for all defined roles', () => {
      const roles = ['admin', 'warehouse_manager', 'technician', 'procurement', 'finance', 'pathologist']
      roles.forEach(role => {
        expect(ROLE_MENU_MAP[role]).toBeDefined()
        expect(ROLE_MENU_MAP[role].length).toBeGreaterThan(0)
      })
    })

    it('should have no duplicate routes within a role', () => {
      Object.entries(ROLE_MENU_MAP).forEach(([, routes]) => {
        const unique = new Set(routes)
        expect(unique.size).toBe(routes.length)
      })
    })

    it('should include all other roles routes in admin', () => {
      const adminRoutes = new Set(ROLE_MENU_MAP.admin)
      Object.entries(ROLE_MENU_MAP).forEach(([role, routes]) => {
        if (role === 'admin') return
        routes.forEach(route => {
          expect(adminRoutes.has(route)).toBe(true)
        })
      })
    })

    it('should have root route for every role', () => {
      Object.values(ROLE_MENU_MAP).forEach(routes => {
        expect(routes).toContain('/')
      })
    })
  })
})
