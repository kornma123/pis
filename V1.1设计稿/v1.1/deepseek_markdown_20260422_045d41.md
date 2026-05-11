# COREONE v2.2 代码审查问题清单

> **审查范围**：本次提交的全部 51 个 HTML 文件、共享样式表、组件库、脚本及 Mock 数据配置。
> **审查依据**：项目根目录下的 `DESIGN.md` 设计规范及 `PROJECT_RULES.md` 项目上下文规范。
> **生成日期**：2026-04-22

---

## 🔴 严重问题 (High Priority)
*直接影响核心功能闭环、数据一致性或严重违反设计规范，必须立即修复。*

### 1. 跨页面状态同步未完全实现
- **问题描述**：`mock-config.js` 中定义了 `stateManager` 用于跨页面数据同步（如入库后库存应增加），但大多数业务页面（如 `inbound.html`、`outbound.html`）仍使用局部硬编码的 `const mockData`，并未调用 `stateManager` 或 `mockApi` 方法。这导致在入库页面完成操作后，返回库存列表页面，库存数量不会发生变化，严重违背了用户对数据一致性的预期。
- **规范依据**：`PROJECT_RULES.md` § 9.2 跨页面状态同步检查点。
- **涉及文件**：
    - `pages/inbound.html`
    - `pages/outbound.html`
    - `pages/stocktaking.html`
    - `pages/scrap.html`
    - `mock/mock-config.js`
- **涉及数据字段**：`stateManager.inventory[].stock`
- **复现步骤**：
    1. 打开 `pages/inventory-list.html`，记录“DNA提取试剂盒”的库存。
    2. 打开 `pages/inbound.html`，对该物料进行入库操作。
    3. 返回库存列表页，观察到库存数量未改变。
- **修复建议**：
    1. 重构所有业务页面的数据操作逻辑，将局部 `mockData` 数组替换为对 `mockApi` 函数的调用。
    2. 确保 `inbound-modal.html` 中的“确认入库”按钮调用 `mockApi.createInboundRecord(record)`，并利用 `stateManager` 的订阅机制刷新列表页的 UI。

### 2. 物料选择器组件重复实现且逻辑不一致
- **问题描述**：`inventory-list.html`、`outbound.html` 以及独立的 `material-selector-modal.html` 中都实现了“添加物料/选择物料”的弹窗。这三个版本的 UI 结构、交互逻辑和内部数据源各不相同。`material-selector-modal.html` 作为独立组件未被任何页面引用，而 `inventory-list.html` 和 `outbound.html` 各自维护一套物料选择逻辑，维护成本极高且极易导致 Bug。
- **规范依据**：`PROJECT_RULES.md` § 3 模块与弹窗清单（未统一组件）。
- **涉及文件**：
    - `pages/inventory-list.html` (内部 `#add-material-modal`)
    - `pages/outbound.html` (内部 `#add-material-modal`)
    - `modals/material-selector-modal.html`
- **复现步骤**：
    1. 对比 `inventory-list.html` 和 `outbound.html` 中“添加物料”弹窗的样式和功能，发现两者完全独立实现。
- **修复建议**：
    1. **统一组件**：废弃页面内嵌的物料选择弹窗，将 `modals/material-selector-modal.html` 作为唯一的标准物料选择器组件。
    2. **全局加载**：使用 JavaScript 动态加载该弹窗的 HTML 结构，或采用 `<iframe>` / Web Components 方式进行复用。
    3. **统一 API**：暴露一致的 `window.selectMaterial(callback)` 方法供各页面调用。

### 3. 关键表单缺乏前端校验
- **问题描述**：多个业务操作弹窗（入库、出库、报废）中的表单，仅做了 UI 层面的简单提示，未阻止非法数据提交。例如，出库时输入数量大于当前库存，点击“确认出库”仍然会弹出“成功”提示（尽管 `mock-config.js` 中的逻辑会返回失败，但 UI 上未联动），这会给用户造成严重误导。
- **规范依据**：`PROJECT_RULES.md` § 9.4 边界与异常场景检查点。
- **涉及文件**：
    - `modals/outbound-modal.html`
    - `modals/inbound-modal.html`
    - `modals/scrap-apply-modal.html`
- **复现步骤**：
    1. 打开出库弹窗，选择一个物料，输入数量 99999（超过库存）。
    2. 点击“确认出库”。
    3. 观察是否有红色错误提示并阻止提交（目前仅依赖最终 API 返回的错误 Toast）。
- **修复建议**：
    1. 为“确认”按钮绑定前置校验函数。
    2. 校验逻辑应包含：必填项检查、数值范围检查（min, max）、日期有效性检查。
    3. 校验失败时，在对应输入框下方显示红色错误信息，并阻止 API 调用。

### 4. 样式表严重冗余与冲突风险
- **问题描述**：项目同时存在 `shared/styles.css` 和 `shared/components.css`。两者均定义了几乎相同的 `:root` 变量、按钮样式（`.btn`）、表单样式（`.form-control`）和模态框样式（`.modal`）。浏览器加载时，后加载的样式会覆盖前者，导致样式优先级混乱，且严重违反 DRY 原则。
- **规范依据**：`DESIGN.md` 设计规范（未提及双样式表架构）。
- **涉及文件**：
    - `shared/styles.css`
    - `shared/components.css`
- **复现步骤**：在浏览器开发者工具中检查任意一个按钮，会发现它的样式规则来自 `components.css`，而 `styles.css` 中的同名规则被覆盖（灰色显示）。
- **修复建议**：
    1. **二选一**：删除 `shared/styles.css` 或 `shared/components.css` 中的一个，将必要的全局变量和重置样式合并到保留的文件中。
    2. 推荐保留 `shared/styles.css` 作为唯一入口，在 HTML 中仅引入该文件。

---

## 🟠 中等问题 (Medium Priority)
*影响用户体验、可维护性或部分规范遵循，建议尽快修复。*

### 5. 页面内嵌样式泛滥
- **问题描述**：超过 15 个 HTML 页面在 `<head>` 中使用了 `<style>` 标签定义局部样式。这些样式本应抽取到共享样式表中，通过组件类名复用。当前做法导致样式分散、难以统一调整主题，且增加了页面体积。
- **规范依据**：`DESIGN.md` 组件化原则。
- **涉及文件**：
    - `pages/inventory-list.html` (大量 `.quick-filter-tag`, `.batch-actions-bar` 样式)
    - `pages/outbound.html`
    - `pages/stocktaking.html`
    - `pages/projects.html`
    - 以及其他约 10 个页面。
- **复现步骤**：打开任一上述页面，查看源代码 `<style>` 标签内容。
- **修复建议**：
    1. 将页面内 `<style>` 标签中的样式迁移至 `shared/styles.css`。
    2. 对于页面特有的、复用性极低的样式，可使用更具体的类名保留在页面中，但需严格限制范围。

### 6. 缺失统一的 Toast 容器与调用方法
- **问题描述**：`shared/scripts.js` 中定义了 `showToast` 函数，但许多页面（如 `inbound.html`、`scrap.html`）在内部又重新实现了一遍 `showToast` 或类似的临时提示逻辑。这导致 Toast 样式不一致（有的靠左，有的靠右），且容易出现全局 `toast-container` 未被正确初始化的错误。
- **规范依据**：`PROJECT_RULES.md` § 7.3 交互规范。
- **涉及文件**：
    - `shared/scripts.js`
    - `pages/inbound.html`
    - `pages/scrap.html`
    - `pages/stocktaking.html`
- **复现步骤**：分别在库存列表页和入库页触发一个操作，观察成功提示的样式和位置。
- **修复建议**：
    1. **全局唯一**：确保所有页面均通过 `<script src="../shared/scripts.js">` 引入并直接调用全局 `showToast(message, type)`。
    2. 删除各业务页面中重复定义的 `showToast` 函数。

### 7. 模态框遮罩层点击关闭逻辑未统一处理
- **问题描述**：大部分模态框依赖内联的 `onclick="hideModal('xxx')"` 绑定在遮罩层 `div` 上，但部分新页面（如独立的弹窗 HTML 文件）未正确处理遮罩层关闭。规范要求点击遮罩层应能关闭弹窗，但实际未绑定事件。
- **规范依据**：`PROJECT_RULES.md` § 7.2 弹窗规范。
- **涉及文件**：所有 `modals/*.html` 文件（如 `modals/edit-category-modal.html`）。
- **复现步骤**：
    1. 在独立的弹窗预览环境中（如直接打开 `edit-category-modal.html`），点击灰色背景区域。
    2. 观察弹窗是否关闭（由于 JS 未完全初始化，大概率无法关闭）。
- **修复建议**：
    1. 在 `shared/scripts.js` 中实现全局模态框管理逻辑：监听 `[data-modal]` 的点击事件，自动处理遮罩层关闭、ESC 关闭。
    2. 修改所有弹窗 HTML，移除内联 `onclick`，改用 `data-modal="modal-id"` 属性。

### 8. 操作反馈缺失防重复提交机制
- **问题描述**：所有弹窗的“确认/保存”按钮在点击后，均未进入 Loading 状态（按钮禁用 + 加载动画）。在网络延迟或异步操作期间，用户可以连续点击多次，导致重复提交数据。
- **规范依据**：`PROJECT_RULES.md` § 7.3 交互规范。
- **涉及文件**：所有包含提交按钮的 Modal 文件。
- **复现步骤**：
    1. 打开任一“新建”弹窗。
    2. 快速连续点击“保存”按钮两次。
    3. 观察是否创建了两条重复数据（根据 `mockApi` 实现可能会创建两次）。
- **修复建议**：
    1. 封装一个异步按钮处理函数，点击后立即设置 `disabled` 属性，并显示 Loading 图标。
    2. 操作完成（成功或失败）后，恢复按钮状态。

### 9. 空状态组件未按规范统一
- **问题描述**：项目规范中定义了统一的空状态组件样式（图标 + 标题 + 描述 + 操作按钮），但不同页面的实现千差万别。例如 `bom.html` 的空状态是一个简单的文本，而 `inventory-list.html` 实现了相对完整的空状态但图标不统一。
- **规范依据**：`PROJECT_RULES.md` § 9.4 边界与异常场景。
- **涉及文件**：
    - `pages/inventory-list.html`
    - `pages/bom.html`
    - `pages/projects.html`
- **复现步骤**：清空 Mock 数据，访问不同列表页，对比空状态 UI。
- **修复建议**：
    1. 创建一个标准的 `empty-state` HTML 模板片段。
    2. 在所有业务列表页中，通过 JavaScript 动态渲染该统一模板。

---

## 🟢 轻微问题 (Low Priority)
*代码整洁度、语义化、微小样式偏差，可在迭代中逐步优化。*

### 10. 使用了非语义化的 `<div>` 模拟按钮
- **问题描述**：部分点击交互使用了 `<div onclick="...">` 而非标准的 `<button>` 元素。这不利于键盘导航（无法通过 Tab 聚焦）和屏幕阅读器解析。
- **涉及文件**：
    - `pages/categories.html` (`.category-row`)
    - `pages/inventory-list.html` (`.stat-card`)
- **复现步骤**：使用键盘 Tab 键尝试导航到分类树或统计卡片，会发现无法聚焦。
- **修复建议**：将具有点击交互的 `<div>` 替换为 `<button>` 或 `<a>`，并重置其默认样式。

### 11. 缺少 ARIA 标签与可访问性支持
- **问题描述**：大部分 SVG 图标缺少 `aria-label` 或 `<title>` 标签，屏幕阅读器用户无法得知图标的含义。模态框缺少 `aria-modal="true"` 和 `role="dialog"` 属性。
- **涉及文件**：所有包含图标的文件。
- **修复建议**：
    1. 为所有功能性图标（关闭、编辑、删除等）的 `<svg>` 添加 `aria-label="关闭"`。
    2. 为模态框容器添加 `role="dialog" aria-modal="true"`。

### 12. 控制台存在大量未清理的调试日志
- **问题描述**：在 `scripts.js` 和一些页面脚本中，存在 `console.log` 语句。虽然开发环境有用，但交付原型时应保持控制台干净，避免干扰审查。
- **涉及文件**：
    - `shared/scripts.js`
    - `pages/locations.html`
    - `pages/stocktaking.html`
- **修复建议**：全局搜索 `console.log` 并删除，或封装为仅在 `dev` 模式下启用的日志工具。

### 13. 文件命名不规范
- **问题描述**：模态框文件命名风格不统一，例如既有 `edit-category-modal.html` 也有 `bom-detail-modal.html`。部分文件名使用了连字符，部分使用了下划线（如 `alert_history_detail_modal.html` 未出现，但需警惕）。
- **涉及文件**：`modals/` 目录下的所有文件。
- **修复建议**：统一采用 **小写字母 + 连字符** 的命名规范，如 `alert-handle-modal.html`、`inbound-detail-modal.html`。

### 14. 部分弹窗缺少 ESC 关闭功能
- **问题描述**：独立的模态框 HTML 文件（如 `modals/alert-handle-modal.html`）未包含监听 ESC 键关闭的逻辑，因为它们通常作为预览展示，未挂载完整的全局事件。
- **涉及文件**：所有 `modals/*.html`。
- **修复建议**：在这些独立文件中补充用于演示的 ESC 监听逻辑，或统一由父页面框架注入。

### 15. 响应式断点缺失导致移动端布局错乱
- **问题描述**：尽管 `styles.css` 中包含 `@media` 查询，但大量页面使用了固定宽度的网格布局（如 `style="display: grid; grid-template-columns: repeat(4, 1fr);"`），在小屏幕（<768px）下并未调整为 2 列或 1 列，导致出现横向滚动条。
- **涉及文件**：
    - `pages/cost-analysis.html`
    - `pages/projects.html`
- **复现步骤**：在 Chrome 开发者工具中切换到移动设备视图，查看统计卡片区域。
- **修复建议**：为固定列数的 Grid 布局补充移动端响应式样式。

---

## ✅ 总体评价

本次提交的代码完整度较高，业务逻辑覆盖全面，设计系统在视觉上较为统一。主要扣分项集中在 **跨页面状态管理缺失** 和 **组件复用不规范** 上，这是从“静态演示原型”向“高保真可交互原型”过渡的关键障碍。

**建议优先处理“严重问题”中的第 1、2 项**，这将极大提升后续页面的开发效率和演示的真实性。