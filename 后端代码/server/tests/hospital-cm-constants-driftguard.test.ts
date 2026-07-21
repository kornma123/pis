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
  currentHospitalCmFormulaBehaviorArtifact,
  HOSPITAL_CM_FORMULA_VERSION,
  CM_TARGET,
  CM_MARGIN_FOR_VARLABOR,
} from '../src/utils/hospital-cm.js'
import {
  PORTFOLIO_HEALTH_GATES_VERIFIED,
  REVIVAL_ACCOUNT_CAP,
  REVIVAL_UNMEASURED_SHARE,
  READINESS_MIN_CLOSED_PERIODS,
  READINESS_FOUNDATION_GATES,
  READINESS_PARAM_VERSION,
  DEFAULT_READINESS_OWNER,
} from '../src/utils/portfolio-health.js'
import { sha256 } from '../src/utils/hospital-cm-foundation-probes.js'
import {
  EXPECTED_HOSPITAL_CM_CONSTANT_MANIFEST_FINGERPRINT,
  HOSPITAL_CM_FOUNDATION_PROBE_VERSION,
} from '../src/utils/hospital-cm-foundation-probes.js'

describe('CM 引擎常量（改 = 立法）', () => {
  it('院级贡献毛利业务公式版本钉死；计算/上卷/成本装载语义变化必须 bump', () => {
    expect(HOSPITAL_CM_FORMULA_VERSION).toBe('2026-07-21.a')
  })
  it('地基探针版本钉死；探针判定语义变化必须 bump（#163 阶段2：合法跨月不再判 CROSS_MONTH_KEY_COLLISION）', () => {
    expect(HOSPITAL_CM_FOUNDATION_PROBE_VERSION).toBe('2026-07-20.a')
  })
  it('常量 manifest 指纹已随公式版本升级换锚：旧锚不得复活（旧证据必须失效重跑）', () => {
    expect(EXPECTED_HOSPITAL_CM_CONSTANT_MANIFEST_FINGERPRINT)
      .not.toBe('ee1698b353070e73323aaf5eac0bdba8b6050d22b296271948fa870290b4fca1')
  })
  it('计算与上卷的规范正反例行为签名钉死；实现变了但忘记 bump 也会先红灯', () => {
    expect(sha256(currentHospitalCmFormulaBehaviorArtifact()))
      .toBe('75d6583bde30791e7f9e4d0df2407d703be011ce2b4baab22b761d07a57d819f')
  })
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
  it('影子模式：全就绪谓词未绿 → GATES_VERIFIED=false（现在是 computeReadiness(现实态).ready·非手翻开关）', () => {
    expect(PORTFOLIO_HEALTH_GATES_VERIFIED).toBe(false)
  })
  it('复活双触发常量：可测账户数上限 30 · UNMEASURED 占比线 0.30', () => {
    expect(REVIVAL_ACCOUNT_CAP).toBe(30)
    expect(REVIVAL_UNMEASURED_SHARE).toBe(0.3)
  })
})

describe('LEG·就绪谓词政策参数登记（改 = 立法·具名+版本化·专家 Q4/§二/§六.5）', () => {
  it('就绪最小完整结算周期数 N=3（技术负责人签·系统时序参数）', () => {
    expect(READINESS_MIN_CLOSED_PERIODS).toBe(3)
  })
  it('数据地基门集 = {inventory_conservation, period_key, constant_freeze}（库存守恒/期间键/常量冻结·具名闭合）', () => {
    expect([...READINESS_FOUNDATION_GATES]).toEqual(['inventory_conservation', 'period_key', 'constant_freeze'])
  })
  it('阈值登记版本钉死 = 2026-07-13.a（改任一 READINESS_* 阈值/门集 = 同步 bump）', () => {
    expect(READINESS_PARAM_VERSION).toBe('2026-07-13.a')
  })
  it('「谁签什么」映射钉死（比例原则·denominator=business 不可代签·改 = 立法）', () => {
    expect(DEFAULT_READINESS_OWNER).toEqual({
      foundation: 'tech', // 系统时序·技术负责人
      denominator: 'business', // 碰钱/对外结论认账·业务决策方·不可代签
      history: 'pm', // 纯日历·具名推进人月度过
      first_period: 'tech', // 首周期校验·技术
    })
  })
})
