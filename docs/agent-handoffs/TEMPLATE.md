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

## PM 大白话

- **做了什么**:
- **结果是什么**:
- **对业务或用户意味着什么**:
