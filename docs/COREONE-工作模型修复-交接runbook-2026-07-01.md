# 工作模型评估修复 — 交接 Runbook（2026-07-01）

> **背景**：对工作模型跑了两轮评估（45-agent 调研 + 28-agent 对抗验证），发现"防漂移机制自己在漂移"。
> 本会话已把**本地安全可逆**的修复落 git（下 §A）；**网络/GitHub/协调-gated** 的部分因本环境
> `git push`/`fetch` 被 SSL 挡（`gh` API 可用、`git push` 不可用）+ 属高风险生产操作，装进本 runbook 交你在能联网环境执行。
> 权威依据：`docs/COREONE-工作模型调研-优化点与模式合理性-2026-07-01.md` §〇（v2 修正块）。

---

## A. 本会话已完成（codex/abc 线本地提交，未 push）

| commit | 内容 |
|---|---|
| `10c9f231` | 抢救 3 个 T1 手核复现脚本入 `docs/analysis/handcheck/`（原困在会话 tmp scratchpad，重启即丢） |
| `e2969efa` | 调研报告 v2 复核修正块 + 落盘（此前 untracked） |
| `891717d8` | 订正 CLAUDE.md/规则文件模板遗留失真 + 项目版 v1.1 补专项决策 |

> ⚠️ 这 3 个 commit 在 codex/abc 线，**尚未 push**（本机 `git push` 被 SSL 挡）。请在能联网环境 `git push origin codex/abc-productization-phase0-1-2026-06-15`。
> ⚠️ `.claude/rules/skills-auto-trigger.md` 已同步订正但**被 .gitignore 排除**——改动只在本地 worktree 生效，不随 push 传播。若要让其它 worktree 也拿到，需 `git add -f` 或从 .gitignore 移除（这是项目既有决定，未擅自更改）。

---

## B. 待执行（按顺序，含逐命令）

### B0. 前置：先立真 CI 门禁（最急，其余合流依赖它）

**问题**：全项目 `.github/workflows/` 只有 e2e、**无 vitest**；master **连分支保护都没开**（`gh api repos/:owner/:repo/branches/master/protection` 返回 404 未保护）。golden-registry 的 ✅ 实为"本地人肉跑绿"。合流"一模块一 PR 守零回归"目前**没有任何 GitHub 机制**会在破坏 ¥13,152/¥27,870 的 PR 上变红。

**动作**：把下面的 workflow 加到 **PR #17 的分支**（`feat/phase2-lab-revenue-split`）——因为黄金 vitest 测试只在 phase2 线上，master 上加了没测试可跑。`pull_request` 触发用 PR 的 merge ref，所以直接加到 #17 分支即当场生效。

```bash
# 在能联网的机器上
git fetch origin
git switch feat/phase2-lab-revenue-split   # 或 git worktree add
# 写入下面的文件后：
git add .github/workflows/backend-tests.yml
git commit -m "ci(backend): vitest 黄金测试门禁(pull_request+push master),守 ¥27,870/¥13,152"
git push origin feat/phase2-lab-revenue-split
```

**`.github/workflows/backend-tests.yml` 完整内容**（Node 22 + `node:sqlite` 需 `--experimental-sqlite`，故用 `test:node`）：

```yaml
name: Backend Tests (golden)

on:
  push:
    branches: [master, main]
  pull_request:
    branches: [master, main, feat/phase2-lab-revenue-split]

concurrency:
  group: backend-tests-${{ github.ref }}
  cancel-in-progress: true

jobs:
  vitest:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: 后端代码/server
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install
        run: npm ci
      - name: Run backend vitest (含 golden ¥27,870 / ¥13,152)
        run: npm run test:node
```

> 校验：CI 应跑到 `tests/golden/hemujia-purelab-golden.test.ts`（¥27,870）与 `tests/golden/partner-revenue-golden.test.ts`（¥13,152）。若 `npm ci` 因无 lockfile 失败，改 `npm install`。
> 注：改 base 后 workflow 不会自动触发（pr-governance 已沉淀的坑）——推空提交触发：`git commit --allow-empty -m "ci: trigger" && git push`。

### B1. 设 required check（否则 CI 只是"可见红叉"不挡合并）

```bash
# 待 B0 的 CI 至少绿一次、拿到 check 名后：
gh api -X PUT repos/Mazikorn/Coreone-Procurement-Sales-and-Inventory-PSI-Management-System/branches/master/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=vitest' \
  -F 'enforce_admins=false' \
  -F 'required_pull_request_reviews=' -F 'restrictions='
```

> 嫌重可降级：只保留 B0 的红叉 + 把 golden-registry CI 列从 ✅ 改成 ⬜（诚实标"未进 CI"）直到 required check 落地。**不要**在没有对应 check 时就设 required——会 block 所有合并。

### B2. 按看板合 #17 → 重定向 #18（⚠️ 需你确认，pr-governance §5）

> 生产 PR 合并是高风险外向操作，且 pr-governance §5 要求人工核"是否当前最上游可合项"。本会话不擅自代合。

```bash
# §5 复核：确认 #17 是 merge-order/1、ready-to-merge、B0 的 CI 绿
gh pr checks 17
gh pr merge 17 --merge          # 栈式用 merge commit(pr-gov 经验:下游免 rebase)
gh pr edit 18 --base master     # 上游合并后 #18 base 悬空→重定向 master(铁律6)
# 触发 #18 的 e2e(改 base 不自动触发):
git fetch origin && git switch feat/phase2-pnl-diagnosis
git commit --allow-empty -m "ci: retrigger after base redirect" && git push origin feat/phase2-pnl-diagnosis
```
合后更新 pr-governance 看板 + session-log 留指针。

### B3. master 收口迁移（方法论权威归一）

> #17 合并后，v1.1（UU-4/机制8/golden-registry）随之落 master。剩下：

1. **v1.2 通用版落 master**：phase2 树 `docs/工作模型-通用版-….md` 已含机制9（提交 `051f3415`），但**文件头仍写"版本: 1.0"**（应改 1.2）、变更记录 v1.2 排在 v1.1 前（应调正）。以 docs-only 提交直落 master：
   ```bash
   git switch master && git pull
   # 从 phase2 取文件 + 修头版本+变更记录顺序，然后：
   git add "docs/工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md"
   git commit -m "docs(workmodel): 通用版 v1.2 落 master(机制9讨论循环) + 修头版本1.0→1.2"
   git push origin master
   ```
2. **把这些 codex 线文件带上 master**（当前只在 codex/abc 线，master 缺）：`.claude/rules/pr-governance.md`、`docs/工作模型-COREONE项目版-…md`(v1.1)、`docs/COREONE-工作模型调研-…md`、`docs/COREONE-前端标准-…md`、`docs/analysis/handcheck/`、本 runbook。因 codex 线与 master **无共同历史**，用**手工移植**（cherry-pick 会因无共同祖先失败）：逐文件 `git show codex/abc-…:<path> > <path>` 或 checkout。
3. **golden-registry**：随 #17 落 master 后，把 CI 列改成真值（CI 落地前诚实标 ⬜），并登记 T1 新锚（见 B4）。
4. **翻转 CLAUDE.md 指针**：待方法论文档确认在 master 后，把"读权威用 `git show origin/master:docs/工作模型…`"写进 CLAUDE.md（现在写=死指针，故本会话未加，只加了"权威待收口到 master"的提示）。

### B4. golden-registry 登记 T1 新锚（⬜ provisional）

在 master 上的 golden-registry 追加（诚实标 ⬜、provisional，**勿此刻上 CI 断言锁死仍在演进的口径**）：
- 纯实验室收入拆分 **¥27,870**（已是 G-REV-3，确认在）
- 成本/毛利 band：全月成本 ~¥17,546、毛利率 mid ~70%、账实 53:60 —— 标 **provisional·G2 弱锚·算全口径演进中**
- 复现脚本：`docs/analysis/handcheck/`（注：账实 53:60 的专项脚本当时未留存，需补建或标缺）

### B5. session-log 修复（交属主会话——本会话遵"绝不动其 session-log"未改）

`.claude/session-log.md` 当前 469 行（自身规则 ≤100）。请属主会话或你应用：
1. **删 3 条死链**（历史记录索引指向不存在的文件）：`2026-06-08.md`、`2026-06-08-e2e-regression.md`、`2026-06-02.md`（实际只有 `2026-06-08-login-fix.md`——把 06-08 那条改指它，06-02 那条删或就地内联摘要）。
2. **头部规则改务实**：逐日归档（`session-log/YYYY-MM-DD.md`）实践已证维护不动（今日无日档）——建议砍掉逐日归档强制，改成"单一滚动正文只留最近状态+索引"，或接受正文增长只维护索引。别用"补作业更严格"来修（那会加重、正中"session-log 是全项目最重"的诊断）。
3. **留本次指针**：一行——"2026-07-01 工作模型评估修复：见 `docs/COREONE-工作模型修复-交接runbook-2026-07-01.md`；codex 线 3 commit(10c9f231/e2969efa/891717d8)待 push"。

---

## C. 不执行项（说明原因）

- **phase2 通用版头版本 1.0→1.2**：机制9 内容已提交（`051f3415`），只剩头版本矛盾；该文件属 phase2 另一会话 worktree（`feat/phase2-config-split`），按"不碰他会话 worktree 暂存/提交"纪律，随 B3.1 迁移时一并修。
- **CLAUDE.md 加"git show origin/master 读权威"指针**：现在方法论文档不在 master，加了是死指针；待 B3 落 master 后再加（B3.4）。
