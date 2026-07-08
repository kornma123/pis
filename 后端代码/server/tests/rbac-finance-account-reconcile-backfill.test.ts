/**
 * 聚焦迁移回归测试：财务(finance) account_reconcile 写权限补齐（数据驱动 RBAC 迁移缺口）
 *
 * 背景见 reconcileFinanceAccountReconcilePerms 注释 + PR 说明：
 * roles.permissions 是单一事实源；SEED_MATRIX 早已给 finance account_reconcile:'W'，但既有库
 *（含提交进仓库的测试 coreone.db）的 finance 行是旧最小数组 ['dashboard','cost_analysis','logs']、
 * 无此模块，且 initializeDatabase 的回填只填「完全为空」的权限 → finance 拿不到 account_reconcile。
 *
 * 直接动因：PR #94 补收单独立签发(SoD)要求签发人≠提交人；全库只有 admin 一个 account_reconcile:'W'
 * 用户时 admin 提交的补收单无人可签 = 确定性死锁。补 finance 'W' 提供第二签发人。
 *
 * 范围注记：本迁移刻意只动 finance 这一角色这一键，不做全矩阵对齐（保留 finance 其余旧模型口径，
 * 如退货 R 的既有 e2e）。本测试同时守住「不误伤 finance 其它键 + 不影响其它角色」两条不变量。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  reconcileFinanceAccountReconcilePerms,
  initializeDatabase,
  getDatabase,
} from '../src/database/DatabaseManager.js'
import { getEffectivePermissions } from '../src/middleware/permissions.js'

let db: any
function userId(username: string): string {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as any).id
}
function setPerms(code: string, perms: unknown): void {
  db.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(JSON.stringify(perms), code)
}
function rawPerms(code: string): string {
  return (db.prepare('SELECT permissions FROM roles WHERE code = ?').get(code) as any).permissions
}

describe('聚焦迁移：finance account_reconcile 补齐（SoD 第二签发人）', () => {
  beforeAll(() => {
    process.env.DATABASE_PATH = ':memory:'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-fin-ar'
    initializeDatabase()
    db = getDatabase()
  })

  it('reconcileFinanceAccountReconcilePerms 是导出函数', () => {
    expect(typeof reconcileFinanceAccountReconcilePerms).toBe('function')
  })

  it('既有库（旧数组无 account_reconcile）→ 迁移后 finance 拿到 account_reconcile W，且不误伤其它键', () => {
    // 模拟提交进库的真实 finance 旧权限（rbac 探针实测：['dashboard','cost_analysis','logs']）
    setPerms('finance', ['dashboard', 'cost_analysis', 'logs'])

    // RED：迁移前 finance 无 account_reconcile
    expect(getEffectivePermissions(db, userId('caiwu')).account_reconcile).toBeUndefined()

    reconcileFinanceAccountReconcilePerms(db)

    // GREEN：迁移后拿到 account_reconcile（W 蕴含读+写）
    expect(getEffectivePermissions(db, userId('caiwu')).account_reconcile).toBe('W')
    // 不误伤既有键：cost_analysis 仍在（旧数组 presence=W）
    expect(getEffectivePermissions(db, userId('caiwu')).cost_analysis).toBe('W')
  })

  it('对象形态（{mod:R|W} 无 account_reconcile）→ 迁移后置为 W，不动其它键', () => {
    setPerms('finance', { cost_analysis: 'W', partner_pricing: 'R' })
    reconcileFinanceAccountReconcilePerms(db)
    const eff = getEffectivePermissions(db, userId('caiwu'))
    expect(eff.account_reconcile).toBe('W')
    expect(eff.cost_analysis).toBe('W')
    expect(eff.partner_pricing).toBe('R')
  })

  it('幂等：已含 account_reconcile 再跑不报错、不重复', () => {
    setPerms('finance', ['cost_analysis', 'account_reconcile'])
    reconcileFinanceAccountReconcilePerms(db)
    reconcileFinanceAccountReconcilePerms(db)
    const arr = JSON.parse(rawPerms('finance'))
    if (Array.isArray(arr)) {
      expect(arr.filter((c: string) => c === 'account_reconcile').length).toBe(1)
    }
    expect(getEffectivePermissions(db, userId('caiwu')).account_reconcile).toBe('W')
  })

  it('不越权：admin(*) 与其它角色不被本迁移改动', () => {
    setPerms('finance', ['cost_analysis'])
    const beforeWhm = rawPerms('warehouse_manager')
    const beforeTech = rawPerms('technician')
    reconcileFinanceAccountReconcilePerms(db)
    // 只动 finance；其它角色原样
    expect(rawPerms('warehouse_manager')).toBe(beforeWhm)
    expect(rawPerms('technician')).toBe(beforeTech)
    // technician 仍无 account_reconcile
    expect(getEffectivePermissions(db, userId('jishuyuan1')).account_reconcile).toBeUndefined()
  })

  it('脏值不覆盖：无法解析的 permissions 原样保留', () => {
    db.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run('not-json{', 'finance')
    reconcileFinanceAccountReconcilePerms(db)
    expect(rawPerms('finance')).toBe('not-json{')
  })
})
