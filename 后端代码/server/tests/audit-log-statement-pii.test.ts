import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'
import { getDatabase, initializeDatabase } from '../src/database/DatabaseManager.js'
import { auditWrite } from '../src/middleware/audit-log.js'

interface SyntheticActorRequest extends Request {
  user?: { userId: string; username: string; role: string }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/

let actorSequence = 0

beforeAll(() => {
  initializeDatabase()
})

function nextActor(label: string) {
  actorSequence += 1
  return {
    userId: `SYNTH_USER_${label}_${actorSequence}_NOT_REAL`,
    username: `SYNTH_ACTOR_${label}_${actorSequence}_NOT_REAL`,
    role: 'SYNTH_ROLE_NOT_REAL',
  }
}

function buildSyntheticApp(actor: ReturnType<typeof nextActor>) {
  const app = express()
  app.use(express.json())
  app.use((req: SyntheticActorRequest, _res: Response, next: NextFunction) => {
    req.user = actor
    next()
  })
  app.use(auditWrite)
  app.post('/api/v1/statement-import/preview', (_req, res) => res.status(200).json({ ok: true }))
  app.post('/api/v1/statement-import/commit', (_req, res) => res.status(200).json({ ok: true }))
  app.post('/api/v1/synthetic-audit', (_req, res) => res.status(200).json({ ok: true }))
  return app
}

function latestLog(username: string) {
  return getDatabase()
    .prepare('SELECT * FROM operation_logs WHERE username = ? ORDER BY rowid DESC LIMIT 1')
    .get(username) as any
}

function statementBody(grid: unknown[][]) {
  return {
    partnerId: 'SYNTH_PARTNER_001_NOT_REAL',
    serviceMonth: '2026-08',
    template: 'line_item',
    confirm: true,
    grid,
    requestId: 'SYNTH_CLIENT_REQUEST_ID_NOT_REAL',
    batch: {
      sha256: 'SYNTH_FORGED_HASH_NOT_REAL',
      rowCount: 999_999,
      columnCount: 999_999,
      cellCount: 999_999,
    },
    unknown: { freeText: 'SYNTH_UNKNOWN_TEXT_NOT_REAL' },
  }
}

describe('successful write audit: statement and patient data minimization', () => {
  it('statement preview/commit logs only a fixed server-owned whitelist and queryless route', async () => {
    const actor = nextActor('STATEMENT')
    const app = buildSyntheticApp(actor)
    const queryMarker = 'SYNTH_QUERY_SECRET_NOT_REAL'
    const grid = [
      [
        'SYNTH_NAME_HEADER_NOT_REAL',
        'SYNTH_ID_HEADER_NOT_REAL',
        'SYNTH_PHONE_HEADER_NOT_REAL',
        'SYNTH_DIAG_HEADER_NOT_REAL',
        'SYNTH_MISC_HEADER_NOT_REAL',
      ],
      [
        'SYNTH_NAME_CELL_A_NOT_REAL',
        'SYNTH_ID_CELL_B_NOT_REAL',
        'SYNTH_PHONE_CELL_C_NOT_REAL',
        'SYNTH_DIAG_CELL_D_NOT_REAL',
        'SYNTH_ARBITRARY_CELL_E_NOT_REAL',
      ],
    ]

    const preview = await request(app)
      .post(`/api/v1/statement-import/preview?token=${queryMarker}`)
      .send(statementBody(grid))
    expect(preview.status).toBe(200)

    const previewRow = latestLog(actor.username)
    expect(previewRow).toBeTruthy()
    expect(previewRow.user_id).toBe(actor.userId)
    expect(previewRow.username).toBe(actor.username)
    expect(previewRow.operation).toBe('POST statement-import')
    expect(previewRow.outcome).toBeNull()
    expect(previewRow.response_data).toBeNull()
    for (const forbidden of [
      'SYNTH_NAME_CELL_A_NOT_REAL',
      'SYNTH_ID_CELL_B_NOT_REAL',
      'SYNTH_PHONE_CELL_C_NOT_REAL',
      'SYNTH_DIAG_CELL_D_NOT_REAL',
      'SYNTH_ARBITRARY_CELL_E_NOT_REAL',
      'SYNTH_UNKNOWN_TEXT_NOT_REAL',
    ]) {
      expect(previewRow.request_data).not.toContain(forbidden)
    }
    expect(previewRow.description).toContain('/api/v1/statement-import/preview')
    expect(previewRow.description).not.toContain('?')
    expect(previewRow.description).not.toContain(queryMarker)

    const previewMeta = JSON.parse(previewRow.request_data)
    expect(Object.keys(previewMeta).sort()).toEqual(['batch', 'business', 'requestId'])
    expect(previewMeta.requestId).toMatch(UUID_V4)
    expect(previewMeta.requestId).not.toBe('SYNTH_CLIENT_REQUEST_ID_NOT_REAL')
    expect(Object.keys(previewMeta.business).sort()).toEqual(['confirm', 'partnerId', 'serviceMonth', 'template'])
    expect(previewMeta.business).toEqual({
      partnerId: 'SYNTH_PARTNER_001_NOT_REAL',
      serviceMonth: '2026-08',
      template: 'line_item',
      confirm: true,
    })
    expect(Object.keys(previewMeta.batch).sort()).toEqual([
      'cellCount',
      'columnCount',
      'rowCount',
      'sha256',
      'status',
    ])
    expect(previewMeta.batch).toEqual({
      status: 'summarized',
      sha256: createHash('sha256').update(JSON.stringify(grid)).digest('hex'),
      rowCount: 2,
      columnCount: 5,
      cellCount: 10,
    })
    expect(previewMeta.batch.sha256).toMatch(SHA256)
    expect(previewRow.request_data).not.toContain('SYNTH_FORGED_HASH_NOT_REAL')
    expect(previewRow.request_data).not.toContain('999999')

    const mixedCase = await request(app)
      .post('/API/V1/STATEMENT-IMPORT/PREVIEW')
      .send(statementBody(grid))
    expect(mixedCase.status).toBe(200)
    const mixedCaseRow = latestLog(actor.username)
    const mixedCaseMeta = JSON.parse(mixedCaseRow.request_data)
    expect(mixedCaseRow.operation).toBe('POST statement-import')
    expect(Object.keys(mixedCaseMeta).sort()).toEqual(['batch', 'business', 'requestId'])
    expect(mixedCaseMeta.requestId).toMatch(UUID_V4)
    expect(mixedCaseMeta.batch).toEqual(previewMeta.batch)
    expect(mixedCaseRow.request_data).not.toContain('SYNTH_FORGED_HASH_NOT_REAL')
    expect(mixedCaseRow.request_data).not.toContain('SYNTH_ARBITRARY_CELL_E_NOT_REAL')

    const changedGrid = grid.map((row) => [...row])
    changedGrid[1][4] = 'SYNTH_CHANGED_CELL_NOT_REAL'
    const commit = await request(app).post('/api/v1/statement-import/commit').send(statementBody(changedGrid))
    expect(commit.status).toBe(200)

    const commitRow = latestLog(actor.username)
    const commitMeta = JSON.parse(commitRow.request_data)
    expect(commitMeta.batch.rowCount).toBe(2)
    expect(commitMeta.batch.columnCount).toBe(5)
    expect(commitMeta.batch.cellCount).toBe(10)
    expect(commitMeta.batch.sha256).toMatch(SHA256)
    expect(commitMeta.batch.sha256).not.toBe(previewMeta.batch.sha256)
    expect(commitRow.request_data).not.toContain('SYNTH_CHANGED_CELL_NOT_REAL')
  })

  it('generic success keeps safe scalars but redacts patient aliases and summarizes every array/table alias', async () => {
    const actor = nextActor('GENERIC')
    const app = buildSyntheticApp(actor)
    const sensitiveMarkers = [
      'SYNTH_PATIENT_NAME_NOT_REAL',
      'SYNTH_PATIENT_ID_NOT_REAL',
      'SYNTH_ID_CARD_NOT_REAL',
      'SYNTH_PHONE_NOT_REAL',
      'SYNTH_DIAGNOSIS_NOT_REAL',
      'SYNTH_CASE_ID_NOT_REAL',
      'SYNTH_CHINESE_NAME_NOT_REAL',
      'SYNTH_CREDENTIAL_NOT_REAL',
      'SYNTH_ARRAY_CELL_NOT_REAL',
      'SYNTH_ALIAS_CELL_NOT_REAL',
    ]
    const aliases = [
      'grid',
      'rawGrid',
      'raw_grid',
      'tableData',
      'sheetData',
      'worksheet',
      'rows',
      'lines',
      'cases',
      'orders',
      'items',
      'records',
      'cells',
      'rawPayload',
    ]
    const aliasPayload: Record<string, unknown> = Object.fromEntries(
      aliases.map((alias) => [alias, [{ arbitrary: 'SYNTH_ALIAS_CELL_NOT_REAL' }]]),
    )
    aliasPayload.rawPayload = { arbitrary: 'SYNTH_ALIAS_CELL_NOT_REAL' }

    const response = await request(app)
      .post('/api/v1/synthetic-audit')
      .send({
        name: 'SYNTH_SAFE_MATERIAL_NAME_NOT_REAL',
        credential: 'SYNTH_CREDENTIAL_NOT_REAL',
        safeNested: {
          scalar: 'SYNTH_SAFE_NESTED_NOT_REAL',
          patientName: 'SYNTH_PATIENT_NAME_NOT_REAL',
          deeper: {
            patient_id: 'SYNTH_PATIENT_ID_NOT_REAL',
            idCard: 'SYNTH_ID_CARD_NOT_REAL',
            phoneNumber: 'SYNTH_PHONE_NOT_REAL',
            diagnosis: 'SYNTH_DIAGNOSIS_NOT_REAL',
            case_id: 'SYNTH_CASE_ID_NOT_REAL',
            ['\u59d3\u540d']: 'SYNTH_CHINESE_NAME_NOT_REAL',
          },
        },
        arbitraryList: [{ value: 'SYNTH_ARRAY_CELL_NOT_REAL' }],
        nestedAliases: aliasPayload,
      })
    expect(response.status).toBe(200)

    const row = latestLog(actor.username)
    expect(row).toBeTruthy()
    expect(row.user_id).toBe(actor.userId)
    expect(row.operation).toBe('POST synthetic-audit')
    expect(row.response_data).toBeNull()
    const meta = JSON.parse(row.request_data)
    expect(meta.requestId).toMatch(UUID_V4)
    expect(meta.name).toBe('SYNTH_SAFE_MATERIAL_NAME_NOT_REAL')
    expect(meta.safeNested.scalar).toBe('SYNTH_SAFE_NESTED_NOT_REAL')
    expect(meta.credential).toBe('[REDACTED]')
    expect(meta.safeNested.patientName).toBe('[REDACTED]')
    expect(Object.values(meta.safeNested.deeper)).toEqual([
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
    ])
    expect(Object.keys(meta.arbitraryList).sort()).toEqual(['count', 'sha256'])
    expect(meta.arbitraryList.count).toBe(1)
    expect(meta.arbitraryList.sha256).toMatch(SHA256)

    for (const alias of aliases) {
      expect(Object.keys(meta.nestedAliases[alias]).sort(), alias).toEqual(['count', 'sha256'])
      expect(meta.nestedAliases[alias].count, alias).toBe(1)
      expect(meta.nestedAliases[alias].sha256, alias).toMatch(SHA256)
    }
    for (const marker of sensitiveMarkers) {
      expect(row.request_data).not.toContain(marker)
    }
  })

  it('unknown statement getters fail closed without losing actor, route, or server request id', () => {
    const actor = nextActor('FAIL_CLOSED')
    const queryMarker = 'SYNTH_FAIL_QUERY_NOT_REAL'
    const thrownMarker = 'SYNTH_THROWN_GETTER_NOT_REAL'
    const body = Object.create(null)
    Object.defineProperty(body, 'grid', {
      enumerable: true,
      get() {
        throw new Error(thrownMarker)
      },
    })

    const res: any = new EventEmitter()
    res.statusCode = 200
    res.json = (value: unknown) => value
    const req: any = {
      method: 'POST',
      user: actor,
      body,
      params: {},
      ip: 'SYNTH_IP_NOT_REAL',
      socket: {},
      originalUrl: `/api/v1/statement-import/preview?token=${queryMarker}`,
      baseUrl: '/api/v1/statement-import',
      path: '/preview',
      get: () => 'SYNTH_USER_AGENT_NOT_REAL',
    }

    auditWrite(req, res, () => undefined)
    res.emit('finish')

    const row = latestLog(actor.username)
    expect(row, 'sanitizer failure must not suppress the audit row').toBeTruthy()
    expect(row.user_id).toBe(actor.userId)
    expect(row.operation).toBe('POST statement-import')
    expect(row.description).toContain('/api/v1/statement-import/preview')
    expect(row.description).not.toContain('?')
    expect(row.description).not.toContain(queryMarker)
    expect(row.response_data).toBeNull()
    const meta = JSON.parse(row.request_data)
    expect(Object.keys(meta).sort()).toEqual(['batch', 'business', 'requestId'])
    expect(meta.requestId).toMatch(UUID_V4)
    expect(meta.business).toEqual({ partnerId: null, serviceMonth: null, template: null, confirm: null })
    expect(meta.batch).toEqual({
      status: 'unavailable',
      sha256: null,
      rowCount: null,
      columnCount: null,
      cellCount: null,
    })
    expect(row.request_data).not.toContain(thrownMarker)
  })

  it('proxy bodies and proxied grids fail closed without persisting trap-provided values', () => {
    const proxyMarker = 'SYNTH_PROXY_TRAP_VALUE_NOT_REAL'
    const genericActor = nextActor('PROXY_GENERIC')
    const proxyBody = new Proxy<Record<string, unknown>>({}, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => ['safeNested'],
      getOwnPropertyDescriptor: () => ({
        configurable: true,
        enumerable: true,
        value: proxyMarker,
        writable: true,
      }),
    })
    const genericRes: any = new EventEmitter()
    genericRes.statusCode = 200
    genericRes.json = (value: unknown) => value
    const genericReq: any = {
      method: 'POST',
      user: genericActor,
      body: proxyBody,
      params: {},
      ip: 'SYNTH_IP_NOT_REAL',
      socket: {},
      originalUrl: '/api/v1/synthetic-audit/proxy',
      baseUrl: '/api/v1/synthetic-audit',
      path: '/proxy',
      get: () => 'SYNTH_USER_AGENT_NOT_REAL',
    }

    auditWrite(genericReq, genericRes, () => undefined)
    genericRes.emit('finish')

    const genericRow = latestLog(genericActor.username)
    expect(genericRow).toBeTruthy()
    expect(genericRow.user_id).toBe(genericActor.userId)
    expect(genericRow.response_data).toBeNull()
    const genericMeta = JSON.parse(genericRow.request_data)
    expect(Object.keys(genericMeta)).toEqual(['requestId'])
    expect(genericMeta.requestId).toMatch(UUID_V4)
    expect(genericRow.request_data).not.toContain(proxyMarker)

    const gridMarker = 'SYNTH_PROXY_GRID_CELL_NOT_REAL'
    const statementActor = nextActor('PROXY_GRID')
    const proxiedGrid = new Proxy([[gridMarker]], {})
    const statementRes: any = new EventEmitter()
    statementRes.statusCode = 200
    statementRes.json = (value: unknown) => value
    const statementReq: any = {
      method: 'POST',
      user: statementActor,
      body: {
        partnerId: 'SYNTH_PARTNER_PROXY_NOT_REAL',
        serviceMonth: '2026-08',
        template: 'line_item',
        confirm: true,
        grid: proxiedGrid,
      },
      params: {},
      ip: 'SYNTH_IP_NOT_REAL',
      socket: {},
      originalUrl: '/api/v1/statement-import/preview',
      baseUrl: '/api/v1/statement-import',
      path: '/preview',
      get: () => 'SYNTH_USER_AGENT_NOT_REAL',
    }

    auditWrite(statementReq, statementRes, () => undefined)
    statementRes.emit('finish')

    const statementRow = latestLog(statementActor.username)
    expect(statementRow).toBeTruthy()
    expect(statementRow.user_id).toBe(statementActor.userId)
    expect(statementRow.response_data).toBeNull()
    const statementMeta = JSON.parse(statementRow.request_data)
    expect(Object.keys(statementMeta).sort()).toEqual(['batch', 'business', 'requestId'])
    expect(statementMeta.requestId).toMatch(UUID_V4)
    expect(statementMeta.batch).toEqual({
      status: 'unavailable',
      sha256: null,
      rowCount: null,
      columnCount: null,
      cellCount: null,
    })
    expect(statementRow.request_data).not.toContain(gridMarker)
  })

  it('inherited toJSON hooks make the statement batch unavailable instead of altering its hash', () => {
    const actor = nextActor('PROTOTYPE_TO_JSON')
    const marker = 'SYNTH_INHERITED_TO_JSON_VALUE_NOT_REAL'
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')

    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        writable: true,
        value() {
          return [marker]
        },
      })

      const res: any = new EventEmitter()
      res.statusCode = 200
      res.json = (value: unknown) => value
      const req: any = {
        method: 'POST',
        user: actor,
        body: {
          partnerId: 'SYNTH_PARTNER_PROTO_NOT_REAL',
          serviceMonth: '2026-08',
          template: 'line_item',
          confirm: true,
          grid: [['SYNTH_SAFE_GRID_CELL_NOT_REAL']],
        },
        params: {},
        ip: 'SYNTH_IP_NOT_REAL',
        socket: {},
        originalUrl: '/api/v1/statement-import/preview',
        baseUrl: '/api/v1/statement-import',
        path: '/preview',
        get: () => 'SYNTH_USER_AGENT_NOT_REAL',
      }

      auditWrite(req, res, () => undefined)
      res.emit('finish')

      const row = latestLog(actor.username)
      expect(row).toBeTruthy()
      expect(row.user_id).toBe(actor.userId)
      expect(row.response_data).toBeNull()
      const meta = JSON.parse(row.request_data)
      expect(meta.requestId).toMatch(UUID_V4)
      expect(meta.batch).toEqual({
        status: 'unavailable',
        sha256: null,
        rowCount: null,
        columnCount: null,
        cellCount: null,
      })
      expect(row.request_data).not.toContain(marker)
    } finally {
      if (previous) Object.defineProperty(Array.prototype, 'toJSON', previous)
      else delete (Array.prototype as any).toJSON
    }
  })

  it('Object.prototype toJSON cannot replace statement or generic audit metadata', () => {
    const marker = 'SYNTH_OBJECT_PROTO_TO_JSON_VALUE_NOT_REAL'
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    const statementActor = nextActor('OBJECT_PROTO_STATEMENT')
    const genericActor = nextActor('OBJECT_PROTO_GENERIC')
    let statementRow: any
    let genericRow: any

    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        writable: true,
        value() {
          return { polluted: marker }
        },
      })

      const statementRes: any = new EventEmitter()
      statementRes.statusCode = 200
      statementRes.json = (value: unknown) => value
      const statementReq: any = {
        method: 'POST',
        user: statementActor,
        body: {
          partnerId: 'SYNTH_PARTNER_OBJECT_PROTO_NOT_REAL',
          serviceMonth: '2026-08',
          template: 'line_item',
          confirm: true,
          grid: [['SYNTH_OBJECT_PROTO_GRID_CELL_NOT_REAL']],
        },
        params: {},
        ip: 'SYNTH_IP_NOT_REAL',
        socket: {},
        originalUrl: '/api/v1/statement-import/preview',
        baseUrl: '/api/v1/statement-import',
        path: '/preview',
        get: () => 'SYNTH_USER_AGENT_NOT_REAL',
      }
      auditWrite(statementReq, statementRes, () => undefined)
      statementRes.emit('finish')
      statementRow = latestLog(statementActor.username)

      const genericRes: any = new EventEmitter()
      genericRes.statusCode = 200
      genericRes.json = (value: unknown) => value
      const genericReq: any = {
        method: 'POST',
        user: genericActor,
        body: {
          name: 'SYNTH_SAFE_OBJECT_PROTO_NAME_NOT_REAL',
          items: [{ arbitrary: 'SYNTH_OBJECT_PROTO_ARRAY_CELL_NOT_REAL' }],
        },
        params: {},
        ip: 'SYNTH_IP_NOT_REAL',
        socket: {},
        originalUrl: '/api/v1/synthetic-audit/object-prototype',
        baseUrl: '/api/v1/synthetic-audit',
        path: '/object-prototype',
        get: () => 'SYNTH_USER_AGENT_NOT_REAL',
      }
      auditWrite(genericReq, genericRes, () => undefined)
      genericRes.emit('finish')
      genericRow = latestLog(genericActor.username)
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'toJSON', previous)
      else delete (Object.prototype as any).toJSON
    }

    expect(statementRow).toBeTruthy()
    expect(statementRow.user_id).toBe(statementActor.userId)
    expect(statementRow.response_data).toBeNull()
    const statementMeta = JSON.parse(statementRow.request_data)
    expect(Object.keys(statementMeta).sort()).toEqual(['batch', 'business', 'requestId'])
    expect(statementMeta.requestId).toMatch(UUID_V4)
    expect(statementMeta.batch).toEqual({
      status: 'unavailable',
      sha256: null,
      rowCount: null,
      columnCount: null,
      cellCount: null,
    })
    expect(statementRow.request_data).not.toContain(marker)
    expect(statementRow.request_data).not.toContain('SYNTH_OBJECT_PROTO_GRID_CELL_NOT_REAL')

    expect(genericRow).toBeTruthy()
    expect(genericRow.user_id).toBe(genericActor.userId)
    expect(genericRow.response_data).toBeNull()
    const genericMeta = JSON.parse(genericRow.request_data)
    expect(genericMeta.requestId).toMatch(UUID_V4)
    expect(genericMeta.name).toBe('SYNTH_SAFE_OBJECT_PROTO_NAME_NOT_REAL')
    expect(genericMeta.items).toEqual({ count: 1, sha256: null })
    expect(genericRow.request_data).not.toContain(marker)
    expect(genericRow.request_data).not.toContain('SYNTH_OBJECT_PROTO_ARRAY_CELL_NOT_REAL')
  })

  it('cyclic generic bodies are bounded and retain safe audit metadata', () => {
    const actor = nextActor('CYCLE')
    const cyclic: any = { name: 'SYNTH_SAFE_CYCLE_NAME_NOT_REAL' }
    cyclic.loop = cyclic

    const res: any = new EventEmitter()
    res.statusCode = 204
    res.json = (value: unknown) => value
    const req: any = {
      method: 'PATCH',
      user: actor,
      body: cyclic,
      params: {},
      ip: 'SYNTH_IP_NOT_REAL',
      socket: {},
      originalUrl: '/api/v1/synthetic-audit/cycle',
      baseUrl: '/api/v1/synthetic-audit',
      path: '/cycle',
      get: () => 'SYNTH_USER_AGENT_NOT_REAL',
    }

    auditWrite(req, res, () => undefined)
    res.emit('finish')

    const row = latestLog(actor.username)
    expect(row).toBeTruthy()
    expect(row.operation).toBe('PATCH synthetic-audit')
    const meta = JSON.parse(row.request_data)
    expect(meta.requestId).toMatch(UUID_V4)
    expect(meta.name).toBe('SYNTH_SAFE_CYCLE_NAME_NOT_REAL')
    expect(meta.loop).toBe('[OMITTED]')
  })
})
