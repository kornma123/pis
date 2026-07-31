import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../src/app.js'
import { getDatabase } from '../src/database/DatabaseManager.js'

const retiredReads = [
  '/api/v1/auth/cost-visibility',
  '/api/v1/equipment',
  '/api/v1/equipment-types',
  '/api/v1/labor-times',
  '/api/v1/indirect-costs',
  '/api/v1/abc/dashboard',
  '/api/v1/cost-adjustments',
  '/api/v1/partner-pnl',
  '/api/v1/antibody-cost/cost-preview?perTestPrice=10',
  '/api/v1/antibody-cost/cost-params',
  '/api/v1/antibody-cost/special-stains',
]

const retiredWrites: Array<{ method: 'post' | 'put'; path: string; body?: Record<string, unknown> }> = [
  { method: 'put', path: '/api/v1/auth/cost-visibility' },
  { method: 'post', path: '/api/v1/equipment' },
  { method: 'post', path: '/api/v1/equipment-types' },
  { method: 'post', path: '/api/v1/labor-times' },
  { method: 'post', path: '/api/v1/indirect-costs' },
  { method: 'post', path: '/api/v1/abc/periods' },
  { method: 'post', path: '/api/v1/cost-adjustments' },
  { method: 'post', path: '/api/v1/partner-pnl/backfill-abc-partner' },
  {
    method: 'put',
    path: '/api/v1/antibody-cost/cost-params/labor_per_slide',
    body: { value: 9876, source: 'R2 retirement mutation probe' },
  },
  {
    method: 'post',
    path: '/api/v1/antibody-cost/cost-params/calibrate',
    body: {
      monthlyTechnicianCost: 120000,
      monthlyEquipmentDepreciation: 30000,
      monthlyFacilityCost: 10000,
      monthlySlideVolume: 5000,
    },
  },
]

const businessTables = [
  'equipment',
  'equipment_types',
  'standard_labor_times',
  'indirect_cost_centers',
  'abc_periods',
  'cost_adjustments',
  'outbound_abc_details',
]

const businessState = () => {
  const db = getDatabase()
  return {
    tableCounts: Object.fromEntries(
      businessTables.map((table) => [
        table,
        (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      ]),
    ),
    costVisibilityRoles: (
      db.prepare("SELECT value FROM app_settings WHERE key = 'cost_visibility_roles'").get() as
        | { value: string }
        | undefined
    )?.value,
    ihcCostParams: db.prepare(`
      SELECT param_key, value, source, confidence, remark
      FROM ihc_cost_params
      ORDER BY param_key
    `).all(),
    abcAuditCount: (db.prepare('SELECT COUNT(*) AS count FROM abc_audit_logs').get() as { count: number }).count,
  }
}

describe('ABC-RETIRE-001 legacy API retirement boundary', () => {
  let token: string

  beforeAll(async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })
    token = login.body?.data?.token
    expect(token).toEqual(expect.any(String))
  })

  it.each(retiredReads)('keeps authentication ahead of the retired response: %s', async (path) => {
    const response = await request(app).get(path)
    expect(response.status).toBe(401)
  })

  it.each(retiredReads)('returns one explicit, data-free retirement contract: %s', async (path) => {
    const response = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(410)
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'FEATURE_RETIRED',
        message: '该产品能力已退役',
      },
    })
  })

  it('rejects every legacy write before business mutation and records the denial without its body', async () => {
    const db = getDatabase()
    const before = businessState()
    const marker = `RETIRED_WRITE_BODY_${Date.now()}`

    for (const { method, path, body } of retiredWrites) {
      const pending = method === 'put' ? request(app).put(path) : request(app).post(path)
      const response = await pending
        .set('Authorization', `Bearer ${token}`)
        .send({ name: marker, password: marker, ...body })
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(410)
      expect(response.body?.error?.code).toBe('FEATURE_RETIRED')
    }

    expect(businessState()).toEqual(before)

    const rows = db.prepare(`
      SELECT description, request_data
      FROM operation_logs
      WHERE outcome = 'denied' AND request_data LIKE '%FEATURE_RETIRED%'
      ORDER BY rowid DESC
      LIMIT ?
    `).all(retiredWrites.length) as Array<{ description: string; request_data: string }>
    expect(rows).toHaveLength(retiredWrites.length)
    for (const row of rows) {
      expect(row.request_data).not.toContain(marker)
      expect(JSON.parse(row.request_data)).toEqual({ status: 410, code: 'FEATURE_RETIRED' })
    }
  })

  it('does not retire current material contribution-margin or inventory/BOM APIs', async () => {
    for (const path of [
      '/api/v1/hospital-pnl/readiness',
      '/api/v1/inventory',
      '/api/v1/boms',
      '/api/v1/antibody-cost/antibodies?pageSize=1',
      '/api/v1/antibody-cost/antibodies/resolve?name=2SC',
      '/api/v1/antibody-cost/detection-systems',
      '/api/v1/antibody-cost/antibody-aliases',
    ]) {
      const response = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${token}`)
      expect(response.status, path).not.toBe(410)
      expect(response.body?.error?.code, path).not.toBe('FEATURE_RETIRED')
    }
  })
})
