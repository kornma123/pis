/**
 * RBAC Phase 0：SEED_MATRIX + parsePermissions helper（无接线，纯逻辑）
 */
import { describe, it, expect } from 'vitest'
import {
  SEED_MATRIX, MODULES, NON_ADMIN_ROLES, parsePermissions, adminAllPermissions,
  mergePermissions, hasLevel,
} from '../src/middleware/permissions.js'

describe('RBAC-P0：SEED_MATRIX 完整性', () => {
  it('30 个模块', () => {
    expect(MODULES.length).toBe(30)
    expect(new Set(MODULES).size).toBe(30) // 无重复
  })

  it('6 个非 admin 角色均有矩阵', () => {
    for (const r of NON_ADMIN_ROLES) expect(SEED_MATRIX[r]).toBeTruthy()
  })

  it('矩阵只用合法模块 + 合法 level', () => {
    for (const r of NON_ADMIN_ROLES) {
      for (const [mod, lvl] of Object.entries(SEED_MATRIX[r])) {
        expect(MODULES).toContain(mod)
        expect(['R', 'W']).toContain(lvl)
      }
    }
  })

  it('§8.2 关键纠正点：病理成本全空、技术员成本全空', () => {
    for (const costMod of ['cost_analysis', 'abc_dashboard', 'slide_cost', 'profitability']) {
      expect(SEED_MATRIX.pathologist[costMod]).toBeUndefined()
      expect(SEED_MATRIX.technician[costMod]).toBeUndefined()
    }
  })

  it('§8.2 财务=成本 W；BOM 主任/技术 W；检测项目 财务/技术/病理 W；采购 物料成本分析 R；设备 主任/技术/财务 W', () => {
    expect(SEED_MATRIX.finance.abc_dashboard).toBe('W')
    expect(SEED_MATRIX.finance.profitability).toBe('W')
    expect(SEED_MATRIX.lab_director.bom).toBe('W')
    expect(SEED_MATRIX.technician.bom).toBe('W')
    expect(SEED_MATRIX.finance.projects).toBe('W')
    expect(SEED_MATRIX.technician.projects).toBe('W')
    expect(SEED_MATRIX.pathologist.projects).toBe('W')
    expect(SEED_MATRIX.procurement.cost_analysis).toBe('R')
    expect(SEED_MATRIX.lab_director.equipment).toBe('W')
    expect(SEED_MATRIX.technician.equipment).toBe('W')
    expect(SEED_MATRIX.finance.equipment).toBe('W')
  })

  it('§8.2 病理 库存/预警 = R（保留只读）；对账 病理 = 无', () => {
    expect(SEED_MATRIX.pathologist.inventory).toBe('R')
    expect(SEED_MATRIX.pathologist.alerts).toBe('R')
    expect(SEED_MATRIX.pathologist.reconciliation).toBeUndefined()
  })

  it('adminAllPermissions = 全模块 W', () => {
    const all = adminAllPermissions()
    expect(Object.keys(all).length).toBe(30)
    expect(Object.values(all).every((v) => v === 'W')).toBe(true)
  })
})

describe('RBAC-P0：parsePermissions 双形态', () => {
  it('对象形态直接用', () => {
    expect(parsePermissions({ inventory: 'R', bom: 'W' })).toEqual({ inventory: 'R', bom: 'W' })
  })
  it('JSON 字符串(对象)', () => {
    expect(parsePermissions('{"inventory":"W"}')).toEqual({ inventory: 'W' })
  })
  it('旧扁平数组 → 列出码视为 W', () => {
    expect(parsePermissions(['inventory', 'bom'])).toEqual({ inventory: 'W', bom: 'W' })
  })
  it("数组含 '*' → 全 W", () => {
    expect(Object.keys(parsePermissions(['*'])).length).toBe(30)
  })
  it('空/非法 → {}', () => {
    expect(parsePermissions('')).toEqual({})
    expect(parsePermissions(null)).toEqual({})
    expect(parsePermissions('not-json')).toEqual({})
  })
  it('过滤非法模块/level', () => {
    expect(parsePermissions({ inventory: 'R', bogus: 'W', bom: 'X' })).toEqual({ inventory: 'R' })
  })
})

describe('RBAC-P0：mergePermissions / hasLevel', () => {
  it('并集 W 优先', () => {
    const m = mergePermissions({ inventory: 'R', bom: 'R' }, { inventory: 'W', alerts: 'R' })
    expect(m.inventory).toBe('W')
    expect(m.bom).toBe('R')
    expect(m.alerts).toBe('R')
  })
  it('hasLevel：W 蕴含 R', () => {
    expect(hasLevel({ bom: 'W' }, 'bom', 'R')).toBe(true)
    expect(hasLevel({ bom: 'W' }, 'bom', 'W')).toBe(true)
    expect(hasLevel({ bom: 'R' }, 'bom', 'W')).toBe(false)
    expect(hasLevel({ bom: 'R' }, 'bom', 'R')).toBe(true)
    expect(hasLevel({}, 'bom', 'R')).toBe(false)
  })
})
