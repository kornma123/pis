# FRS-12 BOM 管理

> **文档编号**: FRS-12  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)、[FRS-06 物料管理](FRS-06-物料管理.md)  

---

## 1. 功能概述

检测项目的 BOM（物料清单）管理，支持版本自动递增、物料明细配置、成本占比计算。BOM 定义了每个检测项目所需耗材及其用量，用于成本估算和出库指导。

| 项目 | 说明 |
|------|------|
| **功能定位** | 检测项目耗材配置，成本估算基础 |
| **可访问角色** | `admin`/`technician`/`pathologist`（读）；`admin`（创建/编辑/删除） |
| **RBAC 控制** | 写：`requireRole('admin')`；读：多角色 |
| **数据规模** | 初始化 113 条 BOM |

---

## 2. 检测类型定义

| 类型编码 | 类型名称 | 说明 |
|---------|---------|------|
| `ihc` | 免疫组化 | 最常见，96+ 种抗体 |
| `he` | HE 染色 | 常规染色 |
| `mp` | 特殊染色 | Masson 等 |
| `fish` | FISH 检测 | 荧光原位杂交 |
| `cyto` | 细胞学 | 细胞学检测 |
| `ss` | 特殊染色 | 其他特殊染色 |

---

## 3. 版本控制规则

### 3.1 版本递增算法

```javascript
// 伪代码
const version = existing.version;  // "v1.0"
const parts = version.replace('v', '').split('.').map(Number);  // [1, 0]
parts[1] += 1;  // [1, 1]
const newVersion = 'v' + parts[0] + '.' + parts[1];  // "v1.1"
```

| 操作 | 版本变化 | 说明 |
|------|---------|------|
| 创建 | `v1.0` | 固定初始版本 |
| 第 1 次编辑 | `v1.0` → `v1.1` | 次版本 +1 |
| 第 2 次编辑 | `v1.1` → `v1.2` | 次版本 +1 |
| 第 N 次编辑 | `v1.N` | 次版本持续 +1 |

**隐含规则**: 主版本号（parts[0]）永远不会自动增加，仅次版本号自动递增。

---

## 4. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/boms` | BOM 列表（分页+类型筛选） | 多角色 Token |
| 2 | GET | `/boms/:id` | 详情（含物料明细+成本占比） | 多角色 Token |
| 3 | POST | `/boms` | 创建 BOM | admin Token |
| 4 | PUT | `/boms/:id` | 编辑 BOM（自动升级版本） | admin Token |
| 5 | DELETE | `/boms/:id` | 删除 BOM | admin Token |

---

## 5. 接口详情

### 5.1 GET /boms — BOM 列表

#### 5.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `type` | ❌ | string | - | 类型筛选（ihc/he/mp/fish/cyto/ss） |

#### 5.1.2 响应字段

| 字段 | 类型 | 说明 | 特殊处理 |
|------|------|------|---------|
| `id` | string | UUID | - |
| `code` | string | BOM 编码 | - |
| `name` | string | 名称 | - |
| `version` | string | 版本号（`v1.0` 格式） | - |
| `type` | string | 检测类型 | - |
| `serviceId` | string | 服务项目 ID | - |
| `materialCount` | integer | 物料数量 | **固定返回 0**，需前端统计 |
| `supportableSamples` | integer | 可检测样本数 | - |
| `unitCost` | decimal | 单位成本 | - |
| `status` | enum | "active"/"inactive" | - |

#### 5.1.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `materialCount` 未实现 | 后端未实现 JOIN 统计，固定返回 0；前端需自行根据详情统计 |

---

### 5.2 GET /boms/:id — BOM 详情

#### 5.2.1 响应扩展字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `materials` | array | 物料明细列表 |
| `versionHistory` | array | 版本历史（仅当前一条） |

#### 5.2.2 物料明细字段

| 字段 | 类型 | 说明 | 计算方式 |
|------|------|------|---------|
| `id` | string | 物料 ID | - |
| `name` | string | 物料名称 | - |
| `spec` | string | 规格 | - |
| `usagePerSample` | decimal | 每样本用量 | 用户配置 |
| `unit` | string | 单位 | - |
| `price` | decimal | 单价 | 物料表 |
| `stock` | decimal | 当前库存 | 库存表 |
| `costRatio` | decimal | 成本占比 | `(price × usagePerSample) / totalCost` |

#### 5.2.3 成本计算规则

```
totalCost = Σ(materials.price × materials.usagePerSample)
material.costRatio = (material.price × material.usagePerSample) / totalCost
```

---

### 5.3 POST /boms — 创建 BOM

#### 5.3.1 请求参数

| 字段 | 必填 | 类型 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|--------|---------|---------|
| `code` | ✅ | string | - | 非空 | "Missing required fields" |
| `name` | ✅ | string | - | 非空 | "Missing required fields" |
| `type` | ✅ | string | - | 非空 | "Missing required fields" |
| `materials` | ✅ | array | - | 非空数组 | "Missing required fields" |
| `serviceId` | ❌ | string | null | - | - |
| `description` | ❌ | string | null | - | - |
| `supportableSamples` | ❌ | integer | null | - | - |

**materials 元素字段**:

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `materialId` | ✅ | string | 物料 ID |
| `usagePerSample` | ✅ | decimal | 每样本用量 |
| `unit` | ✅ | string | 单位 |

#### 5.3.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 校验必填项 | 400 |
| 2 | `version` = "v1.0" | - |
| 3 | `status` = 1 | - |
| 4 | INSERT bom | - |
| 5 | 逐条 INSERT bom_items | - |
| 6 | `(code, version)` 联合唯一冲突 | 409 "Code version exists" |

---

### 5.4 PUT /boms/:id — 编辑 BOM

#### 5.4.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `name` | ❌ | string | 名称 |
| `description` | ❌ | string | 描述 |
| `supportableSamples` | ❌ | integer | 可检测样本数 |
| `materials` | ❌ | array | 物料列表（传则全量替换） |

#### 5.4.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 查询 BOM | 404 若不存在 |
| 2 | 版本自动 +0.1 | `v1.0` → `v1.1` |
| 3 | 若传 `materials` | DELETE 所有 bom_items，再 INSERT 新列表（全量替换） |
| 4 | 未传 `materials` | 仅更新基础字段 |
| 5 | 返回 200 | - |

#### 5.4.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 全量替换 | 编辑时若传 `materials`，先删除所有原明细再插入新明细，非增量更新 |
| 版本不可逆 | 版本只能递增，不能回退 |
| 历史版本不保留 | 系统不保存历史版本的明细数据，仅当前版本有效 |

---

## 6. 数据模型

```
┌─────────────────────────────────────────────────────────────┐
│                        boms                                 │
├─────────────────────────────────────────────────────────────┤
│ id                  TEXT PRIMARY KEY  (UUIDv4)              │
│ code                TEXT NOT NULL                           │
│ name                TEXT NOT NULL                           │
│ version             TEXT NOT NULL                           │
│ type                TEXT NOT NULL                           │
│ service_id          TEXT                                    │
│ description         TEXT                                    │
│ supportable_samples INTEGER                                 │
│ unit_cost           DECIMAL(18,4)                           │
│ status              INTEGER DEFAULT 1                       │
│ is_deleted          INTEGER DEFAULT 0                       │
│ created_at          DATETIME DEFAULT CURRENT_TIMESTAMP      │
│ updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     bom_items                               │
├─────────────────────────────────────────────────────────────┤
│ id              TEXT PRIMARY KEY  (UUIDv4)                  │
│ bom_id          TEXT NOT NULL                               │
│ material_id     TEXT NOT NULL                               │
│ usage_per_sample DECIMAL(18,4)                              │
│ unit            TEXT                                        │
│ created_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 获取 BOM 列表 | 200，含 type 筛选 |
| 获取 BOM 详情 | 200，含 materials 和 costRatio |
| 创建 BOM | 201，version=v1.0 |
| 创建重复(code,version) | 409 "Code version exists" |
| 编辑 BOM | version 自动升级 v1.0→v1.1 |
| 编辑替换物料 | 全量替换，非增量 |
| 删除 BOM | 200，逻辑删除 |
| materialCount | 固定返回 0 |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
