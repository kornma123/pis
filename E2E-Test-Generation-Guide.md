> **SUPERSEDED — DO NOT USE AS OPERATING INSTRUCTIONS.**
> 本文件的路由、模块、测试数量与生成流程仅作历史取证。当前规则见 `docs/agent-operating-contract.md`、活代码路由注册表和 `.claude/rules/coreone-guardrails.md`。

# COREONE E2E 测试模块生成指南

> **用途**: 指导按模块逐个生成 `.spec.ts` 文件，确保每个模块的测试代码与 `E2E-Coverage-Matrix.md` 一一对应，并融合角色权限矩阵、数据状态笛卡尔积、业务流程树、盲点分析的全部约束。
> **核心原则**: 场景数不设上限，矩阵 + 权限 + 笛卡尔积 + 业务流 + 盲点全部独立生成 `test()` 块，追求最大化覆盖。
> **致命约束**: 生成前必须核对前端实际路由。前端只有 17 个独立页面，没有 `/returns` `/scrap` `/transfer` 独立页面，这些功能是嵌入在其他页面中的。

---

## 零、前端路由与实际模块映射（生成前必须核对）

> ⚠️ **以下路由来自 `前端代码/src/App.tsx` 和 `AppSidebar.tsx`，是生成测试的唯一合法页面范围。**

| 路径 | 页面组件 | 模块名 | 独立页面? | 备注 |
|:---|:---|:---|:---:|:---|
| `/login` | `Login.tsx` | 认证与登录 | ✅ | |
| `/` | `Dashboard.tsx` | 仪表盘 | ✅ | |
| `/inventory` | `InventoryList.tsx` | 库存列表 | ✅ | 含详情弹窗、批量出库/报废弹窗、Tab切换 |
| `/stocktaking` | `Stocktaking.tsx` | 库存盘点 | ✅ | |
| `/inbound` | `Inbound.tsx` | 入库管理 | ✅ | 含直接/采购/退货/调拨入库 |
| `/outbound` | `Outbound.tsx` | 出库管理 | ✅ | 含项目/调拨/报废出库类型 |
| `/categories` | `Categories.tsx` | 物料分类 | ✅ | |
| `/materials` | `Materials.tsx` | 耗材管理 | ✅ | |
| `/suppliers` | `Suppliers.tsx` | 供应商管理 | ✅ | |
| `/locations` | `Locations.tsx` | 库位管理 | ✅ | |
| `/projects` | `Projects.tsx` | 检测项目 | ✅ | 含BOM选择 |
| `/bom` | `BOM.tsx` | BOM清单 | ✅ | |
| `/cost-analysis` | `CostAnalysis.tsx` | 物料成本分析 | ✅ | |
| `/reconciliation` | `Reconciliation.tsx` | 消耗对账 | ✅ | |
| `/alerts` | `Alerts.tsx` | 预警中心 | ✅ | |
| `/users` | `Users.tsx` | 用户管理 | ✅ | |
| `/roles` | `Roles.tsx` | 角色权限 | ✅ | |
| `/logs` | `Logs.tsx` | 操作日志 | ✅ | |

### 嵌入功能（无独立页面，测试需挂靠到宿主页面）

| 功能 | 宿主页面 | 嵌入方式 | 合法测试入口 |
|:---|:---|:---|:---|
| **退货管理** | `/outbound` (出库记录) | `type: 'return'` 出库类型 | `outbound.spec.ts` → 退货出库类型场景 |
| **报废管理** | `/inventory` (库存列表) | 批量报废弹窗 | `inventory-list.spec.ts` → 批量报废弹窗场景 |
| | `/outbound` (出库记录) | `type: 'scrap'` 出库类型 | `outbound.spec.ts` → 报废出库类型场景 |
| **调拨管理** | `/outbound` (出库记录) | `type: 'transfer'` 出库类型 | `outbound.spec.ts` → 调拨出库类型场景 |
| | `/inbound` (入库记录) | `type: 'transfer'` 入库记录 | `inbound.spec.ts` → 调拨入库类型场景 |
| **采购订单** | 无独立前端页面 | 仅在入库页弹窗中选择 | `inbound.spec.ts` → 采购入库场景 |
| **消耗跟踪** | `/inventory` (库存列表) | Tab切换"使用中"/"已耗尽" | `inventory-list.spec.ts` → Tab切换场景 |

### ❌ 不存在的独立页面（禁止生成对应 spec 文件）

- ~~`/returns`~~ → 不存在。退货是 outbound 的一种 type。
- ~~`/scrap`~~ → 不存在。报废是 inventory 弹窗或 outbound 的一种 type。
- ~~`/transfer`~~ → 不存在。调拨是 outbound/inbound 的一种 type。
- ~~`/purchase-orders`~~ → 不存在。采购订单只在入库弹窗中出现。

---

## 一、输入文档清单（生成前必须通读）

| # | 文档 | 用途 | 必看章节 |
|---|------|------|---------|
| 1 | [`E2E-Coverage-Matrix.md`](E2E-Coverage-Matrix.md) | 主矩阵：模块 × 功能点 × 8 维度 | 目标模块所在章节 |
| 2 | [`E2E-Role-Permission-Matrix.md`](E2E-Role-Permission-Matrix.md) | 越权测试：敏感功能点 × 禁止角色 | 与目标模块对应的权限章节 |
| 3 | [`E2E-Data-State-Cartesian-Matrix.md`](E2E-Data-State-Cartesian-Matrix.md) | 数据状态组合 | 目标操作章节 |
| 4 | [`E2E-Business-Flow-Tree.md`](E2E-Business-Flow-Tree.md) | 业务流：主流程 × 分支 | 与目标模块相关的流程 |
| 5 | [`E2E-Blind-Spot-Analysis.md`](E2E-Blind-Spot-Analysis.md) | 盲点补充 | 与目标模块相关的盲点 |
| 6 | `前端代码/src/App.tsx` | **前端路由清单** | 确认模块是否有独立页面 |
| 7 | `前端代码/src/components/layout/AppSidebar.tsx` | **侧边栏菜单清单** | 确认模块入口可见性 |
| 8 | `后端代码/server/src/routes/模块-v1.1.ts` | 后端路由源码 | 对应路由文件 |

---

## 二、输出规范（每个 `.spec.ts` 必须遵守）

### 2.1 文件命名规则

```
前端代码/e2e/{模块英文名}.spec.ts
```

**必须以** `App.tsx` 中的 `<Route path="/xxx">` **为唯一命名依据**：

| 路径 | 文件名 | 说明 |
|:---|:---|:---|
| `/inventory` | `inventory-list.spec.ts` | 库存列表（含详情弹窗、批量操作） |
| `/stocktaking` | `stocktaking.spec.ts` | 库存盘点 |
| `/inbound` | `inbound.spec.ts` | 入库管理（含退货入库、调拨入库） |
| `/outbound` | `outbound.spec.ts` | 出库管理（含退货/报废/调拨出库类型） |
| `/projects` | `projects.spec.ts` | 检测项目 |
| `/bom` | `bom.spec.ts` | BOM清单 |
| `/materials` | `materials.spec.ts` | 耗材管理 |
| `/categories` | `categories.spec.ts` | 物料分类 |
| `/suppliers` | `suppliers.spec.ts` | 供应商管理 |
| `/locations` | `locations.spec.ts` | 库位管理 |
| `/alerts` | `alerts.spec.ts` | 预警中心 |
| `/users` | `users.spec.ts` | 用户管理 |
| `/roles` | `roles.spec.ts` | 角色权限 |
| `/logs` | `logs.spec.ts` | 操作日志 |
| `/cost-analysis` | `cost-analysis.spec.ts` | 物料成本分析 |
| `/reconciliation` | `reconciliation.spec.ts` | 消耗对账 |
| `/` | `dashboard.spec.ts` | 仪表盘 |
| `/login` | `auth.spec.ts` | 认证与登录 |

### 2.2 代码结构模板

```typescript
import { test, expect, Page } from '@playwright/test'

const FE_BASE = 'http://localhost:8080'
const API_BASE = 'http://127.0.0.1:3001/api/v1'

async function loginAs(page: Page, role: string) { ... }
async function apiLogin(role: string): Promise<string> { ... }
async function apiFetch(token, method, path, body?) { ... }

// 模块特定 helpers
async function getAnyMaterialId(token) { ... }
async function cleanupTestData(token) { ... }

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// ── 1. 主矩阵场景 (MX-Ry-Cz)
test.describe('模块名 -> 功能点A', () => {
  test('MX-Ry-Cz. ① 正常用例：...', async ({ page }) => { ... })
})

// ── 2. 角色权限矩阵补充 (TC-PERM-xxx)
test.describe('模块名 -> 角色权限矩阵补充', () => {
  test('TC-PERM-xxx. ROLE METHOD /path 应返回 403', async () => { ... })
})

// ── 3. 数据状态笛卡尔积 (IN/OUT/STK/SCR/TRF-xxx)
test.describe('模块名 -> 数据状态笛卡尔积', () => {
  test('OUT-01. 场景摘要', async () => { ... })
})

// ── 4. 业务流程树 (BF-xx-Bx)
test.describe('模块名 -> 业务流程树', () => {
  test('BF-02-B3. 场景摘要', async ({ page }) => { ... })
})
```

### 2.3 嵌入功能的测试归属规则

| 嵌入功能 | 必须写入的文件 | 禁止写入的文件 | 测试入口 |
|:---|:---|:---|:---|
| 退货入库 | `inbound.spec.ts` | ~~`returns.spec.ts`~~ | 入库页 → 创建退货入库单 |
| 退货出库 | `outbound.spec.ts` | ~~`returns.spec.ts`~~ | 出库页 → type=return |
| 报废出库 | `outbound.spec.ts` | ~~`scraps.spec.ts`~~ | 出库页 → type=scrap |
| 批量报废弹窗 | `inventory-list.spec.ts` | ~~`scraps.spec.ts`~~ | 库存列表页 → 勾选 → 批量报废 |
| 调拨出库 | `outbound.spec.ts` | ~~`transfers.spec.ts`~~ | 出库页 → type=transfer |
| 调拨入库 | `inbound.spec.ts` | ~~`transfers.spec.ts`~~ | 入库页 → type=transfer |
| 采购入库 | `inbound.spec.ts` | ~~`purchase-orders.spec.ts`~~ | 入库页 → 采购入库单 |
| 消耗跟踪Tab | `inventory-list.spec.ts` | ~~`depletion.spec.ts`~~ | 库存列表页 → Tab切换 |

---

## 三、子任务拆分（17 个独立页面 + 嵌入功能，逐个产出）

### 批次1：核心库存操作（最高优先级）

| # | 模块 | 文件名 | 矩阵 | 权限 | 笛卡尔积 | 业务流 | 盲点 | **预估总计** | 状态 |
|---|------|--------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 5 | 入库管理 | `inbound.spec.ts` | 53 | 11 | 20 | 9 | 15 | **108** | ✅ 已完成(64) |
| 6 | 出库管理 | `outbound.spec.ts` | 30 | 4 | 25 | 10 | 15 | **84** | ✅ 已完成(67) |
| 7 | 库存盘点 | `stocktaking.spec.ts` | 25 | 8 | 20 | 9 | 12 | **74** | ✅ 已完成(56) |
| 3 | 库存列表 | `inventory-list.spec.ts` | 55 | 5 | 8 | 8 | 15 | **91** | ✅ 已完成(38) |
| 4 | 库存详情 | `inventory-detail.spec.ts` | 25 | 3 | 8 | 7 | 8 | **51** | ✅ 已完成 |

> 注：退货/报废/调拨的嵌入功能测试已分别合并到 inbound/outbound/inventory-list 中。

### 批次2：基础数据管理

| # | 模块 | 文件名 | 矩阵 | 权限 | 笛卡尔积 | 业务流 | 盲点 | **预估总计** | 状态 |
|---|------|--------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 14 | 物料分类 | `categories.spec.ts` | 30 | 10 | 0 | 9 | 12 | **61** | ✅ 已完成(48) |
| 15 | 耗材管理 | `materials.spec.ts` | 50 | 15 | 0 | 9 | 18 | **92** | ✅ 已完成(58) |
| 21 | 供应商管理 | `suppliers.spec.ts` | 35 | 10 | 0 | 8 | 12 | **65** | ✅ 已完成(58) |
| 22 | 库位管理 | `locations.spec.ts` | 40 | 10 | 0 | 8 | 12 | **70** | ✅ 已完成(54) |

### 批次3：业务配置与项目

| # | 模块 | 文件名 | 矩阵 | 权限 | 笛卡尔积 | 业务流 | 盲点 | **预估总计** | 状态 |
|---|------|--------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 10 | 检测项目 | `projects.spec.ts` | 45 | 15 | 0 | 8 | 15 | **83** | ✅ 已完成(52) |
| 12 | BOM清单 | `bom.spec.ts` | 40 | 15 | 0 | 9 | 12 | **76** | ✅ 已完成(51) |

### 批次4：预警与报表

| # | 模块 | 文件名 | 矩阵 | 权限 | 笛卡尔积 | 业务流 | 盲点 | **预估总计** | 状态 |
|---|------|--------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 16 | 预警中心 | `alerts.spec.ts` | 30 | 0 | 0 | 9 | 10 | **49** | ✅ 已完成(39) |
| 20 | 成本分析 | `cost-analysis.spec.ts` | 30 | 6 | 0 | 7 | 8 | **51** | ✅ 已完成(39) |
| 28 | 消耗对账 | `reconciliation.spec.ts` | 45 | 12 | 0 | 8 | 12 | **77** | ✅ 已完成(37) |

### 批次5：系统管理

| # | 模块 | 文件名 | 矩阵 | 权限 | 笛卡尔积 | 业务流 | 盲点 | **预估总计** | 状态 |
|---|------|--------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | 认证与登录 | `auth.spec.ts` | 20 | 0 | 0 | 8 | 10 | **38** | ✅ 已完成(38) |
| 2 | 仪表盘 | `dashboard.spec.ts` | 18 | 0 | 0 | 5 | 8 | **31** | ✅ 已完成(35) |
| 23 | 用户管理 | `users.spec.ts` | 30 | 20 | 0 | 8 | 10 | **68** | ✅ 已完成(45) |
| 24 | 角色权限 | `roles.spec.ts` | 30 | 20 | 0 | 9 | 10 | **69** | ✅ 已完成(51) |
| 25 | 操作日志 | `logs.spec.ts` | 30 | 10 | 0 | 7 | 8 | **55** | ✅ 已完成(36) |

---

## 四、已生成文件清单与修正记录

| 文件名 | 模块 | 测试数 | 验证状态 | 问题记录 |
|:---|:---|:---:|:---:|:---|
| `inbound.spec.ts` | 入库管理 | 64 | ✅ | 无 |
| `outbound.spec.ts` | 出库管理 | 67 | ✅ | 无 |
| `stocktaking.spec.ts` | 库存盘点 | 56 | ✅ | 无 |
| `inventory-list.spec.ts` | 库存列表 | 38 | ✅ | 无 |
| `inventory-detail.spec.ts` | 库存详情 | 22 | ✅ | 无 |
| `projects.spec.ts` | 检测项目 | 52 | ✅ | 无 |
| `materials.spec.ts` | 耗材管理 | 58 | ✅ | 无 |
| `categories.spec.ts` | 物料分类 | 48 | ✅ | 无 |
| `suppliers.spec.ts` | 供应商管理 | 58 | ✅ | 无 |
| `locations.spec.ts` | 库位管理 | 54 | ✅ | 无 |
| `bom.spec.ts` | BOM清单 | 51 | ✅ | 无 |
| `alerts.spec.ts` | 预警中心 | 39 | ✅ | 无 |
| `cost-analysis.spec.ts` | 物料成本分析 | 39 | ✅ | 无 |
| `reconciliation.spec.ts` | 消耗对账 | 37 | ✅ | 无 |
| `users.spec.ts` | 用户管理 | 45 | ✅ | 无 |
| `roles.spec.ts` | 角色权限 | 51 | ✅ | 无 |
| `logs.spec.ts` | 操作日志 | 36 | ✅ | 无 |
| `dashboard.spec.ts` | 仪表盘 | 35 | ✅ | 无 |
| `auth.spec.ts` | 认证与登录 | 38 | ✅ | 无 |
| ~~`returns.spec.ts`~~ | ~~退货管理~~ | ~~23~~ | ~~❌~~ | **前端无 `/returns` 页面，已删除/合并到 outbound.spec.ts** |
| ~~`scraps.spec.ts`~~ | ~~报废管理~~ | ~~56~~ | ~~⚠️~~ | **前端无 `/scrap` 页面，已合并到 inventory-list/outbound** |
| ~~`transfers.spec.ts`~~ | ~~调拨管理~~ | ~~36~~ | ~~⚠️~~ | **前端无 `/transfer` 页面，已合并到 inbound/outbound** |

**当前总计: 17 个独立页面 spec 文件，共计 848 个 tests**

---

## 五、生成 checklist（每个模块执行前勾选）

- [ ] **已核对** `App.tsx` 确认目标模块有独立页面（或确认为嵌入功能）
- [ ] **已核对** `AppSidebar.tsx` 确认模块在菜单中的可见性
- [ ] 已阅读目标模块在 `E2E-Coverage-Matrix.md` 中的全部场景
- [ ] 已阅读 `E2E-Role-Permission-Matrix.md` 中对应章节的全部权限场景
- [ ] 已阅读 `E2E-Data-State-Cartesian-Matrix.md` 中对应操作的全部数据组合
- [ ] 已阅读 `E2E-Business-Flow-Tree.md` 中相关流程的全部分支
- [ ] 已阅读 `E2E-Blind-Spot-Analysis.md` 中对应模块的全部盲点
- [ ] 已阅读 `后端代码/server/src/routes/模块-v1.1.ts`
- [ ] 已独立生成角色权限矩阵中全部 TC-PERM 场景（不省略、不合并）
- [ ] 已独立生成笛卡尔积全部场景
- [ ] 已独立生成业务流程树全部分支场景
- [ ] 已添加 `test.beforeEach` 清理逻辑
- [ ] 已运行 `npx playwright test 文件名 --list` 验证 test 数量
- [ ] **已自检**: 所有 `page.goto()` 的路径必须在 `App.tsx` 的 `<Route>` 中存在

---

*文档版本: v1.4*
*最后更新: 2026-05-14*
*修正内容: 全部17个独立页面模块已生成完毕，补充批次4~5完成状态及最终文件清单*
