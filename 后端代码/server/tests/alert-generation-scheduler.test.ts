import express from 'express'
import request from 'supertest'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { getDatabase, initializeDatabase } from '../src/database/DatabaseManager.js'
import alertRoutes from '../src/routes/alerts-v1.1.js'
import { generateAlerts, type AlertGenerationResult } from '../src/services/alert-generation.js'
import {
  resolveAlertSchedulerConfig,
  startAlertScheduler,
  type AlertScheduler,
} from '../src/services/alert-scheduler.js'

const INTERVAL_MS = 60_000
const FIXED_NOW = new Date('2026-07-22T12:00:00.000Z')
const ZERO_RESULT: AlertGenerationResult = {
  generatedCount: 0,
  lowStockCount: 0,
  expiryCount: 0,
}

let db: ReturnType<typeof getDatabase>
let scheduler: AlertScheduler | undefined
let appModule: typeof import('../src/app.js') | undefined

function flushScheduler(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function resetAlertFixtures(): void {
  db.exec(`
    DELETE FROM alerts;
    DELETE FROM batches;
    DELETE FROM inventory;
    DELETE FROM materials;
    DELETE FROM alert_rules;
  `)
  db.prepare(`
    INSERT INTO alert_rules (id, type, name, threshold, threshold_days, enabled)
    VALUES ('RULE-LOW-LOC031A', 'low-stock', 'low', 5, NULL, 1),
           ('RULE-EXP-LOC031A', 'expiry', 'expiry', NULL, 30, 1)
  `).run()
  db.prepare(`
    INSERT INTO materials
      (id, code, name, unit, category_id, min_stock, safety_stock, status, is_deleted)
    VALUES
      ('MAT-LOW-LOC031A', 'LOW-LOC031A', 'Secret Material Alpha', 'box', 'CAT', 10, 0, 1, 0),
      ('MAT-EXP-LOC031A', 'EXP-LOC031A', 'Secret Material Beta', 'box', 'CAT', 0, 0, 1, 0)
  `).run()
  db.prepare(`
    INSERT INTO inventory (id, material_id, stock)
    VALUES ('INV-LOW-LOC031A', 'MAT-LOW-LOC031A', 3)
  `).run()
  db.prepare(`
    INSERT INTO batches
      (id, material_id, batch_no, quantity, remaining, expiry_date, inbound_id, status)
    VALUES
      ('BATCH-EXP-LOC031A', 'MAT-EXP-LOC031A', 'SECRET-BATCH-42', 1, 1,
       '2000-01-01', 'INBOUND-LOC031A', 1)
  `).run()
}

function rowsByType(): Array<{ type: string; material_id: string }> {
  return db.prepare(
    'SELECT type, material_id FROM alerts ORDER BY type, material_id'
  ).all() as Array<{ type: string; material_id: string }>
}

beforeAll(() => {
  process.env.JWT_SECRET = 'loc-031a-test-secret-32-characters-minimum'
  initializeDatabase()
  db = getDatabase()
})

beforeEach(() => {
  resetAlertFixtures()
})

afterEach(() => {
  scheduler?.stop()
  scheduler = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('LOC-031A transactional alert generation', () => {
  it('generates low-stock and expiry alerts atomically, then deduplicates pending alerts', () => {
    const first = generateAlerts({ database: db, now: FIXED_NOW })
    expect(first).toEqual({ generatedCount: 2, lowStockCount: 1, expiryCount: 1 })
    expect(rowsByType()).toEqual([
      { type: 'expiry', material_id: 'MAT-EXP-LOC031A' },
      { type: 'low-stock', material_id: 'MAT-LOW-LOC031A' },
    ])

    const repeated = generateAlerts({ database: db, now: FIXED_NOW })
    expect(repeated).toEqual(ZERO_RESULT)
    expect(rowsByType()).toHaveLength(2)
  })

  it('rolls back every insert when a fault occurs after the first candidate insert', () => {
    const prototype = Object.getPrototypeOf(db) as { prepare(sql: string): unknown }
    const originalPrepare = prototype.prepare
    const prepareSpy = vi.spyOn(prototype, 'prepare').mockImplementation(function (sql: string) {
      if (sql.includes('INSERT INTO alerts') && !sql.includes('current_stock')) {
        return {
          run() {
            throw new Error('SELECT secret FROM C:\\private\\coreone.db for SECRET-BATCH-42')
          },
        }
      }
      return originalPrepare.call(this, sql)
    })

    expect(() => generateAlerts({ database: db, now: FIXED_NOW })).toThrow('SELECT secret')
    prepareSpy.mockRestore()
    expect(db.prepare('SELECT COUNT(*) AS count FROM alerts').get()).toEqual({ count: 0 })
  })

  it('keeps the manual route and scheduler on the same rules and generated count', async () => {
    const manualApp = express()
    manualApp.use(express.json())
    manualApp.use('/api/v1/alerts', alertRoutes)

    const manual = await request(manualApp).post('/api/v1/alerts/generate')
    expect(manual.status).toBe(200)
    expect(manual.body).toMatchObject({
      success: true,
      data: { generatedCount: 2 },
      message: 'Generated 2 alerts',
    })

    db.exec('DELETE FROM alerts')
    const schedulerResults: AlertGenerationResult[] = []
    scheduler = startAlertScheduler({
      env: { ALERT_SCAN_INTERVAL_MS: String(INTERVAL_MS) },
      onResult: result => schedulerResults.push(result),
    })
    await flushScheduler()

    expect(schedulerResults).toEqual([
      { generatedCount: 2, lowStockCount: 1, expiryCount: 1 },
    ])
    expect(rowsByType()).toHaveLength(manual.body.data.generatedCount)
  })
})

describe('LOC-031A scheduler configuration and lifecycle', () => {
  it('defaults enabled at 15 minutes, supports explicit false, and rejects non-canonical intervals', () => {
    expect(resolveAlertSchedulerConfig({})).toEqual({ enabled: true, intervalMs: 900_000 })
    expect(resolveAlertSchedulerConfig({ ALERT_SCHEDULER_ENABLED: 'false' }))
      .toEqual({ enabled: false, intervalMs: 900_000 })
    expect(resolveAlertSchedulerConfig({ ALERT_SCHEDULER_ENABLED: 'FALSE' }).enabled).toBe(true)
    expect(resolveAlertSchedulerConfig({ ALERT_SCAN_INTERVAL_MS: '60000' }).intervalMs).toBe(60_000)
    expect(resolveAlertSchedulerConfig({ ALERT_SCAN_INTERVAL_MS: '86400000' }).intervalMs).toBe(86_400_000)

    for (const value of ['', '060000', '+60000', '60000.0', '1e5', '59999', '86400001', '9007199254740992']) {
      expect(() => resolveAlertSchedulerConfig({ ALERT_SCAN_INTERVAL_MS: value }), value)
        .toThrow('ALERT_SCAN_INTERVAL_MS')
    }
  })

  it('does not run when explicitly disabled', async () => {
    const scan = vi.fn(() => ZERO_RESULT)
    scheduler = startAlertScheduler({
      env: { ALERT_SCHEDULER_ENABLED: 'false' },
      scan,
    })
    await flushScheduler()
    expect(scan).not.toHaveBeenCalled()
  })

  it('skips an overlapping tick and retries on the following fixed interval', async () => {
    vi.useFakeTimers()
    let finishFirst: ((result: AlertGenerationResult) => void) | undefined
    const firstRun = new Promise<AlertGenerationResult>(resolve => { finishFirst = resolve })
    const scan = vi.fn()
      .mockImplementationOnce(() => firstRun)
      .mockImplementation(() => ZERO_RESULT)
    const info: string[] = []
    scheduler = startAlertScheduler({
      env: { ALERT_SCAN_INTERVAL_MS: String(INTERVAL_MS) },
      scan,
      logger: { info: message => info.push(message), error: vi.fn() },
    })

    expect(scan).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(info).toContain('[alert-scheduler] skipped-overlap')

    finishFirst?.(ZERO_RESULT)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('retries after one scan error and emits only stable sanitized diagnostics', async () => {
    vi.useFakeTimers()
    const info: string[] = []
    const errors: string[] = []
    let attempts = 0
    scheduler = startAlertScheduler({
      env: { ALERT_SCAN_INTERVAL_MS: String(INTERVAL_MS) },
      scan: () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('SELECT * FROM C:\\private\\coreone.db WHERE material=Secret Material Alpha AND batch=SECRET-BATCH-42')
        }
        return generateAlerts({ database: db, now: FIXED_NOW })
      },
      logger: { info: message => info.push(message), error: message => errors.push(message) },
    })

    await Promise.resolve()
    expect(errors).toEqual(['[alert-scheduler] scan-failed'])
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(attempts).toBe(2)
    expect(rowsByType()).toHaveLength(2)

    const logText = [...info, ...errors].join('\n')
    expect(logText).not.toMatch(/SELECT|coreone\.db|\\private|Secret Material|SECRET-BATCH|Error:|at /)
  })

  it('unrefs its timer and stop prevents every later tick', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    const initialScan = vi.fn(() => ZERO_RESULT)
    scheduler = startAlertScheduler({
      env: { ALERT_SCAN_INTERVAL_MS: String(INTERVAL_MS) },
      scan: initialScan,
    })
    await flushScheduler()

    const timer = intervalSpy.mock.results.at(-1)?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
    expect(initialScan).toHaveBeenCalledTimes(1)
    scheduler.stop()

    vi.useFakeTimers()
    const stoppedScan = vi.fn(() => ZERO_RESULT)
    scheduler = startAlertScheduler({
      env: { ALERT_SCAN_INTERVAL_MS: String(INTERVAL_MS) },
      scan: stoppedScan,
    })
    expect(stoppedScan).toHaveBeenCalledTimes(1)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
    expect(stoppedScan).toHaveBeenCalledTimes(1)
  })
})

describe('LOC-031A real app startup boundary', () => {
  it('does not auto-listen or auto-schedule when app is imported in test environment', async () => {
    appModule = await import('../src/app.js')
    expect(appModule.getAutomaticServerRuntime()).toBeUndefined()
  })

  it('fails closed on invalid interval before listening', async () => {
    appModule ??= await import('../src/app.js')
    expect(() => appModule?.startServer({
      host: '127.0.0.1',
      port: 0,
      schedulerEnv: { ALERT_SCAN_INTERVAL_MS: '60000.0' },
    })).toThrow('ALERT_SCAN_INTERVAL_MS')
  })

  it('starts the real scheduler only after listen, scans immediately without HTTP, and disposes cleanly', async () => {
    appModule ??= await import('../src/app.js')
    const runtime = appModule.startServer({
      host: '127.0.0.1',
      port: 0,
      schedulerEnv: { ALERT_SCAN_INTERVAL_MS: String(INTERVAL_MS) },
    })
    await new Promise<void>((resolve, reject) => {
      runtime.server.once('listening', resolve)
      runtime.server.once('error', reject)
    })

    expect(rowsByType()).toHaveLength(2)
    await runtime.dispose()
    expect(runtime.server.listening).toBe(false)
  })
})
