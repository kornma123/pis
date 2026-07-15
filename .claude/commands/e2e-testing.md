---
description: COREONE E2E 专项兼容入口。必须从已认领的 PRD AC、工程 Issue 或 Bug 复现路径进入，并把结果回写验收追踪与 GitHub handoff；不能独立冒充功能完成。
argument-hint: "<#工程Issue> <AC ID / 复现路径 / spec>"
---

# /e2e-testing

1. 先执行 `.claude/skills/coreone/SKILL.md` 的启动路由；没有活动任务合同、Issue owner 与 preflight 时不修改测试。
2. 读取工程 Issue 的 PRD/AC 或 Bug 复现路径，明确这条 E2E 要证明什么、什么坏实现必须使它失败。
3. 从当前 Playwright 配置和相邻活测试确定启动、fixture、数据库与命令；不复用历史命令快照，不假设 CI 覆盖全量回归。
4. 先证明测试在目标缺陷/负控下失败，再恢复实现并跑绿；记录命令、版本、结果与未覆盖边界。
5. E2E 可能跑脏 tracked dev DB；按 guardrails 复原并显式检查 `git status`，不得删除、重建或提交真实开发数据库来“让测试通过”。
6. 把结果更新到 AC 追踪矩阵、Issue/PR 验证字段和 handoff。只在任务分支提交，不直接 push master，不自动合并。

测试绿只代表该证据通过；合并后真跑和 PM 验收仍按 `/coreone-deliver-prd #N accept` 执行。
