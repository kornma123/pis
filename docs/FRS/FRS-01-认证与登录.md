# FRS-01 认证与登录

> **文档编号**: FRS-01  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)  

---

## 1. 功能概述

系统认证中心模块，提供用户身份验证、Token 刷新、登出功能。所有角色均可访问登录相关接口（无需预先认证）。

| 项目 | 说明 |
|------|------|
| **功能定位** | 系统唯一入口，负责身份校验和会话管理 |
| **可访问角色** | 全部角色（登录前无角色限制） |
| **RBAC 控制** | 无（登录接口本身不校验 Token） |

---

## 2. 业务流程图

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   用户输入   │────→│  后端校验    │────→│  生成Token  │
│ 用户名+密码  │     │ bcrypt比对   │     │ JWT(8h)     │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                       ┌────────────────────────┘
                       ▼
              ┌─────────────────┐
              │  返回Token+用户信息  │
              │  + RefreshToken   │
              └─────────────────┘
```

### Token 生命周期

```
登录成功 ──→ Access Token (8h) ──→ 过期 ──→ /auth/refresh ──→ 新 Access Token
                │                                    │
                └────→ Refresh Token (7d) ───────────┘
                                      │
                                      └─→ 过期 ──→ 重新登录
```

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | POST | `/auth/login` | 用户名密码登录 | 无需认证 |
| 2 | POST | `/auth/refresh` | 刷新 Access Token | 需 Refresh Token |
| 3 | POST | `/auth/logout` | 用户登出 | 无需认证 |

---

## 4. 接口详情

### 4.1 POST /auth/login — 用户登录

#### 4.1.1 请求参数

| 字段 | 必填 | 类型 | 长度限制 | 格式 | 默认值 | 校验规则 | 错误提示 |
|------|------|------|---------|------|--------|---------|---------|
| `username` | ✅ | string | 1-50 字符 | 非空字符串 | - | 非空校验 | "Username and password required" |
| `password` | ✅ | string | 1-100 字符 | 非空字符串 | - | 非空校验 | "Username and password required" |

#### 4.1.2 业务流程规则

| 步骤 | 操作 | SQL/逻辑 | 失败处理 |
|------|------|---------|---------|
| 1 | 参数校验 | 检查 `username` 和 `password` 是否同时非空 | 400 `INVALID_PARAMETER`，文案 "Username and password required" |
| 2 | 查询用户 | `SELECT * FROM users WHERE username = ? AND status = 1 AND is_deleted = 0` | 未找到 → 步骤 3 |
| 3 | 用户不存在 | - | 401 `UNAUTHORIZED`，文案 "User not found or disabled" |
| 4 | 密码比对 | `bcrypt.compareSync(password, user.password)` | 不匹配 → 步骤 5 |
| 5 | 密码错误 | - | 401 `UNAUTHORIZED`，文案 "Invalid password" |
| 6 | 生成 Token | `jwt.sign({userId, username, role}, SECRET, {expiresIn: '8h'})` | - |
| 7 | 生成 RefreshToken | `jwt.sign({userId, type: 'refresh'}, SECRET, {expiresIn: '7d'})` | - |
| 8 | 返回数据 | 组装响应体 | 200 成功 |

#### 4.1.3 响应字段

| 字段 | 类型 | 说明 | 来源 |
|------|------|------|------|
| `token` | string | Access Token，有效期 8 小时 | JWT 生成 |
| `refreshToken` | string | Refresh Token，有效期 7 天 | JWT 生成 |
| `expiresIn` | integer | 固定值 `28800`（秒） | 硬编码 |
| `user.id` | string | 用户 UUID | 数据库 |
| `user.username` | string | 登录用户名 | 数据库 |
| `user.realName` | string | 真实姓名 | 数据库 |
| `user.role` | string | 角色编码 | 数据库 |
| `user.department` | string | 部门 | 数据库 |
| `user.permissions` | string[] | **固定值** `['inventory:view', 'inventory:edit', 'report:view', 'system:view']` | 硬编码（注意：不反映真实权限） |

#### 4.1.4 状态流转

```
[输入用户名密码] ──→ [校验非空] ──→ [查询用户] ──→ [bcrypt比对]
                                             │
                    ┌────────────────────────┘
                    ▼
           [用户不存在/禁用]    [密码错误]    [密码正确]
                │                  │             │
                ▼                  ▼             ▼
            401报错             401报错       200成功
         "User not found"    "Invalid password" 返回Token
```

#### 4.1.5 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `permissions` 硬编码 | 返回的 `user.permissions` 为固定数组，不反映该角色在 `roles` 表中的真实权限配置；真实权限由 `auth.ts` 中间件根据 `role` 字段控制 |
| 用户状态检查 | 仅 `status = 1` 且 `is_deleted = 0` 的用户可登录 |
| 密码哈希 | 使用 `bcrypt.compareSync()` 同步比对，12 轮哈希 |
| 并发登录 | 系统允许多客户端同时登录，各自独立 Token，无互踢机制 |

---

### 4.2 POST /auth/refresh — Token 刷新

#### 4.2.1 请求参数

| 字段 | 必填 | 类型 | 长度限制 | 校验规则 | 错误提示 |
|------|------|------|---------|---------|---------|
| `refreshToken` | ✅ | string | - | 非空 | "Refresh token required" |

#### 4.2.2 业务流程规则

| 步骤 | 操作 | 失败处理 |
|------|------|---------|
| 1 | 参数校验：检查 `refreshToken` 非空 | 400 "Refresh token required" |
| 2 | JWT 验证：校验签名和 `type === 'refresh'` | 401 "Invalid refresh token" |
| 3 | 查询用户：`SELECT * FROM users WHERE id = ? AND status = 1` | 401 "User not found or disabled" |
| 4 | 生成新 Access Token（新的 8h 有效期） | - |
| 5 | 返回新 token | 200 |

#### 4.2.3 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | string | 新的 Access Token |
| `expiresIn` | integer | 固定 28800 |

#### 4.2.4 隐含规则显式化

| 规则 | 说明 |
|------|------|
| Refresh Token 复用 | 刷新后原 Refresh Token 仍然有效（7 天内可无限次刷新） |
| Token 类型校验 | 必须使用 `type: 'refresh'` 的 Token，Access Token 用于刷新会返回 401 |
| 用户状态实时校验 | 刷新时实时查询用户状态，若用户被禁用则刷新失败 |

---

### 4.3 POST /auth/logout — 用户登出

#### 4.3.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| 无 | - | - | 无参数 |

#### 4.3.2 业务流程规则

- 服务端始终返回 200 成功响应
- 服务端**不维护 Token 黑名单**
- 登出操作仅前端清除 localStorage 中的 token

#### 4.3.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 无 Token 失效机制 | 已颁发的 Access Token 在 8h 内、Refresh Token 在 7 天内始终有效，即使主动登出 |
| 前端责任 | 登出后前端必须清除 localStorage 中的 `token` 和 `refreshToken`，并跳转登录页 |
| 安全性风险 | 若 Token 被截获，在有效期内可被任意使用 |

---

## 5. 交互细节

### 5.1 前端交互流程

| 场景 | 前端行为 | 后端响应 | 用户感知 |
|------|---------|---------|---------|
| 登录成功 | 存储 token/refreshToken/user 到 localStorage，跳转 Dashboard | 200 + Token + 用户信息 | 页面跳转至首页 |
| 登录失败-用户不存在 | 保留 username 输入框内容，清空 password | 401 | Toast: "用户不存在或已禁用" |
| 登录失败-密码错误 | 保留 username，清空 password，聚焦密码框 | 401 | Toast: "密码错误" |
| 登录失败-参数缺失 | 前端先行校验，阻止提交 | 400 | 表单校验提示 |
| Token 过期 | API 返回 401 → 自动调用 /refresh | 200（新 Token）或 401 | 用户无感知（静默刷新） |
| Refresh 失败 | 清除本地 Token，跳转登录页 | 401 | 跳转登录页，提示"会话已过期" |
| 主动登出 | 调用 /logout，清除 localStorage，跳转登录页 | 200 | 跳转登录页 |

### 5.2 异常处理矩阵

| 异常场景 | HTTP 状态 | 错误码 | 前端处理 |
|---------|----------|--------|---------|
| 用户名空 | 400 | `INVALID_PARAMETER` | 表单校验拦截 |
| 密码空 | 400 | `INVALID_PARAMETER` | 表单校验拦截 |
| 用户不存在 | 401 | `UNAUTHORIZED` | Toast 提示 |
| 用户已禁用 | 401 | `UNAUTHORIZED` | Toast 提示 |
| 密码错误 | 401 | `UNAUTHORIZED` | Toast 提示 |
| Token 过期 | 401 | `UNAUTHORIZED` | 自动刷新 |
| RefreshToken 无效 | 401 | `UNAUTHORIZED` | 跳转登录 |
| RefreshToken 类型错误 | 401 | `UNAUTHORIZED` | 跳转登录 |
| 服务端异常 | 500 | `INTERNAL_ERROR` | Toast + 重试按钮 |

---

## 6. 数据模型关联

```
┌─────────────┐         ┌─────────────┐
│   users     │◄────────│   roles     │
├─────────────┤   role  ├─────────────┤
│ id (PK)     │────────→│ code (UK)   │
│ username    │         │ permissions │
│ password    │         │ ...         │
│ role        │         └─────────────┘
│ status      │
│ is_deleted  │
└─────────────┘
```

- `users.role` 存储角色编码字符串（如 `"admin"`）
- `roles.code` 为角色唯一编码
- 登录时根据 `users.role` 确定权限，不 JOIN `roles` 表

---

## 7. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 正确用户名密码登录 | 200，返回 token + refreshToken + user |
| 错误密码登录 | 401，"Invalid password" |
| 不存在的用户登录 | 401，"User not found or disabled" |
| 已禁用用户登录 | 401，"User not found or disabled" |
| 空用户名/密码 | 400，"Username and password required" |
| 使用 Refresh Token 刷新 | 200，返回新 Access Token |
| 使用 Access Token 刷新 | 401，"Invalid refresh token" |
| Token 过期后刷新 | 200，返回新 Token |
| Refresh Token 过期 | 401，需重新登录 |
| 登出接口 | 200，服务端无状态变化 |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
