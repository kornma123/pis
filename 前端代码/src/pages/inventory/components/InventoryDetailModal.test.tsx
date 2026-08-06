import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { InventoryDetailModal } from './InventoryDetailModal'
import type { InventoryItem } from '@/types'

// 夹具与后端 GET /api/v1/inventory 的 positions[] 合同对齐（inventory-v1.1.ts）：
// 只含 quantity > 0 的位置，按到期先后排序；batchId/batchNo 为 null 表示非批次管理
function makeItem(over: Record<string, unknown> = {}): InventoryItem {
  return {
    id: 'INV-M1-default',
    materialId: 'M1',
    code: 'AB-HER2-001',
    name: 'HER2 抗体',
    spec: '6 ml',
    unit: '瓶',
    stock: 18,
    minStock: 5,
    maxStock: 999,
    availableStock: 18,
    status: 'normal',
    ...over,
  } as InventoryItem
}

const multiPositions = [
  { batchId: 'B1', batchNo: 'HER2-20260801', locationId: 'L1', locationName: '冷藏库 A-01', quantity: 8 },
  { batchId: 'B2', batchNo: 'HER2-20260715', locationId: 'L2', locationName: '冷藏库 A-03', quantity: 6 },
  { batchId: 'B3', batchNo: 'HER2-20260620', locationId: 'L3', locationName: '备用库 B-02', quantity: 4 },
]

function renderModal(item: InventoryItem, handlers: { onClose?: () => void; onOutbound?: () => void } = {}) {
  const onClose = handlers.onClose ?? vi.fn()
  const onOutbound = handlers.onOutbound ?? vi.fn()
  const utils = render(<InventoryDetailModal open item={item} onClose={onClose} onOutbound={onOutbound} />)
  return { onClose, onOutbound, ...utils }
}

describe('InventoryDetailModal — 位置明细（PIS-INV-UI-POSITIONS-001）', () => {
  it('多批次多库位逐行展示，数量单位在表头，合计一致时无警示', () => {
    renderModal(makeItem({ positions: multiPositions }))

    const table = screen.getByRole('table', { name: '库存位置明细' })
    // 数量单位入列表头，行内为纯数字
    expect(within(table).getByText('数量（瓶）')).toBeInTheDocument()
    // 3 条明细逐行展示（表头 + 3 行）
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    for (const p of multiPositions) {
      const row = within(table).getByText(p.batchNo!).closest('tr')!
      expect(within(row).getByText(p.locationName)).toBeInTheDocument()
      expect(within(row).getByText(String(p.quantity))).toBeInTheDocument()
    }
    // 位置数与合计如实展示（8+6+4=18=库存数量 → 无警示）
    expect(screen.getByText('3 个位置，共 18 瓶')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // 有批次行时展示排序事实说明
    expect(screen.getByText(/批次位置按到期时间先后排列/)).toBeInTheDocument()
  })

  it('batchNo 为 null 的位置显示「非批次管理」，不显示排序说明', () => {
    renderModal(makeItem({
      name: '一次性丁腈手套',
      code: 'GLV-NBR-001',
      spec: 'L 码（100 只/盒）',
      unit: '盒',
      stock: 24,
      positions: [
        { batchId: null, batchNo: null, locationId: 'L4', locationName: '常温库 C-02', quantity: 14 },
        { batchId: null, batchNo: null, locationId: 'L5', locationName: '常温库 C-06', quantity: 10 },
      ],
    }))

    // 空批次显示说明文字而不是 '-'，避免被误读为数据缺失
    expect(screen.getAllByText('非批次管理')).toHaveLength(2)
    expect(screen.getByText('数量（盒）')).toBeInTheDocument()
    expect(screen.getByText('2 个位置，共 24 盒')).toBeInTheDocument()
    // 无批次行 → 排序说明无的放矢，应隐藏
    expect(screen.queryByText(/批次位置按到期时间先后排列/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('位置合计与库存数量不一致时显示两组动态数字且不隐藏原始明细', () => {
    renderModal(makeItem({
      stock: 18,
      positions: [
        { batchId: 'B1', batchNo: 'HER2-20260801', locationId: 'L1', locationName: '冷藏库 A-01', quantity: 10 },
        { batchId: 'B2', batchNo: 'HER2-20260715', locationId: 'L2', locationName: '冷藏库 A-03', quantity: 6 },
      ],
    }))

    // 警示由「合计 ≠ 库存数量」判定驱动，两组数字都来自数据而非写死
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('位置合计（16 瓶）与库存数量（18 瓶）不符')
    expect(alert).toHaveTextContent('两组数字均按原始记录如实显示')
    // 原始明细与合计不掩盖
    const table = screen.getByRole('table', { name: '库存位置明细' })
    expect(within(table).getByText('HER2-20260801')).toBeInTheDocument()
    expect(within(table).getByText('HER2-20260715')).toBeInTheDocument()
    expect(screen.getByText('2 个位置，共 16 瓶')).toBeInTheDocument()
  })

  it('合法四位小数不警示：0.1+0.2+0.3 与库存 0.6 在后端精度合同下恒等（R1-P1 反例）', () => {
    renderModal(makeItem({
      stock: 0.6,
      positions: [
        { batchId: 'B1', batchNo: 'HER2-20260801', locationId: 'L1', locationName: '冷藏库 A-01', quantity: 0.1 },
        { batchId: 'B2', batchNo: 'HER2-20260715', locationId: 'L2', locationName: '冷藏库 A-03', quantity: 0.2 },
        { batchId: 'B3', batchNo: 'HER2-20260620', locationId: 'L3', locationName: '备用库 B-02', quantity: 0.3 },
      ],
    }))

    // 后端 DECIMAL(18,4) 合同下 0.1+0.2+0.3 恒等于 0.6；JS 浮点 reduce 的
    // 0.6000000000000001 尾数不得触发误报，界面也不得暴露尾数
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('3 个位置，共 0.6 瓶')).toBeInTheDocument()
    const table = screen.getByRole('table', { name: '库存位置明细' })
    for (const q of ['0.1', '0.2', '0.3']) {
      expect(within(table).getByText(q)).toBeInTheDocument()
    }
  })

  it('真实 0.0001 差异仍警示，并如实展示两组四位小数（R1-P1 反例）', () => {
    renderModal(makeItem({
      stock: 0.6,
      positions: [
        { batchId: 'B1', batchNo: 'HER2-20260801', locationId: 'L1', locationName: '冷藏库 A-01', quantity: 0.1 },
        { batchId: 'B2', batchNo: 'HER2-20260715', locationId: 'L2', locationName: '冷藏库 A-03', quantity: 0.2 },
        { batchId: 'B3', batchNo: 'HER2-20260620', locationId: 'L3', locationName: '备用库 B-02', quantity: 0.3001 },
      ],
    }))

    // 0.0001 是后端四位小数合同内的真实差异，精度换算不得把它吞掉；
    // 警示与合计都要显示干净的两组数字，不得带浮点尾数
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('位置合计（0.6001 瓶）与库存数量（0.6 瓶）不符')
    expect(screen.getByText('3 个位置，共 0.6001 瓶')).toBeInTheDocument()
    const table = screen.getByRole('table', { name: '库存位置明细' })
    expect(within(table).getByText('0.3001')).toBeInTheDocument()
  })

  it('库存数量大于 0 但无位置明细时显示诚实空态，不渲染表格', () => {
    renderModal(makeItem({ stock: 18, positions: [] }))

    const empty = screen.getByRole('status')
    expect(empty).toHaveTextContent('当前没有可展示的位置明细，但库存数量仍为 18 瓶')
    expect(empty).toHaveTextContent('位置数据可能尚未同步')
    expect(screen.queryByRole('table', { name: '库存位置明细' })).not.toBeInTheDocument()
    // 空态不是「合计不一致」，不应出现警示
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('汇总区保留现有字段；单值「库位」字段由明细表替代（冻结 mockup 决定）', () => {
    const { container } = renderModal(makeItem({ positions: multiPositions }))

    const summary = container.querySelector('dl')!
    for (const label of ['物料名称', '物料编码', '规格', '单位', '库存数量', '安全库存', '供应商']) {
      expect(within(summary as HTMLElement).getByText(label)).toBeInTheDocument()
    }
    // 多库位时后端 locationName 恒为 '-'，保留单值字段必然误导；明细表是唯一事实源
    expect(within(summary as HTMLElement).queryByText('库位')).not.toBeInTheDocument()
    // 汇总数字照常展示
    expect(within(summary as HTMLElement).getByText('18')).toBeInTheDocument()
  })

  it('关闭、×、遮罩与出库回调保持现有行为', () => {
    const onClose = vi.fn()
    const onOutbound = vi.fn()
    const { container } = renderModal(makeItem({ positions: multiPositions }), { onClose, onOutbound })

    // 页脚「关闭」：只触发 onClose
    const closeButtons = screen.getAllByRole('button', { name: '关闭' })
    const footerClose = closeButtons.find(b => b.textContent === '关闭')!
    fireEvent.click(footerClose)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOutbound).not.toHaveBeenCalled()

    // 头部 ×：只触发 onClose
    const headerClose = closeButtons.find(b => b.textContent === '×')!
    fireEvent.click(headerClose)
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onOutbound).not.toHaveBeenCalled()

    // 遮罩点击：只触发 onClose
    fireEvent.click(container.querySelector('div.absolute.inset-0')!)
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(onOutbound).not.toHaveBeenCalled()

    // 「出库」：先 onClose 再 onOutbound（现有顺序）
    fireEvent.click(screen.getByRole('button', { name: '出库' }))
    expect(onClose).toHaveBeenCalledTimes(4)
    expect(onOutbound).toHaveBeenCalledTimes(1)
    expect(onClose.mock.invocationCallOrder[3]).toBeLessThan(onOutbound.mock.invocationCallOrder[0])
  })

  it('窄屏结构：汇总区窄屏单列、明细表横向滚动、面板宽度受视口约束', () => {
    const { container } = renderModal(makeItem({ positions: multiPositions }))

    // 汇总区默认单列，≥520px 双列（冻结 mockup 断点）
    const summary = container.querySelector('dl')!
    expect(summary.className).toContain('grid-cols-1')
    expect(summary.className).toContain('min-[520px]:grid-cols-2')

    // 明细表容器横向滚动而非挤压（标准 §5.9），并约束最大高度
    const table = screen.getByRole('table', { name: '库存位置明细' })
    const wrap = table.closest('div')!
    expect(wrap.className).toContain('overflow-auto')
    expect(wrap.className).toContain('max-h-')

    // 面板 w-full + max-w-2xl：根级不产生横向溢出
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('w-full')
    expect(dialog.className).toContain('max-w-2xl')
  })
})
