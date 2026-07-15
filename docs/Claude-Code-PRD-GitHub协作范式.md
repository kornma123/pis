# Claude Code PRD 与 GitHub 协作范式

> **状态**：v0.1 试运行，待 PM 用一个真实 PRD 验证后定稿
>
> **适用范围**：在 Claude Code 中生成或修订 COREONE PRD，并在同一 GitHub 工作链中继续规划、实现和验收
>
> **policy owner**：PM｜**流程维护 owner**：每次修订只设一名 owner｜**独立 reviewer**：未参与同一轮 PRD 改写的第二视角

## 0. 本页只补哪一块

本页是 Claude Code 内部的跨阶段与 GitHub 适配层，不新建第二套工作模型，也不改写现有质量规则。发生冲突时，依次服从：

1. [`docs/agent-operating-contract.md`](agent-operating-contract.md)；
2. [通用 PM–AI 工作模型](工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md)与 [COREONE overlay](工作模型-COREONE项目版-2026-06-30.md)；
3. [`docs/COREONE-质量Loop总览-2026-07-12.md`](COREONE-质量Loop总览-2026-07-12.md) 路由到的 [PRD 质量 Loop](COREONE-PRD质量Loop-2026-07-12.md)；
4. [`docs/github-issue-pr-management-loop.md`](github-issue-pr-management-loop.md) 与 [PR 治理规范](../.claude/rules/pr-governance.md)。

本页只规定三件事：Claude Code 怎样处理 PRD、PRD 在 GitHub 上怎样流转、同一个 Claude Code 怎样从 PRD 阶段切换到实现阶段。流程不绑定具体模型版本。

## 1. 一句话结论

**Claude Code 在 PRD 阶段是草稿作者，不是产品决策者，也不是定稿门。** 它把一个 GitHub PRD Issue 整理成可审的 `DRAFT`。PM 明确说“定稿”只结束 PRD 内容闸；还要完成 PRD 合并、工程 Issue 去重与 PM 确认，并由同一个 Claude Code 重新认领和通过 preflight，才获得实现授权。

| 角色 | 负责 | 不得冒充 |
|---|---|---|
| PM | 目标、优先级、范围、业务口径、PRD 定稿 | 技术实现 owner、GitHub 正式审批或生产 operator |
| Claude Code | 在 PRD 阶段查事实、起草/修订和准备拍板包；下游门禁齐全后按新工程 Issue 进入实现与验证 | PM 决策、自己的独立 reviewer、未经授权扩大范围、自动合并 |
| Codex / 其他 Agent | 独立复核，或在有明确 ownership/handoff 时承接专项实现 | 没有 handoff 时改写同一 owner 文件 |
| 独立 reviewer | 对具体版本给结论、证据、未覆盖边界和下一动作 | 同一轮作者、正式 APPROVE（除非本人确有权限并执行） |

同一个 AI 如果参与了该轮 PRD 改写，就不能再把自己的第二遍阅读称为独立复核。R2/R3 需求优先让未参与改写、且证据轴不同的模型或人员复核。

## 2. Claude Code 的工作界面

| 使用界面 | 适合做什么 | GitHub 边界 | 本项目推荐用法 |
|---|---|---|---|
| Claude Code 本地 | 读取 Git/GitHub 现场、创建 worktree/分支、修改文件、运行检查、开 PR | 以本地凭据与仓库契约为准 | 主工作方式；会话开始读 `CLAUDE.md`，修改前过 preflight |
| Claude Code on the web | 在隔离环境处理仓库并把结果推到新分支/PR | 以该任务授权为准 | 适合异步 PRD/文档任务；仍须遵守同一 Issue、PR body 和 PM 闸点 |
| Claude Chat / Project 的 GitHub integration（若另行使用） | 只读所选分支文件、辅助讨论 | 不读取 commit history、Issues、PR 或其他实时 metadata | 不是本流程主工作台；动态事实仍交 Claude Code 或 GitHub 页面现场查询 |
| GitHub 网页 | PM 决策、Issue/PR 评论、正式 review 与合并 | 以平台权限和 required gates 为准 | PM 的“定稿/要改/不通过”应留在主 Issue 或 PR 的可链接评论中 |

因此，“Claude 能读仓库”不等于“Claude 已读取当前 Issue、PR、checks 和 SHA”。凡涉及动态状态，都必须现场查询或明确标成“未验证”。

## 3. 数据边界：PUBLIC PRD 与受控证据包分轨

COREONE 是公开仓库，PRD 默认产出 **PUBLIC 脱敏版**。具体数据处理、保留和落点按实际使用的 Claude Code 账户、组织与云环境政策执行。因此：

- 可以输入：公开仓库内容、脱敏业务例子、稳定规则、受控材料的 manifest/hash/等级/结论；
- 不得输入：患者或员工个人信息、原始医院/供应商报表、精确未公开价格/工资/利润、token、密钥、生产库、个人下载目录内容；
- 受控证据包只保留在批准的私有位置；公开 PRD 只引用 source id、脱敏摘要、证据等级和保管人；
- 如果只有敏感原件才能继续，Claude Code 必须停在“待授权/待脱敏”，不能为了补全 PRD 上传原件。

数据边界不清时，默认选择“内部探索 + PUBLIC 脱敏”，不得自行升级成“对外可信”。

## 4. GitHub 上的端到端状态流

```text
一个 [PRD] 主 Issue
  → Claude Code 在 PRD 阶段认领并生成 DRAFT
  → PRD Draft PR（Refs #N）
  → 独立复核 + PM 拍板评论
  → PRD 定稿 PR（Closes #N）
  → 合并后再去重、起草实现 Issues
  → PM 确认候选后创建工程 Issues
  → Claude Code 按新 Issue 切换到实现阶段
  → 真跑验收与 PM 验收
```

| 阶段 | GitHub 主源 | 必须做的动作 | 退出条件 |
|---|---|---|---|
| 1. 需求入队 | 一个 `[PRD]` Issue | 使用 `PRD 输入 / 定稿` Issue Form；PM 只需写六项业务输入与数据安全声明 | 输入足以让 Agent 开始核查，不要求 PM 先准备 SHA、路径或去重结果 |
| 2. 作者认领 | 主 Issue body 的 `coreone-owner` 受控块 + 认领评论 | Issue 初始为 `unassigned`；Agent 现场去重、preflight 后用 `claude-task start --claim=true` 原子更新 owner 主源与认领评论 | 没有重复项、重复 owner 或文件冲突；无 body 写权限时仍为未认领 |
| 3. 草稿 | `docs/prd/` 文件 + PR body | 文件头保持 `DRAFT`；PR 使用 `Refs #N`；不改业务代码 | 草稿、自检、假设和拍板项可供复核 |
| 4. 复核与拍板 | 每个 PR 自己的评论 | reviewer 留可追踪评论；仓库 owner 定稿时使用 `[PM-APPROVAL] decision=approved artifact=<PRD path@实际审阅head>`，要改/未通过不得使用 approved 标记 | PRD Loop 的退出条件满足，且批准内容与最终合并文件 blob 一致 |
| 5. 定稿交付 | 同一 PR | 把 PRD 状态改成 `PM_APPROVED`，补 PM 评论链接；PR 主 Issue 改为 `Closes #N` | checks、复核和 PM 合并批准齐全后由有权角色合并 |
| 6. 实现入队 | 新的/既有工程 Issues | 先去重、起草候选，再由 PM 确认；不同 owner/风险/交付物才拆票 | 每个 Issue 可独立实施和验收 |
| 7. 实现与验收 | 工程 PR + 主 Issue | Claude Code 按新的工程 Issue、既有 PR 模板、handoff 和检查工作 | “已实现/已验证/已评审/PM 验收/合并/发布”分别取证 |

稳定规则：

- 一份 PRD 只服务一个可独立验收的目标；大目标拆 PRD，不在一份文件塞完整路线图。
- PRD 未定稿前，不进入 mockup 或写码；下游发现需求错误，回到 PRD 重拍。
- PM 定稿不等于 PR 已合并；PRD 合并不等于功能已实现；功能合并不等于已发布。
- PM 定稿本身不授权写码；实现授权必须同时具备合并后的 PRD 基线、PM 确认的工程 Issue，以及新一轮 ownership / preflight。
- 草稿阶段用 `Refs #N`，只有 PRD 的验收已完整满足时才改成 `Closes #N`。
- Claude Code 在 PRD 阶段只能起草实现 Issue 候选；未得到 PM 确认，不批量创建正式 Issue。

## 5. Claude Code PRD 输入合同

每次启动 PRD 阶段时，给 Claude Code 的输入包至少包含：

```text
主 Issue：#N / URL
用途：内部探索（默认）/ 对外可信
目标、优先级、必须有、不做、不可接受、验收：来自 PM
现场基线：master@<SHA> + 核对日期
权威入口：本需求相关的索引 / ADR / spec / golden / 活代码
现状证据：文件、行号、运行结果或 GitHub 链接
风险命中：金额/口径/golden/RBAC/PII/生产，或“未命中”
数据声明：PUBLIC/已脱敏；受控证据只给 manifest
建议产物：docs/prd/PRD-<id>-<slug>.md
本轮权限：只做 PRD；不做 mockup、不写业务代码、不创建工程 Issue、不合并
```

如果使用只同步文件的 Claude GitHub integration，另附主 Issue 和 PR 的人工快照，并标注抓取时间；它们只是输入快照，不是实时状态源。

## 6. PRD 输出合同

使用 [`docs/templates/COREONE-PRD-template.md`](templates/COREONE-PRD-template.md)。Claude Code 的输出必须先带以下身份块，再按 PRD 质量 Loop 填正文：

```text
状态：DRAFT（未经 PM 定稿）
用途：内部探索 / 对外可信
主 Issue：#N
作者 / 模型 / 使用界面：...
基线：master@<SHA>，核对日期 ...
权威来源：...
数据边界：PUBLIC / 已脱敏 / 仅引用受控 manifest
未确认方向级假设：...
PM 定稿证据：无（DRAFT）
```

Claude Code 在 PRD 阶段交付时同时提供：

1. PRD 文件或可直接落文件的完整草稿；
2. 本轮改动与事实来源；
3. 方向级/细节级假设和未验证项；
4. 给 PM 的二/三选一拍板包；
5. 一段可直接贴到 GitHub 的交接评论。

## 7. GitHub 交流写在哪里

| 信息 | 写入位置 | 不要写在哪里 |
|---|---|---|
| 业务目标、剩余工作、owner、验收 | 主 Issue | 聊天记录或长期状态文档 |
| 本次交付的动态 handoff | PR body | 多人共同追加的 session log |
| 某次决定、复核或阻塞事件 | 对应 Issue/PR 评论 | 只留在 Claude Code 对话里 |
| 可复现的行级问题 | PR inline comment；另有总结评论 | 只有一个孤立截图 |
| 稳定产品结论 | 已合并 PRD / ADR / golden / PM 决策索引 | 另建第二份实时 backlog |
| checks、SHA、mergeability | GitHub/Git 现场 | 长期规则正文 |

每条评论只承担一个目的，并包含：**状态/结论、证据、风险或未验证项、需要谁做什么、触发条件**。引用文件时尽量使用固定 commit 的链接或 `file:line`；不能只写“我检查过了”。

### 7.1 Claude Code PRD 阶段交接评论

```md
## [PRD-DRAFT] Claude Code 阶段交接
- **主 Issue**: #N
- **产物**: `docs/prd/PRD-...md` @ `<commit>`
- **作者 / 模型 / 界面**: ...
- **基线**: `master@<SHA>`（核对日期：YYYY-MM-DD）
- **用途 / 数据边界**: 内部探索；PUBLIC 已脱敏

### 本轮结果
当前状态 → 目标状态；本轮实际补齐了什么。

### 证据与未验证项
- 权威来源：...
- 未验证：...

### 假设
- 方向级（未拍板，不得进入下游）：...
- 细节级（带标记前进）：...

### 需要 PM 决定
- A｜收益 / 代价 / 风险
- B｜收益 / 代价 / 风险（推荐，原因：...）

### 下一步
下一 owner：...；触发条件：...；当前仍为 DRAFT。
```

### 7.2 PM 拍板评论

```md
## [PM-DECISION] PRD 闸点
- **对象**: `docs/prd/PRD-...md` @ `<commit>`
- **结论**: 定稿 / 要改 / 新讨论
- **选择**: A / B / C（如适用）
- **范围与条件**: ...
- **不可接受结果**: ...
- **重审触发**: ...
- **允许结束 PRD 内容闸**: 是 / 否（不等于实现授权）
```

只有仓库 owner 发布的结构化 `[PM-APPROVAL]` 普通评论可以填入 `PM 定稿证据`；沉默、表情、AI 转述或含“未通过/不批准”的自然语言不算。

### 7.3 Claude Code 实现阶段认领评论

```md
## [IMPLEMENTATION-CLAIM] 实现认领
- **工程 Issue**: #N
- **需求基线**: `docs/prd/PRD-...md` @ `<merged-commit>`
- **owner / 模型**: ...
- **base**: `origin/master@<SHA>`
- **owned files**: ...
- **excluded files**: ...
- **验收**: ...
- **下一汇报点**: ...
```

没有合并后的 PRD 基线、PM 确认的工程 Issue、明确 ownership 和通过的 develop preflight 时，Claude Code 不得把 PM 定稿或 DRAFT 当成写码授权。R0 琐碎可逆修改不建 Issue，但仍用本地 `start-r0` / `finish-r0` 约束 owned files 与目标检查，不能借 R0 绕过正式功能流程。

### 7.4 通用状态与 PR 复核评论

实现进度、阻塞和 PR 复核不使用模型专属模板；统一使用 [`docs/github-issue-pr-management-loop.md` §9](github-issue-pr-management-loop.md#9-agent-与-github-的评论合同) 的稳定合同。这样 Claude Code 换模型后仍使用同一套字段，也不会让本页这个试运行适配层变成全局规则源。

## 8. 失败与偏差处理

- 读不到实时 Issue/PR：标“动态状态未验证”，换 Claude Code/`gh`/GitHub 页面查询，不猜。
- 输入缺方向级决定：停在 DRAFT，给互斥选项，不自行定产品方向。
- 发现 PRD 与权威资料冲突：列出双方来源、业务影响和推荐，交有权角色裁决。
- 发现敏感数据：停止上传/引用，改用脱敏摘要或 manifest。
- owner 冲突：不继续改同一文件；由原 owner 释放或正式 handoff。
- PM 定稿后发现新事实：把 PRD 恢复为待修订状态，重走闸点，不在代码中静默改需求。

## 9. 现在怎样在 Claude Code 中使用

1. 从当前任务的独立 worktree 根目录启动 Claude Code；流程不依赖具体模型名。
2. 先创建或指定一个 `PRD 输入 / 定稿` 主 Issue。
3. 从最新 `origin/master` 的独立 worktree 启动 Claude Code。
4. 在项目会话中运行 `/coreone-prd #N`；也可以直接说：

```text
按 docs/Claude-Code-PRD-GitHub协作范式.md，用 Claude Code 处理 #N。
当前阶段是 PRD：只认领 PRD 产物，先核对实时 Issue、master SHA 和权威资料；
按 docs/templates/COREONE-PRD-template.md 产出 DRAFT、拍板包和 GitHub 交接评论。
当前 PRD 阶段只交付 DRAFT 与拍板包：不做 mockup、不写业务代码、不创建工程 Issue、不合并；下游门禁按本页 §4 另行完成。
```

5. 仓库 owner 在主 Issue / PR 留结构化 `[PM-APPROVAL]` 评论后，只结束 PRD 内容闸；按现有门禁完成复核并合并 PRD。
6. 在已拉取最新仓库配置的 Claude Code 中运行 `/coreone-deliver-prd <合并PRD路径> issues`；它先去重并起草工程 Issue 候选，PM 确认后才创建或采用工程 Issue。
7. 针对一个工程 Issue 运行 `/coreone-deliver-prd #N implement`。工程 Issue 必须用工作项表单填写 `PRD 固定基线`、`RQ → AC 映射`与 Mockup 闸点；Claude Code 再重新认领、声明 owned/excluded files 并通过 develop preflight。完成这些条件后才进入实现，不能沿用 PRD 阶段的隐含权限。
8. 实现 PR 合并后运行 `/coreone-deliver-prd #N accept`，逐 AC 真跑并交 PM 验收；实现 PR 默认用 `Refs #N`，Issue 在 PM 明确验收通过后手工关闭。

根目录 `CLAUDE.md` 会把 Claude Code 路由到同一共用契约和本页，不需要另设第二个 Agent。

### PRD 生成后怎样真正被使用

PRD 不是交付终点，也不是每次整篇复制给 Claude 的“大提示词”。它是固定在合并 commit 上的验收合同：

```text
合并 PRD path@SHA
  → 按 Requirement / AC 拆纵向工程 Issue
  → 每个 Issue 只携带自己的 AC、Mockup、风险、依赖和验收
  → AC 追踪矩阵连接代码位置、先失败测试、最终测试和真跑证据
  → PR 交接与独立复核
  → 合并后逐 AC 真跑
  → PM 验收通过后关闭 Issue
```

`.claude/skills/coreone/SKILL.md` 是本地自动路由器，`.claude/commands/coreone-deliver-prd.md` 是显式入口。二者都必须通过 GitHub 合入仓库；另一台设备拉取后，从仓库根目录或子目录启动 Claude Code 才会自动发现。没有进入 GitHub 的本机提示词、memory 或聊天记录不会随设备迁移。

### 另一台设备的一次性启用

合并本范式后，在另一台设备执行：

```text
git switch master
git pull --ff-only origin master
node --version
gh auth status
claude --version
claude
```

本仓库 hooks 要求 Claude Code `>= 2.1.139`（项目 hook 的跨平台 exec-form 参数支持）；低于该版本先升级。首次进入仓库时确认 workspace trust。随后在 Claude Code 内运行 `/status` 与 `/hooks`：应能看到项目级 `.claude/settings.json` 和 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 五类 hook；再运行 `/memory`，确认根目录 `CLAUDE.md` 已加载。若项目 Skill 或 hooks 未出现，先升级 Claude Code，再从仓库根目录重新启动会话。

完成后不需要复制旧设备的聊天或个人配置。直接说“按已合并 PRD 继续”或运行 `/coreone-deliver-prd <PRD路径或#Issue> <issues|implement|accept>`；Claude Code 会以 GitHub Issue、合并 PRD 和当前 Git 状态重新建立任务合同。每次跨设备交接前，上一设备必须先把状态和证据写回 Issue/PR 并清除本地 task state。

### Claude Chat / Project 的 GitHub integration

把它当作“选定分支文件阅读器”。开始前点同步，并人工提供 Issue/PR 快照；产出的 GitHub 评论由人复制，或交给有写权限的 Claude Code 落回 GitHub。

## 10. 试运行验收

这套范式先用一个低风险、可独立验收的 PRD 试跑。满足以下结果后，再由 PM 把本页状态改为正式：

- 一个主 Issue 能完整驱动 Claude Code 生成 DRAFT；
- PRD 中没有隐藏方向级假设或敏感原始数据；
- reviewer 在对应 PR 留下可追踪评论；
- PM 的定稿评论能被 Claude Code 在下一会话准确找到；
- Claude Code 没有在定稿前写码，定稿后能从合并 PRD 拆出不重复的工程任务；
- GitHub Issue、PR body、评论和稳定文档之间没有两套互相漂移的实时状态。

## 外部能力依据

- [Anthropic：Claude Code 项目技能与命令](https://code.claude.com/docs/en/slash-commands)
- [Anthropic：Claude Code 项目配置](https://code.claude.com/docs/en/configuration)
- [Anthropic：Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Anthropic：Claude GitHub integration 的读取边界](https://support.claude.com/en/articles/10167454-use-the-github-integration)
- [Anthropic：Claude Code on the web 的隔离分支与 PR 工作方式](https://support.claude.com/en/articles/12618689-claude-code-on-the-web)

## PM 大白话

你使用的是同一个 Claude Code。它先在 PRD 阶段把想法写成“能审的需求草稿”；GitHub 留下单号、版本、决定和阶段交接。你明确定稿只代表需求内容通过；PRD 合并、工程 Issue 经你确认、Claude Code 重新认领并通过 preflight 后，它才换到实现阶段。不同设备都从同一仓库和 GitHub 现场恢复，不依赖旧设备的聊天或个人配置。
