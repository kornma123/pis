/**
 * Issue #106（DS-WF2-SIMPLE-20260804 · Worker B）：
 * account-reconcile 各可触达 catch-all 对未知异常必须统一收敛为稳定、脱敏的 500，
 * 响应体不得包含 SQL/堆栈/内部路径等 err.message 细节；既有具名领域错误
 * （400/409/410 及 ReconcileLifecycleError 码）语义不变。
 *
 * 注入方式：对 harness 单例 DatabaseSync 的 prepare() 做 vi.spyOn，令其抛带
 * sentinel 的未知异常——不触碰任何真实业务数据，也不 mock 路由模块。
 * NODE_ENV=development 是复现泄漏的最强环境（response.ts 在非 development 下
 * 已对 500 掩码），用它证明路由层不得再透传 err.message。
 *
 * 挂载链刻意不含 auditWrite：其 finish 钩子会再查 DB，与脱敏行为正交，且避免
 * prepare spy 污染审计路径。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

const LEAK_TOKENS = [
  'SQLITE_ERROR',
  'secret_internal_leak_table',
  'DatabaseSync.prepare',
  'internal\\worktree',
  'db.sqlite',
]
const SENTINEL = [
  'SQLITE_ERROR: no such table: secret_internal_leak_table',
  '    at DatabaseSync.prepare (node:sqlite)',
  '    at C:\\internal\\worktree\\db.sqlite',
].join('\n')

const BINDING = {
  partnerId: 'PT-RECON-106',
  settlementMonth: '2026-06',
  statementGenerationId: 'stmt-recon-106',
  reconcileGenerationId: 'recon-106',
}

let app: any
let token = ''
let db: any
let prepareSpy: { mockRestore(): void } | null = null

async function mountApp() {
  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    {
      path: '/api/v1/account-reconcile',
      router: routes,
      middleware: [authenticateToken, requirePermission('account_reconcile', 'R')],
    },
  ])
}

beforeAll(async () => {
  db = await getDb()
  app = await mountApp()
  token = await loginAdmin(app)
})

afterEach(() => {
  prepareSpy?.mockRestore()
  prepareSpy = null
  vi.unstubAllEnvs()
})

const AUTH_SQL_PREFIXES = [
  'SELECT status, is_deleted, role, primary_role FROM users WHERE id = ?',
  'SELECT ur.role_code',
  'SELECT u.role',
  'SELECT permissions, status, is_deleted FROM roles WHERE code = ?',
]

function injectUnknownInternalError(): void {
  const originalPrepare = db.prepare.bind(db)
  prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(function (this: any, sql: string) {
    if (!AUTH_SQL_PREFIXES.some(prefix => sql.trimStart().startsWith(prefix))) {
      throw new Error(SENTINEL)
    }
    return originalPrepare(sql)
  })
}

const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)

describe('Issue #106 · 未知错误统一脱敏 500', () => {
  const cases: Array<{ name: string; request: () => any }> = [
    {
      name: 'GET /overview',
      request: () => auth(
        request(app).get('/api/v1/account-reconcile/overview')
          .query({ settlementMonth: BINDING.settlementMonth }),
      ),
    },
    {
      name: 'GET /workbench',
      request: () => auth(
        request(app).get('/api/v1/account-reconcile/workbench').query(BINDING),
      ),
    },
    {
      name: 'POST /compute',
      request: () => auth(
        request(app).post('/api/v1/account-reconcile/compute').send(BINDING),
      ),
    },
    {
      name: 'GET /supplements',
      request: () => auth(
        request(app).get('/api/v1/account-reconcile/supplements')
          .query({ serviceMonth: BINDING.settlementMonth }),
      ),
    },
    {
      name: 'POST /supplements/:id/approve',
      request: () => auth(
        request(app).post('/api/v1/account-reconcile/supplements/so-106/approve').send({}),
      ),
    },
    {
      name: 'POST /supplements/:id/collect',
      request: () => auth(
        request(app).post('/api/v1/account-reconcile/supplements/so-106/collect')
          .send({ collectedMonth: '2026-07' }),
      ),
    },
    {
      name: 'POST /supplements/:id/giveup',
      request: () => auth(
        request(app).post('/api/v1/account-reconcile/supplements/so-106/giveup')
          .send({ reason: 'x' }),
      ),
    },
    {
      name: 'POST /supplements/:id/reopen',
      request: () => auth(
        request(app).post('/api/v1/account-reconcile/supplements/so-106/reopen')
          .send({ reason: 'x' }),
      ),
    },
    {
      name: 'POST /hospital-months/:id/complete',
      request: () => auth(
        request(app).post('/api/v1/account-reconcile/hospital-months/hm-106/complete')
          .send(BINDING),
      ),
    },
    {
      name: 'POST /close',
      request: () => auth(
        request(app).post('/api/v1/account-reconcile/close').send({ items: [BINDING] }),
      ),
    },
    {
      name: 'POST /diffs/:id/verdict',
      request: () => auth(
        request(app).post('/api/v1/account-reconcile/diffs/diff-106/verdict')
          .send({ ...BINDING, reason: '核对无误' }),
      ),
    },
  ]

  it.each(cases)('$name 的未知异常 -> 稳定脱敏 500，响应体不含内部细节', async ({ request: send }) => {
    vi.stubEnv('NODE_ENV', 'development')
    injectUnknownInternalError()
    const res = await send()
    expect(res.status).toBe(500)
    expect(res.body.success).toBe(false)
    expect(res.body.error.code).toBe('INTERNAL_ERROR')
    expect(res.body.error.message).toBe('服务器内部错误，请稍后重试')
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(SENTINEL)
    for (const leakToken of LEAK_TOKENS) {
      expect(body).not.toContain(leakToken)
    }
  })
})

describe('Issue #106 · 具名领域错误语义不变', () => {
  it('GET /workbench 缺 binding -> 400 GENERATION_BINDING_REQUIRED（ReconcileLifecycleError 映射不变）', async () => {
    const res = await auth(request(app).get('/api/v1/account-reconcile/workbench'))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('GENERATION_BINDING_REQUIRED')
  })

  it('POST /compute 缺 binding -> 400 GENERATION_BINDING_REQUIRED', async () => {
    const res = await auth(request(app).post('/api/v1/account-reconcile/compute').send({}))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('GENERATION_BINDING_REQUIRED')
  })

  it('GET /overview 非法结算月 -> 400 INVALID_SETTLEMENT_MONTH', async () => {
    const res = await auth(request(app).get('/api/v1/account-reconcile/overview')
      .query({ settlementMonth: '2026-13' }))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_SETTLEMENT_MONTH')
  })

  it('POST /close 多绑定 -> 400 GENERATION_BINDING_REQUIRED', async () => {
    const res = await auth(request(app).post('/api/v1/account-reconcile/close')
      .send({ items: [BINDING, { ...BINDING, reconcileGenerationId: 'recon-106-b' }] }))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('GENERATION_BINDING_REQUIRED')
  })

  it('GET /__pre_loc005/* -> 410 GENERATION_BINDING_REQUIRED（LOC-005 移除语义不变）', async () => {
    const res = await auth(request(app).get('/api/v1/account-reconcile/__pre_loc005/overview'))
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('GENERATION_BINDING_REQUIRED')
  })
})
