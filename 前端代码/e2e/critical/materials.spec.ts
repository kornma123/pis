import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiLogin } from './fixtures'

interface ErrorEnvelope {
  success: boolean
  error: {
    code: string
  }
}

type CreatedFixture = {
  categoryId: string
  materialId: string
}

function apiBaseUrl(): string {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

function suffix(): string {
  return randomUUID().replaceAll('-', '')
}

async function expectCreatedId(
  response: Awaited<ReturnType<APIRequestContext['post']>>,
  label: string,
): Promise<string> {
  expect(response.status(), `${label} must return 201`).toBe(201)
  const body = await response.json() as { success: boolean, data?: { id?: unknown } }
  expect(body.success).toBe(true)
  expect(body.data?.id).toEqual(expect.any(String))
  return body.data!.id as string
}

async function createMaterialFixture(
  request: APIRequestContext,
  token: string,
  label: string,
): Promise<CreatedFixture> {
  const idSuffix = suffix()
  const category = await request.post(`${apiBaseUrl()}/categories`, {
    headers: authorization(token),
    data: {
      code: `E2EMD${idSuffix.slice(0, 12)}`,
      name: `E2E material-delete category ${label} ${idSuffix}`,
      level: 1,
    },
  })
  const categoryId = await expectCreatedId(category, 'create category')

  const material = await request.post(`${apiBaseUrl()}/materials`, {
    headers: authorization(token),
    data: {
      code: `E2E-MD-${idSuffix}`,
      name: `E2E material-delete ${label} ${idSuffix}`,
      unit: 'box',
      categoryId,
      price: 1,
    },
  })
  const materialId = await expectCreatedId(material, 'create material')
  return { categoryId, materialId }
}

async function materialStatus(
  request: APIRequestContext,
  token: string,
  materialId: string,
): Promise<number> {
  const response = await request.get(`${apiBaseUrl()}/materials/${materialId}`, {
    headers: authorization(token),
  })
  return response.status()
}

async function cleanupFixture(
  request: APIRequestContext,
  adminToken: string,
  fixture: CreatedFixture | undefined,
): Promise<void> {
  if (!fixture) return
  if (await materialStatus(request, adminToken, fixture.materialId) === 200) {
    const deleted = await request.delete(`${apiBaseUrl()}/materials/${fixture.materialId}`, {
      headers: authorization(adminToken),
    })
    expect(deleted.status(), 'cleanup must delete the material').toBe(200)
  }
  const category = await request.delete(`${apiBaseUrl()}/categories/${fixture.categoryId}`, {
    headers: authorization(adminToken),
  })
  expect([200, 404], 'cleanup must delete or already have deleted the category')
    .toContain(category.status())
}

test.describe('critical material delete guards', () => {
  test('canonical zero material deletes and is no longer readable', async ({ request }) => {
    const adminToken = await apiLogin(request, 'admin')
    let fixture: CreatedFixture | undefined
    try {
      fixture = await createMaterialFixture(request, adminToken, 'zero')
      const deleted = await request.delete(`${apiBaseUrl()}/materials/${fixture.materialId}`, {
        headers: authorization(adminToken),
      })
      expect(deleted.status()).toBe(200)
      expect(await materialStatus(request, adminToken, fixture.materialId)).toBe(404)
    } finally {
      await cleanupFixture(request, adminToken, fixture)
    }
  })

  test('pending purchase order returns ENTITY_IN_USE with zero material delete', async ({ request }) => {
    const adminToken = await apiLogin(request, 'admin')
    let fixture: CreatedFixture | undefined
    let purchaseOrderId: string | undefined
    try {
      fixture = await createMaterialFixture(request, adminToken, 'purchase')
      const createdOrder = await request.post(`${apiBaseUrl()}/purchase-orders`, {
        headers: authorization(adminToken),
        data: {
          materialId: fixture.materialId,
          materialName: 'E2E live-reference material',
          orderedQty: 1,
          unit: 'box',
          unitPrice: 1,
        },
      })
      expect(createdOrder.status()).toBe(200)
      const orderBody = await createdOrder.json() as { data?: { id?: unknown } }
      expect(orderBody.data?.id).toEqual(expect.any(String))
      purchaseOrderId = orderBody.data!.id as string

      const denied = await request.delete(`${apiBaseUrl()}/materials/${fixture.materialId}`, {
        headers: authorization(adminToken),
      })
      expect(denied.status()).toBe(409)
      expect(await denied.json() as ErrorEnvelope).toMatchObject({
        success: false,
        error: { code: 'ENTITY_IN_USE' },
      })
      expect(await materialStatus(request, adminToken, fixture.materialId)).toBe(200)

      const completed = await request.put(
        `${apiBaseUrl()}/purchase-orders/${purchaseOrderId}/receive`,
        {
          headers: authorization(adminToken),
          data: { quantity: 1 },
        },
      )
      expect(completed.status()).toBe(200)
      purchaseOrderId = undefined
    } finally {
      if (purchaseOrderId) {
        const completed = await request.put(
          `${apiBaseUrl()}/purchase-orders/${purchaseOrderId}/receive`,
          {
            headers: authorization(adminToken),
            data: { quantity: 1 },
          },
        )
        expect(completed.status()).toBe(200)
      }
      await cleanupFixture(request, adminToken, fixture)
    }
  })

  test('positive batch inventory returns CONFLICT and survives the denied delete', async ({ request }) => {
    const adminToken = await apiLogin(request, 'admin')
    let fixture: CreatedFixture | undefined
    let inboundId: string | undefined
    let locationId: string | undefined
    try {
      fixture = await createMaterialFixture(request, adminToken, 'inventory')
      const idSuffix = suffix()
      const location = await request.post(`${apiBaseUrl()}/locations`, {
        headers: authorization(adminToken),
        data: {
          name: `E2E material-delete location ${idSuffix}`,
          zone: 'critical',
          capacity: 100,
        },
      })
      locationId = await expectCreatedId(location, 'create location')

      const inbound = await request.post(`${apiBaseUrl()}/inbound`, {
        headers: {
          ...authorization(adminToken),
          'Idempotency-Key': `e2e-material-delete-inbound-${idSuffix}`,
        },
        data: {
          type: 'direct',
          materialId: fixture.materialId,
          batchNo: `E2E-MD-BATCH-${idSuffix}`,
          quantity: 1,
          unit: 'box',
          price: 1,
          locationId,
          operator: 'critical-e2e',
        },
      })
      inboundId = await expectCreatedId(inbound, 'create inbound')

      const denied = await request.delete(`${apiBaseUrl()}/materials/${fixture.materialId}`, {
        headers: authorization(adminToken),
      })
      expect(denied.status()).toBe(409)
      expect(await denied.json() as ErrorEnvelope).toMatchObject({
        success: false,
        error: { code: 'CONFLICT' },
      })
      expect(await materialStatus(request, adminToken, fixture.materialId)).toBe(200)

      const removedInbound = await request.delete(`${apiBaseUrl()}/inbound/${inboundId}`, {
        headers: authorization(adminToken),
      })
      expect(removedInbound.status()).toBe(200)
      inboundId = undefined
    } finally {
      if (inboundId) {
        const removedInbound = await request.delete(`${apiBaseUrl()}/inbound/${inboundId}`, {
          headers: authorization(adminToken),
        })
        expect(removedInbound.status()).toBe(200)
      }
      await cleanupFixture(request, adminToken, fixture)
      if (locationId) {
        const location = await request.delete(`${apiBaseUrl()}/locations/${locationId}`, {
          headers: authorization(adminToken),
        })
        expect([200, 404]).toContain(location.status())
      }
    }
  })

  test('technician delete remains 403 and the material remains readable', async ({ request }) => {
    const adminToken = await apiLogin(request, 'admin')
    const technicianToken = await apiLogin(request, 'technician')
    let fixture: CreatedFixture | undefined
    try {
      fixture = await createMaterialFixture(request, adminToken, 'permission')
      const denied = await request.delete(`${apiBaseUrl()}/materials/${fixture.materialId}`, {
        headers: authorization(technicianToken),
      })
      expect(denied.status()).toBe(403)
      expect(await denied.json() as ErrorEnvelope).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN' },
      })
      expect(await materialStatus(request, adminToken, fixture.materialId)).toBe(200)
    } finally {
      await cleanupFixture(request, adminToken, fixture)
    }
  })
})
