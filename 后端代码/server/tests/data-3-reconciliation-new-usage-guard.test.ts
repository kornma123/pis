/**
 * DATA-3 / #137: reconciliation BOM-fix proposals must reject coercive or
 * non-finite newUsage values before they create a business log. Approval also
 * fails closed for a legacy malformed pending proposal.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let auditedApp: any
let db: any
let adminToken: string
let financeToken: string
let resetDenialTracker: () => void

const MATERIAL_ID = 'MAT-DATA3-RECON'
const BOM_ID = 'BOM-DATA3-RECON'
const BOM_ITEM_ID = 'BI-DATA3-RECON'
const PROJECT_ID = 'PRJ-DATA3-RECON'
const RAW_1E400 = '__RAW_1E400__'

async function login(username: string, password: string): Promise<string> {
  const request = (await import('supertest')).default
  const response = await request(app).post('/api/v1/auth/login').send({ username, password })
  if (!response.body?.data?.token) throw new Error(`login failed: ${JSON.stringify(response.body)}`)
  return response.body.data.token
}

function proposalPayload(newUsage: unknown): Record<string, unknown> {
  return {
    type: 'bom_fix',
    targetId: MATERIAL_ID,
    targetName: 'DATA-3 物料',
    field: 'usage_per_sample',
    oldValue: '2',
    newValue: String(newUsage),
    reason: 'DATA-3 数值护栏回归',
    projectId: PROJECT_ID,
    materialId: MATERIAL_ID,
    newUsage,
  }
}

async function postProposal(newUsage: unknown) {
  const request = (await import('supertest')).default
  return request(app)
    .post('/api/v1/reconciliation/logs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(proposalPayload(newUsage))
}

async function postRawOverflowProposal() {
  const request = (await import('supertest')).default
  const rawBody = JSON.stringify(proposalPayload(RAW_1E400))
    .replace(`"newUsage":${JSON.stringify(RAW_1E400)}`, '"newUsage":1e400')
  return request(app)
    .post('/api/v1/reconciliation/logs')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Content-Type', 'application/json')
    .send(rawBody)
}

function businessState() {
  const item = db.prepare('SELECT usage_per_sample FROM bom_items WHERE id = ?').get(BOM_ITEM_ID) as any
  const bom = db.prepare('SELECT version FROM boms WHERE id = ?').get(BOM_ID) as any
  return {
    reconciliationLogs: Number((db.prepare('SELECT COUNT(*) AS count FROM reconciliation_logs').get() as any).count),
    usagePerSample: Number(item.usage_per_sample),
    bomVersion: bom.version,
    bomVersions: Number((db.prepare('SELECT COUNT(*) AS count FROM bom_versions WHERE bom_id = ?').get(BOM_ID) as any).count),
    costRuns: Number((db.prepare('SELECT COUNT(*) AS count FROM cost_runs').get() as any).count),
  }
}

async function recordExec<T>(action: () => Promise<T>): Promise<{ result: T; execCalls: string[] }> {
  const execSpy = vi.spyOn(db, 'exec')
  try {
    const result = await action()
    return { result, execCalls: execSpy.mock.calls.map(([sql]: any[]) => String(sql)) }
  } finally {
    execSpy.mockRestore()
  }
}

function expectRejectedWithoutBusinessMutation(
  response: any,
  before: ReturnType<typeof businessState>,
  execCalls: string[],
) {
  expect(response.status).toBe(400)
  expect(response.body?.error?.code).toBe('INVALID_PARAMETER')
  expect(businessState()).toEqual(before)
  expect(execCalls.some(sql => /\bBEGIN\s+IMMEDIATE\b/i.test(sql))).toBe(false)
  expect(db.isTransaction).toBe(false)
}

beforeAll(async () => {
  db = await getDb()
  const reconciliationRoutes = (await import('../src/routes/reconciliation-v1.1.js')).default
  const authRoutes = (await import('../src/routes/auth.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const express = (await import('express')).default
  const { auditWrite, __resetDenialTrackerForTest } = await import('../src/middleware/audit-log.js')
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/reconciliation', router: reconciliationRoutes, middleware: [authenticateToken] },
  ])
  auditedApp = express()
  auditedApp.use(express.json())
  auditedApp.use(auditWrite)
  auditedApp.use('/api/v1/reconciliation', authenticateToken, reconciliationRoutes)
  resetDenialTracker = __resetDenialTrackerForTest
  adminToken = await loginAdmin(app)
  financeToken = await login('caiwu', 'CoreOne2026!')

  db.prepare(`INSERT INTO materials (id, code, name, unit, category_id, price, status, is_deleted)
    VALUES (?, 'MAT-DATA3', 'DATA-3 物料', 'ml', 'CAT-A', 10, 1, 0)`).run(MATERIAL_ID)
  db.prepare(`INSERT INTO boms (id, code, name, version, type, status, is_deleted)
    VALUES (?, 'BOM-DATA3', 'DATA-3 BOM', 'v1.0', 'ihc', 1, 0)`).run(BOM_ID)
  db.prepare(`INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit)
    VALUES (?, ?, ?, 2, 'ml')`).run(BOM_ITEM_ID, BOM_ID, MATERIAL_ID)
  db.prepare(`INSERT INTO projects (id, code, name, type, bom_id, status, is_deleted)
    VALUES (?, 'PRJ-DATA3', 'DATA-3 项目', 'ihc', ?, 1, 0)`).run(PROJECT_ID, BOM_ID)
})

describe('DATA-3 reconciliation newUsage finite guard', () => {
  it.each([
    ['null', null],
    ['boolean false', false],
    ['boolean true', true],
    ['blank string', '   '],
    ['array', []],
    ['object', {}],
    ['Infinity string', 'Infinity'],
    ['NaN string', 'NaN'],
    ['negative number', -0.01],
  ])('rejects %s before creating a proposal', async (_label, value) => {
    const before = businessState()
    const { result: response, execCalls } = await recordExec(() => postProposal(value))
    expectRejectedWithoutBusinessMutation(response, before, execCalls)
  })

  it('rejects raw JSON 1e400 before creating a proposal', async () => {
    const before = businessState()
    const { result: response, execCalls } = await recordExec(postRawOverflowProposal)
    expectRejectedWithoutBusinessMutation(response, before, execCalls)
  })

  it.each([
    ['missing newUsage', { projectId: PROJECT_ID, materialId: MATERIAL_ID }],
    ['missing projectId', { materialId: MATERIAL_ID, newUsage: 3 }],
    ['missing materialId', { projectId: PROJECT_ID, newUsage: 3 }],
  ])('rejects an incomplete BOM-fix proposal instead of downgrading it to an applied note: %s', async (_label, fields) => {
    const request = (await import('supertest')).default
    const before = businessState()
    const { result: response, execCalls } = await recordExec(() => request(app)
        .post('/api/v1/reconciliation/logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'bom_fix',
          targetId: MATERIAL_ID,
          targetName: 'DATA-3 物料',
          field: 'usage_per_sample',
          reason: '不完整提案不得降级',
          ...fields,
        }))
    expectRejectedWithoutBusinessMutation(response, before, execCalls)
  })

  it.each([
    ['projectId', { projectId: PROJECT_ID }],
    ['materialId', { materialId: MATERIAL_ID }],
    ['newUsage', { newUsage: 3 }],
    ['usage field', { field: 'usage_per_sample' }],
  ])('keeps a generic note backward-compatible when it only carries %s', async (_label, extra) => {
    const request = (await import('supertest')).default
    const response = await request(app)
      .post('/api/v1/reconciliation/logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'note',
        targetId: MATERIAL_ID,
        reason: '普通审计备注',
        ...extra,
      })
    expect(response.status).toBe(200)
    expect(response.body?.data?.status).toBe('applied')
    const row = db.prepare('SELECT type, status FROM reconciliation_logs WHERE id = ?').get(response.body.data.id) as any
    expect(row).toEqual({ type: 'note', status: 'applied' })
  })

  it.each([
    ['number zero', 0, 0],
    ['trimmed numeric string', ' 3.5 ', 3.5],
  ])('preserves the existing pending-proposal contract for %s', async (_label, value, expected) => {
    const response = await postProposal(value)
    expect(response.status).toBe(200)
    expect(response.body?.data?.status).toBe('pending')
    const row = db.prepare('SELECT * FROM reconciliation_logs WHERE id = ?').get(response.body.data.id) as any
    expect(row.type).toBe('bom_fix_proposal')
    expect(row.status).toBe('pending')
    expect(Number(row.proposed_usage)).toBe(expected)
    expect(row.new_value).toBe(String(expected))
    expect(Number((db.prepare('SELECT usage_per_sample FROM bom_items WHERE id = ?').get(BOM_ITEM_ID) as any).usage_per_sample)).toBe(2)
    expect(db.isTransaction).toBe(false)
  })

  it('fails closed before transaction when a legacy pending proposal contains non-finite proposed_usage', async () => {
    const logId = 'LOG-DATA3-LEGACY-INF'
    db.prepare(`INSERT INTO reconciliation_logs
      (id, type, target_id, target_name, field, old_value, new_value, reason, operator,
       status, material_id, project_id, applied_bom_id, proposed_usage)
      VALUES (?, 'bom_fix_proposal', ?, 'DATA-3 物料', 'usage_per_sample', '2', 'Infinity',
              '历史坏提案', 'admin', 'pending', ?, ?, ?, ?)`)
      .run(logId, MATERIAL_ID, MATERIAL_ID, PROJECT_ID, BOM_ID, Infinity)

    const request = (await import('supertest')).default
    const before = businessState()
    const { result: response, execCalls } = await recordExec(() => request(app)
        .post(`/api/v1/reconciliation/logs/${logId}/approve`)
        .set('Authorization', `Bearer ${financeToken}`)
        .send({ effectiveScope: 'retroactive' }))

    expectRejectedWithoutBusinessMutation(response, before, execCalls)
    const log = db.prepare('SELECT status, reviewed_by, proposed_usage FROM reconciliation_logs WHERE id = ?').get(logId) as any
    expect(log.status).toBe('pending')
    expect(log.reviewed_by).toBeNull()
    expect(Number.isFinite(Number(log.proposed_usage))).toBe(false)
  })

  it('keeps only a scrubbed denied audit when production auditWrite observes an invalid proposal', async () => {
    resetDenialTracker()
    const request = (await import('supertest')).default
    const marker = `DATA3_CANARY_${Date.now()}`
    const before = businessState()
    const operationLogCount = Number((db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get() as any).count)
    const { result: response, execCalls } = await recordExec(() => request(auditedApp)
        .post('/api/v1/reconciliation/logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...proposalPayload(false), reason: marker }))

    expectRejectedWithoutBusinessMutation(response, before, execCalls)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get() as any).count)).toBe(operationLogCount + 1)
    const audit = db.prepare("SELECT * FROM operation_logs WHERE outcome = 'denied' ORDER BY rowid DESC LIMIT 1").get() as any
    expect(audit.username).toBe('admin')
    expect(String(audit.operation)).toContain('DENIED POST reconciliation')
    expect(Object.keys(JSON.parse(audit.request_data)).sort()).toEqual(['code', 'status'])
    expect(String(audit.request_data)).not.toContain(marker)
    expect(String(audit.description)).not.toContain(marker)
  })
})
