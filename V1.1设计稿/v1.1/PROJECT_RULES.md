# COREONE 项目专属上下文

## 1. 项目基本信息

- **项目名称**：COREONE 实验室耗材管理系统
- **项目类型**：后台管理系统
- **当前阶段**：高保真原型验证，包含 8 个模块，约 20 个页面、25 个弹窗
- **设计版本**：v1.1

## 2. 技术栈与规范

- **UI 框架**：HTML + CSS（自定义设计系统）
- **设计规范**：严格遵循项目根目录下的 `DESIGN.md`
- **Mock 方案**：纯前端内存 Mock，通过 `mock-config.js` 管理全局数据
- **页面结构**：多文件 HTML，通过链接跳转
- **脚本模式**：`<script type="module">` 通过 HTTP Server 运行，支持 ES Module 导入

## 3. 业务模块与页面清单

### 模块1：库存管理模块

| 页面 | 文件路径 | 功能描述 |
|------|----------|----------|
| 库存列表 | `pages/inventory-list.html` | 查看所有物料库存状态和预警 |
| 库存详情 | `pages/inventory-detail.html` | 单个物料详细信息和流转记录 |
| 入库记录 | `pages/inbound.html` | 查看和管理所有入库操作 |
| 出库记录 | `pages/outbound.html` | 查看和管理所有出库操作 |
| 库存盘点 | `pages/stocktaking.html` | 执行库存盘点和差异调整 |
| 退货管理 | `pages/return.html` | 处理物料退货和退款记录 |
| 报废管理 | `pages/scrap.html` | 处理过期或损坏物料报废 |

**关联弹窗**：
- `modals/inventory-detail-modal.html` - 库存详情弹窗
- `modals/inbound-modal.html` - 入库登记弹窗
- `modals/inbound-detail-modal.html` - 入库详情弹窗
- `modals/outbound-modal.html` - 出库领用弹窗
- `modals/outbound-detail-modal.html` - 出库详情弹窗
- `modals/create-stocktaking-modal.html` - 新建盘点弹窗
- `modals/stocktaking-detail-modal.html` - 盘点详情弹窗
- `modals/stocktaking-adjust-modal.html` - 处理差异弹窗
- `modals/scrap-apply-modal.html` - 报废申请弹窗

### 模块2：检测项目模块

| 页面 | 文件路径 | 功能描述 |
|------|----------|----------|
| 检测项目 | `pages/projects.html` | 管理检测项目和BOM关联 |
| 项目详情 | `pages/project-detail.html` | 查看项目详情和成本分析 |

**关联弹窗**：
- `modals/create-project-modal.html` - 新建项目弹窗
- `modals/edit-project-modal.html` - 编辑项目弹窗

### 模块3：BOM管理模块

| 页面 | 文件路径 | 功能描述 |
|------|----------|----------|
| BOM清单 | `pages/bom.html` | 管理物料清单和成本配置 |
| BOM版本 | `pages/bom-versions.html` | 查看BOM历史版本和变更 |

**关联弹窗**：
- `modals/create-bom-modal.html` - 新建BOM弹窗
- `modals/edit-bom-modal.html` - 编辑BOM弹窗
- `modals/bom-detail-modal.html` - BOM详情弹窗
- `modals/add-bom-modal.html` - 添加BOM弹窗
- `modals/edit-bom-item-modal.html` - 编辑物料弹窗

### 模块4：基础数据模块

| 页面 | 文件路径 | 功能描述 |
|------|----------|----------|
| 物料分类 | `pages/categories.html` | 管理三级物料分类体系 |
| 耗材配置 | `pages/consumable-config.html` | 配置耗材属性和关联信息 |

**关联弹窗**：
- `modals/create-category-modal.html` - 新建分类弹窗
- `modals/edit-category-modal.html` - 编辑分类弹窗
- `modals/create-consumable-modal.html` - 新增耗材弹窗
- `modals/edit-consumable-modal.html` - 编辑耗材弹窗
- `modals/consumable-detail-modal.html` - 耗材详情弹窗

### 模块5：预警管理模块

| 页面 | 文件路径 | 功能描述 |
|------|----------|----------|
| 规则配置 | `pages/rules.html` | 配置库存预警规则和阈值 |
| 预警中心 | `pages/alerts.html` | 查看和处理库存预警信息 |
| 预警历史 | `pages/alert-history.html` | 查看历史预警和处理记录 |

**关联弹窗**：
- `modals/create-rule-modal.html` - 新建规则弹窗
- `modals/edit-rule-modal.html` - 编辑规则弹窗
- `modals/alert-handle-modal.html` - 处理预警弹窗
- `modals/alert-history-detail-modal.html` - 预警详情弹窗

### 模块6：报表统计模块

| 页面 | 文件路径 | 功能描述 |
|------|----------|----------|
| 成本报表 | `pages/cost-report.html` | 项目成本和库存成本分析 |
| 物料成本分析 | `pages/cost-analysis.html` | 物料成本多维度分析 |

### 模块7：系统管理模块

| 页面 | 文件路径 | 功能描述 |
|------|----------|----------|
| 供应商管理 | `pages/suppliers.html` | 管理供应商信息和合作记录 |
| 库位管理 | `pages/locations.html` | 管理仓库库位和存储区域 |
| 用户管理 | `pages/users.html` | 管理系统用户和权限 |

## 4. Mock 数据模型摘要

从 `mock-config.js` 中提取关键数据结构：

```javascript
{
  materials: {
    [categoryId]: [
      {
        id: string,        // 物料ID，如 'MAT-001'
        code: string,      // 物料编码
        name: string,      // 物料名称
        spec: string,      // 规格
        unit: string,      // 单位
        price: number,     // 单价
        stock: number,     // 库存数量
        location: string,  // 存放位置
        supplier: string,  // 供应商
        status: string     // 状态：active/inactive
      }
    ]
  },
  
  categoryMap: {
    [categoryId]: {
      name: string,        // 分类名称
      path: string         // 分类路径，如 '试剂类 > HE染色试剂 > 苏木素染液'
    }
  },
  
  leafCategories: [
    {
      id: string,          // 分类ID
      name: string,        // 分类名称
      path: string         // 分类路径
    }
  ],
  
  suppliers: [
    {
      id: string,          // 供应商ID
      name: string,        // 供应商名称
      contact: string,     // 联系人
      phone: string,       // 联系电话
      address: string,     // 地址
      status: string       // 状态
    }
  ],
  
  locations: [
    {
      id: string,          // 库位ID
      code: string,        // 库位编码
      name: string,        // 库位名称
      zone: string,        // 区域
      capacity: number,    // 容量
      used: number         // 已用
    }
  ]
}
```

## 5. 页面跳转关系图

```
库存列表 (inventory-list.html)
    ├── → 库存详情 (inventory-detail.html)
    ├── → 入库记录 (inbound.html)
    ├── → 出库记录 (outbound.html)
    ├── → 库存盘点 (stocktaking.html)
    ├── → 退货管理 (return.html)
    └── → 报废管理 (scrap.html)

入库记录 (inbound.html)
    ├── ← 库存列表 (inventory-list.html)
    └── → 供应商管理 (suppliers.html)

出库记录 (outbound.html)
    ├── ← 库存列表 (inventory-list.html)
    └── → 检测项目 (projects.html)

检测项目 (projects.html)
    ├── → 项目详情 (project-detail.html)
    └── → BOM清单 (bom.html)

项目详情 (project-detail.html)
    ├── ← 检测项目 (projects.html)
    └── → BOM清单 (bom.html)

BOM清单 (bom.html)
    ├── ← 项目详情 (project-detail.html)
    └── → BOM版本 (bom-versions.html)

物料分类 (categories.html)
    └── → 耗材配置 (consumable-config.html)

耗材配置 (consumable-config.html)
    └── → 规则配置 (rules.html)

规则配置 (rules.html)
    └── → 预警中心 (alerts.html)

预警中心 (alerts.html)
    ├── ← 规则配置 (rules.html)
    └── → 预警历史 (alert-history.html)

预警历史 (alert-history.html)
    ├── ← 预警中心 (alerts.html)
    └── → 成本报表 (cost-report.html)

成本报表 (cost-report.html)
    ├── → 检测项目 (projects.html)
    ├── → BOM清单 (bom.html)
    └── → 供应商管理 (suppliers.html)

供应商管理 (suppliers.html)
    ├── ← 入库记录 (inbound.html)
    ├── ← 退货管理 (return.html)
    └── → 库位管理 (locations.html)

库位管理 (locations.html)
    └── → 用户管理 (users.html)
```

## 6. 核心数据实体关系

```
┌─────────────────┐     ┌─────────────────┐
│   物料分类       │     │    供应商       │
│  (categories)   │     │  (suppliers)    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       │
┌─────────────────┐              │
│     物料        │◄─────────────┘
│  (materials)    │
└────────┬────────┘
         │
    ┌────┴────┬────────────┐
    ▼         ▼            ▼
┌────────┐ ┌────────┐ ┌────────┐
│ 入库   │ │ 出库   │ │ 盘点   │
│记录    │ │ 记录   │ │ 记录   │
└────────┘ └────┬───┘ └────────┘
              │
              ▼
       ┌─────────────────┐
       │   检测项目       │
       │   (projects)    │
       └────────┬────────┘
                │
                ▼
       ┌─────────────────┐
       │     BOM         │
       │  (物料清单)     │
       └─────────────────┘
```

## 7. 设计规范要点

### 7.1 色彩系统
- **主色**：`#3b82f6` (blue-500)
- **成功色**：`#22c55e` (green-500)
- **警告色**：`#f59e0b` (amber-500)
- **危险色**：`#ef4444` (red-500)

### 7.2 弹窗规范
- 必须支持三种关闭方式：关闭按钮、点击遮罩、ESC键
- 弹窗打开时锁定背景滚动
- 弹窗打开后自动聚焦第一个可输入元素
- z-index：overlay=1, container=2

### 7.3 交互规范
- 所有操作必须有Toast反馈
- 表单提交需防重复点击
- 列表需支持搜索、筛选、分页
- 空状态需显示友好提示

## 8. 文件结构

```
v1.1/
├── index.html              # 验收入口页面
├── DESIGN.md               # 设计规范文档
├── PROJECT_RULES.md        # 项目上下文（本文件）
├── mock/
│   └── mock-config.js      # Mock数据配置
├── shared/
│   └── styles.css          # 共享样式
├── pages/
│   ├── inventory-list.html
│   ├── inventory-detail.html
│   ├── inbound.html
│   ├── outbound.html
│   ├── stocktaking.html
│   ├── return.html
│   ├── scrap.html
│   ├── projects.html
│   ├── project-detail.html
│   ├── bom.html
│   ├── bom-versions.html
│   ├── categories.html
│   ├── consumable-config.html
│   ├── rules.html
│   ├── alerts.html
│   ├── alert-history.html
│   ├── cost-report.html
│   ├── cost-analysis.html
│   ├── suppliers.html
│   ├── locations.html
│   └── users.html
└── modals/
    └── [25个弹窗文件]
```
## 9. 自动化审计配置（供 AI 使用）

> 本章节用于指导 AI 生成细化到每条数据和每个交互的验收清单及审计报告。

### 9.1 数据引用完整性检查点

对于 `mock-config.js` 中定义的以下数据源，AI 必须验证所有下拉框、表格列、标签是否动态引用：

| 数据源路径 | 应出现的页面/弹窗 | 检查内容 |
| :--- | :--- | :--- |
| `suppliers` 数组 | `inbound-modal.html`, `scrap-apply-modal.html`, `suppliers.html` | 供应商下拉框选项应完全来自此数组，且 `name` 字段显示正确 |
| `locations` 数组 | `inventory-list.html` 筛选区, `inbound-modal.html` 库位选择 | 库位下拉框选项应与 `locations` 的 `name` 一致 |
| `leafCategories` 数组 | `categories.html`, `consumable-config.html`, `create-project-modal.html` | 三级分类树或下拉框应基于此数据生成 |
| 物料状态枚举 | 所有显示物料状态的标签 | 状态标签文本应为 `active`→"启用"，`inactive`→"停用"（或按实际定义） |

### 9.2 跨页面状态同步检查点

| 触发操作 | 源页面/弹窗 | 影响的页面/数据 | 预期同步行为 |
| :--- | :--- | :--- | :--- |
| 完成入库 | `inbound-modal.html` 提交 | `inventory-list.html` 中对应物料的 `stock` 字段 | `stock` 数量增加入库量，列表实时刷新 |
| 完成出库 | `outbound-modal.html` 提交 | `inventory-list.html` 中对应物料的 `stock` 字段 | `stock` 数量减少出库量，列表实时刷新 |
| 处理盘点差异 | `stocktaking-adjust-modal.html` 提交 | `inventory-list.html` 中对应物料的 `stock` 字段 | `stock` 调整为盘点后的实际数量 |
| 修改物料分类 | `edit-category-modal.html` 提交 | `categories.html` 分类树, `inventory-list.html` 分类筛选 | 分类名称和层级在所有页面同步更新 |
| 新增供应商 | `suppliers.html` 新建 | `inbound-modal.html`, `scrap-apply-modal.html` 的供应商下拉框 | 下拉框选项自动包含新供应商 |

### 9.3 弹窗功能完整性检查模板（适用于所有25个弹窗）

对于 `PROJECT_RULES.md` 第3章列出的每一个弹窗文件，AI 必须逐一验证：

- [ ] 支持点击右上角关闭按钮关闭
- [ ] 支持点击背景遮罩关闭
- [ ] 支持按下 ESC 键关闭
- [ ] 打开时 `document.body.style.overflow` 被设置为 `hidden`
- [ ] 关闭时 `document.body.style.overflow` 恢复为 `''`
- [ ] 打开后焦点自动移至第一个可聚焦元素（input, select, button）
- [ ] 出现和消失有 `transition` 过渡动画

### 9.4 边界与异常场景检查点

| 场景 | 涉及页面 | 预期表现 |
| :--- | :--- | :--- |
| 物料列表为空 | `inventory-list.html` | 显示空状态插画 + “暂无物料数据” + “去新增”按钮 |
| 入库记录为空 | `inbound.html` | 显示空状态提示 |
| 出库时库存不足 | `outbound-modal.html` 提交 | Toast 提示“库存不足”，阻止出库 |
| 删除被引用的物料分类 | `categories.html` 删除操作 | Toast 提示“该分类下存在物料，无法删除” |
| 网络请求失败（模拟） | 所有异步操作 | 显示 Toast 错误提示，按钮恢复可用状态 |

### 9.5 审计报告输出增强指令

当 AI 以 `interaction-auditor-coreone` 身份输出报告时，**必须**为每一个问题标注以下元数据：

- **规范依据**：引用 `PROJECT_RULES.md` 的具体章节号
- **涉及文件**：使用相对于项目根目录的完整路径，如 `pages/inventory-list.html`
- **涉及数据字段**：如 `mockData.materials[categoryId][0].stock`
- **复现步骤**：1-2句话描述如何触发该问题