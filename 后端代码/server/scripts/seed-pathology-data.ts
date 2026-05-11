/**
 * 病理科基础数据初始化脚本
 * 日期: 2026-05-11
 * 功能: 初始化病理科常用物料分类、物料、供应商、仓库库位、角色、账户
 * 更新: 大幅扩展免疫组化试剂种类，覆盖临床常用全部抗体
 */

import { getDatabase, initializeDatabase } from '../src/database/DatabaseManager.js'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'

const now = new Date().toISOString()
const dateStr = now.slice(0, 10).replace(/-/g, '')

function log(msg: string) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${msg}`)
}

// ============================================
// 1. 创建角色
// ============================================
function seedRoles(db: any) {
  log('开始初始化角色数据...')
  const roles = [
    {
      id: 'ROLE-ADMIN',
      code: 'admin',
      name: '系统管理员',
      description: '拥有系统所有权限，包括用户管理、角色管理、系统配置',
      permissions: JSON.stringify([
        'dashboard', 'inventory', 'inbound', 'outbound', 'stocktaking',
        'categories', 'materials', 'suppliers', 'locations', 'projects', 'bom',
        'cost_analysis', 'alerts', 'users', 'roles', 'logs',
        'purchase_orders', 'returns', 'scraps', 'transfers'
      ]),
      status: 1,
    },
    {
      id: 'ROLE-WAREHOUSE',
      code: 'warehouse_manager',
      name: '仓库管理员',
      description: '负责库存管理、入库出库、盘点等操作',
      permissions: JSON.stringify([
        'dashboard', 'inventory', 'inbound', 'outbound', 'stocktaking',
        'categories', 'materials', 'suppliers', 'locations', 'alerts',
        'purchase_orders', 'returns', 'scraps', 'transfers'
      ]),
      status: 1,
    },
    {
      id: 'ROLE-TECH',
      code: 'technician',
      name: '病理技术员',
      description: '负责物料领用、项目操作、日常消耗记录',
      permissions: JSON.stringify([
        'dashboard', 'inventory', 'outbound', 'projects', 'bom', 'alerts'
      ]),
      status: 1,
    },
    {
      id: 'ROLE-DOCTOR',
      code: 'pathologist',
      name: '病理医师',
      description: '负责诊断项目、审核领用、查看报表',
      permissions: JSON.stringify([
        'dashboard', 'inventory', 'outbound', 'projects', 'bom',
        'cost_analysis', 'alerts'
      ]),
      status: 1,
    },
    {
      id: 'ROLE-PROCURE',
      code: 'procurement',
      name: '采购专员',
      description: '负责采购订单、供应商管理、入库验收',
      permissions: JSON.stringify([
        'dashboard', 'inventory', 'inbound', 'categories', 'materials',
        'suppliers', 'purchase_orders', 'alerts'
      ]),
      status: 1,
    },
    {
      id: 'ROLE-FINANCE',
      code: 'finance',
      name: '财务专员',
      description: '负责成本分析、报表查看、财务核对',
      permissions: JSON.stringify([
        'dashboard', 'cost_analysis', 'logs'
      ]),
      status: 1,
    },
  ]

  const stmt = db.prepare('SELECT COUNT(*) as count FROM roles WHERE is_deleted = 0')
  const existing = stmt.get() as any
  if (existing.count > 1) {
    log('角色数据已存在，跳过角色初始化')
    return
  }

  const insert = db.prepare(
    'INSERT INTO roles (id, code, name, description, permissions, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const r of roles) {
    insert.run(r.id, r.code, r.name, r.description, r.permissions, r.status, now, now)
  }
  log(`角色初始化完成: ${roles.length} 个`)
}

// ============================================
// 2. 创建用户账号
// ============================================
function seedUsers(db: any) {
  log('开始初始化用户账号...')
  const users = [
    { id: 'USER-ADMIN', username: 'admin', realName: '系统管理员', role: 'admin', department: '信息科', phone: '13800000001' },
    { id: 'USER-WHM', username: 'cangguan', realName: '王仓库', role: 'warehouse_manager', department: '病理科', phone: '13800000002' },
    { id: 'USER-TECH1', username: 'jishuyuan1', realName: '张技术', role: 'technician', department: '病理科', phone: '13800000003' },
    { id: 'USER-TECH2', username: 'jishuyuan2', realName: '李技术', role: 'technician', department: '病理科', phone: '13800000004' },
    { id: 'USER-DOC1', username: 'yishi1', realName: '刘医师', role: 'pathologist', department: '病理科', phone: '13800000005' },
    { id: 'USER-DOC2', username: 'yishi2', realName: '陈医师', role: 'pathologist', department: '病理科', phone: '13800000006' },
    { id: 'USER-PRO', username: 'caigou', realName: '赵采购', role: 'procurement', department: '设备科', phone: '13800000007' },
    { id: 'USER-FIN', username: 'caiwu', realName: '孙财务', role: 'finance', department: '财务科', phone: '13800000008' },
  ]

  const insert = db.prepare(
    'INSERT INTO users (id, username, password, real_name, role, department, phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const checkStmt = db.prepare('SELECT COUNT(*) as count FROM users WHERE username = ? AND is_deleted = 0')
  let created = 0
  for (const u of users) {
    const existing = checkStmt.get(u.username) as any
    if (existing.count > 0) {
      log(`用户 ${u.username} 已存在，跳过`)
      continue
    }
    const hashed = bcrypt.hashSync('CoreOne2026!', 12)
    insert.run(u.id, u.username, hashed, u.realName, u.role, u.department, u.phone, 1, now, now)
    created++
  }
  log(`用户初始化完成: 新增 ${created} 个，默认密码: CoreOne2026!`)
}

// ============================================
// 3. 创建供应商
// ============================================
function seedSuppliers(db: any) {
  log('开始初始化供应商数据...')
  const suppliers = [
    { id: 'SUP-001', code: 'DAKO', name: '丹科（DAKO）', contact: '张经理', phone: '021-12345678', address: '上海市浦东新区张江高科技园区', rating: 5 },
    { id: 'SUP-002', code: 'VENTANA', name: '文塔纳（Ventana）', contact: '李经理', phone: '021-23456789', address: '上海市徐汇区漕河泾开发区', rating: 5 },
    { id: 'SUP-003', code: 'LEICA', name: '徕卡（Leica）', contact: '王经理', phone: '021-34567890', address: '上海市静安区南京西路', rating: 4 },
    { id: 'SUP-004', code: 'THERMO', name: '赛默飞（Thermo Fisher）', contact: '赵经理', phone: '021-45678901', address: '上海市浦东新区金桥出口加工区', rating: 5 },
    { id: 'SUP-005', code: 'ROCHE', name: '罗氏（Roche）', contact: '陈经理', phone: '021-56789012', address: '上海市浦东新区外高桥保税区', rating: 5 },
    { id: 'SUP-006', code: 'QIAGEN', name: '凯杰（Qiagen）', contact: '刘经理', phone: '021-67890123', address: '上海市闵行区莘庄工业区', rating: 4 },
    { id: 'SUP-007', code: 'AGILENT', name: '安捷伦（Agilent）', contact: '周经理', phone: '021-78901234', address: '上海市浦东新区张江药谷', rating: 4 },
    { id: 'SUP-008', code: 'BD', name: 'BD生物科学', contact: '吴经理', phone: '021-89012345', address: '上海市浦东新区陆家嘴金融贸易区', rating: 4 },
    { id: 'SUP-009', code: 'SINOPHARM', name: '国药器械上海分公司', contact: '郑经理', phone: '021-90123456', address: '上海市黄浦区外滩', rating: 3 },
    { id: 'SUP-010', code: 'YUHUA', name: '裕华耗材批发', contact: '孙经理', phone: '021-01234567', address: '上海市普陀区真北路', rating: 3 },
  ]

  const check = db.prepare('SELECT COUNT(*) as count FROM suppliers WHERE is_deleted = 0')
  const existing = check.get() as any
  if (existing.count > 0) {
    log('供应商数据已存在，跳过供应商初始化')
    return
  }

  const insert = db.prepare(
    'INSERT INTO suppliers (id, code, name, contact, phone, address, rating, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const s of suppliers) {
    insert.run(s.id, s.code, s.name, s.contact, s.phone, s.address, s.rating, 1, now, now)
  }
  log(`供应商初始化完成: ${suppliers.length} 家`)
}

// ============================================
// 4. 创建仓库库位
// ============================================
function seedLocations(db: any) {
  log('开始初始化仓库库位...')
  const locations = [
    { id: 'LOC-A01', code: 'A-01-01', name: 'A区-01架-01位', type: 'shelf', zone: 'A区（试剂冷藏区）', shelf: '01架', position: '01位', capacity: 50 },
    { id: 'LOC-A02', code: 'A-01-02', name: 'A区-01架-02位', type: 'shelf', zone: 'A区（试剂冷藏区）', shelf: '01架', position: '02位', capacity: 50 },
    { id: 'LOC-A03', code: 'A-02-01', name: 'A区-02架-01位', type: 'shelf', zone: 'A区（试剂冷藏区）', shelf: '02架', position: '01位', capacity: 50 },
    { id: 'LOC-A04', code: 'A-02-02', name: 'A区-02架-02位', type: 'shelf', zone: 'A区（试剂冷藏区）', shelf: '02架', position: '02位', capacity: 50 },
    { id: 'LOC-A05', code: 'A-03-01', name: 'A区-03架-01位', type: 'shelf', zone: 'A区（试剂冷藏区）', shelf: '03架', position: '01位', capacity: 50 },
    { id: 'LOC-B01', code: 'B-01-01', name: 'B区-01架-01位', type: 'shelf', zone: 'B区（耗材常温区）', shelf: '01架', position: '01位', capacity: 100 },
    { id: 'LOC-B02', code: 'B-01-02', name: 'B区-01架-02位', type: 'shelf', zone: 'B区（耗材常温区）', shelf: '01架', position: '02位', capacity: 100 },
    { id: 'LOC-B03', code: 'B-02-01', name: 'B区-02架-01位', type: 'shelf', zone: 'B区（耗材常温区）', shelf: '02架', position: '01位', capacity: 100 },
    { id: 'LOC-B04', code: 'B-02-02', name: 'B区-02架-02位', type: 'shelf', zone: 'B区（耗材常温区）', shelf: '02架', position: '02位', capacity: 100 },
    { id: 'LOC-C01', code: 'C-01-01', name: 'C区-01架-01位', type: 'shelf', zone: 'C区（免疫组化试剂区）', shelf: '01架', position: '01位', capacity: 50 },
    { id: 'LOC-C02', code: 'C-01-02', name: 'C区-01架-02位', type: 'shelf', zone: 'C区（免疫组化试剂区）', shelf: '01架', position: '02位', capacity: 50 },
    { id: 'LOC-C03', code: 'C-02-01', name: 'C区-02架-01位', type: 'shelf', zone: 'C区（免疫组化试剂区）', shelf: '02架', position: '01位', capacity: 50 },
    { id: 'LOC-C04', code: 'C-02-02', name: 'C区-02架-02位', type: 'shelf', zone: 'C区（免疫组化试剂区）', shelf: '02架', position: '02位', capacity: 50 },
    { id: 'LOC-C05', code: 'C-03-01', name: 'C区-03架-01位', type: 'shelf', zone: 'C区（免疫组化试剂区）', shelf: '03架', position: '01位', capacity: 50 },
    { id: 'LOC-D01', code: 'D-01-01', name: 'D区-01架-01位', type: 'shelf', zone: 'D区（分子诊断试剂区）', shelf: '01架', position: '01位', capacity: 40 },
    { id: 'LOC-D02', code: 'D-01-02', name: 'D区-01架-02位', type: 'shelf', zone: 'D区（分子诊断试剂区）', shelf: '01架', position: '02位', capacity: 40 },
    { id: 'LOC-D03', code: 'D-02-01', name: 'D区-02架-01位', type: 'shelf', zone: 'D区（分子诊断试剂区）', shelf: '02架', position: '01位', capacity: 40 },
    { id: 'LOC-E01', code: 'E-01-01', name: 'E区-01架-01位', type: 'shelf', zone: 'E区（细胞学试剂区）', shelf: '01架', position: '01位', capacity: 40 },
    { id: 'LOC-E02', code: 'E-01-02', name: 'E区-01架-02位', type: 'shelf', zone: 'E区（细胞学试剂区）', shelf: '01架', position: '02位', capacity: 40 },
    { id: 'LOC-F01', code: 'F-01-01', name: 'F区-01架-01位', type: 'shelf', zone: 'F区（危险品存储区）', shelf: '01架', position: '01位', capacity: 20 },
    { id: 'LOC-F02', code: 'F-01-02', name: 'F区-01架-02位', type: 'shelf', zone: 'F区（危险品存储区）', shelf: '01架', position: '02位', capacity: 20 },
    { id: 'LOC-G01', code: 'G-01-01', name: 'G区-01架-01位', type: 'shelf', zone: 'G区（大型设备耗材区）', shelf: '01架', position: '01位', capacity: 30 },
    { id: 'LOC-G02', code: 'G-01-02', name: 'G区-01架-02位', type: 'shelf', zone: 'G区（大型设备耗材区）', shelf: '01架', position: '02位', capacity: 30 },
    { id: 'LOC-RECEIVE', code: 'RECEIVING', name: '收货暂存区', type: 'receiving', zone: '收货区', shelf: null, position: null, capacity: 200 },
    { id: 'LOC-RETURN', code: 'RETURN', name: '退货暂存区', type: 'return', zone: '退货区', shelf: null, position: null, capacity: 50 },
    { id: 'LOC-SCRAP', code: 'SCRAP', name: '报废暂存区', type: 'scrap', zone: '报废区', shelf: null, position: null, capacity: 30 },
  ]

  const check = db.prepare('SELECT COUNT(*) as count FROM locations WHERE is_deleted = 0')
  const existing = check.get() as any
  if (existing.count > 0) {
    log('仓库库位已存在，跳过库位初始化')
    return
  }

  const insert = db.prepare(
    'INSERT INTO locations (id, code, name, type, zone, shelf, position, capacity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const l of locations) {
    insert.run(l.id, l.code, l.name, l.type, l.zone, l.shelf, l.position, l.capacity, 1, now, now)
  }
  log(`仓库库位初始化完成: ${locations.length} 个`)
}

// ============================================
// 5. 创建物料分类（三级分类）
// ============================================
function seedCategories(db: any) {
  log('开始初始化物料分类...')

  const check = db.prepare('SELECT COUNT(*) as count FROM material_categories WHERE is_deleted = 0')
  const existing = check.get() as any
  if (existing.count > 0) {
    log('物料分类已存在，跳过分类初始化')
    return
  }

  // 一级分类
  const level1 = [
    { id: 'CAT-HE', code: 'CAT-HE', name: 'HE制片耗材' },
    { id: 'CAT-IHC', code: 'CAT-IHC', name: '免疫组化试剂' },
    { id: 'CAT-SS', code: 'CAT-SS', name: '特殊染色试剂' },
    { id: 'CAT-MP', code: 'CAT-MP', name: '分子诊断试剂' },
    { id: 'CAT-CYTO', code: 'CAT-CYTO', name: '细胞学试剂' },
    { id: 'CAT-GLASS', code: 'CAT-GLASS', name: '玻片与载具' },
    { id: 'CAT-FIX', code: 'CAT-FIX', name: '固定液与保存液' },
    { id: 'CAT-DEVICE', code: 'CAT-DEVICE', name: '设备耗材' },
    { id: 'CAT-LAB', code: 'CAT-LAB', name: '通用实验室耗材' },
    { id: 'CAT-SAFE', code: 'CAT-SAFE', name: '防护用品' },
  ]

  // 二级分类
  const level2 = [
    // HE制片耗材
    { id: 'CAT-HE-01', parent: 'CAT-HE', code: 'CAT-HE-01', name: '染色试剂' },
    { id: 'CAT-HE-02', parent: 'CAT-HE', code: 'CAT-HE-02', name: '脱水透明试剂' },
    { id: 'CAT-HE-03', parent: 'CAT-HE', code: 'CAT-HE-03', name: '包埋试剂' },
    { id: 'CAT-HE-04', parent: 'CAT-HE', code: 'CAT-HE-04', name: '封片试剂' },
    // 免疫组化试剂 - 扩展
    { id: 'CAT-IHC-01', parent: 'CAT-IHC', code: 'CAT-IHC-01', name: '一抗试剂-上皮标志物' },
    { id: 'CAT-IHC-02', parent: 'CAT-IHC', code: 'CAT-IHC-02', name: '一抗试剂-间叶标志物' },
    { id: 'CAT-IHC-03', parent: 'CAT-IHC', code: 'CAT-IHC-03', name: '一抗试剂-淋巴造血标志物' },
    { id: 'CAT-IHC-04', parent: 'CAT-IHC', code: 'CAT-IHC-04', name: '一抗试剂-神经内分泌标志物' },
    { id: 'CAT-IHC-05', parent: 'CAT-IHC', code: 'CAT-IHC-05', name: '一抗试剂-增殖与凋亡标志物' },
    { id: 'CAT-IHC-06', parent: 'CAT-IHC', code: 'CAT-IHC-06', name: '一抗试剂-受体与信号通路' },
    { id: 'CAT-IHC-07', parent: 'CAT-IHC', code: 'CAT-IHC-07', name: '一抗试剂-病毒与感染标志物' },
    { id: 'CAT-IHC-08', parent: 'CAT-IHC', code: 'CAT-IHC-08', name: '一抗试剂-组织特异性标志物' },
    { id: 'CAT-IHC-09', parent: 'CAT-IHC', code: 'CAT-IHC-09', name: '二抗与检测系统' },
    { id: 'CAT-IHC-10', parent: 'CAT-IHC', code: 'CAT-IHC-10', name: '显色试剂' },
    { id: 'CAT-IHC-11', parent: 'CAT-IHC', code: 'CAT-IHC-11', name: '抗原修复试剂' },
    { id: 'CAT-IHC-12', parent: 'CAT-IHC', code: 'CAT-IHC-12', name: '封闭与洗涤试剂' },
    { id: 'CAT-IHC-13', parent: 'CAT-IHC', code: 'CAT-IHC-13', name: '对照试剂与质控品' },
    { id: 'CAT-IHC-14', parent: 'CAT-IHC', code: 'CAT-IHC-14', name: 'IHC辅助试剂' },
    // 特殊染色试剂
    { id: 'CAT-SS-01', parent: 'CAT-SS', code: 'CAT-SS-01', name: '网状纤维染色' },
    { id: 'CAT-SS-02', parent: 'CAT-SS', code: 'CAT-SS-02', name: 'PAS染色' },
    { id: 'CAT-SS-03', parent: 'CAT-SS', code: 'CAT-SS-03', name: '抗酸染色' },
    { id: 'CAT-SS-04', parent: 'CAT-SS', code: 'CAT-SS-04', name: '革兰氏染色' },
    { id: 'CAT-SS-05', parent: 'CAT-SS', code: 'CAT-SS-05', name: '结缔组织染色' },
    { id: 'CAT-SS-06', parent: 'CAT-SS', code: 'CAT-SS-06', name: '脂类染色' },
    // 分子诊断试剂
    { id: 'CAT-MP-01', parent: 'CAT-MP', code: 'CAT-MP-01', name: 'DNA提取试剂' },
    { id: 'CAT-MP-02', parent: 'CAT-MP', code: 'CAT-MP-02', name: 'RNA提取试剂' },
    { id: 'CAT-MP-03', parent: 'CAT-MP', code: 'CAT-MP-03', name: 'PCR试剂' },
    { id: 'CAT-MP-04', parent: 'CAT-MP', code: 'CAT-MP-04', name: 'NGS试剂盒' },
    { id: 'CAT-MP-05', parent: 'CAT-MP', code: 'CAT-MP-05', name: 'FISH探针' },
    { id: 'CAT-MP-06', parent: 'CAT-MP', code: 'CAT-MP-06', name: '测序试剂' },
    // 细胞学试剂
    { id: 'CAT-CYTO-01', parent: 'CAT-CYTO', code: 'CAT-CYTO-01', name: '细胞固定液' },
    { id: 'CAT-CYTO-02', parent: 'CAT-CYTO', code: 'CAT-CYTO-02', name: '细胞染色液' },
    { id: 'CAT-CYTO-03', parent: 'CAT-CYTO', code: 'CAT-CYTO-03', name: '液基细胞试剂' },
    // 玻片与载具
    { id: 'CAT-GLASS-01', parent: 'CAT-GLASS', code: 'CAT-GLASS-01', name: '载玻片' },
    { id: 'CAT-GLASS-02', parent: 'CAT-GLASS', code: 'CAT-GLASS-02', name: '盖玻片' },
    { id: 'CAT-GLASS-03', parent: 'CAT-GLASS', code: 'CAT-GLASS-03', name: '组织包埋盒' },
    { id: 'CAT-GLASS-04', parent: 'CAT-GLASS', code: 'CAT-GLASS-04', name: '载玻片架与配件' },
    // 固定液与保存液
    { id: 'CAT-FIX-01', parent: 'CAT-FIX', code: 'CAT-FIX-01', name: '甲醛固定液' },
    { id: 'CAT-FIX-02', parent: 'CAT-FIX', code: 'CAT-FIX-02', name: '特殊固定液' },
    { id: 'CAT-FIX-03', parent: 'CAT-FIX', code: 'CAT-FIX-03', name: '组织保存液' },
    { id: 'CAT-FIX-04', parent: 'CAT-FIX', code: 'CAT-FIX-04', name: '脱钙液' },
    // 设备耗材
    { id: 'CAT-DEVICE-01', parent: 'CAT-DEVICE', code: 'CAT-DEVICE-01', name: '切片机刀片' },
    { id: 'CAT-DEVICE-02', parent: 'CAT-DEVICE', code: 'CAT-DEVICE-02', name: '染色机耗材' },
    { id: 'CAT-DEVICE-03', parent: 'CAT-DEVICE', code: 'CAT-DEVICE-03', name: '封片机耗材' },
    { id: 'CAT-DEVICE-04', parent: 'CAT-DEVICE', code: 'CAT-DEVICE-04', name: '打印机耗材' },
    // 通用实验室耗材
    { id: 'CAT-LAB-01', parent: 'CAT-LAB', code: 'CAT-LAB-01', name: '移液器吸头' },
    { id: 'CAT-LAB-02', parent: 'CAT-LAB', code: 'CAT-LAB-02', name: '离心管' },
    { id: 'CAT-LAB-03', parent: 'CAT-LAB', code: 'CAT-LAB-03', name: 'PCR管/板' },
    { id: 'CAT-LAB-04', parent: 'CAT-LAB', code: 'CAT-LAB-04', name: '称量纸与滤纸' },
    { id: 'CAT-LAB-05', parent: 'CAT-LAB', code: 'CAT-LAB-05', name: '一次性手套' },
    // 防护用品
    { id: 'CAT-SAFE-01', parent: 'CAT-SAFE', code: 'CAT-SAFE-01', name: '防护口罩' },
    { id: 'CAT-SAFE-02', parent: 'CAT-SAFE', code: 'CAT-SAFE-02', name: '防护面罩' },
    { id: 'CAT-SAFE-03', parent: 'CAT-SAFE', code: 'CAT-SAFE-03', name: '防护服' },
    { id: 'CAT-SAFE-04', parent: 'CAT-SAFE', code: 'CAT-SAFE-04', name: '急救用品' },
  ]

  // 三级分类
  const level3 = [
    // HE染色试剂
    { id: 'CAT-HE-01-01', parent: 'CAT-HE-01', code: 'CAT-HE-01-01', name: '苏木素染液' },
    { id: 'CAT-HE-01-02', parent: 'CAT-HE-01', code: 'CAT-HE-01-02', name: '伊红染液' },
    { id: 'CAT-HE-01-03', parent: 'CAT-HE-01', code: 'CAT-HE-01-03', name: '分化液' },
    { id: 'CAT-HE-01-04', parent: 'CAT-HE-01', code: 'CAT-HE-01-04', name: '返蓝液' },

    // IHC一抗-上皮标志物
    { id: 'CAT-IHC-01-01', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-01', name: '广谱CK（CKpan/AE1/AE3）' },
    { id: 'CAT-IHC-01-02', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-02', name: 'CK7' },
    { id: 'CAT-IHC-01-03', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-03', name: 'CK20' },
    { id: 'CAT-IHC-01-04', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-04', name: 'CK5/6' },
    { id: 'CAT-IHC-01-05', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-05', name: 'EMA' },
    { id: 'CAT-IHC-01-06', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-06', name: 'BerEP4' },
    { id: 'CAT-IHC-01-07', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-07', name: 'TTF-1' },
    { id: 'CAT-IHC-01-08', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-08', name: 'Napsin A' },
    { id: 'CAT-IHC-01-09', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-09', name: 'GATA3' },
    { id: 'CAT-IHC-01-10', parent: 'CAT-IHC-01', code: 'CAT-IHC-01-10', name: 'PAX8' },

    // IHC一抗-间叶标志物
    { id: 'CAT-IHC-02-01', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-01', name: 'Vimentin' },
    { id: 'CAT-IHC-02-02', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-02', name: 'SMA（平滑肌肌动蛋白）' },
    { id: 'CAT-IHC-02-03', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-03', name: 'Desmin' },
    { id: 'CAT-IHC-02-04', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-04', name: 'S-100' },
    { id: 'CAT-IHC-02-05', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-05', name: 'CD34' },
    { id: 'CAT-IHC-02-06', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-06', name: 'CD31' },
    { id: 'CAT-IHC-02-07', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-07', name: 'ERG' },
    { id: 'CAT-IHC-02-08', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-08', name: 'CD117（c-Kit）' },
    { id: 'CAT-IHC-02-09', parent: 'CAT-IHC-02', code: 'CAT-IHC-02-09', name: 'DOG1' },

    // IHC一抗-淋巴造血标志物
    { id: 'CAT-IHC-03-01', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-01', name: 'CD3' },
    { id: 'CAT-IHC-03-02', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-02', name: 'CD20' },
    { id: 'CAT-IHC-03-03', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-03', name: 'CD45（LCA）' },
    { id: 'CAT-IHC-03-04', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-04', name: 'CD30' },
    { id: 'CAT-IHC-03-05', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-05', name: 'CD15' },
    { id: 'CAT-IHC-03-06', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-06', name: 'CD10' },
    { id: 'CAT-IHC-03-07', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-07', name: 'BCL-2' },
    { id: 'CAT-IHC-03-08', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-08', name: 'BCL-6' },
    { id: 'CAT-IHC-03-09', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-09', name: 'MUM1' },
    { id: 'CAT-IHC-03-10', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-10', name: 'CD21' },
    { id: 'CAT-IHC-03-11', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-11', name: 'CD23' },
    { id: 'CAT-IHC-03-12', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-12', name: 'Cyclin D1' },
    { id: 'CAT-IHC-03-13', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-13', name: 'SOX11' },
    { id: 'CAT-IHC-03-14', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-14', name: 'MPO' },
    { id: 'CAT-IHC-03-15', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-15', name: 'CD68' },
    { id: 'CAT-IHC-03-16', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-16', name: 'CD163' },
    { id: 'CAT-IHC-03-17', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-17', name: 'CD138' },
    { id: 'CAT-IHC-03-18', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-18', name: 'Kappa轻链' },
    { id: 'CAT-IHC-03-19', parent: 'CAT-IHC-03', code: 'CAT-IHC-03-19', name: 'Lambda轻链' },

    // IHC一抗-神经内分泌标志物
    { id: 'CAT-IHC-04-01', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-01', name: 'Syn（突触素）' },
    { id: 'CAT-IHC-04-02', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-02', name: 'CgA（嗜铬粒蛋白A）' },
    { id: 'CAT-IHC-04-03', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-03', name: 'CD56' },
    { id: 'CAT-IHC-04-04', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-04', name: 'NSE' },
    { id: 'CAT-IHC-04-05', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-05', name: 'INSM1' },
    { id: 'CAT-IHC-04-06', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-06', name: 'NeuN' },
    { id: 'CAT-IHC-04-07', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-07', name: 'GFAP' },
    { id: 'CAT-IHC-04-08', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-08', name: 'Olig2' },
    { id: 'CAT-IHC-04-09', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-09', name: 'IDH1（R132H）' },
    { id: 'CAT-IHC-04-10', parent: 'CAT-IHC-04', code: 'CAT-IHC-04-10', name: 'ATRX' },

    // IHC一抗-增殖与凋亡标志物
    { id: 'CAT-IHC-05-01', parent: 'CAT-IHC-05', code: 'CAT-IHC-05-01', name: 'Ki-67' },
    { id: 'CAT-IHC-05-02', parent: 'CAT-IHC-05', code: 'CAT-IHC-05-02', name: 'P53' },
    { id: 'CAT-IHC-05-03', parent: 'CAT-IHC-05', code: 'CAT-IHC-05-03', name: 'P16' },
    { id: 'CAT-IHC-05-04', parent: 'CAT-IHC-05', code: 'CAT-IHC-05-04', name: 'P21' },
    { id: 'CAT-IHC-05-05', parent: 'CAT-IHC-05', code: 'CAT-IHC-05-05', name: 'P27' },
    { id: 'CAT-IHC-05-06', parent: 'CAT-IHC-05', code: 'CAT-IHC-05-06', name: 'BCL-2' },
    { id: 'CAT-IHC-05-07', parent: 'CAT-IHC-05', code: 'CAT-IHC-05-07', name: 'Caspase-3' },
    { id: 'CAT-IHC-05-08', parent: 'CAT-IHC-05', code: 'CAT-IHC-05-08', name: 'Cyclin D1' },

    // IHC一抗-受体与信号通路
    { id: 'CAT-IHC-06-01', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-01', name: 'HER2（ERBB2）' },
    { id: 'CAT-IHC-06-02', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-02', name: 'ER（雌激素受体）' },
    { id: 'CAT-IHC-06-03', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-03', name: 'PR（孕激素受体）' },
    { id: 'CAT-IHC-06-04', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-04', name: 'AR（雄激素受体）' },
    { id: 'CAT-IHC-06-05', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-05', name: 'PD-L1（22C3）' },
    { id: 'CAT-IHC-06-06', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-06', name: 'PD-L1（28-8）' },
    { id: 'CAT-IHC-06-07', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-07', name: 'PD-L1（SP263）' },
    { id: 'CAT-IHC-06-08', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-08', name: 'EGFR' },
    { id: 'CAT-IHC-06-09', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-09', name: 'ALK（D5F3）' },
    { id: 'CAT-IHC-06-10', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-10', name: 'ROS1' },
    { id: 'CAT-IHC-06-11', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-11', name: 'RET' },
    { id: 'CAT-IHC-06-12', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-12', name: 'MET' },
    { id: 'CAT-IHC-06-13', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-13', name: 'KRAS' },
    { id: 'CAT-IHC-06-14', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-14', name: 'BRAF（V600E）' },
    { id: 'CAT-IHC-06-15', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-15', name: 'MSH2' },
    { id: 'CAT-IHC-06-16', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-16', name: 'MSH6' },
    { id: 'CAT-IHC-06-17', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-17', name: 'MLH1' },
    { id: 'CAT-IHC-06-18', parent: 'CAT-IHC-06', code: 'CAT-IHC-06-18', name: 'PMS2' },

    // IHC一抗-病毒与感染标志物
    { id: 'CAT-IHC-07-01', parent: 'CAT-IHC-07', code: 'CAT-IHC-07-01', name: 'HPV（L1壳蛋白）' },
    { id: 'CAT-IHC-07-02', parent: 'CAT-IHC-07', code: 'CAT-IHC-07-02', name: 'EBV（LMP-1）' },
    { id: 'CAT-IHC-07-03', parent: 'CAT-IHC-07', code: 'CAT-IHC-07-03', name: 'CMV' },
    { id: 'CAT-IHC-07-04', parent: 'CAT-IHC-07', code: 'CAT-IHC-07-04', name: 'HSV' },
    { id: 'CAT-IHC-07-05', parent: 'CAT-IHC-07', code: 'CAT-IHC-07-05', name: 'HHV-8' },
    { id: 'CAT-IHC-07-06', parent: 'CAT-IHC-07', code: 'CAT-IHC-07-06', name: 'HBsAg' },

    // IHC一抗-组织特异性标志物
    { id: 'CAT-IHC-08-01', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-01', name: 'PSA' },
    { id: 'CAT-IHC-08-02', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-02', name: 'PSAP' },
    { id: 'CAT-IHC-08-03', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-03', name: 'NKX3.1' },
    { id: 'CAT-IHC-08-04', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-04', name: 'WT1' },
    { id: 'CAT-IHC-08-05', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-05', name: 'Calretinin' },
    { id: 'CAT-IHC-08-06', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-06', name: 'Inhibin' },
    { id: 'CAT-IHC-08-07', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-07', name: 'HepPar-1' },
    { id: 'CAT-IHC-08-08', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-08', name: 'Arginase-1' },
    { id: 'CAT-IHC-08-09', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-09', name: 'TTF-1' },
    { id: 'CAT-IHC-08-10', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-10', name: 'Napsin A' },
    { id: 'CAT-IHC-08-11', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-11', name: 'GATA3' },
    { id: 'CAT-IHC-08-12', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-12', name: 'PAX8' },
    { id: 'CAT-IHC-08-13', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-13', name: 'RCC' },
    { id: 'CAT-IHC-08-14', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-14', name: 'CDX2' },
    { id: 'CAT-IHC-08-15', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-15', name: 'SATB2' },
    { id: 'CAT-IHC-08-16', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-16', name: 'Villin' },
    { id: 'CAT-IHC-08-17', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-17', name: 'MUC2' },
    { id: 'CAT-IHC-08-18', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-18', name: 'MUC5AC' },
    { id: 'CAT-IHC-08-19', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-19', name: 'MUC6' },
    { id: 'CAT-IHC-08-20', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-20', name: 'Brachyury' },
    { id: 'CAT-IHC-08-21', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-21', name: 'SALL4' },
    { id: 'CAT-IHC-08-22', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-22', name: 'OCT3/4' },
    { id: 'CAT-IHC-08-23', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-23', name: 'PLAP' },
    { id: 'CAT-IHC-08-24', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-24', name: 'AFP' },
    { id: 'CAT-IHC-08-25', parent: 'CAT-IHC-08', code: 'CAT-IHC-08-25', name: 'HCG' },

    // 二抗与检测系统
    { id: 'CAT-IHC-09-01', parent: 'CAT-IHC-09', code: 'CAT-IHC-09-01', name: 'EnVision二抗试剂盒' },
    { id: 'CAT-IHC-09-02', parent: 'CAT-IHC-09', code: 'CAT-IHC-09-02', name: 'Polymer二抗试剂盒' },
    { id: 'CAT-IHC-09-03', parent: 'CAT-IHC-09', code: 'CAT-IHC-09-03', name: 'LSAB检测系统' },
    { id: 'CAT-IHC-09-04', parent: 'CAT-IHC-09', code: 'CAT-IHC-09-04', name: 'ABC检测系统' },
    { id: 'CAT-IHC-09-05', parent: 'CAT-IHC-09', code: 'CAT-IHC-09-05', name: '兔/鼠通用二抗' },

    // 显色试剂
    { id: 'CAT-IHC-10-01', parent: 'CAT-IHC-10', code: 'CAT-IHC-10-01', name: 'DAB显色试剂盒' },
    { id: 'CAT-IHC-10-02', parent: 'CAT-IHC-10', code: 'CAT-IHC-10-02', name: 'AEC显色试剂盒' },
    { id: 'CAT-IHC-10-03', parent: 'CAT-IHC-10', code: 'CAT-IHC-10-03', name: 'DAB+底物缓冲液' },
    { id: 'CAT-IHC-10-04', parent: 'CAT-IHC-10', code: 'CAT-IHC-10-04', name: 'Vector Red显色试剂' },
    { id: 'CAT-IHC-10-05', parent: 'CAT-IHC-10', code: 'CAT-IHC-10-05', name: 'BCIP/NBT显色试剂' },
    { id: 'CAT-IHC-10-06', parent: 'CAT-IHC-10', code: 'CAT-IHC-10-06', name: '荧光标记二抗' },

    // 抗原修复试剂
    { id: 'CAT-IHC-11-01', parent: 'CAT-IHC-11', code: 'CAT-IHC-11-01', name: 'EDTA抗原修复液（pH9.0）' },
    { id: 'CAT-IHC-11-02', parent: 'CAT-IHC-11', code: 'CAT-IHC-11-02', name: '柠檬酸抗原修复液（pH6.0）' },
    { id: 'CAT-IHC-11-03', parent: 'CAT-IHC-11', code: 'CAT-IHC-11-03', name: 'Tris-EDTA修复液（pH9.0）' },
    { id: 'CAT-IHC-11-04', parent: 'CAT-IHC-11', code: 'CAT-IHC-11-04', name: '酶消化修复液（胰蛋白酶）' },
    { id: 'CAT-IHC-11-05', parent: 'CAT-IHC-11', code: 'CAT-IHC-11-05', name: '胃蛋白酶修复液' },

    // 封闭与洗涤试剂
    { id: 'CAT-IHC-12-01', parent: 'CAT-IHC-12', code: 'CAT-IHC-12-01', name: '正常血清封闭液' },
    { id: 'CAT-IHC-12-02', parent: 'CAT-IHC-12', code: 'CAT-IHC-12-02', name: 'BSA封闭液' },
    { id: 'CAT-IHC-12-03', parent: 'CAT-IHC-12', code: 'CAT-IHC-12-03', name: 'PBS洗涤缓冲液' },
    { id: 'CAT-IHC-12-04', parent: 'CAT-IHC-12', code: 'CAT-IHC-12-04', name: 'TBST洗涤缓冲液' },
    { id: 'CAT-IHC-12-05', parent: 'CAT-IHC-12', code: 'CAT-IHC-12-05', name: 'Tween-20' },

    // 对照试剂与质控品
    { id: 'CAT-IHC-13-01', parent: 'CAT-IHC-13', code: 'CAT-IHC-13-01', name: '阳性对照组织片' },
    { id: 'CAT-IHC-13-02', parent: 'CAT-IHC-13', code: 'CAT-IHC-13-02', name: '阴性对照试剂' },
    { id: 'CAT-IHC-13-03', parent: 'CAT-IHC-13', code: 'CAT-IHC-13-03', name: '同型对照抗体' },
    { id: 'CAT-IHC-13-04', parent: 'CAT-IHC-13', code: 'CAT-IHC-13-04', name: '多组织对照蜡块' },
    { id: 'CAT-IHC-13-05', parent: 'CAT-IHC-13', code: 'CAT-IHC-13-05', name: 'IHC质控品套装' },

    // IHC辅助试剂
    { id: 'CAT-IHC-14-01', parent: 'CAT-IHC-14', code: 'CAT-IHC-14-01', name: '苏木素复染液' },
    { id: 'CAT-IHC-14-02', parent: 'CAT-IHC-14', code: 'CAT-IHC-14-02', name: '中性树胶封片剂' },
    { id: 'CAT-IHC-14-03', parent: 'CAT-IHC-14', code: 'CAT-IHC-14-03', name: '防脱载玻片（IHC专用）' },
    { id: 'CAT-IHC-14-04', parent: 'CAT-IHC-14', code: 'CAT-IHC-14-04', name: '过氧化物酶阻断剂' },
    { id: 'CAT-IHC-14-05', parent: 'CAT-IHC-14', code: 'CAT-IHC-14-05', name: '内源性生物素阻断剂' },
    { id: 'CAT-IHC-14-06', parent: 'CAT-IHC-14', code: 'CAT-IHC-14-06', name: '抗体稀释液' },

    // 特殊染色
    { id: 'CAT-SS-01-01', parent: 'CAT-SS-01', code: 'CAT-SS-01-01', name: '银染试剂盒' },
    { id: 'CAT-SS-02-01', parent: 'CAT-SS-02', code: 'CAT-SS-02-01', name: 'PAS染色试剂盒' },
    { id: 'CAT-SS-03-01', parent: 'CAT-SS-03', code: 'CAT-SS-03-01', name: '抗酸染色试剂' },
    { id: 'CAT-SS-04-01', parent: 'CAT-SS-04', code: 'CAT-SS-04-01', name: '革兰氏染色试剂' },
    { id: 'CAT-SS-05-01', parent: 'CAT-SS-05', code: 'CAT-SS-05-01', name: 'Masson三色染色试剂' },
    { id: 'CAT-SS-05-02', parent: 'CAT-SS-05', code: 'CAT-SS-05-02', name: 'Van Gieson染色试剂' },
    { id: 'CAT-SS-06-01', parent: 'CAT-SS-06', code: 'CAT-SS-06-01', name: '油红O染色试剂' },

    // 分子诊断
    { id: 'CAT-MP-01-01', parent: 'CAT-MP-01', code: 'CAT-MP-01-01', name: 'FFPE DNA提取试剂盒' },
    { id: 'CAT-MP-01-02', parent: 'CAT-MP-01', code: 'CAT-MP-01-02', name: '血液DNA提取试剂盒' },
    { id: 'CAT-MP-02-01', parent: 'CAT-MP-02', code: 'CAT-MP-02-01', name: 'RNA提取试剂盒（TRIzol法）' },
    { id: 'CAT-MP-03-01', parent: 'CAT-MP-03', code: 'CAT-MP-03-01', name: 'PCR Master Mix（2X）' },
    { id: 'CAT-MP-03-02', parent: 'CAT-MP-03', code: 'CAT-MP-03-02', name: 'Taq DNA聚合酶' },
    { id: 'CAT-MP-04-01', parent: 'CAT-MP-04', code: 'CAT-MP-04-01', name: 'NGS文库制备试剂盒' },
    { id: 'CAT-MP-04-02', parent: 'CAT-MP-04', code: 'CAT-MP-04-02', name: 'NGS靶向捕获Panel' },
    { id: 'CAT-MP-05-01', parent: 'CAT-MP-05', code: 'CAT-MP-05-01', name: 'HER2 FISH探针' },
    { id: 'CAT-MP-05-02', parent: 'CAT-MP-05', code: 'CAT-MP-05-02', name: 'ALK FISH探针' },
    { id: 'CAT-MP-06-01', parent: 'CAT-MP-06', code: 'CAT-MP-06-01', name: '测序试剂（SBS）' },

    // 细胞学
    { id: 'CAT-CYTO-01-01', parent: 'CAT-CYTO-01', code: 'CAT-CYTO-01-01', name: '95%乙醇细胞固定液' },
    { id: 'CAT-CYTO-01-02', parent: 'CAT-CYTO-01', code: 'CAT-CYTO-01-02', name: '甲醇细胞固定液' },
    { id: 'CAT-CYTO-02-01', parent: 'CAT-CYTO-02', code: 'CAT-CYTO-02-01', name: '巴氏染色液套装' },
    { id: 'CAT-CYTO-02-02', parent: 'CAT-CYTO-02', code: 'CAT-CYTO-02-02', name: 'Diff-Quik染色液' },
    { id: 'CAT-CYTO-03-01', parent: 'CAT-CYTO-03', code: 'CAT-CYTO-03-01', name: '液基细胞保存液' },

    // 玻片
    { id: 'CAT-GLASS-01-01', parent: 'CAT-GLASS-01', code: 'CAT-GLASS-01-01', name: '防脱载玻片（正电荷）' },
    { id: 'CAT-GLASS-01-02', parent: 'CAT-GLASS-01', code: 'CAT-GLASS-01-02', name: '普通载玻片' },
    { id: 'CAT-GLASS-02-01', parent: 'CAT-GLASS-02', code: 'CAT-GLASS-02-01', name: '盖玻片18x18mm' },
    { id: 'CAT-GLASS-02-02', parent: 'CAT-GLASS-02', code: 'CAT-GLASS-02-02', name: '盖玻片22x22mm' },
    { id: 'CAT-GLASS-03-01', parent: 'CAT-GLASS-03', code: 'CAT-GLASS-03-01', name: '不锈钢包埋盒' },
    { id: 'CAT-GLASS-03-02', parent: 'CAT-GLASS-03', code: 'CAT-GLASS-03-02', name: '塑料包埋盒（带盖）' },

    // 通用耗材
    { id: 'CAT-LAB-01-01', parent: 'CAT-LAB-01', code: 'CAT-LAB-01-01', name: '10ul移液器吸头（无菌）' },
    { id: 'CAT-LAB-01-02', parent: 'CAT-LAB-01', code: 'CAT-LAB-01-02', name: '200ul移液器吸头（无菌）' },
    { id: 'CAT-LAB-01-03', parent: 'CAT-LAB-01', code: 'CAT-LAB-01-03', name: '1000ul移液器吸头（无菌）' },
    { id: 'CAT-LAB-02-01', parent: 'CAT-LAB-02', code: 'CAT-LAB-02-01', name: '1.5ml离心管（无菌）' },
    { id: 'CAT-LAB-02-02', parent: 'CAT-LAB-02', code: 'CAT-LAB-02-02', name: '15ml离心管（无菌）' },
    { id: 'CAT-LAB-03-01', parent: 'CAT-LAB-03', code: 'CAT-LAB-03-01', name: '0.2ml PCR管（平盖）' },
    { id: 'CAT-LAB-03-02', parent: 'CAT-LAB-03', code: 'CAT-LAB-03-02', name: '96孔PCR板（半裙边）' },
  ]

  const insert = db.prepare(
    'INSERT INTO material_categories (id, code, name, parent_id, level, sort_order, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  for (const c of level1) {
    insert.run(c.id, c.code, c.name, null, 1, 0, 1, now, now)
  }
  for (const c of level2) {
    insert.run(c.id, c.code, c.name, c.parent, 2, 0, 1, now, now)
  }
  for (const c of level3) {
    insert.run(c.id, c.code, c.name, c.parent, 3, 0, 1, now, now)
  }

  log(`物料分类初始化完成: 一级 ${level1.length} 个, 二级 ${level2.length} 个, 三级 ${level3.length} 个`)
}

// ============================================
// 6. 创建物料主数据（含扩展IHC抗体）
// ============================================
function seedMaterials(db: any) {
  log('开始初始化物料主数据...')

  const check = db.prepare('SELECT COUNT(*) as count FROM materials WHERE is_deleted = 0')
  const existing = check.get() as any
  if (existing.count > 0) {
    log('物料主数据已存在，跳过物料初始化')
    return
  }

  const materials = [
    // === HE制片耗材 ===
    { id: 'MAT-HE-001', code: 'HE-001', name: '苏木素染液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-HE-01-01', supplier_id: 'SUP-003', price: 180, min_stock: 2, max_stock: 20, safety_stock: 3, location_id: 'LOC-A01' },
    { id: 'MAT-HE-002', code: 'HE-002', name: '伊红染液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-HE-01-02', supplier_id: 'SUP-003', price: 120, min_stock: 2, max_stock: 20, safety_stock: 3, location_id: 'LOC-A01' },
    { id: 'MAT-HE-003', code: 'HE-003', name: '盐酸乙醇分化液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-HE-01-03', supplier_id: 'SUP-003', price: 80, min_stock: 1, max_stock: 10, safety_stock: 2, location_id: 'LOC-A01' },
    { id: 'MAT-HE-004', code: 'HE-004', name: '氨水返蓝液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-HE-01-04', supplier_id: 'SUP-003', price: 60, min_stock: 1, max_stock: 10, safety_stock: 2, location_id: 'LOC-A01' },
    { id: 'MAT-HE-005', code: 'HE-005', name: '无水乙醇', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-HE-02', supplier_id: 'SUP-009', price: 25, min_stock: 5, max_stock: 50, safety_stock: 10, location_id: 'LOC-F01' },
    { id: 'MAT-HE-006', code: 'HE-006', name: '95%乙醇', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-HE-02', supplier_id: 'SUP-009', price: 20, min_stock: 5, max_stock: 50, safety_stock: 10, location_id: 'LOC-F01' },
    { id: 'MAT-HE-007', code: 'HE-007', name: '二甲苯', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-HE-02', supplier_id: 'SUP-009', price: 35, min_stock: 3, max_stock: 30, safety_stock: 5, location_id: 'LOC-F01' },
    { id: 'MAT-HE-008', code: 'HE-008', name: '石蜡（56-58°C）', spec: '5kg/袋', unit: '袋', category_id: 'CAT-HE-03', supplier_id: 'SUP-009', price: 150, min_stock: 2, max_stock: 10, safety_stock: 3, location_id: 'LOC-B01' },
    { id: 'MAT-HE-009', code: 'HE-009', name: '中性树胶', spec: '100ml/瓶', unit: '瓶', category_id: 'CAT-HE-04', supplier_id: 'SUP-003', price: 90, min_stock: 2, max_stock: 15, safety_stock: 3, location_id: 'LOC-A01' },

    // === IHC一抗-上皮标志物 ===
    { id: 'MAT-IHC-001', code: 'IHC-001', name: '广谱CK抗体(CKpan/AE1/AE3)', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-01', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-002', code: 'IHC-002', name: 'CK7抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-02', supplier_id: 'SUP-001', price: 1150, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-003', code: 'IHC-003', name: 'CK20抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-03', supplier_id: 'SUP-001', price: 1180, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-004', code: 'IHC-004', name: 'CK5/6抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-04', supplier_id: 'SUP-001', price: 1220, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-005', code: 'IHC-005', name: 'EMA抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-05', supplier_id: 'SUP-001', price: 1100, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-006', code: 'IHC-006', name: 'BerEP4抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-06', supplier_id: 'SUP-001', price: 1300, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-007', code: 'IHC-007', name: 'TTF-1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-07', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-008', code: 'IHC-008', name: 'Napsin A抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-08', supplier_id: 'SUP-001', price: 1400, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-009', code: 'IHC-009', name: 'GATA3抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-09', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-010', code: 'IHC-010', name: 'PAX8抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-01-10', supplier_id: 'SUP-001', price: 1380, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },

    // === IHC一抗-间叶标志物 ===
    { id: 'MAT-IHC-011', code: 'IHC-011', name: 'Vimentin抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-01', supplier_id: 'SUP-001', price: 1100, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-012', code: 'IHC-012', name: 'SMA抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-02', supplier_id: 'SUP-001', price: 1150, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-013', code: 'IHC-013', name: 'Desmin抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-03', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-014', code: 'IHC-014', name: 'S-100抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-04', supplier_id: 'SUP-001', price: 1180, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-015', code: 'IHC-015', name: 'CD34抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-05', supplier_id: 'SUP-001', price: 1220, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-016', code: 'IHC-016', name: 'CD31抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-06', supplier_id: 'SUP-001', price: 1280, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-017', code: 'IHC-017', name: 'ERG抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-07', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-018', code: 'IHC-018', name: 'CD117(c-Kit)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-08', supplier_id: 'SUP-001', price: 1400, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-019', code: 'IHC-019', name: 'DOG1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-02-09', supplier_id: 'SUP-001', price: 1500, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },

    // === IHC一抗-淋巴造血标志物 ===
    { id: 'MAT-IHC-020', code: 'IHC-020', name: 'CD3抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-01', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-021', code: 'IHC-021', name: 'CD20抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-02', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-022', code: 'IHC-022', name: 'CD45(LCA)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-03', supplier_id: 'SUP-001', price: 1180, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-023', code: 'IHC-023', name: 'CD30抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-04', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-024', code: 'IHC-024', name: 'CD15抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-05', supplier_id: 'SUP-001', price: 1220, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-025', code: 'IHC-025', name: 'CD10抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-06', supplier_id: 'SUP-001', price: 1280, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-026', code: 'IHC-026', name: 'BCL-2抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-07', supplier_id: 'SUP-001', price: 1300, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-027', code: 'IHC-027', name: 'BCL-6抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-08', supplier_id: 'SUP-001', price: 1320, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-028', code: 'IHC-028', name: 'MUM1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-09', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-029', code: 'IHC-029', name: 'CD21抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-10', supplier_id: 'SUP-001', price: 1280, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-030', code: 'IHC-030', name: 'CD23抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-11', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-031', code: 'IHC-031', name: 'Cyclin D1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-12', supplier_id: 'SUP-001', price: 1380, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-032', code: 'IHC-032', name: 'SOX11抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-13', supplier_id: 'SUP-001', price: 1450, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-033', code: 'IHC-033', name: 'MPO抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-14', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-034', code: 'IHC-034', name: 'CD68抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-15', supplier_id: 'SUP-001', price: 1180, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-035', code: 'IHC-035', name: 'CD163抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-16', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-036', code: 'IHC-036', name: 'CD138抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-17', supplier_id: 'SUP-001', price: 1300, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-037', code: 'IHC-037', name: 'Kappa轻链抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-18', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-038', code: 'IHC-038', name: 'Lambda轻链抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-03-19', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },

    // === IHC一抗-神经内分泌标志物 ===
    { id: 'MAT-IHC-039', code: 'IHC-039', name: 'Syn(突触素)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-01', supplier_id: 'SUP-001', price: 1300, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-040', code: 'IHC-040', name: 'CgA(嗜铬粒蛋白A)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-02', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-041', code: 'IHC-041', name: 'CD56抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-03', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-042', code: 'IHC-042', name: 'NSE抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-04', supplier_id: 'SUP-001', price: 1100, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-043', code: 'IHC-043', name: 'INSM1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-05', supplier_id: 'SUP-001', price: 1450, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-044', code: 'IHC-044', name: 'NeuN抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-06', supplier_id: 'SUP-001', price: 1400, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-045', code: 'IHC-045', name: 'GFAP抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-07', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-046', code: 'IHC-046', name: 'Olig2抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-08', supplier_id: 'SUP-001', price: 1500, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-047', code: 'IHC-047', name: 'IDH1(R132H)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-09', supplier_id: 'SUP-001', price: 1600, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-048', code: 'IHC-048', name: 'ATRX抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-04-10', supplier_id: 'SUP-001', price: 1400, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },

    // === IHC一抗-增殖与凋亡标志物 ===
    { id: 'MAT-IHC-049', code: 'IHC-049', name: 'Ki-67抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-05-01', supplier_id: 'SUP-001', price: 1100, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C05' },
    { id: 'MAT-IHC-050', code: 'IHC-050', name: 'P53抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-05-02', supplier_id: 'SUP-001', price: 1150, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C05' },
    { id: 'MAT-IHC-051', code: 'IHC-051', name: 'P16抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-05-03', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C05' },
    { id: 'MAT-IHC-052', code: 'IHC-052', name: 'P21抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-05-04', supplier_id: 'SUP-001', price: 1180, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C05' },
    { id: 'MAT-IHC-053', code: 'IHC-053', name: 'P27抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-05-05', supplier_id: 'SUP-001', price: 1180, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C05' },
    { id: 'MAT-IHC-054', code: 'IHC-054', name: 'Caspase-3抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-05-07', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C05' },

    // === IHC一抗-受体与信号通路 ===
    { id: 'MAT-IHC-055', code: 'IHC-055', name: 'HER2(ERBB2)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-01', supplier_id: 'SUP-001', price: 1500, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-056', code: 'IHC-056', name: 'ER(雌激素受体)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-02', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-057', code: 'IHC-057', name: 'PR(孕激素受体)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-03', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-058', code: 'IHC-058', name: 'AR(雄激素受体)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-04', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-059', code: 'IHC-059', name: 'PD-L1(22C3)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-05', supplier_id: 'SUP-002', price: 2800, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-060', code: 'IHC-060', name: 'PD-L1(28-8)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-06', supplier_id: 'SUP-001', price: 2600, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-061', code: 'IHC-061', name: 'PD-L1(SP263)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-07', supplier_id: 'SUP-001', price: 2700, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-062', code: 'IHC-062', name: 'EGFR抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-08', supplier_id: 'SUP-001', price: 1300, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-063', code: 'IHC-063', name: 'ALK(D5F3)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-09', supplier_id: 'SUP-002', price: 2200, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-064', code: 'IHC-064', name: 'ROS1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-10', supplier_id: 'SUP-001', price: 2000, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-065', code: 'IHC-065', name: 'RET抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-11', supplier_id: 'SUP-001', price: 2100, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-066', code: 'IHC-066', name: 'MET抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-12', supplier_id: 'SUP-001', price: 1900, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-067', code: 'IHC-067', name: 'KRAS抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-13', supplier_id: 'SUP-001', price: 1400, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-068', code: 'IHC-068', name: 'BRAF(V600E)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-14', supplier_id: 'SUP-001', price: 1600, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-069', code: 'IHC-069', name: 'MSH2抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-15', supplier_id: 'SUP-001', price: 1450, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-070', code: 'IHC-070', name: 'MSH6抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-16', supplier_id: 'SUP-001', price: 1450, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-071', code: 'IHC-071', name: 'MLH1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-17', supplier_id: 'SUP-001', price: 1450, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },
    { id: 'MAT-IHC-072', code: 'IHC-072', name: 'PMS2抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-06-18', supplier_id: 'SUP-001', price: 1450, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C01' },

    // === IHC一抗-病毒与感染标志物 ===
    { id: 'MAT-IHC-073', code: 'IHC-073', name: 'HPV(L1壳蛋白)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-07-01', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-074', code: 'IHC-074', name: 'EBV(LMP-1)抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-07-02', supplier_id: 'SUP-001', price: 1300, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-075', code: 'IHC-075', name: 'CMV抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-07-03', supplier_id: 'SUP-001', price: 1100, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-076', code: 'IHC-076', name: 'HSV抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-07-04', supplier_id: 'SUP-001', price: 1100, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-077', code: 'IHC-077', name: 'HHV-8抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-07-05', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-078', code: 'IHC-078', name: 'HBsAg抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-07-06', supplier_id: 'SUP-001', price: 1000, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },

    // === IHC一抗-组织特异性标志物 ===
    { id: 'MAT-IHC-079', code: 'IHC-079', name: 'PSA抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-01', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-080', code: 'IHC-080', name: 'PSAP抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-02', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-081', code: 'IHC-081', name: 'NKX3.1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-03', supplier_id: 'SUP-001', price: 1400, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-082', code: 'IHC-082', name: 'WT1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-04', supplier_id: 'SUP-001', price: 1300, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-083', code: 'IHC-083', name: 'Calretinin抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-05', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-084', code: 'IHC-084', name: 'Inhibin抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-06', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-085', code: 'IHC-085', name: 'HepPar-1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-07', supplier_id: 'SUP-001', price: 1280, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-086', code: 'IHC-086', name: 'Arginase-1抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-08', supplier_id: 'SUP-001', price: 1400, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-087', code: 'IHC-087', name: 'RCC抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-13', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-088', code: 'IHC-088', name: 'CDX2抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-14', supplier_id: 'SUP-001', price: 1250, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-089', code: 'IHC-089', name: 'SATB2抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-15', supplier_id: 'SUP-001', price: 1350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-090', code: 'IHC-090', name: 'Villin抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-16', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-091', code: 'IHC-091', name: 'Brachyury抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-20', supplier_id: 'SUP-001', price: 1600, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-092', code: 'IHC-092', name: 'SALL4抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-21', supplier_id: 'SUP-001', price: 1500, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-093', code: 'IHC-093', name: 'OCT3/4抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-22', supplier_id: 'SUP-001', price: 1450, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-094', code: 'IHC-094', name: 'PLAP抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-23', supplier_id: 'SUP-001', price: 1300, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-095', code: 'IHC-095', name: 'AFP抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-24', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-096', code: 'IHC-096', name: 'HCG抗体', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-08-25', supplier_id: 'SUP-001', price: 1100, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },

    // === IHC检测系统 ===
    { id: 'MAT-IHC-097', code: 'IHC-097', name: 'EnVision二抗试剂盒', spec: '15ml/盒', unit: '盒', category_id: 'CAT-IHC-09-01', supplier_id: 'SUP-001', price: 3200, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-098', code: 'IHC-098', name: 'Polymer二抗试剂盒', spec: '15ml/盒', unit: '盒', category_id: 'CAT-IHC-09-02', supplier_id: 'SUP-001', price: 2800, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-099', code: 'IHC-099', name: 'LSAB检测系统', spec: '100测试/盒', unit: '盒', category_id: 'CAT-IHC-09-03', supplier_id: 'SUP-001', price: 4500, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-100', code: 'IHC-100', name: '兔/鼠通用二抗', spec: '10ml/瓶', unit: '瓶', category_id: 'CAT-IHC-09-05', supplier_id: 'SUP-001', price: 1800, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },

    // === IHC显色试剂 ===
    { id: 'MAT-IHC-101', code: 'IHC-101', name: 'DAB显色试剂盒', spec: '6ml/盒', unit: '盒', category_id: 'CAT-IHC-10-01', supplier_id: 'SUP-001', price: 1800, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-102', code: 'IHC-102', name: 'AEC显色试剂盒', spec: '6ml/盒', unit: '盒', category_id: 'CAT-IHC-10-02', supplier_id: 'SUP-001', price: 1900, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-103', code: 'IHC-103', name: 'DAB+底物缓冲液', spec: '50ml/瓶', unit: '瓶', category_id: 'CAT-IHC-10-03', supplier_id: 'SUP-001', price: 650, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-104', code: 'IHC-104', name: 'Vector Red显色试剂', spec: '5ml/瓶', unit: '瓶', category_id: 'CAT-IHC-10-04', supplier_id: 'SUP-001', price: 1200, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C02' },
    { id: 'MAT-IHC-105', code: 'IHC-105', name: '荧光标记二抗（Cy3）', spec: '1ml/管', unit: '管', category_id: 'CAT-IHC-10-06', supplier_id: 'SUP-004', price: 2200, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C02' },

    // === IHC抗原修复试剂 ===
    { id: 'MAT-IHC-106', code: 'IHC-106', name: 'EDTA抗原修复液（pH9.0）', spec: '1L/瓶', unit: '瓶', category_id: 'CAT-IHC-11-01', supplier_id: 'SUP-001', price: 450, min_stock: 1, max_stock: 8, safety_stock: 2, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-107', code: 'IHC-107', name: '柠檬酸抗原修复液（pH6.0）', spec: '1L/瓶', unit: '瓶', category_id: 'CAT-IHC-11-02', supplier_id: 'SUP-001', price: 420, min_stock: 1, max_stock: 8, safety_stock: 2, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-108', code: 'IHC-108', name: 'Tris-EDTA修复液（pH9.0）', spec: '1L/瓶', unit: '瓶', category_id: 'CAT-IHC-11-03', supplier_id: 'SUP-001', price: 480, min_stock: 1, max_stock: 8, safety_stock: 2, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-109', code: 'IHC-109', name: '胰蛋白酶消化修复液', spec: '100ml/瓶', unit: '瓶', category_id: 'CAT-IHC-11-04', supplier_id: 'SUP-001', price: 350, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-110', code: 'IHC-110', name: '胃蛋白酶修复液', spec: '100ml/瓶', unit: '瓶', category_id: 'CAT-IHC-11-05', supplier_id: 'SUP-001', price: 380, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },

    // === IHC封闭与洗涤试剂 ===
    { id: 'MAT-IHC-111', code: 'IHC-111', name: '正常山羊血清封闭液', spec: '10ml/瓶', unit: '瓶', category_id: 'CAT-IHC-12-01', supplier_id: 'SUP-001', price: 280, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-112', code: 'IHC-112', name: 'BSA封闭液（10%）', spec: '50ml/瓶', unit: '瓶', category_id: 'CAT-IHC-12-02', supplier_id: 'SUP-004', price: 180, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-113', code: 'IHC-113', name: 'PBS洗涤缓冲液（10X）', spec: '1L/瓶', unit: '瓶', category_id: 'CAT-IHC-12-03', supplier_id: 'SUP-009', price: 120, min_stock: 2, max_stock: 10, safety_stock: 2, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-114', code: 'IHC-114', name: 'TBST洗涤缓冲液（10X）', spec: '1L/瓶', unit: '瓶', category_id: 'CAT-IHC-12-04', supplier_id: 'SUP-009', price: 150, min_stock: 2, max_stock: 10, safety_stock: 2, location_id: 'LOC-C03' },
    { id: 'MAT-IHC-115', code: 'IHC-115', name: 'Tween-20', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-IHC-12-05', supplier_id: 'SUP-009', price: 85, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C03' },

    // === IHC对照试剂 ===
    { id: 'MAT-IHC-116', code: 'IHC-116', name: '多组织阳性对照蜡块', spec: '1块', unit: '块', category_id: 'CAT-IHC-13-04', supplier_id: 'SUP-001', price: 2500, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-117', code: 'IHC-117', name: 'IHC质控品套装（Level1/2/3）', spec: '1套/盒', unit: '盒', category_id: 'CAT-IHC-13-05', supplier_id: 'SUP-001', price: 5800, min_stock: 1, max_stock: 2, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-118', code: 'IHC-118', name: '同型对照抗体（小鼠IgG1）', spec: '3ml/瓶', unit: '瓶', category_id: 'CAT-IHC-13-03', supplier_id: 'SUP-001', price: 800, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },

    // === IHC辅助试剂 ===
    { id: 'MAT-IHC-119', code: 'IHC-119', name: '苏木素复染液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-IHC-14-01', supplier_id: 'SUP-003', price: 180, min_stock: 2, max_stock: 10, safety_stock: 2, location_id: 'LOC-A01' },
    { id: 'MAT-IHC-120', code: 'IHC-120', name: '过氧化物酶阻断剂', spec: '10ml/瓶', unit: '瓶', category_id: 'CAT-IHC-14-04', supplier_id: 'SUP-001', price: 320, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-121', code: 'IHC-121', name: '内源性生物素阻断剂', spec: '10ml/瓶', unit: '瓶', category_id: 'CAT-IHC-14-05', supplier_id: 'SUP-001', price: 380, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-122', code: 'IHC-122', name: '抗体稀释液', spec: '100ml/瓶', unit: '瓶', category_id: 'CAT-IHC-14-06', supplier_id: 'SUP-001', price: 280, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-C04' },
    { id: 'MAT-IHC-123', code: 'IHC-123', name: '防脱载玻片（IHC专用正电荷）', spec: '50片/盒', unit: '盒', category_id: 'CAT-IHC-14-03', supplier_id: 'SUP-003', price: 220, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B01' },

    // === 分子诊断试剂 ===
    { id: 'MAT-MP-001', code: 'MP-001', name: 'FFPE DNA提取试剂盒', spec: '50次/盒', unit: '盒', category_id: 'CAT-MP-01-01', supplier_id: 'SUP-004', price: 1800, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-D01' },
    { id: 'MAT-MP-002', code: 'MP-002', name: '血液DNA提取试剂盒', spec: '50次/盒', unit: '盒', category_id: 'CAT-MP-01-02', supplier_id: 'SUP-004', price: 1600, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-D01' },
    { id: 'MAT-MP-003', code: 'MP-003', name: 'RNA提取试剂盒（TRIzol法）', spec: '50次/盒', unit: '盒', category_id: 'CAT-MP-02-01', supplier_id: 'SUP-004', price: 2200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-D01' },
    { id: 'MAT-MP-004', code: 'MP-004', name: 'PCR Master Mix（2X）', spec: '1ml/管', unit: '管', category_id: 'CAT-MP-03-01', supplier_id: 'SUP-005', price: 850, min_stock: 2, max_stock: 10, safety_stock: 2, location_id: 'LOC-D02' },
    { id: 'MAT-MP-005', code: 'MP-005', name: 'Taq DNA聚合酶', spec: '500U/管', unit: '管', category_id: 'CAT-MP-03-02', supplier_id: 'SUP-005', price: 650, min_stock: 1, max_stock: 8, safety_stock: 2, location_id: 'LOC-D02' },
    { id: 'MAT-MP-006', code: 'MP-006', name: 'NGS文库制备试剂盒', spec: '24次/盒', unit: '盒', category_id: 'CAT-MP-04-01', supplier_id: 'SUP-006', price: 12800, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-D02' },
    { id: 'MAT-MP-007', code: 'MP-007', name: '肿瘤靶向Panel（425基因）', spec: '16次/盒', unit: '盒', category_id: 'CAT-MP-04-02', supplier_id: 'SUP-006', price: 25600, min_stock: 1, max_stock: 2, safety_stock: 1, location_id: 'LOC-D03' },
    { id: 'MAT-MP-008', code: 'MP-008', name: 'HER2 FISH探针试剂盒', spec: '20测试/盒', unit: '盒', category_id: 'CAT-MP-05-01', supplier_id: 'SUP-007', price: 6800, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-D03' },
    { id: 'MAT-MP-009', code: 'MP-009', name: 'ALK FISH探针试剂盒', spec: '20测试/盒', unit: '盒', category_id: 'CAT-MP-05-02', supplier_id: 'SUP-007', price: 7200, min_stock: 1, max_stock: 3, safety_stock: 1, location_id: 'LOC-D03' },
    { id: 'MAT-MP-010', code: 'MP-010', name: '测序试剂（SBS）', spec: '300cycles/盒', unit: '盒', category_id: 'CAT-MP-06-01', supplier_id: 'SUP-006', price: 35000, min_stock: 1, max_stock: 2, safety_stock: 1, location_id: 'LOC-D03' },

    // === 细胞学试剂 ===
    { id: 'MAT-CYTO-001', code: 'CYTO-001', name: '95%乙醇细胞固定液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-CYTO-01-01', supplier_id: 'SUP-009', price: 30, min_stock: 3, max_stock: 30, safety_stock: 5, location_id: 'LOC-E01' },
    { id: 'MAT-CYTO-002', code: 'CYTO-002', name: '甲醇细胞固定液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-CYTO-01-02', supplier_id: 'SUP-009', price: 35, min_stock: 2, max_stock: 20, safety_stock: 3, location_id: 'LOC-E01' },
    { id: 'MAT-CYTO-003', code: 'CYTO-003', name: '巴氏染色液套装', spec: 'EA65+OG6+苏木素', unit: '套', category_id: 'CAT-CYTO-02-01', supplier_id: 'SUP-003', price: 680, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-E02' },
    { id: 'MAT-CYTO-004', code: 'CYTO-004', name: 'Diff-Quik染色液', spec: 'A+B+C液各250ml', unit: '套', category_id: 'CAT-CYTO-02-02', supplier_id: 'SUP-003', price: 520, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-E02' },
    { id: 'MAT-CYTO-005', code: 'CYTO-005', name: '液基细胞保存液', spec: '20ml/瓶，100瓶/箱', unit: '箱', category_id: 'CAT-CYTO-03-01', supplier_id: 'SUP-008', price: 1200, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-E02' },

    // === 玻片与载具 ===
    { id: 'MAT-GLASS-001', code: 'GLASS-001', name: '防脱载玻片（正电荷）', spec: '50片/盒', unit: '盒', category_id: 'CAT-GLASS-01-01', supplier_id: 'SUP-003', price: 180, min_stock: 3, max_stock: 30, safety_stock: 5, location_id: 'LOC-B01' },
    { id: 'MAT-GLASS-002', code: 'GLASS-002', name: '普通载玻片', spec: '50片/盒', unit: '盒', category_id: 'CAT-GLASS-01-02', supplier_id: 'SUP-003', price: 60, min_stock: 5, max_stock: 50, safety_stock: 10, location_id: 'LOC-B01' },
    { id: 'MAT-GLASS-003', code: 'GLASS-003', name: '盖玻片18x18mm', spec: '100片/盒', unit: '盒', category_id: 'CAT-GLASS-02-01', supplier_id: 'SUP-003', price: 45, min_stock: 5, max_stock: 40, safety_stock: 8, location_id: 'LOC-B01' },
    { id: 'MAT-GLASS-004', code: 'GLASS-004', name: '盖玻片22x22mm', spec: '100片/盒', unit: '盒', category_id: 'CAT-GLASS-02-02', supplier_id: 'SUP-003', price: 50, min_stock: 5, max_stock: 40, safety_stock: 8, location_id: 'LOC-B01' },
    { id: 'MAT-GLASS-005', code: 'GLASS-005', name: '不锈钢包埋盒', spec: '500个/包', unit: '包', category_id: 'CAT-GLASS-03-01', supplier_id: 'SUP-003', price: 280, min_stock: 2, max_stock: 15, safety_stock: 3, location_id: 'LOC-B02' },
    { id: 'MAT-GLASS-006', code: 'GLASS-006', name: '塑料包埋盒（带盖）', spec: '500个/包', unit: '包', category_id: 'CAT-GLASS-03-02', supplier_id: 'SUP-003', price: 150, min_stock: 2, max_stock: 15, safety_stock: 3, location_id: 'LOC-B02' },
    { id: 'MAT-GLASS-007', code: 'GLASS-007', name: '载玻片架（20片装）', spec: '10个/包', unit: '包', category_id: 'CAT-GLASS-04', supplier_id: 'SUP-003', price: 120, min_stock: 2, max_stock: 10, safety_stock: 2, location_id: 'LOC-B02' },

    // === 固定液与保存液 ===
    { id: 'MAT-FIX-001', code: 'FIX-001', name: '10%中性缓冲甲醛固定液', spec: '5L/桶', unit: '桶', category_id: 'CAT-FIX-01', supplier_id: 'SUP-009', price: 85, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-F01' },
    { id: 'MAT-FIX-002', code: 'FIX-002', name: '4%多聚甲醛固定液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-FIX-02', supplier_id: 'SUP-004', price: 280, min_stock: 2, max_stock: 10, safety_stock: 2, location_id: 'LOC-F01' },
    { id: 'MAT-FIX-003', code: 'FIX-003', name: '组织保存液（RNA later）', spec: '250ml/瓶', unit: '瓶', category_id: 'CAT-FIX-03', supplier_id: 'SUP-004', price: 650, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-A02' },
    { id: 'MAT-FIX-004', code: 'FIX-004', name: '快速脱钙液', spec: '500ml/瓶', unit: '瓶', category_id: 'CAT-FIX-04', supplier_id: 'SUP-009', price: 180, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-F02' },

    // === 设备耗材 ===
    { id: 'MAT-DEV-001', code: 'DEV-001', name: '一次性切片刀片（宽型）', spec: '50片/盒', unit: '盒', category_id: 'CAT-DEVICE-01', supplier_id: 'SUP-003', price: 350, min_stock: 2, max_stock: 15, safety_stock: 3, location_id: 'LOC-G01' },
    { id: 'MAT-DEV-002', code: 'DEV-002', name: '一次性切片刀片（窄型）', spec: '50片/盒', unit: '盒', category_id: 'CAT-DEVICE-01', supplier_id: 'SUP-003', price: 320, min_stock: 2, max_stock: 15, safety_stock: 3, location_id: 'LOC-G01' },
    { id: 'MAT-DEV-003', code: 'DEV-003', name: '染色机专用染色架', spec: '30片/架', unit: '架', category_id: 'CAT-DEVICE-02', supplier_id: 'SUP-001', price: 2800, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-G01' },
    { id: 'MAT-DEV-004', code: 'DEV-004', name: '封片机专用盖玻片夹', spec: '10个/包', unit: '包', category_id: 'CAT-DEVICE-03', supplier_id: 'SUP-003', price: 650, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-G02' },
    { id: 'MAT-DEV-005', code: 'DEV-005', name: '条码打印机色带', spec: '50mm x 300m', unit: '卷', category_id: 'CAT-DEVICE-04', supplier_id: 'SUP-010', price: 120, min_stock: 2, max_stock: 10, safety_stock: 2, location_id: 'LOC-G02' },
    { id: 'MAT-DEV-006', code: 'DEV-006', name: '标签纸（25x50mm）', spec: '1000张/卷', unit: '卷', category_id: 'CAT-DEVICE-04', supplier_id: 'SUP-010', price: 45, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-G02' },

    // === 通用实验室耗材 ===
    { id: 'MAT-LAB-001', code: 'LAB-001', name: '10ul移液器吸头（无菌）', spec: '1000支/包', unit: '包', category_id: 'CAT-LAB-01-01', supplier_id: 'SUP-004', price: 180, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B03' },
    { id: 'MAT-LAB-002', code: 'LAB-002', name: '200ul移液器吸头（无菌）', spec: '1000支/包', unit: '包', category_id: 'CAT-LAB-01-02', supplier_id: 'SUP-004', price: 150, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B03' },
    { id: 'MAT-LAB-003', code: 'LAB-003', name: '1000ul移液器吸头（无菌）', spec: '500支/包', unit: '包', category_id: 'CAT-LAB-01-03', supplier_id: 'SUP-004', price: 120, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B03' },
    { id: 'MAT-LAB-004', code: 'LAB-004', name: '1.5ml离心管（无菌）', spec: '500支/包', unit: '包', category_id: 'CAT-LAB-02-01', supplier_id: 'SUP-004', price: 85, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B03' },
    { id: 'MAT-LAB-005', code: 'LAB-005', name: '15ml离心管（无菌）', spec: '50支/包', unit: '包', category_id: 'CAT-LAB-02-02', supplier_id: 'SUP-004', price: 65, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B03' },
    { id: 'MAT-LAB-006', code: 'LAB-006', name: '0.2ml PCR管（平盖）', spec: '1000支/包', unit: '包', category_id: 'CAT-LAB-03-01', supplier_id: 'SUP-004', price: 220, min_stock: 2, max_stock: 15, safety_stock: 3, location_id: 'LOC-B04' },
    { id: 'MAT-LAB-007', code: 'LAB-007', name: '96孔PCR板（半裙边）', spec: '10块/包', unit: '包', category_id: 'CAT-LAB-03-02', supplier_id: 'SUP-004', price: 350, min_stock: 1, max_stock: 10, safety_stock: 2, location_id: 'LOC-B04' },
    { id: 'MAT-LAB-008', code: 'LAB-008', name: '称量纸（100x100mm）', spec: '500张/包', unit: '包', category_id: 'CAT-LAB-04', supplier_id: 'SUP-010', price: 25, min_stock: 5, max_stock: 30, safety_stock: 8, location_id: 'LOC-B04' },
    { id: 'MAT-LAB-009', code: 'LAB-009', name: '定性滤纸（中速）', spec: '100张/盒', unit: '盒', category_id: 'CAT-LAB-04', supplier_id: 'SUP-010', price: 35, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B04' },
    { id: 'MAT-LAB-010', code: 'LAB-010', name: '丁腈手套（小号，无粉）', spec: '100只/盒', unit: '盒', category_id: 'CAT-LAB-05', supplier_id: 'SUP-010', price: 65, min_stock: 5, max_stock: 30, safety_stock: 10, location_id: 'LOC-B02' },
    { id: 'MAT-LAB-011', code: 'LAB-011', name: '丁腈手套（中号，无粉）', spec: '100只/盒', unit: '盒', category_id: 'CAT-LAB-05', supplier_id: 'SUP-010', price: 65, min_stock: 5, max_stock: 30, safety_stock: 10, location_id: 'LOC-B02' },
    { id: 'MAT-LAB-012', code: 'LAB-012', name: '丁腈手套（大号，无粉）', spec: '100只/盒', unit: '盒', category_id: 'CAT-LAB-05', supplier_id: 'SUP-010', price: 65, min_stock: 5, max_stock: 30, safety_stock: 10, location_id: 'LOC-B02' },

    // === 防护用品 ===
    { id: 'MAT-SAFE-001', code: 'SAFE-001', name: '医用外科口罩', spec: '50只/盒', unit: '盒', category_id: 'CAT-SAFE-01', supplier_id: 'SUP-009', price: 35, min_stock: 10, max_stock: 100, safety_stock: 20, location_id: 'LOC-B02' },
    { id: 'MAT-SAFE-002', code: 'SAFE-002', name: 'N95防护口罩', spec: '20只/盒', unit: '盒', category_id: 'CAT-SAFE-01', supplier_id: 'SUP-009', price: 85, min_stock: 5, max_stock: 50, safety_stock: 10, location_id: 'LOC-B02' },
    { id: 'MAT-SAFE-003', code: 'SAFE-003', name: '防护面罩（防溅）', spec: '10个/包', unit: '包', category_id: 'CAT-SAFE-02', supplier_id: 'SUP-009', price: 45, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B02' },
    { id: 'MAT-SAFE-004', code: 'SAFE-004', name: '一次性防护服', spec: '10件/包', unit: '包', category_id: 'CAT-SAFE-03', supplier_id: 'SUP-009', price: 120, min_stock: 3, max_stock: 20, safety_stock: 5, location_id: 'LOC-B02' },
    { id: 'MAT-SAFE-005', code: 'SAFE-005', name: '急救包（实验室用）', spec: '1套/盒', unit: '盒', category_id: 'CAT-SAFE-04', supplier_id: 'SUP-009', price: 280, min_stock: 1, max_stock: 5, safety_stock: 1, location_id: 'LOC-B02' },
  ]

  for (const m of materials) {
    const sql = `INSERT INTO materials (id, code, name, spec, unit, category_id, supplier_id, price, min_stock, max_stock, safety_stock, location_id, status, created_at, updated_at)
      VALUES ('${m.id}', '${m.code}', '${m.name.replace(/'/g, "''")}', '${(m.spec || '').replace(/'/g, "''")}', '${m.unit}', '${m.category_id}', '${(m.supplier_id || '').replace(/'/g, "''")}', ${m.price}, ${m.min_stock}, ${m.max_stock}, ${m.safety_stock}, '${(m.location_id || '').replace(/'/g, "''")}', 1, '${now}', '${now}')`
    db.exec(sql)
  }
  log(`物料主数据初始化完成: ${materials.length} 个`)
}

// ============================================
// 7. 创建检测项目
// ============================================
function seedProjects(db: any) {
  log('开始初始化检测项目...')

  const check = db.prepare('SELECT COUNT(*) as count FROM projects WHERE is_deleted = 0')
  const existing = check.get() as any
  if (existing.count > 0) {
    log('检测项目已存在，跳过项目初始化')
    return
  }

  const projects = [
    { id: 'PRJ-HE-001', code: 'HE-001', name: '常规HE染色', type: 'he', cycle: '1天', manager: '刘医师', description: '常规苏木素-伊红染色，用于组织切片常规诊断' },
    { id: 'PRJ-IHC-001', code: 'IHC-001', name: '免疫组化检测（广谱CK）', type: 'ihc', cycle: '2天', manager: '刘医师', description: '广谱细胞角蛋白免疫组化染色，用于上皮源性肿瘤诊断' },
    { id: 'PRJ-IHC-002', code: 'IHC-002', name: '免疫组化检测（CD20）', type: 'ihc', cycle: '2天', manager: '刘医师', description: 'CD20免疫组化染色，用于B细胞淋巴瘤诊断' },
    { id: 'PRJ-IHC-003', code: 'IHC-003', name: '免疫组化检测（Ki-67）', type: 'ihc', cycle: '2天', manager: '刘医师', description: 'Ki-67增殖指数检测，用于肿瘤增殖活性评估' },
    { id: 'PRJ-IHC-004', code: 'IHC-004', name: '免疫组化检测（HER2）', type: 'ihc', cycle: '2天', manager: '陈医师', description: 'HER2蛋白表达检测，用于乳腺癌靶向治疗评估' },
    { id: 'PRJ-IHC-005', code: 'IHC-005', name: '免疫组化检测（PD-L1）', type: 'ihc', cycle: '2天', manager: '陈医师', description: 'PD-L1表达检测，用于免疫治疗疗效预测' },
    { id: 'PRJ-MP-001', code: 'MP-001', name: '肿瘤425基因NGS检测', type: 'mp', cycle: '7天', manager: '陈医师', description: '基于二代测序技术的425基因靶向Panel检测' },
    { id: 'PRJ-MP-002', code: 'MP-002', name: 'HER2 FISH检测', type: 'mp', cycle: '3天', manager: '陈医师', description: 'HER2基因扩增FISH检测，用于乳腺癌/胃癌靶向治疗评估' },
    { id: 'PRJ-MP-003', code: 'MP-003', name: 'ALK FISH检测', type: 'mp', cycle: '3天', manager: '陈医师', description: 'ALK基因重排FISH检测，用于非小细胞肺癌靶向治疗评估' },
    { id: 'PRJ-SS-001', code: 'SS-001', name: 'PAS特殊染色', type: 'ss', cycle: '1天', manager: '刘医师', description: '过碘酸-Schiff染色，用于糖原/黏液检测' },
    { id: 'PRJ-CYTO-001', code: 'CYTO-001', name: '液基薄层细胞学检测（TCT）', type: 'cyto', cycle: '2天', manager: '刘医师', description: '宫颈液基薄层细胞学检测，用于宫颈癌筛查' },
    { id: 'PRJ-CYTO-002', code: 'CYTO-002', name: '细针穿刺细胞学检测', type: 'cyto', cycle: '1天', manager: '刘医师', description: '细针穿刺标本细胞学诊断' },
  ]

  const insert = db.prepare(
    'INSERT INTO projects (id, code, name, type, cycle, manager, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const p of projects) {
    insert.run(p.id, p.code, p.name, p.type, p.cycle, p.manager, p.description, 1, now, now)
  }
  log(`检测项目初始化完成: ${projects.length} 个`)
}

// ============================================
// 8. 创建BOM
// ============================================
function seedBOMs(db: any) {
  log('开始初始化BOM清单...')

  const check = db.prepare('SELECT COUNT(*) as count FROM boms WHERE is_deleted = 0')
  const existing = check.get() as any
  if (existing.count > 0) {
    log('BOM数据已存在，跳过BOM初始化')
    return
  }

  const boms = [
    // HE制片
    { id: 'BOM-HE-001', code: 'BOM-HE-001', name: '常规HE染色BOM', version: 'v1.0', type: 'he', supportable_samples: 100, unit_cost: 0 },
    { id: 'BOM-HE-002', code: 'BOM-HE-002', name: '冰冻切片HE染色BOM', version: 'v1.0', type: 'he', supportable_samples: 50, unit_cost: 0 },

    // 免疫组化 - 按检测项目细分
    { id: 'BOM-IHC-001', code: 'BOM-IHC-001', name: 'IHC基础通用耗材BOM', version: 'v1.0', type: 'ihc', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-IHC-CK', code: 'BOM-IHC-CK', name: 'IHC-广谱CK检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CK7', code: 'BOM-IHC-CK7', name: 'IHC-CK7检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CK20', code: 'BOM-IHC-CK20', name: 'IHC-CK20检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-TTF1', code: 'BOM-IHC-TTF1', name: 'IHC-TTF-1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-GATA3', code: 'BOM-IHC-GATA3', name: 'IHC-GATA3检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-PAX8', code: 'BOM-IHC-PAX8', name: 'IHC-PAX8检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD20', code: 'BOM-IHC-CD20', name: 'IHC-CD20检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD3', code: 'BOM-IHC-CD3', name: 'IHC-CD3检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD30', code: 'BOM-IHC-CD30', name: 'IHC-CD30检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Ki67', code: 'BOM-IHC-Ki67', name: 'IHC-Ki-67检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-P53', code: 'BOM-IHC-P53', name: 'IHC-P53检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-P16', code: 'BOM-IHC-P16', name: 'IHC-P16检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-HER2', code: 'BOM-IHC-HER2', name: 'IHC-HER2检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-ER', code: 'BOM-IHC-ER', name: 'IHC-ER检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-PR', code: 'BOM-IHC-PR', name: 'IHC-PR检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-PDL1', code: 'BOM-IHC-PDL1', name: 'IHC-PD-L1(22C3)检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 20, unit_cost: 0 },
    { id: 'BOM-IHC-ALK', code: 'BOM-IHC-ALK', name: 'IHC-ALK(D5F3)检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-EGFR', code: 'BOM-IHC-EGFR', name: 'IHC-EGFR检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Syn', code: 'BOM-IHC-Syn', name: 'IHC-Syn检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CgA', code: 'BOM-IHC-CgA', name: 'IHC-CgA检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-S100', code: 'BOM-IHC-S100', name: 'IHC-S-100检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Vim', code: 'BOM-IHC-Vim', name: 'IHC-Vimentin检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-PSA', code: 'BOM-IHC-PSA', name: 'IHC-PSA检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-WT1', code: 'BOM-IHC-WT1', name: 'IHC-WT1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CDX2', code: 'BOM-IHC-CDX2', name: 'IHC-CDX2检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-SATB2', code: 'BOM-IHC-SATB2', name: 'IHC-SATB2检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MLH1', code: 'BOM-IHC-MLH1', name: 'IHC-MLH1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MSH2', code: 'BOM-IHC-MSH2', name: 'IHC-MSH2检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MSH6', code: 'BOM-IHC-MSH6', name: 'IHC-MSH6检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-PMS2', code: 'BOM-IHC-PMS2', name: 'IHC-PMS2检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-KRAS', code: 'BOM-IHC-KRAS', name: 'IHC-KRAS检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-BRAF', code: 'BOM-IHC-BRAF', name: 'IHC-BRAF(V600E)检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-IDH1', code: 'BOM-IHC-IDH1', name: 'IHC-IDH1(R132H)检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-ATRX', code: 'BOM-IHC-ATRX', name: 'IHC-ATRX检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-GFAP', code: 'BOM-IHC-GFAP', name: 'IHC-GFAP检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-SOX11', code: 'BOM-IHC-SOX11', name: 'IHC-SOX11检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CyclinD1', code: 'BOM-IHC-CyclinD1', name: 'IHC-Cyclin D1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-BCL2', code: 'BOM-IHC-BCL2', name: 'IHC-BCL-2检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-BCL6', code: 'BOM-IHC-BCL6', name: 'IHC-BCL-6检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MUM1', code: 'BOM-IHC-MUM1', name: 'IHC-MUM1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD21', code: 'BOM-IHC-CD21', name: 'IHC-CD21检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD68', code: 'BOM-IHC-CD68', name: 'IHC-CD68检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD163', code: 'BOM-IHC-CD163', name: 'IHC-CD163检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD138', code: 'BOM-IHC-CD138', name: 'IHC-CD138检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Kappa', code: 'BOM-IHC-Kappa', name: 'IHC-Kappa轻链检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Lambda', code: 'BOM-IHC-Lambda', name: 'IHC-Lambda轻链检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-DES', code: 'BOM-IHC-DES', name: 'IHC-Desmin检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-SMA', code: 'BOM-IHC-SMA', name: 'IHC-SMA检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD34', code: 'BOM-IHC-CD34', name: 'IHC-CD34检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD31', code: 'BOM-IHC-CD31', name: 'IHC-CD31检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD117', code: 'BOM-IHC-CD117', name: 'IHC-CD117(c-Kit)检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-DOG1', code: 'BOM-IHC-DOG1', name: 'IHC-DOG1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Inhibin', code: 'BOM-IHC-Inhibin', name: 'IHC-Inhibin检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Calret', code: 'BOM-IHC-Calret', name: 'IHC-Calretinin检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-HepPar', code: 'BOM-IHC-HepPar', name: 'IHC-HepPar-1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Arg1', code: 'BOM-IHC-Arg1', name: 'IHC-Arginase-1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-NapsinA', code: 'BOM-IHC-NapsinA', name: 'IHC-Napsin A检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-INSM1', code: 'BOM-IHC-INSM1', name: 'IHC-INSM1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-NKX31', code: 'BOM-IHC-NKX31', name: 'IHC-NKX3.1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD56', code: 'BOM-IHC-CD56', name: 'IHC-CD56检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-NSE', code: 'BOM-IHC-NSE', name: 'IHC-NSE检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-ROS1', code: 'BOM-IHC-ROS1', name: 'IHC-ROS1检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-RET', code: 'BOM-IHC-RET', name: 'IHC-RET检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MET', code: 'BOM-IHC-MET', name: 'IHC-MET检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Olig2', code: 'BOM-IHC-Olig2', name: 'IHC-Olig2检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-NeuN', code: 'BOM-IHC-NeuN', name: 'IHC-NeuN检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CK56', code: 'BOM-IHC-CK56', name: 'IHC-CK5/6检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-EMA', code: 'BOM-IHC-EMA', name: 'IHC-EMA检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-BerEP4', code: 'BOM-IHC-BerEP4', name: 'IHC-BerEP4检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-AR', code: 'BOM-IHC-AR', name: 'IHC-AR检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Casp3', code: 'BOM-IHC-Casp3', name: 'IHC-Caspase-3检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD10', code: 'BOM-IHC-CD10', name: 'IHC-CD10检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD15', code: 'BOM-IHC-CD15', name: 'IHC-CD15检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD45', code: 'BOM-IHC-CD45', name: 'IHC-CD45(LCA)检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-CD23', code: 'BOM-IHC-CD23', name: 'IHC-CD23检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MPO', code: 'BOM-IHC-MPO', name: 'IHC-MPO检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-ERG', code: 'BOM-IHC-ERG', name: 'IHC-ERG检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-P21', code: 'BOM-IHC-P21', name: 'IHC-P21检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-P27', code: 'BOM-IHC-P27', name: 'IHC-P27检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Brachyury', code: 'BOM-IHC-Brachyury', name: 'IHC-Brachyury检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-SALL4', code: 'BOM-IHC-SALL4', name: 'IHC-SALL4检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-OCT34', code: 'BOM-IHC-OCT34', name: 'IHC-OCT3/4检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-PLAP', code: 'BOM-IHC-PLAP', name: 'IHC-PLAP检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-AFP', code: 'BOM-IHC-AFP', name: 'IHC-AFP检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-HCG', code: 'BOM-IHC-HCG', name: 'IHC-HCG检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-HPV', code: 'BOM-IHC-HPV', name: 'IHC-HPV(L1)检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-EBV', code: 'BOM-IHC-EBV', name: 'IHC-EBV(LMP-1)检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-HHV8', code: 'BOM-IHC-HHV8', name: 'IHC-HHV-8检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MUC2', code: 'BOM-IHC-MUC2', name: 'IHC-MUC2检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MUC5AC', code: 'BOM-IHC-MUC5AC', name: 'IHC-MUC5AC检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-MUC6', code: 'BOM-IHC-MUC6', name: 'IHC-MUC6检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-Villin', code: 'BOM-IHC-Villin', name: 'IHC-Villin检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    { id: 'BOM-IHC-RCC', code: 'BOM-IHC-RCC', name: 'IHC-RCC检测BOM', version: 'v1.0', type: 'ihc', supportable_samples: 30, unit_cost: 0 },
    // 特殊染色
    { id: 'BOM-SS-001', code: 'BOM-SS-001', name: 'PAS特殊染色BOM', version: 'v1.0', type: 'ss', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-SS-002', code: 'BOM-SS-002', name: '网状纤维银染BOM', version: 'v1.0', type: 'ss', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-SS-003', code: 'BOM-SS-003', name: 'Masson三色染色BOM', version: 'v1.0', type: 'ss', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-SS-004', code: 'BOM-SS-004', name: '抗酸染色BOM', version: 'v1.0', type: 'ss', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-SS-005', code: 'BOM-SS-005', name: '革兰氏染色BOM', version: 'v1.0', type: 'ss', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-SS-006', code: 'BOM-SS-006', name: '油红O染色BOM', version: 'v1.0', type: 'ss', supportable_samples: 50, unit_cost: 0 },

    // 分子诊断
    { id: 'BOM-MP-001', code: 'BOM-MP-001', name: 'NGS文库制备BOM', version: 'v1.0', type: 'mp', supportable_samples: 16, unit_cost: 0 },
    { id: 'BOM-MP-002', code: 'BOM-MP-002', name: 'FISH检测BOM', version: 'v1.0', type: 'mp', supportable_samples: 20, unit_cost: 0 },
    { id: 'BOM-MP-003', code: 'BOM-MP-003', name: 'PCR检测BOM', version: 'v1.0', type: 'mp', supportable_samples: 48, unit_cost: 0 },
    { id: 'BOM-MP-004', code: 'BOM-MP-004', name: 'Sanger测序BOM', version: 'v1.0', type: 'mp', supportable_samples: 24, unit_cost: 0 },
    { id: 'BOM-MP-005', code: 'BOM-MP-005', name: 'FFPE DNA提取BOM', version: 'v1.0', type: 'mp', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-MP-006', code: 'BOM-MP-006', name: '血液DNA提取BOM', version: 'v1.0', type: 'mp', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-MP-007', code: 'BOM-MP-007', name: 'RNA提取BOM', version: 'v1.0', type: 'mp', supportable_samples: 50, unit_cost: 0 },

    // 细胞学
    { id: 'BOM-CYTO-001', code: 'BOM-CYTO-001', name: 'TCT检测BOM', version: 'v1.0', type: 'cyto', supportable_samples: 100, unit_cost: 0 },
    { id: 'BOM-CYTO-002', code: 'BOM-CYTO-002', name: '细针穿刺细胞学BOM', version: 'v1.0', type: 'cyto', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-CYTO-003', code: 'BOM-CYTO-003', name: '尿液细胞学BOM', version: 'v1.0', type: 'cyto', supportable_samples: 50, unit_cost: 0 },
    { id: 'BOM-CYTO-004', code: 'BOM-CYTO-004', name: '胸腹水细胞学BOM', version: 'v1.0', type: 'cyto', supportable_samples: 50, unit_cost: 0 },
  ]

  const bomItems = [
    // === HE染色BOM ===
    { bom_id: 'BOM-HE-001', material_id: 'MAT-HE-001', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-HE-002', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-HE-003', usage_per_sample: 0.02, unit: 'ml' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-HE-004', usage_per_sample: 0.02, unit: 'ml' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-HE-005', usage_per_sample: 0.5, unit: 'ml' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-HE-006', usage_per_sample: 0.5, unit: 'ml' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-HE-007', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-HE-009', usage_per_sample: 0.02, unit: 'ml' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-HE-001', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    // === 冰冻切片HE ===
    { bom_id: 'BOM-HE-002', material_id: 'MAT-HE-001', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-HE-002', material_id: 'MAT-HE-002', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-HE-002', material_id: 'MAT-HE-005', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-HE-002', material_id: 'MAT-HE-009', usage_per_sample: 0.01, unit: 'ml' },
    { bom_id: 'BOM-HE-002', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-HE-002', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    // === IHC基础通用耗材（所有IHC检测共用） ===
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-097', usage_per_sample: 0.1, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-098', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-101', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-102', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-106', usage_per_sample: 0.15, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-107', usage_per_sample: 0.15, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-111', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-112', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-113', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-114', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-115', usage_per_sample: 0.01, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-119', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-120', usage_per_sample: 0.02, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-121', usage_per_sample: 0.02, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-122', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-IHC-123', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-LAB-010', usage_per_sample: 1, unit: '只' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-LAB-011', usage_per_sample: 1, unit: '只' },
    { bom_id: 'BOM-IHC-001', material_id: 'MAT-LAB-012', usage_per_sample: 1, unit: '只' },

    // === 各抗体检测BOM（每个包含：特定一抗 + 基础通用耗材引用） ===
    // 广谱CK
    { bom_id: 'BOM-IHC-CK', material_id: 'MAT-IHC-001', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CK7', material_id: 'MAT-IHC-002', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CK20', material_id: 'MAT-IHC-003', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-TTF1', material_id: 'MAT-IHC-007', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-GATA3', material_id: 'MAT-IHC-009', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-PAX8', material_id: 'MAT-IHC-010', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD20', material_id: 'MAT-IHC-021', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD3', material_id: 'MAT-IHC-020', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD30', material_id: 'MAT-IHC-023', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Ki67', material_id: 'MAT-IHC-049', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-P53', material_id: 'MAT-IHC-050', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-P16', material_id: 'MAT-IHC-051', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-HER2', material_id: 'MAT-IHC-055', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-ER', material_id: 'MAT-IHC-056', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-PR', material_id: 'MAT-IHC-057', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-PDL1', material_id: 'MAT-IHC-059', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-ALK', material_id: 'MAT-IHC-063', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-EGFR', material_id: 'MAT-IHC-062', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Syn', material_id: 'MAT-IHC-039', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CgA', material_id: 'MAT-IHC-040', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-S100', material_id: 'MAT-IHC-014', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Vim', material_id: 'MAT-IHC-011', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-PSA', material_id: 'MAT-IHC-079', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-WT1', material_id: 'MAT-IHC-082', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CDX2', material_id: 'MAT-IHC-088', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-SATB2', material_id: 'MAT-IHC-089', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-MLH1', material_id: 'MAT-IHC-071', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-MSH2', material_id: 'MAT-IHC-069', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-MSH6', material_id: 'MAT-IHC-070', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-PMS2', material_id: 'MAT-IHC-072', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-KRAS', material_id: 'MAT-IHC-067', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-BRAF', material_id: 'MAT-IHC-068', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-IDH1', material_id: 'MAT-IHC-047', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-ATRX', material_id: 'MAT-IHC-048', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-GFAP', material_id: 'MAT-IHC-045', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-SOX11', material_id: 'MAT-IHC-032', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CyclinD1', material_id: 'MAT-IHC-031', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-BCL2', material_id: 'MAT-IHC-026', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-BCL6', material_id: 'MAT-IHC-027', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-MUM1', material_id: 'MAT-IHC-028', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD21', material_id: 'MAT-IHC-029', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD68', material_id: 'MAT-IHC-034', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD163', material_id: 'MAT-IHC-035', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD138', material_id: 'MAT-IHC-036', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Kappa', material_id: 'MAT-IHC-037', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Lambda', material_id: 'MAT-IHC-038', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-DES', material_id: 'MAT-IHC-013', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-SMA', material_id: 'MAT-IHC-012', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD34', material_id: 'MAT-IHC-015', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD31', material_id: 'MAT-IHC-016', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD117', material_id: 'MAT-IHC-018', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-DOG1', material_id: 'MAT-IHC-019', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Inhibin', material_id: 'MAT-IHC-084', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Calret', material_id: 'MAT-IHC-083', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-HepPar', material_id: 'MAT-IHC-085', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Arg1', material_id: 'MAT-IHC-086', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-NapsinA', material_id: 'MAT-IHC-008', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-INSM1', material_id: 'MAT-IHC-043', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-NKX31', material_id: 'MAT-IHC-081', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD56', material_id: 'MAT-IHC-041', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-NSE', material_id: 'MAT-IHC-042', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-ROS1', material_id: 'MAT-IHC-064', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-RET', material_id: 'MAT-IHC-065', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-MET', material_id: 'MAT-IHC-066', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Olig2', material_id: 'MAT-IHC-046', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-NeuN', material_id: 'MAT-IHC-044', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CK56', material_id: 'MAT-IHC-004', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-EMA', material_id: 'MAT-IHC-005', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-BerEP4', material_id: 'MAT-IHC-006', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-AR', material_id: 'MAT-IHC-058', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Casp3', material_id: 'MAT-IHC-054', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD10', material_id: 'MAT-IHC-025', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD15', material_id: 'MAT-IHC-024', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD45', material_id: 'MAT-IHC-022', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-CD23', material_id: 'MAT-IHC-030', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-MPO', material_id: 'MAT-IHC-033', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-ERG', material_id: 'MAT-IHC-017', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-P21', material_id: 'MAT-IHC-052', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-P27', material_id: 'MAT-IHC-053', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Brachyury', material_id: 'MAT-IHC-091', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-SALL4', material_id: 'MAT-IHC-092', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-OCT34', material_id: 'MAT-IHC-093', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-PLAP', material_id: 'MAT-IHC-094', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-AFP', material_id: 'MAT-IHC-095', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-HCG', material_id: 'MAT-IHC-096', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-HPV', material_id: 'MAT-IHC-073', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-EBV', material_id: 'MAT-IHC-074', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-HHV8', material_id: 'MAT-IHC-077', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-Villin', material_id: 'MAT-IHC-090', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-IHC-RCC', material_id: 'MAT-IHC-087', usage_per_sample: 0.05, unit: 'ml' },

    // === 特殊染色BOMs ===
    { bom_id: 'BOM-SS-001', material_id: 'MAT-HE-001', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-001', material_id: 'MAT-HE-002', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-001', material_id: 'MAT-HE-005', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-SS-001', material_id: 'MAT-HE-007', usage_per_sample: 0.2, unit: 'ml' },
    { bom_id: 'BOM-SS-001', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-SS-001', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-SS-002', material_id: 'MAT-HE-001', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-002', material_id: 'MAT-HE-002', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-002', material_id: 'MAT-HE-005', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-SS-002', material_id: 'MAT-HE-007', usage_per_sample: 0.2, unit: 'ml' },
    { bom_id: 'BOM-SS-002', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-SS-002', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-SS-003', material_id: 'MAT-HE-001', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-003', material_id: 'MAT-HE-002', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-003', material_id: 'MAT-HE-005', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-SS-003', material_id: 'MAT-HE-007', usage_per_sample: 0.2, unit: 'ml' },
    { bom_id: 'BOM-SS-003', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-SS-003', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-SS-004', material_id: 'MAT-HE-001', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-004', material_id: 'MAT-HE-002', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-004', material_id: 'MAT-HE-005', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-SS-004', material_id: 'MAT-HE-007', usage_per_sample: 0.2, unit: 'ml' },
    { bom_id: 'BOM-SS-004', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-SS-004', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-SS-005', material_id: 'MAT-HE-001', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-005', material_id: 'MAT-HE-002', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-005', material_id: 'MAT-HE-005', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-SS-005', material_id: 'MAT-HE-007', usage_per_sample: 0.2, unit: 'ml' },
    { bom_id: 'BOM-SS-005', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-SS-005', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-SS-006', material_id: 'MAT-HE-001', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-006', material_id: 'MAT-HE-002', usage_per_sample: 0.03, unit: 'ml' },
    { bom_id: 'BOM-SS-006', material_id: 'MAT-HE-005', usage_per_sample: 0.3, unit: 'ml' },
    { bom_id: 'BOM-SS-006', material_id: 'MAT-HE-007', usage_per_sample: 0.2, unit: 'ml' },
    { bom_id: 'BOM-SS-006', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-SS-006', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    // === 分子诊断BOMs ===
    { bom_id: 'BOM-MP-001', material_id: 'MAT-MP-001', usage_per_sample: 1, unit: '次' },
    { bom_id: 'BOM-MP-001', material_id: 'MAT-MP-004', usage_per_sample: 0.05, unit: 'ml' },
    { bom_id: 'BOM-MP-001', material_id: 'MAT-MP-005', usage_per_sample: 0.01, unit: 'ml' },
    { bom_id: 'BOM-MP-001', material_id: 'MAT-MP-006', usage_per_sample: 1, unit: '次' },
    { bom_id: 'BOM-MP-001', material_id: 'MAT-LAB-001', usage_per_sample: 10, unit: '支' },
    { bom_id: 'BOM-MP-001', material_id: 'MAT-LAB-004', usage_per_sample: 5, unit: '支' },
    { bom_id: 'BOM-MP-001', material_id: 'MAT-LAB-006', usage_per_sample: 2, unit: '支' },

    { bom_id: 'BOM-MP-002', material_id: 'MAT-MP-008', usage_per_sample: 1, unit: '测试' },
    { bom_id: 'BOM-MP-002', material_id: 'MAT-MP-009', usage_per_sample: 1, unit: '测试' },
    { bom_id: 'BOM-MP-002', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-MP-002', material_id: 'MAT-GLASS-002', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-MP-003', material_id: 'MAT-MP-004', usage_per_sample: 0.025, unit: 'ml' },
    { bom_id: 'BOM-MP-003', material_id: 'MAT-MP-005', usage_per_sample: 0.005, unit: 'ml' },
    { bom_id: 'BOM-MP-003', material_id: 'MAT-LAB-001', usage_per_sample: 5, unit: '支' },
    { bom_id: 'BOM-MP-003', material_id: 'MAT-LAB-004', usage_per_sample: 2, unit: '支' },
    { bom_id: 'BOM-MP-003', material_id: 'MAT-LAB-006', usage_per_sample: 1, unit: '支' },

    { bom_id: 'BOM-MP-004', material_id: 'MAT-MP-001', usage_per_sample: 1, unit: '次' },
    { bom_id: 'BOM-MP-004', material_id: 'MAT-MP-004', usage_per_sample: 0.02, unit: 'ml' },
    { bom_id: 'BOM-MP-004', material_id: 'MAT-MP-005', usage_per_sample: 0.005, unit: 'ml' },
    { bom_id: 'BOM-MP-004', material_id: 'MAT-LAB-001', usage_per_sample: 3, unit: '支' },
    { bom_id: 'BOM-MP-004', material_id: 'MAT-LAB-004', usage_per_sample: 2, unit: '支' },

    { bom_id: 'BOM-MP-005', material_id: 'MAT-MP-001', usage_per_sample: 1, unit: '次' },
    { bom_id: 'BOM-MP-005', material_id: 'MAT-LAB-001', usage_per_sample: 5, unit: '支' },
    { bom_id: 'BOM-MP-005', material_id: 'MAT-LAB-004', usage_per_sample: 3, unit: '支' },

    { bom_id: 'BOM-MP-006', material_id: 'MAT-MP-002', usage_per_sample: 1, unit: '次' },
    { bom_id: 'BOM-MP-006', material_id: 'MAT-LAB-001', usage_per_sample: 5, unit: '支' },
    { bom_id: 'BOM-MP-006', material_id: 'MAT-LAB-004', usage_per_sample: 3, unit: '支' },

    { bom_id: 'BOM-MP-007', material_id: 'MAT-MP-003', usage_per_sample: 1, unit: '次' },
    { bom_id: 'BOM-MP-007', material_id: 'MAT-LAB-001', usage_per_sample: 5, unit: '支' },
    { bom_id: 'BOM-MP-007', material_id: 'MAT-LAB-004', usage_per_sample: 3, unit: '支' },

    // === 细胞学BOMs ===
    { bom_id: 'BOM-CYTO-001', material_id: 'MAT-CYTO-005', usage_per_sample: 1, unit: '瓶' },
    { bom_id: 'BOM-CYTO-001', material_id: 'MAT-CYTO-003', usage_per_sample: 0.1, unit: '套' },
    { bom_id: 'BOM-CYTO-001', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-CYTO-001', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-CYTO-002', material_id: 'MAT-CYTO-001', usage_per_sample: 0.5, unit: 'ml' },
    { bom_id: 'BOM-CYTO-002', material_id: 'MAT-CYTO-004', usage_per_sample: 0.05, unit: '套' },
    { bom_id: 'BOM-CYTO-002', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
    { bom_id: 'BOM-CYTO-002', material_id: 'MAT-GLASS-003', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-CYTO-003', material_id: 'MAT-CYTO-001', usage_per_sample: 0.5, unit: 'ml' },
    { bom_id: 'BOM-CYTO-003', material_id: 'MAT-CYTO-003', usage_per_sample: 0.05, unit: '套' },
    { bom_id: 'BOM-CYTO-003', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },

    { bom_id: 'BOM-CYTO-004', material_id: 'MAT-CYTO-001', usage_per_sample: 0.5, unit: 'ml' },
    { bom_id: 'BOM-CYTO-004', material_id: 'MAT-CYTO-003', usage_per_sample: 0.05, unit: '套' },
    { bom_id: 'BOM-CYTO-004', material_id: 'MAT-GLASS-001', usage_per_sample: 1, unit: '片' },
  ]

  const insertBom = db.prepare(
    'INSERT INTO boms (id, code, name, version, type, supportable_samples, unit_cost, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const b of boms) {
    insertBom.run(b.id, b.code, b.name, b.version, b.type, b.supportable_samples, b.unit_cost, 1, now, now)
  }

  const insertItem = db.prepare(
    'INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit) VALUES (?, ?, ?, ?, ?)'
  )
  for (const item of bomItems) {
    insertItem.run(uuidv4(), item.bom_id, item.material_id, item.usage_per_sample, item.unit)
  }

  log(`BOM初始化完成: ${boms.length} 个BOM, ${bomItems.length} 个物料明细`)
}

// ============================================
// 9. 创建预警规则
// ============================================
function seedAlertRules(db: any) {
  log('开始初始化预警规则...')
  const check = db.prepare('SELECT COUNT(*) as count FROM alert_rules')
  const existing = check.get() as any
  if (existing.count > 3) {
    log('预警规则已存在，跳过初始化')
    return
  }

  const rules = [
    { id: 'RULE-001', type: 'low-stock', name: '低库存预警', threshold: 5, threshold_days: null, enabled: 1 },
    { id: 'RULE-002', type: 'expiry', name: '有效期预警', threshold: null, threshold_days: 30, enabled: 1 },
    { id: 'RULE-003', type: 'stagnant', name: '呆滞库存预警', threshold: 90, threshold_days: null, enabled: 1 },
    { id: 'RULE-004', type: 'expiry-critical', name: '临期预警（7天）', threshold: null, threshold_days: 7, enabled: 1 },
    { id: 'RULE-005', type: 'safety-stock', name: '安全库存预警', threshold: 2, threshold_days: null, enabled: 1 },
  ]

  const insert = db.prepare(
    'INSERT OR REPLACE INTO alert_rules (id, type, name, threshold, threshold_days, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const r of rules) {
    insert.run(r.id, r.type, r.name, r.threshold, r.threshold_days, r.enabled, now, now)
  }
  log(`预警规则初始化完成: ${rules.length} 条`)
}

// ============================================
// 主函数
// ============================================
function main() {
  log('============================================')
  log('病理科基础数据初始化开始')
  log('============================================')

  // 先初始化数据库表结构
  initializeDatabase()

  const db = getDatabase()

  try {
    seedRoles(db)
    seedUsers(db)
    seedSuppliers(db)
    seedLocations(db)
    seedCategories(db)
    seedMaterials(db)
    seedProjects(db)
    seedBOMs(db)
    seedAlertRules(db)

    log('============================================')
    log('病理科基础数据初始化完成')
    log('============================================')
  } catch (err: any) {
    log(`初始化失败: ${err.message}`)
    console.error(err)
    process.exit(1)
  }
}

main()
