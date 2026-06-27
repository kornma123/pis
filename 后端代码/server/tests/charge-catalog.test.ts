/**
 * 收费目录种子（charge-catalog）单测 —— 逐条用真实目录价验证 seed 规则编码；DB 落库/读取 roundtrip。
 * 价格全部取自《20260605 病理类项目收费代码-YZ.xlsx》新增81项。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import {
  CHARGE_CODE_SEED, buildSeedCatalog, chargeDefToRow, rowToChargeDef, loadChargeCatalog,
} from '../src/utils/charge-catalog.js'
import { computeCharge } from '../src/utils/charge-engine.js'

const SEED = buildSeedCatalog()
const rule = (code: string) => SEED.get(code)!.rule
const amt = (code: string, qty: number) => computeCharge(rule(code), qty)

describe('charge-catalog：seed 逐条价格 = 真实目录价', () => {
  it('诊断费 012100000010000：8张105 / 15张147 / 25张189(封顶)', () => {
    expect(amt('012100000010000', 8)).toBe(105)
    expect(amt('012100000010000', 15)).toBe(147)
    expect(amt('012100000010000', 25)).toBe(189)
  })
  it('处理费组织常规 012100000030000：1块36 / 5块50 / 20块108(封顶)', () => {
    expect(amt('012100000030000', 1)).toBe(36)
    expect(amt('012100000030000', 5)).toBe(50)
    expect(amt('012100000030000', 20)).toBe(108)
  })
  it('处理费组织复杂 012100000040000：5块72 / 7块100', () => {
    expect(amt('012100000040000', 5)).toBe(72)
    expect(amt('012100000040000', 7)).toBe(100)
  })
  it('细胞处理 012100000050000：¥75/玻片 × 2 = 150；细胞蜡块制作 012100000090000：¥40 × 3 = 120', () => {
    expect(amt('012100000050000', 2)).toBe(150)
    expect(amt('012100000090000', 3)).toBe(120)
  })
  it('IHC常规 012100000120000：4片825 / 13片2610', () => {
    expect(amt('012100000120000', 4)).toBe(825)
    expect(amt('012100000120000', 13)).toBe(2610)
  })
  it('IHC增强 012100000130000：1片650 / 4片 650×3+655 = 2605', () => {
    expect(amt('012100000130000', 1)).toBe(650)
    expect(amt('012100000130000', 4)).toBe(2605)
  })
  it('特殊染色 012100000110000：1片80 / 4片 80×3+85 = 325', () => {
    expect(amt('012100000110000', 1)).toBe(80)
    expect(amt('012100000110000', 4)).toBe(325)
  })
  it('原位杂交化学探针 012100000140000：1片223 / 4片 223×3+228 = 897', () => {
    expect(amt('012100000140000', 1)).toBe(223)
    expect(amt('012100000140000', 4)).toBe(897)
  })
  it('切片复制 012100000100000：5片 7×3+12×2 = 45 / 封顶165', () => {
    expect(amt('012100000100000', 5)).toBe(45)
    expect(amt('012100000100000', 1000)).toBe(165)
  })
  it('取材费 flat：钳夹113 / Ⅲ类穿刺360 / 内镜200', () => {
    expect(amt('011201000010000', 1)).toBe(113)
    expect(amt('011201000040000', 1)).toBe(360)
    expect(amt('011201000080000', 1)).toBe(200)
  })
  it('分类正确：诊断费=诊断 / 取材费=取材 / 染色处理=技术', () => {
    expect(SEED.get('012100000010000')!.category).toBe('诊断')
    expect(SEED.get('011201000010000')!.category).toBe('取材')
    expect(SEED.get('012100000120000')!.category).toBe('技术')
  })
})

describe('charge-catalog：row <-> def roundtrip', () => {
  it('chargeDefToRow → rowToChargeDef 还原规则不丢', () => {
    for (const def of CHARGE_CODE_SEED) {
      const back = rowToChargeDef(chargeDefToRow(def))
      expect(back.code).toBe(def.code)
      expect(back.category).toBe(def.category)
      expect(back.rule).toEqual(def.rule)
    }
  })
})

describe('charge-catalog：loadChargeCatalog 从 DB 读取', () => {
  let db: any
  beforeAll(async () => { db = await getDb() })

  it('charge_codes 表已 seed 全部 v1 常见档', () => {
    const count = (db.prepare(`SELECT COUNT(*) c FROM charge_codes WHERE status='active'`).get() as { c: number }).c
    expect(count).toBe(CHARGE_CODE_SEED.length)
  })
  it('loadChargeCatalog 返回可用 Map，且 DB 规则与 seed 求值一致', () => {
    const fromDb = loadChargeCatalog(db)
    expect(fromDb.size).toBe(CHARGE_CODE_SEED.length)
    // DB 读出的诊断/IHC 规则计算应与种子一致
    expect(computeCharge(fromDb.get('012100000010000')!.rule, 25)).toBe(189)
    expect(computeCharge(fromDb.get('012100000120000')!.rule, 4)).toBe(825)
  })
})
