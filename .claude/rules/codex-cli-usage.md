# Codex CLI 使用指南

> **优先级**: P1 — 推荐使用，遵循以下规范

## 可用命令

> ⚠️ **订正（2026-07-01）**：早期本文件列的 `codex adversarial-review` 和 `codex task` **查无实据、从未被用过**（session-log grep 零命中），已删除。以下是本项目**真实在用**的两个命令。

### 1. `codex review` — 代码/PR 审查（真实在用）
```bash
codex review [文件或目录]
```
- 快速质量/安全审查；session-log 多处实证（P0-P6 修复、批一各轮均用它）。

### 2. `codex exec` — 深审 / 任务执行（真实在用，本项目主力）
```bash
codex exec -s read-only -c model_reasoning_effort=xhigh "<审查/分析任务描述>"
codex exec -i <截图.png> "<对着这张图审 UI/口径>"      # 视觉审查
```
- 常用参数：`-s read-only`（只读沙箱，防误改）、`-c model_reasoning_effort=xhigh`（拉高推理强度做深审）、`-i <图>`（喂截图做视觉/口径审）。
- 作为**第二引擎（异构轴）**做独立对抗复核——工作模型机制5 的落地方式。操作铁律（起服务/登录/清僵尸进程）见记忆 `coreone-codex-deep-review`。

## 使用场景

| 场景 | 命令 | 说明 |
|------|------|------|
| PR/提交前审查 | `codex review` | 快速质量/安全检查 |
| 深度对抗复核（碰钱/口径） | `codex exec -s read-only -c model_reasoning_effort=xhigh` | 第二引擎独立审，守黄金锚 |
| UI/口径视觉审 | `codex exec -i <图>` | 对着截图审 |

## 注意事项

1. **Windows 环境**：确保工作路径不含特殊字符（如中文），必要时使用 symlink
2. **超时设置**：复杂任务可能需要较长时间，建议设置合理的超时
3. **结果验证**：Codex 输出需要人工验证，不要盲目采纳
4. **结合使用**：可与 Claude Agent 子代理配合，获得更全面的分析

## 禁用场景

以下情况**不建议**使用 Codex CLI：
- 简单的代码修改（直接使用 Claude Code）
- 实时交互式开发（响应较慢）
- 需要快速迭代的调试场景

---

*生效范围：所有 COREONE 项目会话。*
