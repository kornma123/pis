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
  it('capabilities 缺失 → R 放行（判据不明时不硬挡页面，可达性另由 getAccessiblePaths 裁决）', () => {
    setUser({ role: 'finance' })
    expect(canAccess('whatever', 'R')).toBe(true)
  })
  // 陈旧会话（capabilities 上线前铸造的 localStorage.user）曾使写门 fail-open，
  // 露出点了必吃 403 的按钮——PR #202 收敛为 fail-closed（PM #135：写按钮必须跟随 capability）。
  it('capabilities 缺失 → W 拒绝（fail-closed，不露出必吃 403 的按钮）', () => {
    setUser({ role: 'lab_director' })
    expect(canAccess('labor_times', 'W')).toBe(false)
    expect(canAccess('whatever', 'W')).toBe(false)
  })
  // 零权限用户：后端 getEffectivePermissions 返回 {}，非 null → 不走 caps 缺失分支。
  it('capabilities 为空对象 → R/W 均拒绝（{} 是真值，走模块缺失分支）', () => {
    setUser({ role: 'pathologist', capabilities: {} })
    expect(canAccess('labor_times', 'R')).toBe(false)
    expect(canAccess('labor_times', 'W')).toBe(false)
  })
})

describe('getAccessiblePaths（能力驱动 nav）', () => {
  it('财务能力 → 保留材料成本入口，但不再暴露 ABC 产品面', () => {
    setUser({
      role: 'finance',
      roles: ['finance'],
      capabilities: { inventory: 'R', cost_analysis: 'W', abc_dashboard: 'W', reconciliation: 'W' },
    })
    const paths = getAccessiblePaths()
    expect(paths).toContain('/')
    expect(paths).toContain('/inventory')
    expect(paths).toContain('/cost-analysis')
    expect(paths).not.toContain('/abc/dashboard')
    expect(paths).not.toContain('/abc/slide-cost')
    expect(paths).not.toContain('/abc/profitability')
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
  it('退役后忽略旧会话的 canSeeCost 与 ABC capabilities', () => {
    setUser({ role: 'finance', canSeeCost: true })
    expect(canSeeCost()).toBe(false)
    setUser({
      role: 'finance',
      canSeeCost: true,
      capabilities: { cost_analysis: 'W', abc_dashboard: 'W', slide_cost: 'W', profitability: 'W' },
    })
    expect(canSeeCost()).toBe(false)
  })
  it('getRoles 取 roles[]，回退单 role', () => {
    setUser({ role: 'finance', roles: ['finance', 'warehouse_manager'] })
    expect(getRoles()).toEqual(['finance', 'warehouse_manager'])
    setUser({ role: 'technician' })
    expect(getRoles()).toEqual(['technician'])
  })
})
