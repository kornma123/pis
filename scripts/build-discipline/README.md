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

## ★ 白名单 / baseline fail-closed（旁路口自堵·公理一）★

> 背景（P-5/P-6）：闸有两个「豁免旁路口」——C2 白名单（孵化名单）与 baseline（存量赦免簿）。它们过去
> **fail-open**（自己犯了闸要治的病）：`wl.deadline && wl.deadline < today` 对**缺 deadline** 的条目短路成
> 「永不过期=永久放行」；白名单/baseline 都**无条数上限**、baseline 存量**无死线无负责人=无限期赦免**。
> 现按 **fail-closed** 缺省方向重做：**忘填/过期/膨胀 = 红**（把疏漏顶回作者，绝不让「临时」沉淀成永久债）。

这些是**治理完整性**违规，`run-all` 对其**无条件红**（exit 1）——**不受 `--block`/baseline delta 影响、不受 `--only` 豁免、不可 `--update-baseline` 洗白**。缺省方向即安全底线。

**A · C2 白名单三条**（`check-backend-consumers.cjs` `validateWhitelist`）：
1. **缺 `deadline` = 红**（缺省方向反转：忘填=已过期，而非永不过期放行）；坏格式（非 `YYYY-MM-DD`）亦红。
2. **`deadline` ≤ `today + 120 天`**（`MAX_DEADLINE_HORIZON_DAYS`）：超上限=红（防填 2099 变相永久豁免）。存量真实条目坐落 today+~90 天，120 给足 grandfather 余量、对 2099 仍决定性拦截。
3. **白名单条数 ≤ 12**（`MAX_WHITELIST_ENTRIES`）：超上限=红（防孵化名单膨胀成万年赦免簿）。
   - 结构无效的条目**不豁免其覆盖端点**（旁路口堵上）：该端点直接进 C2 违规。

**B · baseline 治理三条**（`lib/baseline-governance.cjs`）：
1. **per-entry 死线兑现**（`baseline.meta[key]={owner,deadline,note}`）：给「害人型」存量挂负责人+死线，**过期未处置=红**（催：改前端死调用/补真只读路由后 `--update-baseline` 清出，或经 PM 拍板续期）。非强制全员挂——只给需要现在就动的。
2. **净条数天花板**（`baseline.targetMaxCount`）：封顶存量条数，**超顶=红**；`--update-baseline` 也不许越顶吸入新增。抬高天花板须在 PR diff 里显式改+说明理由。
3. **被依赖者禁入死物名单**：某 `C2|` baseline 键对应端点**现被消费**（活跃业务依赖）→ 红（被依赖=非死物，不许赖在「无消费者」死物豁免簿里；修法=`--update-baseline` 自然清出）。

**已挂死线的害人型存量**（B.1/B.3）：`C1|GET|/reports/personnel-efficiency`、`C1|GET|/reports/cost-monthly-comparison`——前端 `前端代码/src/api/reports.ts` 仍 live 调、后端恒 404、真人被喂 404。死线 `2026-08-07`：到期仍没修 → 闸红，逼处置（改前端或补只读路由；均属业务代码，另立 task/PR）。

## 文件

- `lib/registry.cjs` — 共享解析层（app 挂载 / router 端点 / 前端调用[request/axios/fetch/fetch-var 回溯] / 路径归一 / 匹配）。
- `lib/baseline-governance.cjs` — baseline fail-closed 治理（meta 死线 / 净条数天花板 / 被依赖者禁入死物名单）·纯函数可测。
- `check-frontend-to-backend.cjs`（C1）/ `check-backend-consumers.cjs`（C2·含白名单 fail-closed `validateWhitelist`）/ `check-config-engine.cjs`（C3）。
- `run-all.cjs` — 统一入口（`--only` / `--block` / `--json` / `--update-baseline`）+ fail-closed 治理层汇总（无条件红）。
- `selftest.cjs` — 工具不变量自测（41 条已核实断言，含 fail-closed 变异断言证有牙，防解析器/闸静默漂）。
- `consumer-whitelist.json` — C2 白名单（**有名有期的孵化**，fail-closed：缺 deadline/超上限/超条数=红）。
- `baseline.json` — delta 棘轮基线（当前已接受存量键；只减不增）+ `meta`（per-entry 死线）+ `targetMaxCount`（净条数天花板）。

## 防误报（重要）

三条都**先在 CI 以 warn 跑一轮看误报率、再逐条切 block**（当前全 warn）。已内建的防误报：

- **C1 动态路径**：`fetch(变量)` / 非 `/` 开头的运行时拼接路径 → 标 unresolvable、**跳过、不当违规**。模板串 `${id}` 归一为 param 段；`cost-drivers${query}` 只取 literal 前缀。
- **C2 文本兜底（精确形状）**：端点须按其**完整路径形状**（各字面段齐 + param 处为 `${...}` 模板插值）出现在**发请求的文件**里才算「被消费」——覆盖「动态 `fetch(url)` 拼路径」这类静态匹配不到但确有消费的情况，同时**不因共享前缀把死的兄弟子路由误判消费**（独立复核 HIGH 修复）。白名单支持 `external`（外部/手动调用）/`incubating`（开发中新路由）合法豁免。
- **C3 置信分层**：只有「计算旋钮」名（`_base`/`_method`/`_rate`/`allocation`…）却无人读的才是**高置信**（拦截只看它）；纯展示/记录字段（`model`/`zone`/`system_stock`…）归**低置信仅报告**，不拦截。

## 落地节奏（warn → block）——有 owner、有据可依，不是"永远 warn"

> 独立复核提醒：一个永远 `exit 0`、非 required 的"门"= 治理表演（项目已有 e2e 常年红没人消费的前车）。**delta 棘轮**让 block 可**立刻**切（只拦新增、不被存量挡）。flip 决策 + 死线已登记 **`docs/PM待拍板.md` M-6**（有 owner、有日期），不靠口头承诺。

1. **现在**：全 warn（本 task 定"先 warn 跑一轮看误报率"）。`.github/workflows/build-discipline.yml` 每 PR 跑，报告进 CI 日志；`selftest` 必过（工具坏了即红）。
2. **切 C1（已落地·2026-07-07·PM 拍 M-6①）**：C1 已切 `--block=C1`——对**新增**幽灵404判红拦合并；`gate` 已加入 master required checks；workflow 的 PR 侧 paths-ignore 已移除（否则 required 永不上报卡 PR）。存量 9 幽灵在 baseline、不拦无关 PR。
3. **切 C2（已落地·2026-07-07·PM 拍 M-6 续）**：`--block=C1,C2`——对**新增**无消费者端点判红。`gate` 已 required、无需再动分支保护。误报/孵化走 `consumer-whitelist.json`（owner+deadline）豁免。存量 33 在 baseline、不拦无关 PR。
4. **C3 保持 warn（PM 拍 M-6·不切 block）**：C3 最模糊——硬拦会误伤「计算内联在路由、非独立 util」的合法配置字段（喊狼），且无干净豁免出口。日后若要拦，须先给 C3 加**逐字段豁免清单**（类比 C2 白名单）+ 收紧判定，把误报压下去再切。当前只报告 + 存量清单供人工处置。
5. **白名单死线兑现**：`consumer-whitelist.json` 的 deadline 过期→该端点从豁免翻违规。C2 已 block（第 3 步），故 deadline 到期(2026-10-06)会真的红——须有人 review baseline diff / 处置。

## 存量清单

一次性存量盘点见 `docs/COREONE-构建纪律闸-存量违规清单-2026-07-06.md`（按危害分层）。
**逐项处置在另一个「修非 P0 域」task**——本闸只负责「立规 + 出清单 + 防新增」。
