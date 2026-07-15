# hospital-cm 月份窄 delta mockup（DRAFT）

> **状态：DRAFT — 等待 PM 对本 delta 成稿明确批准。** 这不是生产页面、运行时 readiness 证据、业务验收或解锁授权。

## 目标

本原型只补 Issue #185 E0 的月份交互缺口：未选择月份、选择月份、切换月份，以及每个月各自的 readiness / 固定成本池状态。

既有两层结构、校准 / 解锁 / 证据失效三态和“未测量”样式继续以[已批准基线](../hospital-cm-readiness-closure/index.html)为准。本目录不复制、不重画基线中的指标、金额、医院表格或撤销细节。

## 文件边界

Owned：

- `docs/mockups/hospital-cm-month-delta/README.md`
- `docs/mockups/hospital-cm-month-delta/index.html`
- `docs/mockups/hospital-cm-month-delta/validate.cjs`

Excluded：

- `docs/mockups/hospital-cm-readiness-closure/**`（已批准基线必须保持零差异）
- `前端代码/**`，包括 hospital-cm 页面、API、类型和 E2E
- `后端代码/**`、`.github/**`、`scripts/**`、数据库和权威口径文档

## 四个状态帧

| 帧 | 所选月份 | 月份状态 | 完整体检组件（`full-physical-exam`） | 必须证明 |
|---|---|---|---:|---|
| F0 未选月份 | 空 | readiness 与固定池均未检查 | DOM 0 | 不替用户隐式选月 |
| F1 M1 已就绪 | `2026-10`（交互示例） | exact M1 readiness 通过；M1 固定池已认账 | DOM 1 | 判断月份与完整体检月份一致 |
| F2 切换检查中 | 从 M1 切到 `2026-11` | exact M2 正在检查，`aria-busy=true` | DOM 0 | 先清除 M1 完整内容与证据，再检查 M2 |
| F3 M2 未就绪 | `2026-11`（交互示例） | exact M2 readiness 未满足；M2 固定池未认账 | DOM 0 | 不残留 M1，也不把未知显示成 0 |

顶部“演示控制”可固定停在 F0–F3，便于 PM 审阅；这些按钮不是拟议的生产控件。页面中的原生月份输入用于展示稳态选择，状态结果均为虚构交互样例。

## BDD 验收

```gherkin
Scenario: 首次进入时不替用户选择月份
  Given 用户打开月份 delta 原型
  When 用户尚未选择月份
  Then 月份输入保持为空
  And readiness 与固定成本池均显示尚未检查
  And 完整体检组件不进入 DOM

Scenario: exact M1 就绪后只展示 M1 完整组件
  Given 示例月份 M1 的 readiness 与固定成本池证据均满足
  When 原型进入 F1
  Then 页面同屏说明就绪判断月份和完整体检月份都是 M1
  And 完整体检组件恰好进入 DOM 一次
  And M1 示例证据标识 DEMO-M1-READY 可见

Scenario: 切月先清旧值
  Given F1 正在展示 M1 的完整组件
  When 原型进入从 M1 切换到 M2 的 F2
  Then 完整体检组件立即从 DOM 移除
  And 月份上下文标记为忙碌
  And DEMO-M1-READY 与 M1 证据在渲染区域完全消失

Scenario: M2 未就绪时保持校准
  Given 示例月份 M2 的固定成本池尚未认账
  When 原型进入 F3
  Then 页面显示 M2 的未就绪原因
  And 完整体检组件保持不在 DOM
  And 页面不存在 M1 示例证据
```

## 可访问性与响应式

- 页面使用 `lang="zh-CN"`、唯一 `h1`，月份输入有始终可见的 `label`。
- 演示按钮使用 `aria-pressed`；状态更新使用 `role="status" aria-live="polite"`；F2 使用 `aria-busy="true"`。
- 所有交互可键盘聚焦并同时具备 outline 与 focus ring；强制颜色模式使用系统 `Highlight` outline；主要触控目标至少 44px。
- 状态同时用文字与色彩表达；不依赖颜色传意。
- 12px 月份规则说明与 11px 灰色状态徽章均以浏览器 computed color 自动验证 WCAG AA 文字对比度不低于 4.5:1；演示按钮与月份输入边界不低于 3:1。
- 尊重 `prefers-reduced-motion`；375、768、1280 像素宽度不产生页面级横向滚动。

## PM 只需判断

1. 是否同意未选月份时保持校准，不自动代选月份？
2. 是否能看懂“就绪判断月份 = 完整体检月份”的 exact-month 关系？
3. 切月时先清旧完整内容、再检查新月份，是否符合预期？
4. 每月 readiness 与固定池版本/认账状态的同屏表达是否足够清楚？

PM 明确回复“定稿/通过”前，本原型只能标记为“已实现/已验证、待 PM 批准”，不得启动 E1 生产前端。

## 验证

```powershell
node docs/mockups/hospital-cm-month-delta/validate.cjs
rg -n 'fetch\(|XMLHttpRequest|<script[^>]+src=|<link[^>]+href=|https?://' docs/mockups/hospital-cm-month-delta/index.html
git diff --exit-code -- docs/mockups/hospital-cm-readiness-closure
git diff --check
git status --short
```

验证器优先从当前 worktree 的 `前端代码/node_modules` 加载 Playwright；若当前 worktree 尚未恢复依赖，可把 `COREONE_FRONTEND_NODE_MODULES` 设置为另一个同仓 checkout 的 `前端代码/node_modules` 绝对路径，再运行同一验证命令。仓库文件不保存本机路径。

可选截图必须写到仓库外目录：

```powershell
$env:MOCKUP_SCREENSHOT_DIR = "$env:TEMP\coreone-issue185-e0"
node docs/mockups/hospital-cm-month-delta/validate.cjs
```
