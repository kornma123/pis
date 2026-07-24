/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 行为验证：全站写操作统一审计中间件（middleware/audit-log.ts）
 *
 * 立项背景：通用 CRUD（用户/角色/物料/库存/单据…）此前无统一审计，admin 或任何人改这些不留痕
 * （FRS-16 §3.1.3 已承认覆盖不全）。本中间件补齐——给所有登录后成功写操作统一落 operation_logs。
 *
 * 决策（2026-07-02 用户拍板）：全站双轨（成本域并存 abc_audit_logs）+ 强制脱敏。
 *
 * P-3 拒绝写审计（SEC-3）扩展：对登录后的写操作**成功与被拒都记**，区分靠 outcome 列。
 *
 * BDD 契约（本文件逐条锁定）：
 *  1. 成功的写(2xx) → operation_logs 新增一条 outcome=NULL 行，operator=当前用户，request_data 保留提交字段（脱敏后）。
 *  2. 读(GET) → 不新增。
 *  3. 被拒的写(4xx) → 记一条 outcome='denied' 行，仅 {status,code} 元数据、**绝不落 req.body**；
 *     403 越权 = authz 类（可触发探测告警），404/409/422 = other 类（不触发告警）。5xx/未登录(401 无 req.user) → 不记。
 *  4. 敏感字段(password/token/secret…) → 成功行 request_data 中被 [REDACTED]（含嵌套）；被拒行根本不含 body。
 *  5. 成本域双轨：成本写既进 abc_audit_logs 又进 operation_logs。
 *  6. 同账号短时间对多个写端点被拒(403) → 落一条 outcome='security_alert' 行（越权探测签名）。
 *  7. 同一主体每分钟同类被拒 > 阈值 → 逐条转一条 outcome='denied_agg' 聚合计数行（防刷）。
 *
 * 守 ABC 黄金零回归：中间件只追加日志、不改任何业务响应/成本逻辑。
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import express from 'express'
import request from 'supertest'
import app from '../src/app.js'
import { getDatabase } from '../src/database/DatabaseManager.js'
import {
  scrubSensitive,
  auditWrite,
  setSuccessAuditMetadata,
  __resetDenialTrackerForTest,
  DENIAL_AGG_THRESHOLD,
  DENIAL_ALERT_DISTINCT,
} from '../src/middleware/audit-log.js'
import { computeStatementSourceHash } from '../src/services/statement-normalized-lines.js'
import { createLegacyAbcCompatibilityApp } from './helpers/legacy-abc-compatibility-app.js'

const legacyAbcApp = createLegacyAbcCompatibilityApp({ auditWrites: true })

const countLogs = (db: any) =>
  (db.prepare('SELECT COUNT(*) AS c FROM operation_logs').get() as any).c as number
const login = async (username: string, password: string) => {
  const res = await request(app).post('/api/v1/auth/login').send({ username, password })
  return res.body?.data?.token as string
}

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
    token = await login('admin', 'admin123')
    expect(token, 'admin 登录应成功').toBeTruthy()
    // 隔离内存库无 seed 分类 → 自建一个（物料创建依赖 categoryId）
    const catRes = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `AUDIT_CAT_${Date.now()}`, level: 1 })
    categoryId = catRes.body?.data?.id
    expect(categoryId, `分类创建应成功: ${JSON.stringify(catRes.body)}`).toBeTruthy()
  })

  // 每用例前重置拒绝追踪器单例（清空窗口计数），避免跨用例状态泄漏
  beforeEach(() => __resetDenialTrackerForTest())

  it('成功的写(POST /materials 创建) → operation_logs 新增一条 outcome=NULL 且 operator=admin，敏感字段脱敏', async () => {
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
    expect(row.outcome == null, '成功行 outcome 应为 NULL').toBe(true)
    expect(row.request_data).toContain(name)          // 普通字段保留
    expect(row.request_data).toContain('[REDACTED]')  // 敏感字段打码
    expect(row.request_data).not.toContain('should-not-persist')
    expect(row.request_data).not.toContain('nope')
  })

  it('statement empty import success audit stores only server-controlled safe metadata', async () => {
    const marker = `RAW_SOURCE_${Date.now()}`
    const canonicalPartnerId = `PT-AUDIT-${Date.now()}`
    const empty = {
      partnerId: `  ${canonicalPartnerId}  `,
      settlementMonth: '2026-01',
      sourceFile: `${marker}.xlsx`,
      sourceHash: computeStatementSourceHash([]),
      templateFamily: 'category_summary',
      parserRevision: 'parser-phase1a-v1',
      configRevision: 'seed-phase1a-v1',
      sourceSheet: 'Sheet1',
      headerRow: 0,
      grid: [],
      idempotencyKey: `REQ-${marker}`,
    }
    const issued = await request(app)
      .post('/api/v1/statement-batches/authoritative-empty-receipts')
      .set('Authorization', `Bearer ${token}`)
      .send(empty)
    expect(issued.status, JSON.stringify(issued.body)).toBe(200)
    const receipt = issued.body.data.receipt as string
    const imported = await request(app)
      .post('/api/v1/statement-batches')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...empty, emptyReceipt: receipt })
    expect(imported.status, JSON.stringify(imported.body)).toBe(200)

    const row = db.prepare(`
      SELECT request_data FROM operation_logs
      WHERE operation='POST statement-batches'
      ORDER BY rowid DESC LIMIT 1
    `).get() as any
    const metadata = JSON.parse(row.request_data)
    expect(Object.keys(metadata).sort()).toEqual([
      'batchId',
      'duplicate',
      'generationId',
      'normalizedLineCount',
      'partnerId',
      'rawRowCount',
      'settlementMonth',
    ])
    expect(metadata.partnerId).toBe(canonicalPartnerId)
    expect(row.request_data).not.toContain(receipt)
    expect(row.request_data).not.toContain(marker)
    expect(row.request_data).not.toContain('emptyReceipt')
    expect(row.request_data).not.toContain('grid')
  })

  it('statement preview success audit persists only verified scalar metadata', async () => {
    const marker = `PREVIEW_RAW_MARKER_${Date.now()}`
    const canonicalPartnerId = `PT-PREVIEW-${Date.now()}`
    const empty = {
      partnerId: `  ${canonicalPartnerId}  `,
      settlementMonth: '2026-01',
      sourceFile: `${marker}.xlsx`,
      sourceHash: computeStatementSourceHash([]),
      templateFamily: 'category_summary',
      parserRevision: 'parser-phase1a-v1',
      configRevision: 'seed-phase1a-v1',
      sourceSheet: marker,
      headerRow: 0,
      grid: [],
      idempotencyKey: `REQ-${marker}`,
    }
    const issued = await request(app)
      .post('/api/v1/statement-batches/authoritative-empty-receipts')
      .set('Authorization', `Bearer ${token}`)
      .send(empty)
    expect(issued.status, JSON.stringify(issued.body)).toBe(200)
    const receipt = issued.body.data.receipt as string
    const before = {
      batches: (db.prepare('SELECT COUNT(*) n FROM statement_import_batches').get() as any).n,
      raw: (db.prepare('SELECT COUNT(*) n FROM statement_raw_rows').get() as any).n,
      normalized: (db.prepare('SELECT COUNT(*) n FROM statement_normalized_lines').get() as any).n,
    }
    const preview = await request(app)
      .post('/api/v1/statement-batches/preview-normalized')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...empty, emptyReceipt: receipt })
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect({
      batches: (db.prepare('SELECT COUNT(*) n FROM statement_import_batches').get() as any).n,
      raw: (db.prepare('SELECT COUNT(*) n FROM statement_raw_rows').get() as any).n,
      normalized: (db.prepare('SELECT COUNT(*) n FROM statement_normalized_lines').get() as any).n,
    }).toEqual(before)

    const row = db.prepare(`
      SELECT request_data FROM operation_logs
      WHERE operation='POST statement-batches'
        AND description LIKE '%/preview-normalized%'
      ORDER BY rowid DESC LIMIT 1
    `).get() as any
    const metadata = JSON.parse(row.request_data)
    expect(metadata).toEqual({
      partnerId: canonicalPartnerId,
      settlementMonth: '2026-01',
      templateFamily: 'category_summary',
      parserRevision: 'parser-phase1a-v1',
      configRevision: 'seed-phase1a-v1',
      rawRowCount: 0,
      normalizedLineCount: 0,
    })
    expect(row.request_data).not.toContain(marker)
    expect(row.request_data).not.toContain(receipt)
    expect(row.request_data).not.toContain('sourceFile')
    expect(row.request_data).not.toContain('sourceSheet')
    expect(row.request_data).not.toContain('emptyReceipt')
    expect(row.request_data).not.toContain('grid')
  })

  it('rejects object identities before receipt/import and never persists their sensitive marker', async () => {
    const marker = 'R2_AUDIT_SENSITIVE_MARKER'
    const before = {
      logs: countLogs(db),
      batches: (db.prepare('SELECT COUNT(*) n FROM statement_import_batches').get() as any).n,
      raw: (db.prepare('SELECT COUNT(*) n FROM statement_raw_rows').get() as any).n,
      normalized: (db.prepare('SELECT COUNT(*) n FROM statement_normalized_lines').get() as any).n,
    }
    const invalid = {
      partnerId: { password: marker },
      settlementMonth: '2026-01',
      sourceFile: 'invalid-object.xlsx',
      sourceHash: computeStatementSourceHash([]),
      templateFamily: 'category_summary',
      parserRevision: 'parser-phase1a-v1',
      configRevision: 'seed-phase1a-v1',
      sourceSheet: 'Sheet1',
      headerRow: 0,
      grid: [],
      idempotencyKey: 'REQ-invalid-object',
    }
    for (const path of [
      '/api/v1/statement-batches/authoritative-empty-receipts',
      '/api/v1/statement-batches',
    ]) {
      const response = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(path.endsWith('statement-batches') ? { ...invalid, emptyReceipt: 'forged.receipt' } : invalid)
      expect(response.status).toBe(400)
      expect(JSON.stringify(response.body)).not.toContain(marker)
    }
    expect({
      batches: (db.prepare('SELECT COUNT(*) n FROM statement_import_batches').get() as any).n,
      raw: (db.prepare('SELECT COUNT(*) n FROM statement_raw_rows').get() as any).n,
      normalized: (db.prepare('SELECT COUNT(*) n FROM statement_normalized_lines').get() as any).n,
    }).toEqual({ batches: before.batches, raw: before.raw, normalized: before.normalized })
    const newLogs = db.prepare(`
      SELECT request_data FROM operation_logs WHERE rowid > ?
      ORDER BY rowid
    `).all(before.logs) as any[]
    expect(newLogs).toHaveLength(2)
    for (const row of newLogs) {
      expect(String(row.request_data)).not.toContain(marker)
      expect(Object.keys(JSON.parse(row.request_data)).sort()).toEqual(['code', 'status'])
    }
  })

  it('defensively scrubs nested success-audit metadata supplied by another caller', async () => {
    const marker = `NESTED_AUDIT_SECRET_${Date.now()}`
    const probe = express()
    probe.use(express.json())
    probe.use((req: any, _res, next) => {
      req.user = { userId: 'U-AUDIT', username: 'audit-probe', role: 'admin', roles: ['admin'] }
      next()
    })
    probe.use(auditWrite)
    probe.post('/audit-metadata-probe', (_req, res) => {
      setSuccessAuditMetadata(res, {
        safe: 'visible',
        nested: { password: marker, apiToken: marker },
      })
      res.status(200).json({ success: true })
    })
    const response = await request(probe).post('/audit-metadata-probe').send({})
    expect(response.status).toBe(200)
    const row = db.prepare(`
      SELECT request_data FROM operation_logs
      WHERE operation='POST audit-metadata-probe'
      ORDER BY rowid DESC LIMIT 1
    `).get() as any
    expect(row.request_data).toContain('[REDACTED]')
    expect(row.request_data).not.toContain(marker)
  })

  it('读(GET /materials) → operation_logs 不新增', async () => {
    const before = countLogs(db)
    const res = await request(app)
      .get('/api/v1/materials')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(countLogs(db)).toBe(before)
  })

  it('被拒的写(PUT /materials/不存在 → 404) → 记一条 outcome=denied(other 类)，仅状态元数据、绝不落 body', async () => {
    const before = countLogs(db)
    const marker = `NOBODY_${Date.now()}`
    const res = await request(app)
      .put('/api/v1/materials/nonexistent-id-xyz')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: marker })
    expect(res.status).toBe(404)
    expect(countLogs(db)).toBe(before + 1) // 被拒写现在有痕（此前口径为不记）

    const row = db.prepare(`SELECT * FROM operation_logs WHERE outcome='denied' ORDER BY rowid DESC LIMIT 1`).get() as any
    expect(row, 'denied 行应出现').toBeTruthy()
    expect(row.username).toBe('admin')
    expect(String(row.request_data)).toContain('404')     // 状态元数据
    expect(String(row.request_data)).not.toContain(marker) // 绝不落 body
    // 钉死 request_data 精确 keyset：任何未来新增字段（如回显 message/details）都会让本断言变红（守 PII 红线）
    expect(Object.keys(JSON.parse(row.request_data)).sort()).toEqual(['code', 'status'])
    expect(String(row.operation)).toContain('DENIED')
    expect(String(row.operation)).toContain('materials')
  })

  it('未登录的写 → operation_logs 不新增（401 前置拦截，无 req.user）', async () => {
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
    const res = await request(legacyAbcApp)
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
    expect(ops.outcome == null, '成功行 outcome 应为 NULL').toBe(true)
  })
})

describe('审计中间件：P-3 拒绝写审计（集成——403 越权/聚合/告警）', () => {
  let adminToken: string
  let probeToken: string // 低权用户（pathologist），对多数写端点无权 → 403
  let db: any

  beforeAll(async () => {
    db = getDatabase()
    adminToken = await login('admin', 'admin123')
    probeToken = await login('yishi1', 'CoreOne2026!') // 病理医师：仅 inventory:R/bom:R/projects:W/alerts:R
    expect(adminToken && probeToken, '两个用户都应登录成功').toBeTruthy()
  })

  beforeEach(() => __resetDenialTrackerForTest())

  it('被拒的写(403 越权) → 记 denied 行含操作人+拒因，body 中的敏感字段绝不入库（安全红线）', async () => {
    const before = countLogs(db)
    const marker = `SECRET_${Date.now()}`
    const res = await request(app)
      .post('/api/v1/suppliers')
      .set('Authorization', `Bearer ${probeToken}`)
      .send({ name: 'x', password: marker, apiToken: marker })
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    // 单个 403 distinct=1 < 阈值 → 无告警，恰好 1 行
    expect(countLogs(db)).toBe(before + 1)

    const row = db.prepare(`SELECT * FROM operation_logs WHERE outcome='denied' ORDER BY rowid DESC LIMIT 1`).get() as any
    expect(row).toBeTruthy()
    expect(row.username).toBe('yishi1')
    expect(String(row.request_data)).toContain('403')
    expect(String(row.request_data)).toContain('FORBIDDEN')
    expect(String(row.request_data)).not.toContain(marker) // body 绝不入库
    expect(String(row.description)).not.toContain(marker)
    expect(Object.keys(JSON.parse(row.request_data)).sort()).toEqual(['code', 'status']) // 精确 keyset，守 PII 红线
    expect(String(row.operation)).toContain('DENIED')
    expect(String(row.operation)).toContain('suppliers')
  })

  it('成功写仍照记（回归）：admin 成功写 → outcome=NULL 行照常', async () => {
    const before = countLogs(db)
    const res = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `P3_OK_${Date.now()}`, level: 1 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(countLogs(db)).toBe(before + 1)
    const row = db.prepare(`SELECT * FROM operation_logs WHERE operation='POST categories' ORDER BY rowid DESC LIMIT 1`).get() as any
    expect(row.outcome == null).toBe(true)
  })

  it('同账号短时间对多个写端点被拒(403) → 落 security_alert 行 + 结构化告警信号', async () => {
    const before = countLogs(db)
    const endpoints = ['/api/v1/users', '/api/v1/roles', '/api/v1/suppliers', '/api/v1/purchase-orders', '/api/v1/locations']
    expect(endpoints.length).toBeGreaterThanOrEqual(DENIAL_ALERT_DISTINCT)
    for (const ep of endpoints) {
      const r = await request(app).post(ep).set('Authorization', `Bearer ${probeToken}`).send({ probe: 1 })
      expect(r.status, `${ep}: ${JSON.stringify(r.body)}`).toBe(403)
    }
    const alertRow = db.prepare(`SELECT * FROM operation_logs WHERE outcome='security_alert' ORDER BY rowid DESC LIMIT 1`).get() as any
    expect(alertRow, 'security_alert 行应出现').toBeTruthy()
    expect(alertRow.username).toBe('yishi1')
    const meta = JSON.parse(alertRow.request_data)
    expect(meta.alert).toBe('denied-write-burst')
    expect(meta.distinctEndpoints).toBeGreaterThanOrEqual(DENIAL_ALERT_DISTINCT)
    // 5 denied 行 + 1 security_alert 行
    expect(countLogs(db)).toBe(before + endpoints.length + 1)
  })

  it('同一主体每分钟同类被拒 > 阈值 → 逐条转一条 denied_agg 聚合计数行（防刷）', async () => {
    const before = countLogs(db)
    const n = DENIAL_AGG_THRESHOLD + 2
    for (let i = 0; i < n; i++) {
      const r = await request(app).put(`/api/v1/materials/nope-${i}`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'x' })
      expect(r.status).toBe(404) // 404 = other 类
    }
    const agg = db.prepare(`SELECT * FROM operation_logs WHERE outcome='denied_agg' ORDER BY rowid DESC LIMIT 1`).get() as any
    expect(agg, 'denied_agg 行应出现').toBeTruthy()
    const meta = JSON.parse(agg.request_data)
    expect(meta.aggregated).toBe(true)
    expect(meta.total).toBe(n) // 聚合行计数 = 本类本窗被拒总数
    expect(meta.suppressed).toBe(n - DENIAL_AGG_THRESHOLD) // 被抑制条数
    const deniedCount = (db.prepare(`SELECT COUNT(*) c FROM operation_logs WHERE outcome='denied'`).get() as any).c
    expect(deniedCount).toBeGreaterThanOrEqual(DENIAL_AGG_THRESHOLD) // 前 AGG 条仍逐条
    // 新增 = AGG 条逐条 denied + 1 条聚合行（其余被抑制）
    expect(countLogs(db)).toBe(before + DENIAL_AGG_THRESHOLD + 1)
  })

  it('被拒写 URL 带 query(token/email) → cleanPath 剥掉，description/request_data 均不含 query 值（防 URL 泄敏）', async () => {
    const secret = `URLTOKEN_${Date.now()}`
    const res = await request(app)
      .post(`/api/v1/suppliers?token=${secret}&email=a@b.com`)
      .set('Authorization', `Bearer ${probeToken}`)
      .send({ name: 'x' })
    expect(res.status).toBe(403)
    const row = db.prepare(`SELECT * FROM operation_logs WHERE outcome='denied' ORDER BY rowid DESC LIMIT 1`).get() as any
    expect(row).toBeTruthy()
    expect(String(row.description)).not.toContain(secret) // query 值被剥
    expect(String(row.description)).not.toContain('?') // 整个 query 段被剥
    expect(String(row.request_data)).not.toContain(secret)
    // 若 cleanPath 的 raw.split('?')[0] 被移除，SEKRET 会写进可查询的 operation_logs.description → 本用例变红
  })

  it('被拒写响应 error.message 回显了用户输入(抗体名) → denied 行只落标量 {status,code}，绝不含该输入（PII 泄漏红线）', async () => {
    const marker = `PII_${Date.now()}`
    const body = { name: marker, form: '浓缩', category: '一抗' } // form 非空 → 触发 UNIQUE(name,form) 冲突
    const first = await request(app).post('/api/v1/antibody-cost/antibodies').set('Authorization', `Bearer ${adminToken}`).send(body)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const dup = await request(app).post('/api/v1/antibody-cost/antibodies').set('Authorization', `Bearer ${adminToken}`).send(body)
    expect(dup.status, JSON.stringify(dup.body)).toBe(409)
    expect(String(dup.body?.error?.message)).toContain(marker) // 证明响应体 error.message 确实回显了输入

    const row = db.prepare(`SELECT * FROM operation_logs WHERE outcome='denied' ORDER BY rowid DESC LIMIT 1`).get() as any
    expect(row, 'denied 行应出现').toBeTruthy()
    expect(row.username).toBe('admin')
    // 红线：scalarCode 只读标量 error.code，绝不深入 error.message/details → 回显的 marker 不入库
    expect(String(row.request_data)).not.toContain(marker)
    expect(String(row.description)).not.toContain(marker)
    expect(JSON.parse(row.request_data)).toEqual({ status: 409, code: 'CONFLICT' })
  })

  it('5xx/3xx 写(服务器故障/重定向) → 不记（终态 c）——直驱中间件 finish 钩子确定性验证', () => {
    const drive = (status: number) => {
      const before = countLogs(db)
      const res: any = new EventEmitter()
      res.statusCode = status
      res.json = (b: any) => b
      const req: any = {
        method: 'POST',
        user: { userId: 'USER-001', username: 'admin' },
        body: { x: 1, password: 'nope' },
        params: {},
        ip: '',
        socket: {},
        originalUrl: '/api/v1/materials',
        baseUrl: '/api/v1/materials',
        path: '/',
        get: () => '',
      }
      auditWrite(req, res, () => {})
      res.emit('finish')
      expect(countLogs(db), `status ${status} 不应新增 operation_logs`).toBe(before)
    }
    drive(500) // 服务器故障非访问拒绝，归 errorHandler/监控
    drive(302) // 重定向非写结果
    // 若把守卫从 status>=400&&status<500 放宽成 status>=400，500 会落成 denied 行 → 本用例变红
  })
})
