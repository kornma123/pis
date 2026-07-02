/**
 * 行为验证：全站写操作统一审计中间件（middleware/audit-log.ts）
 *
 * 立项背景：通用 CRUD（用户/角色/物料/库存/单据…）此前无统一审计，admin 或任何人改这些不留痕
 * （FRS-16 §3.1.3 已承认覆盖不全）。本中间件补齐——给所有登录后成功写操作统一落 operation_logs。
 *
 * 决策（2026-07-02 用户拍板）：全站双轨（成本域并存 abc_audit_logs）+ 只记成功(2xx) + 强制脱敏。
 *
 * BDD 契约（本文件逐条锁定）：
 *  1. 成功的写(2xx) → operation_logs 新增一条，operator=当前用户，operation 含模块名，request_data 保留提交字段。
 *  2. 读(GET) → 不新增。
 *  3. 失败的写(4xx/5xx) → 不新增。
 *  4. 敏感字段(password/token/secret…) → request_data 中被 [REDACTED]（含嵌套）。
 *  5. 成本域双轨：成本写既进 abc_audit_logs 又进 operation_logs。
 *
 * 守 ABC 黄金零回归：中间件只追加日志、不改任何业务响应/成本逻辑。
 */

import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import app from '../src/app.js'
import { getDatabase } from '../src/database/DatabaseManager.js'
import { scrubSensitive } from '../src/middleware/audit-log.js'

const countLogs = (db: any) =>
  (db.prepare('SELECT COUNT(*) AS c FROM operation_logs').get() as any).c as number

describe('审计中间件：scrubSensitive 脱敏（单元）', () => {
  it('打码 password/token/secret（含嵌套与数组），保留普通字段', () => {
    const out: any = scrubSensitive({
      name: '张三',
      password: 'p@ss',
      nested: { apiToken: 'x', ok: 1, client_secret: 's' },
      list: [{ pwd: 'a', keep: 'b' }],
    })
    expect(out.name).toBe('张三')
    expect(out.password).toBe('[REDACTED]')
    expect(out.nested.apiToken).toBe('[REDACTED]')
    expect(out.nested.client_secret).toBe('[REDACTED]')
    expect(out.nested.ok).toBe(1)
    expect(out.list[0].pwd).toBe('[REDACTED]')
    expect(out.list[0].keep).toBe('b')
  })
})

describe('审计中间件：全站写操作留痕（集成，admin）', () => {
  let token: string
  let db: any
  let categoryId: string

  beforeAll(async () => {
    db = getDatabase()
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })
    token = loginRes.body?.data?.token
    expect(token, 'admin 登录应成功').toBeTruthy()
    // 隔离内存库无 seed 分类 → 自建一个（物料创建依赖 categoryId）
    const catRes = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `AUDIT_CAT_${Date.now()}`, level: 1 })
    categoryId = catRes.body?.data?.id
    expect(categoryId, `分类创建应成功: ${JSON.stringify(catRes.body)}`).toBeTruthy()
  })

  it('成功的写(POST /materials 创建) → operation_logs 新增一条且 operator=admin，敏感字段脱敏', async () => {
    const before = countLogs(db)
    const name = `AUDIT_MW_${Date.now()}`
    const res = await request(app)
      .post('/api/v1/materials')
      .set('Authorization', `Bearer ${token}`)
      // 混入敏感字段：物料路由会忽略它们，但中间件对 raw body 脱敏 → 验证端到端打码
      .send({ name, unit: '个', categoryId, password: 'should-not-persist', apiToken: 'nope' })

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(countLogs(db)).toBe(before + 1)

    const row = db.prepare(`
      SELECT * FROM operation_logs WHERE operation = 'POST materials' ORDER BY rowid DESC LIMIT 1
    `).get() as any
    expect(row).toBeTruthy()
    expect(row.username).toBe('admin')
    expect(row.request_data).toContain(name)          // 普通字段保留
    expect(row.request_data).toContain('[REDACTED]')  // 敏感字段打码
    expect(row.request_data).not.toContain('should-not-persist')
    expect(row.request_data).not.toContain('nope')
  })

  it('读(GET /materials) → operation_logs 不新增', async () => {
    const before = countLogs(db)
    const res = await request(app)
      .get('/api/v1/materials')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(countLogs(db)).toBe(before)
  })

  it('失败的写(PUT /materials/不存在 → 404) → operation_logs 不新增', async () => {
    const before = countLogs(db)
    const res = await request(app)
      .put('/api/v1/materials/nonexistent-id-xyz')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '改名' })
    expect(res.status).toBe(404)
    expect(countLogs(db)).toBe(before)
  })

  it('未登录的写 → operation_logs 不新增（401 前置拦截）', async () => {
    const before = countLogs(db)
    const res = await request(app)
      .post('/api/v1/materials')
      .send({ name: 'x', unit: '个', categoryId })
    expect(res.status).toBe(401)
    expect(countLogs(db)).toBe(before)
  })

  it('成本域双轨：POST /abc/periods 既进 abc_audit_logs 又进 operation_logs', async () => {
    const beforeOps = countLogs(db)
    const yearMonth = '2097-05'
    const res = await request(app)
      .post('/api/v1/abc/periods')
      .set('Authorization', `Bearer ${token}`)
      .send({ yearMonth, remark: '双轨验证' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    // 专属审计
    const abc = db.prepare(`
      SELECT * FROM abc_audit_logs WHERE module='period' AND action='create' AND target_id=? LIMIT 1
    `).get(res.body.data.id) as any
    expect(abc, 'abc_audit_logs 应有专属留痕').toBeTruthy()
    expect(abc.operator).toBe('admin')

    // 统一账本（双轨）
    expect(countLogs(db)).toBe(beforeOps + 1)
    const ops = db.prepare(`
      SELECT * FROM operation_logs WHERE operation='POST abc' ORDER BY rowid DESC LIMIT 1
    `).get() as any
    expect(ops, 'operation_logs 应有统一留痕').toBeTruthy()
    expect(ops.username).toBe('admin')
  })
})
