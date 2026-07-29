---
description: 消费已定稿 COREONE PRD：自动判断当前应拆工程 Issues、实现一个 Issue，还是做合并后真跑验收。适用于“PRD 生成后怎么做”“按这个 PRD 继续”“实现/验收 Issue”等任务。
argument-hint: "<PRD 路径/URL 或 #工程Issue> [issues|implement|accept]"
---

按项目 Skill `.claude/skills/coreone/SKILL.md` 的“PRD 到交付主链”处理 `$ARGUMENTS`。不得把“继续”直接解释成写码授权。

先输出 `LOCAL TASK CONTRACT`，再根据 GitHub/Git 现场选择唯一阶段：

1. **PRD 仍是 DRAFT / 未合并**：停在 PRD 阶段，列出缺失闸点；不拆正式工程 Issue、不做 mockup、不写码。
2. **PRD 已定稿并合并，但没有 PM 确认的工程 Issue**：提取 Requirement / AC，判断 Mockup 路由，现场去重，只起草纵向工程 Issue 候选；等 PM 确认后再创建。
3. **已有工程 Issue，但未 READY**：补齐 `PRD path@merged SHA`、AC、范围/非范围、Mockup、风险、依赖、验收和 `coreone-owner`；未满足硬门时不写码。
4. **工程 Issue READY，动作是 `implement` 或现场明确应实现**：只认领一个 Issue，建立独立 worktree，运行 develop preflight，建立 AC 追踪矩阵，按写码 Loop 做 TDD、验证和 PR handoff。
5. **实现已合并，动作是 `accept` 或 Issue 等待验收**：按真跑验收 Loop 逐 AC、逐角色、逐边界运行并留证；PM 明确验收通过后才关闭 Issue。

默认关闭语义：PRD 驱动的实现 PR 使用 `Refs #N`，因为合并后仍需真跑和 PM 验收；只有主 Issue 的全部验收确实已在合并前满足时才使用 `Closes #N`。

跨设备交接只依赖已推送的分支、GitHub Issue/PR、合并 PRD 与固定 commit。不要依赖本机聊天历史、个人 memory 或未推送文件。结束前由当前 GitHub 操作者在活动 Issue 留一条本轮新普通评论，正文包含 `[HANDOFF] status=<状态>` 以及非占位的 `result:`、`evidence:`、`risk:`、`next-owner:`、`trigger:`、`least-confidence:`、`biggest-missing:`，并把该评论 URL 交给 `claude-task.cjs handoff` 校验。后两项只接受共用契约 §6.1 的 strict typed wire grammar：风险用 `risk-v1; anchor=<type>:<value>; uncertainty=<kind>:<detail>`；无发现用 `no-finding-v1; checked=<type>:<value>; unchecked=<type>:<value>`，不保留旧 free-form fallback，也不要加入 Markdown/HTML 包装。ASCII mode/key/id 是 entity decode + NFKC 后的 canonical 形态；raw/canonical contract 均 `<=4096` UTF-8 bytes，ref 编号不转 Number。placeholder 比较忽略连续句末标点及 `/ _ + - &` 终止填充，并拒绝 canonical `n(?:[./_+-])?a` 等价族；内部的 `C++`、`snake_case`、`R&D+`、`A&B` 与路径保持不变。完整支持的 entity 可解码，裸 `&` 可作可见文本；无分号的受支持 entity 名/前缀 fail-closed。checker 只校验 wire shape / lexical anchor，内容真实性和检查是否实际执行仍须人审；最终直接面向用户的收口继续用产品大白话。
