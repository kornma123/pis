---
description: 用 Claude Code（Fable 5）把一个 GitHub Issue 整理成受控 COREONE PRD 草稿
argument-hint: "[#Issue 或完整 URL]"
---

按 `docs/Fable5-PRD-GitHub协作范式.md` 处理 `$ARGUMENTS`。

当前会话固定为 **PRD 阶段**：

1. 完整读取 `docs/agent-operating-contract.md`、两份工作模型、质量 Loop 总览/契约、PRD 质量 Loop、GitHub Issue/PR 闭环和本需求相关权威资料。
2. 现场核对主 Issue、重复项、开放 PR、`origin/master` SHA 和 ownership；读不到的动态事实标“未验证”，不猜。
3. 按 `docs/github-issue-pr-management-loop.md` 的 `coreone-owner` 受控块认领：先更新 Issue body，再用评论记录认领事件。没有 body 写权限时只输出建议更新内容并保持“未认领”，不得继续占用 owner 身份。
4. 若要修改仓库，先运行 develop preflight，只认领 PRD 文档和本任务明确允许的治理文件。
5. 使用 `docs/templates/COREONE-PRD-template.md` 产出 `DRAFT（未经 PM 定稿）`，包含事实来源、数据边界、假设、验收例、自我质疑和 PM 拍板包。
6. 只使用 PUBLIC / 已脱敏信息；发现 PII、密钥、生产数据、原始医院/供应商报表或未公开精确商业参数时停止，改为请求脱敏摘要或 source manifest。
7. 只起草 PRD 和 GitHub 交接评论；不做 mockup、不写业务代码、不批量创建实现 Issues、不改变正式 review state、不合并。
8. 最后给出可直接贴到主 Issue/PR 的 `[PRD-DRAFT] Claude Code（Fable 5）阶段交接` 评论，以及下一 owner / 触发条件。

没有 PM 的明确、可链接“定稿”证据，当前会话不得结束 PRD 内容闸。即使已经定稿，也必须先合并 PRD、取得 PM 确认的工程 Issue，并重新认领与通过 develop preflight，才可在新会话或新任务中进入实现阶段。

PRD 合并后，在任何已拉取该提交的设备上运行：

```text
/coreone-deliver-prd docs/prd/<PRD文件>.md issues
```

它会先把 PRD 转成去重后的纵向工程 Issue 候选；不会把生成 PRD 的当前会话权限直接延续成写码权限。
