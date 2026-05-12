# FRS-09 出库管理

> **文档编号**: FRS-09  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)、[FRS-06 物料管理](FRS-06-物料管理.md)、[FRS-13 项目管理](FRS-13-项目管理.md)  

---

## 1. 功能概述

出库单创建与查询管理，支持项目领用、调拨、报废三种类型。出库操作采用 FIFO（先进先出）批次分配策略，自动扣减库存并计算成本。出库成本按最早过期批次的入库价计算。

| 项目 | 说明 |
|------|------|
| **功能定位** | 库存减少入口，成本归集起点 |
| **可访问角色** | `admin`/`warehouse_manager`/`technician`/`pathologist`（创建/读）；`procurement` 不可创建 |
| **RBAC 控制** | 写：`requireRole('admin','warehouse_manager','technician','pathologist')`；读：多角色 |
| **数据规模** | 初始化 16 条出库记录 |

---

## 2. FIFO 批次分配策略

### 2.1 分配算法

```sql
SELECT * FROM batches 
WHERE material_id = ? 
  AND remaining > 0 
  AND status = 1 
ORDER BY expiry_date ASC 
LIMIT 1
```

### 2.2 分配规则

| 规则 | 说明 |
|------|------|
| 单批次分配 | 仅取最早一个批次，**不跨批次分配** |
| 批次不足处理 | 若该批次剩余不足所需数量，仍只分配该批次（可能导致库存负数） |
| 无批次处理 | 若该物料无活跃批次，`batchNo` 可能为 null |
| 批次耗尽标记 | 批次剩余 `<= 0` 时自动设置 `status = 0` |

---

## 3. 业务流程图

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   创建出库   │────→│  校验必填项   │────→│  校验库存    │
│             │     │ type/items   │     │ 充足性检查   │
│             │     │ 非空         │     │              │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                        ┌───────────────────────┘
                        ▼
               ┌─────────────────┐
               │  库存不足?       │
               │  stock<quantity │
               └────────┬────────┘
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
    ┌───────────────┐       ┌─────────────────┐
    │  422 拒绝      │       │  FIFO批次分配   │
    │  整单拒绝      │       │  最早过期批次   │
    │  非部分出库    │       │  unitCost=入库价│
    └───────────────┘       └────────┬────────┘
                                     │
                                     ▼
                            ┌─────────────────┐
                            │  创建出库记录    │
                            │  outbound_items │
                            └────────┬────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            ▼                        ▼                        ▼
   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
   │  扣减库存        │    │  扣减批次        │    │  记录流水        │
   │  inventory      │    │  batches        │    │  stock_logs     │
   │  stock-=qty     │    │  remaining-=qty │    │  outbound类型   │
   └─────────────────┘    └─────────────────┘    └─────────────────┘
```

---

## 4. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/outbound` | 出库列表（分页+项目/状态筛选） | 多角色 Token |
| 2 | POST | `/outbound` | 创建出库单 | 指定角色 Token |

---

## 5. 接口详情

### 5.1 GET /outbound — 出库列表

#### 5.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `projectId` | ❌ | string | - | 按项目筛选 |
| `status` | ❌ | enum | - | "completed" 等 |

#### 5.1.2 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `outboundNo` | string | 出库单号（`OB-yyyymmdd-xxx`） |
| `type` | string | 类型（project/transfer/scrap） |
| `projectId` | string | 项目 ID |
| `projectName` | string | 项目名称 |
| `items` | array | 出库明细列表 |
| `totalCost` | decimal | 总成本 |
| `operator` | string | 操作人 |
| `status` | string | "completed" |
| `remark` | string | 备注 |
| `createdAt` | datetime | 创建时间 |

#### 5.1.3 明细字段（items）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 明细 ID |
| `materialId` | string | 物料 ID |
| `materialName` | string | 物料名称 |
| `batchNo` | string | 分配的批号 |
| `quantity` | decimal | 数量 |
| `unit` | string | 单位 |
| `unitCost` | decimal | 单位成本（入库价） |
| `totalCost` | decimal | 明细成本 = quantity × unitCost |

#### 5.1.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 单号格式 | `OB-` + 日期(8 位) + `-` + 3 位随机数 |
| 仅 completed | 当前系统出库单无其他状态，创建即 completed |
| 默认排序 | 按 `created_at DESC` |

---

### 5.2 POST /outbound — 创建出库单

#### 5.2.1 请求参数

| 字段 | 必填 | 类型 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|--------|---------|---------|
| `type` | ✅ | string | - | 非空 | "Missing required fields" |
| `items` | ✅ | array | - | 非空数组 | "Missing required fields" |
| `projectId` | ❌ | string | null | - | - |
| `operator` | ❌ | string | "system" | - | - |
| `remark` | ❌ | string | null | - | - |

**items 数组元素字段**:

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `materialId` | ✅ | string | 物料 ID |
| `quantity` | ✅ | decimal | 数量 |
| `usage` | ❌ | string | 用途（self/return），默认 "self" |
| `receiver` | ❌ | string | 领用人 |

#### 5.2.2 业务流程规则（6 步）

| 步骤 | 操作 | 失败条件 |
|------|------|---------|
| 1 | 校验 `type` 和 `items` 非空 | 400 "Missing required fields" |
| 2 | 校验库存充足 | `inventory.stock < quantity` → 422 "Insufficient stock" |
| 3 | FIFO 批次分配 | 查询最早过期批次 |
| 4 | 计算成本 | `unitCost` = 批次入库价；`itemCost` = quantity × unitCost |
| 5 | 创建出库记录 | INSERT `outbound_records` + `outbound_items` |
| 6 | 扣减库存 | `inventory.stock -= quantity`；`batch.remaining -= quantity` |
| 7 | 记录流水 | `stock_logs` 写入 outbound 类型 |

#### 5.2.3 库存校验规则

```javascript
// 伪代码
for (const item of items) {
  const inventory = db.prepare("SELECT stock FROM inventory WHERE material_id = ?").get(item.materialId);
  if (!inventory || inventory.stock < item.quantity) {
    return 422("Insufficient stock");
  }
}
```

**隐含规则**: 整单校验，任一物料库存不足则整单拒绝，非部分出库。

#### 5.2.4 成本计算规则

```javascript
// 伪代码
const batch = db.prepare(
  "SELECT * FROM batches WHERE material_id = ? AND remaining > 0 AND status = 1 ORDER BY expiry_date ASC LIMIT 1"
).get(item.materialId);

const unitCost = batch ? batch.inbound_price : 0;
const itemCost = item.quantity * unitCost;
```

#### 5.2.5 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 整单拒绝 | 任一物料库存不足则整单 422 拒绝，不会部分出库 |
| FIFO 单批次 | 仅从最早过期批次取货，不跨批次合并 |
| 无批次成本为 0 | 若物料无活跃批次，`unitCost = 0` |
| 成本不反写物料 | 出库成本不影响 `materials.price` 字段 |
| 项目关联 | `type = "project"` 时建议传 `projectId`，用于成本归集 |

---

## 6. 数据模型

### 6.1 实体定义

```
┌─────────────────────────────────────────────────────────────┐
│                  outbound_records                           │
├─────────────────────────────────────────────────────────────┤
│ id            TEXT PRIMARY KEY  (UUIDv4)                    │
│ outbound_no   TEXT NOT NULL                                 │
│ type          TEXT  (project/transfer/scrap)                │
│ project_id    TEXT                                          │
│ total_cost    DECIMAL(18,4)                                 │
│ operator      TEXT                                          │
│ status        TEXT  (completed)                             │
│ remark        TEXT                                          │
│ is_deleted    INTEGER DEFAULT 0                             │
│ created_at    DATETIME DEFAULT CURRENT_TIMESTAMP            │
│ updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   outbound_items                            │
├─────────────────────────────────────────────────────────────┤
│ id              TEXT PRIMARY KEY  (UUIDv4)                  │
│ outbound_id     TEXT NOT NULL                               │
│ material_id     TEXT NOT NULL                               │
│ batch_no        TEXT                                        │
│ quantity        DECIMAL(18,4)                               │
│ unit            TEXT                                        │
│ unit_cost       DECIMAL(18,4)                               │
│ total_cost      DECIMAL(18,4)                               │
│ usage           TEXT  (self/return)                         │
│ receiver        TEXT                                        │
│ created_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. 交互细节

### 7.1 前端页面元素

| 元素 | 类型 | 说明 |
|------|------|------|
| 出库表格 | Table | 展示 outboundNo、type、projectName、totalCost、operator |
| 项目筛选 | Select | 按项目筛选出库记录 |
| 新建出库按钮 | Button | 有权限角色可见 |
| 出库弹窗 | Modal | 选择物料、数量，自动 FIFO 分配批次 |
| 成本展示 | Text | 展示 unitCost 和 totalCost |

### 7.2 异常处理矩阵

| 异常场景 | HTTP 状态 | 错误码 | 前端处理 |
|---------|----------|--------|---------|
| 必填项缺失 | 400 | `INVALID_PARAMETER` | 表单校验 |
| 库存不足 | 422 | `STOCK_INSUFFICIENT` | Dialog 提示，整单拒绝 |
| 物料不存在 | 404 | `NOT_FOUND` | 表单校验 |
| 无权限创建 | 403 | `FORBIDDEN` | 按钮隐藏/禁用 |

---

## 8. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 正常出库 | 200，库存扣减，成本计算正确 |
| 库存不足 | 422 "Insufficient stock"，整单拒绝 |
| FIFO 批次分配 | 按最早过期批次取货 |
| 多物料出库 | 每个物料独立分配批次 |
| 出库后批次耗尽 | batch.status 变为 0 |
| 项目关联出库 | projectId 正确记录 |
| 成本计算 | unitCost = 批次入库价 |
| procurement 创建出库 | 403 Forbidden |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
