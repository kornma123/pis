/**
 * NGS 产品参考目录单测 —— 种子价格照截图 + DB seed/读取 roundtrip。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import { NGS_PRODUCT_SEED, loadNgsCatalog } from '../src/utils/ngs-catalog.js'

describe('ngs-catalog：种子价格照截图', () => {
  it('种子非空，关键产品 指导价/协议价 = 截图', () => {
    expect(NGS_PRODUCT_SEED.length).toBeGreaterThanOrEqual(18)
    const crc = NGS_PRODUCT_SEED.find((p) => p.productName.includes('结直肠'))!
    expect(crc.guidePrice).toBe(8500)
    expect(crc.agreementPrice).toBe(1350)
    const thy = NGS_PRODUCT_SEED.find((p) => p.productName.includes('甲状腺癌核心'))!
    expect(thy.guidePrice).toBe(4500)
    expect(thy.agreementPrice).toBe(850)
    const endo = NGS_PRODUCT_SEED.find((p) => p.productName.includes('加强版'))!
    expect(endo.guidePrice).toBe(5000)
    expect(endo.agreementPrice).toBe(950)
  })
})

describe('ngs-catalog：loadNgsCatalog 从 DB 读取', () => {
  let db: any
  beforeAll(async () => { db = await getDb() })

  it('ngs_products 已 seed 全部参考档，可读回', () => {
    const map = loadNgsCatalog(db)
    expect(map.size).toBe(NGS_PRODUCT_SEED.length)
    expect(map.get('结直肠癌个性化用药套餐（119基因）')!.agreementPrice).toBe(1350)
    expect(map.get('结直肠癌个性化用药套餐（119基因）')!.guidePrice).toBe(8500)
  })
})
