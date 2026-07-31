/**
 * Issue 106（LOC-005 follow-up）：account-reconcile 新增 handler 的未知错误必须统一
 * 映射为脱敏 500，绝不把 err.message 回显给客户端（安全红线：API 错误消息不暴露内部
 * 实现细节）。
 *
 * RED 姿势说明：tests/db-isolation.setup.ts 会把 NODE_ENV 固定为 'test'，而
 * utils/response.ts 只在非 development 环境对 5xx 做通用掩码——base 上若留在 'test'
 * 跑，泄漏会被 response.ts 的通用掩码盖住，负测会假绿。因此本文件在一切被测模块
 * import 之前把 NODE_ENV 显式切到 'development'，让 base 的真实泄漏路径暴露出来，
 * 证明「未知 500 必须由路由层脱敏、不依赖 response.ts 的环境掩码」这一契约。
 */
process.env.NODE_ENV = 'development'

import { describe, it, expect, beforeAll, vi } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin, seedReviewer } from './p0-harness.js'

const { LEAK_SQL, LEAK_PATH, LEAK_STACK } = vi.hoisted(() => ({
  LEAK_SQL: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: supplement_orders.id',
  LEAK_PATH: 'C:\\app\\server\\src\\services\\internal-reconcile.ts',
  LEAK_STACK: 'at readAccountReconciliation (internal-reconcile.ts:42:7)',
}))

const GENERIC_500 = '服务器内部错误，请稍后重试'

// overview / supplements GET / supplement 写端点的共用注入点：凡命中 supplement_orders
// 查询的内部异常都在路由 catch 里炸开（保持真实数据库与真实 handler 顺序，只换异常）。
vi.mock('../src/database/DatabaseManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/database/DatabaseManager.js')>()
  return {
    ...actual,
    getDatabase: () => {
      const db = actual.getDatabase()
      const originalPrepare = db.prepare.bind(db)
      db.prepare = (sql: string, ...args: unknown[]) => {
        if (String(sql).includes('FROM supplement_orders')) {
          throw new Error(`${LEAK_SQL} ${LEAK_PATH}`)
        }
        return originalPrepare(sql, ...args)
      }
      return db
    },
  }
})

// workbench 的 lifecycleError 未知分支注入点：readAccountReconciliation 抛内部异常。
// 其余导出（assertReconcileBinding/isStrictSettlementMonth/ReconcileLifecycleError…）
// 必须保留真实实现，域错误稳定码测试依赖它们。
vi.mock('../src/services/account-reconciliation-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/account-reconciliation-lifecycle.js')>()
  return {
    ...actual,
    readAccountReconciliation: vi.fn(() => {
      throw new Error(`${LEAK_STACK} ${LEAK_SQL}`)
    }),
  }
})

const SUPPLEMENT_ID = 'so-issue106-sanitize'

let app: Awaited<ReturnType<typeof buildTestApp>>
let adminToken = ''

beforeAll(async () => {
  const db = await getDb()
  await seedReviewer(db)
  // 让 approve 走完业务前置（存在/待补收/未签发/非自审）后在 recordOverride 处爆炸。
  db.prepare(
    `INSERT INTO supplement_orders
       (id, partner_id, service_month, amount, status, review_status, submitted_by)
     VALUES (?, ?, ?, ?, '待补收', 'pending_review', ?)`,
  ).run(SUPPLEMENT_ID, 'PT-ISSUE106', '2026-06', 100, 'reviewer2')

  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const { auditWrite } = await import('../src/middleware/audit-log.js')
  app = await buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    {
      path: '/api/v1/account-reconcile',
      router: routes,
      middleware: [auditWrite, authenticateToken, requirePermission('account_reconcile', 'R')],
    },
  ])
  adminToken = await loginAdmin(app)
})

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${adminToken}`)

const assertSanitized500 = (res: request.Response) => {
  expect(res.status).toBe(500)
  expect(res.body.success).toBe(false)
  expect(res.body.error.code).toBe('INTERNAL_ERROR')
  expect(res.body.error.message).toBe(GENERIC_500)
  const raw = res.text
  expect(raw).not.toContain(LEAK_SQL)
  expect(raw).not.toContain(LEAK_PATH)
  expect(raw).not.toContain(LEAK_STACK)
}

describe('Issue 106 · 新增 handler 未知错误脱敏 500（development 模式暴露 base 泄漏）', () => {
  it('GET /overview 未知异常 → 500 脱敏，响应体不含 SQL/路径/堆栈', async () => {
    const res = await auth(
      request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: '2026-06' }),
    )
    assertSanitized500(res)
  })

  it('GET /workbench 未知异常（lifecycleError 兜底）→ 500 脱敏', async () => {
    const res = await auth(
      request(app).get('/api/v1/account-reconcile/workbench').query({
        partnerId: 'PT-ISSUE106',
        settlementMonth: '2026-06',
        statementGenerationId: 'stmt-issue106',
        reconcileGenerationId: 'recon-issue106',
      }),
    )
    assertSanitized500(res)
  })

  it('POST /supplements/:id/approve 未知异常（errorSupplementLifecycle 兜底）→ 500 脱敏', async () => {
    const res = await auth(
      request(app).post(`/api/v1/account-reconcile/supplements/${SUPPLEMENT_ID}/approve`).send({}),
    )
    assertSanitized500(res)
  })

  it('GET /supplements 未知异常 → 500 脱敏', async () => {
    const res = await auth(
      request(app).get('/api/v1/account-reconcile/supplements').query({ status: '待补收' }),
    )
    assertSanitized500(res)
  })
})

describe('Issue 106 · 域错误稳定码不被改变', () => {
  it('workbench 缺 binding → 400 GENERATION_BINDING_REQUIRED 保持', async () => {
    const res = await auth(request(app).get('/api/v1/account-reconcile/workbench').query({}))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('GENERATION_BINDING_REQUIRED')
  })

  it('旧端点路径 → 410 GENERATION_BINDING_REQUIRED 保持', async () => {
    const res = await auth(request(app).get('/api/v1/account-reconcile/__pre_loc005/overview'))
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('GENERATION_BINDING_REQUIRED')
  })
})
