/**
 * 拆分口径认账 · 止损执法层单测（LEG-2 / 公理一）。
 *
 * 守：① 当前恒 UNRATIFIED（工程侧无路径把它置 RATIFIED——认账不可代签）；
 *     ② 水印/声明 basisVersion 钉在既有 SPLIT_FORMULA_VERSION（不另立版本源，drift-guard 一处守）；
 *     ③ 导出声明列齐全且逐行随行（剥不掉）；④ sourceTag=derived（拆分是派生结论）。
 */
import { describe, it, expect } from 'vitest'
import {
  splitCaliberRatification,
  buildExportDeclaration,
  decorateExportRows,
  EXPORT_DECLARATION_COLUMNS,
  SPLIT_CALIBER_RATIFICATION,
  SPLIT_CALIBER_SOURCE_TAG,
  SPLIT_CALIBER_WATERMARK_LABEL,
} from '../src/utils/caliber-ratification.js'
import { SPLIT_DIAG_FEE, SPLIT_FORMULA_VERSION } from '../src/utils/statement-revenue.js'

describe('splitCaliberRatification（响应水印）', () => {
  it('当前恒 UNRATIFIED：ratified=false + state=UNRATIFIED + ratifiedAt=null', () => {
    const r = splitCaliberRatification()
    expect(SPLIT_CALIBER_RATIFICATION).toBe('UNRATIFIED') // 只读占位·无状态机
    expect(r.ratified).toBe(false)
    expect(r.state).toBe('UNRATIFIED')
    expect(r.ratifiedAt).toBeNull()
  })

  it('水印徽标 = 「口径未经业务认账」·与数字同视线渲染的文案', () => {
    expect(splitCaliberRatification().label).toBe(SPLIT_CALIBER_WATERMARK_LABEL)
    expect(SPLIT_CALIBER_WATERMARK_LABEL).toBe('口径未经业务认账')
  })

  it('basisVersion 钉在既有 SPLIT_FORMULA_VERSION（不另立版本源）', () => {
    expect(splitCaliberRatification().basisVersion).toBe(SPLIT_FORMULA_VERSION)
  })

  it('sourceTag=derived（拆分是政策常量派生结论，非实测）', () => {
    expect(splitCaliberRatification().sourceTag).toBe('derived')
    expect(SPLIT_CALIBER_SOURCE_TAG).toBe('derived')
  })

  it('note 点名 SPLIT_DIAG_FEE 与「高估约2倍/不得单独支撑对外结论」', () => {
    const note = splitCaliberRatification().note
    expect(note).toContain(String(SPLIT_DIAG_FEE))
    expect(note).toContain('不得单独支撑对外结论')
  })

  it('纯函数·无副作用：两次调用深相等', () => {
    expect(splitCaliberRatification()).toEqual(splitCaliberRatification())
  })
})

describe('buildExportDeclaration / decorateExportRows（导出声明列）', () => {
  const decl = buildExportDeclaration({ exportedAt: '2026-07-09T00:00:00.000Z', periodRange: '2026-06' })

  it('声明六列齐全·与稳定列顺序一致', () => {
    expect(Object.keys(decl).sort()).toEqual([...EXPORT_DECLARATION_COLUMNS].sort())
    expect(EXPORT_DECLARATION_COLUMNS).toEqual(
      ['_sourceTag', '_basisNote', '_basisVersion', '_exportedAt', '_periodRange', '_ratified'],
    )
  })

  it('声明内容：未认账 + derived + 版本 + 期间 + 导出时刻', () => {
    expect(decl._ratified).toBe(false)
    expect(decl._sourceTag).toBe('derived')
    expect(decl._basisVersion).toBe(SPLIT_FORMULA_VERSION)
    expect(decl._periodRange).toBe('2026-06')
    expect(decl._exportedAt).toBe('2026-07-09T00:00:00.000Z')
    expect(decl._basisNote).toContain('SPLIT_DIAG_FEE')
  })

  it('缺 periodRange → 缺省「全部账期」（不留空让读者误判范围）', () => {
    expect(buildExportDeclaration({ exportedAt: 'X' })._periodRange).toBe('全部账期')
    expect(buildExportDeclaration({ exportedAt: 'X', periodRange: '  ' })._periodRange).toBe('全部账期')
  })

  it('逐行随行·剥不掉：每一行都带全部声明列（含裁到单行）', () => {
    const rows = [{ hospital: 'A', cm: 100 }, { hospital: 'B', cm: 200 }]
    const decorated = decorateExportRows(rows, decl)
    for (const row of decorated) {
      for (const col of EXPORT_DECLARATION_COLUMNS) expect(row).toHaveProperty(col)
      expect(row._ratified).toBe(false)
      expect(row._basisVersion).toBe(SPLIT_FORMULA_VERSION)
    }
    // 原业务列保留
    expect(decorated[0].hospital).toBe('A')
    expect(decorated[1].cm).toBe(200)
  })

  it('decorateExportRows 不改入参（返回新对象）', () => {
    const rows = [{ cm: 1 }]
    const decorated = decorateExportRows(rows, decl)
    expect(rows[0]).not.toHaveProperty('_ratified') // 原数组元素未被污染
    expect(decorated[0]).toHaveProperty('_ratified')
  })
})
