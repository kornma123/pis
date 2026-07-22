# FRS-10 库位管理

> **文档编号**: FRS-10  
> **版本**: v1.1.1
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)  

---

## 1. 功能概述

库位档案管理，支持树形结构、区域划分、容量管理。库位是物料存放位置的物理标识，用于库存定位和存放容量控制。

| 项目 | 说明 |
|------|------|
| **功能定位** | 仓储空间主数据 |
| **可访问角色** | `admin`/`warehouse_manager`（全操作）；其他角色不可访问 |
| **RBAC 控制** | `requireRole('admin','warehouse_manager')` |
| **数据规模** | 初始化 26 个库位 |

---

## 2. 库位类型定义

| 类型 | 编码 | 说明 | 示例 |
|------|------|------|------|
| 货架 | `shelf` | 普通货架存储 | A区-01架 |
| 冷藏柜 | `refrigerator` | 低温存储（试剂） | 冷藏柜-01 |
| 危化品柜 | `cabinet` | 危化品专用柜 | 危化品柜-A |
| 房间 | `room` | 独立房间 | 常温库 |

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/locations` | 库位列表（分页+筛选） | admin/warehouse_manager Token |
| 2 | GET | `/locations/tree` | 库位树形结构 | admin/warehouse_manager Token |
| 3 | POST | `/locations` | 创建库位 | admin Token |
| 4 | PUT | `/locations/:id` | 编辑库位 | admin Token |
| 5 | DELETE | `/locations/:id` | 删除库位 | admin Token |

---

## 4. 接口详情

### 4.1 GET /locations — 库位列表

#### 4.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `zone` | ❌ | string | - | 区域筛选 |
| `type` | ❌ | string | - | 类型筛选（shelf/room/cabinet/refrigerator） |
| `status` | ❌ | enum | - | "active"/"inactive" |

#### 4.1.2 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `code` | string | 编码（`LOC-xxxxx`） |
| `name` | string | 名称 |
| `type` | string | 类型 |
| `parentId` | string | 父库位 ID |
| `zone` | string | 区域 |
| `shelf` | string | 货架 |
| `position` | string | 位置 |
| `capacity` | integer | 容量 |
| `used` | integer | 已用数量 |
| `status` | enum | "active"/"inactive" |

#### 4.1.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `used` 统计 | `used` 为存储字段，非实时计算；由入库/出库操作触发更新 |
| 容量检查 | 当前系统未在入库时校验 `used < capacity` |

---

### 4.2 GET /locations/tree — 库位树

#### 4.2.1 响应结构

```json
[
  {
    "id": "uuid",
    "code": "LOC-00001",
    "name": "A区",
    "type": "room",
    "children": [
      {
        "id": "uuid",
        "code": "LOC-00002",
        "name": "A区-01架",
        "type": "shelf",
        "children": []
      }
    ]
  }
]
```

---

### 4.3 POST /locations — 创建库位

#### 4.3.1 请求参数

| 字段 | 必填 | 类型 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|--------|---------|---------|
| `name` | ✅ | string | - | 非空 | "Name and zone required" |
| `zone` | ✅ | string | - | 非空 | "Name and zone required" |
| `type` | ❌ | string | "shelf" | shelf/room/cabinet/refrigerator | - |
| `parentId` | ❌ | string | null | - | - |
| `shelf` | ❌ | string | null | - | - |
| `position` | ❌ | string | null | - | - |
| `capacity` | ❌ | integer | 999999 | ≥0 | - |

#### 4.3.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 生成 `code` | `LOC-${String(num).padStart(5, '0')}` |
| 2 | `status` = 1 | - |
| 3 | `used` = 0 | - |
| 4 | INSERT | 201 |

#### 4.3.3 编码生成规则

```javascript
const maxNum = db.prepare("SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) as max FROM locations WHERE code LIKE 'LOC-%'").get();
const num = (maxNum.max || 0) + 1;
const code = `LOC-${String(num).padStart(5, '0')}`;  // LOC-00001
```

---

### 4.4 PUT /locations/:id — 编辑库位

#### 4.4.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `name` | ❌ | string | 名称 |
| `zone` | ❌ | string | 区域 |
| `type` | ❌ | string | 类型 |
| `shelf` | ❌ | string | 货架 |
| `position` | ❌ | string | 位置 |
| `capacity` | ❌ | integer | 容量 |
| `status` | ❌ | enum | "active"/"inactive" |

#### 4.4.2 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `used` 不可编辑 | `used` 字段不由本接口更新，由出入库操作自动维护 |
| `code` 不可修改 | 不支持修改编码 |

---

### 4.5 DELETE /locations/:id — 删除库位

#### 4.5.1 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | `BEGIN IMMEDIATE` 后查询未删除库位 | 404 若不存在 |
| 2 | 锁内查询库存与批次 | `inventory.stock > 0` 或该库位入库批次 `remaining > 0` 时返回 409 `CONFLICT` |
| 3 | 锁内查询有效分配 | 未软删物料或设备仍以该库位为 `location_id` 时返回 409 `ENTITY_IN_USE` |
| 4 | 无阻断引用 | UPDATE `is_deleted = 1` 后 COMMIT，返回 200 |

#### 4.5.2 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 既有库存合同保持 | 正库存或剩余批次继续使用 409 `CONFLICT`，不改成 `ENTITY_IN_USE` |
| 新增有效分配合同 | 生效物料/设备分配使用 409 `ENTITY_IN_USE` |
| 历史引用放行 | 软删物料、软删设备、已完成入库及剩余量为 0 的批次不阻断；历史行不级联、不改写 |
| 原子性 | 查询库位、两类锁内引用检查、软删除写入处于同一个 `BEGIN IMMEDIATE` 事务；失败必须回滚 |

---

## 5. 数据模型

```
┌─────────────────────────────────────────────────────────────┐
│                      locations                              │
├─────────────────────────────────────────────────────────────┤
│ id           TEXT PRIMARY KEY  (UUIDv4)                     │
│ code         TEXT NOT NULL UNIQUE                           │
│ name         TEXT NOT NULL                                  │
│ type         TEXT DEFAULT 'shelf'                           │
│ parent_id    TEXT                                           │
│ zone         TEXT NOT NULL                                  │
│ shelf        TEXT                                           │
│ position     TEXT                                           │
│ capacity     INTEGER DEFAULT 999999                         │
│ used         INTEGER DEFAULT 0                              │
│ status       INTEGER DEFAULT 1                              │
│ is_deleted   INTEGER DEFAULT 0                              │
│ created_at   DATETIME DEFAULT CURRENT_TIMESTAMP             │
│ updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP             │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 获取库位列表 | 200，含 code、capacity、used |
| 获取库位树 | 200，树形结构 |
| 创建库位 | 201，code 自动生成 LOC-xxxxx |
| 编辑库位 | 200，字段更新 |
| 删除库位 | 200，逻辑删除 |
| 删除仍有正库存/剩余批次的库位 | 409 `CONFLICT`，库位和库存/批次行不变 |
| 删除仍有生效物料/设备分配的库位 | 409 `ENTITY_IN_USE`，零业务写 |
| 仅历史引用 | 200，库位软删除，历史引用行不变 |
| 非授权角色访问 | 403 Forbidden |

---

*文档版本: v1.1.1*
*最后更新: 2026-07-22*
