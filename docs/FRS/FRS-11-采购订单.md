# FRS-11 采购订单

> **文档编号**: FRS-11  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)、[FRS-04 供应商管理](FRS-04-供应商管理.md)、[FRS-06 物料管理](FRS-06-物料管理.md)  

---

## 1. 功能概述

采购订单全生命周期管理：创建 → 收货（partial）→ 完成（completed）→ 取消（cancelled）。采购订单关联物料和供应商，入库时自动同步收货数量。

| 项目 | 说明 |
|------|------|
| **功能定位** | 采购流程核心单据 |
| **可访问角色** | `admin`/`procurement`（创建/读）；`warehouse_manager`（读） |
| **RBAC 控制** | 写：`requireRole('admin','procurement')`；读：多角色 |
| **数据规模** | 初始化 18 条采购订单 |

---

## 2. 状态机

```
                    ┌─────────────┐
                    │   pending   │
                    │   (待收货)   │
                    └──────┬──────┘
                           │ 收货（quantity < ordered）
                           ▼
                    ┌─────────────┐
     ┌─────────────│   partial   │
     │             │   (部分收货)  │
     │             └──────┬──────┘
     │                    │ 收货（quantity >= ordered）
     │                    ▼
     │             ┌─────────────┐
     │             │  completed  │
     │             │   (已完成)   │
     │             └──────┬──────┘
     │                    │
     └────────────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
       ┌─────────────┐       ┌─────────────┐
       │  cancelled  │       │  不可取消    │
       │   (已取消)   │       │  已完成订单  │
       └─────────────┘       └─────────────┘
```

### 状态说明

| 状态 | 说明 | 可执行操作 |
|------|------|----------|
| `pending` | 待收货，未入库 | 收货、取消 |
| `partial` | 部分收货 | 收货、取消 |
| `completed` | 全部收货 | 不可取消 |
| `cancelled` | 已取消 | 无 |

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/purchase-orders` | 列表（分页+状态/供应商/搜索） | 多角色 Token |
| 2 | GET | `/purchase-orders/:id` | 详情 | 多角色 Token |
| 3 | POST | `/purchase-orders` | 创建采购单 | admin/procurement Token |
| 4 | PUT | `/purchase-orders/:id/receive` | 更新收货数量 | admin/procurement Token |
| 5 | PUT | `/purchase-orders/:id/cancel` | 取消采购单 | admin/procurement Token |

---

## 4. 接口详情

### 4.1 GET /purchase-orders — 采购单列表

#### 4.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `status` | ❌ | enum | - | "pending"/"partial"/"completed" |
| `supplierId` | ❌ | string | - | 供应商筛选 |
| `keyword` | ❌ | string | - | 搜索单号/物料名称 |

#### 4.1.2 响应字段

| 字段 | 类型 | 说明 | 计算/存储 |
|------|------|------|----------|
| `id` | string | UUID | 数据库 |
| `orderNo` | string | 单号（`POyyyymmdd-xxxx`） | 自动生成 |
| `materialId` | string | 物料 ID | 数据库 |
| `materialName` | string | 物料名称 | JOIN |
| `supplierId` | string | 供应商 ID | 数据库 |
| `orderedQty` | decimal | 采购数量 | 数据库 |
| `receivedQty` | decimal | 已收货数量 | 数据库 |
| `remainingQty` | decimal | 剩余数量 | 计算字段 |
| `unit` | string | 单位 | 数据库 |
| `unitPrice` | decimal | 单价 | 数据库 |
| `totalAmount` | decimal | 总金额 | 计算字段 |
| `expectedDate` | date | 预期到货日期 | 数据库 |
| `status` | enum | "pending"/"partial"/"completed"/"cancelled" | 数据库 |
| `remark` | string | 备注 | 数据库 |

#### 4.1.3 计算字段说明

| 字段 | 公式 |
|------|------|
| `remainingQty` | `orderedQty - receivedQty`（非数据库存储，接口层计算） |
| `totalAmount` | `orderedQty × unitPrice`（创建时计算，不随单价修改更新） |

---

### 4.2 POST /purchase-orders — 创建采购单

#### 4.2.1 请求参数

| 字段 | 必填 | 类型 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|--------|---------|---------|
| `materialId` | ✅ | string | - | 非空 | "物料和采购数量必填" |
| `orderedQty` | ✅ | decimal | - | >0 | "物料和采购数量必填" |
| `materialName` | ❌ | string | '' | - | - |
| `supplierId` | ❌ | string | null | - | - |
| `unit` | ❌ | string | "个" | - | - |
| `unitPrice` | ❌ | decimal | 0 | ≥0 | - |
| `expectedDate` | ❌ | date | null | - | - |
| `remark` | ❌ | string | '' | - | - |

#### 4.2.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 生成 `orderNo` | `PO` + yyyymmdd + `-` + 4 位序号 |
| 2 | `receivedQty` = 0 | - |
| 3 | `status` = "pending" | - |
| 4 | `totalAmount` = `orderedQty × unitPrice` | - |
| 5 | INSERT | 201 |

#### 4.2.3 单号生成规则

```javascript
const prefix = 'PO' + year + month(2位) + day(2位);  // PO20260512
const seq = db.prepare("SELECT COUNT(*) as count FROM purchase_orders WHERE order_no LIKE ?").get(prefix + '%');
const orderNo = prefix + '-' + String(seq.count + 1).padStart(4, '0');  // PO20260512-0001
```

---

### 4.3 PUT /purchase-orders/:id/receive — 收货

#### 4.3.1 请求参数

| 字段 | 必填 | 类型 | 校验规则 | 错误提示 |
|------|------|------|---------|---------|
| `quantity` | ✅ | decimal | >0 | "入库数量必填" |

#### 4.3.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 查询采购单 | 404 若不存在 |
| 2 | `newReceived = receivedQty + quantity` | - |
| 3 | 校验 `newReceived <= orderedQty` | > orderedQty → 400 "入库数量超过订单数量" |
| 4 | 更新 `receivedQty` | - |
| 5 | 更新 `status` | `newReceived >= orderedQty` → "completed"，否则 → "partial" |
| 6 | 返回 200 | - |

---

### 4.4 PUT /purchase-orders/:id/cancel — 取消

#### 4.4.1 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 查询采购单 | 404 若不存在 |
| 2 | 校验 `status != 'completed'` | completed → 400 "已完成的订单不能取消" |
| 3 | `status = "cancelled"` | - |
| 4 | 返回 200 | - |

#### 4.4.2 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 取消不可逆 | 取消后不可恢复，不可重新激活 |
| 取消不影响已收货 | 已部分收货的订单取消后，已入库的数量保留 |
| 取消后仍可见 | 状态为 cancelled 的订单仍在列表中 |

---

## 5. 数据模型

```
┌─────────────────────────────────────────────────────────────┐
│                  purchase_orders                            │
├─────────────────────────────────────────────────────────────┤
│ id              TEXT PRIMARY KEY  (UUIDv4)                  │
│ order_no        TEXT NOT NULL UNIQUE                        │
│ material_id     TEXT                                        │
│ material_name   TEXT                                        │
│ supplier_id     TEXT                                        │
│ ordered_qty     DECIMAL(18,4)                               │
│ received_qty    DECIMAL(18,4) DEFAULT 0                     │
│ unit            TEXT DEFAULT '个'                            │
│ unit_price      DECIMAL(18,4) DEFAULT 0                     │
│ total_amount    DECIMAL(18,4)                               │
│ expected_date   DATE                                        │
│ status          TEXT DEFAULT 'pending'                      │
│ remark          TEXT                                        │
│ is_deleted      INTEGER DEFAULT 0                           │
│ created_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
│ updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 创建采购单 | 201，单号 PO 格式，status=pending |
| 收货（部分） | 200，status=partial，receivedQty 增加 |
| 收货（全部） | 200，status=completed |
| 收货超量 | 400 "入库数量超过订单数量" |
| 取消 pending 订单 | 200，status=cancelled |
| 取消 completed 订单 | 400 "已完成的订单不能取消" |
| 剩余数量计算 | remainingQty = orderedQty - receivedQty |
| 按状态筛选 | 正确返回匹配记录 |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
