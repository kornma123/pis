# FRS-15 预警管理

> **文档编号**: FRS-15  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)、[FRS-07 库存管理](FRS-07-库存管理.md)  

---

## 1. 功能概述

库存预警规则配置和预警记录管理，支持低库存和临期两类预警。系统可手动触发预警生成，同一物料同类型的 pending 预警不会重复生成。

| 项目 | 说明 |
|------|------|
| **功能定位** | 库存风险监控，主动预警 |
| **可访问角色** | 全部角色可读；`admin` 可编辑规则 |
| **RBAC 控制** | 规则编辑：`requireRole('admin')`；读：全部角色 |
| **预警类型** | 低库存、临期 |

---

## 2. 预警规则

### 2.1 预设规则

| 类型 | 名称 | 阈值 | 说明 |
|------|------|------|------|
| `low-stock` | 低库存预警 | `threshold` | `stock <= safety_stock` |
| `expiry` | 临期预警 | `thresholdDays` | `expiry_date <= today + thresholdDays` |

---

## 3. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/alerts/rules` | 预警规则列表 | 任意角色 Token |
| 2 | PUT | `/alerts/rules/:id` | 编辑预警规则 | admin Token |
| 3 | GET | `/alerts` | 预警记录列表 | 任意角色 Token |
| 4 | POST | `/alerts/:id/handle` | 处理预警 | 任意角色 Token |
| 5 | POST | `/alerts/generate` | 手动生成预警 | admin Token |

---

## 4. 接口详情

### 4.1 GET /alerts/rules — 预警规则

#### 4.1.1 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `type` | string | "low-stock" 或 "expiry" |
| `name` | string | 规则名称 |
| `threshold` | integer | 阈值（低库存用） |
| `thresholdDays` | integer | 阈值天数（临期用） |
| `enabled` | boolean | 是否启用 |

---

### 4.2 PUT /alerts/rules/:id — 编辑规则

#### 4.2.1 请求参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `threshold` | ❌ | integer | 阈值 |
| `thresholdDays` | ❌ | integer | 阈值天数 |
| `enabled` | ❌ | boolean | 是否启用 |

---

### 4.3 GET /alerts — 预警记录

#### 4.3.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `page` | ❌ | integer | 1 | 页码 |
| `pageSize` | ❌ | integer | 20 | 每页条数 |
| `status` | ❌ | enum | - | "pending"/"handled"/"ignored" |
| `type` | ❌ | string | - | "low-stock"/"expiry" |

#### 4.3.2 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `type` | string | 预警类型 |
| `level` | string | 级别（warning/danger） |
| `materialId` | string | 物料 ID |
| `materialName` | string | 物料名称 |
| `currentStock` | integer | 当前库存 |
| `threshold` | integer | 阈值 |
| `message` | string | 预警消息 |
| `status` | string | "pending"/"handled"/"ignored" |
| `createdAt` | datetime | 创建时间 |

---

### 4.4 POST /alerts/:id/handle — 处理预警

#### 4.4.1 请求参数

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `action` | ❌ | string | "processed" | 处理动作 |
| `remark` | ❌ | string | '' | 备注 |

#### 4.4.2 业务流程规则

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | UPDATE `status = action` | - |
| 2 | `remark = remark` | - |
| 3 | `handled_at = CURRENT_TIMESTAMP` | - |

---

### 4.5 POST /alerts/generate — 手动生成预警

#### 4.5.1 业务流程规则

| 类型 | 触发条件 | SQL 条件 |
|------|---------|---------|
| 低库存 | `stock <= safety_stock` AND `safety_stock > 0` | `JOIN inventory ON materials.id = inventory.material_id` |
| 临期 | `expiry_date <= today + threshold_days` | `JOIN batches ON materials.id = batches.material_id` |

#### 4.5.2 去重规则

```sql
-- 低库存去重
SELECT COUNT(*) FROM alerts 
WHERE material_id = ? AND type = 'low-stock' AND status = 'pending'
-- 若=0则生成新预警
```

#### 4.5.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| 低库存消息格式 | `"Low stock: current {stock}, safety {safety_stock}"` |
| 临期消息格式 | `"Batch {batch_no} expires at {expiry_date}"` |
| 无自动通知 | 生成预警不会自动触发消息推送（无消息推送机制） |
| 手动触发 | 需调用 `/alerts/generate` 手动生成，无定时任务 |

---

## 5. 数据模型

```
┌─────────────────────────────────────────────────────────────┐
│                      alert_rules                            │
├─────────────────────────────────────────────────────────────┤
│ id              TEXT PRIMARY KEY  (UUIDv4)                  │
│ type            TEXT NOT NULL                               │
│ name            TEXT NOT NULL                               │
│ threshold       INTEGER                                     │
│ threshold_days  INTEGER                                     │
│ enabled         INTEGER DEFAULT 1                           │
│ created_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
│ updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                       alerts                                │
├─────────────────────────────────────────────────────────────┤
│ id              TEXT PRIMARY KEY  (UUIDv4)                  │
│ type            TEXT NOT NULL                               │
│ level           TEXT                                        │
│ material_id     TEXT                                        │
│ material_name   TEXT                                        │
│ current_stock   INTEGER                                     │
│ threshold       INTEGER                                     │
│ message         TEXT                                        │
│ status          TEXT DEFAULT 'pending'                      │
│ remark          TEXT                                        │
│ handled_at      DATETIME                                    │
│ created_at      DATETIME DEFAULT CURRENT_TIMESTAMP          │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 获取预警规则 | 200，返回规则列表 |
| 编辑预警规则 | 200，阈值更新 |
| 获取预警记录 | 200，支持 status/type 筛选 |
| 处理预警 | 200，status 变为 handled |
| 手动生成预警 | 低库存/临期预警生成 |
| 重复预警去重 | 同一物料同类型 pending 不重复生成 |
| 无权限编辑规则 | 403 Forbidden |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
