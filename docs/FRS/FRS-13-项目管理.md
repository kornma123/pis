# FRS-13 项目管理

> **文档编号**: FRS-13  
> **版本**: v1.1.1
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)、[FRS-12 BOM管理](FRS-12-BOM管理.md)  

---

## 1. 功能概述

检测项目管理，用于归集检测成本、统计项目维度的耗材消耗。项目关联 BOM，通过出库单实现成本自动归集。

| 项目 | 说明 |
|------|------|
| **功能定位** | 成本归集维度之一，检测项目档案 |
| **可访问角色** | `admin`/`technician`/`pathologist`（读+写）；其他角色不可访问 |
| **RBAC 控制** | `requireRole('admin','technician','pathologist')` |
| **数据规模** | 初始化 10+ 个项目 |

---

## 2. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/projects` | 列表（分页+类型/状态/搜索） | 指定角色 Token |
| 2 | GET | `/projects/:id` | 详情（含成本统计） | 指定角色 Token |
| 3 | POST | `/projects` | 创建项目 | admin Token |
| 4 | PUT | `/projects/:id` | 编辑项目 | admin Token |
| 5 | DELETE | `/projects/:id` | 删除项目 | admin Token |

---

## 3. 接口详情

### 3.1 GET /projects — 项目列表

#### 3.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `type` | ❌ | string | - | 类型筛选（ihc/he/mp/fish/cyto/ss） |
| `status` | ❌ | enum | - | "active"/"inactive" |
| `keyword` | ❌ | string | - | 搜索 name/code |

#### 3.1.2 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `code` | string | 项目编码 |
| `name` | string | 项目名称 |
| `type` | string | 类型 |
| `cycle` | string | 检测周期 |
| `bomId` | string | 关联 BOM ID |
| `supportableSamples` | integer | 可检测样本数 |
| `status` | enum | "active"/"inactive" |
| `manager` | string | 项目负责人 |
| `description` | string | 描述 |
| `createdAt` | datetime | 创建时间 |

---

### 3.2 GET /projects/:id — 项目详情

#### 3.2.1 响应扩展字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `costStats` | object | 成本统计 |

#### 3.2.2 costStats 字段

| 字段 | 类型 | 计算公式 |
|------|------|---------|
| `totalCost` | decimal | `SUM(outbound_records.total_cost WHERE project_id = ?)` |
| `sampleCount` | integer | `COUNT(DISTINCT outbound_records.id WHERE project_id = ?)` |
| `unitCost` | decimal | `IF sampleCount > 0 THEN totalCost / sampleCount ELSE 0` |

---

### 3.3 POST /projects — 创建项目

#### 3.3.1 请求参数

| 字段 | 必填 | 类型 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|--------|---------|---------|
| `code` | ✅ | string | - | 非空，唯一 | "Code, name and type required" / "Code exists" |
| `name` | ✅ | string | - | 非空 | "Code, name and type required" |
| `type` | ✅ | string | - | 非空 | "Code, name and type required" |
| `cycle` | ❌ | string | null | - | - |
| `manager` | ❌ | string | null | - | - |
| `description` | ❌ | string | null | - | - |

#### 3.3.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 校验 `code`、`name`、`type` 非空 | 400 |
| 2 | 检查 `code` 唯一性 | 409 "Code exists" |
| 3 | `status` = 1 | - |
| 4 | INSERT | 201 |

---

### 3.4 PUT /projects/:id — 编辑项目

#### 3.4.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `code` | ❌ | string | 编码 |
| `name` | ❌ | string | 名称 |
| `type` | ❌ | string | 类型 |
| `cycle` | ❌ | string | 周期 |
| `manager` | ❌ | string | 负责人 |
| `description` | ❌ | string | 描述 |
| `status` | ❌ | enum | "active"/"inactive" |

---

### 3.5 DELETE /projects/:id — 删除项目

#### 3.5.1 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | `BEGIN IMMEDIATE` 后查询未删除项目 | 404 若不存在 |
| 2 | 锁内查询真正活引用 | 未完成/未取消且未软删的出库；未 `resolved`/`closed`/`ignored` 的成本异常 |
| 3 | 活引用存在 | 409 `ENTITY_IN_USE`，回滚且零业务写 |
| 4 | 无活引用 | UPDATE `is_deleted = 1` 后 COMMIT，返回 200 |

#### 3.5.2 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 活义务阻断 | 在途出库或未决成本异常存在时返回 409 `ENTITY_IN_USE` |
| 历史业务行放行 | completed/cancelled/已软删出库和 resolved/closed/ignored 成本异常不阻断；删除后历史行仍保留 `project_id` |
| LIS 病例不是活引用 | `lis_cases.project_id` 是历史业务记录，项目删除不阻断、不级联、不改写病例行 |
| 目录映射不是项目 FK | `code_mappings` 的 `alias_code`/`catalog_code` 仅用于别名归一化；自动生成的 `system='project_code'` 映射不阻断 typed 项目删除，也不被级联改写 |
| 未知状态 fail-closed | 出库只有 `completed`/`cancelled` 放行；成本异常只有 `resolved`/`closed`/`ignored` 放行；空值或未知值均阻断 |
| 原子性 | 查询项目、锁内查活引用、软删除写入处于同一个 `BEGIN IMMEDIATE` 事务；失败必须回滚 |

---

## 4. 数据模型

```
┌─────────────────────────────────────────────────────────────┐
│                      projects                               │
├─────────────────────────────────────────────────────────────┤
│ id                  TEXT PRIMARY KEY  (UUIDv4)              │
│ code                TEXT NOT NULL UNIQUE                    │
│ name                TEXT NOT NULL                           │
│ type                TEXT NOT NULL                           │
│ cycle               TEXT                                    │
│ bom_id              TEXT                                    │
│ supportable_samples INTEGER                                 │
│ status              INTEGER DEFAULT 1                       │
│ manager             TEXT                                    │
│ description         TEXT                                    │
│ is_deleted          INTEGER DEFAULT 0                       │
│ created_at          DATETIME DEFAULT CURRENT_TIMESTAMP      │
│ updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP      │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 获取项目列表 | 200，支持 type/status 筛选 |
| 获取项目详情 | 200，含 costStats |
| 创建项目 | 201，code 唯一 |
| 重复 code | 409 "Code exists" |
| 编辑项目 | 200 |
| 删除项目 | 200，逻辑删除 |
| 仅有 project_code 映射 | 200，项目软删除，映射行逐字段不变 |
| 仅有历史 LIS 病例 | 200，项目软删除，病例行逐字段不变 |
| 有在途出库或未决成本异常 | 409 `ENTITY_IN_USE`，项目与引用行不变 |
| 未知引用状态 | 409 `ENTITY_IN_USE`（fail-closed） |
| 成本统计 | totalCost = 该项目所有出库成本之和 |

---

*文档版本: v1.1.1*
*最后更新: 2026-07-22*
