---
description: COREONE 功能开发兼容入口。新功能必须先路由到已定稿 PRD 的交付链；已有工程 Issue 或 Bug 则按当前阶段进入写码。不能绕过 GitHub ownership、preflight、Mockup 和验收映射。
argument-hint: "<PRD 路径/URL、#工程Issue 或 Bug 描述>"
---

# /feature-development

这是兼容入口，不再维护一套独立的固定技术步骤。

处理 `$ARGUMENTS` 时：

1. 先执行 `.claude/skills/coreone/SKILL.md` 的启动路由并输出 `LOCAL TASK CONTRACT`。
2. 若输入是新功能、PRD 或“按需求继续”，转入 `/coreone-deliver-prd $ARGUMENTS`。
3. 若输入是 Bug，要求已有工程 Issue、可复现路径、owner 和 develop preflight，再按写码质量 Loop 修复。
4. DB / E2E 只在父任务合同成立后调用 `/db-migration` 或 `/e2e-testing`；专项命令不能替代主 Issue、PRD/验收或 handoff。
5. 技术模式以活代码、相关 ADR/spec 和 `.claude/rules/coreone-guardrails.md` 为准；不得沿用本命令历史版本中的 React Query、Zod、`requireRole`、`express-validator`、直接推 master 或删除现有数据库等固定假设。

没有合并后的 PRD（新功能）或可复现 Bug + 工程 Issue（修复）时，不开始写码。
