/**
 * 业务交易测试数据初始化脚本
 * 日期: 2026-05-11
 * 功能: 创建真实的入库、出库、盘点、退货、报废等业务数据
 * 用于支持自动化测试的预置数据
 */

import { getDatabase } from '../src/database/DatabaseManager.js'
import { v4 as uuidv4 } from 'uuid'

const now = new Date().toISOString()
const today = now.slice(0, 10)

function log(msg: string) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${msg}`)
}

function generateInboundNo(seq: number): string {
  return `IB-20260511-${String(seq).padStart(3, '0')}`
}
function generateOutboundNo(seq: number): string {
  return `OB-20260511-${String(seq).padStart(3, '0')}`
}
function generateStocktakingNo(seq: number): string {
  return `ST-20260511-${String(seq).padStart(3, '0')}`
}
function generateReturnNo(seq: number): string {
  return `RT-20260511-${String(seq).padStart(3, '0')}`
}
function generateScrapNo(seq: number): string {
  return `SC-20260511-${String(seq).padStart(3, '0')}`
}
function generateSupplierReturnNo(seq: number): string {
  return `SR-20260511-${String(seq).padStart(3, '0')}`
}
function generatePurchaseOrderNo(seq: number): string {
  return `PO-20260511-${String(seq).padStart(3, '0')}`
}

// ============================================
// 1. 创建采购订单（先创建订单，再入库）
// ============================================
function seedPurchaseOrders(db: any) {
  log('开始创建采购订单...')
  const check = db.prepare('SELECT COUNT(*) as count FROM purchase_orders').get() as any
  const partialCheck = db.prepare("SELECT COUNT(*) as count FROM purchase_orders WHERE status = 'partial'").get() as any

  const orders = [
    { id: 'PO-001', material_id: 'MAT-HE-001', material_name: '苏木素染液', supplier_id: 'SUP-003', ordered_qty: 10, unit_price: 180, total_amount: 1800, expected_date: '2026-05-15', status: 'completed' },
    { id: 'PO-002', material_id: 'MAT-HE-002', material_name: '伊红染液', supplier_id: 'SUP-003', ordered_qty: 10, unit_price: 120, total_amount: 1200, expected_date: '2026-05-15', status: 'completed' },
    { id: 'PO-003', material_id: 'MAT-IHC-001', material_name: '广谱CK抗体', supplier_id: 'SUP-001', ordered_qty: 3, unit_price: 1200, total_amount: 3600, expected_date: '2026-05-20', status: 'completed' },
    { id: 'PO-004', material_id: 'MAT-IHC-021', material_name: 'CD20抗体', supplier_id: 'SUP-001', ordered_qty: 3, unit_price: 1350, total_amount: 4050, expected_date: '2026-05-20', status: 'completed' },
    { id: 'PO-005', material_id: 'MAT-IHC-049', material_name: 'Ki-67抗体', supplier_id: 'SUP-001', ordered_qty: 3, unit_price: 1100, total_amount: 3300, expected_date: '2026-05-20', status: 'completed' },
    { id: 'PO-006', material_id: 'MAT-IHC-055', material_name: 'HER2抗体', supplier_id: 'SUP-001', ordered_qty: 2, unit_price: 1500, total_amount: 3000, expected_date: '2026-05-25', status: 'completed' },
    { id: 'PO-007', material_id: 'MAT-IHC-059', material_name: 'PD-L1抗体', supplier_id: 'SUP-002', ordered_qty: 2, unit_price: 2800, total_amount: 5600, expected_date: '2026-05-25', status: 'completed' },
    { id: 'PO-008', material_id: 'MAT-MP-001', material_name: 'FFPE DNA提取试剂盒', supplier_id: 'SUP-004', ordered_qty: 2, unit_price: 1800, total_amount: 3600, expected_date: '2026-05-18', status: 'completed' },
    { id: 'PO-009', material_id: 'MAT-MP-004', material_name: 'PCR Master Mix', supplier_id: 'SUP-005', ordered_qty: 5, unit_price: 850, total_amount: 4250, expected_date: '2026-05-18', status: 'completed' },
    { id: 'PO-010', material_id: 'MAT-GLASS-001', material_name: '防脱载玻片', supplier_id: 'SUP-003', ordered_qty: 20, unit_price: 180, total_amount: 3600, expected_date: '2026-05-12', status: 'completed' },
    { id: 'PO-011', material_id: 'MAT-LAB-010', material_name: '丁腈手套（小号）', supplier_id: 'SUP-010', ordered_qty: 30, unit_price: 65, total_amount: 1950, expected_date: '2026-05-12', status: 'completed' },
    { id: 'PO-012', material_id: 'MAT-HE-005', material_name: '无水乙醇', supplier_id: 'SUP-009', ordered_qty: 20, unit_price: 25, total_amount: 500, expected_date: '2026-05-12', status: 'completed' },
    { id: 'PO-013', material_id: 'MAT-FIX-001', material_name: '10%中性缓冲甲醛', supplier_id: 'SUP-009', ordered_qty: 10, unit_price: 85, total_amount: 850, expected_date: '2026-05-12', status: 'completed' },
    { id: 'PO-014', material_id: 'MAT-CYTO-005', material_name: '液基细胞保存液', supplier_id: 'SUP-008', ordered_qty: 3, unit_price: 1200, total_amount: 3600, expected_date: '2026-05-15', status: 'completed' },
    { id: 'PO-015', material_id: 'MAT-DEV-001', material_name: '一次性切片刀片（宽型）', supplier_id: 'SUP-003', ordered_qty: 5, unit_price: 350, total_amount: 1750, expected_date: '2026-05-15', status: 'completed' },
    // 待采购的订单
    { id: 'PO-016', material_id: 'MAT-IHC-056', material_name: 'ER抗体', supplier_id: 'SUP-001', ordered_qty: 3, unit_price: 1200, total_amount: 3600, expected_date: '2026-05-30', status: 'pending' },
    { id: 'PO-017', material_id: 'MAT-IHC-057', material_name: 'PR抗体', supplier_id: 'SUP-001', ordered_qty: 3, unit_price: 1200, total_amount: 3600, expected_date: '2026-05-30', status: 'pending' },
    { id: 'PO-018', material_id: 'MAT-MP-006', material_name: 'NGS文库制备试剂盒', supplier_id: 'SUP-006', ordered_qty: 2, unit_price: 12800, total_amount: 25600, expected_date: '2026-06-01', status: 'pending' },
    // 部分收货的订单（用于测试入库时的partial状态）
    { id: 'PO-019', material_id: 'MAT-IHC-058', material_name: 'AR抗体', supplier_id: 'SUP-001', ordered_qty: 5, unit_price: 950, total_amount: 4750, expected_date: '2026-06-05', status: 'partial' },
    { id: 'PO-020', material_id: 'MAT-MP-007', material_name: 'FFPE RNA提取试剂盒', supplier_id: 'SUP-004', ordered_qty: 4, unit_price: 2200, total_amount: 8800, expected_date: '2026-06-10', status: 'partial' },
  ]

  const insert = db.prepare(
    'INSERT INTO purchase_orders (id, order_no, material_id, material_name, supplier_id, ordered_qty, received_qty, unit, unit_price, total_amount, expected_date, status, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  if (check.count === 0) {
    // 全新数据库：插入所有订单
    for (const o of orders) {
      const unit = db.prepare('SELECT unit FROM materials WHERE id = ?').get(o.material_id) as any
      const receivedQty = o.status === 'completed' ? o.ordered_qty : (o.status === 'partial' ? Math.floor(o.ordered_qty / 2) : 0)
      insert.run(o.id, generatePurchaseOrderNo(Number(o.id.split('-')[1])), o.material_id, o.material_name, o.supplier_id, o.ordered_qty, receivedQty, unit?.unit || '瓶', o.unit_price, o.total_amount, o.expected_date, o.status, '', now, now)
    }
    log(`采购订单创建完成: ${orders.length} 笔`)
  } else if (partialCheck.count === 0) {
    // 已有数据但缺少partial订单：只插入partial订单
    const partialOrders = orders.filter(o => o.status === 'partial')
    for (const o of partialOrders) {
      const unit = db.prepare('SELECT unit FROM materials WHERE id = ?').get(o.material_id) as any
      const receivedQty = Math.floor(o.ordered_qty / 2)
      insert.run(o.id, generatePurchaseOrderNo(Number(o.id.split('-')[1])), o.material_id, o.material_name, o.supplier_id, o.ordered_qty, receivedQty, unit?.unit || '瓶', o.unit_price, o.total_amount, o.expected_date, o.status, '', now, now)
    }
    log(`补充partial采购订单: ${partialOrders.length} 笔`)
  } else {
    log('采购订单已存在，跳过')
  }
}

// ============================================
// 2. 创建入库记录（多批次，不同日期，不同价格）
// ============================================
function seedInboundRecords(db: any) {
  log('开始创建入库记录...')
  const check = db.prepare('SELECT COUNT(*) as count FROM inbound_records WHERE is_deleted = 0').get() as any
  if (check.count > 0) {
    log('入库记录已存在，跳过')
    return
  }

  const inbounds = [
    // === 苏木素染液 - 3个批次 ===
    { id: 'IB-001', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260115-A', quantity: 5, price: 180, supplier_id: 'SUP-003', location_id: 'LOC-A01', production_date: '2026-01-15', expiry_date: '2027-01-15', operator: '赵采购', purchase_order_id: 'PO-001' },
    { id: 'IB-002', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260320-B', quantity: 3, price: 185, supplier_id: 'SUP-003', location_id: 'LOC-A01', production_date: '2026-03-20', expiry_date: '2027-03-20', operator: '赵采购', purchase_order_id: 'PO-001' },
    { id: 'IB-003', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260510-C', quantity: 2, price: 190, supplier_id: 'SUP-003', location_id: 'LOC-A01', production_date: '2026-05-10', expiry_date: '2027-05-10', operator: '赵采购', purchase_order_id: 'PO-001' },

    // === 伊红染液 - 2个批次 ===
    { id: 'IB-004', material_id: 'MAT-HE-002', batch_no: 'LEICA-HE-20260201-A', quantity: 6, price: 120, supplier_id: 'SUP-003', location_id: 'LOC-A01', production_date: '2026-02-01', expiry_date: '2027-02-01', operator: '赵采购', purchase_order_id: 'PO-002' },
    { id: 'IB-005', material_id: 'MAT-HE-002', batch_no: 'LEICA-HE-20260508-B', quantity: 4, price: 125, supplier_id: 'SUP-003', location_id: 'LOC-A01', production_date: '2026-05-08', expiry_date: '2027-05-08', operator: '赵采购', purchase_order_id: 'PO-002' },

    // === 分化液/返蓝液 ===
    { id: 'IB-006', material_id: 'MAT-HE-003', batch_no: 'LEICA-HE-20260401', quantity: 3, price: 80, supplier_id: 'SUP-003', location_id: 'LOC-A01', production_date: '2026-04-01', expiry_date: '2027-04-01', operator: '赵采购', purchase_order_id: null },
    { id: 'IB-007', material_id: 'MAT-HE-004', batch_no: 'LEICA-HE-20260401', quantity: 3, price: 60, supplier_id: 'SUP-003', location_id: 'LOC-A01', production_date: '2026-04-01', expiry_date: '2027-04-01', operator: '赵采购', purchase_order_id: null },

    // === 乙醇/二甲苯 (PO-012 ordered_qty=20) ===
    { id: 'IB-008', material_id: 'MAT-HE-005', batch_no: 'SINOPHARM-20260501', quantity: 15, price: 25, supplier_id: 'SUP-009', location_id: 'LOC-F01', production_date: '2026-05-01', expiry_date: '2028-05-01', operator: '赵采购', purchase_order_id: 'PO-012' },
    { id: 'IB-008b', material_id: 'MAT-HE-005', batch_no: 'SINOPHARM-20260508', quantity: 5, price: 25, supplier_id: 'SUP-009', location_id: 'LOC-F01', production_date: '2026-05-08', expiry_date: '2028-05-08', operator: '赵采购', purchase_order_id: 'PO-012' },
    { id: 'IB-009', material_id: 'MAT-HE-006', batch_no: 'SINOPHARM-20260501', quantity: 12, price: 20, supplier_id: 'SUP-009', location_id: 'LOC-F01', production_date: '2026-05-01', expiry_date: '2028-05-01', operator: '赵采购', purchase_order_id: null },
    { id: 'IB-010', material_id: 'MAT-HE-007', batch_no: 'SINOPHARM-20260501', quantity: 8, price: 35, supplier_id: 'SUP-009', location_id: 'LOC-F01', production_date: '2026-05-01', expiry_date: '2028-05-01', operator: '赵采购', purchase_order_id: null },

    // === 石蜡/树胶 ===
    { id: 'IB-011', material_id: 'MAT-HE-008', batch_no: 'SINOPHARM-20260415', quantity: 3, price: 150, supplier_id: 'SUP-009', location_id: 'LOC-B01', production_date: '2026-04-15', expiry_date: '2029-04-15', operator: '赵采购', purchase_order_id: null },
    { id: 'IB-012', material_id: 'MAT-HE-009', batch_no: 'LEICA-HE-20260310', quantity: 5, price: 90, supplier_id: 'SUP-003', location_id: 'LOC-A01', production_date: '2026-03-10', expiry_date: '2027-03-10', operator: '赵采购', purchase_order_id: null },

    // === IHC抗体 - 多批次，高价值 ===
    { id: 'IB-013', material_id: 'MAT-IHC-001', batch_no: 'DAKO-IHC-20260301-A', quantity: 2, price: 1200, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2026-03-01', expiry_date: '2027-03-01', operator: '赵采购', purchase_order_id: 'PO-003' },
    { id: 'IB-014', material_id: 'MAT-IHC-001', batch_no: 'DAKO-IHC-20260505-B', quantity: 1, price: 1250, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2026-05-05', expiry_date: '2027-05-05', operator: '赵采购', purchase_order_id: 'PO-003' },

    { id: 'IB-015', material_id: 'MAT-IHC-021', batch_no: 'DAKO-IHC-20260301-A', quantity: 2, price: 1350, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2026-03-01', expiry_date: '2027-03-01', operator: '赵采购', purchase_order_id: 'PO-004' },
    { id: 'IB-016', material_id: 'MAT-IHC-021', batch_no: 'DAKO-IHC-20260505-B', quantity: 1, price: 1380, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2026-05-05', expiry_date: '2027-05-05', operator: '赵采购', purchase_order_id: 'PO-004' },

    { id: 'IB-017', material_id: 'MAT-IHC-049', batch_no: 'DAKO-IHC-20260301-A', quantity: 2, price: 1100, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2026-03-01', expiry_date: '2027-03-01', operator: '赵采购', purchase_order_id: 'PO-005' },
    { id: 'IB-018', material_id: 'MAT-IHC-049', batch_no: 'DAKO-IHC-20260505-B', quantity: 1, price: 1150, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2026-05-05', expiry_date: '2027-05-05', operator: '赵采购', purchase_order_id: 'PO-005' },

    { id: 'IB-019', material_id: 'MAT-IHC-055', batch_no: 'DAKO-IHC-20260420', quantity: 2, price: 1500, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2026-04-20', expiry_date: '2027-04-20', operator: '赵采购', purchase_order_id: 'PO-006' },
    { id: 'IB-020', material_id: 'MAT-IHC-059', batch_no: 'VENTANA-IHC-20260425', quantity: 2, price: 2800, supplier_id: 'SUP-002', location_id: 'LOC-C01', production_date: '2026-04-25', expiry_date: '2027-04-25', operator: '赵采购', purchase_order_id: 'PO-007' },

    // === 分子诊断试剂 ===
    { id: 'IB-021', material_id: 'MAT-MP-001', batch_no: 'THERMO-MP-20260501', quantity: 2, price: 1800, supplier_id: 'SUP-004', location_id: 'LOC-D01', production_date: '2026-05-01', expiry_date: '2027-05-01', operator: '赵采购', purchase_order_id: 'PO-008' },
    { id: 'IB-022', material_id: 'MAT-MP-004', batch_no: 'ROCHE-MP-20260501', quantity: 5, price: 850, supplier_id: 'SUP-005', location_id: 'LOC-D02', production_date: '2026-05-01', expiry_date: '2027-05-01', operator: '赵采购', purchase_order_id: 'PO-009' },

    // === 玻片 ===
    { id: 'IB-023', material_id: 'MAT-GLASS-001', batch_no: 'LEICA-GL-20260501', quantity: 10, price: 180, supplier_id: 'SUP-003', location_id: 'LOC-B01', production_date: '2026-05-01', expiry_date: '2029-05-01', operator: '赵采购', purchase_order_id: 'PO-010' },
    { id: 'IB-024', material_id: 'MAT-GLASS-001', batch_no: 'LEICA-GL-20260508', quantity: 10, price: 185, supplier_id: 'SUP-003', location_id: 'LOC-B01', production_date: '2026-05-08', expiry_date: '2029-05-08', operator: '赵采购', purchase_order_id: 'PO-010' },

    // === 手套/防护用品 (PO-011 ordered_qty=30, 需要两笔入库) ===
    { id: 'IB-025', material_id: 'MAT-LAB-010', batch_no: 'YUHUA-LAB-20260501', quantity: 15, price: 65, supplier_id: 'SUP-010', location_id: 'LOC-B02', production_date: '2026-05-01', expiry_date: '2031-05-01', operator: '赵采购', purchase_order_id: 'PO-011' },
    { id: 'IB-025b', material_id: 'MAT-LAB-010', batch_no: 'YUHUA-LAB-20260508', quantity: 15, price: 65, supplier_id: 'SUP-010', location_id: 'LOC-B02', production_date: '2026-05-08', expiry_date: '2031-05-08', operator: '赵采购', purchase_order_id: 'PO-011' },
    { id: 'IB-026', material_id: 'MAT-LAB-011', batch_no: 'YUHUA-LAB-20260501', quantity: 15, price: 65, supplier_id: 'SUP-010', location_id: 'LOC-B02', production_date: '2026-05-01', expiry_date: '2031-05-01', operator: '赵采购', purchase_order_id: null },

    // === 固定液 (PO-013 ordered_qty=10, 补第二笔入库) ===
    { id: 'IB-027', material_id: 'MAT-FIX-001', batch_no: 'SINOPHARM-FIX-20260501', quantity: 8, price: 85, supplier_id: 'SUP-009', location_id: 'LOC-F01', production_date: '2026-05-01', expiry_date: '2028-05-01', operator: '赵采购', purchase_order_id: 'PO-013' },
    { id: 'IB-027b', material_id: 'MAT-FIX-001', batch_no: 'SINOPHARM-FIX-20260508', quantity: 2, price: 85, supplier_id: 'SUP-009', location_id: 'LOC-F01', production_date: '2026-05-08', expiry_date: '2028-05-08', operator: '赵采购', purchase_order_id: 'PO-013' },

    // === 细胞学 (PO-014 ordered_qty=3) ===
    { id: 'IB-028', material_id: 'MAT-CYTO-005', batch_no: 'BD-CYTO-20260501', quantity: 3, price: 1200, supplier_id: 'SUP-008', location_id: 'LOC-E02', production_date: '2026-05-01', expiry_date: '2027-05-01', operator: '赵采购', purchase_order_id: 'PO-014' },

    // === 设备耗材 (PO-015 ordered_qty=5) ===
    { id: 'IB-029', material_id: 'MAT-DEV-001', batch_no: 'LEICA-DEV-20260501', quantity: 3, price: 350, supplier_id: 'SUP-003', location_id: 'LOC-G01', production_date: '2026-05-01', expiry_date: '2031-05-01', operator: '赵采购', purchase_order_id: 'PO-015' },
    { id: 'IB-029b', material_id: 'MAT-DEV-001', batch_no: 'LEICA-DEV-20260508', quantity: 2, price: 350, supplier_id: 'SUP-003', location_id: 'LOC-G01', production_date: '2026-05-08', expiry_date: '2031-05-08', operator: '赵采购', purchase_order_id: 'PO-015' },

    // === 临期物料（用于有效期预警测试） ===
    { id: 'IB-030', material_id: 'MAT-IHC-002', batch_no: 'DAKO-IHC-20250601-OLD', quantity: 1, price: 1150, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2025-06-01', expiry_date: '2026-05-16', operator: '赵采购', purchase_order_id: null },
    { id: 'IB-031', material_id: 'MAT-IHC-003', batch_no: 'DAKO-IHC-20250601-OLD', quantity: 1, price: 1180, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2025-06-01', expiry_date: '2026-05-14', operator: '赵采购', purchase_order_id: null },

    // === 已过期物料（用于过期预警测试） ===
    { id: 'IB-032', material_id: 'MAT-IHC-004', batch_no: 'DAKO-IHC-20240501-EXP', quantity: 1, price: 1220, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2024-05-01', expiry_date: '2025-05-01', operator: '赵采购', purchase_order_id: null },

    // === 低库存物料（用于低库存预警测试） ===
    { id: 'IB-033', material_id: 'MAT-IHC-005', batch_no: 'DAKO-IHC-20260101', quantity: 1, price: 1100, supplier_id: 'SUP-001', location_id: 'LOC-C01', production_date: '2026-01-01', expiry_date: '2027-01-01', operator: '赵采购', purchase_order_id: null },
  ]

  const insert = db.prepare(
    `INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_no, quantity, unit, price, amount, supplier_id, location_id, production_date, expiry_date, operator, status, remark, purchase_order_id, purchase_order_no, created_at, updated_at)
     VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`
  )

  for (let i = 0; i < inbounds.length; i++) {
    const r = inbounds[i]
    const material = db.prepare('SELECT unit, name FROM materials WHERE id = ?').get(r.material_id) as any
    const amount = r.price * r.quantity
    const poNo = r.purchase_order_id ? generatePurchaseOrderNo(Number(r.purchase_order_id.split('-')[1])) : null
    insert.run(r.id, generateInboundNo(i + 1), r.material_id, r.batch_no, r.quantity, material?.unit || '瓶', r.price, amount,
      r.supplier_id, r.location_id, r.production_date, r.expiry_date, r.operator, '', r.purchase_order_id || null, poNo, now, now)
  }
  log(`入库记录创建完成: ${inbounds.length} 笔`)
}

// ============================================
// 3. 创建批次记录
// ============================================
function seedBatches(db: any) {
  log('开始创建批次记录...')
  const check = db.prepare('SELECT COUNT(*) as count FROM batches').get() as any
  if (check.count > 0) {
    log('批次记录已存在，跳过')
    return
  }

  const inbounds = db.prepare(`SELECT * FROM inbound_records WHERE is_deleted = 0 AND status = 'completed'`).all() as any[]
  const insert = db.prepare(
    'INSERT INTO batches (id, material_id, batch_no, quantity, remaining, production_date, expiry_date, inbound_id, inbound_price, supplier_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
  )

  for (const r of inbounds) {
    if (!r.batch_no) continue
    const id = uuidv4()
    insert.run(id, r.material_id, r.batch_no, r.quantity, r.quantity, r.production_date, r.expiry_date, r.id, r.price, r.supplier_id)
  }
  log(`批次记录创建完成: ${inbounds.length} 个`)
}

// ============================================
// 4. 创建库存汇总
// ============================================
function seedInventory(db: any) {
  log('开始创建库存汇总...')
  const check = db.prepare('SELECT COUNT(*) as count FROM inventory').get() as any
  if (check.count > 0) {
    log('库存汇总已存在，跳过')
    return
  }

  const materials = db.prepare('SELECT id FROM materials WHERE is_deleted = 0').all() as any[]
  const insert = db.prepare(
    'INSERT INTO inventory (id, material_id, stock, locked_stock, location_id, last_inbound_id, last_inbound_date, update_time) VALUES (?, ?, ?, 0, ?, ?, ?, ?)'
  )

  for (const m of materials) {
    const inbound = db.prepare(
      `SELECT COALESCE(SUM(quantity),0) as total, location_id, MAX(id) as last_id, MAX(created_at) as last_date
       FROM inbound_records WHERE material_id = ? AND status = 'completed' AND is_deleted = 0`
    ).get(m.id) as any

    const outbound = db.prepare(
      `SELECT COALESCE(SUM(quantity),0) as total FROM outbound_items WHERE material_id = ?`
    ).get(m.id) as any

    const stockReturn = db.prepare(
      `SELECT COALESCE(SUM(quantity),0) as total FROM return_records WHERE material_id = ? AND status = 'completed'`
    ).get(m.id) as any

    const scrap = db.prepare(
      `SELECT COALESCE(SUM(quantity),0) as total FROM scrap_records WHERE material_id = ? AND status = 'completed'`
    ).get(m.id) as any

    const stock = Number(inbound?.total || 0) - Number(outbound?.total || 0) + Number(stockReturn?.total || 0) - Number(scrap?.total || 0)

    if (stock > 0 || (inbound && inbound.total > 0)) {
      insert.run(uuidv4(), m.id, Math.max(0, stock), inbound?.location_id || null, inbound?.last_id || null, inbound?.last_date?.slice(0, 10) || today, now)
    }
  }
  log('库存汇总创建完成')
}

// ============================================
// 5. 创建出库记录（项目领用，覆盖多种场景）
// ============================================
function seedOutboundRecords(db: any) {
  log('开始创建出库记录...')
  const check = db.prepare('SELECT COUNT(*) as count FROM outbound_records WHERE is_deleted = 0').get() as any
  if (check.count > 0) {
    log('出库记录已存在，跳过')
    return
  }

  const outbounds = [
    // === HE染色项目出库 ===
    { id: 'OB-001', type: 'project', project_id: 'PRJ-HE-001', total_cost: 0, operator: '张技术', remark: '常规HE染色-每日例检' },
    { id: 'OB-002', type: 'project', project_id: 'PRJ-HE-001', total_cost: 0, operator: '张技术', remark: '常规HE染色-每日例检' },
    { id: 'OB-003', type: 'project', project_id: 'PRJ-HE-001', total_cost: 0, operator: '李技术', remark: '常规HE染色-每日例检' },

    // === IHC项目出库 ===
    { id: 'OB-004', type: 'project', project_id: 'PRJ-IHC-001', total_cost: 0, operator: '张技术', remark: '广谱CK检测-乳腺癌标本' },
    { id: 'OB-005', type: 'project', project_id: 'PRJ-IHC-002', total_cost: 0, operator: '张技术', remark: 'CD20检测-淋巴瘤标本' },
    { id: 'OB-006', type: 'project', project_id: 'PRJ-IHC-003', total_cost: 0, operator: '李技术', remark: 'Ki-67检测-胃癌标本' },
    { id: 'OB-007', type: 'project', project_id: 'PRJ-IHC-004', total_cost: 0, operator: '张技术', remark: 'HER2检测-乳腺癌标本' },
    { id: 'OB-008', type: 'project', project_id: 'PRJ-IHC-005', total_cost: 0, operator: '李技术', remark: 'PD-L1检测-肺癌标本' },

    // === 分子诊断项目出库 ===
    { id: 'OB-009', type: 'project', project_id: 'PRJ-MP-001', total_cost: 0, operator: '张技术', remark: 'NGS-425基因Panel-结直肠癌' },
    { id: 'OB-010', type: 'project', project_id: 'PRJ-MP-002', total_cost: 0, operator: '李技术', remark: 'HER2 FISH-乳腺癌' },
    { id: 'OB-011', type: 'project', project_id: 'PRJ-MP-003', total_cost: 0, operator: '张技术', remark: 'ALK FISH-肺癌' },

    // === 特殊染色项目出库 ===
    { id: 'OB-012', type: 'project', project_id: 'PRJ-SS-001', total_cost: 0, operator: '张技术', remark: 'PAS染色-肾穿刺' },

    // === 细胞学项目出库 ===
    { id: 'OB-013', type: 'project', project_id: 'PRJ-CYTO-001', total_cost: 0, operator: '李技术', remark: 'TCT检测-宫颈癌筛查' },
    { id: 'OB-014', type: 'project', project_id: 'PRJ-CYTO-002', total_cost: 0, operator: '张技术', remark: '细针穿刺-甲状腺结节' },

    // === 非项目领用（调拨/报废） ===
    { id: 'OB-015', type: 'transfer', project_id: null, total_cost: 0, operator: '王仓库', remark: 'A区调至B区-库位整理' },
    { id: 'OB-016', type: 'scrap', project_id: null, total_cost: 0, operator: '王仓库', remark: '过期物料报废-HER2抗体' },
  ]

  const insertRec = db.prepare(
    `INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
  )
  for (let i = 0; i < outbounds.length; i++) {
    const o = outbounds[i]
    insertRec.run(o.id, generateOutboundNo(i + 1), o.type, o.project_id, o.total_cost, o.operator, o.remark, now, now)
  }

  // 创建出库明细
  const items = [
    // OB-001: HE染色出库
    { outbound_id: 'OB-001', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260115-A', quantity: 0.5, unit: 'ml', unit_cost: 180 },
    { outbound_id: 'OB-001', material_id: 'MAT-HE-002', batch_no: 'LEICA-HE-20260201-A', quantity: 0.5, unit: 'ml', unit_cost: 120 },
    { outbound_id: 'OB-001', material_id: 'MAT-HE-005', batch_no: 'SINOPHARM-20260501', quantity: 5, unit: 'ml', unit_cost: 25 },
    { outbound_id: 'OB-001', material_id: 'MAT-GLASS-001', batch_no: 'LEICA-GL-20260501', quantity: 10, unit: '片', unit_cost: 180 },

    // OB-002: HE染色出库（消耗不同批次）
    { outbound_id: 'OB-002', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260115-A', quantity: 0.5, unit: 'ml', unit_cost: 180 },
    { outbound_id: 'OB-002', material_id: 'MAT-HE-002', batch_no: 'LEICA-HE-20260201-A', quantity: 0.5, unit: 'ml', unit_cost: 120 },
    { outbound_id: 'OB-002', material_id: 'MAT-GLASS-001', batch_no: 'LEICA-GL-20260501', quantity: 8, unit: '片', unit_cost: 180 },

    // OB-003: HE染色出库（李技术）
    { outbound_id: 'OB-003', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260115-A', quantity: 0.5, unit: 'ml', unit_cost: 180 },
    { outbound_id: 'OB-003', material_id: 'MAT-HE-002', batch_no: 'LEICA-HE-20260201-A', quantity: 0.5, unit: 'ml', unit_cost: 120 },
    { outbound_id: 'OB-003', material_id: 'MAT-GLASS-001', batch_no: 'LEICA-GL-20260508', quantity: 5, unit: '片', unit_cost: 185 },

    // OB-004: IHC-广谱CK
    { outbound_id: 'OB-004', material_id: 'MAT-IHC-001', batch_no: 'DAKO-IHC-20260301-A', quantity: 0.05, unit: 'ml', unit_cost: 1200 },
    { outbound_id: 'OB-004', material_id: 'MAT-IHC-097', batch_no: null, quantity: 0.1, unit: 'ml', unit_cost: 3200 },
    { outbound_id: 'OB-004', material_id: 'MAT-IHC-101', batch_no: null, quantity: 0.05, unit: 'ml', unit_cost: 1800 },

    // OB-005: IHC-CD20
    { outbound_id: 'OB-005', material_id: 'MAT-IHC-021', batch_no: 'DAKO-IHC-20260301-A', quantity: 0.05, unit: 'ml', unit_cost: 1350 },
    { outbound_id: 'OB-005', material_id: 'MAT-IHC-097', batch_no: null, quantity: 0.1, unit: 'ml', unit_cost: 3200 },

    // OB-006: IHC-Ki-67
    { outbound_id: 'OB-006', material_id: 'MAT-IHC-049', batch_no: 'DAKO-IHC-20260301-A', quantity: 0.05, unit: 'ml', unit_cost: 1100 },
    { outbound_id: 'OB-006', material_id: 'MAT-IHC-097', batch_no: null, quantity: 0.1, unit: 'ml', unit_cost: 3200 },

    // OB-007: IHC-HER2
    { outbound_id: 'OB-007', material_id: 'MAT-IHC-055', batch_no: 'DAKO-IHC-20260420', quantity: 0.05, unit: 'ml', unit_cost: 1500 },
    { outbound_id: 'OB-007', material_id: 'MAT-IHC-097', batch_no: null, quantity: 0.1, unit: 'ml', unit_cost: 3200 },

    // OB-008: IHC-PD-L1
    { outbound_id: 'OB-008', material_id: 'MAT-IHC-059', batch_no: 'VENTANA-IHC-20260425', quantity: 0.05, unit: 'ml', unit_cost: 2800 },
    { outbound_id: 'OB-008', material_id: 'MAT-IHC-097', batch_no: null, quantity: 0.1, unit: 'ml', unit_cost: 3200 },

    // OB-009: NGS
    { outbound_id: 'OB-009', material_id: 'MAT-MP-001', batch_no: 'THERMO-MP-20260501', quantity: 1, unit: '次', unit_cost: 1800 },
    { outbound_id: 'OB-009', material_id: 'MAT-MP-006', batch_no: null, quantity: 1, unit: '次', unit_cost: 12800 },
    { outbound_id: 'OB-009', material_id: 'MAT-LAB-001', batch_no: null, quantity: 10, unit: '支', unit_cost: 180 },

    // OB-010: FISH-HER2
    { outbound_id: 'OB-010', material_id: 'MAT-MP-008', batch_no: null, quantity: 1, unit: '测试', unit_cost: 6800 },

    // OB-011: FISH-ALK
    { outbound_id: 'OB-011', material_id: 'MAT-MP-009', batch_no: null, quantity: 1, unit: '测试', unit_cost: 7200 },

    // OB-012: PAS染色
    { outbound_id: 'OB-012', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260115-A', quantity: 0.3, unit: 'ml', unit_cost: 180 },
    { outbound_id: 'OB-012', material_id: 'MAT-HE-005', batch_no: 'SINOPHARM-20260501', quantity: 3, unit: 'ml', unit_cost: 25 },

    // OB-013: TCT
    { outbound_id: 'OB-013', material_id: 'MAT-CYTO-005', batch_no: 'BD-CYTO-20260501', quantity: 1, unit: '瓶', unit_cost: 1200 },
    { outbound_id: 'OB-013', material_id: 'MAT-GLASS-001', batch_no: 'LEICA-GL-20260501', quantity: 20, unit: '片', unit_cost: 180 },

    // OB-014: 细针穿刺
    { outbound_id: 'OB-014', material_id: 'MAT-CYTO-001', batch_no: null, quantity: 2, unit: 'ml', unit_cost: 30 },

    // OB-015: 调拨
    { outbound_id: 'OB-015', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260115-A', quantity: 1, unit: 'ml', unit_cost: 180 },

    // OB-016: 报废（过期HER2抗体）
    { outbound_id: 'OB-016', material_id: 'MAT-IHC-004', batch_no: 'DAKO-IHC-20240501-EXP', quantity: 1, unit: 'ml', unit_cost: 1220 },
  ]

  const insertItem = db.prepare(
    `INSERT INTO outbound_items (id, outbound_id, material_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'self', ?, ?)`
  )
  for (const item of items) {
    const totalCost = item.quantity * item.unit_cost
    insertItem.run(uuidv4(), item.outbound_id, item.material_id, item.batch_no, item.quantity, item.unit, item.unit_cost, totalCost, item.outbound_id.startsWith('OB-00') ? '张技术' : '王仓库', now)
  }

  // 更新出库记录的总成本
  for (const o of outbounds) {
    const total = (db.prepare('SELECT COALESCE(SUM(total_cost),0) as total FROM outbound_items WHERE outbound_id = ?').get(o.id) as any)?.total || 0
    db.prepare('UPDATE outbound_records SET total_cost = ? WHERE id = ?').run(total, o.id)
  }

  log(`出库记录创建完成: ${outbounds.length} 笔，明细 ${items.length} 条`)
}

// ============================================
// 6. 创建库存盘点记录
// ============================================
function seedStocktaking(db: any) {
  log('开始创建盘点记录...')
  const check = db.prepare('SELECT COUNT(*) as count FROM stocktaking_records').get() as any
  if (check.count > 0) {
    log('盘点记录已存在，跳过')
    return
  }

  const records = [
    // 苏木素染液 - 系统10瓶，实际9瓶（差异-1）
    { id: 'ST-001', material_id: 'MAT-HE-001', system_stock: 10, actual_stock: 9, difference: -1, operator: '王仓库', remark: '日常损耗' },
    // 伊红染液 - 系统10瓶，实际10瓶（无差异）
    { id: 'ST-002', material_id: 'MAT-HE-002', system_stock: 10, actual_stock: 10, difference: 0, operator: '王仓库', remark: '账实相符' },
    // 无水乙醇 - 系统15瓶，实际14瓶（差异-1）
    { id: 'ST-003', material_id: 'MAT-HE-005', system_stock: 15, actual_stock: 14, difference: -1, operator: '王仓库', remark: '挥发损耗' },
    // 防脱载玻片 - 系统20盒，实际18盒（差异-2）
    { id: 'ST-004', material_id: 'MAT-GLASS-001', system_stock: 20, actual_stock: 18, difference: -2, operator: '王仓库', remark: '破损2盒' },
    // 丁腈手套 - 系统15盒，实际16盒（差异+1）
    { id: 'ST-005', material_id: 'MAT-LAB-010', system_stock: 15, actual_stock: 16, difference: 1, operator: '王仓库', remark: '盘盈1盒' },
    // CK抗体 - 系统3瓶，实际3瓶
    { id: 'ST-006', material_id: 'MAT-IHC-001', system_stock: 3, actual_stock: 3, difference: 0, operator: '王仓库', remark: '账实相符' },
  ]

  const insert = db.prepare(
    `INSERT INTO stocktaking_records (id, stocktaking_no, material_id, system_stock, actual_stock, difference, operator, status, remark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
  )
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    insert.run(r.id, generateStocktakingNo(i + 1), r.material_id, r.system_stock, r.actual_stock, r.difference, r.operator, r.remark, now)
  }
  log(`盘点记录创建完成: ${records.length} 笔`)
}

// ============================================
// 7. 创建退货记录
// ============================================
function seedReturns(db: any) {
  log('开始创建退货记录...')
  const check = db.prepare('SELECT COUNT(*) as count FROM return_records').get() as any
  if (check.count > 0) {
    log('退货记录已存在，跳过')
    return
  }

  const records = [
    { id: 'RT-001', material_id: 'MAT-HE-001', batch_no: 'DAKO-HE-20260320-B', quantity: 1, reason: '包装破损', operator: '王仓库' },
    { id: 'RT-002', material_id: 'MAT-GLASS-001', batch_no: 'LEICA-GL-20260508', quantity: 2, reason: '运输损坏', operator: '王仓库' },
  ]

  const insert = db.prepare(
    `INSERT INTO return_records (id, return_no, material_id, batch_id, quantity, reason, operator, status, remark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
  )
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    insert.run(r.id, generateReturnNo(i + 1), r.material_id, null, r.quantity, r.reason, r.operator, '', now)
  }
  log(`退货记录创建完成: ${records.length} 笔`)
}

// ============================================
// 8. 创建报废记录
// ============================================
function seedScraps(db: any) {
  log('开始创建报废记录...')
  const check = db.prepare('SELECT COUNT(*) as count FROM scrap_records').get() as any
  if (check.count > 0) {
    log('报废记录已存在，跳过')
    return
  }

  const records = [
    { id: 'SC-001', material_id: 'MAT-IHC-004', batch_no: 'DAKO-IHC-20240501-EXP', quantity: 1, reason: '已过期（2025-05-01）', operator: '王仓库' },
    { id: 'SC-002', material_id: 'MAT-HE-003', batch_no: 'LEICA-HE-20260401', quantity: 1, reason: '开封后变质', operator: '王仓库' },
  ]

  const insert = db.prepare(
    `INSERT INTO scrap_records (id, scrap_no, material_id, batch_id, quantity, reason, operator, status, remark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
  )
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    insert.run(r.id, generateScrapNo(i + 1), r.material_id, null, r.quantity, r.reason, r.operator, '', now)
  }
  log(`报废记录创建完成: ${records.length} 笔`)
}

// ============================================
// 9. 创建退货给供应商记录
// ============================================
function seedSupplierReturns(db: any) {
  log('开始创建退货给供应商记录...')
  const check = db.prepare('SELECT COUNT(*) as count FROM supplier_returns WHERE is_deleted = 0').get() as any
  if (check.count > 0) {
    log('退货给供应商记录已存在，跳过')
    return
  }

  const records = [
    // pending: 待发货
    { id: 'SR-001', material_id: 'MAT-HE-001', quantity: 1, supplier_id: 'SUP-003', reason: 'quality_issue', refund_amount: 180, tracking_no: '', status: 'pending', operator: '王仓库', remark: '包装渗漏' },
    // shipped: 已发货
    { id: 'SR-002', material_id: 'MAT-GLASS-001', quantity: 2, supplier_id: 'SUP-003', reason: 'damaged', refund_amount: 360, tracking_no: 'SF1234567890', status: 'shipped', operator: '王仓库', remark: '运输破损' },
    // received: 已收货
    { id: 'SR-003', material_id: 'MAT-IHC-001', quantity: 1, supplier_id: 'SUP-001', reason: 'quality_issue', refund_amount: 1200, tracking_no: 'JD9876543210', status: 'received', operator: '王仓库', remark: '效期不足6个月' },
    // refunded: 已退款
    { id: 'SR-004', material_id: 'MAT-HE-005', quantity: 3, supplier_id: 'SUP-009', reason: 'quantity_mismatch', refund_amount: 75, tracking_no: 'YT5555666677', status: 'refunded', operator: '赵采购', remark: '实际到货少3瓶' },
    // cancelled: 已取消
    { id: 'SR-005', material_id: 'MAT-LAB-010', quantity: 1, supplier_id: 'SUP-010', reason: 'other', refund_amount: 0, tracking_no: '', status: 'cancelled', operator: '王仓库', remark: '与供应商协商换货' },
  ]

  const insert = db.prepare(
    `INSERT INTO supplier_returns (id, return_no, material_id, batch_id, batch_no, quantity, supplier_id, purchase_order_id, inbound_record_id, reason, refund_amount, tracking_no, status, operator, remark, created_at, updated_at, is_deleted)
     VALUES (?, ?, ?, null, null, ?, ?, null, null, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  )
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    insert.run(r.id, generateSupplierReturnNo(i + 1), r.material_id, r.quantity, r.supplier_id, r.reason, r.refund_amount, r.tracking_no, r.status, r.operator, r.remark, now, now)
  }
  log(`退货给供应商记录创建完成: ${records.length} 笔`)
}

// ============================================
// 10. 创建库存流水
// ============================================
function seedStockLogs(db: any) {
  log('开始创建库存流水...')
  const check = db.prepare('SELECT COUNT(*) as count FROM stock_logs').get() as any
  if (check.count > 0) {
    log('库存流水已存在，跳过')
    return
  }

  const inbounds = db.prepare(`SELECT * FROM inbound_records WHERE is_deleted = 0 AND status = 'completed'`).all() as any[]
  const insert = db.prepare(
    'INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  for (const r of inbounds) {
    const beforeStock = 0
    const afterStock = r.quantity
    insert.run(uuidv4(), 'inbound', r.material_id, r.quantity, beforeStock, afterStock, r.id, 'inbound', r.operator, `入库 ${r.inbound_no}`, r.created_at)
  }
  log(`库存流水创建完成: ${inbounds.length} 条`)
}

// ============================================
// 10. 创建操作日志
// ============================================
function seedOperationLogs(db: any) {
  log('开始创建操作日志...')
  const check = db.prepare('SELECT COUNT(*) as count FROM operation_logs').get() as any
  if (check.count > 0) {
    log('操作日志已存在，跳过')
    return
  }

  const logs = [
    { user_id: 'USER-ADMIN', username: 'admin', operation: '系统初始化', description: '执行病理科基础数据初始化脚本' },
    { user_id: 'USER-PRO', username: 'caigou', operation: '采购入库', description: '创建苏木素染液采购入库单 IB-20260511-001' },
    { user_id: 'USER-PRO', username: 'caigou', operation: '采购入库', description: '创建伊红染液采购入库单 IB-20260511-004' },
    { user_id: 'USER-PRO', username: 'caigou', operation: '采购入库', description: '创建IHC抗体批量采购入库（6笔）' },
    { user_id: 'USER-WHM', username: 'cangguan', operation: '库存盘点', description: '完成月度库存盘点，发现差异3笔' },
    { user_id: 'USER-TECH1', username: 'jishuyuan1', operation: '物料领用', description: 'HE染色项目领用-苏木素/伊红/载玻片' },
    { user_id: 'USER-TECH1', username: 'jishuyuan1', operation: '物料领用', description: 'IHC检测领用-广谱CK抗体' },
    { user_id: 'USER-TECH2', username: 'jishuyuan2', operation: '物料领用', description: 'IHC检测领用-Ki-67抗体' },
    { user_id: 'USER-TECH2', username: 'jishuyuan2', operation: '物料领用', description: 'TCT检测领用-液基保存液/载玻片' },
    { user_id: 'USER-WHM', username: 'cangguan', operation: '退货处理', description: '处理苏木素染液包装破损退货1瓶' },
    { user_id: 'USER-WHM', username: 'cangguan', operation: '报废处理', description: '报废过期IHC抗体（2025-05-01到期）' },
    { user_id: 'USER-DOC1', username: 'yishi1', operation: '出库审批', description: '审批通过NGS检测项目出库单' },
    { user_id: 'USER-DOC2', username: 'yishi2', operation: '出库审批', description: '审批通过FISH检测项目出库单' },
  ]

  const insert = db.prepare(
    'INSERT INTO operation_logs (id, user_id, username, operation, description, request_data, response_data, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const l of logs) {
    insert.run(uuidv4(), l.user_id, l.username, l.operation, l.description, '{}', '{}', '127.0.0.1', 'Mozilla/5.0', now)
  }
  log(`操作日志创建完成: ${logs.length} 条`)
}

// ============================================
// 主函数
// ============================================
function main() {
  log('============================================')
  log('业务交易测试数据初始化开始')
  log('============================================')

  const db = getDatabase()

  try {
    seedPurchaseOrders(db)
    seedInboundRecords(db)
    seedBatches(db)
    seedOutboundRecords(db)
    seedInventory(db)
    seedStocktaking(db)
    seedReturns(db)
    seedScraps(db)
    seedSupplierReturns(db)
    seedStockLogs(db)
    seedOperationLogs(db)

    log('============================================')
    log('业务交易测试数据初始化完成')
    log('============================================')
  } catch (err: any) {
    log(`初始化失败: ${err.message}`)
    console.error(err)
    process.exit(1)
  }
}

main()
