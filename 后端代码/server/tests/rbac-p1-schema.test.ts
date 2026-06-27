/**
 * RBAC Phase 1：Schema/Seed —— user_roles + primary_role + 矩阵种子 + lab_director + app_settings + 回填
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'

let db: any
function cols(t: string): string[] {
  return (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name)
}

beforeAll(async () => { db = await getDb() })

describe('RBAC-P1：Schema/Seed', () => {
  it('user_roles 表存在 + users.primary_role 列', () => {
    expect(cols('user_roles')).toEqual(expect.arrayContaining(['id', 'user_id', 'role_code']))
    expect(cols('users')).toContain('primary_role')
    expect(cols('app_settings')).toEqual(expect.arrayContaining(['key', 'value']))
  })

  it('新增 lab_director 角色', () => {
    const r = db.prepare("SELECT * FROM roles WHERE code = 'lab_director'").get() as any
    expect(r).toBeTruthy()
  })

  it('roles.permissions 种子为矩阵对象（warehouse_manager.inventory=W）；admin=["*"]', () => {
    const whm = db.prepare("SELECT permissions FROM roles WHERE code = 'warehouse_manager'").get() as any
    const parsed = JSON.parse(whm.permissions)
    expect(parsed.inventory).toBe('W')
    expect(parsed.bom).toBe('R')
    const admin = db.prepare("SELECT permissions FROM roles WHERE code = 'admin'").get() as any
    expect(JSON.parse(admin.permissions)).toEqual(['*'])
    // 病理成本为空
    const doc = JSON.parse((db.prepare("SELECT permissions FROM roles WHERE code = 'pathologist'").get() as any).permissions)
    expect(doc.abc_dashboard).toBeUndefined()
    expect(doc.inventory).toBe('R')
  })

  it('存量用户回填 user_roles + primary_role（admin）', () => {
    const adminUser = db.prepare("SELECT id, primary_role FROM users WHERE username = 'admin'").get() as any
    expect(adminUser.primary_role).toBe('admin')
    const ur = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ?').all(adminUser.id) as any[]
    expect(ur.map((x) => x.role_code)).toContain('admin')
    // 财务测试用户 caiwu 也回填
    const fin = db.prepare("SELECT id FROM users WHERE username = 'caiwu'").get() as any
    const finRoles = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ?').all(fin.id) as any[]
    expect(finRoles.map((x) => x.role_code)).toContain('finance')
  })

  it('app_settings.cost_visibility_roles 默认 finance/lab_director/admin', () => {
    const s = db.prepare("SELECT value FROM app_settings WHERE key = 'cost_visibility_roles'").get() as any
    expect(JSON.parse(s.value)).toEqual(expect.arrayContaining(['finance', 'lab_director', 'admin']))
  })

  it('重复 init 幂等不抛 + user_roles 不重复', async () => {
    const mod = await import('../src/database/DatabaseManager.js')
    expect(() => mod.initializeDatabase()).not.toThrow()
    const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as any
    const cnt = db.prepare('SELECT COUNT(*) as c FROM user_roles WHERE user_id = ? AND role_code = ?').get(adminUser.id, 'admin') as any
    expect(cnt.c).toBe(1)
  })
})
