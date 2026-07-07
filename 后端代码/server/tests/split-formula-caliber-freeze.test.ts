/**
 * 拆分公式常量冻结 + 口径印记 drift-guard（非-P0 审计项 C · 档1）。
 *
 * 背景：SPLIT_DIAG_FEE=105 是拆分公式（范围内 vs 范围外份额分界）的固定分母项，也是对外「高估约 2 倍」结论的
 * 唯一来源。「只看趋势」语境下真正致命的是它**中途被人悄改致趋势断层无标注**。本测试把它与公式版本**钉死**：
 * 任何改动 SPLIT_DIAG_FEE / 拆分公式的 PR **必须同步改这里的钉死值 + bump SPLIT_FORMULA_VERSION**，
 * 强制「改口径 = 显式立法动作」（红→绿：直接改 105 而不改本测试 → 立即翻红）。
 */
import { describe, it, expect } from 'vitest'
import { SPLIT_DIAG_FEE, SPLIT_FORMULA_VERSION, computeStatementRevenue } from '../src/utils/statement-revenue.js'
import { DIAGNOSIS_ANCHOR_DEFAULT } from '../src/utils/antibody-cost.js'
import { caliberSignature, seedDefaultConfig } from '../src/utils/partner-config.js'

describe('C · 拆分公式常量冻结（改值必显式立法）', () => {
  it('SPLIT_DIAG_FEE 钉死 105；SPLIT_FORMULA_VERSION 钉死当前版本', () => {
    // ⚠️ 立法耦合：改 SPLIT_DIAG_FEE（下一行）时，**必须同时 bump SPLIT_FORMULA_VERSION**（再下一行）——
    //    两个断言分列是为了各自钉死值，但语义上「改口径」= 二者一起改（口径变而版本不变 = 趋势打标失效）。
    expect(SPLIT_DIAG_FEE).toBe(105)
    expect(SPLIT_FORMULA_VERSION).toBe('2026-07-06.a')
  })

  it('收入侧 SPLIT_DIAG_FEE 与成本侧 DIAGNOSIS_ANCHOR_DEFAULT 一致（两处 105 不漂移）', () => {
    expect(SPLIT_DIAG_FEE).toBe(DIAGNOSIS_ANCHOR_DEFAULT)
  })

  it('caliberSignature 纳入全局公式常量+版本（改 105/公式版本 → 签名变，可被写门禁/追溯感知）', () => {
    const cfg = seedDefaultConfig()
    const sig = caliberSignature(cfg)
    const parsed = JSON.parse(sig)
    expect(parsed.formula).toEqual({ splitDiagFee: 105, formulaVersion: '2026-07-06.a' })
    expect(Array.isArray(parsed.lines)).toBe(true)
  })

  it('computeStatementRevenue 结果透出 caliber 印记（供落库/趋势对相邻两期 diff 打标）', () => {
    const rev = computeStatementRevenue([], seedDefaultConfig())
    expect(rev.caliber).toEqual({ splitDiagFee: 105, formulaVersion: '2026-07-06.a' })
  })
})
