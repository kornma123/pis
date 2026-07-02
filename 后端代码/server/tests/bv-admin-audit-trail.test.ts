/**
 * 行为验证：admin 敏感财务写留痕（审计缺口自审的回归门禁）
 *
 * 背景（2026-07-02 多镜头自审）：曾疑虑"admin 以最高权限操作却无留痕"。核实结论——
 * 审计不落在 RBAC 守卫层（守卫对读也触发、在操作成功前跑，不是审计落点），而落在**操作层**：
 * 碰钱的写经 writeAuditLog 落 abc_audit_logs，含 operator（=用户名），对 admin 一视同仁。
 *
 * 本测试锁定该真实不变量：admin 执行一次敏感财务写（创建成本期间）后，abc_audit_logs 必有一条
 * 对应留痕，且 operator=admin。守 ABC 黄金零回归：仅新增只读断言，不改任何成本/收入逻辑。
 *
 * 数据库隔离：静态 import app（ESM 提升），隔离由 vitest setupFiles（tests/db-isolation.setup.ts）
 * 统一强制 :memory:，与 tests/integration/abc-cost.test.ts 同构。
 */

import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import app from '../src/app.js'
import { getDatabase } from '../src/database/DatabaseManager.js'

describe('审计留痕：admin 敏感财务写落 abc_audit_logs（operator=admin）', () => {
  let token: string
  let db: any

  beforeAll(async () => {
    db = getDatabase()
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })
    token = loginRes.body?.data?.token
    expect(token, 'admin 登录应成功').toBeTruthy()
  })

  it('admin 创建成本期间 → abc_audit_logs 留痕且 operator=admin', async () => {
    const yearMonth = '2098-07' // 隔离内存库不含该期间，走 INSERT 分支必写审计
    const res = await request(app)
      .post('/api/v1/abc/periods')
      .set('Authorization', `Bearer ${token}`)
      .send({ yearMonth, remark: '审计回归门禁' })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const periodId = res.body?.data?.id
    expect(periodId).toBeTruthy()

    const audit = db.prepare(`
      SELECT module, action, target_id, detail, operator
      FROM abc_audit_logs
      WHERE module = 'period' AND action = 'create' AND target_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(periodId) as any

    // 核心断言：admin 的最高权限操作**留痕**，且落到 admin 本人（SoD/合规前提）
    expect(audit, 'admin 创建期间应写入 abc_audit_logs').toBeTruthy()
    expect(audit.operator).toBe('admin')
    expect(JSON.parse(audit.detail)?.yearMonth).toBe(yearMonth)
  })
})
