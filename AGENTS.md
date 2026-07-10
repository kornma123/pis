# COREONE — Codex / 通用 Agent 入口

Codex 和其他遵循 `AGENTS.md` 的工具，开始任何工作前必须完整读取唯一共用契约：

- [共用 Agent Operating Contract](docs/agent-operating-contract.md)

随后按契约中的权威链读取与本任务相关的工作模型、golden、guardrails 与领域索引。这里仅保留 Codex 适配信息，不复制共用规则。

## Codex 适配

- 先用 `node scripts/agent-preflight.cjs` 选择 `develop` 或 `review` 模式；新开发先由操作者执行 `git fetch origin`。
- Codex 作为 Claude Code 之外的异构复核轴时，默认只读目标 ref，并把文件、行号、触发条件和修法写入复核结论。
- 当前环境实际可用的工具、技能和协作能力以会话清单为准；不要从历史文档推断能力。
- 面向 PM 的交付结尾附一段大白话：做了什么、结果是什么、对业务或用户意味着什么。
