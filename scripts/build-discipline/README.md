# 构建纪律闸（Build Discipline Gate）

> 把 **P0 设计选择 #7**——「**完成 = 真数据跑通 + 人工核对一致 · 消费者被服务**」，不是「代码合并」——
> 从只在 P0 成本域执行，推广成**全系统机器可执行规则**。
> 目的：根除反复出现的「功能先于消费者被建」五形态：幽灵端点 / 有后端无前端 / 孤儿路由 / 空转参数 / 假能力。
> 背景见记忆 `coreone-feature-keep-cut-inventory`「外审补正」段。

## 三条检查

| ID | 名称 | 根除的病 | 判定 |
|----|------|---------|------|
| **C1** | 前端→后端 | 幽灵 404 | 每条前端 API 调用（`request.METHOD` + `axios.METHOD` + `fetch('/api/v1/...')` + 回溯解析的 `fetch(变量)`）必须命中一个已注册后端路由（`app.ts` 挂载前缀 × `routes/*.ts` 的 `router.METHOD`），否则违规 |
| **C2** | 后端→消费者 | 有后端无前端 / 死路由 | 每个后端端点须有 ≥1 生产消费者（前端调用 / 「发请求文件」文本兜底）；无则须进白名单带 `{owner, deadline}`；死线过期未接消费者 → 违规、默认删 |
| **C3** | 配置→引擎 | 空转参数 | 每个用户可写的持久化配置字段（建表列 ∩ 出现在某路由 INSERT/UPDATE）须在其自身 CRUD 之外有读取点（snake_case 或 camelCase），否则=空转（`allocation_base` 型） |

### ⚠️ 覆盖诚实声明：五形态里机器只查得了四种

「功能先于消费者被建」有**五形态**，本闸机器可查 **4 种**：幽灵端点（C1）· 有后端无前端（C2）· 死路由（C2）· 空转参数（C3）。
- **孤儿路由**（后端+前端页都有、只缺侧栏入口）= 可发现性缺口非"该删"，**本闸不检出**——靠既有前端审计 + 侧栏比对（见 I-1 PR#65）。
- **假能力**（第 5 形态·项目定为**最高危 Tier「止骗」**，如 `/abc/variance` 假标准成本：`totalStandard=materialActual`、labor/equip/indirect 硬编码 0）= 「输出口径假」而非字段空转，**本闸无对应机器检查**，靠人工审计（处置口径见记忆 `coreone-feature-keep-cut-inventory`）。
> 所以别把「三条检查」读成「五形态全自动拦住了」——**最高危的假能力仍靠人**。这条写在这里就是防「以为质量门自动在跑」的假象（本项目屡次踩过的坑）。

## 用法

```bash
# 全部 warn（默认，永远 exit 0，把存量报告打到 stdout）
node scripts/build-discipline/run-all.cjs

# 只跑某条
node scripts/build-discipline/run-all.cjs --only=C1

# 切拦截：仅 C1 拦（有违规则 exit 1），C2/C3 仍 warn
node scripts/build-discipline/run-all.cjs --block=C1

# 三条全拦 + 机器可读 JSON
node scripts/build-discipline/run-all.cjs --block=C1,C2,C3 --json

# 自测（守护工具自身不被改坏；CI 必跑）
node scripts/build-discipline/selftest.cjs
```

零依赖、纯 Node（`node:` 内建），不编译 TS——正则静态扫描。

## ★ delta 棘轮（防新增，不只盘存量）★

这是本闸从「一次性报告」变成「真门」的关键。`baseline.json` 记录当前**已接受的存量违规**键集合。每次运行把违规分成：
- **存量已知**（在 baseline 里）——历史欠账，不拦；
- **🆕 新增**（不在 baseline 里）——本次 PR 引入的新病，**`--block` 只拦这个**。

于是可以**立刻**对干净的检查开 `--block`（如 C1），而**不会被 45 条历史存量红墙挡住所有无关 PR**。存量只减不增：修掉一条就 `--update-baseline` 收紧棘轮（`baseline.json` 的 diff 在 PR 里可见、须说明）。这让 PR 模板「无**新增**违规」成为机器可判定的事实（回应独立复核逮到的「工具算的是绝对存量、模板却要你保证'无新增'」硬伤）。护栏：`--update-baseline` 与 `--block` 互斥、被 `--block` 的检查不可被 `--only` 排除（否则 exit 2，防"缴械拦截却假绿"）。

无 `baseline.json` 时 **fail-closed**：全部计为新增（逼你先生成基线再谈 block，防基线丢失时静默放行）。

## 文件

- `lib/registry.cjs` — 共享解析层（app 挂载 / router 端点 / 前端调用[request/axios/fetch/fetch-var 回溯] / 路径归一 / 匹配）。
- `check-frontend-to-backend.cjs`（C1）/ `check-backend-consumers.cjs`（C2）/ `check-config-engine.cjs`（C3）。
- `run-all.cjs` — 统一入口（`--only` / `--block` / `--json` / `--update-baseline`）。
- `selftest.cjs` — 工具不变量自测（22 条已核实断言，防解析器静默漂）。
- `consumer-whitelist.json` — C2 白名单（**有名有期的孵化**）。
- `baseline.json` — delta 棘轮基线（当前已接受存量键；只减不增）。

## 防误报（重要）

三条都**先在 CI 以 warn 跑一轮看误报率、再逐条切 block**（当前全 warn）。已内建的防误报：

- **C1 动态路径**：`fetch(变量)` / 非 `/` 开头的运行时拼接路径 → 标 unresolvable、**跳过、不当违规**。模板串 `${id}` 归一为 param 段；`cost-drivers${query}` 只取 literal 前缀。
- **C2 文本兜底（精确形状）**：端点须按其**完整路径形状**（各字面段齐 + param 处为 `${...}` 模板插值）出现在**发请求的文件**里才算「被消费」——覆盖「动态 `fetch(url)` 拼路径」这类静态匹配不到但确有消费的情况，同时**不因共享前缀把死的兄弟子路由误判消费**（独立复核 HIGH 修复）。白名单支持 `external`（外部/手动调用）/`incubating`（开发中新路由）合法豁免。
- **C3 置信分层**：只有「计算旋钮」名（`_base`/`_method`/`_rate`/`allocation`…）却无人读的才是**高置信**（拦截只看它）；纯展示/记录字段（`model`/`zone`/`system_stock`…）归**低置信仅报告**，不拦截。

## 落地节奏（warn → block）——有 owner、有据可依，不是"永远 warn"

> 独立复核提醒：一个永远 `exit 0`、非 required 的"门"= 治理表演（项目已有 e2e 常年红没人消费的前车）。**delta 棘轮**让 block 可**立刻**切（只拦新增、不被存量挡）。flip 决策 + 死线已登记 **`docs/PM待拍板.md` M-6**（有 owner、有日期），不靠口头承诺。

1. **现在**：全 warn（本 task 定"先 warn 跑一轮看误报率"）。`.github/workflows/build-discipline.yml` 每 PR 跑，报告进 CI 日志；`selftest` 必过（工具坏了即红）。
2. **切 C1（棘轮·随时可切）**：C1 已实证 **0 误报**（9 幽灵全真）。因 delta 棘轮只拦**新增**，切 `--block=C1` **无需先清存量**、不会红墙无关 PR。切法=改 workflow Gate 命令为 `--block=C1` + 把本 workflow 加进 master 分支保护 required checks。→ PM 拍板见 M-6。
3. **切 C2**：同理 `--block=C1,C2`（棘轮只拦新增无消费者端点；存量按存量清单在「修非 P0 域」task 处置）。
4. **C3**：高置信稳定后可选 `--block=C1,C2,C3`（只拦新增高置信）；低置信长期仅报告。
5. **白名单死线兑现**：`consumer-whitelist.json` 的 deadline 过期→该端点从豁免翻违规。**但仅在 block 模式才真的红**——故死线兑现依赖第 2 步已切 block + 有人 review baseline diff。这条也在 M-6 一并拍。

## 存量清单

一次性存量盘点见 `docs/COREONE-构建纪律闸-存量违规清单-2026-07-06.md`（按危害分层）。
**逐项处置在另一个「修非 P0 域」task**——本闸只负责「立规 + 出清单 + 防新增」。
