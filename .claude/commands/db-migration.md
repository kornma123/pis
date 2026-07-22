---
description: COREONE 数据库变更专项兼容入口。按 R2/R3、PRD/ADR、工程 Issue、迁移与回滚证据执行；不得通过删除现有数据库或旧脚手架绕过兼容性验证。
argument-hint: "<#工程Issue> <PRD/ADR/迁移目标>"
---

# /db-migration

1. 先执行 `.claude/skills/coreone/SKILL.md` 的启动路由，确认工程 Issue、PRD/ADR、owner、owned/excluded files、R2/R3 风险和 develop preflight。
2. 现场读取数据库实现、schema 初始化、相邻迁移和测试；技术模式以活代码与 guardrails 为准，不假定历史命令仍正确。
3. 先写会失败的迁移/兼容性证据，至少覆盖旧数据升级、重复运行幂等、失败不留半写、回滚/前滚和下游消费者。
4. 在隔离副本或专用测试数据上验证；不得删除或覆盖 tracked dev DB 来代替迁移测试，不得把 DB、WAL/SHM 或敏感数据提交进 Git。
5. 碰钱、跨表派生、权限、PII 或不可逆生产迁移时执行相应 R2/R3 加固；生产动作必须另取授权、备份/止损与 operator 证据。
6. 把迁移、回滚、真数据/golden、未覆盖边界和 AC 追踪写入 Issue/PR handoff。只在任务分支提交，不自动合并或宣称已发布。
