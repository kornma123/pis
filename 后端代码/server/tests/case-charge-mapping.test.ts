/**
 * case→charges 映射（case-charge-mapping）单测 —— 锁定口径（2026-06-27）：
 *  诊断←HE切片数 / 处理费按样本类型分流 / IHC常规←免疫组化数 / IHC增强←PD-L1数 / 特染←特染数 / ISH←EBER数。
 * 用真实 LIS 形态的 case 走「映射 → computeCaseSplit → 技术占比」全链。
 */
import { describe, it, expect } from 'vitest'
import { detectSpecimenType, mapCaseToCharges, CHARGE_CODE, type LisCaseQty } from '../src/utils/case-charge-mapping.js'
import { computeCaseSplit } from '../src/utils/charge-engine.js'
import { buildSeedCatalog } from '../src/utils/charge-catalog.js'

const CATALOG = buildSeedCatalog()
const zero: LisCaseQty = { heSlideCount: 0, blockCount: 0, ihcCount: 0, specialStainCount: 0, eberCount: 0, pdl1Count: 0 }

describe('detectSpecimenType（关键词自动判，默认组织）', () => {
  it('胸水/腹水/积液/细胞蜡块/涂片 → 细胞学', () => {
    expect(detectSpecimenType({ 送检部位: '胸水' })).toBe('cytology')
    expect(detectSpecimenType({ 送检部位: '右侧胸腔积液' })).toBe('cytology')
    expect(detectSpecimenType({ 大体描述: '收到液体…制成细胞蜡块' })).toBe('cytology')
    expect(detectSpecimenType({ 大体描述: '常规涂片1张' })).toBe('cytology')
  })
  it('实体组织/无关键词 → 组织（默认）', () => {
    expect(detectSpecimenType({ 送检部位: '左颈部淋巴结' })).toBe('tissue')
    expect(detectSpecimenType({ 送检部位: '乳腺肿物', 大体描述: '灰白组织一块' })).toBe('tissue')
    expect(detectSpecimenType({})).toBe('tissue')
  })
  it('不误杀「腹腔镜活检/胸壁穿刺」实体组织为细胞学（对抗审查 HIGH 修复）', () => {
    expect(detectSpecimenType({ 送检部位: '腹腔镜活检' })).toBe('tissue')
    expect(detectSpecimenType({ 送检部位: '胸壁穿刺组织' })).toBe('tissue')
    expect(detectSpecimenType({ 大体描述: '盆腔肿物' })).toBe('tissue')
  })
})

describe('mapCaseToCharges（只对 >0 数量产出收费项）', () => {
  it('全 0 → 空（无收费项）', () => {
    expect(mapCaseToCharges(zero)).toEqual([])
  })

  it('组织 IHC case：HE3/蜡块3/IHC12 → 诊断+组织处理+IHC常规', () => {
    const items = mapCaseToCharges({ ...zero, heSlideCount: 3, blockCount: 3, ihcCount: 12, specimenType: 'tissue' })
    expect(items).toEqual([
      { code: CHARGE_CODE.DIAGNOSIS, qty: 3 },
      { code: CHARGE_CODE.PROC_TISSUE_STD, qty: 3 },
      { code: CHARGE_CODE.IHC_STD, qty: 12 },
    ])
  })

  it('细胞学积液 case：HE2/蜡块1 → 诊断+细胞蜡块制作+细胞处理', () => {
    const items = mapCaseToCharges({ ...zero, heSlideCount: 2, blockCount: 1, specimenType: 'cytology' })
    expect(items).toEqual([
      { code: CHARGE_CODE.DIAGNOSIS, qty: 2 },
      { code: CHARGE_CODE.CYTOLOGY_BLOCK, qty: 1 },
      { code: CHARGE_CODE.PROC_CYTOLOGY, qty: 1 },
    ])
  })

  it('组织复杂(tissue_complex)→复杂处理费(¥72/5块基础)，区别于常规', () => {
    const items = mapCaseToCharges({ ...zero, blockCount: 5, specimenType: 'tissue_complex' })
    expect(items).toEqual([{ code: CHARGE_CODE.PROC_TISSUE_CX, qty: 5 }])
  })

  it('PD-L1→IHC增强；EBER→原位杂交化学探针；特染→特殊染色（各自独立列）', () => {
    const items = mapCaseToCharges({ ...zero, blockCount: 1, ihcCount: 5, pdl1Count: 1, eberCount: 2, specialStainCount: 1, specimenType: 'tissue' })
    expect(items).toContainEqual({ code: CHARGE_CODE.IHC_STD, qty: 5 })
    expect(items).toContainEqual({ code: CHARGE_CODE.IHC_ENHANCED, qty: 1 })
    expect(items).toContainEqual({ code: CHARGE_CODE.ISH_CHEMICAL, qty: 2 })
    expect(items).toContainEqual({ code: CHARGE_CODE.SPECIAL_STAIN, qty: 1 })
  })

  it('多重染色/冰冻 两列（院内、LIS 补列后）→ 各自独立收费项', () => {
    const items = mapCaseToCharges({ ...zero, multiplexCount: 2, frozenBlockCount: 3 })
    expect(items).toContainEqual({ code: CHARGE_CODE.MULTIPLEX, qty: 2 })
    expect(items).toContainEqual({ code: CHARGE_CODE.FROZEN_PROC, qty: 3 })
  })

  it('多重染色与常规 IHC 分列并存（上游须把多重切片从 ihcCount 剔除）', () => {
    const items = mapCaseToCharges({ ...zero, ihcCount: 5, multiplexCount: 2, specimenType: 'tissue' })
    expect(items).toContainEqual({ code: CHARGE_CODE.IHC_STD, qty: 5 })
    expect(items).toContainEqual({ code: CHARGE_CODE.MULTIPLEX, qty: 2 })
  })

  it('两列缺省（当前真实 LIS 形态，无这两列）→ 不产出对应收费项（零回归）', () => {
    const items = mapCaseToCharges({ ...zero, heSlideCount: 3, blockCount: 3, ihcCount: 12, specimenType: 'tissue' })
    expect(items.some((i) => [CHARGE_CODE.MULTIPLEX, CHARGE_CODE.FROZEN_PROC].includes(i.code as never))).toBe(false)
  })
})

describe('全链：mapCaseToCharges → computeCaseSplit → 技术占比', () => {
  it('组织 IHC case（HE3/蜡块3/IHC12）：技术2541 / 诊断105 / 技术占比≈0.9603', () => {
    const split = computeCaseSplit(
      mapCaseToCharges({ ...zero, heSlideCount: 3, blockCount: 3, ihcCount: 12, specimenType: 'tissue' }),
      CATALOG,
    )
    // 诊断 ¥105(3张) + 组织处理 ¥36(3块) + IHC ¥2505(12片=205×3+210×9)
    expect(split.byCategory.诊断).toBe(105)
    expect(split.byCategory.技术).toBe(2541)
    expect(split.total).toBe(2646)
    expect(split.techRatio).toBeCloseTo(0.9603, 4)
  })

  it('细胞学积液 case（HE2/蜡块1）：技术115 / 诊断105 / 技术占比≈0.5227', () => {
    const split = computeCaseSplit(
      mapCaseToCharges({ ...zero, heSlideCount: 2, blockCount: 1, specimenType: 'cytology' }),
      CATALOG,
    )
    // 诊断 ¥105(2张) + 细胞蜡块制作 ¥40 + 细胞处理 ¥75 = 技术115
    expect(split.byCategory.诊断).toBe(105)
    expect(split.byCategory.技术).toBe(115)
    expect(split.techRatio).toBeCloseTo(0.5227, 4)
  })

  it('纯技术 case（无 HE 切片→无诊断）：技术占比 = 1.0', () => {
    const split = computeCaseSplit(
      mapCaseToCharges({ ...zero, blockCount: 2, ihcCount: 4, specimenType: 'tissue' }),
      CATALOG,
    )
    expect(split.byCategory.诊断).toBe(0)
    expect(split.techRatio).toBe(1)
  })
})
