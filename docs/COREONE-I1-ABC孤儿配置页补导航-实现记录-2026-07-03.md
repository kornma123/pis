# COREONE · I-1 ABC 孤儿配置页补导航 —— 实现记录

> **性质**：实现项（源自 ABC 前端处置清单 §五 I-1，PM 已拍「配置类保留」）。**纯前端·零后端·golden 天然零回归**。
> **出发点**：`origin/master` tip `877b3932`（2026-07-03，PR #61 已合）。
> **改动**：仅 2 个前端文件——`前端代码/src/lib/permissions.ts`（`NAV_PATH_MODULE` + `ROLE_MENU_MAP`）、`前端代码/src/components/layout/AppSidebar.tsx`（`ALL_MAIN_MENU`）。
> **方法**：工作模型四段（先摊后端权限真相→改码→真跑端到端→异构双引擎独立复核）。

---

## 一、问题

ABC 前端处置清单（`docs/COREONE-ABC前端页面处置清单-审计与废弃候选-2026-07-03.md`）审计发现：18 个 `/abc/*` 路由里 **14 个是孤儿路由**——在 `App.tsx` 注册了，但侧栏 `AppSidebar.tsx` 无入口、也不在 `permissions.ts` 的 `NAV_PATH_MODULE`/`ROLE_MENU_MAP` 里，**普通操作点不到（只能手敲 URL）**。其中 6 个是**有独有录入能力的配置页**——它们是 ABC 方法论参数在系统里的唯一录入入口。PM 已拍板「配置类页保留」，故本实现项把这些够不着的配置页接回侧栏。

## 二、接回的 8 个页面

| 侧栏文案 | 路由 | 页面（组件） | 独有能力 |
|---|---|---|---|
| 成本动因 | `/abc/cost-drivers` | CostDriverList | 成本动因主数据（含阶梯费率）唯一 CRUD |
| 成本池 | `/abc/cost-pools` | CostPoolList | 手工成本调整录入 + 归集触发 + 完全吸收对账唯一页 |
| 收费映射配置 | `/abc/fee-mappings` | FeeMappingConfig | BOM↔收费标准绑定唯一录入 UI |
| 成本预算 | `/abc/budgets` | BudgetManagement | 月度成本预算录入唯一 UI |
| 质量成本 | `/abc/quality-costs` | QualityCostAnalysis | ISO 15189 质量成本四分类录入唯一 UI |
| 季度成本调整 | `/abc/quarterly-adjustment` | QuarterlyAdjustment | 预提 vs 实际季度差异调整录入 + 审核唯一 UI |
| 成本异常台账 | `/abc/alerts` | CostAlerts | 成本异常「解决/忽略/重试」操作台（成本看板深链下游，补一级入口） |
| 成本审计追溯 | `/abc/audit` | AuditTrail | 成本域变更前后审计追溯 UI（挂"成本管理"分组） |

> 文案「说人话」，不含黑话。独立复核（3-lens 面板）提了 2 项 LOW 命名消歧并采纳：`成本异常台账`（原「成本异常中心」，避免与「预警中心」的"中心"撞尾）、`成本审计追溯`（原「成本操作审计」，避免与系统级「操作日志」的"操作"重叠；后者读另一张表、无成本域 before/after diff）。

## 三、权限映射（可达性 ⟺ 后端授权，逐条对齐）

前端可见性规则（能力驱动用户）：路径出现在侧栏 ⟺ `canAccess(NAV_PATH_MODULE[path], 'R')`。故映射的模块码必须满足**「侧栏可见 ⟹ 该页主 GET 不 403」**（P0 护栏：别放行了前端却被后端 403）。

后端守卫真相（读自 `abc-v1.1.ts` / `cost-adjustment-v1.1.ts` / `app.ts`）：
- `/api/v1/abc` 挂载守卫 = `abc_dashboard:R`（所有 `/abc/*` 请求先过这道）；abc 路由内读 = `requireCostWorkbenchRead`(=`abc_dashboard:R`)，写 = `requireCostWrite`(=`abc_config:W`)。
- `/api/v1/cost-adjustments` 挂载 = `cost_analysis:R`，写 = `cost_analysis:W`（撑 `/abc/quarterly-adjustment`）。

| 路径 | `NAV_PATH_MODULE` | 页面主 GET 的载入门 | 写门 |
|---|---|---|---|
| cost-drivers/cost-pools/fee-mappings/budgets/quality-costs | `abc_config` | `abc_dashboard:R` | `abc_config:W` |
| quarterly-adjustment | `abc_config` | `cost_analysis:R` | `cost_analysis:W` |
| alerts | `abc_dashboard` | `abc_dashboard:R` | `abc_config:W` |
| audit | `abc_dashboard` | `abc_dashboard:R` | （只读） |

配置类映 `abc_config` 与既有 `/abc/activity-centers` 一致；alerts/audit 按其后端读权限映 `abc_dashboard`。

**为什么映 `abc_config` 读端点不会 403（共旅不变量）**：真实角色矩阵（`rbac-matrix.ts` `SEED_MATRIX` + 运行库 roles 表）里，**持 `abc_config` 的角色必同时持 `abc_dashboard:R`**（`lab_director`：`abc_config:W`+`abc_dashboard:R`；`admin`：全 W）——这是权限设计的自然属性（你不能一边配置 ABC、一边看不了 ABC 看板）。季度调整同理：持 `abc_config` 者亦均持 `cost_analysis:R`。故「配置类映 abc_config」在真实角色下侧栏可见 ⟹ 读端点授权。已在 `NAV_PATH_MODULE` 注释固化此假设。

## 四、验证（真跑端到端）

- **tsc**：`npx tsc --noEmit` 绿（exit 0）。
- **build**：`npx vite build` 绿（✓ built）。⚠️ 附记：共享 `node_modules` 原缺 `@tanstack/react-query`（package.json 已声明），`--no-save --no-package-lock` 补装后构建通过；此为共享环境既有缺装，与本改动无关。
- **前端 vitest**：`permissions.test.ts`(15)+`permissions.capabilities.test.ts`(7) 全绿；整仓 5 个失败与 clean-master 基线**完全一致**（`utils.test.ts` formatDate×2、`CostDashboard.adjustments.render.test.tsx`×2、`QualityCostAnalysis.test.tsx`×1，均本改动未触及的既有失败），**本改动零新增失败**。
- **后端 vitest（required check）**：89 files / 757 tests 全绿；ABC golden(13)+hemujia-purelab-golden(5)+partner-revenue-golden(5) 绿，**golden ¥13,152 + ¥27,870 零回归**（本改动纯前端，天然不触后端）。
- **真跑端到端**（起前后端·admin 登录）：
  - 8 个新入口全部出现在侧栏、文案正确；逐个点开——8 页全部渲染出 H1、**无 403、无 error boundary、零 console 报错**。
  - API 授权：admin 对 8 页主 GET 全部 200；`成本动因`、`成本预算`创建**落库**（GET 复查在列 + `成本操作审计`页显示两条「创建 · admin · 时间」审计留痕）。
  - **可达性 ⟺ 授权不变量**（逐 6 个种子用户 × 8 路径，实测 HTTP）：**0 破链**。admin 见 8/8 且全授权；其余种子角色（仓管/技术员/病理/采购/财务）**因无 `abc_config`/`abc_dashboard` 均见 0/8**——与后端 403 一致，**无破链**。这与既有 `/abc/activity-centers` 对这些角色的行为完全相同。

> **注（运行库口径）**：运行库里 `财务专员` 角色只有 `{cost_analysis, logs}`（历史扁平权限数组），**不含 ABC 模块**；且**无 `实验室主任` 种子用户**。故当前种子系统里实际能看到/使用这 8 页的是 **admin**（及日后若建 `lab_director` 用户）。`ROLE_MENU_MAP` 里给 finance 补这 8 条是对齐 `SEED_MATRIX` 的角色设计意图（legacy 兜底仅在 capabilities 缺失时用；真实登录都带 capabilities，按能力显隐）。

## 五、独立复核（异构双引擎，机制5）

- **codex（异构轴，`-s read-only -c model_reasoning_effort=high`，拆多请求）**：
  - 破链专审：正确指出「若存在 `abc_config:R` 但无 `abc_dashboard:R` 的角色则破链」的**理论**风险——经核实**无此角色**（真实/种子矩阵 0 违反，共旅成立），且与既有 activity-centers 同款耦合；作为**已披露边界**记录，非缺陷。
  - 完整性/回归专审：见结论。
- **Workflow 对抗面板（Claude 轴，3 lens：RBAC-403 / 完整性一致 / 文案回归 + 综合裁决）**：见结论。

## 六、已披露边界

1. **共旅假设**：配置类映 `abc_config`，其载入门是 `abc_dashboard:R`。真实角色下 `abc_config ⊆ abc_dashboard:R` 持有者（已验证），故安全；但若日后经角色编辑器造出「有 `abc_config:R`、无 `abc_dashboard:R`」的不连贯角色，其配置页链接会 404→403 破链。**此耦合与既有 `/abc/activity-centers` 完全相同，非本改动新引入**；已在代码注释固化。
2. **finance 运行库欠配**：运行库 finance 角色缺 ABC 模块，故 finance 当前看不到这 8 页（与看不到既有 `/abc/activity-centers` 一致）。属角色数据欠配，正交于本导航实现。
3. **审计发现的两处缺陷（`personnel-efficiency` 幽灵接口 / `variance` 假标准成本）不在本项范围**（另立 I-3/I-4）。

---

### 变更记录
- 2026-07-03 初版。I-1 实现：8 个 ABC 孤儿配置页接回侧栏 + `NAV_PATH_MODULE`/`ROLE_MENU_MAP` 权限映射。纯前端 2 文件；tsc/build/前端 vitest（零新增失败）/后端 vitest 757 绿·golden 零回归；真跑端到端 8 页可点开+落库+审计留痕、可达性⟺授权 0 破链；codex 异构 + Workflow 3-lens 双轨独立复核。

*配套：`docs/COREONE-ABC前端页面处置清单-审计与废弃候选-2026-07-03.md`（§五 I-1 出处）、`.claude/rules/pr-governance.md`（看板）、`.claude/session-log.md`。*
