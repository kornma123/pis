# FRS-14 成本分析

> **文档编号**: FRS-14  
> **版本**: v1.1.0  
> **系统**: COREONE 病理科耗材管理系统  
> **生成时间**: 2026-05-12  
> **依赖文档**: [FRS-00 全局规范](FRS-00-全局规范.md)  

---

## 1. 功能概述

多维度成本分析报表，支持按项目、按物料、按供应商三个维度聚合统计成本数据。用于科室耗材成本监控和采购决策支持。

| 项目 | 说明 |
|------|------|
| **功能定位** | 成本统计报表，辅助决策 |
| **可访问角色** | `admin`/`pathologist`/`finance`（读） |
| **RBAC 控制** | `requireRole('admin','pathologist','finance')` |
| **数据特点** | 只读报表，基于出库/入库记录聚合计算 |

---

## 2. API 列表

| 序号 | 方法 | 路径 | 描述 | 认证要求 |
|------|------|------|------|---------|
| 1 | GET | `/reports/cost-by-project` | 按项目成本 | 指定角色 Token |
| 2 | GET | `/reports/cost-by-material` | 按物料成本 | 指定角色 Token |
| 3 | GET | `/reports/cost-by-supplier` | 按供应商成本 | 指定角色 Token |

---

## 3. 接口详情

### 3.1 GET /reports/cost-by-project — 按项目成本

#### 3.1.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `startDate` | ❌ | date | - | 开始日期（>= created_at） |
| `endDate` | ❌ | date | - | 结束日期（<= created_at+23:59:59） |

#### 3.1.2 响应字段

| 字段 | 类型 | 计算公式 |
|------|------|---------|
| `summary.totalCost` | decimal | `SUM(total_cost)` |
| `summary.totalSamples` | integer | `SUM(sample_count)` |
| `projects[].projectId` | string | 项目 ID |
| `projects[].projectName` | string | 项目名称 |
| `projects[].totalCost` | decimal | 项目总成本 |
| `projects[].sampleCount` | integer | 项目样本数 |
| `projects[].unitCost` | decimal | `total_cost / sample_count`（IF sample_count>0 ELSE 0） |
| `projects[].ratio` | string | `(total_cost / totalCost × 100).toFixed(1)` |
| `projects[].changeRate` | integer | 固定 0 |
| `projects[].changeDirection` | string | 固定 "down" |

#### 3.1.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `changeRate` 固定 0 | 系统未实现同比/环比计算，固定返回 0 |
| `changeDirection` 固定 "down" | 同上，固定返回值 |
| 日期筛选 | 基于 `outbound_records.created_at` 筛选 |

---

### 3.2 GET /reports/cost-by-material — 按物料成本

#### 3.2.1 请求参数（Query String）

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `startDate` | ❌ | date | 开始日期 |
| `endDate` | ❌ | date | 结束日期 |
| `categoryId` | ❌ | string | 分类筛选 |

#### 3.2.2 响应字段

| 字段 | 类型 | 计算公式 |
|------|------|---------|
| `summary.totalCost` | decimal | `SUM(total_cost)` |
| `materials[].materialId` | string | 物料 ID |
| `materials[].materialName` | string | 物料名称 |
| `materials[].consumption` | decimal | `SUM(quantity)` |
| `materials[].totalCost` | decimal | `SUM(total_cost)` |
| `materials[].ratio` | string | `(total_cost / totalCost × 100).toFixed(1)` |

#### 3.2.3 数据源

`outbound_items` JOIN `outbound_records` JOIN `materials`

---

### 3.3 GET /reports/cost-by-supplier — 按供应商成本

#### 3.3.1 响应字段

| 字段 | 类型 | 计算公式 |
|------|------|---------|
| `summary.totalAmount` | decimal | `SUM(amount)` |
| `suppliers[].supplierId` | string | 供应商 ID |
| `suppliers[].supplierName` | string | 供应商名称 |
| `suppliers[].amount` | decimal | `SUM(inbound_records.amount)` |
| `suppliers[].orderCount` | integer | `COUNT(inbound_records.id)` |
| `suppliers[].ratio` | string | `(amount / totalAmount × 100).toFixed(1)` |
| `suppliers[].status` | string | 固定 "long-term" |

#### 3.3.2 数据源

`inbound_records`（非采购订单）

#### 3.3.3 隐含规则显式化

| 规则 | 说明 |
|------|------|
| `status` 固定 "long-term" | 系统未实现供应商合作状态计算，固定返回值 |
| 数据来源 | 基于入库记录统计，非采购订单 |

---

## 4. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 按项目成本 | 返回各项目成本占比，ratio 保留 1 位小数 |
| 按物料成本 | 返回各物料消耗量和成本 |
| 按供应商成本 | 返回各供应商采购金额和订单数 |
| 日期范围筛选 | 正确过滤范围内数据 |
| 分类筛选（物料） | 正确过滤分类下物料 |
| 无数据 | 返回空数组，ratio=0 |
| 无权限访问 | 403 Forbidden |

---

*文档版本: v1.1.0*  
*最后更新: 2026-05-12*
