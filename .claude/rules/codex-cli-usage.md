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
codex exec -s read-only -c model_reasoning_effort=high "<聚焦的单点审查任务>"   # 默认 high
codex exec -i <截图.png> "<对着这张图审 UI/口径>"      # 视觉审查
```
- **⚠️ 默认推理强度 = `high`（2026-07-03 用户拍板）**：直接用 `xhigh` 调用会**频繁重连/断流**（长 SSE 流保不住）→ 改 `model_reasoning_effort=high`；并**把一次大提问拆成多个请求**（`codex exec` 起头 + `codex resume --last` 续问，分批喂，别一条塞满）。`xhigh` 仅在单文件+短上下文+无并发时偶用。详见下方「长请求断流规避」。
- 常用参数：`-s read-only`（只读沙箱，防误改）、`-c model_reasoning_effort=high`（深审默认）、`-i <图>`（喂截图做视觉/口径审）。
- 作为**第二引擎（异构轴）**做独立对抗复核——工作模型机制5 的落地方式。操作铁律（起服务/登录/清僵尸进程）见记忆 `coreone-codex-deep-review`。

## 使用场景

| 场景 | 命令 | 说明 |
|------|------|------|
| PR/提交前审查 | `codex review` | 快速质量/安全检查 |
| 深度对抗复核（碰钱/口径） | `codex exec -s read-only -c model_reasoning_effort=high`（拆多请求） | 第二引擎独立审，守黄金锚；勿默认 xhigh（断流） |
| UI/口径视觉审 | `codex exec -i <图>` | 对着截图审 |

## 注意事项

1. **Windows 环境**：确保工作路径不含特殊字符（如中文），必要时使用 symlink
2. **超时设置**：复杂任务可能需要较长时间，建议设置合理的超时
3. **结果验证**：Codex 输出需要人工验证，不要盲目采纳
4. **结合使用**：可与 Claude Agent 子代理配合，获得更全面的分析

## 长请求断流规避（实证 2026-07-02）

> **症状**：`codex exec` 跑**长复核**（读多文件 + `xhigh`/`high` 长推理）时，结果在流式传输途中被掐断：
> `ERROR: Reconnecting... 1/5 … 5/5` → `ERROR: stream disconnected before completion: Transport error: network error: error decoding response body`。进程 exit 0、`task_complete`，但**吐不出任何结论**（只 echo 了读过的文件）。

- **不是 codex 坏 / 不是限流 / 不是登录**：最小探针（`-c model_reasoning_effort=low` 回一个词）秒级干净成功；`codex login status` 正常；会话日志 `rate_limit_reached_type: null`。根因是**长时流式连接保不住**——请求跑得久（高推理 + 大上下文），SSE 流被中途截断。**多个 codex `xhigh` 会话并发时显著加剧**（抢同一连接）。
- **规避（按成功探针的姿势，实证有效）**：
  1. **降推理强度**：多会话并发或长复核时用 `-c model_reasoning_effort=medium`（甚至 `low` 做定点核查）**起步，别默认 `xhigh`** → 推理短 → 流短 → 断流前完成。
  2. **缩小请求**：**单文件聚焦**、明确"别读别的文件/别跑命令/直接给结论"，避免 codex 大范围探索把上下文撑大。
  3. **错开并发**：等其它 codex `xhigh` 会话跑完再起高推理深审；或把一次大复核拆成几个小请求分轮跑。
  4. **降级不降质**：长深审断流时，改用「low/medium + 逐文件 + 简短产出」仍能拿到对关键红线的逐条结论（实证：抗体名映射线 A 复核即以 `low` 单文件成功出「无真 bug」结论）。
- **兜底**：codex 这一异构轴被网络挡住时，**Workflow 多 agent 对抗复核面板**（Claude 侧）可独立完成机制5 的第二视角复核，不必卡在 codex 上。

### ⚠️ 重要更正（2026-07-03 实证·§③b）——上面「一律降级躲断流」的姿势不对，别照抄

> 背景：上面 2026-07-02 那套把「长请求」当成天然易断、推人默认 low/medium。**2026-07-03 实证发现：多数「断流」是自己制造的误判——真凶是 `| tail` 缓冲 + 并发抢连接，不是 high 本身。** `high` 长请求其实**能完成**。

1. **`| tail -N` 是头号误判陷阱**：`codex exec ... 2>&1 | tail -N` 的 `tail` **缓冲到进程退出才 flush** → 运行途中读输出文件**永远 0 字节** → 极易误判「断流」而中途杀掉。**要看进度就裸重定向 `> file 2>&1`（别接 `tail`）**，能读到部分输出。
2. **`high` 长请求会跑很久但*能*完成**：读 5+ 文件 + 逐条判的首请求**实测约 15 分钟**才吐全量结论（完全可用）。**给足时间（10–15min 正常）**，用后台任务 + 进程存活探针（`kill -0 <pid>` / `ps` 见进程活着）等它自然退出，**别中途杀**。
3. **别叠并发 codex**：真断流（`Reading additional input from stdin...` / 0 字节秒退 / `stream disconnected`）**多因多个 `codex exec` 并发抢同一连接**（`ps` 见 3 个并发 = 越叠越断）。**等首个长请求跑完再起下一个**；要并行第二视角就用 Workflow 面板，别起第二个 codex。
4. **真断流 vs 只是慢 的判别**：进程活着（`kill -0` 成功）、无 `stream disconnected` 报错 = **只是慢，等**；0 字节秒退 / 明确 `stream disconnected` / `Reading additional input from stdin` = **真断流**，才降级或改 Workflow。
5. **措辞纪律**：**没拿到结论前别在文档写「断流·已兜底」**——等 codex 真回来再定。（2026-07-02 那版就因 `tail` 误判过一次。）

→ **净姿势**：单条 `high` 聚焦请求（单文件/明令别探索）+ 裸重定向 + 后台 + 耐心等 10–15min + 不并发。`xhigh` 仍易断（保留上面躲法）；`high` 别无脑降级。

## 禁用场景

以下情况**不建议**使用 Codex CLI：
- 简单的代码修改（直接使用 Claude Code）
- 实时交互式开发（响应较慢）
- 需要快速迭代的调试场景

---

*生效范围：所有 COREONE 项目会话。*
