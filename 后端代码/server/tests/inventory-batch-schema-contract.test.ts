/**
 * #140 Phase B — 全新 canonical schema 批次事实 CHECK 合同测试。
 *
 * 合同（TASK-CONTRACT §5.B）：生产 initializeDatabase() 建出的全新库必须拒绝
 * 以下非法库存事实（直接 SQL 证明，非源码正则）：
 * - inventory.stock < 0；
 * - batches.quantity < 0；
 * - batches.remaining 越界（< 0 或 > quantity）；
 * - batches.status 非 0/1；
 * - remaining > 0 但 status = 0（inactive-positive）；
 * - remaining = 0 但 status = 1（active-exhausted 方向反了）。
 * 合法事实保持有效：零库存、耗尽批次（remaining=0/status=0/quantity=0 亦可）、
 * 正库存批次、零价格批次。
 *
 * 本测试只用一次性临时绝对库，绝不触碰 tracked dev 库或任何真实库。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'coreone-schema-contract-'))
process.env.DATABASE_PATH = join(tempDir, 'fresh-canonical.db')
process.env.JWT_SECRET = process.env.JWT_SECRET || 'schema-contract-only-9x'.repeat(4)

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync

beforeAll(async () => {
  const mod = await import('../src/database/DatabaseManager.js')
  mod.initializeDatabase()
  db = mod.getDatabase()
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

let sequence = 0
function ids() {
  sequence += 1
  return {
    material: `SCHEMA-MAT-${sequence}`,
    batch: `SCHEMA-BATCH-${sequence}`,
    inbound: `SCHEMA-INBOUND-${sequence}`,
    inventory: `SCHEMA-INV-${sequence}`,
  }
}

function insertInventory(stock: number) {
  const id = ids()
  db.prepare('INSERT INTO inventory (id, material_id, stock) VALUES (?, ?, ?)')
    .run(id.inventory, id.material, stock)
}

function insertBatch(facts: { quantity: number; remaining: number; status: number; price?: number }) {
  const id = ids()
  db.prepare(
    `INSERT INTO batches (id, material_id, batch_no, quantity, remaining, inbound_id, inbound_price, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id.batch, id.material, id.batch, facts.quantity, facts.remaining, id.inbound, facts.price ?? 0, facts.status)
}

describe('#140 Phase B 全新 canonical schema 批次事实 CHECK', () => {
  it('拒绝负 inventory.stock', () => {
    expect(() => insertInventory(-1)).toThrow(/CHECK constraint failed/)
  })

  it('拒绝负 batches.quantity', () => {
    expect(() => insertBatch({ quantity: -1, remaining: 0, status: 0 })).toThrow(/CHECK constraint failed/)
  })

  it('拒绝负 batches.remaining', () => {
    expect(() => insertBatch({ quantity: 5, remaining: -1, status: 1 })).toThrow(/CHECK constraint failed/)
    expect(() => insertBatch({ quantity: 5, remaining: -1, status: 0 })).toThrow(/CHECK constraint failed/)
  })

  it('拒绝 remaining > quantity', () => {
    expect(() => insertBatch({ quantity: 3, remaining: 5, status: 1 })).toThrow(/CHECK constraint failed/)
  })

  it('拒绝非 0/1 的 batches.status', () => {
    expect(() => insertBatch({ quantity: 5, remaining: 5, status: 2 })).toThrow(/CHECK constraint failed/)
    expect(() => insertBatch({ quantity: 5, remaining: 0, status: 2 })).toThrow(/CHECK constraint failed/)
  })

  it('拒绝 remaining>0 但 status=0（inactive 批次带正剩余）', () => {
    expect(() => insertBatch({ quantity: 5, remaining: 5, status: 0 })).toThrow(/CHECK constraint failed/)
  })

  it('拒绝 remaining=0 但 status=1（active 批次却零剩余）', () => {
    expect(() => insertBatch({ quantity: 5, remaining: 0, status: 1 })).toThrow(/CHECK constraint failed/)
  })

  it('合法事实保持有效：零库存/耗尽批次/正批次/零价格/零数量耗尽批次', () => {
    expect(() => insertInventory(0)).not.toThrow()
    expect(() => insertInventory(15)).not.toThrow()
    expect(() => insertBatch({ quantity: 10, remaining: 0, status: 0 })).not.toThrow()
    expect(() => insertBatch({ quantity: 0, remaining: 0, status: 0 })).not.toThrow()
    expect(() => insertBatch({ quantity: 10, remaining: 7, status: 1 })).not.toThrow()
    expect(() => insertBatch({ quantity: 10, remaining: 10, status: 1, price: 0 })).not.toThrow()
  })
})
