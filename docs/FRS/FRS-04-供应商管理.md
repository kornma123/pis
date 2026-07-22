# FRS-04 供应商管理

> **文档编号**: FRS-04  
> **版本**: v1.1.1
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)  

---

## 1. 功能概述

供应商档案的增删改查管理，包括供应商编码自动生成、联系信息、评级、合作统计等。供应商是采购订单和物料管理的基础数据。

| 项目 | 说明 |
|------|------|
| **功能定位** | 采购主数据，支撑采购订单和物料供应商关联 |
| **可访问角色** | `admin`（全操作）、`warehouse_manager`（读）、`procurement`（读） |
| **RBAC 控制** | `requireRole('admin', 'warehouse_manager', 'procurement')` |
| **数据规模** | 10+ 供应商（初始化数据） |

---

## 2. 业务流程图

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   创建供应商 │────→│  校验name    │────→│   code      │
│  (admin)    │     │   非空       │     │  自动生成    │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                        ┌───────────────────────┘
                        ▼
               ┌─────────────────┐
               │  SUP-xxxxx格式  │
               │  5位数字补零    │
               └────────┬────────┘
                        ▼
               ┌─────────────────┐
               │ cooperation=0   │
               │ totalAmount=0   │
               │ rating=5        │
               │ status=1        │
               └────────┬────────┘
                        ▼
               ┌─────────────────┐
               │   返回201+供应商ID │
               └─────────────────┘
```

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/suppliers` | 供应商列表（分页+搜索+状态筛选） | admin/warehouse_manager/procurement Token |
| 2 | POST | `/suppliers` | 创建供应商 | admin Token |
| 3 | PUT | `/suppliers/:id` | 编辑供应商 | admin Token |
| 4 | DELETE | `/suppliers/:id` | 删除供应商 | admin Token |

---

## 4. 接口详情

### 4.1 GET /suppliers — 供应商列表

#### 4.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 | 校验规则 |
|------|------|------|--------|------|---------|
| `page` | ❌ | integer | 1 | 页码 | ≥1 |
| `pageSize` | ❌ | integer | 20 | 每页条数 | ≥1，≤1000 |
| `keyword` | ❌ | string | - | 搜索关键词 | 模糊匹配 name 或 code |
| `status` | ❌ | enum | - | 状态筛选 | "active"/"inactive" |

#### 4.1.2 业务流程规则

| 步骤 | 操作 | SQL 条件 |
|------|------|---------|
| 1 | 构建 WHERE | `is_deleted = 0` |
| 2 | 状态筛选 | `AND status = ?`（1 或 0） |
| 3 | 关键词搜索 | `AND (name LIKE '%?%' OR code LIKE '%?%')` |
| 4 | 分页查询 | `LIMIT pageSize OFFSET (page-1)*pageSize` |
| 5 | 统计总数 | `SELECT COUNT(*) ...` |
| 6 | 字段映射 | `status` 1→"active"，0→"inactive" |

#### 4.1.3 响应字段

| 字段 | 类型 | 说明 | 来源 |
|------|------|------|------|
| `id` | string | UUID | 数据库 |
| `code` | string | 供应商编码（`SUP-xxxxx` 格式） | 自动生成 |
| `name` | string | 供应商名称 | 用户输入 |
| `contact` | string | 联系人姓名 | 用户输入 |
| `phone` | string | 联系电话 | 用户输入 |
| `email` | string | 联系邮箱 | 用户输入 |
| `address` | string | 地址 | 用户输入 |
| `status` | enum | "active"/"inactive" | 状态映射 |
| `cooperationCount` | integer | 合作次数 | 统计字段 |
| `totalAmount` | decimal | 累计采购金额 | 统计字段 |
| `rating` | integer | 评级（1-5） | 默认 5 |

#### 4.1.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 统计字段来源 | `cooperationCount` 和 `totalAmount` 为供应商表中的存储字段，非实时计算；由入库操作触发更新 |
| 搜索范围 | 仅搜索 `name` 和 `code`，不搜索 contact/phone/address |
| 排序规则 | 默认按 `created_at DESC`（最新创建在前） |

---

### 4.2 POST /suppliers — 创建供应商

#### 4.2.1 请求参数

| 字段 | 必填 | 类型 | 长度限制 | 格式 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|---------|------|--------|---------|---------|
| `name` | ✅ | string | 1-100 | 非空字符串 | - | 非空 | "Name required" |
| `contact` | ❌ | string | - | - | null | - | - |
| `phone` | ❌ | string | - | - | null | - | - |
| `email` | ❌ | string | - | 邮箱格式 | null | - | - |
| `address` | ❌ | string | - | - | null | - | - |

#### 4.2.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 校验 `name` 非空 | 400 "Name required" |
| 2 | 生成编码：`SUP-${String(num).padStart(5, '0')}` | - |
| 3 | `num` = `MAX(CAST(SUBSTR(code, 5) AS INTEGER)) + 1` | - |
| 4 | `status` = 1 | - |
| 5 | `cooperationCount` = 0 | - |
| 6 | `totalAmount` = 0 | - |
| 7 | `rating` = 5 | - |
| 8 | INSERT 并返回新供应商 ID | 201 |

#### 4.2.3 编码生成规则详解

```javascript
// 伪代码
const prefix = 'SUP-';
const rows = db.prepare("SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) as maxNum FROM suppliers WHERE code LIKE 'SUP-%'").get();
const num = (rows.maxNum || 0) + 1;
const code = `SUP-${String(num).padStart(5, '0')}`;  // SUP-00001, SUP-00002...
```

| 规则项 | 说明 |
|--------|------|
| 提取逻辑 | `SUBSTR(code, 5)` 提取 "SUP-" 后的数字部分 |
| 最大值计算 | `MAX(CAST(... AS INTEGER))` 取最大序号 |
| 补零规则 | 5 位数字，不足前补零 |
| 冲突处理 | code 唯一性冲突 → 409 "Code exists" |

#### 4.2.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 编码不可自定义 | 创建时不支持传入 `code` 参数，必须由系统生成 |
| 编码唯一性 | 编码在 `is_deleted = 0` 范围内唯一，已删除供应商的编码可被复用 |
| 评级默认 5 星 | 新供应商默认最高评级，后续可手动调整 |
| 合作统计归零 | 新供应商 `cooperationCount` 和 `totalAmount` 均为 0 |

---

### 4.3 PUT /suppliers/:id — 编辑供应商

#### 4.3.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `code` | ❌ | string | 供应商编码（一般不修改） |
| `name` | ❌ | string | 名称 |
| `contact` | ❌ | string | 联系人 |
| `phone` | ❌ | string | 电话 |
| `email` | ❌ | string | 邮箱 |
| `address` | ❌ | string | 地址 |
| `status` | ❌ | enum | "active"/"inactive" |

#### 4.3.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 查询供应商 | 404 若不存在 |
| 2 | 仅更新传入字段 | PATCH 语义（虽然用 PUT） |
| 3 | `updated_at` 自动刷新 | - |
| 4 | 返回 200 + `{id}` | - |

#### 4.3.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 编码可修改但不建议 | 接口允许修改 `code`，但修改后可能导致历史数据引用错乱 |
| 统计字段不可修改 | `cooperationCount` 和 `totalAmount` 不由本接口更新，由入库操作自动累加 |
| 状态切换 | "inactive" 的供应商仍可被物料关联，但新建采购订单时建议过滤 |

---

### 4.4 DELETE /suppliers/:id — 删除供应商

#### 4.4.1 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | `BEGIN IMMEDIATE` 后查询未删除供应商 | 404 若不存在 |
| 2 | 锁内查询活引用 | 未完成/未取消采购单、未完成/未取消入库、未退款/未取消供应商退货 |
| 3 | 活引用存在 | 409 `ENTITY_IN_USE`，回滚且零业务写 |
| 4 | 无活引用 | UPDATE `is_deleted = 1` 后 COMMIT，返回 200 |

#### 4.4.2 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 活义务阻断 | 在途采购、入库或未结退货属于现行义务，删除返回 409 `ENTITY_IN_USE` |
| 历史引用放行 | completed/cancelled 采购单、completed/cancelled 入库、refunded/cancelled 退货、软删业务行和物料关联不阻断 |
| 未知状态 fail-closed | 只有上列终态放行；空值、未知值及未来未登记状态均按活引用阻断 |
| 不级联删除 | 供应商软删除后不删除或改写关联物料、采购订单、入库与退货历史行 |
| 原子性 | 查询供应商、锁内查活引用、软删除写入处于同一个 `BEGIN IMMEDIATE` 事务；失败必须回滚 |
| 编码可回收 | 逻辑删除后，该编码可被新供应商复用（因为生成时只查 `is_deleted = 0`） |

---

## 5. 数据模型

### 5.1 实体定义

```
┌─────────────────────────────────────────────────────────────┐
│                      suppliers                              │
├─────────────────────────────────────────────────────────────┤
│ id                  TEXT PRIMARY KEY  (UUIDv4)              │
│ code                TEXT NOT NULL UNIQUE                    │
│ name                TEXT NOT NULL                           │
│ contact             TEXT                                    │
│ phone               TEXT                                    │
│ email               TEXT                                    │
│ address             TEXT                                    │
│ cooperation_count   INTEGER DEFAULT 0                       │
│ total_amount        DECIMAL(18,4) DEFAULT 0                 │
│ rating              INTEGER DEFAULT 5                       │
│ status              INTEGER DEFAULT 1                       │
│ is_deleted          INTEGER DEFAULT 0                       │
│ created_at          DATETIME DEFAULT CURRENT_TIMESTAMP      │
│ updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP      │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 与其他模块关联

| 关联模块 | 关联字段 | 关联类型 | 说明 |
|---------|---------|---------|------|
| 物料管理 | `materials.supplier_id` | 弱引用 | 物料关联供应商 |
| 采购订单 | `purchase_orders.supplier_id` | 弱引用 | 采购单关联供应商 |
| 入库管理 | `inbound_records.supplier_id` | 弱引用 | 入库单关联供应商 |

---

## 6. 交互细节

### 6.1 前端页面元素

| 元素 | 类型 | 说明 |
|------|------|------|
| 供应商列表表格 | Table | 展示 code、name、contact、phone、rating、status |
| 搜索框 | Input | 模糊搜索 name/code |
| 状态筛选 | Select | "全部"/"active"/"inactive" |
| 新建供应商按钮 | Button | admin 可见 |
| 编辑按钮 | Button | admin 可见 |
| 删除按钮 | Button | admin 可见，二次确认 |
| 评级展示 | Rate/Star | 1-5 星展示 |

### 6.2 表单校验规则

| 字段 | 前端校验 | 后端校验 |
|------|---------|---------|
| `name` | 非空，1-100 字符 | 非空 |
| `phone` | 手机号/电话格式 | 无 |
| `email` | 邮箱格式 | 无 |
| `code` | 只读（自动生成） | 自动生成，唯一性 |

### 6.3 异常处理矩阵

| 异常场景 | HTTP 状态 | 错误码 | 前端处理 |
|---------|----------|--------|---------|
| name 为空 | 400 | `INVALID_PARAMETER` | 表单校验 |
| code 冲突 | 409 | `RESOURCE_CONFLICT` | Toast |
| 供应商不存在 | 404 | `NOT_FOUND` | Toast |
| 无权限（非 admin 创建） | 403 | `FORBIDDEN` | 跳转 403 |

---

## 7. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| admin 获取供应商列表 | 200，返回分页列表 |
| 搜索供应商 | 200，返回匹配结果（name/code） |
| admin 创建供应商 | 201，返回 ID，code 为 SUP-xxxxx |
| code 自动生成连续 | 创建多个供应商，code 连续递增 |
| admin 编辑供应商 | 200，字段更新成功 |
| admin 删除供应商 | 200，逻辑删除 |
| 删除有在途采购/入库/退货的供应商 | 409 `ENTITY_IN_USE`，供应商和引用行不变 |
| 仅历史业务行或物料关联 | 200，供应商软删除，历史行不变 |
| 未知引用状态 | 409 `ENTITY_IN_USE`（fail-closed） |
| warehouse_manager 读列表 | 200，正常返回 |
| procurement 读列表 | 200，正常返回 |
| technician 访问列表 | 403 Forbidden |

---

*文档版本: v1.1.1*
*最后更新: 2026-07-22*
