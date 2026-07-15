# COREONE — Claude Code 入口

Claude Code 会话开始任何工作前必须完整读取唯一共用契约：

- [共用 Agent Operating Contract](docs/agent-operating-contract.md)

随后按契约中的权威链读取与本任务相关的工作模型、golden、guardrails 与领域索引。这里仅保留 Claude Code 适配信息，不复制共用规则。

## 本地自动路由

- 项目级 Skill `.claude/skills/coreone/SKILL.md` 是 Claude Code 的本地工作路由。遇到 PRD、功能、Bug、Issue/PR、代码、测试、复核或跨设备接手时自动调用；不要等用户重复粘贴 GitHub 规则。
- 第一次修改前必须先输出 Skill 定义的 `LOCAL TASK CONTRACT`。缺 PRD/Issue、owner、阶段闸点、owned/excluded files 或 preflight 时，停在补合同阶段，不直接写码。
- 新想法 / 未定需求 → `/coreone-prd`；已定稿 PRD / “按 PRD 继续” → `/coreone-deliver-prd`；`/feature-development` 只是兼容入口，必须回到同一 Skill，不能另走旧脚手架。
- PRD 驱动任务以 `PRD path@merged SHA + AC IDs + 工程 Issue` 为最小下游输入；当前实施矩阵写回 Issue/PR，不只留在 Claude 对话中。
- 跨设备工作只承认已进入 GitHub/Git 的状态。另一台设备先拉取含本入口与 Skill 的提交，再从仓库根目录或其子目录启动 Claude Code；未推送分支、个人 memory、聊天历史和本地 session-log 不构成交接。

## Claude Code 适配

- 先用 `node scripts/agent-preflight.cjs` 选择 `develop` 或 `review` 模式；新开发先由操作者执行 `git fetch origin`。
- 只调用当前会话实际列出的内建能力、插件或技能；历史日志中的能力名称不构成可用性证明。
- 子任务只有在文件所有权互斥且 handoff 自包含时才能并行；同一文件仍只有一个实现 owner。
- 面向 PM 的交付结尾附一段大白话：做了什么、结果是什么、对业务或用户意味着什么。
- 做需求 / 前端 mockup / 写码 / 真跑验收 / 报告结论类任务时，按质量 Loop 家族唯一入口 `docs/COREONE-质量Loop总览-2026-07-12.md` 选对应循环并贴对应会话注入块（规则细则以工作模型与共用契约为准，本入口不复制）。
- 使用 Fable 5 模型处理 PRD 时，统一视为当前 Claude Code 会话的 PRD 阶段，并读取 `docs/Fable5-PRD-GitHub协作范式.md`。PM 定稿只结束 PRD 内容闸；还须有合并后的 PRD、PM 确认的工程 Issue 和新一轮 ownership / preflight，才可切换到 mockup 或写码阶段。
