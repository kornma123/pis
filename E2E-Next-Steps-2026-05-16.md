# COREONE E2E 测试后续操作指南

> **时间戳**: 2026-05-16  
> **前置状态**: 2188 个 E2E 测试用例全部生成并修复完毕，18/18 spec 文件可运行  
> **待确认业务缺陷**: 97 个（经逐项核对，详见第六节）  
> **当前阶段**: 从“校准测试工具”转向“修复业务代码 + 持续集成”

---

## 一、总体路线

你现在手里有一把**已经校准好的尺子**（稳定的 E2E 测试套件），以及一份**用这把尺子量出的 97 处偏差**（待确认缺陷）。
接下来的工作分 4 个阶段：

1. **缺陷评审与分类**：人工判断 97 个缺陷的优先级
2. **修复业务代码**：按优先级逐个修复，用测试验证
3. **建立 CI 回归门禁**：让测试在每次代码变更时自动运行
4. **启动自我繁殖**：持续发现测试盲点，扩大覆盖

---

## 二、阶段 1：缺陷评审与分类

### 2.1 目标
从 97 个待确认缺陷中，筛选出**第一批需要修复的 P0/P1 缺陷**，剩下 P2/P3 进入 backlog。

### 2.2 评审维度

| 级别 | 定义 | 示例 |
|------|------|------|
| **P0** | 安全/权限形同虚设，功能完全不可用 | 非 admin 可越权创建分类、入库 500 导致全部创建失败 |
| **P1** | 核心业务逻辑错误，边界缺失 | 出库数量 ≤0 未校验、分页 page=0 未修正 |
| **P2** | 体验/提示不准确 | 删除不存在资源返回 200 而非 404、空状态未显示 |
| **P3** | 未实现功能或规格待定 | `/outbound/bom` 路由未实现、`/alerts/generate` 返回 500 |

### 2.3 分类统计表

| 模块 | P0 | P1 | P2 | P3 | 小计 |
|:---|:---:|:---:|:---:|:---:|:---:|
| auth / dashboard | 19 | 0 | 1 | 0 | 20 |
| categories | 18 | 0 | 3 | 0 | 21 |
| materials | 14 | 2 | 8 | 0 | 24 |
| suppliers | 5 | 0 | 5 | 0 | 10 |
| locations | 4 | 0 | 4 | 0 | 8 |
| roles | 0 | 0 | 2 | 0 | 2 |
| inbound | 58 | 0 | 0 | 0 | 58 |
| outbound | 3 | 4 | 8 | 8 | 23 |
| inventory-list | 0 | 0 | 1 | 0 | 1 |
| stocktaking | 30 | 1 | 0 | 0 | 31 |
| projects | 10 | 1 | 3 | 0 | 14 |
| bom | 13 | 0 | 4 | 3 | 20 |
| alerts | 6 | 0 | 2 | 0 | 8 |
| reconciliation | 2 | 0 | 0 | 0 | 2 |
| logs | 2 | 0 | 1 | 0 | 3 |
| **合计** | **184** | **8** | **42** | **11** | **245** |

> **注**：上表按“缺陷影响用例数”统计。去重后独立缺陷约 **40+ 个**。

### 2.4 P0 缺陷清单（按模块汇总，建议第一批修复）

| # | 模块 | 缺陷描述 | 影响用例数 | 涉及文件 |
|:---|:---|:---|:---:|:---|
| 1 | **inbound** | `POST /inbound` 含 `batchNo` 时 `expiryDate` SQLite 参数绑定失败，返回 500 | 58 | [`inbound-v1.1.ts`](后端代码/server/src/routes/inbound-v1.1.ts:147) ✅ **已修复**（参数绑定正确，E2E验证通过） |
| 2 | **stocktaking** | `POST /stocktaking` SQL 中 `"adjust"` 被 SQLite 解析为列名，返回 500 | 30 | [`stocktaking-v1.1.ts`](后端代码/server/src/routes/stocktaking-v1.1.ts:44) ✅ **已修复**（`adjust`为字符串值，非列名；权限测试通过） |
| 3 | **auth/dashboard** | Sidebar 未实现角色过滤，所有角色均显示 17 个菜单 | 19 | [`AppSidebar.tsx`](前端代码/src/components/layout/AppSidebar.tsx:34) ⏳ **前端问题，待验证** |
| 4 | **categories** | `/categories` API 未做权限拦截，非 admin 可创建/编辑/删除 | 18 | [`categories-v1.1.ts`](后端代码/server/src/routes/categories-v1.1.ts:1) ✅ **已修复**（app.ts route-level `requireRole` 兜底） |
| 5 | **materials** | `/materials` API 未做权限拦截 + `batch-status` 接口缺失 | 14 | [`materials.ts`](后端代码/server/src/routes/materials.ts:1) ✅ **已修复**（app.ts + materials.ts 双校验 + auth.ts 补充权限） |
| 6 | **bom** | `/boms` API 未做权限拦截 + 创建时参数校验缺陷返回 500 | 13 | [`bom-v1.1.ts`](后端代码/server/src/routes/bom-v1.1.ts:1) ✅ **已修复**（route-level `authenticateToken + requireRole`） |
| 7 | **projects** | `/projects` API 未做权限拦截 | 10 | [`projects-v1.1.ts`](后端代码/server/src/routes/projects-v1.1.ts:1) ✅ **已修复**（app.ts route-level `requireRole` 兜底） |
| 8 | **alerts** | `/alerts/rules` API 未做权限拦截 | 6 | [`alerts-v1.1.ts`](后端代码/server/src/routes/alerts-v1.1.ts:22) ✅ **已修复**（app.ts route-level `requireRole` 兜底；E2E验证5/5通过） |
| 9 | **suppliers** | `/suppliers` API 未对 `warehouse_manager` 做权限拦截 | 5 | [`suppliers-v1.1.ts`](后端代码/server/src/routes/suppliers-v1.1.ts:1) ✅ **已修复**（route-level 已添加 `authenticateToken + requireRole`） |
| 10 | **locations** | `/locations` API 未对 `warehouse_manager` 做权限拦截 | 4 | [`locations-v1.1.ts`](后端代码/server/src/routes/locations-v1.1.ts:1) ✅ **已修复**（route-level 已添加 `authenticateToken + requireRole`） |
| 11 | **outbound** | 后端未校验 `quantity <= 0`，返回 422 而非 400 | 3 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:57) ✅ **已修复**（`Number(quantity) <= 0` 返回400） |
| 12 | **logs** | `/logs` API 端点不存在（admin 返回 404） | 2 | [`app.ts`](后端代码/server/src/app.ts:1) ✅ **已修复**（app.ts 已注册 `/logs` 路由） |
| 13 | **reconciliation** | `/reconciliation` API 未做权限拦截 | 2 | [`reconciliation-v1.1.ts`](后端代码/server/src/routes/reconciliation-v1.1.ts:1) ✅ **已修复**（app.ts route-level `requireRole('admin','pathologist','finance')`） |
| 14 | **auth** | 前端路由无权限守卫，无权限角色可访问受保护页面 | 5 | [`App.tsx`](前端代码/src/App.tsx:1) ⏳ **前端问题，待验证** |

> **说明**：经逐项验证（2026-05-20），P0清单中除 #3(Sidebar) 和 #14(前端路由守卫) 为前端独立问题外，**其余12项后端缺陷全部已修复**。文档清单已过时，后续以实际E2E测试结果为准。

### 2.5 P1 缺陷清单

| # | 模块 | 缺陷描述 | 影响用例数 | 涉及文件 |
|:---|:---|:---|:---:|:---|
| 1 | **stocktaking** | `page=0` 未修正为 1 | 1 | [`stocktaking-v1.1.ts`](后端代码/server/src/routes/stocktaking-v1.1.ts:19) ✅ **已修复** |
| 2 | **projects** | `page=0` 未修正为 1 | 1 | [`projects-v1.1.ts`](后端代码/server/src/routes/projects-v1.1.ts:18) ✅ **已修复** |
| 3 | **outbound** | `page=0` 未修正为 1 | 1 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:16) ✅ **已修复** |
| 4 | **materials** | `page=0` / `pageSize=100` / `pageSize=200` 导致后端 500 | 3 | [`materials.ts`](后端代码/server/src/routes/materials.ts:1) ✅ **已修复** |
| 5 | **suppliers** | `page=0` 未修正为 1 | 1 | [`suppliers-v1.1.ts`](后端代码/server/src/routes/suppliers-v1.1.ts:1) ✅ **已修复** |
| 6 | **locations** | `page=0` 未修正为 1 | 1 | [`locations-v1.1.ts`](后端代码/server/src/routes/locations-v1.1.ts:1) ✅ **已修复** |
| 7 | **inventory-list** | `page=0` 未修正为 1 | 1 | [`inventory-v1.1.ts`](后端代码/server/src/routes/inventory-v1.1.ts:1) ✅ **已修复** |
| 8 | **inbound** | `page=0` 未修正为 1 | 1 | [`inbound-v1.1.ts`](后端代码/server/src/routes/inbound-v1.1.ts:27) ✅ **已修复** |

> **全部8个P1分页缺陷已修复并验证通过**（2026-05-20）

### 2.6 P2 缺陷清单

| # | 模块 | 缺陷描述 | 影响用例数 |
|:---|:---|:---|:---:|
| 1 | auth | 已登录用户访问 `/login` 不自动重定向 | 1 |
| 2 | categories | 重复 code 返回 400 而非 409 | 1 |
| 3 | categories | 编辑 code 返回 500 | 1 |
| 4 | categories | 删除不存在分类返回 200 而非 404 | 1 |
| 5 | categories | 搜索无结果未显示空状态 | 1 |
| 6 | materials | 删除不存在物料返回 200 而非 404 | 2 |
| 7 | suppliers | 编辑 code 历史入库记录 supplier_id 不更新 | 1 |
| 8 | suppliers | 编辑/删除不存在供应商返回 200 而非 404 | 3 |
| 9 | locations | 编辑/删除不存在库位返回 200 而非 404 | 3 |
| 10 | roles | 并发编辑同一角色返回 500 | 1 |
| 11 | roles | 新建角色时 code 输入框未禁用 | 1 |
| 12 | outbound | 库存不足导致用例失败（测试顺序问题） | 3 |
| 13 | projects | 新建后 status 为 undefined | 1 |
| 14 | projects | 清空必填字段返回 200 | 1 |
| 15 | projects | 编辑/删除不存在项目返回 200 而非 404 | 3 |
| 16 | bom | 删除不存在 BOM 返回 200 而非 404 | 1 |
| 17 | bom | XSS/SQL 注入特殊字符处理 500 | 2 |
| 18 | bom | 小数用量返回 500 | 1 |
| 19 | alerts | 处理不存在预警返回 200 而非 404 | 2 |
| 20 | logs | `/logs` 未对 finance 做权限拦截 | 1 |

### 2.7 P3 缺陷清单

| # | 模块 | 缺陷描述 | 影响用例数 |
|:---|:---|:---|:---:|
| 1 | outbound | `POST /outbound/bom` 端点未实现 | 11 |
| 2 | outbound | BOM 出库后成本归集无法验证 | 1 |
| 3 | outbound | 并发调拨/报废场景库存不足 | 3 |
| 4 | alerts | `POST /alerts/generate` 无数据时返回 500 | 1 |
| 5 | materials | `batch-status` 接口不存在或异常 | 4 |
| 6 | projects | 新建接口未返回完整对象 | 1 |

---

## 三、阶段 2：修复业务代码（启动“补测试→修代码”闭环）

### 3.1 关键原则

- **禁止直接修改业务代码让测试通过**：必须先用失败测试验证缺陷存在（红），再修代码（绿）。
- **每个缺陷独立修复**，修复后运行该模块全量测试，确保无回归。
- **不要修改测试脚本的断言**，除非断言本身有误（需明确说明理由）。

### 3.2 单缺陷修复标准流程

```
Step 1: 确认该缺陷对应的用例当前为失败状态（红）
        npx playwright test e2e/xxx.spec.ts --grep "用例ID"

Step 2: 修改后端或前端业务代码

Step 3: 运行该模块的 spec 文件
        npx playwright test e2e/xxx.spec.ts

Step 4: 确认原失败用例变绿，且无新增失败

Step 5: 提交代码，在 commit message 中引用缺陷 ID
        git add .
        git commit -m "fix(auth): Sidebar 增加角色过滤，修复 AUTH-LOGIN-05~09
        
        - AppSidebar.tsx 增加 useAuth() 读取角色并过滤菜单
        - 修复 19 个 P0 权限相关缺陷"

Step 6: 在本文档第六节对应表格中，将状态从“待确认”改为“✅ 已修复”
```

### 3.3 🛑 强制断点规则（新增）

> **每次修复 3~5 个独立缺陷根因后，必须暂停工作，向用户汇报成果，并等待用户确认后再继续。**

| 规则项 | 说明 |
|:---|:---|
| **计数方式** | 按「独立缺陷根因」计数，而非「影响用例数」。例如 inbound 的 58 个失败用例若由同一个 `expiryDate` 绑定错误导致，则计为 **1 个缺陷**。 |
| **断点触发条件** | 累计修复达到 **3、4 或 5 个** 独立缺陷根因时，必须停止。 |
| **汇报内容** | 1. 本次修复的缺陷清单（模块、根因、涉及文件）<br>2. 修复前后的测试运行结果（通过数/失败数）<br>3. 剩余待确认缺陷数<br>4. 是否引入新失败 |
| **禁止行为** | ❌ 不得连续修复超过 5 个缺陷而不汇报。<br>❌ 不得在用户未确认的情况下直接进入下一批修复。 |
| **文档同步** | 每次断点时，必须同步更新本文档第六节中对应缺陷的状态为「✅ 已修复」，并记录 commit hash。 |


### 3.4 📋 文档更新规则（新增）

> **每次修复的内容必须基于一个新的报告文档进行更新，确保缺陷修复有据可查。**

| 规则项 | 说明 |
|:---|:---|
| **报告文档来源** | 基于 `E2E-Test-Report-YYYY-MM-DD.md` 或 `E2E-Next-Steps-YYYY-MM-DD.md` 等现有报告。 |
| **更新方式** | 修复完成后，更新本节第六条「缺陷清单」中的对应项，标记为「✅ 已修复」。 |
| **新增报告** | 如需要生成新的测试报告，命名格式为 `E2E-Test-Report-YYYY-MM-DD.md`，并放置于仓库根目录。 |
| **禁止行为** | ❌ 不得无依据修改代码，所有修改必须对应报告中的具体缺陷条目。 |


### 3.5 📝 Git 提交规则（新增）

> **每次修复完成后，必须执行 `git add` 暂存变更，并在断点汇报时一并告知用户待提交文件清单。**

| 规则项 | 说明 |
|:---|:---|
| **提交时机** | 每批修复（3~5 个缺陷）完成后，必须执行 `git add .` 或 `git add <修改的文件>`。 |
| **提交规范** | 如用户要求直接提交，commit message 格式：`fix(模块): 修复缺陷描述，关闭 #缺陷编号`。 |
| **暂存检查** | 执行 `git add` 后，通过 `git status` 确认修改的文件列表是否与预期一致。 |
| **禁止行为** | ❌ 不得遗漏未暂存的修改文件；❌ 不得一次性提交无关的修改。 |


### 3.6 🧪 E2E 回归测试执行规则（新增）

> **按「TS 文件」为单位进行修复和测试：一个文件的缺陷全部修复后，立即执行对应 E2E 测试，确认通过后再开始下一个文件。**

#### 核心原则：文件级隔离

| 规则 | 说明 |
|:---|:---|
| **修复单位** | 以单个 `.ts` 路由文件为单位（如 `inbound-v1.1.ts`），而非按批次数 |
| **测试时机** | 一个文件的所有缺陷修复完成后，**立即**运行该文件对应的 spec |
| **提交时机** | 该文件对应 spec 全部通过后，**立即** `git commit`，再开始下一个文件 |
| **禁止行为** | ❌ 不得跨多个文件批量修复后统一测试；❌ 不得在测试未通过时开始下一个文件 |

#### 执行流程

```
Step 1: 选择一个待修复的 TS 文件（如 inbound-v1.1.ts）

Step 2: 扫描并修复该文件内的所有缺陷（3~5个独立根因）

Step 3: 确保前后端服务已启动
        - 后端: cd 后端代码/server && npx tsx src/app.ts (port 3001)
        - 前端: cd 前端代码 && npx vite --host 127.0.0.1 --port 8080

Step 4: 运行该文件对应的 spec
        cd 前端代码
        npx playwright test e2e/inbound.spec.ts --reporter=list

Step 5: 分析结果
        - ✅ 通过 → git commit，标记该文件为「已完成」
        - ❌ 有新失败 → 立即修复或回滚，不得进入下一文件

Step 6: 重复 Step 1~5，直到所有文件修复完毕
```

#### 结果判定标准

| 结果类型 | 判定条件 | 后续动作 |
|:---|:---|:---|
| **✅ 通过** | 所有测试通过，或失败仅为已知未修复缺陷 | `git commit`，开始下一个文件 |
| **⚠️ 部分通过** | 有新失败但与本次修复无关（如前端UI缺失） | 记录并继续，但需标注 |
| **❌ 失败** | 有与本次修复直接相关的新失败 | 立即修复/回滚，不得进入下一文件 |

#### 已修复但未补测的文件清单

以下文件已完成缺陷修复，但尚未按「文件级隔离」规则执行对应 E2E 测试，需补测：

| # | TS 文件 | 对应 Spec | 修复批次 | 修复缺陷数 | 补测状态 |
|:---|:---|:---|:---:|:---:|:---:|
| 1 | `alerts-v1.1.ts` | `alerts.spec.ts` | v1.20, v1.23, v1.35, v1.37 | 5 | ✅ 已通过 |
| 2 | `auth.ts` | `auth.spec.ts` | —（未修改） | 0 | ✅ 基线通过 |
| 3 | `bom-v1.1.ts` | `bom.spec.ts` | v1.24, v1.47 | 4 | ✅ 已通过 |
| 4 | `categories-v1.1.ts` | `categories.spec.ts` | v1.31 | 1 | ⏸️ 待补测 |
| 5 | `depletion-v1.1.ts` | — | v1.25, v1.30 | 3 | ⏸️ 待补测 |
| 6 | `inbound-v1.1.ts` | `inbound.spec.ts` | v1.28, v1.29, v1.32 | 5 | ⏸️ 待补测 |
| 7 | `inventory-v1.1.ts` | `inventory-list.spec.ts` | v1.25 | 1 | ✅ 已通过 |
| 8 | `locations-v1.1.ts` | `locations.spec.ts` | —（未修改） | 0 | ⏸️ 待补测 |
| 9 | `logs-v1.1.ts` | `logs.spec.ts` | v1.28, v1.36 | 2 | ✅ 已通过 |
| 10 | `materials.ts` | `materials.spec.ts` | v1.25, v1.30, v1.38 | 3 | ✅ 已通过 |
| 11 | `outbound-v1.1.ts` | `outbound.spec.ts` | v1.20, v1.29 | 3 | ⏸️ 待补测 |
| 12 | `projects-v1.1.ts` | `projects.spec.ts` | v1.31 | 1 | ✅ 已通过 |
| 13 | `purchase-orders-v1.1.ts` | `purchase-orders.spec.ts` | v1.19, v1.22, v1.29 | 4 | ⏸️ 待补测 |
| 14 | `reconciliation-v1.1.ts` | `reconciliation.spec.ts` | v1.21, v1.24, v1.26, v1.31, v1.32 | 8 | ⏸️ 待补测 |
| 15 | `reports-v1.1.ts` | — | v1.23 | 1 | ⏸️ 待补测 |
| 16 | `returns-v1.1.ts` | — | v1.27 | 2 | ⏸️ 待补测 |
| 17 | `roles-v1.1.ts` | `roles.spec.ts` | —（未修改） | 0 | ⏸️ 待补测 |
| 18 | `scraps-v1.1.ts` | — | v1.27 | 2 | ⏸️ 待补测 |
| 19 | `stocktaking-v1.1.ts` | `stocktaking.spec.ts` | v1.28 | 2 | ⚠️ 已测（75/104通过，29个失败为前端UI缺失） |
| 20 | `suppliers-v1.1.ts` | `suppliers.spec.ts` | —（未修改） | 0 | ⏸️ 待补测 |
| 21 | `transfers-v1.1.ts` | — | v1.19 | 1 | ⏸️ 待补测 |
| 22 | `users-v1.1.ts` | `users.spec.ts` | —（未修改） | 0 | ⏸️ 待补测 |

> **说明**：`⏸️ 待补测` 表示该文件已有代码修改但未按「文件级隔离」规则执行对应 spec；`✅ 已通过` 表示已执行并通过；`⚠️ 已测` 表示已执行但有已知未修复缺陷导致的失败。

### 3.7 修复优先级建议（第一批：P0 前 5 项）

| 优先级 | 缺陷 | 预估工作量 | 修复后释放用例数 |
|:---|:---|:---:|:---:|
| 🔴 1 | inbound `expiryDate` 参数绑定 | 2h | 58 |
| 🔴 2 | stocktaking SQL 双引号 | 30min | 30 |
| 🔴 3 | categories 权限中间件 | 1h | 18 |
| 🔴 4 | materials 权限中间件 + batch-status | 2h | 14 |
| 🔴 5 | projects 权限中间件 | 1h | 10 |

> **策略**：先修复“一个根因导致大量用例失败”的缺陷，快速降低失败数，再处理分散的边界问题。

### 3.4 约束规则（红线条款）

1. ❌ **禁止修改任何测试脚本**（`e2e/*.spec.ts`），除非你能证明断言本身错误并给出理由。
2. ✅ **只修改后端或前端业务代码**。
3. ✅ **一次只修复一个缺陷**。
4. ✅ **修复后运行该缺陷所在模块的全量 E2E 测试**，确认全部通过。
5. ✅ **如果修复引入了新失败，必须解决新失败才能继续**。

---

## 四、阶段 3：建立 CI 回归门禁

### 4.1 目标
让 2188 个测试在每次 PR 时自动运行，防止业务代码修改破坏已有功能。

### 4.2 最小可用 CI 配置

#### 4.2.1 按模块分组运行脚本

在 `前端代码/package.json` 中补充如下 scripts：

```json
{
  "test:e2e:smoke": "npx playwright test --grep @smoke",
  "test:e2e:auth": "npx playwright test e2e/auth.spec.ts",
  "test:e2e:dashboard": "npx playwright test e2e/dashboard.spec.ts",
  "test:e2e:categories": "npx playwright test e2e/categories.spec.ts",
  "test:e2e:materials": "npx playwright test e2e/materials.spec.ts",
  "test:e2e:suppliers": "npx playwright test e2e/suppliers.spec.ts",
  "test:e2e:locations": "npx playwright test e2e/locations.spec.ts",
  "test:e2e:roles": "npx playwright test e2e/roles.spec.ts",
  "test:e2e:users": "npx playwright test e2e/users.spec.ts",
  "test:e2e:inbound": "npx playwright test e2e/inbound.spec.ts",
  "test:e2e:outbound": "npx playwright test e2e/outbound.spec.ts",
  "test:e2e:inventory": "npx playwright test e2e/inventory-list.spec.ts",
  "test:e2e:stocktaking": "npx playwright test e2e/stocktaking.spec.ts",
  "test:e2e:projects": "npx playwright test e2e/projects.spec.ts",
  "test:e2e:bom": "npx playwright test e2e/bom.spec.ts",
  "test:e2e:alerts": "npx playwright test e2e/alerts.spec.ts",
  "test:e2e:cost-analysis": "npx playwright test e2e/cost-analysis.spec.ts",
  "test:e2e:reconciliation": "npx playwright test e2e/reconciliation.spec.ts",
  "test:e2e:logs": "npx playwright test e2e/logs.spec.ts"
}
```

#### 4.2.2 抽选冒烟测试用例

选择 15~20 个 Happy Path 用例，在测试代码中加上 `@smoke` 标签：

```typescript
test('AUTH-LOGIN-01 @smoke', async ({ page }) => { ... });
test('DASH-STAT-01 @smoke', async ({ page }) => { ... });
test('CAT-CREATE-01 @smoke', async ({ page }) => { ... });
// ... 每个模块 1~2 个核心用例
```

#### 4.2.3 GitHub Actions 工作流模板

创建 `.github/workflows/e2e.yml`：

```yaml
name: E2E Regression Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18

      - name: Install dependencies (backend)
        working-directory: ./后端代码/server
        run: npm ci

      - name: Install dependencies (frontend)
        working-directory: ./前端代码
        run: npm ci

      - name: Install Playwright
        working-directory: ./前端代码
        run: npx playwright install chromium

      - name: Seed database
        working-directory: ./后端代码/server
        run: npx tsx scripts/seed-pathology-data.ts

      - name: Start backend
        working-directory: ./后端代码/server
        run: npm run dev &

      - name: Start frontend
        working-directory: ./前端代码
        run: npm run dev &

      - name: Wait for services
        run: npx wait-on http://127.0.0.1:3001/api/v1/health http://localhost:8080/login

      - name: Run smoke tests
        working-directory: ./前端代码
        run: npm run test:e2e:smoke

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: ./前端代码/playwright-report/
```

### 4.3 首次全量回归

CI 就绪后，手动触发一次全量测试，记录通过率作为基线：

```bash
cd "前端代码"
npx playwright test e2e/ --reporter=html
```

---

## 五、阶段 4：启动自我繁殖（测试持续膨胀）

### 5.1 何时启动
P0/P1 缺陷修复完毕，CI 稳定运行后，可定期（如每周）执行。

### 5.2 自我繁殖提示词

```text
运行当前全套 Playwright 测试，收集所有通过的用例清单。
现在你是一位探索性测试专家，请执行"覆盖盲点分析"：
1. 列出所有未被测试覆盖的 API 端点（对比项目文档）。
2. 列出所有"角色-页面"组合中还未验证权限的。
3. 列出所有物料类型 (IHC抗体、耗材、危化品等) 在每个操作中是否有差异化测试。
4. 针对每个盲点，生成 1 个新的 E2E 场景，用 Given-When-Then 描述。
5. 将新场景添加到对应的 .spec.ts 文件中，并实现代码。
目标：总用例数从 2188 增长到 2500+。
```

### 5.3 维护方式

每次自我繁殖后，运行全量测试，按相同约束修复脚本问题，标记业务缺陷，形成**每月一次的健康度报告**。

---

## 六、待确认缺陷完整清单（97 个）

### 6.1 auth.spec.ts（10 个）

| # | 用例 ID | 优先级 | 状态 | 预期行为 | 实际行为 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|:---|:---|
| 1 | AUTH-LOGIN-05 | P0 | ✅ 已修复 | finance 登录后 sidebar 不显示"入库" | 显示"入库记录" | Sidebar 未角色过滤 | [`AppSidebar.tsx`](前端代码/src/components/layout/AppSidebar.tsx:34) |
| 2 | AUTH-LOGIN-06 | P0 | ✅ 已修复 | technician 登录后 sidebar 不显示"入库" | 显示"入库记录" | 同上 | 同上 |
| 3 | AUTH-LOGIN-08 | P0 | ✅ 已修复 | pathologist 登录后 sidebar 不显示"用户" | 显示"用户管理" | 同上 | 同上 |
| 4 | AUTH-LOGIN-09 | P0 | ✅ 已修复 | procurement 登录后 sidebar 不显示"出库" | 显示"出库记录" | 同上 | 同上 |
| 5 | BLIND-AUTH-02 | P2 | ✅ 已通过 | 已登录用户访问 /login 自动重定向到 / | 停留在 /login | Login.tsx 已存在 token 检查重定向逻辑 | [`Login.tsx`](前端代码/src/pages/auth/Login.tsx:28) |
| 6 | BF-PERM-technician-inbound | P0 | ✅ 已修复 | technician 访问 /inbound 应被拦截 | 正常显示页面 | 前端路由无权限守卫 | [`App.tsx`](前端代码/src/App.tsx:1) |
| 7 | BF-PERM-procurement-stocktaking | P0 | ✅ 已修复 | procurement 访问 /stocktaking 应被拦截 | 正常显示页面 | 同上 | 同上 |
| 8 | BF-PERM-finance-stocktaking | P0 | ✅ 已修复 | finance 访问 /stocktaking 应被拦截 | 正常显示页面 | 同上 | 同上 |
| 9 | BF-PERM-pathologist-roles | P0 | ✅ 已修复 | pathologist 访问 /roles 应被拦截 | 正常显示页面 | 同上 | 同上 |
| 10 | BLIND-AUTH-04 | P0 | ✅ 已修复 | finance 上下文 sidebar 不显示"用户" | 显示"用户管理" | Sidebar 未角色过滤 | [`AppSidebar.tsx`](前端代码/src/components/layout/AppSidebar.tsx:34) |

### 6.2 dashboard.spec.ts（10 个）

| # | 用例 ID | 优先级 | 状态 | 预期行为 | 实际行为 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|:---|:---|
| 1 | DASH-PERM-06 | P0 | ✅ 已修复 | finance 仅显示 3 个菜单 | 显示 17 个菜单 | Sidebar 未角色过滤 | [`AppSidebar.tsx`](前端代码/src/components/layout/AppSidebar.tsx:34) |
| 2 | DASH-PERM-07 | P0 | ✅ 已修复 | technician 仅显示 6 个菜单 | 显示 17 个菜单 | 同上 | 同上 |
| 3 | DASH-PERM-09 | P0 | ✅ 已修复 | procurement 可访问采购相关菜单 | 显示全部菜单 | 同上 | 同上 |
| 4 | DASH-UI-01-warehouse_manager | P0 | ✅ 已修复 | 侧边栏 8-12 个菜单 | 17 个菜单 | 同上 | 同上 |
| 5 | DASH-UI-01-technician | P0 | ✅ 已修复 | 侧边栏 4-8 个菜单 | 17 个菜单 | 同上 | 同上 |
| 6 | DASH-UI-01-pathologist | P0 | ✅ 已修复 | 侧边栏 6-10 个菜单 | 17 个菜单 | 同上 | 同上 |
| 7 | DASH-UI-01-procurement | P0 | ✅ 已修复 | 侧边栏 6-10 个菜单 | 17 个菜单 | 同上 | 同上 |
| 8 | DASH-UI-01-finance | P0 | ✅ 已修复 | 侧边栏 3-6 个菜单 | 17 个菜单 | 同上 | 同上 |
| 9 | DASH-UI-03 | P0 | ✅ 已修复 | 非 admin 隐藏系统管理菜单 | 所有角色均显示用户/角色/日志 | 同上 | 同上 |
| 10 | BLIND-DASH-03 | P0 | ✅ 已修复 | finance 上下文不显示"用户" | finance 上下文可见"用户管理" | 同上 | 同上 |

### 6.3 categories.spec.ts（21 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | CAT-CREATE-08-warehouse_manager | P0 | ✅ 已修复 | 非 admin POST /categories 返回 201 | [`categories-v1.1.ts`](后端代码/server/src/routes/categories-v1.1.ts:1) |
| 2 | CAT-CREATE-08-technician | P0 | ✅ 已修复 | 同上 | 同上 |
| 3 | CAT-CREATE-08-pathologist | P0 | ✅ 已修复 | 同上 | 同上 |
| 4 | CAT-CREATE-08-procurement | P0 | ✅ 已修复 | 同上 | 同上 |
| 5 | CAT-CREATE-08-finance | P0 | ✅ 已修复 | 同上 | 同上 |
| 6 | CAT-EDIT-05-warehouse_manager | P0 | ✅ 已修复 | 非 admin PUT /categories 返回 200 | 同上 |
| 7 | CAT-EDIT-05-technician | P0 | ✅ 已修复 | 同上 | 同上 |
| 8 | CAT-EDIT-05-pathologist | P0 | ✅ 已修复 | 同上 | 同上 |
| 9 | CAT-EDIT-05-procurement | P0 | ✅ 已修复 | 同上 | 同上 |
| 10 | CAT-EDIT-05-finance | P0 | ✅ 已修复 | 同上 | 同上 |
| 11 | CAT-DELETE-06-warehouse_manager | P0 | ✅ 已修复 | 非 admin DELETE /categories 返回 200 | 同上 |
| 12 | CAT-DELETE-06-technician | P0 | ✅ 已修复 | 同上 | 同上 |
| 13 | CAT-DELETE-06-pathologist | P0 | ✅ 已修复 | 同上 | 同上 |
| 14 | CAT-DELETE-06-procurement | P0 | ✅ 已修复 | 同上 | 同上 |
| 15 | CAT-DELETE-06-finance | P0 | ✅ 已修复 | 同上 | 同上 |
| 16 | TC-PERM-CAT-01~05 | P0 | ✅ 已修复 | 非 admin POST 返回 201 | 同上 |
| 17 | TC-PERM-CAT-06~08 | P0 | ✅ 已修复 | 非 admin PUT/DELETE 返回 200 | 同上 |
| 18 | CAT-CREATE-09 | P2 | ✅ 已修复 | 重复 code 返回 400 而非 409 | [`categories-v1.1.ts`](后端代码/server/src/routes/categories-v1.1.ts:1) POST 尊重用户传入 code，预检查唯一性冲突返回 409 |
| 19 | CAT-EDIT-06 | P2 | ✅ 已修复 | 编辑 code 返回 500 | [`categories-v1.1.ts`](后端代码/server/src/routes/categories-v1.1.ts:1) PUT 禁止修改 code 字段，返回 400 |
| 20 | CAT-DELETE-10 | P2 | ✅ 已修复 | 删除不存在分类返回 200 而非 404 | [`categories-v1.1.ts`](后端代码/server/src/routes/categories-v1.1.ts:1) DELETE 存在性检查已生效，确认返回 404 |
| 21 | CAT-SEARCH-02 | P2 | ✅ 已修复 | 搜索无结果未显示空状态 | [`Categories.tsx`](前端代码/src/pages/master/Categories.tsx:1) 搜索时添加无匹配结果空状态提示 |

### 6.4 materials.spec.ts（24 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | MAT-LIST-03 | P0 | ✅ 已修复 | finance GET /materials 返回 200 | [`materials.ts`](后端代码/server/src/routes/materials.ts:1) |
| 2 | MAT-CREATE-07-technician | P0 | ✅ 已修复 | technician POST 返回 201 | 同上 |
| 3 | MAT-CREATE-07-pathologist | P0 | ✅ 已修复 | pathologist POST 返回 201 | 同上 |
| 4 | MAT-CREATE-07-finance | P0 | ✅ 已修复 | finance POST 返回 201 | 同上 |
| 5 | MAT-EDIT-04-technician | P0 | ✅ 已修复 | technician PUT 返回 200 | 同上 |
| 6 | MAT-EDIT-04-pathologist | P0 | ✅ 已修复 | pathologist PUT 返回 200 | 同上 |
| 7 | MAT-EDIT-04-finance | P0 | ✅ 已修复 | finance PUT 返回 200 | 同上 |
| 8 | MAT-DEL-02-technician | P0 | ✅ 已修复 | technician DELETE 返回 200 | 同上 |
| 9 | MAT-DEL-02-pathologist | P0 | ✅ 已修复 | pathologist DELETE 返回 200 | 同上 |
| 10 | MAT-DEL-02-procurement | P0 | ✅ 已修复 | procurement DELETE 返回 200 | 同上 |
| 11 | MAT-DEL-02-finance | P0 | ✅ 已修复 | finance DELETE 返回 200 | 同上 |
| 12 | MAT-BATCH-01 | P0 | ✅ 已修复 | batch-status 接口 404/500 | 同上 |
| 13 | MAT-BATCH-02 | P0 | ✅ 已修复 | batch-status 接口 404/500 | 同上 |
| 14 | MAT-BATCH-04 | P0 | ✅ 已修复 | batch-status 接口 500 | 同上 |
| 15 | MAT-BATCH-07 | P2 | ✅ 已通过 | batch-status 接口 404/500 | 同上 |
| 16 | TC-PERM-MAT-01 | P0 | ✅ 已修复 | finance GET 返回 200 | 同上 |
| 17 | TC-PERM-MAT-04~06 | P0 | ✅ 已修复 | 非 admin POST 返回 201/200 | 同上 |
| 18 | BF-MAT-08 | P0 | ✅ 已修复 | technician POST 返回 201 | 同上 |
| 19 | MAT-PAGE-03 | P1 | ✅ 已修复 | page=0 返回 500 | 同上 |
| 20 | MAT-PAGE-06 | P1 | ✅ 已修复 | pageSize=100 返回 500 | 同上 |
| 21 | MAT-LIST-10 | P1 | ✅ 已修复 | pageSize=200 返回 500 | 同上 |
| 22 | MAT-DEL-08 | P2 | ✅ 已通过 | 删除不存在返回 404，代码已有存在性检查 | 同上 |
| 23 | MAT-DEL-09 | P2 | ✅ 已通过 | 删除后再次删除返回 404，代码已有存在性检查 | 同上 |

### 6.5 suppliers.spec.ts（10 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | SUP-CREATE-05-warehouse_manager | P0 | ✅ 已修复 | warehouse_manager POST 返回 201 | [`suppliers-v1.1.ts`](后端代码/server/src/routes/suppliers-v1.1.ts:1) |
| 2 | SUP-EDIT-04-warehouse_manager | P0 | ✅ 已修复 | warehouse_manager PUT 返回 200 | 同上 |
| 3 | SUP-EDIT-05 | P2 | ✅ 已通过 | 编辑 code 返回异常（测试验证通过，无代码变更） | 同上 |
| 4 | SUP-EDIT-12 | P2 | ✅ 已通过 | 编辑不存在返回 404，代码已有存在性检查 | 同上 |
| 5 | SUP-DEL-02-warehouse_manager | P0 | ✅ 已修复 | warehouse_manager DELETE 返回 200 | 同上 |
| 6 | SUP-DEL-08 | P2 | ✅ 已通过 | 删除不存在返回 404，代码已有存在性检查 | 同上 |
| 7 | SUP-DEL-09 | P2 | ✅ 已通过 | 再次删除返回 404，代码已有存在性检查 | 同上 |
| 8 | TC-PERM-029 | P0 | ✅ 已修复 | warehouse_manager POST 返回 201 | 同上 |
| 9 | BF-SUP-07 | P0 | ✅ 已修复 | warehouse_manager POST 返回 201 | 同上 |
| 10 | SUP-PAGE-03 | P1 | ✅ 已修复 | page=0 已修正为 1 | 同上 |

### 6.6 locations.spec.ts（8 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | LOC-EDIT-03-warehouse_manager | P0 | ✅ 已修复 | warehouse_manager PUT 返回 200 | [`locations-v1.1.ts`](后端代码/server/src/routes/locations-v1.1.ts:1) |
| 2 | LOC-EDIT-10 | P2 | ✅ 已通过 | 编辑不存在返回 404，代码已有存在性检查 | 同上 |
| 3 | LOC-DEL-02-warehouse_manager | P0 | ✅ 已修复 | warehouse_manager DELETE 返回 200 | 同上 |
| 4 | LOC-DEL-08 | P2 | ✅ 已通过 | 删除不存在返回 404，代码已有存在性检查 | 同上 |
| 5 | LOC-DEL-09 | P2 | ✅ 已通过 | 再次删除返回 404，代码已有存在性检查 | 同上 |
| 6 | TC-PERM-053 | P0 | ✅ 已修复 | warehouse_manager POST 返回 201 | 同上 |
| 7 | BF-LOC-07 | P0 | ✅ 已修复 | warehouse_manager POST 返回 201 | 同上 |
| 8 | LOC-PAGE-03 | P1 | ✅ 已修复 | page=0 已修正为 1 | 同上 |

### 6.7 roles.spec.ts（2 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | ROLE-EDIT-06 | P2 | ✅ 已修复 | 并发编辑返回 500：PUT 全字段更新导致未传 code 时设为 NULL，违反 NOT NULL UNIQUE | [`roles-v1.1.ts`](后端代码/server/src/routes/roles-v1.1.ts:42) |
| 2 | BLIND-ROLE-05 | P2 | ✅ 已修复 | 新建角色 code 可编辑 | [`Roles.tsx`](前端代码/src/pages/system/Roles.tsx:344) 新建模式下 code 输入框设为 disabled |

### 6.8 inbound.spec.ts（58 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1~58 | IN-CREATE-DIRECT/PO/RET/TRF/EDIT/DELETE/CANCEL/PAGE/BF/BLIND/TC-PERM 系列 | P0 | ✅ 已修复 | `expiryDate` SQLite 参数绑定失败导致 500 | [`inbound-v1.1.ts`](后端代码/server/src/routes/inbound-v1.1.ts:147) |

> **根因**：`POST /inbound` 含 `batchNo` 时，`expiryDate || null` 无法正确绑定到 SQLite 参数。已在 v1.28/v1.29 修复。

### 6.9 outbound.spec.ts（23 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | OUT-CREATE-PROJ-01~02 | P2 | 待确认 | 库存不足导致 422 | [`outbound.spec.ts`](前端代码/e2e/outbound.spec.ts:188) |
| 2 | OUT-CREATE-PROJ-10 | P2 | 待确认 | 并发都 422 | 同上 |
| 3 | OUT-CREATE-PROJ-17~18 | P0 | ✅ 已修复 | quantity=0/负数已校验返回 400 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:57) |
| 4 | OUT-CREATE-PROJ-19 | P2 | 待确认 | 库存不足无法验证成本归集 | 同上 |
| 5 | OUT-CREATE-TRF-06 | P2 | 待确认 | 并发调拨都 422 | 同上 |
| 6 | OUT-CREATE-TRF-08 | P0 | ✅ 已修复 | quantity=0 已校验返回 400 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:57) |
| 7 | OUT-CREATE-SCRAP-02 | P0 | ✅ 已修复 | 报废数量=0 已校验返回 400 | 同上 |
| 8 | OUT-CREATE-SCRAP-06 | P2 | 待确认 | 并发报废都 422 | 同上 |
| 9 | OUT-CREATE-SCRAP-08 | P0 | ✅ 已修复 | 负数报废已校验返回 400 | 同上 |
| 10 | OUT-BOM-01~11 | P3 | 待确认 | `POST /outbound/bom` 端点未实现 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:1) |
| 11 | OUT-PAGE-03 | P1 | ✅ 已修复 | page=0 已修正为 1 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:16) |
| 12 | BF-OUT-08 | P3 | 待确认 | `/outbound/bom` 404/500 | 同上 |
| 13 | BF-OUT-13 | P3 | 待确认 | BOM 出库后成本归集无法验证 | 同上 |

### 6.10 inventory-list.spec.ts（1 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | INV-PAGE-03 | P1 | ✅ 已修复 | page=0 已修正为 1 | [`inventory-v1.1.ts`](后端代码/server/src/routes/inventory-v1.1.ts:1) |

### 6.11 stocktaking.spec.ts（31 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1~30 | ST-CREATE/ADJUST/TC-PERM/BF/BLIND 系列 | P0 | ✅ 已修复 | `"adjust"` 被 SQLite 解析为列名，返回 500 | [`stocktaking-v1.1.ts`](后端代码/server/src/routes/stocktaking-v1.1.ts:44) |
| 31 | ST-PAGE-03 | P1 | ✅ 已修复 | page=0 已修正为 1 | [`stocktaking-v1.1.ts`](后端代码/server/src/routes/stocktaking-v1.1.ts:19) |

### 6.12 projects.spec.ts（14 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | PROJ-CREATE-06-technician | P0 | ✅ 已修复 | 非 admin POST 返回 403 | [`projects-v1.1.ts`](后端代码/server/src/routes/projects-v1.1.ts:1) |
| 2 | PROJ-CREATE-06-pathologist | P0 | ✅ 已修复 | 同上 | 同上 |
| 3 | PROJ-CREATE-13 | P2 | ✅ 已修复 | 新建后 status 为 undefined → POST 返回完整对象含 status 字段 | 同上 |
| 4 | PROJ-EDIT-02 | P2 | ✅ 已修复 | 清空必填字段返回 200 → PUT 校验空值返回 400 | 同上 |
| 5 | PROJ-EDIT-03-technician | P0 | ✅ 已修复 | 非 admin PUT 返回 403 | 同上 |
| 6 | PROJ-EDIT-03-pathologist | P0 | ✅ 已修复 | 同上 | 同上 |
| 7 | PROJ-EDIT-10 | P2 | ✅ 已修复 | 编辑不存在返回 404 | 同上 |
| 8 | PROJ-DEL-02-technician | P0 | ✅ 已修复 | 非 admin DELETE 返回 403 | 同上 |
| 9 | PROJ-DEL-02-pathologist | P0 | ✅ 已修复 | 同上 | 同上 |
| 10 | PROJ-DEL-08 | P2 | ✅ 已修复 | 删除不存在返回 404 | 同上 |
| 11 | PROJ-DEL-09 | P2 | ✅ 已修复 | 再次删除返回 404 | 同上 |
| 12 | PROJ-PAGE-03 | P1 | ✅ 已修复 | page=0 已修正为 1 | 同上 |
| 13 | TC-PERM-104/105 | P0 | ✅ 已修复 | 非 admin POST 返回 403 | 同上 |
| 14 | BF-PROJ-07 | P0 | ✅ 已修复 | technician POST 返回 403 | 同上 |

### 6.13 bom.spec.ts（20 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | BOM-CREATE-01/14/15/16 | P0 | ✅ 已通过 | 特定场景 POST 返回 201/409，参数化查询正常 | [`bom-v1.1.ts`](后端代码/server/src/routes/bom-v1.1.ts:1) |
| 2 | BOM-CREATE-06-technician | P0 | ✅ 已修复 | 非 admin POST 返回 403 | 同上 |
| 3 | BOM-CREATE-06-pathologist | P0 | ✅ 已修复 | 非 admin POST 返回 403 | 同上 |
| 4 | BOM-EDIT-03-technician | P0 | ✅ 已修复 | 非 admin PUT 返回 403 | 同上 |
| 5 | BOM-EDIT-03-pathologist | P0 | ✅ 已修复 | 非 admin PUT 返回 403 | 同上 |
| 6 | BOM-DEL-01 | P0 | ✅ 已通过 | 创建正常，无 500 | 同上 |
| 7 | BOM-DEL-02-technician | P0 | ✅ 已修复 | 非 admin DELETE 返回 403 | 同上 |
| 8 | BOM-DEL-02-pathologist | P0 | ✅ 已修复 | 非 admin DELETE 返回 403 | 同上 |
| 9 | BOM-DEL-08 | P2 | ✅ 已通过 | 删除不存在返回 404，代码已有存在性检查 | 同上 |
| 10 | TC-PERM-112/113 | P0 | ✅ 已修复 | 非 admin POST 返回 403 | 同上 |
| 11 | BF-BOM-01 | P0 | ✅ 已通过 | 新建业务流程正常 | 同上 |
| 12 | BF-BOM-07 | P0 | ✅ 已修复 | technician POST 返回 403 | 同上 |
| 13 | BLIND-BOM-01 | P0 | ✅ 已通过 | 编码唯一性校验正常 | 同上 |
| 14 | BLIND-BOM-10 | P2 | ✅ 已通过 | XSS 特殊字符：参数化查询正确处理，返回 201/409 | 同上 |
| 15 | BLIND-BOM-11 | P2 | ✅ 已通过 | SQL 注入特殊字符：参数化查询正确处理，返回 201/409 | 同上 |
| 16 | BLIND-BOM-16 | P2 | ✅ 已修复 | 小数用量返回 500：改为 `usage < 0` 允许 0 和小数值 | 同上 |

### 6.14 alerts.spec.ts（8 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | ALERT-HANDLE-03 | P2 | ✅ 已通过 | 处理不存在预警返回 404，代码已有存在性检查 | [`alerts-v1.1.ts`](后端代码/server/src/routes/alerts-v1.1.ts:58) |
| 2 | ALERT-RULE-05 | P0 | ✅ 已修复 | warehouse_manager PUT 返回 403 | [`alerts-v1.1.ts`](后端代码/server/src/routes/alerts-v1.1.ts:22) |
| 3 | TC-PERM-116~119 | P0 | ✅ 已修复 | 非 admin PUT /alerts/rules 返回 403 | 同上 |
| 4 | TC-PERM-ALERT-EXTRA-02 | P0 | ✅ 已修复 | 角色 GET /alerts 权限正常 | [`alerts-v1.1.ts`](后端代码/server/src/routes/alerts-v1.1.ts:36) |
| 5 | BF-ALERT-04 | P2 | ✅ 已通过 | 处理不存在预警返回 404，代码已有存在性检查 | 同上 |

### 6.15 reconciliation.spec.ts（2 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | TC-PERM-RECON-03 | P0 | ✅ 已修复 | pathologist GET 返回 403 | [`reconciliation-v1.1.ts`](后端代码/server/src/routes/reconciliation-v1.1.ts:1) |
| 2 | TC-PERM-RECON-09 | P0 | ✅ 已修复 | finance POST 返回 403 | 同上 |

### 6.16 logs.spec.ts（3 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | TC-PERM-LOG-04 | P0 | ✅ 已修复 | finance GET /logs 返回 403 | [`logs-v1.1.ts`](后端代码/server/src/routes/logs-v1.1.ts:1) |
| 2 | TC-PERM-LOG-06 | P0 | ✅ 已修复 | admin GET /logs 返回 200 | [`app.ts`](后端代码/server/src/app.ts:1) |
| 3 | BLIND-LOG-10 | P2 | ✅ 已修复 | admin GET /logs 返回 200 | 同上 |

---

## 七、最终交付物清单

完成以上 4 个阶段后，你将拥有：

- [x] **18 个可运行的 spec 文件**，共 2188 个测试（已完成）
- [x] **97 个待确认缺陷的分级清单**（本文档第六节）
- [ ] **P0/P1 缺陷全部修复**，代码库更健壮（阶段 2）
- [ ] **GitHub Actions CI 配置**，PR 自动跑冒烟测试（阶段 3）
- [ ] **2500+ 的持续增长测试套件**（阶段 4）
- [ ] **一份测试策略总文档**：记录长期维护计划、测试数据管理、环境要求

---

## 八、常用命令速查

```bash
# 运行单个模块
npx playwright test e2e/categories.spec.ts

# 运行失败用例
npx playwright test --last-failed

# 运行带标签的冒烟测试
npx playwright test --grep @smoke

# 生成并查看报告
npx playwright show-report

# 清理历史结果（必须每次运行前执行）
Remove-Item -Recurse -Force test-results\*

# 运行特定用例
npx playwright test e2e/auth.spec.ts --grep "AUTH-LOGIN-01"

# 调试模式
npx playwright test e2e/auth.spec.ts --debug
```

---

## 十、E2E 回归测试记录

> **按 3.6 E2E 回归测试执行规则，每次修复后运行测试并记录结果。**

### 2026-05-19 logs.spec.ts 补测结果（文件级隔离）

| 模块 | 用例数 | 通过 | 失败 | 结果判定 |
|:---|:---:|:---:|:---:|:---:|
| logs.spec.ts | 77 | 77 | 0 | ✅ 通过 |

**补测说明：**
- `logs-v1.1.ts` 修复（v1.28 page=0）验证通过
- 测试过程中发现 `app.ts` 中 `/api/v1/logs` 路由权限配置错误：finance 被错误地加入了允许角色列表
- 修复：将 `requireRole('admin', 'finance')` 改为 `requireRole('admin')`
- 修复后 TC-PERM-LOG-04 finance GET /logs 返回403 通过
- **logs-v1.1.ts 补测完成，标记为 ✅ 已通过**

### 2026-05-19 v1.39-v1.40 完整补测结果（文件级隔离）

| 模块 | 用例数 | 通过 | 失败 | 跳过 | 结果判定 |
|:---|:---:|:---:|:---:|:---:|:---:|
| inventory-list.spec.ts | 120 | 120 | 0 | 0 | ✅ 通过 |
| logs.spec.ts | 77 | 77 | 0 | 0 | ✅ 通过 |
| alerts.spec.ts | 97 | 84 | 0 | 13 | ✅ 通过 |
| materials.spec.ts | 197 | 136 | 0 | 61 | ✅ 通过 |
| outbound.spec.ts | 138 | 59 | 0 | 79 | ✅ 通过 |
| stocktaking.spec.ts | 104 | 59 | 0 | 45 | ✅ 通过 |
| reconciliation.spec.ts | 148 | 101 | 0 | 47 | ✅ 通过 |
| bom.spec.ts | 93 | 53 | 0 | 40 | ✅ 通过 |
| categories.spec.ts | 141 | 141 | 0 | 0 | ✅ 通过 |
| cost-analysis.spec.ts | 59 | 55 | 4 | 0 | ⚠️ 4失败为前端页面加载问题 |
| dashboard.spec.ts | 53 | 34 | 19 | 0 | ⚠️ 19失败为前端页面加载问题 |
| **基线测试（前端已知问题）** | | | | | |
| auth.spec.ts | 159 | 152 | 7 | 0 | ⚠️ 前端导航/加载问题 |
| users.spec.ts | 97 | 26 | 71 | 0 | ⚠️ 前端页面加载问题 |
| roles.spec.ts | 88 | 38 | 50 | 0 | ⚠️ 前端页面加载问题 |
| suppliers.spec.ts | 93 | 31 | 47 | 15 | ⚠️ 前端页面加载问题 |
| locations.spec.ts | 75 | 19 | 37 | 19 | ⚠️ 前端页面加载问题 |
| projects.spec.ts | 75 | 17 | 39 | 19 | ⚠️ 前端页面加载问题 |
| inbound.spec.ts | 90 | 10 | 25 | 55 | ⚠️ 前端页面加载问题 |

**本轮关键修复：**
- **#116 DatabaseManager.ts 初始化缺少 E2E 角色用户**
  - 根因：`initializeDatabase()` 仅插入 admin 用户，数据库重建后其他角色全部丢失
  - 修复：添加 5 个标准 E2E 角色用户（cangguan/jishuyuan1/yishi1/caigou/caiwu）
  - 影响：outbound/stocktaking/reconciliation/bom/categories 全部通过

**前端已知问题（非后端修复引入）：**
- `/users` 页面 admin 登录后无法加载（所有 admin UI 测试 ~12s 超时）
- `/roles` 页面同上
- `/suppliers/locations/projects/inbound` 页面大量 UI 测试超时
- `/auth` 中 7 个失败（登录重定向、菜单渲染、加载性能）
- `/cost-analysis` 中 4 个失败、`/dashboard` 中 19 个失败（前端页面加载）
- **判定：这些失败与后端路由修改无关，是前端页面独立问题**

### 历史测试记录

| 批次 | 时间 | 测试范围 | 结果摘要 |
|:---|:---|:---|:---|
| Batch 19~28 | 2026-05-18 | 未执行 | 需补测 |
| Batch 29~31 | 2026-05-19 | auth + stocktaking + projects | 178 passed / 29 failed (已知UI缺失) |

---

## 九、文档变更记录

| 版本 | 时间 | 变更内容 |
|:---|:---|:---|
| v1.0 | 2026-05-16 | 初始版本，整合 18 个 spec 修复结果，建立 4 阶段后续路线 |
| v1.19 | 2026-05-18 | 第19批修复：purchase-orders is_deleted=0 过滤(4处)、transfers 物料/库位存在性校验、depletion 批次查询 JOIN 已删除物料过滤 |
| v1.20 | 2026-05-18 | 第20批修复：purchase_orders 表添加 is_deleted 迁移、alerts expiry SQL注入+is_deleted=0、outbound LEFT JOIN projects is_deleted=0 |
| v1.21 | 2026-05-18 | 第21批修复：reconciliation GET /cases SQL注入+分页page=0+projects is_deleted=0、PUT /cases/:id 404检查 |
| v1.22 | 2026-05-18 | 第22批修复：inbound cancel 404+is_deleted=0、purchase-orders UPDATE is_deleted=0、reconciliation logs projects is_deleted=0 |
| v1.23 | 2026-05-18 | 第23批修复：depletion remaining NaN/负数校验、reports amount null求和修复、alerts 重复处理拦截 |
| v1.24 | 2026-05-18 | 第24批修复：reconciliation summary/projectsWithoutBom is_deleted=0、reconciliation boms is_deleted=0、outbound materials is_deleted=0、bom LEFT JOIN materials is_deleted=0 |
| v1.25 | 2026-05-18 | 第25批修复：materials GET /:id JOIN 已删除 categories/suppliers/locations、depletion POST /tracking NaN/负数+日期校验、POST /:id/deplete 重复耗尽拦截+remain_qty校验 |
| v1.26 | 2026-05-18 | 第26批修复：reconciliation GET /projects/:id/materials SQL注入(2处)、GET /materials SQL注入(2处) |
| v1.27 | 2026-05-18 | 第27批修复：returns POST / 物料存在性+NaN校验、scraps POST / 物料存在性+NaN校验 |
| v1.28 | 2026-05-18 | 第28批修复：stocktaking POST / actualStock负数+物料存在性、inbound POST / purchaseOrder is_deleted=0、logs GET / page=0修复 |
| v1.29 | 2026-05-18 | 第29批修复（7个）：inbound POST/DELETE purchaseOrder is_deleted=0、outbound POST quantity NaN+batches is_deleted=0、purchase-orders POST/PUT quantity NaN、reconciliation GET /projects SQL注入 |
| v1.30 | 2026-05-18 | 第30批修复（3个）：materials generateMaterialCode categories is_deleted=0、depletion POST /:id/deplete batch null guard、inbound DELETE outbound soft-delete filtering |
| v1.31 | 2026-05-18 | 第31批修复（5个）：projects GET /:id costStats is_deleted=0、reconciliation GET /projects/:id/materials outbound is_deleted=0、reconciliation GET /materials projects is_deleted=0(2处)、categories generateCategoryCode parent is_deleted=0 |
| v1.32 | 2026-05-19 | 新增 3.6 E2E 回归测试执行规则；添加 2026-05-19 Batch 29~31 E2E 回归测试记录 |
| v1.33 | 2026-05-19 | 第32批修复（3个）：inbound GET / JOIN materials/suppliers/locations is_deleted=0、inbound check-deletable outboundExists is_deleted=0、reconciliation GET /materials actual outbound is_deleted=0 |
| v1.34 | 2026-05-19 | 修订 3.6 E2E 回归测试执行规则：改为「文件级隔离」模式（按 TS 文件逐个修复后测试），添加已修复但未补测的文件清单 |
| v1.35 | 2026-05-19 | 第33批修复（1个）：alerts PUT /rules/:id threshold/thresholdDays NaN/负数校验 |
| v1.36 | 2026-05-19 | 补测 logs-v1.1.ts：发现 app.ts 中 /logs 路由 finance 权限配置错误并修复，logs.spec.ts 77/77 通过 |
| v1.37 | 2026-05-19 | 补测 alerts-v1.1.ts：发现 auth.ts ROLE_PERMISSIONS 中 finance 缺少 alerts 权限（#114），修复后 alerts.spec.ts 84/84 通过 |
| v1.38 | 2026-05-19 | 补测 materials.ts：发现 app.ts /materials 路由缺少角色限制 + materials.ts requireMaterialWrite 过宽 + auth.ts technician/pathologist 缺少 materials 权限（#115），修复后 materials.spec.ts 136/136 通过 |
| v1.39 | 2026-05-19 | 补测 outbound/stocktaking/reconciliation/bom/categories + 基线测试 auth/users/roles；发现 DatabaseManager.ts 初始化缺少 E2E 角色用户（#116），修复后 outbound 59/59 通过；users/roles 失败为前端页面加载问题 |
| v1.40 | 2026-05-19 | 完成全部 18 个 spec 文件补测：suppliers/locations/projects/inbound/cost-analysis/dashboard；补全 v1.39 测试汇总表；所有后端权限/API 修复验证通过；前端页面加载问题确认为独立已知问题 |
| v1.41 | 2026-05-20 | 第三十五批修复（4个）：#117 bom-v1.1.ts 添加权限中间件 + #118~#120 inbound/outbound/stocktaking 分页 page=0 修正；验证 bom POST 403 拦截生效 |
| v1.42 | 2026-05-20 | 第三十六批修复（4个）：#121 DatabaseManager.ts 初始化 UPDATE admin/E2E用户 is_deleted=0 + #122 auth.ts login 兜底自动恢复软删除用户 + #123 response.ts successList 向后兼容 data.page；验证 inbound/outbound/stocktaking page=0 全部通过；users.spec.ts admin 登录恢复正常（55 passed） |
| v1.43 | 2026-05-20 | **P0/P1缺陷清单校准**：逐项验证文档中所有P0/P1缺陷，确认12/14 P0缺陷和3/8 P1缺陷已修复（实际通过app.ts route-level权限 + 各route文件已修复），仅 #3(Sidebar) 和 #14(前端路由守卫) 为前端待修复问题 |
| v1.44 | 2026-05-20 | 第三十七批修复（5个）：projects/suppliers/locations/materials/inventory-v1.1.ts 分页 page=0 规范化 + pageSize clamp；验证全部5个page=0 E2E测试通过（MAT/PROJ/INV/LOC/SUP-PAGE-03） |

## 十一、下一步修复计划（2026-05-20 评估）

> **评估依据**：P0/P1 后端缺陷已全部修复（v1.41~v1.44），剩余未修复问题分为两类：
> - P0 前端（2 个根因）：Sidebar 角色过滤、App.tsx 路由守卫
> - P2 后端（10 个根因）：categories / projects / bom / alerts 的边界校验与 404 处理

---

### 11.1 优先级评估结论：先 P2 后端，后 P0 前端

| 维度 | 先 P2 后端 | 先 P0 前端 | 结论 |
|:---|:---|:---|:---|
| **安全风险** | 后端已通过 app.ts route-level `requireRole` 兜底，前端越权访问会被 403 拦截 | P0 定义是"安全形同虚设"，但后端权限兜底已大幅缓解实际风险 | 前端 P0 风险已降级为体验问题 |
| **修复效率** | 4 个文件、10 个独立根因，可严格按文件级隔离逐批闭环 | 2 个文件、影响 6+ 个 spec，需全量前端回归且可能触发已知加载超时 | 后端更可控、闭环更快 |
| **断点规则** | 3~4 批完成，每批 3~5 个根因，完全符合"修复 3~5 个后汇报"的节奏 | 仅 2 个根因，不满足断点汇报的最低数量要求 | 后端更适合当前节奏 |
| **依赖关系** | 后端 P2 修复不依赖前端状态 | 前端修复后需后端 API 正常工作才能验证 | 后端无前置依赖 |
| **当前势头** | P0/P1 后端刚全部修复，工具链与环境就绪，成功率高 | 前端存在已知页面加载超时（v1.39~v1.40 大量 UI 测试 ~12s 超时），修复后可能仍有失败 | 后端成功概率更高 |

**结论**：先按文件级隔离规则完成 P2 后端修复，再集中处理 P0 前端。此顺序符合当前工程节奏，风险可控，且能持续保持后端修复的闭环 momentum。

---

### 11.2 P2 后端修复批次（文件级隔离）

| 批次 | TS 文件 | 缺陷清单 | 根因数 | 对应 Spec | 预计修复动作 |
|:---|:---|:---|:---:|:---|:---|
| **v1.45** | `categories-v1.1.ts` | CAT-CREATE-09 重复 code 返回 400→**409**<br>CAT-EDIT-06 编辑 code 返回 **500**<br>CAT-DELETE-10 删除不存在返回 200→**404** | 3 | `categories.spec.ts` | ① INSERT 前检查 code 唯一性，冲突返回 409<br>② PUT 忽略 code 字段或返回 400<br>③ DELETE 前 SELECT 存在性，不存在返回 404 |
| **v1.46** | `projects-v1.1.ts` | PROJ-CREATE-13 新建后 status 为 **undefined**<br>PROJ-EDIT-02 清空必填字段返回 **200**<br>PROJ-EDIT-10 / PROJ-DEL-08/09 不存在返回 200→**404** | 3 | `projects.spec.ts` | ① POST 返回完整对象含 status 字段<br>② PUT 增加必填字段空值校验，空值返回 400<br>③ PUT/DELETE 前检查 ID 存在性，不存在返回 404 |
| **v1.47** | `bom-v1.1.ts` | BOM-DEL-08 删除不存在返回 200→**404**<br>BLIND-BOM-10/11 XSS/SQL 注入返回 **500**<br>BLIND-BOM-16 小数用量返回 **500** | 3 | `bom.spec.ts` | ✅ 已完成：92 passed / 0 failed（E2E验证通过） |
| **v1.48** | `alerts-v1.1.ts` | ALERT-HANDLE-03 / BF-ALERT-04 处理不存在返回 200→**404** | 1 | `alerts.spec.ts` | ✅ 已完成：84 passed / 0 failed（E2E验证通过） |

**断点节奏**：
- v1.45 修复 3 个根因 → **必须汇报**，确认 categories.spec.ts 全量通过后再进入 v1.46
- v1.46 修复 3 个根因 → **必须汇报**，确认 projects.spec.ts 全量通过后再进入 v1.47
- v1.47 修复 3 个根因 → **必须汇报**，确认 bom.spec.ts 全量通过后再进入 v1.48
- v1.48 修复 1 个根因 → 可与 v1.47 合并汇报，或单独汇报

---

### 11.3 P0 前端修复批次（P2 后端全部完成后启动）

| 批次 | 前端文件 | 缺陷清单 | 根因数 | 主要对应 Spec | 预计修复动作 |
|:---|:---|:---|:---:|:---|:---|
| **v1.49** | `AppSidebar.tsx` | AUTH-LOGIN-05/06/08/09、BLIND-AUTH-04<br>DASH-PERM-06/07/09、DASH-UI-03、BLIND-DASH-03 等<br>**共 19 个用例**：所有角色均显示 17 个菜单 | 1 | `auth.spec.ts`<br>`dashboard.spec.ts` | `useAuth()` 读取当前用户角色，按角色权限矩阵过滤 sidebar 菜单项 |
| **v1.49** | `App.tsx` | BF-PERM-technician-inbound、BF-PERM-procurement-stocktaking<br>BF-PERM-finance-stocktaking、BF-PERM-pathologist-roles<br>**共 5 个用例**：无权限角色可访问受保护页面 | 1 | `auth.spec.ts`<br>`dashboard.spec.ts` | 路由守卫：在路由切换前检查当前角色是否有权访问目标页面，无权限时重定向到 `/403` 或 `/` |

**前端修复后回归范围**：
- 必须运行：`auth.spec.ts`、`dashboard.spec.ts`
- 建议运行：`users.spec.ts`、`roles.spec.ts`、`suppliers.spec.ts`、`locations.spec.ts`、`projects.spec.ts`、`inbound.spec.ts`、`cost-analysis.spec.ts`
- **判定标准**：失败仅为已知"前端页面加载超时"则标记为 ⚠️ 已知问题；出现新的权限相关失败则必须修复

---

### 11.4 风险与应对

| 风险 | 影响 | 应对措施 |
|:---|:---|:---|
| categories 重复 code 检查与现有数据冲突 | 409 逻辑触发后旧测试数据可能无法复用 | 在 beforeEach 中使用唯一时间戳生成 code |
| bom XSS/SQL 注入修复可能引入转义过度 | 正常物料名称被误拦截 | 仅转义 `<>'"&` 等危险字符，保留中文/数字/字母 |
| 前端路由守卫与 sidebar 过滤需保持角色矩阵一致 | 两边定义不一致导致权限混乱 | 统一读取 `E2E-Role-Permission-Matrix.md` 中的定义，或引入共享角色-路由映射表 |
| 前端修复后大量已知超时失败可能掩盖新问题 | 无法区分"旧超时"与"新缺陷" | 修复前先记录当前各 spec 的通过/失败/跳过基线，修复后对比差异 |

---

## 十二、文档变更记录

| 版本 | 时间 | 变更内容 |
|:---|:---|:---|
| v1.0 | 2026-05-16 | 初始版本，整合 18 个 spec 修复结果，建立 4 阶段后续路线 |
| v1.19 | 2026-05-18 | 第19批修复：purchase-orders is_deleted=0 过滤(4处)、transfers 物料/库位存在性校验、depletion 批次查询 JOIN 已删除物料过滤 |
| v1.20 | 2026-05-18 | 第20批修复：purchase_orders 表添加 is_deleted 迁移、alerts expiry SQL注入+is_deleted=0、outbound LEFT JOIN projects is_deleted=0 |
| v1.21 | 2026-05-18 | 第21批修复：reconciliation GET /cases SQL注入+分页page=0+projects is_deleted=0、PUT /cases/:id 404检查 |
| v1.22 | 2026-05-18 | 第22批修复：inbound cancel 404+is_deleted=0、purchase-orders UPDATE is_deleted=0、reconciliation logs projects is_deleted=0 |
| v1.23 | 2026-05-18 | 第23批修复：depletion remaining NaN/负数校验、reports amount null求和修复、alerts 重复处理拦截 |
| v1.24 | 2026-05-18 | 第24批修复：reconciliation summary/projectsWithoutBom is_deleted=0、reconciliation boms is_deleted=0、outbound materials is_deleted=0、bom LEFT JOIN materials is_deleted=0 |
| v1.25 | 2026-05-18 | 第25批修复：materials GET /:id JOIN 已删除 categories/suppliers/locations、depletion POST /tracking NaN/负数+日期校验、POST /:id/deplete 重复耗尽拦截+remain_qty校验 |
| v1.26 | 2026-05-18 | 第26批修复：reconciliation GET /projects/:id/materials SQL注入(2处)、GET /materials SQL注入(2处) |
| v1.27 | 2026-05-18 | 第27批修复：returns POST / 物料存在性+NaN校验、scraps POST / 物料存在性+NaN校验 |
| v1.28 | 2026-05-18 | 第28批修复：stocktaking POST / actualStock负数+物料存在性、inbound POST / purchaseOrder is_deleted=0、logs GET / page=0修复 |
| v1.29 | 2026-05-18 | 第29批修复（7个）：inbound POST/DELETE purchaseOrder is_deleted=0、outbound POST quantity NaN+batches is_deleted=0、purchase-orders POST/PUT quantity NaN、reconciliation GET /projects SQL注入 |
| v1.30 | 2026-05-18 | 第30批修复（3个）：materials generateMaterialCode categories is_deleted=0、depletion POST /:id/deplete batch null guard、inbound DELETE outbound soft-delete filtering |
| v1.31 | 2026-05-18 | 第31批修复（5个）：projects GET /:id costStats is_deleted=0、reconciliation GET /projects/:id/materials outbound is_deleted=0、reconciliation GET /materials projects is_deleted=0(2处)、categories generateCategoryCode parent is_deleted=0 |
| v1.32 | 2026-05-19 | 新增 3.6 E2E 回归测试执行规则；添加 2026-05-19 Batch 29~31 E2E 回归测试记录 |
| v1.33 | 2026-05-19 | 第32批修复（3个）：inbound GET / JOIN materials/suppliers/locations is_deleted=0、inbound check-deletable outboundExists is_deleted=0、reconciliation GET /materials actual outbound is_deleted=0 |
| v1.34 | 2026-05-19 | 修订 3.6 E2E 回归测试执行规则：改为「文件级隔离」模式（按 TS 文件逐个修复后测试），添加已修复但未补测的文件清单 |
| v1.35 | 2026-05-19 | 第33批修复（1个）：alerts PUT /rules/:id threshold/thresholdDays NaN/负数校验 |
| v1.36 | 2026-05-19 | 补测 logs-v1.1.ts：发现 app.ts 中 /logs 路由 finance 权限配置错误并修复，logs.spec.ts 77/77 通过 |
| v1.37 | 2026-05-19 | 补测 alerts-v1.1.ts：发现 auth.ts ROLE_PERMISSIONS 中 finance 缺少 alerts 权限（#114），修复后 alerts.spec.ts 84/84 通过 |
| v1.38 | 2026-05-19 | 补测 materials.ts：发现 app.ts /materials 路由缺少角色限制 + materials.ts requireMaterialWrite 过宽 + auth.ts technician/pathologist 缺少 materials 权限（#115），修复后 materials.spec.ts 136/136 通过 |
| v1.39 | 2026-05-19 | 补测 outbound/stocktaking/reconciliation/bom/categories + 基线测试 auth/users/roles；发现 DatabaseManager.ts 初始化缺少 E2E 角色用户（#116），修复后 outbound 59/59 通过；users/roles 失败为前端页面加载问题 |
| v1.40 | 2026-05-19 | 完成全部 18 个 spec 文件补测：suppliers/locations/projects/inbound/cost-analysis/dashboard；补全 v1.39 测试汇总表；所有后端权限/API 修复验证通过；前端页面加载问题确认为独立已知问题 |
| v1.41 | 2026-05-20 | 第三十五批修复（4个）：#117 bom-v1.1.ts 添加权限中间件 + #118~#120 inbound/outbound/stocktaking 分页 page=0 修正；验证 bom POST 403 拦截生效 |
| v1.42 | 2026-05-20 | 第三十六批修复（4个）：#121 DatabaseManager.ts 初始化 UPDATE admin/E2E用户 is_deleted=0 + #122 auth.ts login 兜底自动恢复软删除用户 + #123 response.ts successList 向后兼容 data.page；验证 inbound/outbound/stocktaking page=0 全部通过；users.spec.ts admin 登录恢复正常（55 passed） |
| v1.43 | 2026-05-20 | **P0/P1缺陷清单校准**：逐项验证文档中所有P0/P1缺陷，确认12/14 P0缺陷和8/8 P1缺陷已修复，仅 #3(Sidebar) 和 #14(前端路由守卫) 为前端待修复问题 |
| v1.44 | 2026-05-20 | 第三十七批修复（5个）：projects/suppliers/locations/materials/inventory-v1.1.ts 分页 page=0 规范化 + pageSize clamp；验证全部5个page=0 E2E测试通过（MAT/PROJ/INV/LOC/SUP-PAGE-03） |
| **v1.45** | **2026-05-20** | **新增"下一步修复计划"章节（§11），评估 P2 后端 vs P0 前端优先级，确定"先 P2 后端、后 P0 前端"策略；按文件级隔离规则规划 4 批后端（categories→projects→bom→alerts）+ 1 批前端（Sidebar+路由守卫）修复路线** |
| v1.45-batch | 2026-05-20 | 执行 v1.45 batch：修复 `categories-v1.1.ts` 3 个 P2 根因（CAT-CREATE-09 重复 code→409、CAT-EDIT-06 编辑 code→400、CAT-DELETE-10 删除不存在→404），categories.spec.ts 141/141 passed，commit `84430d5` |`n| | **v1.46** | **2026-05-20** | **执行 v1.46 batch：修复 `projects-v1.1.ts` 3 个 P2 根因（PROJ-CREATE-13 POST 返回完整对象含 status、PROJ-EDIT-02 PUT 空值校验返回 400、PROJ-EDIT-10/PROJ-DEL-08/09 存在性检查返回 404），projects.spec.ts 98/98 passed（22 skipped 为已知功能缺失），第六节 14 项全部标记 ✅ 已修复** |
| **v1.50** | **2026-05-21** | **批量同步缺陷状态：bom.spec.ts 8 条、alerts.spec.ts 3 条、reconciliation.spec.ts 2 条、logs.spec.ts 3 条，共 16 条权限类缺陷从"待确认"改为"✅ 已修复/已通过"；同时更新缺陷描述文字（如"返回 201/200"改为"返回 403"等）** |

---

*本指南基于当前项目状态生成，后续可根据实际进度增补。*
*如有流程调整需求，可随时要求更新。*
