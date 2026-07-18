/**
 * 导出口径声明列（元素⑪·HON-3 条件②）回归门禁——导出是免责声明被剥离的头号通道。
 * 守：每一行导出都带口径声明列（来源标签/口径声明/版本/导出时刻/期间/是否认账）；fail-closed 缺水印→按未认账声明。
 */
import { describe, it, expect } from 'vitest'
import { exportComparisonCsv, buildExportDeclaration, EXPORT_DECLARATION_COLUMNS } from './exportComparison'
import type { ComparisonRow, CaliberRatification } from '@/types/hospital-cm'

const CALIBER: CaliberRatification = {
  ratified: false, state: 'UNRATIFIED', sourceTag: 'derived',
  basisVersion: '2026-07-06.a', label: '口径未经业务认账',
  note: '拆分口径由政策分摊常量派生，非实测成本；对外可能显著高估约 2 倍，业务方尚未认账。', ratifiedAt: null,
}

function mkRow(over: Partial<ComparisonRow> & { partnerId: string; cm: number | null }): ComparisonRow {
  return {
    partnerName: over.partnerId,
    cmRate: over.measurable === false ? null : 0.8,
    fixedCoverageShare: over.measurable === false ? null : 0.5,
    trend: null,
    measurable: true,
    ...over,
  }
}

describe('exportComparisonCsv（元素⑪·逐行口径声明列）', () => {
  const rows = [
    mkRow({ partnerId: '东安县医院', cm: 36994, detail: { caliber: '仅染色', state: '经营线未定·仅供观察' } as any }),
    // legacy/defensive 输入：消费者不能信任 0，占位值仍须导出为空。
    mkRow({ partnerId: '外送院', cm: 0, cmRate: 0, fixedCoverageShare: 0, measurable: false }),
  ]

  it('CSV 表头含全部 6 个口径声明列（稳定列序）', () => {
    const csv = exportComparisonCsv(rows, CALIBER, { exportedAt: '2026-07-09T10:00:00Z', periodRange: '2026-06', download: false })
    for (const label of ['来源标签', '口径声明', '口径版本', '导出时刻', '期间', '是否已认账']) {
      expect(csv).toContain(label)
    }
    expect(EXPORT_DECLARATION_COLUMNS.length).toBe(6)
  })

  it('每一数据行都带口径版本 + 未认账 + 导出时刻（剥不掉）', () => {
    const csv = exportComparisonCsv(rows, CALIBER, { exportedAt: '2026-07-09T10:00:00Z', periodRange: '2026-06', download: false })
    const lines = csv.split('\n')
    expect(lines.length).toBe(3) // 表头 + 2 行
    for (const dataLine of lines.slice(1)) {
      expect(dataLine).toContain('2026-07-06.a') // 口径版本随行
      expect(dataLine).toContain('2026-07-09T10:00:00Z') // 导出时刻随行
      expect(dataLine).toContain('false') // 未认账随行
    }
    // UNMEASURED 行如实标注（不缺席）
    expect(csv).toContain('UNMEASURED')
  })

  it('D2：UNMEASURED 行三个不可算数值导出为空单元格，不外流为 0', () => {
    const csv = exportComparisonCsv(rows, CALIBER, { exportedAt: '2026-07-09T10:00:00Z', periodRange: '2026-06', download: false })
    const unmeasuredCells = csv.split('\n')[2].split(',')
    expect(unmeasuredCells.slice(1, 4)).toEqual(['', '', ''])
  })

  it('fail-closed：缺 caliberRatification → 仍以「未认账 + derived」声明（宁可多提示）', () => {
    const decl = buildExportDeclaration(undefined, { exportedAt: '2026-07-09T10:00:00Z', periodRange: '2026-06' })
    expect(decl._ratified).toBe(false)
    expect(decl._sourceTag).toBe('derived')
    expect(decl._basisNote).toMatch(/未认账|不得单独/)
  })

  it('CSV 公式注入中和：医院名以 = / @ 开头 → 前置单引号钝化（导出外流通道防注入）', () => {
    const evil = [mkRow({ partnerId: '=cmd|calc', cm: 100 }), mkRow({ partnerId: '@SUM(A1)', cm: 50 })]
    const csv = exportComparisonCsv(evil, CALIBER, { exportedAt: '2026-07-09T10:00:00Z', periodRange: '2026-06', download: false })
    // 值被包裹在引号里（含=开头）时，钝化的单引号在引号内可见
    expect(csv).toContain("'=cmd|calc")
    expect(csv).toContain("'@SUM(A1)")
    // 未以公式字符开头的正常名不被加引号前缀
    expect(csv).not.toContain("'东安")
  })
})
