/**
 * 弱锚闸回归门禁（非-P0 审计项 F · 绿档1）——「未校准的成本合计禁入毛利/去留计算」。
 *
 * 背景：单片全成本 total 无条件含工时/设备 G2 估弱锚（antibody-cost.ts computeFullSlideCost）。今天安全**仅因**它是
 * 孤立只读展示层、未进毛利/去留（唯一消费者 antibody-cost-v1.1.ts:208 不入库不喂毛利）。把 P0 教训（弱锚占位当真值
 * 传播）**在复发前立法**：forMargin 守卫在类型层 + 运行期挡住未校准 total 进毛利/去留——毛利计算只接受 CalibratedCost。
 */
import { describe, it, expect } from 'vitest'
import { forMargin, computeFullSlideCost, DEFAULT_IHC_COST_PARAMS } from '../src/utils/antibody-cost.js'

const calParams = (labor: boolean, equip: boolean) => ({ ...DEFAULT_IHC_COST_PARAMS, laborCalibrated: labor, equipmentCalibrated: equip })

describe('F 绿档1 · 弱锚闸：未校准成本禁入毛利/去留', () => {
  it('WA-1 默认 G2 估 breakdown → forMargin 抛错（拒未校准进毛利）', () => {
    const bd = computeFullSlideCost({ perTestPrice: 10 } as any)
    expect(bd.laborEquipmentSource).toBe('G2估')
    expect(() => forMargin(bd)).toThrow(/未校准/)
  })
  it('WA-2 部分校准（只一半）→ forMargin 抛错', () => {
    const bd = computeFullSlideCost({ perTestPrice: 10 } as any, calParams(true, false))
    expect(bd.laborEquipmentSource).toBe('部分校准')
    expect(() => forMargin(bd)).toThrow()
  })
  it('WA-3 两半都校准 → forMargin 放行，返回 CalibratedCost{total,calibrated:true}', () => {
    const bd = computeFullSlideCost({ perTestPrice: 10 } as any, calParams(true, true))
    expect(bd.laborEquipmentSource).toBe('已校准')
    expect(forMargin(bd)).toEqual({ total: bd.total, calibrated: true })
  })
  it('WA-4 直接构造未校准 total 也被拦（守卫只认 laborEquipmentSource，防绕过取 total）', () => {
    expect(() => forMargin({ total: 999, laborEquipmentSource: 'G2估' })).toThrow()
    expect(() => forMargin({ total: 999, laborEquipmentSource: '部分校准' })).toThrow()
    expect(forMargin({ total: 999, laborEquipmentSource: '已校准' })).toEqual({ total: 999, calibrated: true })
  })
})
