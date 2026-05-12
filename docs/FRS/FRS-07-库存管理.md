# FRS-07 库存管理

> **文档编号**: FRS-07  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)、[FRS-06 物料管理](FRS-06-物料管理.md)  

---

## 1. 功能概述

库存实时查询与统计模块。库存数据基于入库记录聚合计算，支持按批次维度展示、多状态筛选、库存统计看板。库存状态动态计算，优先级：过期 > 临期 > 低库存 > 正常。

| 项目 | 说明 |
|------|------|
| **功能定位** | 库存实时查询与监控 |
| **可访问角色** | `admin`/`warehouse_manager`/`technician`/`pathologist`/`procurement`（读）；`finance` 不可访问 |
| **RBAC 控制** | `requireRole('admin','warehouse_manager','technician','pathologist','procurement')` |
| **数据特点** | 实时聚合计算，非物理库存表直接查询 |

---

## 2. 核心计算逻辑

### 2.1 库存聚合查询

```sql
SELECT 
  material_id,
  batch_no,
  SUM(quantity) as stock,
  location_id,
  MAX(expiry_date) as expiry
FROM inbound_records
WHERE status = 'completed' 
  AND is_deleted = 0
GROUP BY material_id, batch_no, location_id
```

### 2.2 状态计算优先级

状态按以下优先级降序判断（一旦满足某条件即返回对应状态）：

| 优先级 | 条件 | 状态 | 颜色/标签 |
|--------|------|------|----------|
| 1 | `stock <= 0` | `out-of-stock` | 红色/缺货 |
| 2 | `expiry <= today` | `expired` | 深红/已过期 |
| 3 | `expiry <= today + 30天` | `warning` | 橙色/临期 |
| 4 | `stock <= minStock` AND `minStock > 0` | `low-stock` | 黄色/低库存 |
| 5 | 以上都不满足 | `normal` | 绿色/正常 |

**隐含规则**: `out-of-stock` 和 `expired` 可能同时满足，按优先级 `expired` > `out-of-stock`；但实际判断顺序中 `stock <= 0` 排在最前，所以 `stock=0` 时优先显示 `out-of-stock`。

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/inventory` | 库存列表（按批次聚合） | 指定角色 Token |
| 2 | GET | `/inventory/stats` | 库存统计看板 | 指定角色 Token |

---

## 4. 接口详情

### 4.1 GET /inventory — 库存列表

#### 4.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `keyword` | ❌ | string | - | 搜索 name/code |
| `categoryId` | ❌ | string | - | 分类筛选 |
| `locationId` | ❌ | string | - | 库位筛选 |
| `status` | ❌ | enum | - | "low-stock" 低库存筛选 |

#### 4.1.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 聚合查询入库记录 | 按 `material_id + batch_no + location_id` 分组 |
| 2 | 关联物料表 | JOIN materials 获取名称、规格、单位、库存阈值 |
| 3 | 关联库位表 | JOIN locations 获取库位名称 |
| 4 | 关联供应商表 | JOIN suppliers 获取供应商名称 |
| 5 | 应用筛选条件 | keyword/categoryId/locationId/status |
| 6 | 计算状态 | 按优先级规则计算每条记录的状态 |
| 7 | 分页返回 | LIMIT/OFFSET |

#### 4.1.3 响应字段

| 字段 | 类型 | 说明 | 计算方式 |
|------|------|------|---------|
| `id` | string | 合成 ID：`INV-${material_id}-${batch_no}` | 后端拼接 |
| `materialId` | string | 物料 ID | 入库记录 |
| `code` | string | 物料编码 | 物料表 |
| `name` | string | 物料名称 | 物料表 |
| `spec` | string | 规格 | 物料表 |
| `unit` | string | 单位 | 物料表 |
| `stock` | decimal | 库存数量 | `SUM(inbound.quantity)` |
| `minStock` | integer | 最低库存 | 物料表 |
| `maxStock` | integer | 最高库存 | 物料表 |
| `availableStock` | decimal | 可用库存 | `= stock`（无锁定概念） |
| `locationId` | string | 库位 ID | 入库记录 |
| `locationName` | string | 库位名称 | 库位表 |
| `supplierId` | string | 供应商 ID | 物料表 |
| `supplierName` | string | 供应商名称 | 供应商表 |
| `status` | enum | 动态计算状态 | 优先级规则 |
| `batch` | string | 批号 | 入库记录 |
| `expiry` | date | 有效期 | `MAX(expiry_date)` |

#### 4.1.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 库存数据来源 | 基于 `inbound_records` 聚合，非 `inventory` 表直接查询；`inventory` 表仅用于快速库存扣减 |
| 批次合并规则 | 同物料 + 同批号 + 同库位合并为一条记录 |
| 有效期取最大 | `expiry` 取该批次所有入库记录中的最大有效期 |
| `availableStock` | 当前等于 `stock`，系统无库存锁定机制 |
| 缺货优先 | `stock <= 0` 时状态为 `out-of-stock`，即使未设置 `minStock` |

---

### 4.2 GET /inventory/stats — 库存统计看板

#### 4.2.1 响应字段

| 字段 | 类型 | 计算公式 |
|------|------|---------|
| `totalMaterials` | integer | `COUNT(*) FROM materials WHERE is_deleted = 0` |
| `totalStockValue` | decimal | `SUM(inbound.quantity × material.price)` |
| `totalStockCount` | integer | 有库存的批次数（`stock > 0`） |
| `normalCount` | integer | 正常状态批次数 |
| `lowStockCount` | integer | 低库存批次数 |
| `expiringCount` | integer | 临期批次数（30 天内过期） |
| `expiredCount` | integer | 已过期批次数 |
| `categoryDistribution` | array | 一级分类物料分布（饼图数据） |

#### 4.2.2 状态统计公式

```
normal     = stock > min_stock AND (expiry IS NULL OR expiry > today+30days)
low_stock  = min_stock > 0 AND stock <= min_stock
expiring   = expiry IS NOT NULL AND expiry <= today+30days AND expiry > today
expired    = expiry IS NOT NULL AND expiry <= today
```

#### 4.2.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 按批次统计 | 统计维度为批次，非物料；同物料多批次分别计数 |
| `totalStockValue` 计算 | 基于入库数量 × 当前物料单价，非实际出库成本 |
| `categoryDistribution` | 按一级分类聚合物料数量，展示占比 |
| 缺货不单独统计 | `out-of-stock` 批次数隐含在 `totalStockCount` 之外（stock=0 不计入有库存批次） |

---

## 5. 数据模型

### 5.1 库存计算依赖关系

```
inventory (聚合视图)
├── inbound_records (GROUP BY material_id, batch_no, location_id)
│   └── SUM(quantity) as stock
├── materials (JOIN 名称、规格、阈值)
├── locations (JOIN 库位名称)
└── suppliers (JOIN 供应商名称)
```

### 5.2 inventory 表结构

```
┌─────────────────────────────────────────────────────────────┐
│                      inventory                              │
├─────────────────────────────────────────────────────────────┤
│ id              TEXT PRIMARY KEY  (UUIDv4)                  │
│ material_id     TEXT NOT NULL UNIQUE                        │
│ stock           DECIMAL(18,4) DEFAULT 0                     │
│ locked_stock    DECIMAL(18,4) DEFAULT 0                     │
│ location_id     TEXT                                        │
│ status          INTEGER DEFAULT 1                           │
│ created_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
│ updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
└─────────────────────────────────────────────────────────────┘
```

**注意**: `inventory` 表的 `stock` 字段是快速缓存字段，真实库存以 `inbound_records` 聚合为准。

---

## 6. 交互细节

### 6.1 前端页面元素

| 元素 | 类型 | 说明 |
|------|------|------|
| 库存表格 | Table | 展示 code、name、batch、stock、status、expiry |
| 状态标签 | Tag | 按状态显示不同颜色：normal(绿)、low-stock(黄)、warning(橙)、expired(红)、out-of-stock(灰) |
| 统计卡片 | Card×6 | 总物料、总库存值、正常、低库存、临期、过期 |
| 筛选栏 | Select×3 | 分类/库位/状态筛选 |
| 搜索框 | Input | 搜索 name/code |
| 分类分布图 | PieChart | categoryDistribution 数据可视化 |

### 6.2 异常处理矩阵

| 异常场景 | HTTP 状态 | 错误码 | 前端处理 |
|---------|----------|--------|---------|
| 无权限（finance） | 403 | `FORBIDDEN` | 跳转 403 |
| Token 过期 | 401 | `UNAUTHORIZED` | 自动刷新 |

---

## 7. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 获取库存列表 | 200，按批次聚合，含动态 status |
| 低库存筛选 | 200，仅返回 `status=low-stock` |
| 按分类筛选 | 200，返回该分类下所有批次 |
| 按库位筛选 | 200，返回该库位下所有批次 |
| 库存统计 | 200，各状态计数正确 |
| 过期物料状态 | 过期物料 `status=expired` |
| 临期物料状态 | 30 天内过期 `status=warning` |
| 库存=0 状态 | `status=out-of-stock` |
| finance 访问 | 403 Forbidden |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
