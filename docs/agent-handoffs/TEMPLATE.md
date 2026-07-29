# COREONE 任务交接 / Handoff

> 一任务一文件；变化中的实时状态优先写 PR body。不得复制 GitHub 当前状态到长期规则文档。

## 身份与基线

- **task id**:
- **owner / author**:
- **reviewer**:
- **base SHA**:
- **worktree**:
- **branch**:

## 文件所有权

- **owned files**:
- **excluded files**:
- **owner 规则确认**: 一项文件一个实现 owner；另一模型只复核不代写。
- **实现并发确认**: 本 owner 当前没有第二个实现 PR。

## 依赖与影响

- **depends on**:
- **ABC / 共享事实链影响**:
- **动态状态入口**: PR URL 或 `gh` 查询命令；不要复制易漂移状态。

## BDD / 验收

- **给定 / 当 / 那么**:
- **PM 可判断结果**:
- **golden / 真数据 / 守恒**:

## 验证证据

- **自动测试**:
- **人工或真人验证**:
- **preflight / drift check**:
- **git diff --check**:

## 边界与交付

- **未覆盖边界**:
- **迁移方式**:
- **回滚方式**:
- **PR URL**:
- **merge authority**: required checks + 异构复核 + PM 明确批准；实现代理不得自动合并。

## 反盲区自检

- **我现在最没把握的是什么？ / Least confidence**: risk-v1; anchor=name:支付回调; uncertainty=unverified:目标环境重试行为
- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: no-finding-v1; checked=path:scripts/example.cjs; unchecked=ref:Issue#81

> PR / Issue 机器入口只接受共用契约 §6.1 的 `risk-v1` / `no-finding-v1` typed wire grammar，不接受旧 free-form，也不要带 Markdown/HTML 包装。ASCII mode/key/id 是 entity decode + NFKC 后的 canonical 形态；raw 与 canonical contract 都须 `<=4096` UTF-8 bytes，ref 编号按 digit string 比较。canonical grammar 先分段、再逐 token 重检 entity，NFKC 后新出现的 unresolved entity 也 fail-closed；字段分隔符不会与前一 value 的裸 `&` 拼成伪 entity。placeholder 比较会忽略连续句末标点及 `/ _ + - &` 终止填充，并拒绝 canonical `n(?:[./_+-])?a` 等价族；内部的 `C++`、`snake_case`、`R&D+`、`A&B` 与路径保持不变。完整支持的 entity 可解码，裸 `&` 可作可见文本；entity 名边界按 ASCII 名 token 推导，无分号的受支持 entity 名/前缀 fail-closed。checker 只校验 wire shape 与 lexical anchor；名称真实性、检查是否实际执行和回答是否诚实仍须人审。最终直接面向用户的交付结尾继续使用产品大白话。

## PM 大白话

- **做了什么**:
- **结果是什么**:
- **对业务或用户意味着什么**:
