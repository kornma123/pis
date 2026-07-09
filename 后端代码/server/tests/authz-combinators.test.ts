/**
 * 授权组合子夹具对（trigger + pass）—— 每个具名授权条件配「触发拒绝」+「通过」两个请求，
 * 作为后续「权限影子断言矩阵」的覆盖基石。无夹具的条件 = 未验证 = fail-closed（后续按待裁处理）。
 *
 * 这些是组合子的可执行规格（纯函数·无 DB）：锁 requireAdmin/isAdmin/assertNotSelfReview/
 * assertCaliberChangeAllowed 的判定与响应，与被提升的路由站点逐字节一致（行为零变更的验收网）。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  isAdmin,
  requireAdmin,
  assertNotSelfReview,
  assertCaliberChangeAllowed,
  SELF_REVIEW_FORBIDDEN,
} from '../src/middleware/authz-combinators.js'

function mockRes() {
  const res: any = { statusCode: 0, body: null }
  res.status = (c: number) => { res.statusCode = c; return res }
  res.json = (b: any) => { res.body = b; return res }
  return res
}
const reqWith = (user: any) => ({ user }) as any

describe('isAdmin —— roles-aware admin 谓词（caliber 门用）', () => {
  it('pass：primary role=admin → true', () => {
    expect(isAdmin(reqWith({ role: 'admin' }))).toBe(true)
  })
  it('pass：primary role 非 admin 但 roles[] 含 admin → true（roles-aware）', () => {
    expect(isAdmin(reqWith({ role: 'finance', roles: ['finance', 'admin'] }))).toBe(true)
  })
  it('trigger：既非 admin 也无 admin 角色 → false', () => {
    expect(isAdmin(reqWith({ role: 'finance', roles: ['finance'] }))).toBe(false)
  })
  it('trigger：user 缺失 → false（不抛错）', () => {
    expect(isAdmin(reqWith(undefined))).toBe(false)
  })
})

describe('requireAdmin({primaryRoleOnly:true}) —— alerts 站点夹具（只看 primary role）', () => {
  const guard = requireAdmin({ primaryRoleOnly: true, message: 'Forbidden', code: 'FORBIDDEN' })

  it('pass：primary role=admin → 放行（next 调用、无响应）', () => {
    const res = mockRes(); const next = vi.fn()
    guard(reqWith({ role: 'admin' }), res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(0)
  })
  it('trigger：primary role=finance → 403 {code:FORBIDDEN,message:Forbidden}、next 不调用', () => {
    const res = mockRes(); const next = vi.fn()
    guard(reqWith({ role: 'finance' }), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(res.body.error.message).toBe('Forbidden')
  })
  it('trigger（关键·逐字节）：primary role=finance 但 roles[] 含 admin → 仍 403（primaryRoleOnly 忽略 roles）', () => {
    const res = mockRes(); const next = vi.fn()
    guard(reqWith({ role: 'finance', roles: ['finance', 'admin'] }), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })
  it('trigger：user 缺失 → 403（复刻原 `!user` 分支，非 401）', () => {
    const res = mockRes(); const next = vi.fn()
    guard(reqWith(undefined), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })
})

describe('requireAdmin() —— 默认 roles-aware', () => {
  const guard = requireAdmin()
  it('pass：roles[] 含 admin → 放行', () => {
    const res = mockRes(); const next = vi.fn()
    guard(reqWith({ role: 'finance', roles: ['admin'] }), res, next)
    expect(next).toHaveBeenCalledOnce()
  })
  it('trigger：非 admin → 403 默认文案', () => {
    const res = mockRes(); const next = vi.fn()
    guard(reqWith({ role: 'finance' }), res, next)
    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(res.body.error.message).toBe('Forbidden: insufficient permissions')
  })
})

describe('assertNotSelfReview —— SoD 自审守卫', () => {
  it('pass：提交人 ≠ 操作者 → 返回 true、无响应（reconciliation/abc 通过路径）', () => {
    const res = mockRes()
    const ok = assertNotSelfReview(res, { submitterId: 'alice', actorId: 'bob', message: '不能审核自己提交的修正提案' })
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(0)
  })
  it('trigger：提交人 === 操作者 → 返回 false、403 SELF_REVIEW_FORBIDDEN', () => {
    const res = mockRes()
    const ok = assertNotSelfReview(res, { submitterId: 'alice', actorId: 'alice', message: '不能审核自己提交的修正提案' })
    expect(ok).toBe(false)
    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe(SELF_REVIEW_FORBIDDEN)
    expect(res.body.error.message).toBe('不能审核自己提交的修正提案')
  })
  it('trigger（fail-closed）：submitted_by 缺失 + failClosedOnMissing → 403（account-reconcile 签发门夹具）', () => {
    for (const missing of ['', null, undefined]) {
      const res = mockRes()
      const ok = assertNotSelfReview(res, { submitterId: missing, actorId: 'bob', message: '不能签发自己提交的补收单（或提交人缺失）', failClosedOnMissing: true })
      expect(ok).toBe(false)
      expect(res.statusCode).toBe(403)
    }
  })
  it('pass（不 fail-closed）：submitted_by 缺失但未开 failClosed → true（reconciliation/abc/cost-adjustment 语义）', () => {
    const res = mockRes()
    const ok = assertNotSelfReview(res, { submitterId: '', actorId: 'bob', message: 'x' })
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(0)
  })
  it('trigger（自定义 code）：cost-adjustment 站点用 code=FORBIDDEN', () => {
    const res = mockRes()
    const ok = assertNotSelfReview(res, { submitterId: 'u1', actorId: 'u1', message: '不能审核自己提交的调整', code: 'FORBIDDEN' })
    expect(ok).toBe(false)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })
})

describe('assertCaliberChangeAllowed —— 口径变更 admin 门', () => {
  it('trigger：改了口径 + 非 admin → 返回 false、403 FORBIDDEN', () => {
    const res = mockRes()
    const ok = assertCaliberChangeAllowed(reqWith({ role: 'finance' }), res, true, '拆分/诊断口径仅管理员可改（国标费率与工艺拆分是口径决策，财务侧只读）')
    expect(ok).toBe(false)
    expect(res.statusCode).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })
  it('pass：改了口径但操作者是 admin → true、无响应', () => {
    const res = mockRes()
    const ok = assertCaliberChangeAllowed(reqWith({ role: 'admin' }), res, true, 'x')
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(0)
  })
  it('pass：未改口径（changed=false）+ 非 admin → true（口径没动不设门，财务可写 in/out+扣率）', () => {
    const res = mockRes()
    const ok = assertCaliberChangeAllowed(reqWith({ role: 'finance' }), res, false, 'x')
    expect(ok).toBe(true)
    expect(res.statusCode).toBe(0)
  })
})
