# FRS-08 入库管理

> **文档编号**: FRS-08  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)、[FRS-11 采购订单](FRS-11-采购订单.md)  

---

## 1. 功能概述

入库单全流程管理，支持采购入库、退货入库、调拨入库三种类型。入库操作自动更新库存、管理批次、同步采购订单收货量。删除入库单时需进行级联回退校验。

| 项目 | 说明 |
|------|------|
| **功能定位** | 库存增加入口，批次创建源头 |
| **可访问角色** | `admin`/`warehouse_manager`（创建/读）；`procurement`（读） |
| **RBAC 控制** | 写：`requireRole('admin','warehouse_manager')`；读：多角色 |
| **数据规模** | 初始化 33 条入库记录 |

---

## 2. 业务流程图

### 2.1 创建入库单流程

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   创建入库   │────→│  校验必填项   │────→│  生成单号    │
│             │     │ type/materialId│     │ IB-yyyymmdd  │
│             │     │ /quantity/     │     │ -xxx         │
│             │     │ locationId     │     │              │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                        ┌───────────────────────┼───────────────────────┐
                        ▼                       ▼                       ▼
               ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
               │  关联采购订单    │     │   创建/更新批次  │     │   更新库存       │
               │  received_qty   │     │  batches表      │     │ inventory.stock │
               │  status更新     │     │  quantity       │     │  += quantity    │
               └─────────────────┘     └─────────────────┘     └─────────────────┘
                        │                       │                       │
                        └───────────────────────┼───────────────────────┘
                                                ▼
                                       ┌─────────────────┐
                                       │  写入stock_logs  │
                                       │  记录流水        │
                                       └────────┬────────┘
                                                ▼
                                       ┌─────────────────┐
                                       │   返回200+入库详情│
                                       └─────────────────┘
```

### 2.2 删除入库单流程

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   删除入库   │────→│  检查出库记录  │────→│  检查使用中   │
│             │     │  >0?         │     │  status=in-use?│
└─────────────┘     └──────────────┘     └──────┬──────┘
     │                    │ 是                   │ 是
     │                    ▼                      ▼
     │              ┌───────────┐          ┌───────────┐
     │              │ 400 不可删  │          │ 400 不可删  │
     │              │ 有出库记录  │          │ 正在使用中  │
     │              └───────────┘          └───────────┘
     │                    │ 否                   │ 否
     │                    └──────────────────────┘
     │                                       │
     │                                       ▼
     │                              ┌───────────────┐
     │                              │ 检查库存为负   │
     │                              │ 删除后<0?     │
     │                              └───────┬───────┘
     │                                      │ 是
     │                                      ▼
     │                              ┌───────────────┐
     │                              │ 400 不可删     │
     │                              │ 库存将变负数   │
     │                              └───────────────┘
     │                                      │ 否
     │                                      ▼
     └────────────────────────────►┌───────────────┐
                                   │ 回退PO/批次/库存│
                                   │ 软删除记录      │
                                   │ 写入删除流水    │
                                   └───────┬───────┘
                                           ▼
                                   ┌───────────────┐
                                   │    返回200     │
                                   └───────────────┘
```

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/inbound` | 入库列表（分页+状态+日期筛选） | 多角色 Token |
| 2 | GET | `/inbound/:id/check-deletable` | 删除前检查 | admin/warehouse_manager Token |
| 3 | POST | `/inbound` | 创建入库单 | admin/warehouse_manager Token |
| 4 | PUT | `/inbound/:id` | 编辑入库单 | admin/warehouse_manager Token |
| 5 | DELETE | `/inbound/:id` | 删除入库单 | admin/warehouse_manager Token |
| 6 | POST | `/inbound/:id/cancel` | 取消入库单 | admin/warehouse_manager Token |

---

## 4. 接口详情

### 4.1 GET /inbound — 入库列表

#### 4.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `status` | ❌ | enum | - | "completed"/"pending"/"cancelled" |
| `startDate` | ❌ | date | - | 开始日期（>= created_at） |
| `endDate` | ❌ | date | - | 结束日期（<= created_at + 23:59:59） |

#### 4.1.2 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `inboundNo` | string | 入库单号（`IB-yyyymmdd-xxx`） |
| `type` | string | 入库类型（purchase/return/transfer） |
| `materialId` | string | 物料 ID |
| `materialName` | string | 物料名称 |
| `batchNo` | string | 批号 |
| `quantity` | decimal | 数量 |
| `unit` | string | 单位 |
| `price` | decimal | 单价 |
| `amount` | decimal | 金额 = quantity × price |
| `supplierId` | string | 供应商 ID |
| `supplierName` | string | 供应商名称 |
| `locationId` | string | 库位 ID |
| `locationName` | string | 库位名称 |
| `productionDate` | date | 生产日期 |
| `expiryDate` | date | 有效期至 |
| `operator` | string | 操作人 |
| `status` | string | "completed"/"pending"/"cancelled" |
| `purchaseOrderId` | string | 关联采购单 ID |
| `purchaseOrderNo` | string | 关联采购单号 |

#### 4.1.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 日期筛选 | `endDate` 自动附加 `T23:59:59`，确保包含整天 |
| 单号格式 | `IB-` + 日期(8 位) + `-` + 3 位随机数，如 `IB-20260512-001` |
| 默认排序 | 按 `created_at DESC` |
| 仅显示未删除 | `is_deleted = 0` |

---

### 4.2 GET /inbound/:id/check-deletable — 删除前检查

#### 4.2.1 业务流程规则

| 检查项 | 条件 | 结果 |
|--------|------|------|
| 出库记录 | `SUM(outbound_items.quantity) > 0` | `canDelete=false`，原因"该批次已有出库记录 X unit" |
| 使用中 | `batch_usage_tracking.status='in-use'` | `canDelete=false`，原因"该批次库存正在使用中" |
| 库存为负 | `剩余入库 < 已出库` | `canDelete=false`，原因"删除后该批次库存将变为负数" |

#### 4.2.2 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `canDelete` | boolean | 是否可删除 |
| `reasons` | string[] | 不可删除的原因列表 |
| `record` | object | 入库记录摘要 |

---

### 4.3 POST /inbound — 创建入库单

#### 4.3.1 请求参数

| 字段 | 必填 | 类型 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|--------|---------|---------|
| `type` | ✅ | string | - | 非空 | "Missing required fields" |
| `materialId` | ✅ | string | - | 非空 | "Missing required fields" |
| `quantity` | ✅ | decimal | - | >0（建议） | "Missing required fields" |
| `locationId` | ✅ | string | - | 非空 | "Missing required fields" |
| `batchNo` | ❌ | string | null | - | - |
| `price` | ❌ | decimal | 0 | ≥0 | - |
| `supplierId` | ❌ | string | null | - | - |
| `purchaseOrderId` | ❌ | string | null | - | - |
| `productionDate` | ❌ | date | null | - | - |
| `expiryDate` | ❌ | date | null | - | - |
| `remark` | ❌ | string | null | - | - |
| `operator` | ❌ | string | "system" | - | - |

#### 4.3.2 业务流程规则（7 步）

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 生成 `inboundNo` | `IB-yyyymmdd-xxx`，3 位随机数 |
| 2 | 获取 `unit` | 自动从 `materials` 表获取 |
| 3 | 计算 `amount` | `quantity × price` |
| 4 | 设置 `status` | "completed" |
| 5 | 关联采购订单（若有） | 更新 PO 的 `received_qty` 和 `status` |
| 6 | 管理批次（若有 batchNo） | 存在则累加，不存在则创建 |
| 7 | 更新库存 | `inventory.stock += quantity` |
| 8 | 写入流水 | `stock_logs` 记录 inbound |

#### 4.3.3 采购订单状态更新规则

```
newReceived = PO.received_qty + quantity
IF newReceived >= PO.ordered_qty THEN
  PO.status = 'completed'
ELSE
  PO.status = 'partial'
```

#### 4.3.4 批次管理规则

```
IF batchNo 存在 THEN
  UPDATE batches SET quantity += quantity, remaining += quantity
ELSE
  INSERT batches (quantity = quantity, remaining = quantity, status = 1)
```

#### 4.3.5 隐含规则显式化

| 规则 | 说明 |
|------|------|
| quantity=0 未拦截 | 后端未显式拦截 `quantity=0`（边界测试已通过） |
| quantity 负数未拦截 | 后端未显式拦截负数（边界测试已通过） |
| 单位自动获取 | `unit` 不从前端传入，自动从物料表获取 |
| 金额自动计算 | `amount` 不从前端传入，由后端计算 |
| 批次可选 | `batchNo` 为空时不创建批次记录 |

---

### 4.4 DELETE /inbound/:id — 删除入库单

#### 4.4.1 业务流程规则（7 步级联）

| 步骤 | 操作 | 失败条件 |
|------|------|---------|
| 1 | 检查出库记录 | 有出库 → 400 "已有出库记录，不可删除" |
| 2 | 检查使用中 | 使用中 → 400 "正在使用中" |
| 3 | 检查库存为负 | 删除后库存<0 → 400 "库存将变为负数" |
| 4 | 回退采购订单 | `PO.received_qty -= quantity`，status 更新 |
| 5 | 扣减批次数量 | `batches.quantity -= quantity`, `remaining -= quantity` |
| 6 | 软删除入库记录 | `is_deleted = 1` |
| 7 | 记录操作日志 | `stock_logs` 写入 delete 类型流水 |

#### 4.4.2 采购订单回退规则

```
newReceived = MAX(0, PO.received_qty - quantity)
IF newReceived == 0 THEN
  PO.status = 'pending'
ELSE
  PO.status = 'partial'
```

#### 4.4.3 批次回退规则

```
batches.remaining -= quantity
IF batches.remaining <= 0 THEN
  batches.status = 0
```

#### 4.4.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 事务级联 | 步骤 4-7 应在事务中执行，确保数据一致性 |
| 删除不可逆 | 删除后仅可通过重新创建入库单恢复 |
| PO 回退下限 | `received_qty` 不会低于 0 |

---

### 4.5 POST /inbound/:id/cancel — 取消入库单

#### 4.5.1 请求参数

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `reason` | ❌ | string | - | 取消原因 |

#### 4.5.2 业务流程规则

- 仅更新 `status = "cancelled"` 和 `cancel_reason`
- **不触发库存/批次/PO 回退**

#### 4.5.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 取消≠删除 | 取消仅改状态，不扣减库存；删除会级联回退 |
| 取消后仍可见 | 状态为 cancelled 的记录仍在列表中显示 |
| 可重复取消 | 对已 cancelled 的记录再次调用不会报错 |

---

## 5. 数据模型

### 5.1 实体定义

```
┌─────────────────────────────────────────────────────────────┐
│                   inbound_records                           │
├─────────────────────────────────────────────────────────────┤
│ id                TEXT PRIMARY KEY  (UUIDv4)                │
│ inbound_no        TEXT NOT NULL                             │
│ type              TEXT  (purchase/return/transfer)          │
│ material_id       TEXT                                      │
│ batch_no          TEXT                                      │
│ quantity          DECIMAL(18,4)                             │
│ unit              TEXT                                      │
│ price             DECIMAL(18,4)                             │
│ amount            DECIMAL(18,4)                             │
│ supplier_id       TEXT                                      │
│ location_id       TEXT                                      │
│ production_date   DATE                                      │
│ expiry_date       DATE                                      │
│ operator          TEXT                                      │
│ status            TEXT  (completed/pending/cancelled)       │
│ purchase_order_id TEXT                                      │
│ remark            TEXT                                      │
│ is_deleted        INTEGER DEFAULT 0                         │
│ created_at        DATETIME DEFAULT CURRENT_TIMESTAMP        │
│ updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP        │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 创建采购入库 | 200，单号 IB 格式，库存增加，PO 状态更新 |
| 创建退货入库 | 200，type=return |
| 关联 PO 入库 | PO.received_qty 增加，status 变为 partial/completed |
| 创建带批次入库 | batches 记录创建/更新 |
| 删除有出库的入库 | 400 "已有出库记录" |
| 删除后库存回退 | inventory.stock 扣减 |
| 取消入库 | status=cancelled，库存不变 |
| 日期范围筛选 | 正确返回范围内记录 |
| 按状态筛选 | 正确返回匹配记录 |
| quantity=0 | 后端未拦截，创建成功（边界） |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
