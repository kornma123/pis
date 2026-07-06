# COREONE — Agent 指导（codex / 非 Claude-Code 工具入口）

> **用途**：本文件是 `AGENTS.md`-约定的工具（codex CLI 等）读取的项目入口。**Claude Code 会话请以 `CLAUDE.md` 为准**；本文件只做"把外部工具导到正确权威"这一件事，不重复正文。
> **版本**: 2.0（2026-07-06 重写）| **原 1.0（2026-05-22）已废**：见文末「为什么重写」。

## 唯一权威链（有冲突按此顺序）

1. **`CLAUDE.md`**（仓库根）— 项目规则总入口：技术栈、目录结构、编码规范、启动命令、安全基线。
2. **`docs/工作模型-通用版-PM+AI-vibe-coding-2026-06-30.md`** + **`docs/工作模型-COREONE项目版-2026-06-30.md`** — **唯一方法论主线**：讨论循环 + 逼 AI 摊假设 + 真数据产手核答案 → BDD/TDD → mockup 真人 → 独立复核。
3. **`docs/golden-registry.md`** — 黄金锚登记（收入 ¥13,152 / ¥27,870 等），CI 门禁 `required=vitest` 守着。
4. **`.claude/rules/`** — 分域规则：`coreone-guardrails.md`（安全/编码/审计口径）、`pr-governance.md`（PR/看板/合并纪律）、`codex-cli-usage.md`（codex 用法与断流规避）。
5. **成本域**：凡碰「单切片成本 / 院级贡献毛利 / 账实成本」→ 先读 `docs/COREONE-成本域文档-权威索引-2026-07-06.md` 认清当前唯一权威（旧成本文档多已 SUPERSEDED）。

## 怎么干活（真实工作模式）

- **代理**：本项目**没有** planner / tdd-guide / code-reviewer / security-reviewer / build-error-resolver / e2e-runner / database-reviewer 这些"专业代理"（`.claude/agents/` 从未建立）。用 Claude Code 内建 `Agent` 工具的子代理类型（`Explore` 只读搜索 / `Plan` 架构规划 / `general-purpose`），或已装技能（`/code-review`、`/security-review`）。**别调用不存在的代理名。**
- **工作区**：**master = 唯一权威线**。新工作从 `origin/master` 开 worktree（`git worktree add <目录> -b <分支> origin/master`）→ 干完开 PR 合回。别在孤儿线（`codex/*`，与 master 无共同历史）上开新活。
- **独立复核（异构轴）**：codex 作为 Claude 之外的第二视角做对抗复核，用法/断流规避见 `.claude/rules/codex-cli-usage.md`。

## 与用户协作

用户是**产品经理、非专业开发**：解释避免术语堆砌（见工作模型「说人话」铁律）；需要决策时给清晰选项和影响；碰钱/关键逻辑的边界不确定就摊开问，别自信填空；**每次产出结尾附一段 PM 看得懂的大白话汇总**。

---

## 为什么重写（2026-07-06）

原 1.0（2026-05-22）通篇是已废内容，机制审查判定为"规则镜像不同步"病灶：① 列了 7 个**从不存在**的专业代理并教"主动使用"（`CLAUDE.md` 2026-07-02 已订正）；② 整套"会话A(Roo)/会话B"双会话协调 + 工作日志机制早被 worktree + PR 模式取代。外部工具（codex）每次运行读本文件 → 旧内容会把它导向不存在的代理和废弃的协作模式，故整篇重写为指向真权威的薄入口。
