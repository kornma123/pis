# COREONE 实验室耗材管理系统 — v1.0 产品需求文档（最终定稿）

**版本**: v1.0 FINAL  
**定稿日期**: 2026-05-23  
**状态**: 功能冻结 — 仅修复缺陷，不再新增功能  
**关联文档**: DESIGN.md, TECH-SPEC-v1.1.md, DATABASE-DESIGN-v1.1.md

---

## 1. 版本声明

本文档是 COREONE v1.0 的**最终范围声明**。自本文档定稿之日起：
- **v1.0 功能范围正式锁定**，后续仅修复缺陷（bug fix）
- 所有新增功能需求归入 v1.1 或后续版本规划
- 本文档作为验收基准，任何偏离均需经过变更审批

---

## 2. 系统概述

COREONE 是一款面向病理免疫组化特染领域的进销存与单张切片成本控制系统（PSI）。v1.0 实现了从物料入库、出库消耗、库存盘点到成本归集的完整闭环，支持 6 种角色权限管理。

### 2.1 用户角色

| 角色代码 | 角色名称 | 核心职责 |
|---------|---------|---------|
| admin | 系统管理员 | 用户管理、角色权限、系统配置 |
| warehouse_manager | 仓库管理员 | 入库、出库、盘点、退库、报废、调拨 |
| technician | 技术员 | 检测项目、BOM 配置、成本查看 |
| procurement | 采购员 | 采购订单、供应商管理 |
| finance | 财务人员 | 成本分析、消耗对账 |
| pathologist | 病理医生 | 项目查看、成本查看 |

---

## 3. v1.0 功能清单（已实现）

### 3.1 库存管理模块

| 功能 | 页面 | 后端路由 | 状态 |
|------|------|---------|------|
| 库存列表（实时查询、筛选、分页） | InventoryList.tsx | inventory-v1.1.ts | ✅ |
| 库存盘点（创建、撤销） | Stocktaking.tsx | stocktaking-v1.1.ts | ✅ |
| 入库记录（创建、编辑、删除、撤销） | Inbound.tsx | inbound-v1.1.ts | ✅ |
| 出库记录（创建、编辑、删除） | Outbound.tsx | outbound-v1.1.ts | ✅ |
| 退库管理（创建、撤销） | Returns.tsx | returns-v1.1.ts | ✅ |
| 报废管理（创建、撤销） | Scraps.tsx | scraps-v1.1.ts | ✅ |
| 调拨管理（创建、撤销） | Transfers.tsx | transfers-v1.1.ts | ✅ |

### 3.2 检测项目与 BOM 模块

| 功能 | 页面 | 后端路由 | 状态 |
|------|------|---------|------|
| 检测项目管理 | Projects.tsx | projects-v1.1.ts | ✅ |
| BOM 清单管理 | BOM.tsx | bom-v1.1.ts | ✅ |

### 3.3 基础数据模块

| 功能 | 页面 | 后端路由 | 状态 |
|------|------|---------|------|
| 物料分类管理 | Categories.tsx | categories-v1.1.ts | ✅ |
| 耗材管理 | Materials.tsx | materials.ts | ✅ |
| 供应商管理 | Suppliers.tsx | suppliers-v1.1.ts | ✅ |
| 库位管理 | Locations.tsx | locations-v1.1.ts | ✅ |

### 3.4 采购与预警模块

| 功能 | 页面 | 后端路由 | 状态 |
|------|------|---------|------|
| 采购订单管理 | PurchaseOrders.tsx | purchase-orders-v1.1.ts | ✅ |
| 预警中心 | Alerts.tsx | alerts-v1.1.ts | ✅ |

### 3.5 报表与对账模块

| 功能 | 页面 | 后端路由 | 状态 |
|------|------|---------|------|
| 物料成本分析 | CostAnalysis.tsx | reports-v1.1.ts | ✅ |
| 消耗对账 | Reconciliation.tsx | reconciliation-v1.1.ts | ✅ |

### 3.6 系统管理模块

| 功能 | 页面 | 后端路由 | 状态 |
|------|------|---------|------|
| 用户管理 | Users.tsx | users-v1.1.ts | ✅ |
| 角色权限 | Roles.tsx | roles-v1.1.ts | ✅ |
| 操作日志 | Logs.tsx | logs-v1.1.ts | ✅ |
| 仪表盘 | Dashboard.tsx | inventory-v1.1.ts + reports-v1.1.ts | ✅ |

### 3.7 认证模块

| 功能 | 页面 | 后端路由 | 状态 |
|------|------|---------|------|
| 登录/登出 | Login.tsx | auth.ts | ✅ |
| JWT Token 认证 | — | auth.ts | ✅ |

---

## 4. 明确不包含的功能（v1.1+ 规划）

以下功能在 v1.0 中**明确不提供**，已记录为后续迭代需求：

| 功能 | 说明 | 计划版本 |
|------|------|---------|
| 批次使用跟踪 UI | 后端有 6 个接口（depletion-v1.1.ts），前端无页面 | v1.1 |
| 批次耗尽记录 UI | 后端表已存在，无前端页面 | v1.1 |
| 移动端适配 | 仅桌面端响应式，无独立移动端 | v1.2 |
| 条码/扫码入库 | 需硬件设备支持 | v1.2 |
| HIS/LIS 系统集成 | 需外部系统对接 | v2.0 |
| 智能采购建议 | AI 辅助功能 | v2.0 |
| 多院区协同 | 多机构支持 | v2.0 |
| 报表导出 Excel/PDF | 部分页面支持，未全覆盖 | v1.1 |
| 数据备份与恢复 | 需运维方案 | v1.1 |
| 审批流程引擎 | 出库审批硬编码，无配置化 | v1.1 |

---

## 5. 技术架构

### 5.1 技术栈

**前端**:
- React 18.3 + TypeScript 5.8
- Vite 5.4 (SWC)
- React Router DOM 6.30
- TanStack Query 5.83 + Axios 1.16
- Tailwind CSS 3.4 + Radix UI Primitives
- Recharts 2.15
- Playwright 1.59 (E2E)

**后端**:
- Node.js 22 + Express 4.22 + TypeScript 5.9
- SQLite via `node:sqlite` DatabaseSync
- JWT (jsonwebtoken) + bcryptjs
- UUID + CORS

### 5.2 部署架构

```
浏览器 → Nginx (反向代理)
            ↓
    前端静态资源 (端口 8080)
            ↓
    后端 API 服务 (端口 3001)
            ↓
    SQLite 数据库文件 (coreone.db)
```

---

## 6. 数据库表清单（22 张表）

| 表名 | 用途 | 软删除 |
|------|------|--------|
| material_categories | 物料分类 | ✅ is_deleted |
| materials | 物料主数据 | ✅ is_deleted |
| suppliers | 供应商 | ✅ is_deleted |
| locations | 库位 | ✅ is_deleted |
| inventory | 库存实时数量 | ❌ |
| batches | 批次管理 | ❌ |
| inbound_records | 入库记录（含调拨） | ✅ is_deleted |
| outbound_records | 出库记录 | ✅ is_deleted |
| outbound_items | 出库明细 | ❌ |
| projects | 检测项目 | ✅ is_deleted |
| boms | BOM 主表 | ✅ is_deleted |
| bom_items | BOM 明细 | ❌ |
| stock_logs | 库存变动日志 | ❌ |
| alert_rules | 预警规则 | ❌ |
| alerts | 预警记录 | ❌ |
| users | 用户 | ✅ is_deleted |
| roles | 角色 | ✅ is_deleted |
| operation_logs | 操作日志 | ❌ |
| stocktaking_records | 盘点记录 | ✅ is_deleted |
| return_records | 退库记录 | ✅ is_deleted |
| scrap_records | 报废记录 | ✅ is_deleted |
| purchase_orders | 采购订单 | ✅ is_deleted |
| batch_usage_tracking | 批次使用跟踪 | ❌ |
| batch_depletion | 批次耗尽记录 | ❌ |
| lis_cases | LIS 病例数据 | ❌ |
| reconciliation_logs | 对账修正日志 | ❌ |

---

## 7. API 路由清单（21 个模块）

| 路由文件 | 基础路径 | 功能 |
|---------|---------|------|
| auth.ts | /api/v1/auth | 登录/注册/Token 刷新 |
| inventory-v1.1.ts | /api/v1/inventory | 库存查询、统计 |
| inbound-v1.1.ts | /api/v1/inbound | 入库 CRUD + 取消 |
| outbound-v1.1.ts | /api/v1/outbound | 出库 CRUD |
| returns-v1.1.ts | /api/v1/returns | 退库创建 + 撤销 |
| scraps-v1.1.ts | /api/v1/scraps | 报废创建 + 撤销 |
| transfers-v1.1.ts | /api/v1/transfers | 调拨创建 + 撤销 |
| stocktaking-v1.1.ts | /api/v1/stocktaking | 盘点创建 + 撤销 |
| purchase-orders-v1.1.ts | /api/v1/purchase-orders | 采购订单 CRUD |
| materials.ts | /api/v1/materials | 物料 CRUD |
| categories-v1.1.ts | /api/v1/categories | 分类 CRUD |
| suppliers-v1.1.ts | /api/v1/suppliers | 供应商 CRUD |
| locations-v1.1.ts | /api/v1/locations | 库位 CRUD |
| projects-v1.1.ts | /api/v1/projects | 项目 CRUD |
| bom-v1.1.ts | /api/v1/bom | BOM CRUD |
| reports-v1.1.ts | /api/v1/reports | 成本报表 |
| reconciliation-v1.1.ts | /api/v1/reconciliation | 消耗对账 |
| alerts-v1.1.ts | /api/v1/alerts | 预警管理 |
| users-v1.1.ts | /api/v1/users | 用户 CRUD |
| roles-v1.1.ts | /api/v1/roles | 角色 CRUD |
| logs-v1.1.ts | /api/v1/logs | 操作日志 |
| depletion-v1.1.ts | /api/v1/depletion | 批次使用/耗尽（无前端） |

---

## 8. 前端页面清单（23 个页面）

| 页面 | 路径 | 角色可见 |
|------|------|---------|
| 登录 | /login | 全部 |
| 仪表盘 | / | 全部 |
| 库存列表 | /inventory | 全部 |
| 入库记录 | /inbound | admin, warehouse_manager, procurement |
| 出库记录 | /outbound | admin, warehouse_manager |
| 退库管理 | /returns | admin, warehouse_manager |
| 报废管理 | /scraps | admin, warehouse_manager |
| 调拨管理 | /transfers | admin, warehouse_manager |
| 库存盘点 | /stocktaking | admin, warehouse_manager |
| 检测项目 | /projects | admin, technician, pathologist |
| BOM 清单 | /bom | admin, technician, pathologist |
| 消耗对账 | /reconciliation | admin, technician, finance, pathologist |
| 物料成本分析 | /cost-analysis | admin, technician, finance, pathologist |
| 物料分类 | /categories | 全部 |
| 耗材管理 | /materials | 全部（除 finance） |
| 预警中心 | /alerts | 全部 |
| 采购订单 | /purchase-orders | admin, procurement |
| 供应商管理 | /suppliers | admin, warehouse_manager, procurement |
| 库位管理 | /locations | admin, warehouse_manager |
| 用户管理 | /users | admin |
| 角色权限 | /roles | admin |
| 操作日志 | /logs | admin |
| 404 | * | 全部 |

---

## 9. 角色权限矩阵（菜单级）

| 页面路径 | admin | warehouse_manager | technician | procurement | finance | pathologist |
|---------|:-----:|:-----------------:|:----------:|:-----------:|:-------:|:-----------:|
| / | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| /inventory | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| /inbound | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| /outbound | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| /returns | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| /scraps | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| /transfers | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| /stocktaking | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| /projects | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| /bom | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| /reconciliation | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| /cost-analysis | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| /categories | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| /materials | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| /alerts | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| /purchase-orders | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| /suppliers | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| /locations | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| /users | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| /roles | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| /logs | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 10. 数据一致性规则（强制）

v1.0 中以下数据一致性规则已通过事务保护实现：

1. **入库 → 库存联动**: 入库记录创建时，inventory.stock 同步增加，batches.remaining 同步增加
2. **出库 → 库存联动**: 出库记录创建时，inventory.stock 同步减少，batches.remaining 同步减少（FIFO）
3. **盘点 → 库存调整**: 盘点差异非零时，inventory.stock 直接调整为实盘数量
4. **退库 → 库存回滚**: 退库记录撤销时，inventory.stock 同步增加
5. **报废 → 库存回滚**: 报废记录撤销时，inventory.stock 同步增加
6. **调拨 → 库存回滚**: 调拨记录撤销时，inventory.stock 同步减少
7. **入库取消/删除**: 回滚 inventory.stock 和 batches.remaining
8. **出库删除**: 回滚 inventory.stock 和 batches.remaining
9. **所有库存变动记录 stock_logs**: 包含 before_stock / after_stock / quantity / operator

**事务保护**: 所有涉及多表操作的写接口均使用 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`。

---

## 11. 已知限制与缺陷（v1.0）

| 编号 | 限制/缺陷 | 影响 |  workaround |
|------|----------|------|------------|
| LIM-001 | 采购订单无编辑/完整撤销 | 采购单录错需联系管理员 | 删除后重建 |
| LIM-002 | 批次使用跟踪无前端页面 | 无法查看试剂开瓶使用记录 | 直接查数据库 |
| LIM-003 | 无报表导出功能（大部分页面） | 无法导出 Excel/PDF | 截图或手动复制 |
| LIM-004 | 库存盘点为单物料模式 | 不支持按分类/库位批量盘点 | 逐个物料盘点 |
| LIM-005 | 预警为静态查询，无自动通知 | 需手动刷新预警中心 | 定期手动检查 |
| LIM-006 | 退库/报废/盘点/调拨无编辑 | 仅支持撤销后重建 | 撤销 → 重新创建 |
| LIM-007 | 操作日志仅记录后端请求 | 前端交互行为未记录 | 后端日志为主 |
| LIM-008 | 无数据备份/恢复机制 | 数据库文件需手动备份 | 定期手动复制 db 文件 |

### 11.1 边界保护机制（v1.0 已加固）

| 机制 | 覆盖范围 | 实现方式 |
|------|---------|---------|
| 并发事务保护 | 所有库存写操作（入库/出库/盘点/退库/报废/调拨） | `BEGIN IMMEDIATE` + `COMMIT`/`ROLLBACK` |
| 负库存兜底 | 所有库存扣减路径 | UPDATE 后断言 `stock >= 0`，否则 ROLLBACK |
| 重复提交防护 | 前端所有创建/提交按钮 | 提交中 `disabled` + 后端单号唯一索引 |

---

## 12. 验收标准（v1.0）

### 12.1 功能验收

- [x] 所有 23 个前端页面可正常访问
- [x] 所有 21 个后端路由模块正常运行
- [x] 6 种角色权限控制生效
- [x] 入库/出库/盘点/退库/报废/调拨核心流程跑通
- [x] 库存数据一致性通过事务保护
- [x] BOM 配置和成本归集逻辑正确
- [x] 成本报表数据与手工计算一致

### 12.2 技术验收

- [x] 前端 TypeScript 编译零错误
- [x] 后端路由无新增类型错误（既有错误未增加）
- [x] 数据库迁移兼容旧数据
- [x] E2E 测试通过（待确认）

---

## 13. 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|----------|--------|
| v1.0 | 2026-04-20 | 初始 PRD | 产品团队 |
| v1.1 | 2026-04-23 | 基于验收反馈完善 | 产品团队 |
| v1.0 FINAL | 2026-05-23 | 功能范围锁定，补充 4 个模块（退库/报废/调拨/采购），数据一致性治理 | 开发团队 |

---

*本文档为 v1.0 最终定稿版，后续功能需求请提交至 v1.1 需求池。*
