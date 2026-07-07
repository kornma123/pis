/**
 * P0 贡献毛利 + 组合体检 具名常量 drift-guard（§4c/§10.B·「照 C 域档1 立法」）。
 *
 * 目的：把四轮换来的触发器/阈值/影子闸**钉死**——改任一常量的 PR **必须同步改本测试**，
 *   强制「改口径 = 显式立法动作」（防有人无声调参、把复活触发器/影子模式偷偷改掉）。
 *
 * ⚠️ 改这里前先问：这是 PM 拍板的口径变更吗？是 → 连同变更留痕一起改；否 → 别动。
 */
import { describe, it, expect } from 'vitest'
import {
  P0_ANTIBODY_ADVICE_TYPES,
  SECONDARY_PER_SLIDE_DEFAULT,
  P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK,
  CM_THRESHOLDS,
  CM_TARGET,
  CM_MARGIN_FOR_VARLABOR,
} from '../src/utils/hospital-cm.js'
import {
  PORTFOLIO_HEALTH_GATES_VERIFIED,
  REVIVAL_ACCOUNT_CAP,
  REVIVAL_UNMEASURED_SHARE,
} from '../src/utils/portfolio-health.js'

describe('CM 引擎常量（改 = 立法）', () => {
  it('真抗体码白名单 = {Y000001, Y000003}（与 reconcile-account 同源）', () => {
    expect([...P0_ANTIBODY_ADVICE_TYPES].sort()).toEqual(['Y000001', 'Y000003'])
  })
  it('二抗显色默认 = ¥15（台账真价）', () => {
    expect(SECONDARY_PER_SLIDE_DEFAULT).toBe(15)
  })
  it('组织处理料 = ¥7/蜡块（PM 拍板·康湾台账校准·①*）', () => {
    expect(P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK).toBe(7)
  })
  it('数据质量/稳健层阈值保守默认', () => {
    expect(CM_THRESHOLDS).toEqual({
      MAX_MISSING_PRICE_RATE: 0.1,
      MAX_STAR_RATE: 0.6,
      MIN_COVERAGE: 0.85,
      MIN_LINE_COVERAGE: 0.7,
      MAX_UNSCOPED: 0.15,
      MAX_STAIN_PLACEHOLDER_RATE: 0.5,
      MIN_CASES_FOR_VERDICT: 20,
      PERSIST_MONTHS: 3,
    })
  })
  it('经营线常量恒 null（G-1·CM_TARGET 拍不了绝对单值·未 PM 拍板前不驱动强判定）', () => {
    expect(CM_TARGET).toBeNull()
    expect(CM_MARGIN_FOR_VARLABOR).toBeNull()
  })
})

describe('组合体检 / 复活常量（改 = 立法）', () => {
  it('影子模式：三门 A/B/C 未验收 → GATES_VERIFIED=false（翻 true 需三门落地 + 显式改此测试）', () => {
    expect(PORTFOLIO_HEALTH_GATES_VERIFIED).toBe(false)
  })
  it('复活双触发常量：可测账户数上限 30 · UNMEASURED 占比线 0.30', () => {
    expect(REVIVAL_ACCOUNT_CAP).toBe(30)
    expect(REVIVAL_UNMEASURED_SHARE).toBe(0.3)
  })
})
