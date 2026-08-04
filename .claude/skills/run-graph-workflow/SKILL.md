---
name: run-graph-workflow
description: COREONE 项目内的 Graph Engineering 工作流入口。处理多阶段、跨设备、跨 Agent、多模块、高风险或需要独立验证的任务时使用；小而明确的低风险任务由 canonical Skill 判定为快速路径。
---

<!-- project-skill-adapter/v1 -->

# Claude Code 项目适配入口

本文件只负责 Claude Code 的项目级发现，不保存工作流规则。

开始任务前，必须完整读取并执行 `${CLAUDE_PROJECT_DIR}/.agents/skills/run-graph-workflow/SKILL.md`；其中引用的 reference 一律从同一 canonical Skill 目录解析。

若 canonical 文件不可读，立即停止并报告项目 Skill 安装损坏；不得用本适配文件、个人 Skill 或记忆补写另一套规则。

项目 `AGENTS.md`、`CLAUDE.md` 和 `docs/agent-operating-contract.md` 始终保持更高优先级。
