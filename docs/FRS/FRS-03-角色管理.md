# FRS-03 角色管理

> **文档编号**: FRS-03  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)  

---

## 1. 功能概述

系统角色定义与权限配置管理。角色是 RBAC 权限控制的核心，每个角色拥有唯一的编码、名称和权限列表。仅系统管理员可管理角色。

| 项目 | 说明 |
|------|------|
| **功能定位** | RBAC 权限基座，定义角色-权限映射关系 |
| **可访问角色** | `admin`（全操作） |
| **RBAC 控制** | `requireRole('admin')` |
| **数据敏感性** | 高（影响全系统权限控制） |

---

## 2. 预设角色清单

系统预置 6 个核心角色，初始化时自动创建：

| 角色编码 | 角色名称 | 权限范围 | 数据规模 |
|---------|---------|---------|---------|
| `admin` | 系统管理员 | 全部功能（读写删） | 1 人 |
| `warehouse_manager` | 仓库管理员 | 库存/入库/出库/库位/物料读/供应商读 | 1-2 人 |
| `technician` | 检验技师 | 库存读/出库写/项目读/BOM读 | 3-5 人 |
| `pathologist` | 病理医师 | 库存读/项目读/BOM读/成本分析读 | 2-3 人 |
| `procurement` | 采购专员 | 供应商读/采购订单读写 | 1-2 人 |
| `finance` | 财务人员 | 成本分析读/操作日志读 | 1-2 人 |

**隐含规则**: 预置角色的编码（code）不可被新角色占用，但系统未在创建时强制校验（仅靠数据初始化保证唯一性）。

---

## 3. 业务流程图

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   创建角色   │────→│  校验code/   │────→│   code      │
│  (admin)    │     │  name非空    │     │  唯一性检查  │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                        ┌───────────────────────┘
                        ▼
               ┌─────────────────┐
               │ permissions序列化 │
               │ 为JSON字符串存储  │
               └────────┬────────┘
                        ▼
               ┌─────────────────┐
               │  status = 1     │
               │  is_deleted = 0 │
               └────────┬────────┘
                        ▼
               ┌─────────────────┐
               │   返回201+角色ID  │
               └─────────────────┘
```

---

## 4. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/roles` | 角色列表（分页） | admin Token |
| 2 | POST | `/roles` | 创建角色 | admin Token |
| 3 | PUT | `/roles/:id` | 编辑角色 | admin Token |
| 4 | DELETE | `/roles/:id` | 删除角色（逻辑删除） | admin Token |

---

## 5. 接口详情

### 5.1 GET /roles — 角色列表

#### 5.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |

#### 5.1.2 响应字段

| 字段 | 类型 | 说明 | 特殊处理 |
|------|------|------|---------|
| `id` | string | UUID | - |
| `code` | string | 角色编码（唯一） | 区分大小写 |
| `name` | string | 角色名称 | - |
| `description` | string | 角色描述 | - |
| `permissions` | string | **JSON 字符串** | 如 `'["inventory","alerts"]'`，前端需 `JSON.parse()` |
| `status` | integer | 1=active, 0=inactive | - |

#### 5.1.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `permissions` 存储格式 | 数据库中存储为 JSON 字符串（非 JSON 数组），如 `'["inventory", "alerts"]'`；接口层原样返回字符串，前端需自行解析 |
| 仅返回未删除 | `is_deleted = 0` 为强制过滤条件 |
| 无搜索功能 | 列表接口不支持 keyword 搜索 |

---

### 5.2 POST /roles — 创建角色

#### 5.2.1 请求参数

| 字段 | 必填 | 类型 | 长度限制 | 格式 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|---------|------|--------|---------|---------|
| `code` | ✅ | string | 1-50 | 非空字符串 | - | 非空，全局唯一 | "Code and name required" / "Role code already exists" |
| `name` | ✅ | string | 1-50 | 非空字符串 | - | 非空 | "Code and name required" |
| `description` | ❌ | string | - | - | '' | - | - |
| `permissions` | ❌ | string[] | - | 字符串数组 | `[]` | 数组元素为字符串 | - |
| `status` | ❌ | enum | - | "active"/"inactive" | "active" | - | - |

#### 5.2.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 校验 `code` 和 `name` 同时非空 | 400 "Code and name required" |
| 2 | 检查 `code` 唯一性：`SELECT * FROM roles WHERE code = ? AND is_deleted = 0` | 存在 → 409 "Role code already exists" |
| 3 | `permissions` 序列化为 JSON 字符串：`JSON.stringify(permissions)` | - |
| 4 | `status` = "active" ? 1 : 0 | - |
| 5 | INSERT 并返回新角色 ID | 201 |

#### 5.2.3 权限列表预定义值

权限字符串为前端路由/功能标识，常见值包括：

| 权限值 | 含义 |
|--------|------|
| `"inventory"` | 库存管理 |
| `"inbound"` | 入库管理 |
| `"outbound"` | 出库管理 |
| `"alerts"` | 预警管理 |
| `"reports"` | 报表分析 |
| `"system"` | 系统管理 |
| `"master"` | 主数据管理 |
| `"purchase"` | 采购管理 |

**隐含规则**: 权限列表为前端约定的字符串标识，后端仅做存储和透传，不解析权限语义。

#### 5.2.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `code` 区分大小写 | `"Admin"` 和 `"admin"` 被视为不同编码 |
| 预置角色保护 | 系统未在创建时阻止使用预置编码（admin/warehouse_manager 等），仅靠初始化数据保证唯一性 |
| permissions 可为空 | `permissions = []` 表示该角色无任何权限 |
| 角色创建不影响现有用户 | 新角色创建后，已存在的用户不会自动获得该角色 |

---

### 5.3 PUT /roles/:id — 编辑角色

#### 5.3.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `code` | ❌ | string | 角色编码 |
| `name` | ❌ | string | 角色名称 |
| `description` | ❌ | string | 描述 |
| `permissions` | ❌ | string[] | 权限数组（序列化存储） |
| `status` | ❌ | enum | "active"/"inactive" |

#### 5.3.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 查询角色：`SELECT * FROM roles WHERE id = ? AND is_deleted = 0` | 不存在 → 404 "Role not found" |
| 2 | 全字段覆盖更新（PUT 语义） | - |
| 3 | 若传 `permissions` → `JSON.stringify(permissions)` | - |
| 4 | 若传 `status` → 字符串转整数 | - |
| 5 | UPDATE 并返回 `{id}` | 200 |

#### 5.3.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 全量更新 | PUT 语义，传入字段覆盖，未传字段也按传入值处理（若传 null 则覆盖为 null） |
| 权限即时生效 | 修改角色权限后，已绑定该角色的用户下次登录时获得新权限（Token 中携带 role） |
| 不级联更新用户 | 修改 `code` 不会同步更新 `users.role` 字段，可能导致用户角色失效 |

---

### 5.4 DELETE /roles/:id — 删除角色

#### 5.4.1 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 查询角色是否存在 | 404 若不存在 |
| 2 | UPDATE `is_deleted = 1` | 逻辑删除 |
| 3 | 返回 200 | 无 data |

#### 5.4.2 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 无关联校验 | 即使有用户绑定此角色，仍可删除角色 |
| 删除后影响 | 已绑定该角色的用户仍能正常登录，RBAC 基于 `users.role` 字符串匹配，不校验 `roles` 表存在性 |
| 悬空引用风险 | 删除角色后，`users.role` 成为悬空引用，用户仍持有该角色编码但无对应角色定义 |

---

## 6. 数据模型

### 6.1 实体关系图

```
┌─────────────────────────────────────────────────────────────┐
│                        roles                                │
├─────────────────────────────────────────────────────────────┤
│ id           TEXT PRIMARY KEY  (UUIDv4)                     │
│ code         TEXT NOT NULL                                  │
│ name         TEXT NOT NULL                                  │
│ description  TEXT                                           │
│ permissions  TEXT  (JSON字符串，如 '["inventory","alerts"]') │
│ status       INTEGER DEFAULT 1                              │
│ is_deleted   INTEGER DEFAULT 0                              │
│ created_at   DATETIME DEFAULT CURRENT_TIMESTAMP             │
│ updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP             │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 与 users 表关系

```
┌─────────────┐         ┌─────────────┐
│   roles     │         │   users     │
├─────────────┤         ├─────────────┤
│ code (UK)   │◄───────│ role        │
│ ...         │  弱引用 │ ...         │
└─────────────┘         └─────────────┘
```

- `users.role` → `roles.code` 为字符串弱引用，无 FOREIGN KEY 约束
- 删除角色不会级联删除用户或更新用户角色

---

## 7. 交互细节

### 7.1 前端页面元素

| 元素 | 类型 | 说明 |
|------|------|------|
| 角色列表表格 | Table | 展示 code、name、description、status |
| 权限标签组 | Tag | 展示 permissions 解析后的权限标签 |
| 新建角色按钮 | Button | admin 可见 |
| 编辑按钮 | Button | 打开编辑弹窗，含权限多选框 |
| 删除按钮 | Button | 行内删除 |

### 7.2 权限配置交互

| 交互 | 说明 |
|------|------|
| 权限选择 | 多选框组，选项为预定义权限字符串 |
| 全选/清空 | 快捷操作按钮 |
| 权限展示 | 列表中以 Tag 标签展示已选权限 |

### 7.3 异常处理矩阵

| 异常场景 | HTTP 状态 | 错误码 | 前端处理 |
|---------|----------|--------|---------|
| code/name 为空 | 400 | `INVALID_PARAMETER` | 表单校验 |
| code 已存在 | 409 | `RESOURCE_CONFLICT` | 字段级错误 |
| 角色不存在 | 404 | `NOT_FOUND` | Toast |
| 无权限 | 403 | `FORBIDDEN` | 跳转 403 |
| permissions 格式错误 | 400 | `INVALID_PARAMETER` | 表单校验 |

---

## 8. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| admin 获取角色列表 | 200，含 permissions JSON 字符串 |
| admin 创建新角色 | 201，返回角色 ID |
| 创建重复 code | 409 "Role code already exists" |
| 编辑角色权限 | 200，permissions 更新为 JSON 字符串 |
| 删除角色 | 200，逻辑删除 |
| 删除后绑定用户仍可登录 | 用户登录成功，RBAC 仍基于 role 字符串 |
| 非 admin 访问 | 403 Forbidden |
| 角色详情含权限 | permissions 字段为字符串，需 JSON.parse |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
