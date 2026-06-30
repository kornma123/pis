/**
 * 按医院成本/盈利 P0：schema + RBAC 模块注册（仅 ADD，幂等）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { MODULES, SEED_MATRIX } from '../src/middleware/rbac-matrix.js'

let db: any
function cols(t: string): string[] {
  return (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name)
}
beforeAll(async () => { db = await getDb() })

describe('partner-P0：schema', () => {
  it('partners 表存在 + 关键列', () => {
    expect(cols('partners')).toEqual(expect.arrayContaining(['id', 'code', 'name', 'service_scope', 'status', 'is_deleted']))
  })
  it('lis_cases / outbound_abc_details 加 partner_id', () => {
    expect(cols('lis_cases')).toContain('partner_id')
    expect(cols('outbound_abc_details')).toContain('partner_id')
  })
  it('partners.code UNIQUE 生效', () => {
    db.prepare("INSERT INTO partners (id, code, name) VALUES ('PT-1','H001','测试医院A')").run()
    expect(() => db.prepare("INSERT INTO partners (id, code, name) VALUES ('PT-2','H001','重复code')").run()).toThrow()
    db.prepare("DELETE FROM partners WHERE id='PT-1'").run()
  })
  it('幂等：重复 init 不抛', async () => {
    const mod = await import('../src/database/DatabaseManager.js')
    expect(() => mod.initializeDatabase()).not.toThrow()
  })
})

describe('partner-P0：RBAC 模块注册', () => {
  it('MODULES 含 partners/partner_pricing（共 29）', () => {
    expect(MODULES).toContain('partners')
    expect(MODULES).toContain('partner_pricing')
    expect(MODULES.length).toBe(29)
  })
  it('种子：lab_director 定价 W；finance 定价 W、客户 R', () => {
    expect(SEED_MATRIX.lab_director.partner_pricing).toBe('W')
    expect(SEED_MATRIX.lab_director.partners).toBe('W')
    expect(SEED_MATRIX.finance.partner_pricing).toBe('W')
    expect(SEED_MATRIX.finance.partners).toBe('R')
  })
  it('诊断/技术线无定价权（pathologist/technician 无 partner_pricing）', () => {
    expect(SEED_MATRIX.pathologist.partner_pricing).toBeUndefined()
    expect(SEED_MATRIX.technician.partner_pricing).toBeUndefined()
  })
})
