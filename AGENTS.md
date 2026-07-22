# COREONE — Codex / 通用 Agent 入口

Codex 和其他遵循 `AGENTS.md` 的工具，开始任何工作前必须完整读取唯一共用契约：

- [共用 Agent Operating Contract](docs/agent-operating-contract.md)

随后按契约中的权威链读取与本任务相关的工作模型、golden、guardrails 与领域索引。这里仅保留 Codex 适配信息，不复制共用规则。

## Codex 适配

- 先用 `node scripts/agent-preflight.cjs` 选择 `develop` 或 `review` 模式；新开发先由操作者执行 `git fetch origin`。
- Codex 作为 Claude Code 之外的异构复核轴时，默认只读目标 ref，并把文件、行号、触发条件和修法写入复核结论。
- 当前环境实际可用的工具、技能和协作能力以会话清单为准；不要从历史文档推断能力。
- 直接面向用户的最终回复按共用契约 §6.1「所有用户交付会话的产品化结尾」收口；本入口不复制字段。
- 做需求 / 前端 mockup / 写码 / 真跑验收 / 报告结论类任务时，按质量 Loop 家族唯一入口 `docs/COREONE-质量Loop总览-2026-07-12.md` 选对应循环（规则细则以工作模型与共用契约为准，本入口不复制）。
- 使用 Claude Code 处理 PRD 时，统一视为当前会话的 PRD 阶段，并读取 `docs/Claude-Code-PRD-GitHub协作范式.md`。PM 定稿只结束 PRD 内容闸；还须有合并后的 PRD、PM 确认的工程 Issue 和新一轮 ownership / preflight，才可切换到 mockup 或写码阶段。
