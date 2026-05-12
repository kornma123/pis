# FRS-02 用户管理

> **文档编号**: FRS-02  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)  

---

## 1. 功能概述

系统用户档案的增删改查管理，包括用户名、密码、真实姓名、角色、部门、联系方式等信息的维护。仅系统管理员可操作用户数据。

| 项目 | 说明 |
|------|------|
| **功能定位** | 系统账号生命周期管理 |
| **可访问角色** | `admin`（全操作） |
| **RBAC 控制** | `requireRole('admin')` |
| **数据敏感性** | 高（涉及账号密码） |

---

## 2. 业务流程图

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   创建用户   │────→│  校验必填项   │────→│  username   │
│  (admin)    │     │  username/   │     │  唯一性检查  │
│             │     │  password/   │     │             │
│             │     │  realName    │     │             │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                        ┌───────────────────────┘
                        ▼
               ┌─────────────────┐
               │  bcrypt哈希密码  │
               │  status=1       │
               │  is_deleted=0   │
               └────────┬────────┘
                        ▼
               ┌─────────────────┐
               │   返回201+新用户ID │
               └─────────────────┘
```

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/users` | 用户列表（分页+搜索） | admin Token |
| 2 | POST | `/users` | 创建用户 | admin Token |
| 3 | PUT | `/users/:id` | 编辑用户 | admin Token |
| 4 | DELETE | `/users/:id` | 删除用户（逻辑删除） | admin Token |

---

## 4. 接口详情

### 4.1 GET /users — 用户列表

#### 4.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 | 校验规则 |
|------|------|------|--------|------|---------|
| `page` | ❌ | integer | 1 | 页码 | ≥1，page=0 按 1 处理 |
| `pageSize` | ❌ | integer | 20 | 每页条数 | ≥1，≤1000 |
| `keyword` | ❌ | string | - | 搜索关键词 | 模糊匹配 username 或 realName |

#### 4.1.2 业务流程规则

| 步骤 | 操作 | SQL 条件 |
|------|------|---------|
| 1 | 构建 WHERE | `is_deleted = 0`（仅显示未删除用户） |
| 2 | 关键词搜索 | `AND (username LIKE '%?%' OR real_name LIKE '%?%')` |
| 3 | 分页查询 | `LIMIT pageSize OFFSET (page-1)*pageSize` |
| 4 | 统计总数 | `SELECT COUNT(*) ...` |
| 5 | 字段映射 | `status` 1→"active"，0→"inactive" |

#### 4.1.3 响应字段

| 字段 | 类型 | 说明 | 敏感信息 |
|------|------|------|---------|
| `id` | string | UUID | 否 |
| `username` | string | 登录用户名 | 否 |
| `realName` | string | 真实姓名 | 否 |
| `role` | string | 角色编码 | 否 |
| `department` | string | 所属部门 | 否 |
| `phone` | string | 联系电话 | 否 |
| `email` | string | 邮箱 | 否 |
| `status` | enum | "active"/"inactive" | 否 |
| `createdAt` | datetime | 创建时间 | 否 |

#### 4.1.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 密码字段不返回 | 响应体中绝不包含 `password` 字段（即使数据库查询到也不返回） |
| 仅显示活跃用户 | `is_deleted = 0` 为强制过滤条件，已删除用户不可见 |
| 模糊搜索范围 | 仅搜索 `username` 和 `real_name` 两个字段，不搜索 department/phone/email |

---

### 4.2 POST /users — 创建用户

#### 4.2.1 请求参数

| 字段 | 必填 | 类型 | 长度限制 | 格式 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|---------|------|--------|---------|---------|
| `username` | ✅ | string | 1-50 | 非空字符串 | - | 非空 | "Username, password and realName required" |
| `password` | ✅ | string | 1-100 | 非空字符串 | - | 非空 | "Username, password and realName required" |
| `realName` | ✅ | string | 1-50 | 非空字符串 | - | 非空 | "Username, password and realName required" |
| `role` | ❌ | string | - | 有效角色编码 | "operator" | - | - |
| `department` | ❌ | string | - | - | null | - | - |
| `phone` | ❌ | string | - | - | null | - | - |
| `email` | ❌ | string | - | 邮箱格式 | null | - | - |

#### 4.2.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 校验 `username`、`password`、`realName` 同时非空 | 400 "Username, password and realName required" |
| 2 | 检查 `username` 唯一性：`SELECT * FROM users WHERE username = ? AND is_deleted = 0` | 存在 → 409 "Username exists" |
| 3 | `id` = `UUIDv4()` 自动生成 | - |
| 4 | `password` = `bcrypt.hashSync(password, 12)` | - |
| 5 | `status` = 1（active） | - |
| 6 | `is_deleted` = 0 | - |
| 7 | `created_at` / `updated_at` = CURRENT_TIMESTAMP | - |
| 8 | INSERT 并返回新用户 ID | 201 |

#### 4.2.3 自动生成字段

| 字段 | 值 | 说明 |
|------|------|------|
| `id` | UUIDv4 | 系统生成 |
| `password` | bcrypt 哈希 | 12 轮哈希 |
| `status` | 1 | 默认启用 |
| `is_deleted` | 0 | 未删除 |
| `created_at` | CURRENT_TIMESTAMP | 创建时间 |
| `updated_at` | CURRENT_TIMESTAMP | 更新时间 |

#### 4.2.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `role` 默认值问题 | 默认值为 `"operator"`，但系统 6 个正式角色中无此编码（正式角色：admin/warehouse_manager/technician/pathologist/procurement/finance） |
| 角色不校验存在性 | 创建用户时不校验 `role` 是否在 `roles` 表中存在，仅存储字符串 |
| 密码明文传输 | 创建请求中 `password` 为明文，由后端哈希存储 |
| 无初始权限分配 | 权限完全由 `role` 字段决定，不单独分配权限列表 |

---

### 4.3 PUT /users/:id — 编辑用户

#### 4.3.1 请求参数

| 字段 | 必填 | 类型 | 格式 | 默认值 | 说明 |
|------|------|------|------|--------|------|
| `realName` | ❌ | string | - | 保持原值 | 真实姓名 |
| `role` | ❌ | string | 有效角色编码 | 保持原值 | 角色 |
| `department` | ❌ | string | - | 保持原值 | 部门 |
| `phone` | ❌ | string | - | 保持原值 | 电话 |
| `email` | ❌ | string | 邮箱格式 | 保持原值 | 邮箱 |
| `status` | ❌ | enum | "active"/"inactive" | 保持原值 | 状态 |
| `password` | ❌ | string | - | 保持原值 | 新密码（若传则重新哈希） |

#### 4.3.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 查询用户：`SELECT * FROM users WHERE id = ? AND is_deleted = 0` | 不存在 → 404 |
| 2 | 仅更新传入的字段，未传字段保持原值 | - |
| 3 | 若传 `password` → `bcrypt.hashSync(password, 12)` | - |
| 4 | 若传 `status` → 字符串转整数（"active"→1, "inactive"→0） | - |
| 5 | `updated_at` = CURRENT_TIMESTAMP | - |
| 6 | UPDATE 并返回 `{id}` | 200 |

#### 4.3.3 状态转换规则

```
"active" ──→ "inactive" (禁用用户，无法登录)
"inactive" ──→ "active" (启用用户，恢复登录)
```

#### 4.3.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| PATCH 语义 | 虽然使用 PUT 方法，但行为是 PATCH（仅更新传入字段，未传保持原值） |
| 密码修改触发 | 仅当传入 `password` 时才重新哈希，不传则不影响原密码 |
| 状态字符串映射 | 接口接收 "active"/"inactive" 字符串，数据库存储 1/0 整数 |
| 不校验角色存在性 | 修改 `role` 时不校验新角色是否在 `roles` 表中存在 |

---

### 4.4 DELETE /users/:id — 删除用户

#### 4.4.1 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 查询用户是否存在 | 404 若不存在 |
| 2 | UPDATE `is_deleted = 1` | 逻辑删除 |
| 3 | 返回 200 | 无 data |

#### 4.4.2 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 逻辑删除 | 仅标记 `is_deleted = 1`，数据保留在数据库中 |
| 无关联校验 | 即使该用户有操作记录（入库/出库/日志），仍可删除 |
| 删除后影响 | 已删除用户的操作日志仍保留（`user_id` 成为悬空引用） |
| 不可恢复 | 当前系统无恢复功能，删除后需重新创建用户 |

---

## 5. 数据模型

### 5.1 实体关系图

```
┌─────────────────────────────────────────────────────────────┐
│                         users                               │
├─────────────────────────────────────────────────────────────┤
│ id           TEXT PRIMARY KEY  (UUIDv4)                     │
│ username     TEXT NOT NULL UNIQUE                           │
│ password     TEXT NOT NULL  (bcrypt哈希)                     │
│ real_name    TEXT NOT NULL                                  │
│ role         TEXT  (角色编码字符串)                           │
│ department   TEXT                                           │
│ phone        TEXT                                           │
│ email        TEXT                                           │
│ status       INTEGER DEFAULT 1  (1=active, 0=inactive)      │
│ is_deleted   INTEGER DEFAULT 0                              │
│ created_at   DATETIME DEFAULT CURRENT_TIMESTAMP             │
│ updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 与其他模块关联

| 关联模块 | 关联字段 | 关联类型 | 说明 |
|---------|---------|---------|------|
| 角色管理 | `users.role` → `roles.code` | 弱引用 | 字符串匹配，不 FOREIGN KEY |
| 入库管理 | `inbound_records.operator` | 引用 | 操作人姓名（非 ID） |
| 出库管理 | `outbound_records.operator` | 引用 | 操作人姓名（非 ID） |
| 操作日志 | `logs.user_id` | 引用 | 用户 ID |

---

## 6. 交互细节

### 6.1 前端页面元素

| 元素 | 类型 | 说明 |
|------|------|------|
| 用户列表表格 | Table | 展示 username、realName、role、department、status |
| 搜索框 | Input | 模糊搜索 username/realName |
| 新建用户按钮 | Button | admin 可见，打开创建弹窗 |
| 状态切换开关 | Switch | 快速启用/禁用用户 |
| 编辑按钮 | Button | 行内编辑，打开编辑弹窗 |
| 删除按钮 | Button | 行内删除，二次确认 |

### 6.2 表单校验规则

| 字段 | 前端校验 | 后端校验 |
|------|---------|---------|
| `username` | 非空，1-50 字符 | 非空 + 唯一性 |
| `password` | 非空，创建时必填 | 非空 + bcrypt 哈希 |
| `realName` | 非空，1-50 字符 | 非空 |
| `role` | 下拉选择 | 无校验（任意字符串） |
| `email` | 邮箱格式 | 无校验 |

### 6.3 异常处理矩阵

| 异常场景 | HTTP 状态 | 错误码 | 前端处理 |
|---------|----------|--------|---------|
| 必填项缺失 | 400 | `INVALID_PARAMETER` | 表单校验提示 |
| 用户名已存在 | 409 | `RESOURCE_CONFLICT` | 字段级错误提示 |
| 用户不存在 | 404 | `NOT_FOUND` | Toast 提示 |
| 无权限访问 | 403 | `FORBIDDEN` | 跳转 403 页面 |
| Token 无效 | 401 | `UNAUTHORIZED` | 跳转登录 |

---

## 7. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| admin 获取用户列表 | 200，返回分页列表，不含 password |
| admin 搜索用户 | 200，返回匹配结果 |
| admin 创建用户 | 201，返回新用户 ID |
| 创建重复用户名 | 409 "Username exists" |
| admin 编辑用户角色 | 200，role 更新成功 |
| admin 禁用用户 | 200，status 变为 "inactive" |
| admin 删除用户 | 200，逻辑删除 |
| 非 admin 访问用户列表 | 403 Forbidden |
| 修改不存在的用户 | 404 "Not found" |
| 密码修改后旧密码失效 | 新密码可登录，旧密码不可登录 |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
