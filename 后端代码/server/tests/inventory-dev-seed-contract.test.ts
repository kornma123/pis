/**
 * #140 Phase A — 开发种子（验收数据）批次事实闭环合同测试。
 *
 * 合同（TASK-CONTRACT §5.A）：
 * - 生产种子在全新临时绝对库上跑通（NODE_ENV=test 与 development）；
 * - 每个正 inventory.stock 的物料都有 eligible 批次（status=1 且 remaining>0）；
 * - 每个物料 inventory.stock = Σ eligible 批次 remaining（且 = Σ 全部 remaining）；
 * - 种子拒绝非法批次事实（inactive 却正 remaining、负数、remaining>quantity）——
 *   由种子内 fixture 校验与写后守恒核验强制执行（变异证据见任务台账）；
 * - 种子带硬目标库守卫：既有业务库一律拒写，哨兵数据原样保留；
 * - 非 development/test 环境拒绝执行且不创建目标库。
 *
 * 全程只用一次性临时绝对库，绝不触碰 tracked dev 库或任何真实库。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const created: string[] = []
const seedScript = resolve(process.cwd(), 'scripts/seed-acceptance-data.ts')
const SEED_JWT_SECRET = 'seed-contract-only-9x'.repeat(4)

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coreone-seed-contract-'))
  created.push(directory)
  return directory
}

function runNode(args: string[], env: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

function runSeed(env: Record<string, string>): { status: number | null; output: string } {
  return runNode(['--import', 'tsx', seedScript], env)
}

function queryAll(dbPath: string, sql: string, params: unknown[] = []): any[] {
  const db = new DatabaseSync(dbPath, { readOnly: true } as any)
  try {
    return db.prepare(sql).all(...(params as any[])) as any[]
  } finally {
    db.close()
  }
}

function expectSeededConservation(dbPath: string): void {
  const inventoryRows = queryAll(dbPath, 'SELECT material_id, stock FROM inventory')
  expect(inventoryRows.length).toBeGreaterThan(0)
  const positive = inventoryRows.filter((row) => Number(row.stock) > 0)
  expect(positive.length).toBeGreaterThan(0)

  for (const row of inventoryRows) {
    const stock = Number(row.stock)
    expect(stock).toBeGreaterThanOrEqual(0)
    const batches = queryAll(
      dbPath,
      'SELECT quantity, remaining, status FROM batches WHERE material_id = ?',
      [row.material_id],
    )
    let eligible = 0
    let totalRemaining = 0
    for (const batch of batches) {
      const quantity = Number(batch.quantity)
      const remaining = Number(batch.remaining)
      const status = Number(batch.status)
      expect(quantity).toBeGreaterThanOrEqual(0)
      expect(remaining).toBeGreaterThanOrEqual(0)
      expect(remaining).toBeLessThanOrEqual(quantity)
      expect([0, 1]).toContain(status)
      expect(status).toBe(remaining === 0 ? 0 : 1)
      totalRemaining += remaining
      if (status === 1 && remaining > 0) eligible += remaining
    }
    if (stock > 0) {
      expect(
        batches.some((batch) => Number(batch.status) === 1 && Number(batch.remaining) > 0),
      ).toBe(true)
    }
    expect(stock).toBe(eligible)
    expect(stock).toBe(totalRemaining)
  }
}

describe('#140 Phase A 开发种子批次事实闭环', () => {
  it.each(['test', 'development'])(
    'NODE_ENV=%s：种子在全新临时库落出全批次事实，库存=eligible批次求和',
    (nodeEnv) => {
      const directory = makeTempDir()
      const dbPath = join(directory, `seed-${nodeEnv}.db`)
      const run = runSeed({ NODE_ENV: nodeEnv, DATABASE_PATH: dbPath, JWT_SECRET: SEED_JWT_SECRET })

      expect(run.status).toBe(0)
      expect(run.output).toContain('验收测试数据初始化完成')
      expectSeededConservation(dbPath)

      // 精确夹具锚：入库 20 + 10，FEFO 出库 5 + 10 全部落在首批
      // → 首批 remaining 5、次批 remaining 10、库存 15。
      const material = queryAll(dbPath, "SELECT id FROM materials WHERE code = 'MAT-ACCEPT-001'")
      expect(material).toHaveLength(1)
      const materialId = material[0].id
      const batches = queryAll(
        dbPath,
        'SELECT quantity, remaining, status FROM batches WHERE material_id = ? ORDER BY batch_no',
        [materialId],
      )
      expect(batches.map((b) => [Number(b.quantity), Number(b.remaining), Number(b.status)])).toEqual([
        [20, 5, 1],
        [10, 10, 1],
      ])
      const stock = queryAll(dbPath, 'SELECT stock FROM inventory WHERE material_id = ?', [materialId])
      expect(Number(stock[0].stock)).toBe(15)
      const outboundQty = queryAll(dbPath, 'SELECT COALESCE(SUM(quantity), 0) AS total FROM outbound_items')
      expect(Number(outboundQty[0].total)).toBe(15)
      const logs = queryAll(dbPath, 'SELECT quantity FROM stock_logs ORDER BY rowid')
      expect(logs.map((log) => Number(log.quantity))).toEqual([20, 10, -5, -10])
    },
    180_000,
  )

  it('硬目标库守卫：拒绝覆盖既有业务库，哨兵数据原样保留且零夹具写入', () => {
    const directory = makeTempDir()
    const dbPath = join(directory, 'existing-business.db')

    // 用生产 initializeDatabase 建一个真实既有业务库，并写入与夹具不冲突的哨兵行。
    const bootstrap = runNode(
      [
        '--import', 'tsx', '--input-type=module', '--eval',
        "const m = await import('./src/database/DatabaseManager.js');"
        + ' m.initializeDatabase();'
        + ' const db = m.getDatabase();'
        + " db.prepare(\"INSERT INTO suppliers (id, code, name, status) VALUES ('SENTINEL-BIZ-001','SENTINEL-BIZ-001','既有业务供应商',1)\").run();",
      ],
      { NODE_ENV: 'test', DATABASE_PATH: dbPath, JWT_SECRET: SEED_JWT_SECRET },
    )
    expect(bootstrap.status).toBe(0)
    expect(existsSync(dbPath)).toBe(true)

    const run = runSeed({ NODE_ENV: 'test', DATABASE_PATH: dbPath, JWT_SECRET: SEED_JWT_SECRET })
    expect(run.status).not.toBe(0)
    expect(run.output).toContain('拒绝')

    // 哨兵原样保留，夹具一行都没写进去。
    const suppliers = queryAll(dbPath, 'SELECT code FROM suppliers ORDER BY code')
    expect(suppliers.map((row) => row.code)).toEqual(['SENTINEL-BIZ-001'])
    expect(queryAll(dbPath, "SELECT COUNT(*) AS c FROM materials WHERE code = 'MAT-ACCEPT-001'")[0].c).toBe(0)
    expect(queryAll(dbPath, 'SELECT COUNT(*) AS c FROM batches')[0].c).toBe(0)
    expect(queryAll(dbPath, 'SELECT COUNT(*) AS c FROM inventory')[0].c).toBe(0)
    expect(queryAll(dbPath, 'SELECT COUNT(*) AS c FROM inbound_records')[0].c).toBe(0)
    expect(queryAll(dbPath, 'SELECT COUNT(*) AS c FROM outbound_records')[0].c).toBe(0)
    expect(queryAll(dbPath, 'SELECT COUNT(*) AS c FROM stock_logs')[0].c).toBe(0)
  }, 180_000)

  it.each(['production', 'staging', ''])(
    'NODE_ENV=%j：非 development/test 环境拒绝执行且不创建目标库',
    (nodeEnv) => {
      const directory = makeTempDir()
      const dbPath = join(directory, 'must-not-exist.db')
      const run = runSeed({ NODE_ENV: nodeEnv, DATABASE_PATH: dbPath, JWT_SECRET: SEED_JWT_SECRET })
      expect(run.status).not.toBe(0)
      expect(run.output).toContain('development/test')
      expect(existsSync(dbPath)).toBe(false)
    },
    180_000,
  )
})
