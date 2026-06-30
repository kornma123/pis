/**
 * 聚焦迁移回归测试：仓管/采购 supplier_returns 写权限补齐（数据驱动 RBAC 迁移缺口）
 *
 * 背景见 reconcileSupplierReturnsPerms 注释 + PR 说明：
 * roles.permissions 是单一事实源；SEED_MATRIX 后来新增 supplier_returns 给 whm/采购 'W'，
 * 但既有库（含提交进仓库的测试 coreone.db）的角色权限是旧值、无此模块，且 initializeDatabase
 * 的回填只填「完全为空」的权限 → 这两个角色拿不到 supplier_returns → 虽矩阵给权却 403。
 *
 * 范围注记：本迁移刻意只动 warehouse_manager/procurement 两角色，不做全矩阵对齐
 *（finance/technician 等的旧模型 e2e 当前为绿，全量对齐属另一独立决策）。本测试同时守住
 * 「finance 不被本迁移影响」这条不变量，防止未来误扩大范围导致 finance 退货用例回归。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb, reconcileSupplierReturnsPerms } from '../src/database/DatabaseManager.js'
import { getEffectivePermissions } from '../src/middleware/permissions.js'

// getDb() 来自 p0-harness：:memory: 库 + initializeDatabase。但本测试需要直接拿 db 句柄，
// 故复用 DatabaseManager 的 getDatabase（initializeDatabase 已在 import 链中由其它测试触发）。
// 这里用最小自给方式：直接 initializeDatabase 后取句柄。
import { initializeDatabase, getDatabase } from '../src/database/DatabaseManager.js'

let db: any
function userId(username: string): string {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as any).id
}
/** 把某角色权限改成「旧扁平数组、且不含 supplier_returns」以模拟既有库 */
function setStaleArrayPerms(code: string, codes: string[]): void {
  db.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(codes), code)
}

describe('聚焦迁移：whm/采购 supplier_returns 补齐', () => {
  beforeAll(() => {
    process.env.DATABASE_PATH = ':memory:'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-sr'
    initializeDatabase()
    db = getDatabase()
  })

  it('reconcileSupplierReturnsPerms 是导出函数', () => {
    expect(typeof reconcileSupplierReturnsPerms).toBe('function')
  })

  it('既有库（旧数组无 supplier_returns）→ 迁移后 whm/采购 拿到 supplier_returns W', () => {
    // 模拟提交进库的旧权限（真实 coreone.db 的 whm/采购数组截取，均不含 supplier_returns）
    setStaleArrayPerms('warehouse_manager', [
      'inventory', 'inbound', 'outbound', 'stocktaking', 'categories', 'materials',
      'suppliers', 'locations', 'alerts', 'purchase_orders', 'returns', 'scraps', 'transfers',
    ])
    setStaleArrayPerms('procurement', [
      'inventory', 'inbound', 'categories', 'materials', 'suppliers', 'purchase_orders', 'alerts',
    ])

    // RED：迁移前两角色都没有 supplier_returns
    expect(getEffectivePermissions(db, userId('cangguan')).supplier_returns).toBeUndefined()
    expect(getEffectivePermissions(db, userId('caigou')).supplier_returns).toBeUndefined()

    reconcileSupplierReturnsPerms(db)

    // GREEN：迁移后两角色都拿到 supplier_returns（W 蕴含读+写）
    expect(getEffectivePermissions(db, userId('cangguan')).supplier_returns).toBe('W')
    expect(getEffectivePermissions(db, userId('caigou')).supplier_returns).toBe('W')
  })

  it('不影响 finance（聚焦范围不变量）：finance 旧权限无 supplier_returns，迁移后仍无', () => {
    setStaleArrayPerms('finance', ['inventory', 'cost_analysis', 'logs'])
    reconcileSupplierReturnsPerms(db)
    expect(getEffectivePermissions(db, userId('caiwu')).supplier_returns).toBeUndefined()
  })

  it('幂等：已含 supplier_returns 再跑不报错、不重复', () => {
    reconcileSupplierReturnsPerms(db)
    reconcileSupplierReturnsPerms(db)
    const raw = (db.prepare('SELECT permissions FROM roles WHERE code = ?').get('warehouse_manager') as any).permissions
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      expect(arr.filter((c: string) => c === 'supplier_returns').length).toBe(1)
    }
    expect(getEffectivePermissions(db, userId('cangguan')).supplier_returns).toBe('W')
  })
})
