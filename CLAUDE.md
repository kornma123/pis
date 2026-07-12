# COREONE — Claude Code 入口

Claude Code 会话开始任何工作前必须完整读取唯一共用契约：

- [共用 Agent Operating Contract](docs/agent-operating-contract.md)

随后按契约中的权威链读取与本任务相关的工作模型、golden、guardrails 与领域索引。这里仅保留 Claude Code 适配信息，不复制共用规则。

## Claude Code 适配

- 先用 `node scripts/agent-preflight.cjs` 选择 `develop` 或 `review` 模式；新开发先由操作者执行 `git fetch origin`。
- 只调用当前会话实际列出的内建能力、插件或技能；历史日志中的能力名称不构成可用性证明。
- 子任务只有在文件所有权互斥且 handoff 自包含时才能并行；同一文件仍只有一个实现 owner。
- 面向 PM 的交付结尾附一段大白话：做了什么、结果是什么、对业务或用户意味着什么。
