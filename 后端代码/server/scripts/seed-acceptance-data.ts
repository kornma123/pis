/**
 * 验收测试数据初始化脚本（#140 全批次事实模型）
 *
 * 合同（K3-PRD-140-BATCH-FACT-CLOSURE-V1 Phase A）：
 * - 只在显式 development/test 环境执行（门禁通过后才动态加载数据库模块）；
 * - 硬目标库守卫：目标库文件已存在且非空时拒绝执行，绝不覆盖既有业务库；
 * - batches.remaining 是库存事实，inventory.stock 是同事务派生缓存：
 *   写库前逐批次校验（quantity>=0、0<=remaining<=quantity、status∈{0,1}、
 *   remaining>0 当且仅当 status=1），写库后逐物料核验
 *   inventory.stock = Σ eligible 批次 remaining，失败即整体回滚；
 * - 只用于全新开发库，不触碰任何真实/生产数据库。
 *
 * 数据链：供应商 → 三级分类 → 物料 → 库位 → 入库 20+10（两个事实批次）
 * → FEFO 出库 5+10（全部消耗首批）→ 末态：首批余 5、次批余 10、库存 15。
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFixtureEnv } from '../src/config/security.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MATERIAL_CODE = 'MAT-ACCEPT-001'

function resolveTargetDatabasePath(): string {
  return process.env.DATABASE_PATH || join(__dirname, '../data/coreone.db')
}

function assertFreshTargetDatabase(targetPath: string): void {
  if (targetPath === ':memory:') return
  if (existsSync(targetPath) && statSync(targetPath).size > 0) {
    throw new Error(
      `[SECURITY] 目标数据库已存在且非空：${targetPath}。` +
      '拒绝在既有业务库上灌入验收夹具；请先备份并移除该文件后再重灌。',
    )
  }
}

type BatchFixture = {
  id: string
  batchNo: string
  quantity: number
  remaining: number
  status: number
  productionDate: string
  expiryDate: string
  inboundId: string
  inboundPrice: number
}

function assertValidBatchFixture(fixture: BatchFixture): void {
  if (!Number.isFinite(fixture.quantity) || fixture.quantity < 0) {
    throw new Error(`批次 ${fixture.batchNo} 数量非法：${fixture.quantity}（必须 >= 0）`)
  }
  if (!Number.isFinite(fixture.remaining) || fixture.remaining < 0 || fixture.remaining > fixture.quantity) {
    throw new Error(
      `批次 ${fixture.batchNo} 剩余量非法：remaining=${fixture.remaining} / quantity=${fixture.quantity}（必须 0 <= remaining <= quantity）`,
    )
  }
  if (fixture.status !== 0 && fixture.status !== 1) {
    throw new Error(`批次 ${fixture.batchNo} 状态非法：${fixture.status}（只允许 0/1）`)
  }
  if ((fixture.remaining === 0) !== (fixture.status === 0)) {
    throw new Error(
      `批次 ${fixture.batchNo} 事实矛盾：remaining=${fixture.remaining} 与 status=${fixture.status} 不一致（remaining>0 当且仅当 status=1）`,
    )
  }
}

async function main() {
  if (!isFixtureEnv()) {
    throw new Error('[SECURITY] seed-acceptance-data 只允许在显式 development/test 环境执行。')
  }
  const targetPath = resolveTargetDatabasePath()
  assertFreshTargetDatabase(targetPath)

  // 门禁通过后才加载数据库模块，避免拒止前创建/打开目标数据库。
  const { getDatabase, initializeDatabase } = await import('../src/database/DatabaseManager.js')
  initializeDatabase()
  const db = getDatabase()

  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  const expiry = new Date()
  expiry.setFullYear(expiry.getFullYear() + 1)
  const expiryDate = expiry.toISOString().slice(0, 10)

  console.log('🌱 开始初始化验收测试数据...\n')

  // ============================================
  // 夹具定义（唯一事实源；派生值在写库后从 DB 重新核验）
  // ============================================
  const supplierId = 'SEED-ACCEPT-SUP-001'
  const cat1Id = 'SEED-ACCEPT-CAT-1'
  const cat2Id = 'SEED-ACCEPT-CAT-2'
  const cat3Id = 'SEED-ACCEPT-CAT-3'
  const materialId = 'SEED-ACCEPT-MAT-001'
  const locationId = 'SEED-ACCEPT-LOC-001'
  const inbound1Id = 'SEED-ACCEPT-IB-001'
  const inbound2Id = 'SEED-ACCEPT-IB-002'
  const outbound1Id = 'SEED-ACCEPT-OB-001'
  const outbound2Id = 'SEED-ACCEPT-OB-002'
  const projectId = 'SEED-ACCEPT-PRJ-001'
  const bomId = 'SEED-ACCEPT-BOM-001'

  // 批次事实：入库 20 + 10；出库 5 + 10 按 FEFO 全部消耗首批。
  const batchFixtures: BatchFixture[] = [
    {
      id: 'SEED-ACCEPT-BATCH-001',
      batchNo: 'B-ACCEPT-001',
      quantity: 20,
      remaining: 5,
      status: 1,
      productionDate: today,
      expiryDate,
      inboundId: inbound1Id,
      inboundPrice: 50,
    },
    {
      id: 'SEED-ACCEPT-BATCH-002',
      batchNo: 'B-ACCEPT-002',
      quantity: 10,
      remaining: 10,
      status: 1,
      productionDate: today,
      expiryDate,
      inboundId: inbound2Id,
      inboundPrice: 50,
    },
  ]
  for (const fixture of batchFixtures) assertValidBatchFixture(fixture)

  const eligibleTotal = batchFixtures
    .filter((fixture) => fixture.status === 1 && fixture.remaining > 0)
    .reduce((sum, fixture) => sum + fixture.remaining, 0)

  db.exec('BEGIN IMMEDIATE')
  try {
    // 1. 供应商
    db.prepare(
      `INSERT INTO suppliers (id, code, name, contact, phone, address, status)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(supplierId, 'SUP-ACCEPT-001', '验收测试供应商', '王经理', '13800138001', '北京市朝阳区')
    console.log('✅ 供应商创建成功:', supplierId)

    // 2. 三级分类
    db.prepare(
      `INSERT INTO material_categories (id, code, name, parent_id, level, sort_order, status)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(cat1Id, 'CAT-ACCEPT-1', '试剂类', null, 1, 1)
    db.prepare(
      `INSERT INTO material_categories (id, code, name, parent_id, level, sort_order, status)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(cat2Id, 'CAT-ACCEPT-2', '分子诊断试剂', cat1Id, 2, 1)
    db.prepare(
      `INSERT INTO material_categories (id, code, name, parent_id, level, sort_order, status)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(cat3Id, 'CAT-ACCEPT-3', 'NGS试剂盒', cat2Id, 3, 1)
    console.log('✅ 三级分类创建成功:', cat1Id, cat2Id, cat3Id)

    // 3. 库位
    db.prepare(
      `INSERT INTO locations (id, code, name, type, zone, shelf, position, status)
       VALUES (?, ?, ?, 'shelf', ?, ?, ?, 1)`,
    ).run(locationId, 'LOC-ACCEPT-A1', 'A区-1-001', 'A区', '1', '001')
    console.log('✅ 库位创建成功:', locationId)

    // 4. 物料（验收测试试剂盒）
    db.prepare(
      `INSERT INTO materials (id, code, name, spec, unit, spec_qty, spec_unit, category_id, supplier_id, price, min_stock, location_id, status)
       VALUES (?, ?, ?, ?, '盒', 50, '次', ?, ?, 50, 5, ?, 1)`,
    ).run(materialId, MATERIAL_CODE, '验收测试试剂盒', '50次/盒', cat3Id, supplierId, locationId)
    console.log('✅ 物料创建成功:', materialId)

    // 5. 入库记录（20盒 + 10盒，各自对应一个事实批次）
    db.prepare(
      `INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount, supplier_id, location_id, production_date, expiry_date, operator, status, remark)
       VALUES (?, ?, 'purchase', ?, ?, ?, 20, '盒', 50, 1000, ?, ?, ?, ?, '管理员', 'completed', '第一次入库20盒')`,
    ).run(inbound1Id, 'IB-ACCEPT-001', materialId, batchFixtures[0].id, batchFixtures[0].batchNo, supplierId, locationId, today, expiryDate)
    db.prepare(
      `INSERT INTO inbound_records (id, inbound_no, type, material_id, batch_id, batch_no, quantity, unit, price, amount, supplier_id, location_id, production_date, expiry_date, operator, status, remark)
       VALUES (?, ?, 'purchase', ?, ?, ?, 10, '盒', 50, 500, ?, ?, ?, ?, '管理员', 'completed', '第二次入库10盒')`,
    ).run(inbound2Id, 'IB-ACCEPT-002', materialId, batchFixtures[1].id, batchFixtures[1].batchNo, supplierId, locationId, today, expiryDate)
    console.log('✅ 入库记录创建成功: 20盒 + 10盒 = 30盒')

    // 6. 批次事实（batches.remaining 是库存事实）
    for (const fixture of batchFixtures) {
      db.prepare(
        `INSERT INTO batches (id, material_id, batch_no, quantity, remaining, production_date, expiry_date, inbound_id, inbound_price, supplier_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fixture.id,
        materialId,
        fixture.batchNo,
        fixture.quantity,
        fixture.remaining,
        fixture.productionDate,
        fixture.expiryDate,
        fixture.inboundId,
        fixture.inboundPrice,
        supplierId,
        fixture.status,
      )
    }
    console.log('✅ 批次事实创建成功: 首批余 5 / 次批余 10')

    // 7. 出库记录（FEFO：5 + 10 全部消耗首批，逐批留明细）
    db.prepare(
      `INSERT INTO outbound_records (id, outbound_no, type, total_cost, operator, status, remark)
       VALUES (?, ?, 'direct', 250, '张医生', 'completed', '第一次出库5盒')`,
    ).run(outbound1Id, 'OB-ACCEPT-001')
    db.prepare(
      `INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
       VALUES (?, ?, ?, ?, ?, 5, '盒', 50, 250, 'self', '张医生')`,
    ).run('SEED-ACCEPT-OI-001', outbound1Id, materialId, batchFixtures[0].id, batchFixtures[0].batchNo)
    db.prepare(
      `INSERT INTO outbound_records (id, outbound_no, type, total_cost, operator, status, remark)
       VALUES (?, ?, 'direct', 500, '李医生', 'completed', '第二次出库10盒')`,
    ).run(outbound2Id, 'OB-ACCEPT-002')
    db.prepare(
      `INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
       VALUES (?, ?, ?, ?, ?, 10, '盒', 50, 500, 'self', '李医生')`,
    ).run('SEED-ACCEPT-OI-002', outbound2Id, materialId, batchFixtures[0].id, batchFixtures[0].batchNo)
    console.log('✅ 出库记录创建成功: 5盒 + 10盒 = 15盒（全部首批）')

    // 8. 库存派生缓存（inventory.stock = Σ eligible 批次 remaining）
    db.prepare(
      `INSERT INTO inventory (id, material_id, stock, locked_stock, location_id, last_inbound_id, last_inbound_date, last_outbound_id, last_outbound_date)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run('SEED-ACCEPT-INV-001', materialId, eligibleTotal, locationId, inbound2Id, today, outbound2Id, today)
    console.log(`✅ 库存派生缓存创建成功: ${eligibleTotal}盒`)

    // 9. 检测项目 + BOM（单例用量2盒）
    db.prepare(
      `INSERT INTO projects (id, code, name, type, description, status)
       VALUES (?, 'ACCEPT-PRJ-001', '验收测试项目', '分子诊断', '分子诊断验收测试项目', 1)`,
    ).run(projectId)
    db.prepare(
      `INSERT INTO boms (id, code, name, version, type, description, status)
       VALUES (?, 'ACCEPT-BOM-001', '验收测试BOM', 'v1.0', '分子诊断', '验收测试用BOM配置', 1)`,
    ).run(bomId)
    db.prepare(
      `INSERT INTO bom_items (id, bom_id, material_id, usage_per_sample, unit, is_alternative)
       VALUES (?, ?, ?, 2, '盒', 0)`,
    ).run('SEED-ACCEPT-BOMITEM-001', bomId, materialId)
    console.log('✅ 检测项目与BOM创建成功: 单例用量2盒')

    // 10. 库存台账（+20 / +10 / -5 / -10）
    const stockLogRows = [
      { id: 'SEED-ACCEPT-LOG-001', type: 'inbound', quantity: 20, before: 0, after: 20, relatedId: inbound1Id, relatedType: 'inbound', operator: '管理员', remark: '第一次入库20盒' },
      { id: 'SEED-ACCEPT-LOG-002', type: 'inbound', quantity: 10, before: 20, after: 30, relatedId: inbound2Id, relatedType: 'inbound', operator: '管理员', remark: '第二次入库10盒' },
      { id: 'SEED-ACCEPT-LOG-003', type: 'outbound', quantity: -5, before: 30, after: 25, relatedId: outbound1Id, relatedType: 'outbound', operator: '张医生', remark: '第一次出库5盒' },
      { id: 'SEED-ACCEPT-LOG-004', type: 'outbound', quantity: -10, before: 25, after: 15, relatedId: outbound2Id, relatedType: 'outbound', operator: '李医生', remark: '第二次出库10盒' },
    ]
    for (const log of stockLogRows) {
      db.prepare(
        `INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(log.id, log.type, materialId, log.quantity, log.before, log.after, log.relatedId, log.relatedType, log.operator, log.remark)
    }
    console.log('✅ 库存台账创建成功: 4 笔')

    // ============================================
    // 写后核验（同一事务内，从 DB 重新读事实，不轻信夹具定义）
    // ============================================
    const persistedBatches = db.prepare(
      'SELECT batch_no, quantity, remaining, status FROM batches WHERE material_id = ?',
    ).all(materialId) as Array<{ batch_no: string; quantity: number; remaining: number; status: number }>
    if (persistedBatches.length !== batchFixtures.length) {
      throw new Error(`种子写后核验失败：批次行数 ${persistedBatches.length} != ${batchFixtures.length}`)
    }
    let persistedEligible = 0
    for (const row of persistedBatches) {
      assertValidBatchFixture({
        id: row.batch_no,
        batchNo: row.batch_no,
        quantity: Number(row.quantity),
        remaining: Number(row.remaining),
        status: Number(row.status),
        productionDate: today,
        expiryDate,
        inboundId: '',
        inboundPrice: 0,
      })
      if (Number(row.status) === 1 && Number(row.remaining) > 0) persistedEligible += Number(row.remaining)
    }
    const persistedStock = db.prepare(
      'SELECT stock FROM inventory WHERE material_id = ?',
    ).get(materialId) as { stock: number } | undefined
    if (!persistedStock) throw new Error('种子写后核验失败：库存行缺失')
    if (Number(persistedStock.stock) !== persistedEligible) {
      throw new Error(
        `种子写后守恒核验失败：inventory.stock=${persistedStock.stock} != Σ eligible 批次 remaining=${persistedEligible}`,
      )
    }
    if (Number(persistedStock.stock) > 0 && persistedEligible <= 0) {
      throw new Error('种子写后核验失败：正库存缺少 eligible 批次')
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  console.log('\n📊 验收测试数据初始化完成:')
  console.log('  ├─ 供应商: 1 家')
  console.log('  ├─ 分类: 3 级')
  console.log('  ├─ 库位: 1 个')
  console.log('  ├─ 物料: 1 项（验收测试试剂盒）')
  console.log('  ├─ 入库记录: 2 笔 (20盒 + 10盒 = 30盒)')
  console.log('  ├─ 批次事实: 2 个 (首批余 5 / 次批余 10)')
  console.log('  ├─ 出库记录: 2 笔 (5盒 + 10盒 = 15盒，FEFO 全部首批)')
  console.log('  ├─ 库存缓存: 15盒 (= Σ eligible 批次 remaining)')
  console.log('  ├─ 检测项目+BOM: 1 套 (单例用量2盒)')
  console.log('  └─ 库存台账: 4 笔\n')
}

main().catch((error: unknown) => {
  console.error('❌ 数据初始化失败:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
