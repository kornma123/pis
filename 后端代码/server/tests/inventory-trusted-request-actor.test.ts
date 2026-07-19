/**
 * P0 inventory actor trust boundary.
 *
 * Inventory write families, including transfers, must persist only the
 * authenticated server identity. Actor-shaped request input is inert,
 * including for idempotency.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

type RequestUser = {
  userId: unknown
  username: unknown
  role: unknown
  roles: unknown
}

let app: any
let isolatedApp: any
let db: any
let adminToken = ''
let trustedActor: { userId: string; username: string }
let injectedUser: RequestUser | undefined
let sequence = 0

const FORGED_A = 'forged-actor-a'
const FORGED_B = 'forged-actor-b'

const injectRequestUser = (req: any, _res: any, next: any) => {
  if (injectedUser !== undefined) req.user = injectedUser
  next()
}

function nextId(label: string): string {
  sequence += 1
  return `ACTOR-${label}-${sequence}`
}

function seedMaterial(label: string, quantity = 0) {
  const materialId = nextId(`MAT-${label}`)
  const locationId = nextId(`LOC-${label}`)
  db.prepare(`
    INSERT INTO locations (id, code, name, type, zone, status)
    VALUES (?, ?, ?, 'shelf', 'ACTOR-TEST', 1)
  `).run(locationId, locationId, locationId)
  db.prepare(`
    INSERT INTO materials (id, code, name, unit, category_id, price, location_id, status, is_deleted)
    VALUES (?, ?, ?, 'unit', 'CAT', 10, ?, 1, 0)
  `).run(materialId, materialId, materialId, locationId)

  let batchId: string | null = null
  if (quantity > 0) {
    batchId = nextId(`BATCH-${label}`)
    db.prepare(`
      INSERT INTO batches
        (id, material_id, batch_no, quantity, remaining, expiry_date, inbound_id, inbound_price, status)
      VALUES (?, ?, ?, ?, ?, '2027-01-01', ?, 10, 1)
    `).run(batchId, materialId, nextId(`BATCH-NO-${label}`), quantity, quantity, nextId(`SOURCE-${label}`))
  }
  db.prepare('INSERT INTO inventory (id, material_id, stock, location_id) VALUES (?, ?, ?, ?)')
    .run(nextId(`INV-${label}`), materialId, quantity, locationId)
  return { materialId, locationId, batchId }
}

function seedTransfer(label: string, quantity = 10) {
  const fixture = seedMaterial(label, quantity)
  const toLocationId = nextId(`LOC-TO-${label}`)
  db.prepare(`
    INSERT INTO locations (id, code, name, type, zone, status)
    VALUES (?, ?, ?, 'shelf', 'ACTOR-TEST', 1)
  `).run(toLocationId, toLocationId, toLocationId)
  return { ...fixture, fromLocationId: fixture.locationId, toLocationId }
}

function withForgedActor(test: any, forged: string, idempotencyKey?: string) {
  test
    .query({ operator: `${forged}-query`, actor: `${forged}-query` })
    .set('X-Operator', `${forged}-header`)
    .set('X-Actor', `${forged}-header`)
    .set('X-User-Id', `${forged}-header`)
    .set('X-Created-By', `${forged}-header`)
    .set('X-Updated-By', `${forged}-header`)
    .set('X-Approved-By', `${forged}-header`)
  if (idempotencyKey) test.set('Idempotency-Key', idempotencyKey)
  return test
}

function forgedBody(body: Record<string, unknown>, forged: string): Record<string, unknown> {
  return {
    ...body,
    operator: `${forged}-body`,
    actor: `${forged}-body`,
    createdBy: `${forged}-body`,
    updatedBy: `${forged}-body`,
    approvedBy: `${forged}-body`,
    auditActor: `${forged}-body`,
    userId: `${forged}-body`,
    username: `${forged}-body`,
  }
}

function postAsAdmin(path: string, key: string, body: Record<string, unknown>, forged: string) {
  return withForgedActor(
    request(app).post(path).set('Authorization', `Bearer ${adminToken}`),
    forged,
    key,
  ).send(forgedBody(body, forged))
}

function maxAuditRowid(): number {
  return Number((db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM operation_logs').get() as any).value)
}

function expectNewAuditActors(afterRowid: number): void {
  const rows = db.prepare(`
    SELECT user_id, username FROM operation_logs WHERE rowid > ? ORDER BY rowid
  `).all(afterRowid) as any[]
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every((row) => row.user_id === trustedActor.userId && row.username === trustedActor.username)).toBe(true)
}

function expectStoredOperator(table: string, id: string): void {
  expect(db.prepare(`SELECT operator FROM ${table} WHERE id = ?`).get(id))
    .toMatchObject({ operator: trustedActor.username })
}

function expectStockLogOperators(relatedId: string): void {
  const rows = db.prepare('SELECT operator FROM stock_logs WHERE related_id = ? ORDER BY rowid').all(relatedId) as any[]
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every((row) => row.operator === trustedActor.username)).toBe(true)
}

function expectIdempotencyActor(key: string): void {
  expect(db.prepare('SELECT operator FROM idempotency_keys WHERE idempotency_key = ?').get(key))
    .toMatchObject({ operator: trustedActor.username })
}

const MUTATION_TABLES = [
  'inbound_records',
  'outbound_records',
  'outbound_items',
  'return_records',
  'scrap_records',
  'stocktaking_records',
  'supplier_returns',
  'stock_logs',
  'idempotency_keys',
  'batch_usage_tracking',
  'batches',
  'inventory',
] as const

function mutationSnapshot(): Record<string, unknown[]> {
  return Object.fromEntries(MUTATION_TABLES.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]))
}

beforeAll(async () => {
  db = await getDb()
  app = (await import('../src/app.js')).default
  adminToken = await loginAdmin(app)
  const admin = db.prepare('SELECT id, username FROM users WHERE username = ?').get('admin') as any
  trustedActor = { userId: String(admin.id), username: String(admin.username) }

  const [inbound, outbound, returns, scraps, stocktaking, supplierReturns, transfers] = await Promise.all([
    import('../src/routes/inbound-v1.1.js'),
    import('../src/routes/outbound-v1.1.js'),
    import('../src/routes/returns-v1.1.js'),
    import('../src/routes/scraps-v1.1.js'),
    import('../src/routes/stocktaking-v1.1.js'),
    import('../src/routes/supplier-returns-v1.1.js'),
    import('../src/routes/transfers-v1.1.js'),
  ])
  isolatedApp = await buildTestApp([
    { path: '/api/v1/inbound', router: inbound.default, middleware: [injectRequestUser] },
    { path: '/api/v1/outbound', router: outbound.default, middleware: [injectRequestUser] },
    { path: '/api/v1/returns', router: returns.default, middleware: [injectRequestUser] },
    { path: '/api/v1/scraps', router: scraps.default, middleware: [injectRequestUser] },
    { path: '/api/v1/stocktaking', router: stocktaking.default, middleware: [injectRequestUser] },
    { path: '/api/v1/supplier-returns', router: supplierReturns.default, middleware: [injectRequestUser] },
    { path: '/api/v1/transfers', router: transfers.default, middleware: [injectRequestUser] },
  ])
})

beforeEach(() => {
  injectedUser = {
    userId: trustedActor.userId,
    username: trustedActor.username,
    role: 'admin',
    roles: ['admin'],
  }
})

describe('trusted inventory actors', () => {
  it('persists the authenticated actor for inbound and replays when only forged actor input changes', async () => {
    const fixture = seedMaterial('INBOUND')
    const key = nextId('IDEM-INBOUND')
    const body = { type: 'direct', materialId: fixture.materialId, quantity: 5, locationId: fixture.locationId }
    const auditStart = maxAuditRowid()

    const first = await postAsAdmin('/api/v1/inbound', key, body, FORGED_A)
    const replay = await postAsAdmin('/api/v1/inbound', key, body, FORGED_B)

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expectStoredOperator('inbound_records', first.body.data.id)
    expectStockLogOperators(first.body.data.id)
    expectIdempotencyActor(key)
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM inbound_records WHERE id = ?').get(first.body.data.id) as any).value)).toBe(1)
    expectNewAuditActors(auditStart)
  })

  it('persists the authenticated actor for outbound and keeps replay side effects singular', async () => {
    const fixture = seedMaterial('OUTBOUND', 10)
    const key = nextId('IDEM-OUTBOUND')
    const body = { type: 'direct', items: [{ materialId: fixture.materialId, quantity: 2 }] }
    const auditStart = maxAuditRowid()

    const first = await postAsAdmin('/api/v1/outbound', key, body, FORGED_A)
    const replay = await postAsAdmin('/api/v1/outbound', key, body, FORGED_B)

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expectStoredOperator('outbound_records', first.body.data.id)
    expectStockLogOperators(first.body.data.id)
    expectIdempotencyActor(key)
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM stock_logs WHERE related_id = ?').get(first.body.data.id) as any).value)).toBe(1)
    expectNewAuditActors(auditStart)
  })

  it('persists the authenticated actor for returns', async () => {
    const fixture = seedMaterial('RETURN', 10)
    const key = nextId('IDEM-RETURN')
    const body = { materialId: fixture.materialId, quantity: 2, reason: 'unused' }
    const auditStart = maxAuditRowid()

    const first = await postAsAdmin('/api/v1/returns', key, body, FORGED_A)
    const replay = await postAsAdmin('/api/v1/returns', key, body, FORGED_B)

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expectStoredOperator('return_records', first.body.data.id)
    expectStockLogOperators(first.body.data.id)
    expectIdempotencyActor(key)
    expectNewAuditActors(auditStart)
  })

  it('persists the authenticated actor for scraps', async () => {
    const fixture = seedMaterial('SCRAP', 10)
    const key = nextId('IDEM-SCRAP')
    const body = { materialId: fixture.materialId, quantity: 2, reason: 'expired' }
    const auditStart = maxAuditRowid()

    const first = await postAsAdmin('/api/v1/scraps', key, body, FORGED_A)
    const replay = await postAsAdmin('/api/v1/scraps', key, body, FORGED_B)

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expectStoredOperator('scrap_records', first.body.data.id)
    expectStockLogOperators(first.body.data.id)
    expectIdempotencyActor(key)
    expectNewAuditActors(auditStart)
  })

  it('persists the authenticated actor for stocktaking create and adjust', async () => {
    const fixture = seedMaterial('STOCKTAKING', 10)
    const createKey = nextId('IDEM-STOCKTAKING-CREATE')
    const createBody = { materialId: fixture.materialId, actualStock: 7 }
    const auditStart = maxAuditRowid()

    const created = await postAsAdmin('/api/v1/stocktaking', createKey, createBody, FORGED_A)
    const createReplay = await postAsAdmin('/api/v1/stocktaking', createKey, createBody, FORGED_B)
    expect(created.status).toBe(200)
    expect(createReplay.status).toBe(200)
    expect(createReplay.body.data.id).toBe(created.body.data.id)
    expectStoredOperator('stocktaking_records', created.body.data.id)
    expectIdempotencyActor(createKey)

    const adjustKey = nextId('IDEM-STOCKTAKING-ADJUST')
    const adjusted = await postAsAdmin(`/api/v1/stocktaking/${created.body.data.id}/adjust`, adjustKey, { reason: 'normal' }, FORGED_A)
    const adjustReplay = await postAsAdmin(`/api/v1/stocktaking/${created.body.data.id}/adjust`, adjustKey, { reason: 'normal' }, FORGED_B)
    expect(adjusted.status).toBe(200)
    expect(adjustReplay.status).toBe(200)
    expect(adjustReplay.body.data).toEqual(adjusted.body.data)
    expectStockLogOperators(created.body.data.id)
    expectIdempotencyActor(adjustKey)
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM stock_logs WHERE related_id = ?').get(created.body.data.id) as any).value)).toBe(1)
    expectNewAuditActors(auditStart)
  })

  it('persists the authenticated actor for supplier returns and its manual refund audit', async () => {
    const fixture = seedMaterial('SUPPLIER-RETURN', 10)
    const key = nextId('IDEM-SUPPLIER-RETURN')
    const body = { materialId: fixture.materialId, quantity: 2, reason: 'quality_issue' }
    const auditStart = maxAuditRowid()

    const first = await postAsAdmin('/api/v1/supplier-returns', key, body, FORGED_A)
    const replay = await postAsAdmin('/api/v1/supplier-returns', key, body, FORGED_B)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(first.body.data.id)
    expectStoredOperator('supplier_returns', first.body.data.id)
    expectStockLogOperators(first.body.data.id)
    expectIdempotencyActor(key)

    const refund = await withForgedActor(
      request(app)
        .put(`/api/v1/supplier-returns/${first.body.data.id}/refund-amount`)
        .set('Authorization', `Bearer ${adminToken}`),
      FORGED_B,
    ).send(forgedBody({ refundAmount: 1 }, FORGED_B))
    expect(refund.status).toBe(200)
    const manualAudit = db.prepare(`
      SELECT user_id, username FROM operation_logs
      WHERE operation = 'supplier_return_refund_amount'
        AND json_extract(request_data, '$.returnId') = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(first.body.data.id)
    expect(manualAudit).toMatchObject({ user_id: trustedActor.userId, username: trustedActor.username })
    expectNewAuditActors(auditStart)
  })

  it('persists the authenticated actor for transfer create and cancel', async () => {
    const fixture = seedTransfer('TRANSFER')
    const auditStart = maxAuditRowid()
    const created = await postAsAdmin('/api/v1/transfers/inbound', nextId('IDEM-TRANSFER'), {
      materialId: fixture.materialId,
      quantity: 2,
      fromLocationId: fixture.fromLocationId,
      toLocationId: fixture.toLocationId,
    }, FORGED_A)

    expect(created.status).toBe(200)
    expectStoredOperator('inbound_records', created.body.data.id)
    expectStockLogOperators(created.body.data.id)

    const cancelled = await withForgedActor(
      request(app)
        .delete(`/api/v1/transfers/${created.body.data.id}`)
        .set('Authorization', `Bearer ${adminToken}`),
      FORGED_B,
    ).send(forgedBody({}, FORGED_B))

    expect(cancelled.status).toBe(200)
    expectStoredOperator('inbound_records', created.body.data.id)
    expectStockLogOperators(created.body.data.id)
    expect(Number((db.prepare('SELECT COUNT(*) AS value FROM stock_logs WHERE related_id = ?').get(created.body.data.id) as any).value)).toBe(2)
    expectNewAuditActors(auditStart)
  })

  it('rejects spoof-only identity on every write family with zero side effects', async () => {
    const inbound = seedMaterial('NOAUTH-INBOUND')
    const outbound = seedMaterial('NOAUTH-OUTBOUND', 10)
    const returned = seedMaterial('NOAUTH-RETURN', 10)
    const scrap = seedMaterial('NOAUTH-SCRAP', 10)
    const stocktaking = seedMaterial('NOAUTH-STOCKTAKING', 10)
    const supplierReturn = seedMaterial('NOAUTH-SUPPLIER-RETURN', 10)
    const transfer = seedTransfer('NOAUTH-TRANSFER')
    const scenarios = [
      { path: '/api/v1/inbound', body: { type: 'direct', materialId: inbound.materialId, quantity: 1, locationId: inbound.locationId } },
      { path: '/api/v1/outbound', body: { type: 'direct', items: [{ materialId: outbound.materialId, quantity: 1 }] } },
      { path: '/api/v1/returns', body: { materialId: returned.materialId, quantity: 1, reason: 'unused' } },
      { path: '/api/v1/scraps', body: { materialId: scrap.materialId, quantity: 1, reason: 'expired' } },
      { path: '/api/v1/stocktaking', body: { materialId: stocktaking.materialId, actualStock: 9 } },
      { path: '/api/v1/supplier-returns', body: { materialId: supplierReturn.materialId, quantity: 1, reason: 'quality_issue' } },
      { path: '/api/v1/transfers/inbound', body: { materialId: transfer.materialId, quantity: 1, fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId } },
    ]

    for (const scenario of scenarios) {
      const before = mutationSnapshot()
      const auditBefore = maxAuditRowid()
      const response = await withForgedActor(
        request(app).post(scenario.path),
        FORGED_A,
        nextId('IDEM-NOAUTH'),
      ).send(forgedBody(scenario.body, FORGED_A))
      expect(response.status).toBe(401)
      expect(mutationSnapshot()).toEqual(before)
      expect(maxAuditRowid()).toBe(auditBefore)
    }
  })

  it('accepts normal Unicode identity without letting forged actor input replace it', async () => {
    const fixture = seedMaterial('UNICODE-ACTOR')
    const unicodeUsername = '病理医师-张三😀\u0080'
    injectedUser = {
      userId: '用户-001😀',
      username: unicodeUsername,
      role: 'admin',
      roles: ['admin'],
    }

    const response = await withForgedActor(
      request(isolatedApp).post('/api/v1/inbound'),
      FORGED_A,
      nextId('IDEM-UNICODE-ACTOR'),
    ).send(forgedBody({
      type: 'direct',
      materialId: fixture.materialId,
      quantity: 1,
      locationId: fixture.locationId,
    }, FORGED_A))

    expect(response.status).toBe(201)
    expect(db.prepare('SELECT operator FROM inbound_records WHERE id = ?').get(response.body.data.id))
      .toMatchObject({ operator: unicodeUsername })
  })

  it.each([
    ['missing user id', { userId: undefined, username: 'admin', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['empty user id', { userId: '', username: 'admin', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['non-string user id', { userId: 42, username: 'admin', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['control-character user id', { userId: 'bad\nactor', username: 'admin', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['NUL user id', { userId: 'bad\u0000actor', username: 'admin', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['unit-separator user id', { userId: 'bad\u001factor', username: 'admin', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['CRLF username', { userId: 'USER-001', username: 'bad\r\nactor', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['DEL username', { userId: 'USER-001', username: 'bad\u007factor', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['line-separator username', { userId: 'USER-001', username: 'bad\u2028actor', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['paragraph-separator username', { userId: 'USER-001', username: 'bad\u2029actor', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['empty username', { userId: 'USER-001', username: ' ', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['role mismatch', { userId: 'USER-001', username: 'admin', role: 'finance', roles: ['admin'] }, 403, 'ACTOR_PERMISSION_CONTEXT_MISMATCH'],
  ])('fails closed for %s before validation, idempotency, or transaction', async (_label, user, status, code) => {
    const fixture = seedMaterial(`INVALID-${sequence}`)
    injectedUser = user as RequestUser
    const before = mutationSnapshot()
    const response = await withForgedActor(
      request(isolatedApp).post('/api/v1/inbound'),
      FORGED_A,
      nextId('IDEM-INVALID-ACTOR'),
    ).send(forgedBody({
      type: 'direct',
      materialId: fixture.materialId,
      quantity: 1,
      locationId: fixture.locationId,
    }, FORGED_A))

    expect(response.status).toBe(status)
    expect(response.body.error.code).toBe(code)
    expect(mutationSnapshot()).toEqual(before)
  })

  it.each([
    ['missing request user', undefined, 401, 'UNAUTHORIZED'],
    ['missing user id', { userId: undefined, username: 'admin', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['non-string user id', { userId: 42, username: 'admin', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['control-character username', { userId: 'USER-001', username: 'bad\nactor', role: 'admin', roles: ['admin'] }, 401, 'INVALID_AUTHENTICATED_ACTOR'],
    ['role mismatch', { userId: 'USER-001', username: 'admin', role: 'finance', roles: ['admin'] }, 403, 'ACTOR_PERMISSION_CONTEXT_MISMATCH'],
  ])('transfer create and cancel fail closed for %s with zero side effects', async (_label, user, status, code) => {
    const fixture = seedTransfer(`INVALID-TRANSFER-${sequence}`)
    const created = await postAsAdmin('/api/v1/transfers/inbound', nextId('IDEM-TRANSFER-SETUP'), {
      materialId: fixture.materialId,
      quantity: 2,
      fromLocationId: fixture.fromLocationId,
      toLocationId: fixture.toLocationId,
    }, FORGED_A)
    expect(created.status).toBe(200)

    injectedUser = user as RequestUser | undefined
    const beforeCreate = mutationSnapshot()
    const rejectedCreate = await withForgedActor(
      request(isolatedApp).post('/api/v1/transfers/inbound'),
      FORGED_B,
    ).send(forgedBody({
      materialId: fixture.materialId,
      quantity: 1,
      fromLocationId: fixture.fromLocationId,
      toLocationId: fixture.toLocationId,
    }, FORGED_B))
    expect(rejectedCreate.status).toBe(status)
    expect(rejectedCreate.body.error.code).toBe(code)
    expect(mutationSnapshot()).toEqual(beforeCreate)

    const beforeCancel = mutationSnapshot()
    const rejectedCancel = await withForgedActor(
      request(isolatedApp).delete(`/api/v1/transfers/${created.body.data.id}`),
      FORGED_B,
    ).send(forgedBody({}, FORGED_B))
    expect(rejectedCancel.status).toBe(status)
    expect(rejectedCancel.body.error.code).toBe(code)
    expect(mutationSnapshot()).toEqual(beforeCancel)
  })

  it('rolls back the idempotency claim and all business writes on a transaction failure', async () => {
    const fixture = seedMaterial('TX-FAILURE', 1)
    const before = mutationSnapshot()
    const auditStart = maxAuditRowid()
    const response = await postAsAdmin('/api/v1/outbound', nextId('IDEM-TX-FAILURE'), {
      type: 'direct',
      items: [{ materialId: fixture.materialId, quantity: 2 }],
    }, FORGED_A)

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('STOCK_INSUFFICIENT')
    expect(mutationSnapshot()).toEqual(before)
    expectNewAuditActors(auditStart)
  })
})

describe('actor trust mutation contract', () => {
  const untrustedOperatorDestructuring = /\{[^}]*\boperator\b[^}]*\}\s*=\s*req\.body/s

  const routeSpecs = [
    ['inbound-v1.1.ts', 4],
    ['outbound-v1.1.ts', 3],
    ['returns-v1.1.ts', 2],
    ['scraps-v1.1.ts', 2],
    ['stocktaking-v1.1.ts', 4],
    ['supplier-returns-v1.1.ts', 4],
    ['transfers-v1.1.ts', 2],
  ] as const

  it('detects declaration and assignment-style operator destructuring from req.body', () => {
    expect('const { operator } = req.body').toMatch(untrustedOperatorDestructuring)
    expect('let operator; ({ operator } = req.body)').toMatch(untrustedOperatorDestructuring)
  })

  it.each(routeSpecs)('%s resolves a trusted actor before each of its %i mutation handlers', (file, expectedMutations) => {
    const source = readFileSync(fileURLToPath(new URL(`../src/routes/${file}`, import.meta.url)), 'utf8')
    const routePattern = /router\.(get|post|put|delete|patch)\(/g
    const starts = [...source.matchAll(routePattern)]
    const mutations = starts.filter((match) => match[1] !== 'get')
    expect(mutations).toHaveLength(expectedMutations)

    for (const mutation of mutations) {
      const start = mutation.index ?? 0
      const next = starts.find((candidate) => (candidate.index ?? 0) > start)
      const segment = source.slice(start, next?.index ?? source.length)
      const actorGuard = segment.indexOf('requireTrustedRequestActor(req, res)')
      expect(actorGuard).toBeGreaterThanOrEqual(0)
      for (const firstSensitiveOperation of ['getDatabase()', 'req.body', 'readIdempotencyKey(req)']) {
        const sensitiveIndex = segment.indexOf(firstSensitiveOperation)
        if (sensitiveIndex >= 0) expect(actorGuard).toBeLessThan(sensitiveIndex)
      }
    }

    expect(source).not.toMatch(/req\.body\??\.operator/)
    expect(source).not.toMatch(untrustedOperatorDestructuring)
    expect(source).not.toMatch(/req\.(?:get|header)\(\s*['"`][^'"`]*(?:operator|actor|created-by|updated-by|approved-by)/i)
    expect(source).not.toMatch(/(?:operator|actor)[^\n;=]*=([^\n;]*)(?:\|\||\?\?)[^\n;]*['"]system['"]/i)

    const fingerprintCalls = [...source.matchAll(/fingerprintRequest\(/g)]
    const safeFingerprintCalls = [...source.matchAll(/fingerprintRequest\(withoutUntrustedActorFields\(req\.body\)\)/g)]
    expect(safeFingerprintCalls).toHaveLength(fingerprintCalls.length)
  })

  it('the resolver reads only req.user and the fingerprint sanitizer drops all actor-shaped keys', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/security/trusted-request-actor.ts', import.meta.url)), 'utf8')
    const resolverStart = source.indexOf('export function requireTrustedRequestActor')
    const sanitizerStart = source.indexOf('export function withoutUntrustedActorFields')
    expect(resolverStart).toBeGreaterThanOrEqual(0)
    expect(sanitizerStart).toBeGreaterThan(resolverStart)
    const resolver = source.slice(resolverStart, sanitizerStart)
    expect(resolver).toContain('.user')
    expect(resolver).not.toMatch(/req\.(?:body|query|params|headers|get|header)/)
    for (const key of ['operator', 'actor', 'createdby', 'updatedby', 'approvedby', 'auditactor', 'userid', 'username']) {
      expect(source).toContain(`'${key}'`)
    }
  })
})
