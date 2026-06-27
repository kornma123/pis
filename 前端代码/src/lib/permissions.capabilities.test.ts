/**
 * RBAC P4 前端：能力驱动 helper（canAccess / getAccessiblePaths / canSeeCost / getRoles）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { canAccess, canSeeCost, getRoles, getAccessiblePaths } from './permissions'

function setUser(u: any) {
  localStorage.setItem('user', JSON.stringify(u))
}

beforeEach(() => {
  localStorage.clear()
})

describe('canAccess（能力并集）', () => {
  it('按 capabilities 判定 R/W（W 蕴含 R）', () => {
    setUser({ role: 'finance', capabilities: { inventory: 'R', abc_dashboard: 'W' }, roles: ['finance'] })
    expect(canAccess('inventory', 'R')).toBe(true)
    expect(canAccess('inventory', 'W')).toBe(false)
    expect(canAccess('abc_dashboard', 'W')).toBe(true)
    expect(canAccess('outbound', 'R')).toBe(false)
  })
  it('capabilities 缺失 → 放行（退回旧逻辑兜底）', () => {
    setUser({ role: 'finance' })
    expect(canAccess('whatever', 'R')).toBe(true)
  })
})

describe('getAccessiblePaths（能力驱动 nav）', () => {
  it('财务能力 → 含 cost-analysis/abc 不含 outbound', () => {
    setUser({
      role: 'finance',
      roles: ['finance'],
      capabilities: { inventory: 'R', cost_analysis: 'W', abc_dashboard: 'W', reconciliation: 'W' },
    })
    const paths = getAccessiblePaths()
    expect(paths).toContain('/')
    expect(paths).toContain('/inventory')
    expect(paths).toContain('/cost-analysis')
    expect(paths).toContain('/abc/dashboard')
    expect(paths).not.toContain('/outbound')
    expect(paths).not.toContain('/users')
  })
  it('病理能力 → 无任何成本/abc 路径', () => {
    setUser({ role: 'pathologist', roles: ['pathologist'], capabilities: { inventory: 'R', bom: 'R', projects: 'W', alerts: 'R' } })
    const paths = getAccessiblePaths()
    expect(paths).toContain('/projects')
    expect(paths).not.toContain('/cost-analysis')
    expect(paths).not.toContain('/abc/dashboard')
    expect(paths).not.toContain('/abc/slide-cost')
  })
  it('capabilities 缺失 → 退回 ROLE_MENU_MAP[role]', () => {
    setUser({ role: 'warehouse_manager' })
    const paths = getAccessiblePaths()
    expect(paths).toContain('/inventory')
    expect(paths).toContain('/inbound')
  })
})

describe('canSeeCost / getRoles', () => {
  it('canSeeCost 读 user.canSeeCost', () => {
    setUser({ role: 'finance', canSeeCost: true })
    expect(canSeeCost()).toBe(true)
    setUser({ role: 'pathologist', canSeeCost: false })
    expect(canSeeCost()).toBe(false)
  })
  it('getRoles 取 roles[]，回退单 role', () => {
    setUser({ role: 'finance', roles: ['finance', 'warehouse_manager'] })
    expect(getRoles()).toEqual(['finance', 'warehouse_manager'])
    setUser({ role: 'technician' })
    expect(getRoles()).toEqual(['technician'])
  })
})
