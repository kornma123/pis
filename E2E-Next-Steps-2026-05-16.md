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
| 1 | **inbound** | `POST /inbound` 含 `batchNo` 时 `expiryDate` SQLite 参数绑定失败，返回 500 | 58 | [`inbound-v1.1.ts`](后端代码/server/src/routes/inbound-v1.1.ts:147) |
| 2 | **stocktaking** | `POST /stocktaking` SQL 中 `"adjust"` 被 SQLite 解析为列名，返回 500 | 30 | [`stocktaking-v1.1.ts`](后端代码/server/src/routes/stocktaking-v1.1.ts:44) |
| 3 | **auth/dashboard** | Sidebar 未实现角色过滤，所有角色均显示 17 个菜单 | 19 | [`AppSidebar.tsx`](前端代码/src/components/layout/AppSidebar.tsx:34) |
| 4 | **categories** | `/categories` API 未做权限拦截，非 admin 可创建/编辑/删除 | 18 | [`categories-v1.1.ts`](后端代码/server/src/routes/categories-v1.1.ts:1) |
| 5 | **materials** | `/materials` API 未做权限拦截 + `batch-status` 接口缺失 | 14 | [`materials.ts`](后端代码/server/src/routes/materials.ts:1) |
| 6 | **bom** | `/boms` API 未做权限拦截 + 创建时参数校验缺陷返回 500 | 13 | [`boms-v1.1.ts`](后端代码/server/src/routes/boms-v1.1.ts:1) |
| 7 | **projects** | `/projects` API 未做权限拦截 | 10 | [`projects-v1.1.ts`](后端代码/server/src/routes/projects-v1.1.ts:1) |
| 8 | **alerts** | `/alerts/rules` API 未做权限拦截 | 6 | [`alerts-v1.1.ts`](后端代码/server/src/routes/alerts-v1.1.ts:22) |
| 9 | **suppliers** | `/suppliers` API 未对 `warehouse_manager` 做权限拦截 | 5 | [`suppliers-v1.1.ts`](后端代码/server/src/routes/suppliers-v1.1.ts:1) |
| 10 | **locations** | `/locations` API 未对 `warehouse_manager` 做权限拦截 | 4 | [`locations-v1.1.ts`](后端代码/server/src/routes/locations-v1.1.ts:1) |
| 11 | **outbound** | 后端未校验 `quantity <= 0`，返回 422 而非 400 | 3 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:57) |
| 12 | **logs** | `/logs` API 端点不存在（admin 返回 404） | 2 | [`app.ts`](后端代码/server/src/app.ts:1) |
| 13 | **reconciliation** | `/reconciliation` API 未做权限拦截 | 2 | [`reconciliation-v1.1.ts`](后端代码/server/src/routes/reconciliation-v1.1.ts:1) |
| 14 | **auth** | 前端路由无权限守卫，无权限角色可访问受保护页面 | 5 | [`App.tsx`](前端代码/src/App.tsx:1) |

### 2.5 P1 缺陷清单

| # | 模块 | 缺陷描述 | 影响用例数 | 涉及文件 |
|:---|:---|:---|:---:|:---|
| 1 | **stocktaking** | `page=0` 未修正为 1 | 1 | [`stocktaking-v1.1.ts`](后端代码/server/src/routes/stocktaking-v1.1.ts:19) |
| 2 | **projects** | `page=0` 未修正为 1 | 1 | [`projects-v1.1.ts`](后端代码/server/src/routes/projects-v1.1.ts:18) |
| 3 | **outbound** | `page=0` 未修正为 1 | 1 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:16) |
| 4 | **materials** | `page=0` / `pageSize=100` / `pageSize=200` 导致后端 500 | 3 | [`materials.ts`](后端代码/server/src/routes/materials.ts:1) |
| 5 | **suppliers** | `page=0` 未修正为 1 | 1 | [`suppliers-v1.1.ts`](后端代码/server/src/routes/suppliers-v1.1.ts:1) |
| 6 | **locations** | `page=0` 未修正为 1 | 1 | [`locations-v1.1.ts`](后端代码/server/src/routes/locations-v1.1.ts:1) |
| 7 | **inventory-list** | `page=0` 未修正为 1 | 1 | [`inventory-v1.1.ts`](后端代码/server/src/routes/inventory-v1.1.ts:1) |

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


### 3.6 修复优先级建议（第一批：P0 前 5 项）

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
| 1 | AUTH-LOGIN-05 | P0 | 待确认 | finance 登录后 sidebar 不显示"入库" | 显示"入库记录" | Sidebar 未角色过滤 | [`AppSidebar.tsx`](前端代码/src/components/layout/AppSidebar.tsx:34) |
| 2 | AUTH-LOGIN-06 | P0 | 待确认 | technician 登录后 sidebar 不显示"入库" | 显示"入库记录" | 同上 | 同上 |
| 3 | AUTH-LOGIN-08 | P0 | 待确认 | pathologist 登录后 sidebar 不显示"用户" | 显示"用户管理" | 同上 | 同上 |
| 4 | AUTH-LOGIN-09 | P0 | 待确认 | procurement 登录后 sidebar 不显示"出库" | 显示"出库记录" | 同上 | 同上 |
| 5 | BLIND-AUTH-02 | P2 | 待确认 | 已登录用户访问 /login 自动重定向到 / | 停留在 /login | Login.tsx 未检查已有 token | [`Login.tsx`](前端代码/src/pages/auth/Login.tsx:28) |
| 6 | BF-PERM-technician-inbound | P0 | 待确认 | technician 访问 /inbound 应被拦截 | 正常显示页面 | 前端路由无权限守卫 | [`App.tsx`](前端代码/src/App.tsx:1) |
| 7 | BF-PERM-procurement-stocktaking | P0 | 待确认 | procurement 访问 /stocktaking 应被拦截 | 正常显示页面 | 同上 | 同上 |
| 8 | BF-PERM-finance-stocktaking | P0 | 待确认 | finance 访问 /stocktaking 应被拦截 | 正常显示页面 | 同上 | 同上 |
| 9 | BF-PERM-pathologist-roles | P0 | 待确认 | pathologist 访问 /roles 应被拦截 | 正常显示页面 | 同上 | 同上 |
| 10 | BLIND-AUTH-04 | P0 | 待确认 | finance 上下文 sidebar 不显示"用户" | 显示"用户管理" | Sidebar 未角色过滤 | [`AppSidebar.tsx`](前端代码/src/components/layout/AppSidebar.tsx:34) |

### 6.2 dashboard.spec.ts（10 个）

| # | 用例 ID | 优先级 | 状态 | 预期行为 | 实际行为 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|:---|:---|
| 1 | DASH-PERM-06 | P0 | 待确认 | finance 仅显示 3 个菜单 | 显示 17 个菜单 | Sidebar 未角色过滤 | [`AppSidebar.tsx`](前端代码/src/components/layout/AppSidebar.tsx:34) |
| 2 | DASH-PERM-07 | P0 | 待确认 | technician 仅显示 6 个菜单 | 显示 17 个菜单 | 同上 | 同上 |
| 3 | DASH-PERM-09 | P0 | 待确认 | procurement 可访问采购相关菜单 | 显示全部菜单 | 同上 | 同上 |
| 4 | DASH-UI-01-warehouse_manager | P0 | 待确认 | 侧边栏 8-12 个菜单 | 17 个菜单 | 同上 | 同上 |
| 5 | DASH-UI-01-technician | P0 | 待确认 | 侧边栏 4-8 个菜单 | 17 个菜单 | 同上 | 同上 |
| 6 | DASH-UI-01-pathologist | P0 | 待确认 | 侧边栏 6-10 个菜单 | 17 个菜单 | 同上 | 同上 |
| 7 | DASH-UI-01-procurement | P0 | 待确认 | 侧边栏 6-10 个菜单 | 17 个菜单 | 同上 | 同上 |
| 8 | DASH-UI-01-finance | P0 | 待确认 | 侧边栏 3-6 个菜单 | 17 个菜单 | 同上 | 同上 |
| 9 | DASH-UI-03 | P0 | 待确认 | 非 admin 隐藏系统管理菜单 | 所有角色均显示用户/角色/日志 | 同上 | 同上 |
| 10 | BLIND-DASH-03 | P0 | 待确认 | finance 上下文不显示"用户" | finance 上下文可见"用户管理" | 同上 | 同上 |

### 6.3 categories.spec.ts（21 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | CAT-CREATE-08-warehouse_manager | P0 | 待确认 | 非 admin POST /categories 返回 201 | [`categories-v1.1.ts`](后端代码/server/src/routes/categories-v1.1.ts:1) |
| 2 | CAT-CREATE-08-technician | P0 | 待确认 | 同上 | 同上 |
| 3 | CAT-CREATE-08-pathologist | P0 | 待确认 | 同上 | 同上 |
| 4 | CAT-CREATE-08-procurement | P0 | 待确认 | 同上 | 同上 |
| 5 | CAT-CREATE-08-finance | P0 | 待确认 | 同上 | 同上 |
| 6 | CAT-EDIT-05-warehouse_manager | P0 | 待确认 | 非 admin PUT /categories 返回 200 | 同上 |
| 7 | CAT-EDIT-05-technician | P0 | 待确认 | 同上 | 同上 |
| 8 | CAT-EDIT-05-pathologist | P0 | 待确认 | 同上 | 同上 |
| 9 | CAT-EDIT-05-procurement | P0 | 待确认 | 同上 | 同上 |
| 10 | CAT-EDIT-05-finance | P0 | 待确认 | 同上 | 同上 |
| 11 | CAT-DELETE-06-warehouse_manager | P0 | 待确认 | 非 admin DELETE /categories 返回 200 | 同上 |
| 12 | CAT-DELETE-06-technician | P0 | 待确认 | 同上 | 同上 |
| 13 | CAT-DELETE-06-pathologist | P0 | 待确认 | 同上 | 同上 |
| 14 | CAT-DELETE-06-procurement | P0 | 待确认 | 同上 | 同上 |
| 15 | CAT-DELETE-06-finance | P0 | 待确认 | 同上 | 同上 |
| 16 | TC-PERM-CAT-01~05 | P0 | 待确认 | 非 admin POST 返回 201 | 同上 |
| 17 | TC-PERM-CAT-06~08 | P0 | 待确认 | 非 admin PUT/DELETE 返回 200 | 同上 |
| 18 | CAT-CREATE-09 | P2 | 待确认 | 重复 code 返回 400 而非 409 | 同上 |
| 19 | CAT-EDIT-06 | P2 | 待确认 | 编辑 code 返回 500 | 同上 |
| 20 | CAT-DELETE-10 | P2 | 待确认 | 删除不存在分类返回 200 而非 404 | 同上 |
| 21 | CAT-SEARCH-02 | P2 | 待确认 | 搜索无结果未显示空状态 | [`Categories.tsx`](前端代码/src/pages/master/Categories.tsx:1) |

### 6.4 materials.spec.ts（24 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | MAT-LIST-03 | P0 | 待确认 | finance GET /materials 返回 200 | [`materials.ts`](后端代码/server/src/routes/materials.ts:1) |
| 2 | MAT-CREATE-07-technician | P0 | 待确认 | technician POST 返回 201 | 同上 |
| 3 | MAT-CREATE-07-pathologist | P0 | 待确认 | pathologist POST 返回 201 | 同上 |
| 4 | MAT-CREATE-07-finance | P0 | 待确认 | finance POST 返回 201 | 同上 |
| 5 | MAT-EDIT-04-technician | P0 | 待确认 | technician PUT 返回 200 | 同上 |
| 6 | MAT-EDIT-04-pathologist | P0 | 待确认 | pathologist PUT 返回 200 | 同上 |
| 7 | MAT-EDIT-04-finance | P0 | 待确认 | finance PUT 返回 200 | 同上 |
| 8 | MAT-DEL-02-technician | P0 | 待确认 | technician DELETE 返回 200 | 同上 |
| 9 | MAT-DEL-02-pathologist | P0 | 待确认 | pathologist DELETE 返回 200 | 同上 |
| 10 | MAT-DEL-02-procurement | P0 | 待确认 | procurement DELETE 返回 200 | 同上 |
| 11 | MAT-DEL-02-finance | P0 | 待确认 | finance DELETE 返回 200 | 同上 |
| 12 | MAT-BATCH-01 | P0 | 待确认 | batch-status 接口 404/500 | 同上 |
| 13 | MAT-BATCH-02 | P0 | 待确认 | batch-status 接口 404/500 | 同上 |
| 14 | MAT-BATCH-04 | P0 | 待确认 | batch-status 接口 500 | 同上 |
| 15 | MAT-BATCH-07 | P2 | 待确认 | batch-status 接口 404/500 | 同上 |
| 16 | TC-PERM-MAT-01 | P0 | 待确认 | finance GET 返回 200 | 同上 |
| 17 | TC-PERM-MAT-04~06 | P0 | 待确认 | 非 admin POST 返回 201/200 | 同上 |
| 18 | BF-MAT-08 | P0 | 待确认 | technician POST 返回 201 | 同上 |
| 19 | MAT-PAGE-03 | P1 | 待确认 | page=0 返回 500 | 同上 |
| 20 | MAT-PAGE-06 | P1 | 待确认 | pageSize=100 返回 500 | 同上 |
| 21 | MAT-LIST-10 | P1 | 待确认 | pageSize=200 返回 500 | 同上 |
| 22 | MAT-DEL-08 | P2 | 待确认 | 删除不存在返回 200 而非 404 | 同上 |
| 23 | MAT-DEL-09 | P2 | 待确认 | 删除后再次删除返回 200 而非 404 | 同上 |

### 6.5 suppliers.spec.ts（10 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | SUP-CREATE-05-warehouse_manager | P0 | 待确认 | warehouse_manager POST 返回 201 | [`suppliers-v1.1.ts`](后端代码/server/src/routes/suppliers-v1.1.ts:1) |
| 2 | SUP-EDIT-04-warehouse_manager | P0 | 待确认 | warehouse_manager PUT 返回 200 | 同上 |
| 3 | SUP-EDIT-05 | P2 | 待确认 | 编辑 code 返回异常 | 同上 |
| 4 | SUP-EDIT-12 | P2 | 待确认 | 编辑不存在返回 200 而非 404 | 同上 |
| 5 | SUP-DEL-02-warehouse_manager | P0 | 待确认 | warehouse_manager DELETE 返回 200 | 同上 |
| 6 | SUP-DEL-08 | P2 | 待确认 | 删除不存在返回 200 而非 404 | 同上 |
| 7 | SUP-DEL-09 | P2 | 待确认 | 再次删除返回 200 而非 404 | 同上 |
| 8 | TC-PERM-029 | P0 | 待确认 | warehouse_manager POST 返回 201 | 同上 |
| 9 | BF-SUP-07 | P0 | 待确认 | warehouse_manager POST 返回 201 | 同上 |
| 10 | SUP-PAGE-03 | P1 | 待确认 | page=0 未修正为 1 | 同上 |

### 6.6 locations.spec.ts（8 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | LOC-EDIT-03-warehouse_manager | P0 | 待确认 | warehouse_manager PUT 返回 200 | [`locations-v1.1.ts`](后端代码/server/src/routes/locations-v1.1.ts:1) |
| 2 | LOC-EDIT-10 | P2 | 待确认 | 编辑不存在返回 200 而非 404 | 同上 |
| 3 | LOC-DEL-02-warehouse_manager | P0 | 待确认 | warehouse_manager DELETE 返回 200 | 同上 |
| 4 | LOC-DEL-08 | P2 | 待确认 | 删除不存在返回 200 而非 404 | 同上 |
| 5 | LOC-DEL-09 | P2 | 待确认 | 再次删除返回 200 而非 404 | 同上 |
| 6 | TC-PERM-053 | P0 | 待确认 | warehouse_manager POST 返回 201 | 同上 |
| 7 | BF-LOC-07 | P0 | 待确认 | warehouse_manager POST 返回 201 | 同上 |
| 8 | LOC-PAGE-03 | P1 | 待确认 | page=0 未修正为 1 | 同上 |

### 6.7 roles.spec.ts（2 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | ROLE-EDIT-06 | P2 | 待确认 | 并发编辑返回 500 | [`roles-v1.1.ts`](后端代码/server/src/routes/roles-v1.1.ts:1) |
| 2 | BLIND-ROLE-05 | P2 | 待确认 | 新建角色 code 可编辑 | [`Roles.tsx`](前端代码/src/pages/system/Roles.tsx:344) |

### 6.8 inbound.spec.ts（58 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1~58 | IN-CREATE-DIRECT/PO/RET/TRF/EDIT/DELETE/CANCEL/PAGE/BF/BLIND/TC-PERM 系列 | P0 | 待确认 | `expiryDate` SQLite 参数绑定失败导致 500 | [`inbound-v1.1.ts`](后端代码/server/src/routes/inbound-v1.1.ts:147) |

> **根因**：`POST /inbound` 含 `batchNo` 时，`expiryDate || null` 无法正确绑定到 SQLite 参数。

### 6.9 outbound.spec.ts（23 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | OUT-CREATE-PROJ-01~02 | P2 | 待确认 | 库存不足导致 422 | [`outbound.spec.ts`](前端代码/e2e/outbound.spec.ts:188) |
| 2 | OUT-CREATE-PROJ-10 | P2 | 待确认 | 并发都 422 | 同上 |
| 3 | OUT-CREATE-PROJ-17~18 | P0 | 待确认 | quantity=0/负数未校验，返回 422 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:57) |
| 4 | OUT-CREATE-PROJ-19 | P2 | 待确认 | 库存不足无法验证成本归集 | 同上 |
| 5 | OUT-CREATE-TRF-06 | P2 | 待确认 | 并发调拨都 422 | 同上 |
| 6 | OUT-CREATE-TRF-08 | P0 | 待确认 | quantity=0 返回 422 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:57) |
| 7 | OUT-CREATE-SCRAP-02 | P0 | 待确认 | 报废数量=0 返回 422 | 同上 |
| 8 | OUT-CREATE-SCRAP-06 | P2 | 待确认 | 并发报废都 422 | 同上 |
| 9 | OUT-CREATE-SCRAP-08 | P0 | 待确认 | 负数报废返回 422 | 同上 |
| 10 | OUT-BOM-01~11 | P3 | 待确认 | `POST /outbound/bom` 端点未实现 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:1) |
| 11 | OUT-PAGE-03 | P1 | 待确认 | page=0 未修正为 1 | [`outbound-v1.1.ts`](后端代码/server/src/routes/outbound-v1.1.ts:16) |
| 12 | BF-OUT-08 | P3 | 待确认 | `/outbound/bom` 404/500 | 同上 |
| 13 | BF-OUT-13 | P3 | 待确认 | BOM 出库后成本归集无法验证 | 同上 |

### 6.10 inventory-list.spec.ts（1 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | INV-PAGE-03 | P1 | 待确认 | page=0 未修正为 1 | [`inventory-v1.1.ts`](后端代码/server/src/routes/inventory-v1.1.ts:1) |

### 6.11 stocktaking.spec.ts（31 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1~30 | ST-CREATE/ADJUST/TC-PERM/BF/BLIND 系列 | P0 | 待确认 | `"adjust"` 被 SQLite 解析为列名，返回 500 | [`stocktaking-v1.1.ts`](后端代码/server/src/routes/stocktaking-v1.1.ts:44) |
| 31 | ST-PAGE-03 | P1 | 待确认 | page=0 未修正为 1 | [`stocktaking-v1.1.ts`](后端代码/server/src/routes/stocktaking-v1.1.ts:19) |

### 6.12 projects.spec.ts（14 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | PROJ-CREATE-06-technician | P0 | 待确认 | 非 admin POST 返回 201 | [`projects-v1.1.ts`](后端代码/server/src/routes/projects-v1.1.ts:1) |
| 2 | PROJ-CREATE-06-pathologist | P0 | 待确认 | 同上 | 同上 |
| 3 | PROJ-CREATE-13 | P2 | 待确认 | 新建后 status 为 undefined | 同上 |
| 4 | PROJ-EDIT-02 | P2 | 待确认 | 清空必填字段返回 200 | 同上 |
| 5 | PROJ-EDIT-03-technician | P0 | 待确认 | 非 admin PUT 返回 200 | 同上 |
| 6 | PROJ-EDIT-03-pathologist | P0 | 待确认 | 同上 | 同上 |
| 7 | PROJ-EDIT-10 | P2 | 待确认 | 编辑不存在返回 200 而非 404 | 同上 |
| 8 | PROJ-DEL-02-technician | P0 | 待确认 | 非 admin DELETE 返回 200 | 同上 |
| 9 | PROJ-DEL-02-pathologist | P0 | 待确认 | 同上 | 同上 |
| 10 | PROJ-DEL-08 | P2 | 待确认 | 删除不存在返回 200 而非 404 | 同上 |
| 11 | PROJ-DEL-09 | P2 | 待确认 | 再次删除返回 200 而非 404 | 同上 |
| 12 | PROJ-PAGE-03 | P1 | 待确认 | page=0 未修正为 1 | 同上 |
| 13 | TC-PERM-104/105 | P0 | 待确认 | 非 admin POST 返回 201/409 | 同上 |
| 14 | BF-PROJ-07 | P0 | 待确认 | technician POST 返回 409 | 同上 |

### 6.13 bom.spec.ts（20 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | BOM-CREATE-01/14/15/16 | P0 | 待确认 | 特定场景下 POST /boms 返回 500 | [`boms-v1.1.ts`](后端代码/server/src/routes/boms-v1.1.ts:1) |
| 2 | BOM-CREATE-06-technician | P0 | 待确认 | 非 admin POST 返回 201 | 同上 |
| 3 | BOM-CREATE-06-pathologist | P0 | 待确认 | 同上 | 同上 |
| 4 | BOM-EDIT-03-technician | P0 | 待确认 | 非 admin PUT 返回 200 | 同上 |
| 5 | BOM-EDIT-03-pathologist | P0 | 待确认 | 同上 | 同上 |
| 6 | BOM-DEL-01 | P0 | 待确认 | 创建即 500 无 ID 可删 | 同上 |
| 7 | BOM-DEL-02-technician | P0 | 待确认 | 非 admin DELETE 返回 200 | 同上 |
| 8 | BOM-DEL-02-pathologist | P0 | 待确认 | 同上 | 同上 |
| 9 | BOM-DEL-08 | P2 | 待确认 | 删除不存在返回 200 而非 404 | 同上 |
| 10 | TC-PERM-112/113 | P0 | 待确认 | 非 admin POST 返回 201 | 同上 |
| 11 | BF-BOM-01 | P0 | 待确认 | 新建业务流程返回 500 | 同上 |
| 12 | BF-BOM-07 | P0 | 待确认 | technician POST 返回 201 | 同上 |
| 13 | BLIND-BOM-01 | P0 | 待确认 | 编码唯一性校验无法验证 | 同上 |
| 14 | BLIND-BOM-10 | P2 | 待确认 | XSS 特殊字符返回 500 | 同上 |
| 15 | BLIND-BOM-11 | P2 | 待确认 | SQL 注入特殊字符返回 500 | 同上 |
| 16 | BLIND-BOM-16 | P2 | 待确认 | 小数用量返回 500 | 同上 |

### 6.14 alerts.spec.ts（8 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | ALERT-HANDLE-03 | P2 | 待确认 | 处理不存在预警返回 200 而非 404 | [`alerts-v1.1.ts`](后端代码/server/src/routes/alerts-v1.1.ts:58) |
| 2 | ALERT-RULE-05 | P0 | 待确认 | warehouse_manager PUT 返回 200 | [`alerts-v1.1.ts`](后端代码/server/src/routes/alerts-v1.1.ts:22) |
| 3 | TC-PERM-116~119 | P0 | 待确认 | 非 admin PUT /alerts/rules 返回 200 | 同上 |
| 4 | TC-PERM-ALERT-EXTRA-02 | P0 | 待确认 | 某角色 GET /alerts 返回 403 | [`alerts-v1.1.ts`](后端代码/server/src/routes/alerts-v1.1.ts:36) |
| 5 | BF-ALERT-04 | P2 | 待确认 | 处理不存在预警返回 200 而非 404 | 同上 |

### 6.15 reconciliation.spec.ts（2 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | TC-PERM-RECON-03 | P0 | 待确认 | pathologist GET 返回 200 | [`reconciliation-v1.1.ts`](后端代码/server/src/routes/reconciliation-v1.1.ts:1) |
| 2 | TC-PERM-RECON-09 | P0 | 待确认 | finance POST 返回 200 | 同上 |

### 6.16 logs.spec.ts（3 个）

| # | 用例 ID | 优先级 | 状态 | 缺陷描述 | 涉及文件 |
|:---|:---|:---:|:---|:---|:---|
| 1 | TC-PERM-LOG-04 | P0 | 待确认 | finance GET /logs 返回 200 | [`logs-v1.1.ts`](后端代码/server/src/routes/logs-v1.1.ts:1) |
| 2 | TC-PERM-LOG-06 | P0 | 待确认 | admin GET /logs 返回 404 | [`app.ts`](后端代码/server/src/app.ts:1) |
| 3 | BLIND-LOG-10 | P2 | 待确认 | admin GET /logs 返回 404 | 同上 |

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

---

*本指南基于当前项目状态生成，后续可根据实际进度增补。*
*如有流程调整需求，可随时要求更新。*
