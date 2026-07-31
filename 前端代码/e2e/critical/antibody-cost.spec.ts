import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiGet, apiLogin } from './fixtures'

const retiredResponse = {
  success: false,
  error: {
    code: 'FEATURE_RETIRED',
    message: '该产品能力已退役',
  },
}

function apiBaseUrl(): string {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

function authenticatedRequest(request: APIRequestContext, token: string) {
  return {
    get: (path: string) => request.get(`${apiBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    post: (path: string, data: Record<string, unknown>) => request.post(`${apiBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      data,
    }),
    put: (path: string, data: Record<string, unknown>) => request.put(`${apiBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      data,
    }),
  }
}

function businessState() {
  const databasePath = process.env.DATABASE_PATH
    || resolve(process.cwd(), '../后端代码/server/data/coreone.db')
  const database = new DatabaseSync(databasePath, { readOnly: true } as any)

  try {
    return {
      ihcCostParams: database.prepare(`
        SELECT param_key, value, source, confidence, remark
        FROM ihc_cost_params
        ORDER BY param_key
      `).all(),
      abcAuditCount: (
        database.prepare('SELECT COUNT(*) AS count FROM abc_audit_logs').get() as { count: number }
      ).count,
    }
  } finally {
    database.close()
  }
}

test.describe('critical antibody cost contract', () => {
  test('keeps authentication ahead of the retired full-cost surface', async ({ request }) => {
    const unauthenticatedResponses = [
      {
        path: '/antibody-cost/cost-preview?perTestPrice=10',
        response: await request.get(`${apiBaseUrl()}/antibody-cost/cost-preview?perTestPrice=10`),
      },
      {
        path: '/antibody-cost/cost-params',
        response: await request.get(`${apiBaseUrl()}/antibody-cost/cost-params`),
      },
      {
        path: '/antibody-cost/cost-params/labor_per_slide',
        response: await request.put(`${apiBaseUrl()}/antibody-cost/cost-params/labor_per_slide`, {
          data: { value: 9876 },
        }),
      },
      {
        path: '/antibody-cost/cost-params/calibrate',
        response: await request.post(`${apiBaseUrl()}/antibody-cost/cost-params/calibrate`, {
          data: {
            monthlyTechnicianCost: 120000,
            monthlyEquipmentDepreciation: 30000,
            monthlySlideVolume: 5000,
          },
        }),
      },
    ]

    for (const { path, response } of unauthenticatedResponses) {
      expect(response.status(), path).toBe(401)
    }
  })

  test('returns the explicit, data-free retirement contract after authentication', async ({ request }) => {
    const token = await apiLogin(request, 'admin')
    const client = authenticatedRequest(request, token)

    for (const path of [
      '/antibody-cost/cost-preview?perTestPrice=10',
      '/antibody-cost/cost-params',
    ]) {
      const response = await client.get(path)
      expect(response.status(), path).toBe(410)
      expect(await response.json(), path).toEqual(retiredResponse)
    }
  })

  test('rejects retired parameter writes without changing business state', async ({ request }) => {
    const token = await apiLogin(request, 'admin')
    const client = authenticatedRequest(request, token)
    const before = businessState()

    const responses = [
      await client.put('/antibody-cost/cost-params/labor_per_slide', {
        value: 9876,
        source: 'E2E retirement mutation probe',
      }),
      await client.post('/antibody-cost/cost-params/calibrate', {
        monthlyTechnicianCost: 120000,
        monthlyEquipmentDepreciation: 30000,
        monthlyFacilityCost: 10000,
        monthlySlideVolume: 5000,
      }),
    ]

    for (const response of responses) {
      expect.soft(response.status()).toBe(410)
      expect.soft(await response.json()).toEqual(retiredResponse)
    }
    expect(businessState()).toEqual(before)
  })

  test('keeps material ledger compatibility APIs available', async ({ request }) => {
    const token = await apiLogin(request, 'admin')

    for (const path of [
      '/antibody-cost/antibodies?pageSize=1',
      '/antibody-cost/antibodies/resolve?name=2SC',
      '/antibody-cost/detection-systems',
      '/antibody-cost/antibody-aliases',
    ]) {
      const response = await apiGet(request, token, path)
      expect(response.status(), path).toBe(200)
      expect((await response.json())?.success, path).toBe(true)
    }
  })
})
