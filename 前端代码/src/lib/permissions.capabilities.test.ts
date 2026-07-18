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
  it('capabilities 缺失且角色已登记 → R 放行（legacy 会话兼容）', () => {
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
  it.each(['external_auditor', 'constructor'])(
    '未登记角色 %s 且 capabilities 缺失 → R/W 均拒绝，不继承 legacy 读权限',
    (role) => {
      setUser({ role })
      expect(canAccess('equipment', 'R')).toBe(false)
      expect(canAccess('equipment', 'W')).toBe(false)
    }
  )
  // 零权限用户：后端 getEffectivePermissions 返回 {}，非 null → 不走 caps 缺失分支。
  it('capabilities 为空对象 → R/W 均拒绝（{} 是真值，走模块缺失分支）', () => {
    setUser({ role: 'pathologist', capabilities: {} })
    expect(canAccess('labor_times', 'R')).toBe(false)
    expect(canAccess('labor_times', 'W')).toBe(false)
  })
})

describe('getAccessiblePaths（能力驱动 nav）', () => {
  it('equipment 能力只增加 active 父页，不把 headless 或其他模块塞进导航', () => {
    setUser({ role: 'technician', roles: ['technician'], capabilities: { equipment: 'R' } })
    expect(getAccessiblePaths()).toEqual(['/', '/equipment'])
  })

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

  it.each([
    { role: 'external_auditor' },
    { role: 'external_auditor', roles: ['external_auditor'] },
    { role: 'constructor' },
  ])('未知角色且 capabilities 缺失 → 仅保留公共首页，不继承 technician：%j', (user) => {
    setUser(user)
    expect(getAccessiblePaths()).toEqual(['/'])
  })

  it('未知角色只有在后端显式下发 equipment capability 时才获得设备父页', () => {
    setUser({
      role: 'external_auditor',
      roles: ['external_auditor'],
      capabilities: { equipment: 'R' },
    })
    expect(getAccessiblePaths()).toEqual(['/', '/equipment'])
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
