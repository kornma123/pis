# FRS-00 全局规范

> **文档编号**: FRS-00  
> **版本**: v1.1.1
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **适用范围**: 全部功能模块  

---

## 1. 文档目的

本文档定义 COREONE 系统所有 API 接口共同遵循的全局规范，包括响应格式、分页规则、错误码体系、通用字段规范及非功能性需求。所有子模块 FRS 文档均须引用本文档中的全局约定。

---

## 2. 通用响应格式

### 2.1 成功响应（单条数据）

```json
{
  "success": true,
  "data": { ... },
  "message": "操作成功"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `success` | boolean | ✅ | 固定为 `true` |
| `data` | object | ✅ | 业务数据对象 |
| `message` | string | ✅ | 操作结果描述，默认"操作成功" |

### 2.2 成功响应（列表数据）

```json
{
  "success": true,
  "data": {
    "list": [...],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 100
    }
  },
  "message": "操作成功"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `list` | array | ✅ | 数据记录数组 |
| `pagination.page` | integer | ✅ | 当前页码 |
| `pagination.pageSize` | integer | ✅ | 每页条数 |
| `pagination.total` | integer | ✅ | 总记录数 |

### 2.3 错误响应

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "参数错误描述"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `success` | boolean | ✅ | 固定为 `false` |
| `error.code` | string | ✅ | 错误码标识符 |
| `error.message` | string | ✅ | 错误描述文案 |

---

## 3. 分页规则

### 3.1 请求参数

| 参数 | 类型 | 默认值 | 最小值 | 最大值 | 说明 |
|------|------|--------|--------|--------|------|
| `page` | integer | 1 | 1 | - | 当前页码，`page=0` 时后端按 `1` 处理 |
| `pageSize` | integer | 20 | 1 | 1000 | 每页条数，支持 `pageSize=1000` 用于全量导出 |

### 3.2 分页计算规则

```
offset = (page - 1) * pageSize
limit = pageSize
```

### 3.3 边界处理

| 场景 | 处理规则 |
|------|---------|
| `page = 0` | 后端修正为 `page = 1` |
| `pageSize > 1000` | 后端限制为 `1000`（建议实现） |
| 空列表 | `list: []`, `pagination.total: 0` |
| 超页请求 | `list: []`, `pagination.total: N`（不报错） |

---

## 4. 错误码体系

### 4.1 错误码总表

| 错误码 | HTTP 状态码 | 触发场景 | 典型响应文案 |
|--------|------------|---------|------------|
| `INVALID_PARAMETER` | 400 | 参数缺失、格式错误、类型不匹配 | "Missing required fields" / "Invalid parameter" |
| `UNAUTHORIZED` | 401 | 未携带 Token、Token 过期、Token 签名无效 | "Unauthorized" / "Invalid token" |
| `FORBIDDEN` | 403 | 已认证但无权限访问（RBAC 拦截） | "Forbidden: insufficient permissions" |
| `NOT_FOUND` | 404 | 资源不存在 | "Not found" / "Role not found" |
| `RESOURCE_CONFLICT` | 409 | 唯一性冲突（编码、用户名重复） | "Code already exists" / "Username exists" |
| `BUSINESS_RULE` | 400 | 违反业务规则 | "Has children" / "Stock exists" |
| `STOCK_INSUFFICIENT` | 422 | 库存不足 | "Insufficient stock" |
| `CONFLICT` | 409 | 存在关联数据，无法删除 | "已有出库记录，不可删除" |
| `ENTITY_IN_USE` | 409 | 主数据仍被现行运营义务或有效分配引用 | "实体仍被使用，无法删除" |
| `INTERNAL_ERROR` | 500 | 服务端内部异常 | "Internal server error" |

### 4.2 HTTP 状态码与错误码映射

| HTTP 状态码 | 使用场景 |
|------------|---------|
| 200 | GET/PUT/DELETE 成功 |
| 201 | POST 创建成功 |
| 400 | 参数校验失败、业务规则冲突 |
| 401 | 认证失败 |
| 403 | 权限不足 |
| 404 | 资源不存在 |
| 409 | 数据冲突（唯一性/关联性） |
| 422 | 语义错误（如库存不足） |
| 500 | 服务端异常 |

---

## 5. 通用字段规范

### 5.1 数据库通用字段

以下字段存在于绝大多数数据表中，除非特别说明：

| 字段 | 类型 | 默认值 | 说明 | 规则 |
|------|------|--------|------|------|
| `id` | TEXT (UUIDv4) | 自动生成 | 主键，全局唯一 | 不可修改，不可由前端传入 |
| `created_at` | DATETIME | CURRENT_TIMESTAMP | 创建时间 | 插入时自动填充 |
| `updated_at` | DATETIME | CURRENT_TIMESTAMP | 更新时间 | 每次 UPDATE 自动刷新 |
| `is_deleted` | INTEGER (0/1) | 0 | 逻辑删除标志 | `0`=正常，`1`=已删除；物理查询需过滤 `is_deleted = 0` |
| `status` | INTEGER (0/1) | 1 | 记录状态 | `1`=active（启用），`0`=inactive（禁用）；接口层转换为 "active"/"inactive" 字符串 |

### 5.2 枚举值映射规则

| 存储值 | 接口返回值 | 说明 |
|--------|-----------|------|
| `status = 1` | `"active"` | 启用/正常 |
| `status = 0` | `"inactive"` | 禁用/停用 |
| `is_deleted = 0` | 记录可见 | 正常数据 |
| `is_deleted = 1` | 记录不可见 | 已删除（逻辑删除） |

### 5.3 日期时间格式

| 场景 | 格式 | 示例 |
|------|------|------|
| 接口请求（日期） | `yyyy-mm-dd` | `2026-05-12` |
| 接口请求（日期时间） | ISO 8601 | `2026-05-12T10:30:00Z` |
| 数据库存储 | DATETIME | `2026-05-12 10:30:00` |
| 接口响应 | ISO 8601 | `2026-05-12T10:30:00.000Z` |

**隐含规则**: 日期范围筛选时，结束日期自动附加 `T23:59:59` 时间后缀，确保包含整天。

---

## 6. 数据精度规范

### 6.1 数值精度

| 数据类型 | 数据库类型 | 精度 | 说明 |
|---------|-----------|------|------|
| 金额 | DECIMAL(18,4) | 4位小数 | 支持分以下精度（如 0.0001） |
| 数量 | DECIMAL(18,4) | 4位小数 | 库存数量、采购数量等 |
| 占比 | DECIMAL(5,1) | 1位小数 | 百分比展示，如 `"32.5"` |
| 单价 | DECIMAL(18,4) | 4位小数 | 物料单价、入库单价 |

### 6.2 计算规则

- 金额计算：`amount = quantity × price`，结果四舍五入保留 4 位小数
- 占比计算：`ratio = (subTotal / total × 100).toFixed(1)`
- 单位成本：`unitCost = batch.inbound_price`（按 FIFO 批次取最早过期批次的入库价）

---

## 7. 认证与授权规范

### 7.1 Token 规范

| 项目 | 规范 |
|------|------|
| Token 类型 | JWT (JSON Web Token) |
| 签名算法 | HS256 |
| Secret Key | 由环境变量 `JWT_SECRET` 注入（旧硬编码弱密钥已泄露并移除，勿使用） |
| Access Token 有效期 | 8 小时（28800 秒） |
| Refresh Token 有效期 | 7 天（604800 秒） |
| Token 传输位置 | HTTP Header: `Authorization: Bearer <token>` |

### 7.2 JWT Payload 结构

**Access Token**:
```json
{
  "userId": "uuid-string",
  "username": "admin",
  "role": "admin",
  "iat": 1715491200,
  "exp": 1715520000
}
```

**Refresh Token**:
```json
{
  "userId": "uuid-string",
  "type": "refresh",
  "iat": 1715491200,
  "exp": 1716096000
}
```

### 7.3 RBAC 权限矩阵

| 角色编码 | 角色名称 | 权限范围 |
|---------|---------|---------|
| `admin` | 系统管理员 | 全部功能（读写删） |
| `warehouse_manager` | 仓库管理员 | 库存/入库/出库/库位/物料读 |
| `technician` | 检验技师 | 库存读/出库写/项目/BOM读 |
| `pathologist` | 病理医师 | 库存读/项目/BOM读/成本分析读 |
| `procurement` | 采购专员 | 供应商读/采购订单读写 |
| `finance` | 财务人员 | 成本分析读/操作日志读 |

### 7.4 权限拦截规则

- 未携带 Token → 401 `UNAUTHORIZED`
- Token 无效/过期 → 401 `UNAUTHORIZED`
- Token 有效但角色不在允许列表 → 403 `FORBIDDEN`
- 资源不存在 → 404 `NOT_FOUND`

**隐含规则**: 服务端无 Token 黑名单机制，登出仅前端清除 localStorage，已颁发的 Token 在有效期内始终可用。

---

## 8. 非功能性需求（NFR）

### 8.1 性能要求

| 操作类型 | 目标响应时间 | 说明 |
|---------|------------|------|
| 简单查询（单条） | < 200ms | 主键查询、详情查询 |
| 列表查询（分页） | < 300ms | 含搜索、筛选、分页 |
| 复杂报表查询 | < 1s | 多表 JOIN 聚合统计 |
| 写操作（含事务） | < 500ms | 创建、更新、删除 |

### 8.2 并发限制

| 限制项 | 说明 |
|--------|------|
| SQLite 文件锁 | 同一时间仅允许一个写入事务；读操作可并发 |
| 无连接池 | 每个请求独立打开/关闭数据库连接 |
| 无高并发支持 | 系统设计为科室内部使用，并发用户 < 20 |

### 8.3 安全要求

| 项目 | 规范 |
|------|------|
| 密码存储 | bcrypt 12轮哈希，服务端绝不返回 `password` 字段 |
| SQL 注入防御 | 全部使用参数化查询（`?` 占位符） |
| XSS 防御 | 前端输出转义，后端不执行 HTML 解析 |
| 敏感数据 | 用户列表不返回密码哈希；Token 不存储敏感信息 |

### 8.4 可用性要求

| 项目 | 规范 |
|------|------|
| 数据持久化 | SQLite 文件存储，定期备份 |
| 无会话管理 | 纯 Token 认证，无服务端 Session |
| 故障恢复 | 数据库损坏时需从备份恢复 |

---

## 9. 编码生成规则汇总

| 编码类型 | 格式 | 生成规则 |
|---------|------|---------|
| 供应商编码 | `SUP-xxxxx` | `MAX(CAST(SUBSTR(code,5) AS INT)) + 1`，5位补零 |
| 库位编码 | `LOC-xxxxx` | 同上 |
| 物料编码 | `REA-xxxxx` / `CON-xxxxx` / `DEV-xxxxx` / `HZP-xxxxx` | 根据分类前缀 + 该前缀最大编号 +1 |
| 分类编码 | 纯数字 | 一级：`MAX+100`；二/三级：`MAX(同parent)+1` |
| 入库单号 | `IB-yyyymmdd-xxx` | 日期前缀 + 3位随机数 |
| 出库单号 | `OB-yyyymmdd-xxx` | 日期前缀 + 3位随机数 |
| 采购单号 | `POyyyymmdd-xxxx` | 日期前缀 + 4位当日序号 |
| BOM 版本 | `vN.M` | 初始 `v1.0`，编辑时次版本 +1 |

---

## 10. 逻辑删除统一规则

| 表名 | 删除方式 | 关联影响 | 前置校验 |
|------|---------|---------|---------|
| `users` | `is_deleted = 1` | 历史单据、操作日志保留且不级联 | 生效项目负责人或未完成/未取消出库经办存在时返回 409 `ENTITY_IN_USE` |
| `roles` | `is_deleted = 1` | 历史用户分配保留且不级联 | 启用且未删除用户仍经 `users.role`/`primary_role`/`user_roles` 持有时返回 409 `ENTITY_IN_USE` |
| `suppliers` | `is_deleted = 1` | 历史物料、采购、入库、退货保留且不级联 | 在途采购、未完成/未取消入库、未退款/未取消退货存在时返回 409 `ENTITY_IN_USE` |
| `materials` | `is_deleted = 1` | 历史 inbound/outbound 保留 | `inventory.stock = 0` |
| `categories` | `is_deleted = 1` | 有子/有物料时禁止删除 | 检查子分类、关联物料 |
| `locations` | `is_deleted = 1` | 历史库存、批次、物料、设备记录保留且不级联 | 正库存/剩余批次返回 409 `CONFLICT`；生效物料或设备分配返回 409 `ENTITY_IN_USE` |
| `boms` | `is_deleted = 1` | 无级联 | 无 |
| `projects` | `is_deleted = 1` | 历史出库、成本异常、LIS 病例和目录映射保留且不级联 | 未完成/未取消出库或未 resolved/closed/ignored 成本异常存在时返回 409 `ENTITY_IN_USE` |
| `inbound_records` | `is_deleted = 1` | 同步扣减库存/批次/PO | 检查出库记录、使用中状态 |

### 10.1 主数据删除事务不变量

- 上表五类主数据（用户、角色、供应商、库位、项目）的“查实体 → 查活引用 → 写软删除”必须处于同一个 `BEGIN IMMEDIATE` 事务中；引用判断以锁内查询为准。
- 历史/审计行不级联删除、不改写；只有现行运营义务或有效分配阻断删除。
- 对带状态的引用，只允许文档列明的终态放行；空值、未知值和未来新增但未登记的状态一律按活引用处理（fail-closed）。
- 拒绝删除返回 HTTP 409；新增主数据活引用统一使用 `ENTITY_IN_USE`，库位既有正库存/剩余批次合同继续使用 `CONFLICT`。
- 事务内任一步失败不得留下部分业务写；回滚命令失败时关闭当前数据库连接以触发 SQLite 回滚。回滚与关闭同时失败的处置不在本版合同范围，须保持 500 fail-closed 并由独立故障恢复任务处理。

---

## 11. 接口版本约定

- API Base URL: `http://localhost:3001/api/v1`
- 所有路由前缀: `/api/v1`
- 版本号采用 URI 路径版本控制（v1, v1.1 等）

---

*文档版本: v1.1.1*
*最后更新: 2026-07-22*
*维护责任人: 业务分析团队*
