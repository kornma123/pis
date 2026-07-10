> **SUPERSEDED — DO NOT USE AS OPERATING INSTRUCTIONS.**
> 本文件的账户、用例数量、页面清单、安装命令和执行顺序都是历史快照。当前规则见 `docs/agent-operating-contract.md` 与 `.claude/rules/coreone-guardrails.md`；本地缺浏览器时先核对现有运行时和项目约束，不照抄下文安装指令。

# COREONE E2E 测试执行指南

> **版本**: v2.2
> **日期**: 2026-05-14
> **适用范围**: 全部 18 个模块 spec 文件，**2188** 个 E2E 测试用例

---

## 一、环境要求

| 组件 | 版本要求 | 说明 |
|:---|:---|:---|
| Node.js | >= 18 | 建议 v20 LTS |
| npm | >= 9 | 与 Node.js 配套 |
| Chromium | 已安装 | Playwright 内置或自定义路径 |
| 后端服务 | 运行中 | `http://127.0.0.1:3001` |
| 前端服务 | 运行中 | `http://localhost:8080` |

### 1.1 系统账户要求

系统必须预置以下测试账户（与 spec 文件中 `ROLES` 常量一致）：

| 角色 | 用户名 | 密码 | 说明 |
|:---|:---|:---|:---|
| admin | `admin` | `admin123` | 系统管理员，全部权限 |
| warehouse_manager | `cangguan` | `CoreOne2026!` | 仓库管理员 |
| technician | `jishuyuan1` | `CoreOne2026!` | 病理技术员 |
| pathologist | `yishi1` | `CoreOne2026!` | 病理医师 |
| procurement | `caigou` | `CoreOne2026!` | 采购专员 |
| finance | `caiwu` | `CoreOne2026!` | 财务专员 |

> ⚠️ **警告：禁止在修复过程中使用 PowerShell 的 `Get-ChildItem | ForEach-Object { Set-Content ... }` 进行批量文本替换。**  
> PowerShell `Set-Content` 默认使用系统编码（中文 Windows 为 GB2312/GBK），而非 UTF-8。这会导致所有中文字符被替换为 `�`（U+FFFD），彻底破坏 TypeScript 源文件。此前已发生一次全量 18 个 spec 文件被毁坏的事故。如需批量替换，请使用 Node.js 脚本并显式指定 `utf-8` 编码，或逐文件使用 `apply_diff` 工具进行精准编辑。

---

## 二、前置条件

### 2.1 启动后端服务

```bash
cd "后端代码/server"
npx tsx src/app.ts
```

验证后端启动成功：
```bash
curl http://127.0.0.1:3001/api/v1/health
```

### 2.2 启动前端服务

```bash
cd "前端代码"
npm run dev
```

验证前端启动成功：访问 `http://localhost:8080/login`

### 2.3 验证 Playwright 安装

```bash
cd "前端代码"
npx playwright --version
```

如未安装 Chromium：
```bash
npx playwright install chromium
```

---

## 三、测试文件清单与执行顺序

> ⚠️ **约束 1**：每次只执行一个测试文件，禁止一次性全量运行。
> ⚠️ **约束 2**：必须按以下评估的先后顺序逐文件执行，避免数据依赖冲突。
> ⚠️ **约束 3**：互相影响的测试用例，需在后续文件测试问题修复后，加入重测。
> ⚠️ **约束 4**：每修复一个文件后，执行一次 `git add`。

### 3.1 执行顺序评估（基于数据依赖关系）

| 批次 | 顺序 | 文件名 | 模块 | 前端路由 | 测试数 | 数据依赖 |
|:---|:---:|--------|------|----------|:---:|:---|
| 批次 0 | 1 | `auth.spec.ts` | 认证与登录 | `/login` | 175 | 无依赖，最优先 |
| 批次 0 | 2 | `dashboard.spec.ts` | 仪表盘 | `/` | 112 | 仅依赖登录状态 |
| 批次 1 | 3 | `categories.spec.ts` | 物料分类 | `/categories` | 141 | 无依赖，基础主数据 |
| 批次 1 | 4 | `materials.spec.ts` | 耗材管理 | `/materials` | 136 | 依赖 categories |
| 批次 1 | 5 | `suppliers.spec.ts` | 供应商管理 | `/suppliers` | 113 | 无依赖，基础主数据 |
| 批次 1 | 6 | `locations.spec.ts` | 库位管理 | `/locations` | 121 | 无依赖，基础主数据 |
| 批次 2 | 7 | `roles.spec.ts` | 角色权限 | `/roles` | 88 | 无依赖，系统管理 |
| 批次 2 | 8 | `users.spec.ts` | 用户管理 | `/users` | 97 | 依赖 roles 数据 |
| 批次 3 | 9 | `inbound.spec.ts` | 入库管理 | `/inbound` | 228 | 依赖 materials/suppliers/locations |
| 批次 3 | 10 | `outbound.spec.ts` | 出库管理 | `/outbound` | 138 | 依赖 materials/inventory |
| 批次 3 | 11 | `inventory-list.spec.ts` | 库存列表 | `/inventory` | 120 | 依赖 inbound/outbound 产生的库存 |
| 批次 3 | 12 | `stocktaking.spec.ts` | 库存盘点 | `/stocktaking` | 104 | 依赖 inventory 数据 |
| 批次 4 | 13 | `projects.spec.ts` | 检测项目 | `/projects` | 120 | 依赖 materials |
| 批次 4 | 14 | `bom.spec.ts` | BOM清单 | `/bom` | 119 | 依赖 materials |
| 批次 5 | 15 | `alerts.spec.ts` | 预警中心 | `/alerts` | 97 | 依赖 inventory 数据 |
| 批次 5 | 16 | `cost-analysis.spec.ts` | 物料成本分析 | `/cost-analysis` | 98 | 依赖 inbound/outbound 数据 |
| 批次 5 | 17 | `reconciliation.spec.ts` | 消耗对账 | `/reconciliation` | 104 | 依赖 projects/outbound 数据 |
| 批次 6 | 18 | `logs.spec.ts` | 操作日志 | `/logs` | 77 | 依赖其他操作产生的日志 |

**执行原则**：
- 按上表顺序逐文件执行，每完成一个文件并修复通过后，再进入下一个。
- 若批次 3 的 `inventory-list` 因 inbound/outbound 数据未就绪而失败，需先确保前序文件通过。
- `logs.spec.ts` 放在最后，因为日志记录依赖前面所有操作产生的审计数据。

### 3.2 不存在的页面（已排除）

以下模块已确认不存在独立前端页面，相关功能已合并到宿主页面：

| 功能 | 宿主页面 | 说明 |
|:---|:---|:---|
| ~~退货管理~~ | `/outbound` | 退货是 outbound 的一种 type |
| ~~报废管理~~ | `/inventory` 或 `/outbound` | 报废是弹窗或 outbound type |
| ~~调拨管理~~ | `/outbound` 或 `/inbound` | 调拨是 outbound/inbound 的 type |
| ~~采购订单~~ | `/inbound` | 采购订单只在入库弹窗中出现 |
| ~~消耗跟踪~~ | `/inventory` | Tab 切换嵌入库存列表 |

---

## 四、执行命令

### 4.1 运行单个文件（唯一允许的方式）

```bash
cd "前端代码"
npx playwright test e2e/auth.spec.ts
npx playwright test e2e/dashboard.spec.ts
npx playwright test e2e/categories.spec.ts
npx playwright test e2e/materials.spec.ts
npx playwright test e2e/suppliers.spec.ts
npx playwright test e2e/locations.spec.ts
npx playwright test e2e/roles.spec.ts
npx playwright test e2e/users.spec.ts
npx playwright test e2e/inbound.spec.ts
npx playwright test e2e/outbound.spec.ts
npx playwright test e2e/inventory-list.spec.ts
npx playwright test e2e/stocktaking.spec.ts
npx playwright test e2e/projects.spec.ts
npx playwright test e2e/bom.spec.ts
npx playwright test e2e/alerts.spec.ts
npx playwright test e2e/cost-analysis.spec.ts
npx playwright test e2e/reconciliation.spec.ts
npx playwright test e2e/logs.spec.ts
```

### 4.2 带调试模式运行

```bash
cd "前端代码"
npx playwright test e2e/auth.spec.ts --headed --debug
```

### 4.3 仅列出测试用例（不执行）

```bash
cd "前端代码"
npx playwright test e2e/auth.spec.ts --list
```

### 4.4 生成 HTML 报告

```bash
cd "前端代码"
npx playwright test e2e/auth.spec.ts --reporter=html
# 报告将输出到 e2e-report/index.html
```

---

## 五、修复循环流程（强制要求）

> 如果 Test Suite 中出现失败用例，**不要一次性分析所有**，而是执行修复循环，直到全部通过。

### 5.1 修复循环步骤

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: 运行当前文件                                         │
│   npx playwright test e2e/xxx.spec.ts                       │
├─────────────────────────────────────────────────────────────┤
│ Step 2: 如果有失败，运行 --last-failed 获取失败列表           │
│   npx playwright test --last-failed                         │
├─────────────────────────────────────────────────────────────┤
│ Step 3: 逐条分析失败原因（仅限脚本问题，不修改业务代码）        │
│   - 选择器过时/文本不匹配 → 修正测试脚本                     │
│   - 时序问题（元素未出现）→ 添加 waitFor 或 toBeVisible({timeout: 10000}) │
│   - 数据准备问题 → 在 beforeEach 中补充 seed 逻辑或 API 调用  │
├─────────────────────────────────────────────────────────────┤
│ Step 4: 每次修改后，重新运行该失败用例确认变绿               │
│   npx playwright test e2e/xxx.spec.ts --grep "用例名"       │
├─────────────────────────────────────────────────────────────┤
│ Step 5: 修复完所有失败用例后，重新运行全量套件确保无回归       │
│   npx playwright test e2e/xxx.spec.ts                       │
├─────────────────────────────────────────────────────────────┤
│ Step 6: 执行 git add                                        │
│   git add 前端代码/e2e/xxx.spec.ts                          │
├─────────────────────────────────────────────────────────────┤
│ Step 7: 进入下一个文件                                       │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 失败原因分类与修复策略

| 失败原因 | 识别特征 | 修复策略 |
|:---|:---|:---|
| **选择器过时** | `locator.click: Target page, context or browser has been closed` / `Timeout waiting for selector` | 更新选择器匹配当前 DOM 结构 |
| **文本不匹配** | `expect.toHaveText: expected "xxx" but got "yyy"` | 修正预期文本为实际渲染文本 |
| **时序问题** | `waiting for selector` / `element not visible` | 添加 `await page.waitForSelector()` 或增加 `{timeout: 10000}` |
| **数据准备缺失** | `NOT_FOUND` / `空状态` / `无数据` | 在 `test.beforeEach` 中通过 API 预置 seed 数据 |
| **状态残留** | 前序测试修改了数据导致后续断言失败 | 在 `test.beforeEach` 中执行 cleanup |
| **路由错误** | `page.goto: net::ERR_CONNECTION_REFUSED` | 检查前后端服务是否启动 |

### 5.3 修复记录表模板

每次修复循环结束后，输出如下格式的修复记录：

```markdown
| 用例 ID | 失败原因 | 修复内容 | 验证状态 |
|:---|:---|:---|:---:|
| AUTH-LOGIN-01 | 选择器过时 | `input[name="username"]` → `input[placeholder="用户名"]` | ✅ |
| INB-CREATE-03 | 时序问题 | 添加 `await page.waitForSelector('text=保存成功', {timeout: 10000})` | ✅ |
```

---

## 六、预期结果

### 6.1 单文件成功执行标志

```
Running 175 tests using 1 worker
[175/175] Passed
```

### 6.2 HTML 报告结构

执行后 `e2e-report/` 目录下生成：
- `index.html` — 汇总报告
- `data/` — 测试数据与截图
- 失败用例自动附带截图和视频（配置 `video: 'retain-on-failure'`）

---

## 七、故障排查

### 7.1 后端连接失败

**现象**: 测试报告 `ECONNREFUSED 127.0.0.1:3001`

**解决**:
```bash
cd "后端代码/server"
npx tsx src/app.ts
```

### 7.2 前端连接失败

**现象**: `page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8080`

**解决**:
```bash
cd "前端代码"
npm run dev
```

### 7.3 登录失败

**现象**: 大量测试因登录失败而跳过

**解决**: 检查数据库中是否存在 6 个测试账户：
```sql
SELECT username, role, status FROM users WHERE username IN ('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance');
```

### 7.4 Chromium 启动失败

**现象**: `Executable doesn't exist`

**解决**:
```bash
npx playwright install chromium
```

### 7.5 测试超时

**现象**: `Test timeout of 30000ms exceeded`

**解决**: 检查前端首屏加载时间，可在 `playwright.config.ts` 中增加超时：
```typescript
timeout: 60000,
```

---

## 八、CI/CD 集成建议

### 8.1 GitHub Actions 示例

```yaml
name: E2E Tests
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
        working-directory: ./前端代码
      - run: npx playwright install --with-deps chromium
        working-directory: ./前端代码
      - run: npm run test:e2e
        working-directory: ./前端代码
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: e2e-report
          path: 前端代码/e2e-report/
```

---

## 九、测试覆盖维度说明

每个 spec 文件遵循统一的 8 维度测试结构：

| 维度 | 测试代码前缀 | 说明 |
|:---|:---|:---|
| ① 正常用例 | `XXX-01` ~ `XXX-NN` | 主功能路径 |
| ② 空数据/边界 | `XXX-02`, `XXX-12` 等 | 空表、零值、越界 |
| ③ 表单校验错误 | `XXX-15`, `XXX-22` 等 | 必填缺失、格式错误 |
| ④ 权限拦截 | `TC-PERM-XXX` | 越权访问返回 403 |
| ⑤ 业务冲突 | `XXX-17`, `XXX-25` 等 | 重复提交、关联数据冲突 |
| ⑥ 并发/重复提交 | `XXX-18`, `XXX-27` 等 | 快速双击、并发请求 |
| ⑦ 异常后恢复 | `XXX-04`, `XXX-19` 等 | API 500、网络中断重试 |
| ⑧ UI 差异 | `XXX-05`, `XXX-06` 等 | 不同角色可见菜单/按钮 |
| 业务流程树 | `BF-XX-BX` | 跨页面业务流分支 |
| 盲点分析 | `BLIND-XXX` | 边界场景和隐性需求 |

---

## 十、维护记录

| 日期 | 版本 | 变更内容 |
|:---|:---|:---|
| 2026-05-14 | v1.0 | 初始版本，覆盖 18 个模块 596 个测试 |
| 2026-05-14 | v2.0 | 按 8 维度全量扩充至 **2188** 个测试 |
| 2026-05-14 | v2.1 | 增加执行顺序约束、单文件执行规则、修复循环流程、git add 要求 |
| 2026-05-14 | v2.2 | 修正系统账户表为真实 DB 凭证；更新各文件真实测试数（Playwright --list 实测）；增加 PowerShell 批量替换危险警告 |
