# FRS-16 操作日志

> **文档编号**: FRS-16  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)  

---

## 1. 功能概述

系统操作日志查询，记录用户的关键操作行为（登录、创建、编辑、删除等）。用于审计追踪和问题排查。

| 项目 | 说明 |
|------|------|
| **功能定位** | 操作审计，问题追溯 |
| **可访问角色** | `admin`/`finance`（读） |
| **RBAC 控制** | `requireRole('admin','finance')` |
| **数据特点** | 只读，系统初始化 13 条日志 |

---

## 2. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/logs/operation` | 操作日志列表（分页+筛选） | admin/finance Token |

---

## 3. 接口详情

### 3.1 GET /logs/operation — 操作日志

#### 3.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `startDate` | ❌ | date | - | 开始日期 |
| `endDate` | ❌ | date | - | 结束日期 |
| `userId` | ❌ | string | - | 用户 ID 筛选 |

#### 3.1.2 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `userId` | string | 用户 ID |
| `username` | string | 用户名 |
| `operation` | string | 操作类型 |
| `description` | string | 操作描述 |
| `ip` | string | IP 地址 |
| `userAgent` | string | 浏览器 UA |
| `createdAt` | datetime | 操作时间 |

#### 3.1.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 日志写入方式 | **全站写操作由 `auditWrite` 中间件统一自动记录**（`middleware/audit-log.ts`，2026-07-02 起）：所有登录后的成功(2xx)写操作（POST/PUT/PATCH/DELETE）自动落 `operation_logs`；成本/对账域并存其专属审计（`abc_audit_logs`/`reconciliation_logs`）。个别路由（如 supplier-returns 修正）另手写带明细的日志。读(GET)/公开接口(/auth)/失败请求不记。 |
| 敏感字段脱敏 | 请求体中 password/token/secret 等字段入库前打码为 `[REDACTED]`；响应体不落库（`response_data` 恒为 null）。 |
| 记录口径 | 只记成功(2xx)；失败尝试(403/422/…)不入库，避免被失败请求刷爆。 |
| 当前数据量 | 系统 seed 数据含约 13 条历史日志；运行后随写操作自动增长。 |
| 不支持删除 | 日志不支持删除/清理接口 |
| IP/UA | IP 和 UA 原样记录，未脱敏处理 |

---

## 4. 数据模型

```
┌─────────────────────────────────────────────────────────────┐
│                    operation_logs                           │
├─────────────────────────────────────────────────────────────┤
│ id            TEXT PRIMARY KEY  (UUIDv4)                    │
│ user_id       TEXT                                          │
│ username      TEXT                                          │
│ operation     TEXT                                          │
│ description   TEXT                                          │
│ ip            TEXT                                          │
│ user_agent    TEXT                                          │
│ created_at    DATETIME DEFAULT CURRENT_TIMESTAMP            │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 获取操作日志 | 200，返回分页列表 |
| 按日期筛选 | 200，返回范围内日志 |
| 按用户筛选 | 200，返回该用户日志 |
| 无权限访问 | 403 Forbidden |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
