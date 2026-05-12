# FRS-06 物料管理

> **文档编号**: FRS-06  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)、[FRS-05 物料分类](FRS-05-物料分类.md)  

---

## 1. 功能概述

物料主数据全生命周期管理，包含编码自动生成（基于分类前缀）、分类/供应商/库位关联、库存属性配置、批次追踪详情查询。物料是库存管理的核心实体。

| 项目 | 说明 |
|------|------|
| **功能定位** | 库存管理核心主数据 |
| **可访问角色** | `admin`（全操作）、`warehouse_manager`/`technician`/`pathologist`/`procurement`（读） |
| **RBAC 控制** | 写：`requireRole('admin')`；读：多角色 |
| **数据规模** | 初始化 181 个物料 |

---

## 2. 编码体系

### 2.1 编码前缀规则

物料编码前缀由所属分类的一级编码决定：

| 一级分类编码 | 前缀 | 含义 | 示例 |
|------------|------|------|------|
| 100（试剂类） | `REA` | Reagent | REA-00001 |
| 200（耗材类） | `CON` | Consumable | CON-00001 |
| 300（设备配件） | `DEV` | Device | DEV-00001 |
| 400（危化品） | `HZP` | Hazardous | HZP-00001 |

### 2.2 编码生成公式

```javascript
// 伪代码
const categoryCode = getCategoryCode(categoryId);  // 如 "101"
const prefixMap = { 1: 'REA', 2: 'CON', 3: 'DEV', 4: 'HZP' };
const prefix = prefixMap[Math.floor(parseInt(categoryCode) / 100)];

const maxNum = db.prepare(
  "SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) as max FROM materials WHERE code LIKE ?"
).get(prefix + '-%');

const num = (maxNum.max || 0) + 1;
const code = `${prefix}-${String(num).padStart(5, '0')}`;  // REA-00001
```

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/materials` | 物料列表（分页+多维筛选） | 多角色 Token |
| 2 | GET | `/materials/next-code` | 获取下一个物料编码 | admin Token |
| 3 | GET | `/materials/:id` | 详情（含批次+流水） | 多角色 Token |
| 4 | POST | `/materials` | 创建物料 | admin Token |
| 5 | PUT | `/materials/:id` | 编辑物料 | admin Token |
| 6 | DELETE | `/materials/:id` | 删除物料 | admin Token |
| 7 | PATCH | `/materials/batch-status` | 批量启停 | admin Token |

---

## 4. 接口详情

### 4.1 GET /materials — 物料列表

#### 4.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `keyword` | ❌ | string | - | 搜索 name 或 code |
| `categoryId` | ❌ | string | - | 按分类筛选 |
| `supplierId` | ❌ | string | - | 按供应商筛选 |
| `status` | ❌ | enum | - | "active"/"inactive" |

#### 4.1.2 业务流程规则

| 步骤 | 操作 | SQL 条件 |
|------|------|---------|
| 1 | 构建 WHERE | `materials.is_deleted = 0` |
| 2 | 关键词搜索 | `AND (materials.name LIKE '%?%' OR materials.code LIKE '%?%')` |
| 3 | 分类筛选 | `AND materials.category_id = ?` |
| 4 | 供应商筛选 | `AND materials.supplier_id = ?` |
| 5 | 状态筛选 | `AND materials.status = ?` |
| 6 | JOIN 关联表 | `LEFT JOIN inventory`、`LEFT JOIN categories`、`LEFT JOIN suppliers`、`LEFT JOIN locations` |
| 7 | 分页查询 | `LIMIT pageSize OFFSET (page-1)*pageSize` |

#### 4.1.3 响应字段

| 字段 | 类型 | 说明 | 来源 |
|------|------|------|------|
| `id` | string | UUID | materials |
| `code` | string | 物料编码（REA/CON/DEV/HZP） | materials |
| `name` | string | 物料名称 | materials |
| `spec` | string | 规格 | materials |
| `unit` | string | 单位 | materials |
| `specQty` | decimal | 规格数量 | materials |
| `specUnit` | string | 规格单位 | materials |
| `price` | decimal | 单价 | materials |
| `stock` | decimal | 当前库存 | inventory.stock |
| `minStock` | integer | 最低库存 | materials |
| `maxStock` | integer | 最高库存（默认 999999） | materials |
| `safetyStock` | integer | 安全库存 | materials |
| `locationId` | string | 默认库位 ID | materials |
| `locationName` | string | 库位名称 | locations.name |
| `categoryId` | string | 分类 ID | materials |
| `categoryPath` | string | 分类完整路径 | 拼接 |
| `supplierId` | string | 供应商 ID | materials |
| `supplierName` | string | 供应商名称 | suppliers.name |
| `status` | enum | "active"/"inactive" | materials |

#### 4.1.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `stock` 来源 | 列表中的 `stock` 来自 `inventory` 表的 `stock` 字段，非实时聚合计算 |
| `categoryPath` 拼接 | 格式如 `"试剂类 > HE染色 > 苏木素"`，由后端拼接三级分类名称 |
| 默认排序 | 按 `materials.created_at DESC` |
| 仅显示未删除 | `materials.is_deleted = 0` 为强制条件 |

---

### 4.2 GET /materials/next-code — 获取下一个编码

#### 4.2.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `categoryId` | ✅ | string | 分类 ID，用于确定编码前缀 |

#### 4.2.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 查询分类 code | 404 若分类不存在 |
| 2 | 计算前缀：`floor(code / 100)` → REA/CON/DEV/HZP | - |
| 3 | 查询该前缀最大编号 +1 | - |
| 4 | 返回建议编码 | 200 |

#### 4.2.3 响应示例

```json
{
  "success": true,
  "data": {
    "code": "REA-00182",
    "prefix": "REA"
  }
}
```

---

### 4.3 GET /materials/:id — 物料详情

#### 4.3.1 响应扩展字段

在列表字段基础上增加：

| 字段 | 类型 | 说明 |
|------|------|------|
| `batches` | array | 活跃批次列表（status=1，按 expiry_date 升序） |
| `stockLogs` | array | 最近 20 条库存流水 |

#### 4.3.2 批次字段（batches）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 批次 ID |
| `batchNo` | string | 批号 |
| `quantity` | decimal | 入库数量 |
| `remaining` | decimal | 剩余数量 |
| `productionDate` | date | 生产日期 |
| `expiryDate` | date | 有效期至 |
| `inboundId` | string | 关联入库单 ID |
| `status` | integer | 1=活跃，0=耗尽 |

#### 4.3.3 流水字段（stockLogs）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 流水 ID |
| `type` | string | 类型（inbound/outbound/return/scrap/adjust） |
| `quantity` | decimal | 数量 |
| `balance` | decimal | 操作后余额 |
| `referenceNo` | string | 关联单号 |
| `operator` | string | 操作人 |
| `createdAt` | datetime | 操作时间 |

#### 4.3.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 批次排序 | 按 `expiry_date ASC` 升序排列，最早过期的批次在前（FIFO 基础） |
| 仅活跃批次 | 仅返回 `status = 1` 的批次，已耗尽（status=0）的批次不展示 |
| 流水限制 | 仅返回最近 20 条流水记录，非全量 |
| 详情级联查询 | 单次请求触发多次查询（物料 + 批次 + 流水），响应时间较长 |

---

### 4.4 POST /materials — 创建物料

#### 4.4.1 请求参数

| 字段 | 必填 | 类型 | 长度限制 | 格式 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|---------|------|--------|---------|---------|
| `name` | ✅ | string | 1-200 | 非空 | - | 非空 | "Name, unit and category required" |
| `unit` | ✅ | string | 1-50 | 非空 | - | 非空 | "Name, unit and category required" |
| `categoryId` | ✅ | string | - | UUID | - | 非空 | "Name, unit and category required" |
| `code` | ❌ | string | - | PREFIX-xxxxx | 自动生成 | 唯一性 | "Code already exists" |
| `spec` | ❌ | string | - | - | null | - | - |
| `specQty` | ❌ | decimal | - | ≥0 | 0 | - | - |
| `specUnit` | ❌ | string | - | - | null | - | - |
| `supplierId` | ❌ | string | - | UUID | null | - | - |
| `price` | ❌ | decimal | - | ≥0 | 0 | - | - |
| `minStock` | ❌ | integer | - | ≥0 | 0 | - | - |
| `maxStock` | ❌ | integer | - | ≥0 | 999999 | - | - |
| `safetyStock` | ❌ | integer | - | ≥0 | 0 | - | - |
| `locationId` | ❌ | string | - | UUID | null | - | - |
| `remark` | ❌ | string | - | - | null | - | - |

#### 4.4.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 校验 `name`、`unit`、`categoryId` 非空 | 400 "Name, unit and category required" |
| 2 | 若传 `code` → 校验唯一性 | 冲突 → 409 "Code already exists" |
| 3 | 若未传 `code` → 按分类自动生成 | - |
| 4 | `status` = 1 | - |
| 5 | INSERT materials | - |
| 6 | 自动创建 inventory 记录：`stock = 0`, `locked_stock = 0` | - |
| 7 | 返回 201 + 新物料 ID | - |

#### 4.4.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `price` 允许为 0 | `price = 0` 是合法的（边界测试已通过） |
| `price` 负数未拦截 | 后端未显式校验 `price >= 0`，但前端应限制 |
| 自动创建 inventory | 创建物料后立即有一条 `inventory` 记录（`stock=0`），即使从未入库 |
| 编码自定义 | 支持传入自定义 `code`，但须符合前缀规则且全局唯一 |
| 供应商不校验存在性 | `supplierId` 不校验是否在 `suppliers` 表中存在 |

---

### 4.5 PUT /materials/:id — 编辑物料

#### 4.5.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `code` | ❌ | string | 编码 |
| `name` | ❌ | string | 名称 |
| `spec` | ❌ | string | 规格 |
| `unit` | ❌ | string | 单位 |
| `specQty` | ❌ | decimal | 规格数量 |
| `specUnit` | ❌ | string | 规格单位 |
| `categoryId` | ❌ | string | 分类 |
| `supplierId` | ❌ | string | 供应商 |
| `price` | ❌ | decimal | 单价 |
| `minStock` | ❌ | integer | 最低库存 |
| `maxStock` | ❌ | integer | 最高库存 |
| `safetyStock` | ❌ | integer | 安全库存 |
| `locationId` | ❌ | string | 库位 |
| `remark` | ❌ | string | 备注 |
| `status` | ❌ | enum | "active"/"inactive" |

#### 4.5.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 查询物料是否存在 | 404 若不存在 |
| 2 | 仅更新传入字段 | PATCH 语义 |
| 3 | `updated_at` 自动刷新 | - |
| 4 | 返回 200 + `{id}` | - |

#### 4.5.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 编码可修改 | 支持修改 `code`，但须保证唯一性；修改后历史单据中的物料编码不会同步更新 |
| 分类可修改 | 支持修改 `categoryId`，但编码前缀不会自动更新（编码与分类前缀无强绑定） |

---

### 4.6 DELETE /materials/:id — 删除物料

#### 4.6.1 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 查询物料是否存在 | 404 若不存在 |
| 2 | 检查 `inventory.stock > 0` | >0 → 409 "Stock exists" |
| 3 | UPDATE `materials.is_deleted = 1` | 逻辑删除 |
| 4 | 返回 200 | - |

#### 4.6.2 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 仅检查 stock | 仅检查 `inventory.stock`，不检查 `inventory.locked_stock` |
| 历史记录保留 | 删除后，该物料的历史入库/出库/盘点记录仍然保留（通过 `material_id` 关联） |
| 批次不清理 | 关联的 `batches` 记录不删除，成为历史数据 |

---

### 4.7 PATCH /materials/batch-status — 批量启停

#### 4.7.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `ids` | ✅ | string[] | 物料 ID 数组，至少 1 个元素 |
| `status` | ✅ | enum | "active"/"inactive" |

#### 4.7.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 校验 `ids` 非空数组 | 400 若为空 |
| 2 | 校验 `status` 有效值 | 400 若无效 |
| 3 | 事务批量更新 | `UPDATE materials SET status = ? WHERE id IN (?)` |
| 4 | 返回 200 + 影响行数 | - |

#### 4.7.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 原子操作 | 使用数据库事务，全部成功或全部失败 |
| 不检查库存 | 即使物料有库存，也可批量禁用 |
| 影响范围 | 仅更新 `status` 字段，不影响其他数据 |

---

## 5. 数据模型

### 5.1 实体定义

```
┌─────────────────────────────────────────────────────────────┐
│                      materials                              │
├─────────────────────────────────────────────────────────────┤
│ id              TEXT PRIMARY KEY  (UUIDv4)                  │
│ code            TEXT NOT NULL UNIQUE                        │
│ name            TEXT NOT NULL                               │
│ spec            TEXT                                        │
│ unit            TEXT NOT NULL                               │
│ spec_qty        DECIMAL(18,4) DEFAULT 0                     │
│ spec_unit       TEXT                                        │
│ category_id     TEXT                                        │
│ supplier_id     TEXT                                        │
│ price           DECIMAL(18,4) DEFAULT 0                     │
│ min_stock       INTEGER DEFAULT 0                           │
│ max_stock       INTEGER DEFAULT 999999                      │
│ safety_stock    INTEGER DEFAULT 0                           │
│ location_id     TEXT                                        │
│ remark          TEXT                                        │
│ status          INTEGER DEFAULT 1                           │
│ is_deleted      INTEGER DEFAULT 0                           │
│ created_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
│ updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 关联关系

```
materials
├── categories (category_id)
├── suppliers (supplier_id)
├── locations (location_id)
├── inventory (material_id, 1:1)
├── batches (material_id, 1:N)
├── inbound_records (material_id, 1:N)
├── outbound_items (material_id, 1:N)
└── bom_items (material_id, 1:N)
```

---

## 6. 交互细节

### 6.1 前端页面元素

| 元素 | 类型 | 说明 |
|------|------|------|
| 物料表格 | Table | 展示 code、name、spec、stock、price、status |
| 搜索框 | Input | 模糊搜索 name/code |
| 筛选栏 | Select×3 | 分类/供应商/状态筛选 |
| 新建物料按钮 | Button | admin 可见 |
| 批量操作 | Dropdown | 批量启用/禁用 |
| 详情抽屉 | Drawer | 展示批次和流水 |

### 6.2 异常处理矩阵

| 异常场景 | HTTP 状态 | 错误码 | 前端处理 |
|---------|----------|--------|---------|
| 必填项缺失 | 400 | `INVALID_PARAMETER` | 表单校验 |
| code 已存在 | 409 | `RESOURCE_CONFLICT` | 字段错误 |
| 删除时有库存 | 409 | `BUSINESS_RULE` | Dialog 提示 |
| 物料不存在 | 404 | `NOT_FOUND` | Toast |

---

## 7. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 获取物料列表 | 200，含 stock、categoryPath、supplierName |
| 按分类筛选 | 200，仅返回该分类物料 |
| 按供应商筛选 | 200，仅返回该供应商物料 |
| 搜索物料 | 200，匹配 name/code |
| 创建物料 | 201，自动生成编码，创建 inventory 记录 |
| 传入自定义 code | 201，使用传入 code |
| 创建重复 code | 409 "Code already exists" |
| 价格=0 | 创建成功 |
| 删除有库存物料 | 409 "Stock exists" |
| 批量禁用 | 200，status 变为 "inactive" |
| 获取物料详情 | 200，含 batches（按效期升序）和 stockLogs |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
