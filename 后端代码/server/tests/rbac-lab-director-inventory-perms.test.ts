/**
 * 聚焦迁移回归测试：实验室主任(lab_director) 退库/盘点 写权限补齐（R→W，2026-07-06 PM 口径）
 *
 * 背景见 reconcileLabDirectorInventoryPerms 注释 + PR 说明：
 * roles.permissions 是单一事实源、shadow SEED_MATRIX（getEffectivePermissionsForRoles 先读 roles 行，
 * permissions.ts:46-48）。ROLE-DIR 落库后既有库的 lab_director 行固化了旧 returns:'R'/stocktaking:'R'；
 * 仅改 SEED_MATRIX（PM 口径 R→W）对既有库静默无效（INSERT OR IGNORE 不覆盖、backfill 只补空值）→
 * 需本迁移把两键对齐 'W'。
 *
 * 本测试直接走 DB 解析路径（getEffectivePermissionsForRoles），补上纯对象断言
 *（rbac-p0-matrix-seed）覆盖不到的 shadowing 盲区——那个测试只断言 SEED_MATRIX 对象、
 * 不经 DB，无法暴露既有行 shadow 矩阵导致的静默无效。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { initializeDatabase, getDatabase, reconcileLabDirectorInventoryPerms } from '../src/database/DatabaseManager.js'
import { getEffectivePermissionsForRoles } from '../src/middleware/permissions.js'

let db: any

/** 把 lab_director 行改回旧口径（returns/stocktaking = 'R'）以模拟「本次改 SEED_MATRIX 之前落库」的既有行 */
function setStaleLabDirectorPerms(): void {
  const cur = getEffectivePermissionsForRoles(db, ['lab_director']) as Record<string, string>
  const stale = { ...cur, returns: 'R', stocktaking: 'R' }
  db.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(stale), 'lab_director')
}

describe('聚焦迁移：主任 退库/盘点 R→W 补齐（DB 解析路径，防 shadowing）', () => {
  beforeAll(() => {
    process.env.DATABASE_PATH = ':memory:'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ld'
    initializeDatabase()
    db = getDatabase()
  })

  it('reconcileLabDirectorInventoryPerms 是导出函数', () => {
    expect(typeof reconcileLabDirectorInventoryPerms).toBe('function')
  })

  it('既有库 lab_director 行固化旧 R → 迁移后 DB 解析出 returns/stocktaking = W（RED→GREEN）', () => {
    setStaleLabDirectorPerms()

    // RED：迁移前 DB 行 shadow 矩阵，解析出旧 R（证明只改 SEED_MATRIX 对既有行无效）
    const before = getEffectivePermissionsForRoles(db, ['lab_director']) as Record<string, string>
    expect(before.returns).toBe('R')
    expect(before.stocktaking).toBe('R')

    reconcileLabDirectorInventoryPerms(db)

    // GREEN：迁移后两键对齐 W；未被触碰的键仍原样（不误扩大范围）
    const after = getEffectivePermissionsForRoles(db, ['lab_director']) as Record<string, string>
    expect(after.returns).toBe('W')
    expect(after.stocktaking).toBe('W')
    expect(after.transfers).toBe('W') // 迁移前本就 W、未触碰
    expect(after.scraps).toBe('W')
    expect(after.inventory).toBe('R') // 只读键不被误提权
  })

  it('幂等：已 W 再跑两次不报错、不改动', () => {
    reconcileLabDirectorInventoryPerms(db)
    reconcileLabDirectorInventoryPerms(db)
    const after = getEffectivePermissionsForRoles(db, ['lab_director']) as Record<string, string>
    expect(after.returns).toBe('W')
    expect(after.stocktaking).toBe('W')
  })

  it('角色行缺失时拒绝静态矩阵回退，避免被删除角色恢复权限', () => {
    db.prepare('DELETE FROM roles WHERE code = ?').run('lab_director')
    expect(() => reconcileLabDirectorInventoryPerms(db)).not.toThrow()
    const eff = getEffectivePermissionsForRoles(db, ['lab_director']) as Record<string, string>
    expect(eff).toEqual({})
  })
})
