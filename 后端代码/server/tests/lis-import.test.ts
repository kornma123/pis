/**
 * lis-import（W3 规范化）单测 —— 用真实「病例导出文档」形态的行验证：
 *  6 数量列解析、医院名、自动样本类型判定（组织 vs 细胞学）、有效行判定。
 */
import { describe, it, expect } from 'vitest'
import { normalizeLisRow, isValidLisRow, toLisCaseQty } from '../src/utils/lis-import.js'

describe('normalizeLisRow：真实 LIS 行 → 规范化', () => {
  it('组织 case（和睦家 宫颈，HE5/蜡块5/IHC2）→ 数量对 + 自动判 tissue', () => {
    const c = normalizeLisRow({
      病理号: 'S26-02725', 送检医院: '上海和睦家医院', 缴费方式: '合作医院收费', 病例状态: '已签发',
      送检部位: '宫颈3点cervical 3 o\'clock', 蜡块数: 5, HE切片数: 5, 免疫组化数: 2, 特染数: 0, EBER数: 0, 'PD-L1数': 0,
      登记时间: '2026-06-05 15:38:39',
    })
    expect(c.caseNo).toBe('S26-02725')
    expect(c.partnerName).toBe('上海和睦家医院')
    expect(c.blockCount).toBe(5)
    expect(c.heSlideCount).toBe(5)
    expect(c.ihcCount).toBe(2)
    expect(c.autoSpecimenType).toBe('tissue')
  })

  it('细胞学 case（胸腔积液 + 细胞蜡块）→ 自动判 cytology', () => {
    const c = normalizeLisRow({
      病理号: 'X26-00150', 送检医院: '上海和睦家医院', 送检部位: '右侧胸腔积液',
      大体描述: '离心得到沉淀，加入琼脂制成细胞蜡块', 蜡块数: 3, HE切片数: 3, 免疫组化数: 12,
    })
    expect(c.autoSpecimenType).toBe('cytology')
    expect(c.ihcCount).toBe(12)
  })

  it('数量缺省/非数字 → 0；isValidLisRow 需 caseNo + 医院', () => {
    const c = normalizeLisRow({ 病理号: 'X26-00152', 送检医院: '上海中大肿瘤医院' })
    expect(c.blockCount).toBe(0)
    expect(c.ihcCount).toBe(0)
    expect(isValidLisRow(c)).toBe(true)
    expect(isValidLisRow(normalizeLisRow({ 病理号: '', 送检医院: '' }))).toBe(false)
    expect(isValidLisRow(normalizeLisRow({ 病理号: 'X1' }))).toBe(false) // 缺医院
  })

  it('小数数量四舍五入为整数，不被 parseInt 剥成 ×10（对抗审查 critical 修复）', () => {
    const c = normalizeLisRow({ 病理号: 'A', 送检医院: 'H', 蜡块数: '10.5', HE切片数: '5.2', 免疫组化数: '3' })
    expect(c.blockCount).toBe(11) // 非 105
    expect(c.heSlideCount).toBe(5) // 非 52
    expect(c.ihcCount).toBe(3)
    expect(normalizeLisRow({ 病理号: 'A', 送检医院: 'H', 蜡块数: '7' }).blockCount).toBe(7)
  })

  it('toLisCaseQty：带入指定 specimenType，喂给 mapCaseToCharges', () => {
    const c = normalizeLisRow({ 病理号: 'A', 送检医院: 'H', 蜡块数: 2, 免疫组化数: 4 })
    const q = toLisCaseQty(c, 'tissue')
    expect(q).toMatchObject({ blockCount: 2, ihcCount: 4, specimenType: 'tissue' })
  })
})
