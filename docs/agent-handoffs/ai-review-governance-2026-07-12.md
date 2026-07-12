# COREONE 单人 AI Review 审批链治理

> 本文件保存本任务的稳定设计、时间戳审计快照与回滚边界。实时 PR、checks、review 和保护状态仍以 GitHub 为准。

## 任务身份

- task id: ai-review-governance-2026-07-12
- owner / author: Codex，分支 codex/ai-review-gate
- reviewer: 独立安全审查轴 + PM
- base: master@eea52d243bd6b347ecf0e230b747f671412033f5
- owned files:
  - .github/workflows/ai-review-gate.yml
  - .github/workflows/ai-review-integrity.yml
  - .github/codex/ai-review-prompt.md
  - .github/codex/ai-review-schema.json
  - .github/codex/ai-review-config.toml
  - scripts/ai-review-gate.cjs
  - scripts/ai-review-gate.selftest.cjs
  - 本文件
- excluded files: #119 的 secret-scan 与扫描脚本；#121/#122 的契约、preflight、build-discipline、工作模型和 PR 模板；全部业务代码。
- ABC / 共享事实链影响: 无业务数据或运行时代码变化；只影响 PR 合并治理。

## 为什么不要求第二个人

当前仓库只有 Mazikorn 一名管理员和协作者。PR 作者不能用自己的 review 满足 required approval，因此启用 1 个真人 approval、CODEOWNERS approval 或 last-push approval 都会锁死 master。

本仓采用：

1. required approving reviews 保持 0；
2. GitHub Actions 以正式 COMMENTED Review 留下 reviewer、submitted_at 和 commit_id；
3. ai-review-gate 状态绑定当前 PR head，并由 branch protection 强制；
4. 新 commit 生成新 SHA，旧 Review 保留审计价值，但旧状态不能放行新 SHA。

PR body、Issue comment 和普通评论不属于 GitHub Review submission，不能被 required approving reviews 计数。COMMENTED Review 是正式 Review 事件，但也不计为 APPROVED；真正的阻断来自 required ai-review-gate。

## 时间戳 before 快照

审计时间：2026-07-12T01:51:13.133Z。

```json
{
  "master_sha": "eea52d243bd6b347ecf0e230b747f671412033f5",
  "collaborators": [{"login": "Mazikorn", "role": "admin"}],
  "codeowners": null,
  "required_status_checks": {
    "strict": false,
    "checks": [
      {"context": "vitest", "app_id": 15368},
      {"context": "gate", "app_id": 15368}
    ]
  },
  "required_pull_request_reviews": null,
  "required_conversation_resolution": false,
  "enforce_admins": false,
  "rulesets": [],
  "actions": {
    "default_workflow_permissions": "read",
    "can_approve_pull_request_reviews": false,
    "repository_secret_names": ["OPENAI_API_KEY"]
  },
  "master_checks": {
    "vitest": "success",
    "gate": "success",
    "e2e": "success",
    "secret-scan": "success"
  }
}
```

Secret API 只能证明名称存在，不能读取值或证明额度、模型权限和调用有效；首次测试 PR 才是有效性探针。

### PR / Review 实时复核

刷新时间：2026-07-12T02:58:26.935Z；master 仍为 `eea52d243bd6b347ecf0e230b747f671412033f5`，保护状态与上方 before JSON 相同，`ai-review` Environment 仍不存在，`OPENAI_API_KEY` 仍是 repository secret。

- 按 `merged_at` 倒序的最近 12 个合并 PR：#121、#122、#119、#123、#120、#118、#117、#112、#114、#116、#115、#113。
- 其中 11 个没有任何 Review submission；#119 有 2 个由 Mazikorn 提交、分别绑定不同 commit_id 的正式 `COMMENTED` Review。12 个 PR 合计 `APPROVED=0`、`CHANGES_REQUESTED=0`。
- 12 个 PR 当前 review request 均为 0，Issue timeline 也没有 `review_requested` / `review_request_removed` 事件；review threads 均为 0。
- #122 标题自述“Codex 七轮复核”，但 GitHub Reviews API 为 0；这类 PR body、标题或 Issue comment 证据不能被 branch protection 当作 approval 或正式 Review submission。
- 合并 head 的 checks：#121/#119 为 vitest、gate、e2e、secret-scan 成功；#123 为 vitest、gate 成功；#120/#118/#117/#112/#114/#116/#115/#113 为 vitest、gate、e2e 成功；#122 的 head 没有可查询到的 check run/status，因此无法仅凭 head 证明 required checks 曾运行。在当前 admin bypass 可用的状态下，PR 时间线自述不能替代机器门证据。
- 当前唯一开放 PR 是 #124：review submissions=0、review requests=0、review threads=0、Issue comments=0；其 head `c8040c3f4c5e7fd1b42ea7612bf3135b9d56d963` 上 vitest、gate、e2e、secret-scan 均成功。它属于并行工作，本任务不修改、不关闭、不重开、不合并。

## 受信执行链

```text
master 版本 pull_request_target workflow
  -> pending 状态写到事件 head
  -> 无 Secret job: checkout base，只把 PR ref 变成有上限的纯文本 patch
  -> Secret job: 不 checkout 仓库，只读 patch，Codex 最后一步
  -> 新 runner: 严格校验 JSON，提交 COMMENTED Review
  -> 再核 live head 与本 run 的 pending 所有权
  -> success / failure / error 写到同一 head 的 ai-review-gate
```

安全不变量：

- 不在持有 OPENAI_API_KEY 的 job 中 checkout 或执行 PR 代码。
- 模型 job 只引用 master-only 的 ai-review Environment；最终启用前必须把 Key 迁入该 Environment 并删除 repository secret。
- 不把 PR title、body、commit message 或截图传给模型；不会加载或遵循 PR 版 AGENTS。若 AGENTS.md 本身被修改，其 diff 仍作为不可信 patch 接受审查。
- 自定义 Codex 权限配置拒绝一般 runner 文件读取、临时目录与网络；只允许 review-input workspace 和启动只读文本工具所需的最小运行时路径。
- 模型 job 无 pull-request/status 写权限；发布 job 无模型 Key。
- 所有第三方 Action、Codex Action 和 Codex CLI 都固定版本。
- 模型原始文本不直接进入 shell 或 Review；只接受受限 JSON Schema，由确定性脚本转义、限长并硬编码 event=COMMENT。
- 无 Key、无额度、超时、空输出、非法 JSON、Review 发布失败或超大 diff 全部 fail-closed。
- binary、submodule/gitlink、Git LFS pointer 和 patch digest 不一致全部 fail-closed，不能在模型看不到真实内容时判 PASS。
- workflow 无 paths/paths-ignore；纯文档 PR 也必须回报。
- ai-review-integrity 覆盖 base retarget 的 edited 事件，并用 actionlint v1.7.12 + 固定发布包 SHA256 实际解析两份 workflow，避免正则自测假绿。
- PR base 重定向会触发重新审查；只改标题或正文不会重复消耗模型额度。

## current -> target

| 项目 | before | target |
|---|---|---|
| 独立 AI 证据 | PR body / 评论中的自述 | 正式 COMMENTED Review，绑定 commit_id |
| 强制方式 | 无 | 当前 head 的 ai-review-gate required status |
| required approvals | 未启用 | 0；不要求第二个人 |
| stale 处理 | 无 | 新 SHA 必须重新产生状态；future-proof stale dismissal=true |
| CODEOWNERS | 无 | 不新增、不要求 |
| required checks | vitest、gate | vitest、gate、secret-scan、ai-review-integrity、ai-review-gate |
| up-to-date | strict=false | strict=true |
| review threads | 不要求解决 | required conversation resolution=true |
| admin | 可直接 bypass | 单人阶段维持 enforce_admins=false，保留受控应急出口；只允许 GitHub/CI 故障时使用，并在 PR 时间线记录原因、影响、恢复时间与补跑证据 |

计划中的最终保护 payload：

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [],
    "checks": [
      {"context": "vitest", "app_id": 15368},
      {"context": "gate", "app_id": 15368},
      {"context": "secret-scan", "app_id": 15368},
      {"context": "ai-review-integrity", "app_id": 15368},
      {"context": "ai-review-gate", "app_id": 15368}
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "required_conversation_resolution": true,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
```

在 ai-review-gate 首次对测试 PR 的 head 成功回报前，不得把它加入 required contexts。

## 分阶段实施

1. 在 GitHub 建立仅允许 master 的 ai-review Environment，把 OPENAI_API_KEY 重新录入为 Environment secret，并删除同名 repository secret。
2. 合入独立 workflow PR；其无 Secret 的 ai-review-integrity 会在本 PR 先验证 parser/schema/workflow 语法。Bootstrap 例外：新增的 pull_request_target workflow 在进入 master 前不会成为信任根，因此本治理 PR 只依赖 integrity、现有 required checks 与本次独立审计证据；正式 ai-review-gate 从合入后的测试 PR 开始。
3. secret-scan 虽已稳定回报，但当前 `pull_request` 会运行 PR 自己版本的 workflow/scanner；同一 PR 理论上可同时削弱扫描器并报绿。该文件属于 #119，本任务不抢改。应由 #119 owner 先建立不可由候选 PR 自改的信任根，或由 PM 明确接受“单人防误操作、非对抗隔离”的残余后，才把 secret-scan 加入 required；仅有历史绿灯还不够。
4. 新建测试 PR，验证纯文档也得到 pending -> terminal 状态和正式 COMMENTED Review；现场确认 explicit status 的 creator/app_id 和 merge box 实际采用的 SHA，并验证 base 重定向会重审、title/body 编辑不会重复调用模型。
5. 制造阻断 finding，验证 failure 真能挡住；修复并推新 commit，验证旧结果不能放行新 head。
6. 加 required 前重新枚举全部开放 PR。新 workflow 不会自动给存量 PR 补历史 context；当前 #124 若仍开放，应等待其合并/关闭，或另获 PM 明确批准后 close/reopen 触发两条 workflow。不得通过改 title/body 伪装触发 gate，也不得擅自操作并行任务 PR。逐个确认 `ai-review-integrity` 与 `ai-review-gate` 都已 terminal，且 creator/app_id 正确。
7. 只有测试 PR和全部存量开放 PR 都已具备两条 terminal context 后，才把 ai-review-integrity 与 ai-review-gate 加入 required，再启用 strict、0-review PR 门和 conversation resolution；单人阶段继续保留 admin bypass 作为受控应急出口。
8. 验证 unresolved thread、落后 master、失败 checks 都不能合并，解决后可以合并；再验证新出现的纯文档 PR 不会停在 Expected。
9. 保存 after JSON、时间戳和测试 PR 链接。只有未来增加第二位可恢复 master 的维护者，或单人应急恢复演练成熟后，才另行审批 enforce_admins=true。

### 单人 admin bypass 纪律

- 只限 GitHub Actions/API 故障、required provider 持续不可用或必须立即止血的安全事件；不得用于跳过正常复核。
- 仍通过 PR 合并，不直接 push master、不 force-push。合并前在 PR 留下：触发原因、失败 run URL、风险判断和计划恢复时间。
- 合并后立即在 master 补跑可用 checks，并把结果、异常影响与修复链接追加到同一 PR；若改过任何保护设置，另存 before/after JSON 与 UTC 时间戳。
- 普通模型 FAIL、测试 FAIL 或未解决 thread 不属于 bypass 条件，必须修复后再合并。

## 回滚

严格按顺序：

1. 若未来曾启用 enforce_admins 且 master 被锁，先把 enforce_admins 改回 false；当前单人阶段本来就保持 false。
2. 从 required contexts 移除 ai-review-gate 与 ai-review-integrity；必要时再移除 secret-scan。
3. 复核 vitest、gate 仍在 required，并保存回滚后的 JSON。
4. 最后才禁用 workflow、删除/迁移 Secret 或 revert workflow PR。

先删任一 AI workflow 或 Secret、后移除对应 required context 会让 PR 永久停在 Expected，禁止这样回滚。

## 已知边界与下一阶段

- 当前 status 由 GitHub Actions App 产生。同仓有 write 权限的人仍可故意新增另一条 workflow 写同名 status；只有独立 GitHub App 的独立 app_id 能彻底消除伪造面。单人仓当前把它当作防误操作和强制留痕，不宣称是对仓库 owner 的密码学隔离。
- #119 的 secret-scan 当前由候选 PR 版本运行，尚不是独立信任根。最终 target 保留该 required context，但实际启用依赖 #119 owner 的加固或 PM 对单人非对抗风险的单独批准。
- ai-review-integrity 自身若被改成 GitHub 无法解析的 YAML，GitHub 调度器不会启动其内部 actionlint，required context 会按 fail-closed 停在 Expected。当前分工不修改 #121 的既有 gate 来做第二层外部 lint；此平台边界依赖回滚顺序中的临时 admin bypass 恢复。
- 当前 OPENAI_API_KEY 是 repository secret，workflow 已声明 ai-review Environment，但安全迁移尚未完成。Key 值不可读取或复制，所以合入和探针前需要 PM 在 GitHub 页面重新录入 Environment secret，并删除 repository secret。
- 当前阶段不支持外部 fork 或机器人自动通过。将来开放外部贡献时，应增加受控重触发机制或改用专用 GitHub App。
- Secret job 只允许同仓且 author_association=OWNER 的 PR；外部 fork 仍会得到正式的 terminal error，不会进入 Environment 或消耗模型额度。
- 模型只看 patch，不运行项目测试；vitest、gate、secret-scan 各自提供确定性证据，AI Review 不能替代它们。

## PM 大白话

这套方案不找第二个人签字，也不让机器人冒充真人 APPROVED。它把每次 AI 复核变成 GitHub 里真正的 Review 记录，再用一个只认当前提交的红绿灯拦合并。换了代码就必须重新审；模型或接口坏了就红，不会偷偷放行。
