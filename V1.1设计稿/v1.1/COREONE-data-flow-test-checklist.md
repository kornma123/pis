# COREONE 实验室耗材管理系统 - 数据流转测试清单

> **测试日期**：2026-04-20
> **测试范围**：跨页面数据流转、状态同步、数据引用完整性
> **测试依据**：PROJECT_RULES.md 第9章自动化审计配置

---

## 一、数据流转测试概述

### 1.1 测试目标

验证系统中各模块间的数据流转是否正确，包括：
- 入库/出库操作对库存数据的影响
- 基础数据变更对业务页面的同步影响
- 跨页面数据引用的完整性

### 1.2 数据流转关系图

```
┌─────────────────────────────────────────────────────────────────┐
│                        基础数据层                                │
├─────────────────┬─────────────────┬─────────────────────────────┤
│   供应商管理     │    库位管理      │      物料分类               │
│  (suppliers)    │  (locations)    │    (categories)            │
└────────┬────────┴────────┬────────┴────────────┬────────────────┘
         │                 │                      │
         ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                        库存数据层                                │
├─────────────────┬─────────────────┬─────────────────────────────┤
│    入库记录      │    出库记录      │      库存列表               │
│   (inbound)     │   (outbound)    │    (inventory)             │
└────────┬────────┴────────┬────────┴────────────┬────────────────┘
         │                 │                      │
         ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                        业务关联层                                │
├─────────────────┬─────────────────┬─────────────────────────────┤
│    检测项目      │     BOM清单      │      预警中心               │
│   (projects)    │     (bom)       │      (alerts)              │
└─────────────────┴─────────────────┴─────────────────────────────┘
```

---

## 二、数据流转测试项

### 2.1 入库→库存数据流转

| 测试ID | 测试项 | 触发操作 | 源页面 | 目标页面 | 预期结果 |
|:---|:---|:---|:---|:---|:---|
| FLOW-IN-001 | 入库增加库存 | 完成入库登记 | inbound-modal.html | inventory-list.html | 对应物料库存数量增加 |
| FLOW-IN-002 | 入库记录生成 | 完成入库登记 | inbound-modal.html | inbound.html | 入库记录列表新增一条记录 |
| FLOW-IN-003 | 供应商关联 | 选择供应商入库 | inbound-modal.html | suppliers.html | 供应商合作记录更新 |

### 2.2 出库→库存数据流转

| 测试ID | 测试项 | 触发操作 | 源页面 | 目标页面 | 预期结果 |
|:---|:---|:---|:---|:---|:---|
| FLOW-OUT-001 | 出库减少库存 | 完成出库领用 | outbound-modal.html | inventory-list.html | 对应物料库存数量减少 |
| FLOW-OUT-002 | 出库记录生成 | 完成出库领用 | outbound-modal.html | outbound.html | 出库记录列表新增一条记录 |
| FLOW-OUT-003 | 项目关联出库 | 关联检测项目出库 | outbound-modal.html | project-detail.html | 项目使用记录更新 |
| FLOW-OUT-004 | 库存不足拦截 | 出库数量超过库存 | outbound-modal.html | - | Toast提示"库存不足"，阻止提交 |

### 2.3 盘点→库存数据流转

| 测试ID | 测试项 | 触发操作 | 源页面 | 目标页面 | 预期结果 |
|:---|:---|:---|:---|:---|:---|
| FLOW-STK-001 | 盘点差异调整 | 确认盘点差异 | stocktaking-adjust-modal.html | inventory-list.html | 库存数量调整为盘点值 |
| FLOW-STK-002 | 盘点记录生成 | 完成盘点 | create-stocktaking-modal.html | stocktaking.html | 盘点记录列表新增一条记录 |

### 2.4 供应商数据流转

| 测试ID | 测试项 | 触发操作 | 源页面 | 目标页面 | 预期结果 |
|:---|:---|:---|:---|:---|:---|
| FLOW-SUP-001 | 供应商下拉同步 | 新增供应商 | suppliers.html | inbound-modal.html | 入库弹窗供应商下拉新增选项 |
| FLOW-SUP-002 | 供应商详情关联 | 查看供应商详情 | suppliers.html | inbound.html | 显示该供应商的所有入库记录 |

### 2.5 分类数据流转

| 测试ID | 测试项 | 触发操作 | 源页面 | 目标页面 | 预期结果 |
|:---|:---|:---|:---|:---|:---|
| FLOW-CAT-001 | 分类筛选同步 | 新增物料分类 | categories.html | inventory-list.html | 分类筛选下拉新增选项 |
| FLOW-CAT-002 | 分类删除校验 | 删除有物料的分类 | categories.html | - | Toast提示"该分类下存在物料，无法删除" |

### 2.6 BOM数据流转

| 测试ID | 测试项 | 触发操作 | 源页面 | 目标页面 | 预期结果 |
|:---|:---|:---|:---|:---|:---|
| FLOW-BOM-001 | BOM关联项目 | 创建检测项目选择BOM | create-project-modal.html | project-detail.html | 项目详情显示关联的BOM信息 |
| FLOW-BOM-002 | BOM物料状态 | 查看BOM详情 | bom-detail-modal.html | inventory-list.html | 显示各物料的库存状态标签 |

### 2.7 预警数据流转

| 测试ID | 测试项 | 触发操作 | 源页面 | 目标页面 | 预期结果 |
|:---|:---|:---|:---|:---|:---|
| FLOW-ALERT-001 | 预警规则触发 | 库存低于阈值 | inventory-list.html | alerts.html | 预警中心生成预警记录 |
| FLOW-ALERT-002 | 预警处理同步 | 处理预警 | alert-handle-modal.html | alert-history.html | 预警历史新增处理记录 |

---

## 三、数据引用完整性测试

### 3.1 下拉框数据引用

| 测试ID | 数据源 | 引用位置 | 预期行为 |
|:---|:---|:---|:---|
| REF-SUP-001 | mockData.suppliers | inbound-modal.html 供应商下拉 | 下拉选项与suppliers数组name字段一致 |
| REF-SUP-002 | mockData.suppliers | scrap.html 报废申请弹窗 | 下拉选项与suppliers数组name字段一致 |
| REF-LOC-001 | mockData.locations | inventory-list.html 库位筛选 | 筛选选项与locations数组name字段一致 |
| REF-LOC-002 | mockData.locations | inbound-modal.html 库位选择 | 下拉选项与locations数组name字段一致 |
| REF-CAT-001 | mockData.leafCategories | inventory-list.html 分类筛选 | 筛选选项与leafCategories数组一致 |
| REF-CAT-002 | mockData.leafCategories | consumable-config.html 分类下拉 | 下拉选项与leafCategories数组一致 |

### 3.2 表格数据引用

| 测试ID | 数据源 | 引用位置 | 预期行为 |
|:---|:---|:---|:---|
| REF-TBL-001 | mockData.inventory | inventory-list.html 物料列表 | 表格数据与inventory数组一致 |
| REF-TBL-002 | mockData.inboundRecords | inbound.html 入库记录列表 | 表格数据与inboundRecords数组一致 |
| REF-TBL-003 | mockData.outboundRecords | outbound.html 出库记录列表 | 表格数据与outboundRecords数组一致 |
| REF-TBL-004 | mockData.projects | projects.html 检测项目列表 | 表格数据与projects数组一致 |
| REF-TBL-005 | mockData.boms | bom.html BOM列表 | 表格数据与boms数组一致 |

---

## 四、跨页面状态同步测试

### 4.1 库存状态同步

| 测试ID | 触发场景 | 涉及页面 | 预期同步行为 |
|:---|:---|:---|:---|
| SYNC-STK-001 | 入库完成 | inventory-list.html, inventory-detail.html | 库存数量同步增加 |
| SYNC-STK-002 | 出库完成 | inventory-list.html, inventory-detail.html | 库存数量同步减少 |
| SYNC-STK-003 | 盘点调整完成 | inventory-list.html, inventory-detail.html | 库存数量同步调整 |

### 4.2 预警状态同步

| 测试ID | 触发场景 | 涉及页面 | 预期同步行为 |
|:---|:---|:---|:---|
| SYNC-ALERT-001 | 库存低于阈值 | inventory-list.html, alerts.html | 预警标签和预警记录同步生成 |
| SYNC-ALERT-002 | 预警处理完成 | alerts.html, alert-history.html | 预警状态同步更新 |

---

## 五、测试统计

| 测试类型 | 测试项数 |
|:---|:---:|
| 数据流转测试 | 17 |
| 数据引用完整性测试 | 10 |
| 跨页面状态同步测试 | 5 |
| **总计** | **32** |

---

*本测试清单用于验证COREONE系统的数据流转正确性*
