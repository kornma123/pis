/**
 * 验收测试数据初始化脚本
 * 基于 TEST-PLAN-v1.1 的测试场景创建完整数据链
 */

import { DatabaseManager } from "../src/database/DatabaseManager";
import { v4 as uuidv4 } from "uuid";

async function seedAcceptanceData() {
  const dbManager = DatabaseManager.getInstance();
  await dbManager.initialize();
  const db = dbManager.getDatabase();

  const now = new Date().toISOString();

  console.log("🌱 开始初始化验收测试数据...\n");

  // ============================================
  // 1. 创建供应商
  // ============================================
  const supplierId = uuidv4();
  await db.run(
    `INSERT INTO suppliers (id, public_id, name, contact_person, contact_phone, address, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [supplierId, supplierId, "验收测试供应商", "王经理", "13800138001", "北京市朝阳区", 1, now, now]
  );
  console.log("✅ 供应商创建成功:", supplierId);

  // ============================================
  // 2. 创建三级分类
  // ============================================
  const cat1Id = uuidv4();
  await db.run(
    `INSERT INTO categories (id, public_id, level, name, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [cat1Id, cat1Id, 1, "试剂类", 1, 1, now, now]
  );

  const cat2Id = uuidv4();
  await db.run(
    `INSERT INTO categories (id, public_id, parent_id, level, name, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cat2Id, cat2Id, cat1Id, 2, "分子诊断试剂", 1, 1, now, now]
  );

  const cat3Id = uuidv4();
  await db.run(
    `INSERT INTO categories (id, public_id, parent_id, level, name, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cat3Id, cat3Id, cat2Id, 3, "NGS试剂盒", 1, 1, now, now]
  );
  console.log("✅ 三级分类创建成功:", cat1Id, cat2Id, cat3Id);

  // ============================================
  // 3. 创建耗材配置（验收测试试剂盒）
  // ============================================
  const consumableId = uuidv4();
  await db.run(
    `INSERT INTO consumable_configs (id, public_id, category, name, specification, unit, default_unit_price, default_supplier_id, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [consumableId, consumableId, "NGS试剂盒", "验收测试试剂盒", "50次/盒", "盒", 50.0, supplierId, 1, now, now]
  );
  console.log("✅ 耗材配置创建成功:", consumableId);

  // ============================================
  // 4. 入库记录 - 第一次入库 20盒
  // ============================================
  const inboundBatchNo1 = `IB${new Date().toISOString().slice(0,10).replace(/-/g,"")}-001`;
  const inboundId1 = uuidv4();
  const expiryDate1 = new Date();
  expiryDate1.setFullYear(expiryDate1.getFullYear() + 1);

  await db.run(
    `INSERT INTO inbound_records (id, public_id, batch_no, consumable_config_id, category, specification, quantity, unit, unit_price, total_price, supplier_id, supplier_name, production_batch_no, expiry_date, expiry_status, days_until_expiry, storage_location, operator_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [inboundId1, inboundId1, inboundBatchNo1, consumableId, "NGS试剂盒", "50次/盒", 20, "盒", 50.0, 1000.0, supplierId, "验收测试供应商", "PROD-2026-001", expiryDate1.toISOString().slice(0,10), "normal", 365, "A区-1-001", "管理员", now, now]
  );
  console.log("✅ 第一次入库创建成功:", inboundBatchNo1, "数量: 20盒");

  // ============================================
  // 5. 入库记录 - 第二次入库 10盒（不同批次，测试FIFO）
  // ============================================
  const inboundBatchNo2 = `IB${new Date().toISOString().slice(0,10).replace(/-/g,"")}-002`;
  const inboundId2 = uuidv4();

  await db.run(
    `INSERT INTO inbound_records (id, public_id, batch_no, consumable_config_id, category, specification, quantity, unit, unit_price, total_price, supplier_id, supplier_name, production_batch_no, expiry_date, expiry_status, days_until_expiry, storage_location, operator_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [inboundId2, inboundId2, inboundBatchNo2, consumableId, "NGS试剂盒", "50次/盒", 10, "盒", 50.0, 500.0, supplierId, "验收测试供应商", "PROD-2026-002", expiryDate1.toISOString().slice(0,10), "normal", 365, "A区-1-001", "管理员", now, now]
  );
  console.log("✅ 第二次入库创建成功:", inboundBatchNo2, "数量: 10盒");

  // ============================================
  // 6. 库存表初始化（30盒总库存）
  // ============================================
  const inventoryId = uuidv4();
  await db.run(
    `INSERT INTO inventory (id, sku, name, category, batch, qty, unit, amount, unit_cost, location, status, expiry, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [inventoryId, "MAT-ACCEPT-001", "验收测试试剂盒", "NGS试剂盒", inboundBatchNo1, 30, "盒", 1500.0, 50.0, "A区-1-001", "in_stock", expiryDate1.toISOString().slice(0,10), now, now]
  );
  console.log("✅ 库存初始化成功: 30盒");

  // ============================================
  // 7. 创建检测项目（BOM项目）
  // ============================================
  const projectId = uuidv4();
  await db.run(
    `INSERT INTO detection_projects (id, public_id, project_name, project_code, project_type, description, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, projectId, "验收测试项目", "ACCEPT-PRJ-001", "分子诊断", "分子诊断验收测试项目", 1, now, now]
  );
  console.log("✅ 检测项目创建成功:", projectId);

  // ============================================
  // 8. 创建BOM项目
  // ============================================
  const bomProjectId = uuidv4();
  await db.run(
    `INSERT INTO bom_projects (id, public_id, project_name, project_code, description, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [bomProjectId, bomProjectId, "验收测试BOM", "ACCEPT-BOM-001", "验收测试用BOM配置", 1, now, now]
  );
  console.log("✅ BOM项目创建成功:", bomProjectId);

  // ============================================
  // 9. BOM清单 - 添加试剂盒，单例用量2盒
  // ============================================
  const bomItemId = uuidv4();
  await db.run(
    `INSERT INTO bom_items (id, public_id, project_id, consumable_config_id, category, specification, standard_quantity, unit, unit_price, total_price, remark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bomItemId, bomItemId, bomProjectId, consumableId, "NGS试剂盒", "50次/盒", 2, "盒", 50.0, 100.0, "单例用量2盒", now, now]
  );
  console.log("✅ BOM清单创建成功: 单例用量2盒");

  // ============================================
  // 10. 出库记录 - 第一次出库 5盒，领用人张医生
  // ============================================
  const outboundNo1 = `OB${new Date().toISOString().slice(0,10).replace(/-/g,"")}-001`;
  const outboundId1 = uuidv4();
  await db.run(
    `INSERT INTO outbound_records (id, public_id, outbound_no, batch_no, inventory_id, quantity, unit, purpose, operator_name, remark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [outboundId1, outboundId1, outboundNo1, inboundBatchNo1, inventoryId, 5, "盒", "分子诊断检测", "张医生", "第一次出库", now, now]
  );
  console.log("✅ 第一次出库创建成功:", outboundNo1, "数量: 5盒, 领用人: 张医生");

  // ============================================
  // 11. 出库记录 - 第二次出库 10盒，领用人李医生
  // ============================================
  const outboundNo2 = `OB${new Date().toISOString().slice(0,10).replace(/-/g,"")}-002`;
  const outboundId2 = uuidv4();
  await db.run(
    `INSERT INTO outbound_records (id, public_id, outbound_no, batch_no, inventory_id, quantity, unit, purpose, operator_name, remark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [outboundId2, outboundId2, outboundNo2, inboundBatchNo1, inventoryId, 10, "盒", "分子诊断检测", "李医生", "第二次出库", now, now]
  );
  console.log("✅ 第二次出库创建成功:", outboundNo2, "数量: 10盒, 领用人: 李医生");

  // ============================================
  // 12. 台账记录
  // ============================================
  await db.run(
    `INSERT INTO ledger (id, time, action_type, source_no, batch, material_code, material_name, qty_change, amount_change, operator, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), now, "inbound", inboundBatchNo1, inboundBatchNo1, "MAT-ACCEPT-001", "验收测试试剂盒", 20, 1000.0, "管理员", "第一次入库20盒"]
  );
  await db.run(
    `INSERT INTO ledger (id, time, action_type, source_no, batch, material_code, material_name, qty_change, amount_change, operator, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), now, "inbound", inboundBatchNo2, inboundBatchNo2, "MAT-ACCEPT-001", "验收测试试剂盒", 10, 500.0, "管理员", "第二次入库10盒"]
  );
  await db.run(
    `INSERT INTO ledger (id, time, action_type, source_no, batch, material_code, material_name, qty_change, amount_change, operator, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), now, "outbound", outboundNo1, inboundBatchNo1, "MAT-ACCEPT-001", "验收测试试剂盒", -5, -250.0, "张医生", "出库5盒"]
  );
  await db.run(
    `INSERT INTO ledger (id, time, action_type, source_no, batch, material_code, material_name, qty_change, amount_change, operator, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), now, "outbound", outboundNo2, inboundBatchNo1, "MAT-ACCEPT-001", "验收测试试剂盒", -10, -500.0, "李医生", "出库10盒"]
  );
  console.log("✅ 台账记录创建成功");

  // ============================================
  // 汇总
  // ============================================
  console.log("\n📊 验收测试数据初始化完成:");
  console.log("  ├─ 供应商: 1 家");
  console.log("  ├─ 分类: 3 级");
  console.log("  ├─ 耗材配置: 1 项");
  console.log("  ├─ 入库记录: 2 笔 (20盒 + 10盒 = 30盒)");
  console.log("  ├─ 库存总量: 30盒");
  console.log("  ├─ 检测项目: 1 个");
  console.log("  ├─ BOM项目: 1 个");
  console.log("  ├─ BOM清单: 试剂盒单例用量2盒");
  console.log("  ├─ 出库记录: 2 笔 (5盒 + 10盒 = 15盒)");
  console.log("  ├─ 预期剩余库存: 15盒");
  console.log("  └─ 台账记录: 4 笔\n");
}

seedAcceptanceData()
  .then(() => {
    console.log("🎉 数据初始化完成");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ 数据初始化失败:", error);
    process.exit(1);
  });
