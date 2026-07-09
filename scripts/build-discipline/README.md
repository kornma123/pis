# 构建纪律闸（Build Discipline Gate）

> 把 **P0 设计选择 #7**——「**完成 = 真数据跑通 + 人工核对一致 · 消费者被服务**」，不是「代码合并」——
> 从只在 P0 成本域执行，推广成**全系统机器可执行规则**。
> 目的：根除反复出现的「功能先于消费者被建」五形态：幽灵端点 / 有后端无前端 / 孤儿路由 / 空转参数 / 假能力。
> 背景见记忆 `coreone-feature-keep-cut-inventory`「外审补正」段。

## 检查项（C1–C4「功能先于消费者」轴 + C5「授权可枚举性」轴）

> **两条正交轴**：C1–C4 治「功能先于消费者被建」（幽灵端点 C1 / 无消费者 C2 / 空转参数 C3 / 孤儿路由 C4）；C5 是另一条**正交轴**——授权可枚举性（野生授权逻辑）。C4（路由↔导航注册表）与 C5（授权组合子）都挂 run-all 的 fail-closed 治理层、各自独立无 baseline 棘轮。

| ID | 名称 | 根除的病 | 判定 |
|----|------|---------|------|
| **C1** | 前端→后端 | 幽灵 404 | 每条前端 API 调用（`request.METHOD` + `axios.METHOD` + `fetch('/api/v1/...')` + 回溯解析的 `fetch(变量)`）必须命中一个已注册后端路由（`app.ts` 挂载前缀 × `routes/*.ts` 的 `router.METHOD`），否则违规 |
| **C2** | 后端→消费者 | 有后端无前端 / 死路由 | 每个后端端点须有 ≥1 生产消费者（前端调用 / 「发请求文件」文本兜底）；无则须进白名单带 `{owner, deadline}`；死线过期未接消费者 → 违规、默认删 |
| **C3** | 配置→引擎 | 空转参数 | 每个用户可写的持久化配置字段（建表列 ∩ 出现在某路由 INSERT/UPDATE）须在其自身 CRUD 之外有读取点（snake_case 或 camelCase），否则=空转（`allocation_base` 型） |
| **C4** | 路由→导航注册表 | 孤儿路由 / 新页无归宿 | 每条 `App.tsx` 应用路由（`/login`、`*` 除外）必须在 `前端代码/src/lib/route-registry.ts` 声明：`active`（须 `navGroup ∈` 封闭枚举 NAV_GROUPS + `label`）或 `headless`（须 `owner`+`due`死线+`reason`·fail-closed）或 `deprecated`（须 `reason`）；否则红。菜单从注册表派生（不再各处手写 MenuItem）→ **孤儿化在构造上不可能** |
| **C5** | 授权组合子 | 野生授权逻辑（不可枚举的授权条件） | `routes/*.ts` 的 handler 里禁止裸写授权条件——① 禁对「请求用户」做 `.role`/`.roles` 访问（点/可选链/别名/解构/方括号）② 禁裸写 SoD 判决码 `SELF_REVIEW_FORBIDDEN` ③ 禁内联「请求用户身份（userId/username/id）=== 行字段」比对。授权只能经具名组合子表达（`middleware/authz-combinators.ts` + `permissions.ts` + `auth.ts`）→ 条件集可机器枚举（权限影子断言矩阵前置） |

> **C5 是独立轴、零容忍**：与 C1/C2/C3 的「防新增·存量攒 baseline」不同，C5 **无 baseline 宽容**——任一野生授权即无条件红（授权缺口不是可攒的存量债），接在 run-all 的 fail-closed 治理层（公理一）。**覆盖边界（诚实）**：C5 是正则/tokenizer 级，闭包覆盖「直接对 `req.user` 的授权写法」；**不覆盖**先抽标量再比对的派生变量（`const uid=req.user.userId; if(uid===…)`）、经 helper 读角色（`resolveRequestRoles(req.user).includes(…)`）、capability 内联判决——这些靠「注册表 + 人工复核」兜底（要闭合需强制 `req.user` 唯一访问器，会牵动 ~30 处合法 attribution，超出结构重构范围）。

### ⚠️ 覆盖诚实声明：五形态里机器查得了四种半

「功能先于消费者被建」有**五形态**，本闸机器可查：幽灵端点（C1）· 有后端无前端（C2）· 死路由（C2）· 空转参数（C3）· **孤儿路由（C4·结构预防）**。
- **孤儿路由**（后端+前端页都有、只缺侧栏入口）现由 **C4 结构预防**：新页无注册表声明即红；无导航入口的页必须显式 `headless` 带死线（=periodic 重新分诊·忘填≠永久绿），不能悄悄漂成孤儿。**但 C4 不替人拍「这页该删还是该补入口」**——它把孤儿从「静默漂移」变成「显式带死线的待办」，去留仍是人的分诊（见 I-1 PR#65 / ABC 处置清单 #61）。
- **假能力**（第 5 形态·项目定为**最高危 Tier「止骗」**，如 `/abc/variance` 曾假标准成本：`totalStandard=materialActual`、labor/equip/indirect 硬编码 0·已 #99/P-7 诚实降级为返 null）= 「输出口径假」而非字段空转，**本闸无对应机器检查**，靠人工审计（处置口径见记忆 `coreone-feature-keep-cut-inventory`）。
> 所以别把「四条检查」读成「五形态全自动拦住了」——**最高危的假能力仍靠人**。这条写在这里就是防「以为质量门自动在跑」的假象（本项目屡次踩过的坑）。

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
2. **净条数天花板**（`baseline.targetMaxCount`）：封顶存量条数，**超顶=红**；**非空 baseline 缺 `targetMaxCount` 本身也=红**（fail-closed：堵「删掉这行=悄悄取消封顶」的旁路口；`--update-baseline` 会给每份新基线自动播种一个天花板）。`--update-baseline` 也不许越顶吸入新增。抬高天花板须在 PR diff 里显式改+说明理由。
3. **被依赖者禁入死物名单**：某 `C2|` baseline 键对应端点**现被消费**（活跃业务依赖）→ 红（被依赖=非死物，不许赖在「无消费者」死物豁免簿里；修法=`--update-baseline` 自然清出）。

**不受 `--only` 影响**：白名单(A) 与 B.2 消费集校验会**无条件跑一次 C2** 取治理数据（即使 `--only` 把 C2 排除），`--update-baseline` 更禁与 `--only` 同用——否则 `--only=C1` 会静默跳过校验/用局部快照截断整份基线。`--update-baseline` 的拒绝判定用**将写入的新 doc** 复算（「存量已修→键掉出→干净」的合法清理不会被旧 doc 的过期 meta 自我死锁）。

**已挂死线的害人型存量**（B.1/B.3）：`C1|GET|/reports/personnel-efficiency`、`C1|GET|/reports/cost-monthly-comparison`——前端 `前端代码/src/api/reports.ts` 仍 live 调、后端恒 404、真人被喂 404。死线 `2026-08-07`：到期仍没修 → 闸红，逼处置（改前端或补只读路由；均属业务代码，另立 task/PR）。
> ⚠️ **爆炸半径（必须知情）**：`gate` 是 master **required check** 且 PR 侧无 `paths-ignore`，故该死线到期后闸红会**拦截所有到 master 的 PR**（含与报表无关者），直到有人 ①修根因（改 `reports.ts`/补只读路由）并 `--update-baseline` 清出，或 ②经 PM 拍板把 `baseline.json` 里这两条 `meta.deadline` 显式改后（可见 diff）。这是**有意的强制函数**（fail-closed），非 bug——把「真人被喂 404」的债顶到有人处置为止。

**C · C4 路由注册表（`check-route-nav.cjs`）**：与白名单(A)/baseline(B) 同款 fail-closed，但**无 baseline 棘轮**——迁移时已把全部路由声明干净、零存量债，故任一违规（未声明新页 / active 缺 navGroup / 越封闭枚举 / headless 缺死线或过期或超上限 / headless 超条数 / 悬空声明 / deprecated 缺理由）即**无条件红**（不受 `--block`/`--only`/baseline 影响）。`headless` 死线同 C2 白名单口径（`due` 缺=红·YYYY-MM-DD·未过期·≤ `today+MAX_DEADLINE_HORIZON_DAYS`）、条数 ≤ `MAX_HEADLESS_ROUTES=12`。地面真相 = `App.tsx` 的 `<Route path>` 清单（运行时路由器的静态镜像），声明源 = `route-registry.ts`，两侧双向对账（`undeclared` + `dangling` 双查，防「迁移弄丢从两边同时消失」）。fixture 注入用 `BD_APP_TSX_PATH` / `BD_ROUTE_REGISTRY_PATH`（仅 selftest）。

## 文件

- `lib/registry.cjs` — 共享解析层（app 挂载 / router 端点 / 前端调用[request/axios/fetch/fetch-var 回溯] / 路径归一 / 匹配）。
- `lib/constants.cjs` — fail-closed 治理常量单一事实源（`MAX_DEADLINE_HORIZON_DAYS=120` / `MAX_WHITELIST_ENTRIES=12` / `MAX_HEADLESS_ROUTES=12`），多模块共用防漂移。
- `lib/baseline-governance.cjs` — baseline fail-closed 治理（meta 死线 / 净条数天花板[含缺天花板=红] / 被依赖者禁入死物名单）·纯函数可测。
- `check-frontend-to-backend.cjs`（C1）/ `check-backend-consumers.cjs`（C2·含白名单 fail-closed `validateWhitelist`）/ `check-config-engine.cjs`（C3）/ `check-route-nav.cjs`（C4·路由↔导航注册表结构 fail-closed `validateRouteNav`）/ `check-authz-combinators.cjs`（C5·授权组合子·独立轴·零容忍无 baseline，扫 `routes/*.ts` 先 `blankComments` 剥注释再匹配）。
- `run-all.cjs` — 统一入口（`--only` / `--block` / `--json` / `--update-baseline`）+ fail-closed 治理层汇总（无条件红·不受 `--only` 豁免；含 C4 路由结构违规 + C5 授权违规）。fixture 注入用 `BD_BASELINE_PATH` / `BD_WHITELIST_PATH` / `BD_APP_TSX_PATH` / `BD_ROUTE_REGISTRY_PATH` / `BD_AUTHZ_ROUTES_DIR` 环境变量（仅 selftest）。
- `selftest.cjs` — 工具不变量自测（含 C1–C5 fail-closed 变异断言 + 解析器边界断言 + run-all.cjs exit-code 端到端「最后一公里」覆盖，证有牙、防解析器/闸静默漂）。
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
